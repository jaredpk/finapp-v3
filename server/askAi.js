// Ask AI (Brief 03): natural-language questions answered by Gemini through a
// manual function-calling loop over a READ-ONLY tool surface — every impl
// entry below calls only query functions from db.js; nothing here can write.
//
// runAskLoop is deliberately pure-ish: `generate(contents)` is injected
// (production passes a closure over ai.models.generateContent, tests pass a
// scripted fake) and `impl` is the tool-name → async function map, so the loop
// is unit-testable without a network or a database (test/askAi.test.js).
// @google/genai is loaded on first use, not at boot — see receiptScan.js for
// the memory rationale. Type mirrors the SDK's plain-string enum.
import { loadGenAI } from "./receiptScan.js";
const Type = { OBJECT: "OBJECT", STRING: "STRING", NUMBER: "NUMBER", INTEGER: "INTEGER", BOOLEAN: "BOOLEAN", ARRAY: "ARRAY" };
import {
  getVisibleTransactions, getSpendingByCategory, getCategories,
  getLatestBalances, getReportSummary,
} from "./db.js";

export const MAX_ITERATIONS = 8;
export const MAX_RESULT_CHARS = 50_000;
const MAX_HISTORY_TURNS = 10;
// Wall-clock budget for the whole loop. MAX_ITERATIONS alone bounds the number
// of round-trips but not their duration: eight slow generateContent calls can
// outlast the proxy's request timeout, and once that fires the client gets a
// gateway HTML page instead of our JSON — an un-parseable error that says
// nothing about what went wrong (the same failure shape documented at the
// backfill replay in index.js). Stopping ourselves under that ceiling means a
// slow question degrades to an honest answer we control. Sized against a 60s
// proxy timeout (we don't know the real one; 60s is the common default) and
// the per-round-trip timeout below: 35s budget + 20s in-flight call = 55s
// worst case. With thinking disabled the normal path finishes far inside 35s.
export const ASK_DEADLINE_MS = 35_000;

export function askAiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// ── System prompt ─────────────────────────────────────────────────────────────
// Built at request time so today's date is always current — the model doesn't
// know the date on its own.
export function buildSystemPrompt(today = new Date().toISOString().slice(0, 10)) {
  return [
    "You are the built-in assistant of a personal finance app with a single",
    `user (its owner — every account and transaction is theirs). Today's date is ${today}.`,
    "",
    "Data conventions:",
    "- All amounts are in USD.",
    "- Transaction sign convention: a POSITIVE amount is money out (spending);",
    "  a NEGATIVE amount is money in (income, refunds, transfers in).",
    "- Dates are YYYY-MM-DD.",
    "",
    "Rules:",
    "- Answer ONLY from data returned by the provided tools. Call tools as",
    "  needed before answering. If the tool data does not cover the question,",
    "  say so plainly instead of guessing.",
    "- The tools are read-only; you cannot change any data.",
    "- Keep answers concise. Respond in plain text (no markdown tables) and",
    "  format money like $1,234.56.",
  ].join("\n");
}

// ── Tool declarations (what the model sees) ───────────────────────────────────
export const functionDeclarations = [
  {
    name: "get_transactions",
    description:
      "List transactions. Use for questions about specific purchases, merchants, dates, amounts. Positive amount = money out (spend); negative = money in.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_date: { type: Type.STRING, description: "YYYY-MM-DD" },
        end_date:   { type: Type.STRING, description: "YYYY-MM-DD" },
        category:   { type: Type.STRING },
        limit:      { type: Type.INTEGER, description: "default 100, max 500" },
      },
    },
  },
  {
    name: "get_spending_by_category",
    description:
      "Spending totals grouped by category (spend only, positive amounts). Use for 'how much did I spend on X' style questions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_date: { type: Type.STRING, description: "YYYY-MM-DD" },
        end_date:   { type: Type.STRING, description: "YYYY-MM-DD" },
      },
    },
  },
  // The next two take no arguments, so they carry no `parameters` key at all —
  // the SDK marks it optional ("for function with no parameters, this can be
  // left unset") and the API rejects the obvious-looking alternative outright:
  // an OBJECT schema with an empty `properties` fails request validation with
  // 400 INVALID_ARGUMENT ("parameters.properties: should be non-empty for
  // OBJECT type"). Every declaration ships on every generateContent call, so
  // one bad entry here fails all of Ask AI. Don't "fix" this by adding
  // `parameters: { type: Type.OBJECT, properties: {} }` back.
  {
    name: "list_categories",
    description: "List the user-defined budget categories (id, name, color).",
  },
  {
    name: "get_latest_balances",
    description:
      "Latest snapshot of account balances (account, institution, type, balance, available, snapshot_date).",
  },
  {
    name: "get_report_summary",
    description:
      "Monthly income/spend/net plus per-category totals and top merchants for a date range. Best for overviews and trends.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_date: { type: Type.STRING, description: "YYYY-MM-DD; defaults to 6 full months ago" },
        end_date:   { type: Type.STRING, description: "YYYY-MM-DD; defaults to today" },
      },
    },
  },
];

