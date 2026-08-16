// Gmail receipt scanner (Brief 01, Part B). Searches Gmail for e-receipts,
// extracts them with Gemini structured output, and matches each receipt to
// exactly one transaction. Its only writes are receipt_matches inserts,
// scanned_gmail_messages inserts, and reviewed_at = NULL on the matched
// transaction — it never modifies amounts, dates, or merchants and never
// deletes anything.
// @google/genai costs ~34 MB RSS at import, so it is loaded on first use
// rather than at boot — the 256 MB production VM can't afford it idle.
// Type mirrors the SDK's enum, which is plain uppercase strings.
const Type = { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER", INTEGER: "INTEGER", BOOLEAN: "BOOLEAN", ARRAY: "ARRAY" };
let genaiModule = null;
// Caching the promise (not the module) is what makes concurrent first-callers
// share one import instead of racing two. But a REJECTED promise would stay
// cached just as happily: `??=` only reassigns on null/undefined, so one
// transient failure would poison every later call and take both the scanner
// and Ask AI down until the process restarted. So clear the cache on rejection
// and let the next caller retry. The clear runs in a microtask after the
// assignment below has already completed, so it can't null out a fresh entry;
// on success nothing reassigns and the one cached promise is reused forever.
// Know what this does and doesn't buy: Node's ESM loader keeps its own
// per-URL module job, and a failure during load or evaluation is cached there
// too — a second import() of the same specifier replays the recorded rejection
// without re-attempting anything. So the retry only truly recovers from the
// failures Node won't cache (resolution-class, e.g. the specifier not
// resolving yet), not from a mid-load OOM or evaluation throw. It is still
// strictly better than caching the rejection ourselves on top of Node's.
export function loadGenAI() {
  return (genaiModule ??= import("@google/genai").catch((err) => {
    genaiModule = null;
    throw err;
  }));
}
import pool from "./db.js";
import { getCategories, unreviewTransaction } from "./db.js";
import { getGmailClient } from "./gmail.js";
import { checkGeminiBudget, recordGeminiCall, usageFromResponse } from "./geminiUsage.js";

const GMAIL_QUERY =
  '("receipt" OR "order confirmation" OR "invoice" OR "your purchase") newer_than:35d -category:promotions';
const MAX_MESSAGES_PER_RUN = 40; // free-tier RPD headroom
const MAX_TEXT_CHARS = 15000;
const MIN_MS_BETWEEN_GEMINI_CALLS = 7500; // ≤8 requests/min (free tier is ~10 RPM)

export function receiptScanConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Minimal HTML → text. Good enough for receipt emails; deliberately not a
// parser and not a new dependency.
export function stripHtml(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const dayMs = 24 * 60 * 60 * 1000;
function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  return Math.round((to - from) / dayMs);
}

// The matching rule, pure so it is unit-testable (test/receiptMatching.test.js).
// receipt: { total, date: 'YYYY-MM-DD' }
// candidates: [{ id, amount, date: 'YYYY-MM-DD', status, has_match }]
// Returns the single matching transaction id, or null. Rules:
//   - amount within $0.01 of the receipt total; if none, fall back to within 1%
//   - date between receipt.date - 1 and receipt.date + 4 (inclusive)
//   - status != 'pending'
//   - no existing receipt_matches row (has_match)
//   - EXACTLY ONE candidate left, otherwise null — never guess.
export function matchReceiptToTransaction(receipt, candidates) {
  const total = Number(receipt?.total);
  if (!receipt?.date || !Number.isFinite(total) || total === 0) return null;

  const eligible = (candidates || []).filter((c) => {
    if (!c || c.status === "pending" || c.has_match) return false;
    const diff = daysBetween(receipt.date, c.date);
    return diff >= -1 && diff <= 4;
  });

  const exact = eligible.filter((c) => Math.abs(Number(c.amount) - total) < 0.01);
  const inTolerance = exact.length > 0
    ? exact
    : eligible.filter((c) => Math.abs(Number(c.amount) - total) <= 0.01 * Math.abs(total));

  return inTolerance.length === 1 ? inTolerance[0].id : null;
}

// ── Gmail text extraction ─────────────────────────────────────────────────────

function decodeBody(data) {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

function collectParts(payload, out) {
  if (!payload) return;
  if (payload.body?.data && payload.mimeType) out.push(payload);
  for (const part of payload.parts || []) collectParts(part, out);
}

export function extractMessageText(message) {
  const headers = message?.payload?.headers || [];
  const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
  const parts = [];
  collectParts(message?.payload, parts);
  const plain = parts.filter((p) => p.mimeType.startsWith("text/plain")).map((p) => decodeBody(p.body.data)).join("\n");
  let body = plain.trim();
  if (!body) {
    const html = parts.filter((p) => p.mimeType.startsWith("text/html")).map((p) => decodeBody(p.body.data)).join("\n");
    body = stripHtml(html);
  }
  return `Subject: ${subject}\n\n${body}`.slice(0, MAX_TEXT_CHARS);
}

// ── Gemini extraction ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimitError(err) {
  return err?.status === 429 || /\b429\b|RESOURCE_EXHAUSTED/i.test(err?.message || "");
}

async function extractReceipt(ai, categoryNames, emailText) {
  // Resolved into a local because two things need it now: the request, and the
  // usage row that has to say which model's price list the estimate came from.
  const model = process.env.RECEIPT_MODEL || "gemini-2.5-flash";
  const res = await ai.models.generateContent({
    model,
    contents:
      `Categories: ${categoryNames.join(", ")}\n` +
      `If this email is a purchase receipt, extract it. If not, return is_receipt=false.\n\n` +
      emailText,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          is_receipt: { type: Type.BOOLEAN },
          merchant:   { type: Type.STRING },
          date:       { type: Type.STRING, description: "YYYY-MM-DD" },
          total:      { type: Type.NUMBER },
          items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
            description: { type: Type.STRING }, amount: { type: Type.NUMBER } } } },
          suggested_category: { type: Type.STRING,
            description: "Exactly one of the provided category names, or empty" },
        },
        required: ["is_receipt"],
      },
    },
  });
  // Accounted after the call returns and before the parse: a call that threw
  // has no usageMetadata to account for, while one whose JSON we then fail to
  // parse was still paid for. recordGeminiCall swallows its own failures, so
  // this line cannot cost us a receipt.
  await recordGeminiCall({ feature: "receipt_scan", model, usage: usageFromResponse(res) });
  return JSON.parse(res.text);
}

