// Bulk AI transaction update: the user hands over a list of transactions and a
// natural-language instruction, Gemini proposes per-transaction changes with
// structured output, the user previews them, then applies them in one go.
//
// This file is the pure half, in the same spirit as askAi.js's runAskLoop:
// `generate(contents)` is injected (production passes createBulkGenerate(), tests
// pass a scripted fake) and the validators take plain data, so the whole
// propose/validate path is unit-testable without a network or a database
// (test/bulkUpdate.test.js). Proposing writes NOTHING; the only writes are in
// db.js applyBulkChanges, reached through POST /api/transactions/bulk-update/apply.
// @google/genai is loaded on first use — see receiptScan.js for the memory
// rationale. Type mirrors the SDK's plain-string enum.
import { loadGenAI } from "./receiptScan.js";
import { resolveAskModel, thinkingConfigFor } from "./askAi.js";
import { usageFromResponse } from "./geminiUsage.js";

const Type = { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY" };

export const MAX_BULK_TRANSACTIONS = 100;
export const MAX_INSTRUCTION_CHARS = 1000;
export const MAX_MERCHANT_CHARS = 200;

// ── Request validation ────────────────────────────────────────────────────────

// Returns { ids, instruction } or { error } — the error text is what the route
// sends back as a 400.
export function parseProposeRequest(body) {
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) return { error: "instruction is required" };
  if (instruction.length > MAX_INSTRUCTION_CHARS)
    return { error: `instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer` };
  const raw = body?.transactionIds;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "transactionIds array required" };
  if (!raw.every((id) => typeof id === "string" && id)) return { error: "transactionIds must be non-empty strings" };
  const ids = [...new Set(raw)];
  if (ids.length > MAX_BULK_TRANSACTIONS)
    return { error: `at most ${MAX_BULK_TRANSACTIONS} transactions per request` };
  return { ids, instruction };
}

const cleanMerchant = (m) => (typeof m === "string" && m.trim() ? m.trim() : null);

// Shared by the proposal and the apply path, so what the model may return and
// what the client may send are held to one rule. `raw` is untrusted either way.
// Returns { changes, skipped }:
//   changes: [{ transactionId, categoryId|null, merchant|null, reason }]
//   skipped: [{ transactionId, reason }] — anything dropped, and why.
// A row naming an unknown category loses only that field: a good merchant
// rename on the same row still goes through, and the skipped list says why the
// category did not. A row left with nothing to change is omitted silently.
export function validateChanges(raw, { allowedIds, categoryIds }) {
  const changes = [];
  const skipped = [];
  if (!Array.isArray(raw)) return { changes, skipped };
  const seen = new Set();
  for (const item of raw.slice(0, MAX_BULK_TRANSACTIONS)) {
    const transactionId = item?.transactionId;
    if (typeof transactionId !== "string" || !allowedIds.has(transactionId)) {
      skipped.push({ transactionId: typeof transactionId === "string" ? transactionId : null, reason: "transaction not in the requested set" });
      continue;
    }
    if (seen.has(transactionId)) {
      skipped.push({ transactionId, reason: "duplicate change for this transaction" });
      continue;
    }
    seen.add(transactionId);

    let categoryId = typeof item.categoryId === "string" && item.categoryId ? item.categoryId : null;
    if (categoryId && !categoryIds.has(categoryId)) {
      skipped.push({ transactionId, reason: "unknown category" });
      categoryId = null;
    }
    let merchant = cleanMerchant(item.merchant);
    if (merchant && merchant.length > MAX_MERCHANT_CHARS) {
      skipped.push({ transactionId, reason: `merchant longer than ${MAX_MERCHANT_CHARS} characters` });
      merchant = null;
    }
    if (!categoryId && !merchant) continue;
    changes.push({
      transactionId,
      categoryId,
      merchant,
      reason: typeof item.reason === "string" ? item.reason.slice(0, 300) : "",
    });
  }
  if (raw.length > MAX_BULK_TRANSACTIONS) skipped.push({ transactionId: null, reason: `list capped at ${MAX_BULK_TRANSACTIONS}` });
  return { changes, skipped };
}

// ── Gemini ────────────────────────────────────────────────────────────────────

const responseSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      transactionId: { type: Type.STRING, description: "Exactly one of the provided transaction ids" },
      categoryId: { type: Type.STRING, nullable: true, description: "Exactly one of the provided category ids, or null to leave the category unchanged" },
      merchant: { type: Type.STRING, nullable: true, description: "New merchant display name, or null to leave it unchanged" },
      reason: { type: Type.STRING, description: "One short sentence explaining the change" },
    },
    required: ["transactionId", "reason"],
  },
};

// `rows`: [{ id, date, merchant, amount, category }] — category is the current
// category NAME or null. Only these five fields reach the model.
export function buildProposalPrompt({ rows, categories, instruction }) {
  return (
    `You propose edits to bank transactions. Follow the user's instruction and return ` +
    `a JSON array with one entry per transaction that should change; omit transactions ` +
    `that should stay as they are. Use only the transaction ids and category ids given below.\n\n` +
    `Instruction: ${instruction}\n\n` +
    `Categories (id: name):\n${categories.map((c) => `${c.id}: ${c.name}`).join("\n")}\n\n` +
    `Transactions (JSON):\n${JSON.stringify(rows)}`
  );
}

// Production `generate`: a closure over ai.models.generateContent, same client
// setup and model knob (ASK_AI_MODEL) as Ask AI.
export function createBulkGenerate() {
  const model = resolveAskModel();
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
        responseMimeType: "application/json",
        responseSchema,
        httpOptions: { timeout: 30_000 },
        ...thinkingConfigFor(model),
      },
    });
  };
}

// One Gemini call, then validation. Returns { changes, skipped, usage }. A
// response that is not parseable JSON throws with err.usage attached, because
// the call was still billed and the route records it.
export async function proposeBulkUpdate({ rows, categories, instruction, generate }) {
  const res = await generate(buildProposalPrompt({ rows, categories, instruction }));
  const usage = usageFromResponse(res);
  let raw;
  try {
    raw = JSON.parse(res.text);
  } catch {
    const err = new Error("AI returned an unparseable response");
    err.usage = usage;
    throw err;
  }
  const { changes, skipped } = validateChanges(raw, {
    allowedIds: new Set(rows.map((r) => r.id)),
    categoryIds: new Set(categories.map((c) => c.id)),
  });
  return { changes, skipped, usage };
}