// Default range for get_report_summary — mirrors GET /api/reports/summary.
function reportRangeDefaults() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
  return {
    startDate: first.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  };
}

// ── Tool implementations (read-only: query functions only) ────────────────────
export const impl = {
  get_transactions: ({ start_date, end_date, category, limit } = {}) =>
    getVisibleTransactions({
      startDate: start_date,
      endDate: end_date,
      category,
      limit: Math.min(Math.max(1, Number(limit) || 100), 500),
    }),
  get_spending_by_category: ({ start_date, end_date } = {}) =>
    getSpendingByCategory({ startDate: start_date, endDate: end_date }),
  list_categories: () => getCategories(),
  get_latest_balances: () => getLatestBalances(),
  get_report_summary: ({ start_date, end_date } = {}) => {
    const defaults = reportRangeDefaults();
    return getReportSummary({
      startDate: start_date || defaults.startDate,
      endDate: end_date || defaults.endDate,
    });
  },
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

// One broad query must not blow the context: stringify, cut, mark the cut.
export function truncateJson(value, maxChars = MAX_RESULT_CHARS) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") return json;
  return json.length > maxChars ? `${json.slice(0, maxChars)}(truncated)` : json;
}

// Client sends the last ≤10 turns; clamp server-side and drop junk entries.
export function clampHistory(history, maxTurns = MAX_HISTORY_TURNS) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && (t.role === "user" || t.role === "model") && typeof t.text === "string" && t.text.trim())
    .slice(-maxTurns)
    .map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
}

// ── The function-calling loop ─────────────────────────────────────────────────
// generate(contents) → GenerateContentResponse-shaped object. On @google/genai
// 2.16.0 the accessors are the getters `r.functionCalls` (undefined/empty when
// the model is done) and `r.text`, plus `r.candidates[0].content.parts` for
// echoing the model turn back — verified against dist/genai.d.ts.
// Returns { answer, toolCalls } where toolCalls is the ordered list of tool
// names invoked (the route logs it — acceptance criterion 1).
// `now` is injected for the same reason `generate` is: the deadline has to be
// testable without spending real seconds in the suite.
export async function runAskLoop({
  question, history, generate, impl: tools,
  maxIterations = MAX_ITERATIONS, deadlineMs = ASK_DEADLINE_MS, now = () => Date.now(),
}) {
  const contents = [
    ...clampHistory(history),
    { role: "user", parts: [{ text: question }] },
  ];
  const toolCalls = [];
  const deadline = now() + deadlineMs;

  for (let i = 0; i < maxIterations; i++) {
    // Checked only between round-trips: a request already in flight is left to
    // finish (aborting it would waste tokens already paid for and buys nothing
    // — what we're preventing is *starting* work that can't land in time).
    // So the real worst case is the deadline plus one whole round-trip:
    // ASK_DEADLINE_MS 35s + httpOptions.timeout 20s = 55s, which is why the
    // budget is set below the proxy's assumed 60s timeout rather than at it.
    if (now() >= deadline) {
      return { answer: "That took too long to answer — try a narrower question.", toolCalls };
    }
    const r = await generate(contents);
    const calls = r.functionCalls;
    if (!calls || calls.length === 0) {
      return { answer: r.text || "(no answer)", toolCalls };
    }

    contents.push({ role: "model", parts: r.candidates[0].content.parts });
    for (const call of calls) {
      toolCalls.push(call.name);
      let result;
      try {
        const fn = tools[call.name];
        if (!fn) throw new Error(`Unknown tool: ${call.name}`);
        result = await fn(call.args || {});
      } catch (e) {
        // Hand the failure back to the model instead of aborting — it can
        // rephrase the call or answer around it.
        result = { error: String(e.message) };
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: call.name, response: { result: truncateJson(result) } } }],
      });
    }
  }

  // Iteration cap, not the clock — deliberately worded differently from the
  // deadline answer above so a log or a bug report tells you which limit bit.
  return { answer: "I couldn't finish answering that — try a narrower question.", toolCalls };
}