// ── Scan pipeline ─────────────────────────────────────────────────────────────

async function listNewMessageIds(gmail) {
  const ids = [];
  let pageToken;
  do {
    const r = await gmail.users.messages.list({
      userId: "me",
      q: GMAIL_QUERY,
      maxResults: 100,
      pageToken,
    });
    for (const m of r.data.messages || []) ids.push(m.id);
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT gmail_message_id FROM scanned_gmail_messages WHERE gmail_message_id = ANY($1)`,
    [ids]
  );
  const seen = new Set(rows.map((r) => r.gmail_message_id));
  return ids.filter((id) => !seen.has(id)).slice(0, MAX_MESSAGES_PER_RUN);
}

async function findCandidates(receiptDate) {
  const { rows } = await pool.query(
    `SELECT t.id, t.amount::float AS amount, TO_CHAR(t.date, 'YYYY-MM-DD') AS date,
            t.status, (rm.transaction_id IS NOT NULL) AS has_match
     FROM transactions t
     LEFT JOIN receipt_matches rm ON rm.transaction_id = t.id
     WHERE t.date BETWEEN $1::date - 1 AND $1::date + 4`,
    [receiptDate]
  );
  return rows;
}

async function recordScanned(gmailMessageId, matched) {
  await pool.query(
    `INSERT INTO scanned_gmail_messages (gmail_message_id, matched)
     VALUES ($1, $2)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [gmailMessageId, matched]
  );
}

