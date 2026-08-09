// Ask AI (Brief 03): natural-language questions answered by Gemini through a
// manual function-calling loop over a READ-ONLY tool surface — every impl
// entry below calls only query functions from db.js; nothing here can write.
//
// runAskLoop is deliberately pure-ish: `generate(contents)` is injected
// (production passes a closure over ai.models.generateContent, tests pass a
// scripted fake) and `impl` is the tool-name → async function map, so the loop
// is unit-testable without a network or a database (test/askAi.test.js).
import { GoogleGenAI, Type } from "@google/genai";
import {
  getVisibleTransactions, getSpendingByCategory, getCategories,
  getLatestBalances, getReportSummary,
} from "./db.js";

export const MAX_ITERATIONS = 8;
export const MAX_RESULT_CHARS = 50_000;
const MAX_HISTORY_TURNS = 10;

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
  {
    name: "list_categories",
    description: "List the user-defined budget categories (id, name, color).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_latest_balances",
    description:
      "Latest snapshot of account balances (account, institution, type, balance, available, snapshot_date).",
    parameters: { type: Type.OBJECT, properties: {} },
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
export async function runAskLoop({ question, history, generate, impl: tools, maxIterations = MAX_ITERATIONS }) {
  const contents = [
    ...clampHistory(history),
    { role: "user", parts: [{ text: question }] },
  ];
  const toolCalls = [];

  for (let i = 0; i < maxIterations; i++) {
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

  return { answer: "I couldn't finish answering that — try a narrower question.", toolCalls };
}

// Production `generate`: a closure over ai.models.generateContent. Created per
// request so the system prompt carries the current date.
export function createGeminiGenerate() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const systemInstruction = buildSystemPrompt();
  return (contents) =>
    ai.models.generateContent({
      model: process.env.ASK_AI_MODEL || "gemini-2.5-flash",
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations }] },
    });
}