// Resolved in one place because two things now depend on the model name: the
// request itself and whether thinking can be switched off for it.
export function resolveAskModel() {
  return process.env.ASK_AI_MODEL || "gemini-2.5-flash";
}

// Thinking costs latency we don't need — Ask AI runs up to MAX_ITERATIONS
// round-trips, so per-call thinking time is multiplied by the loop — hence
// thinkingBudget 0 (ThinkingConfig.thinkingBudget, "0 is DISABLED", verified
// against dist/genai.d.ts on 2.16.0). But the budget is NOT universally
// settable, and ASK_AI_MODEL is an env knob, so sending the field to a model
// that won't take it turns one env var into a config that 400s every single
// request — precisely the failure class removed from the tool declarations
// above. Two distinct ways to get that wrong:
//   - gemini-2.5-pro understands thinking but cannot switch it off (minimum
//     budget 128), so 0 is rejected;
//   - gemini-2.0-flash / gemini-1.5-flash predate thinking entirely and have
//     no thinkingConfig to set — matching them on the substring "flash" would
//     reintroduce the same breakage from the other direction.
// So this is an allow-list, not a keyword search: only the 2.5 flash tier
// (gemini-2.5-flash and gemini-2.5-flash-lite, plus their dated/preview
// suffixes) is known to accept 0. Anything unrecognised — new models, other
// vendors' naming, a typo — falls through to {} and keeps the model's own
// default, so the failure mode of being wrong here is "slower than it could
// be", never "broken". Returns a spreadable fragment so "omit" really means
// absent, not an undefined key.
export function thinkingConfigFor(model) {
  if (!/^gemini-2\.5-flash\b/.test(String(model))) return {};
  return { thinkingConfig: { thinkingBudget: 0 } };
}

// Production `generate`: a closure over ai.models.generateContent. Created per
// request so the system prompt carries the current date.
export function createGeminiGenerate() {
  const systemInstruction = buildSystemPrompt();
  const model = resolveAskModel();
  // Memoized so a request builds one client instead of one per loop iteration:
  // runAskLoop can call `generate` up to MAX_ITERATIONS times and there is no
  // per-call state to keep them apart. The import stays lazy (deliberate: see
  // the boot-memory note at the top of this file), so the first call resolves
  // it and later calls reuse the same client. The guarantee holds for SERIAL
  // callers only — the check and the await aren't atomic, so N calls made
  // concurrently on one generator would each pass `!ai` and build N clients.
  // runAskLoop awaits every `generate` before the next, which is the only way
  // production drives this; the fallout for a concurrent caller is a few extra
  // clients, not incorrect behaviour, so this isn't worth a lock.
  let ai = null;
  return async (contents) => {
    if (!ai) {
      const { GoogleGenAI } = await loadGenAI();
      ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    return ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations }],
        // Per-request timeout in ms (HttpOptions.timeout, verified against
        // dist/genai.d.ts on 2.16.0). Without it one hung socket could eat the
        // whole runAskLoop deadline on its own and the loop would never get to
        // make its second call — the deadline bounds the loop, this bounds a
        // single round-trip so a stall costs one iteration, not all eight.
        httpOptions: { timeout: 20_000 },
        ...thinkingConfigFor(model),
      },
    });
  };
}