async function insertReceiptMatch(transactionId, gmailMessageId, receipt, suggestedCategoryId) {
  await pool.query(
    `INSERT INTO receipt_matches
       (transaction_id, gmail_message_id, merchant, receipt_date, total, items, suggested_category_id, extracted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      transactionId,
      gmailMessageId,
      receipt.merchant || null,
      receipt.date,
      receipt.total,
      JSON.stringify(receipt.items || []),
      suggestedCategoryId,
      JSON.stringify(receipt),
    ]
  );
}

// Runs one scan. Returns { scanned, receipts_found, matched }. A Gemini 429
// aborts the run gracefully: every message processed so far is already in
// scanned_gmail_messages, and the message that hit the limit is not, so the
// next run resumes with it.
export async function runReceiptScan() {
  if (!receiptScanConfigured()) throw new Error("GEMINI_API_KEY is not set");
  // Budget guard, before Gmail or the SDK is touched. It lives here rather than
  // in POST /api/receipts/scan because the caller that actually needs stopping
  // is the 8:10 AM scheduled job in index.js: unattended, up to
  // MAX_MESSAGES_PER_RUN Gemini calls a night, and the only thing in this app
  // that can quietly spend a month's budget while nobody is looking. The manual
  // button is gated by the same line for free. The scanner is cut off at 100%
  // while interactive Ask AI deliberately runs on past it (see /api/ask) — when
  // money runs short, the request a human is waiting on wins.
  // Throwing rather than returning a result matches the configuration refusal
  // directly above and is what carries the reason to the user: the route turns
  // an Error into the message the UI already shows, whereas a zero-count result
  // would look like a scan that simply found nothing.
  const budget = await checkGeminiBudget("receipt_scan");
  if (budget.level === "over") {
    throw new Error(
      `Monthly Gemini budget reached: $${budget.spentUsd} of $${budget.budgetUsd} spent in ${budget.month} ` +
        `(${budget.pct}%). Receipt scanning is paused until the month rolls over — raise ` +
        `GEMINI_MONTHLY_BUDGET_USD to continue sooner.`
    );
  }
  const gmail = await getGmailClient();
  const { GoogleGenAI } = await loadGenAI();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const categories = await getCategories();
  const categoryNames = categories.map((c) => c.name);
  const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

  const messageIds = await listNewMessageIds(gmail);
  let scanned = 0;
  let receiptsFound = 0;
  let matched = 0;
  let lastGeminiCall = 0;

  for (const messageId of messageIds) {
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const emailText = extractMessageText(msg.data);

    const wait = lastGeminiCall + MIN_MS_BETWEEN_GEMINI_CALLS - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeminiCall = Date.now();

    let receipt;
    try {
      receipt = await extractReceipt(ai, categoryNames, emailText);
    } catch (err) {
      if (isRateLimitError(err)) {
        console.warn(`Receipt scan: Gemini rate limit hit after ${scanned} message(s); stopping — next run resumes`);
        break;
      }
      throw err;
    }

    let isMatch = false;
    if (receipt?.is_receipt && receipt.date && Number(receipt.total) > 0) {
      receiptsFound++;
      const candidates = await findCandidates(receipt.date);
      const transactionId = matchReceiptToTransaction(receipt, candidates);
      if (transactionId) {
        const suggestedCategoryId =
          categoryIdByName.get((receipt.suggested_category || "").toLowerCase().trim()) || null;
        await insertReceiptMatch(transactionId, messageId, receipt, suggestedCategoryId);
        await unreviewTransaction(transactionId); // amber: a suggestion is waiting
        isMatch = true;
        matched++;
      }
    }

    await recordScanned(messageId, isMatch);
    scanned++;
  }

  return { scanned, receipts_found: receiptsFound, matched };
}
