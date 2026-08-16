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
import { addUsage, emptyUsage, parsePositiveNumber, usageFromResponse } from "./geminiUsage.js";

export const MAX_ITERATIONS = 8;
// Ceiling on a single tool result, in characters of JSON. The default is the
// fallback, not the value: ASK_MAX_RESULT_CHARS overrides it at call time.
//
// Why 100k and not more. It was 50k, which is very conservative against
// gemini-3.7-flash's 1M-token context — a whole year of get_report_summary
// serializes past 50k and got cut, which is what produced the wrong answers
// this limit now refuses outright. But the number must NOT simply be maximised,
// because a tool result is not sent once: every functionResponse stays in
// `contents` and is re-sent on every subsequent round-trip, so one oversized
// result is billed up to MAX_ITERATIONS times over. Raising this multiplies
// prompt tokens by the loop; the right fix for a too-big answer is a narrower
// range or a category filter (both of which the refusal below asks for), not a
// bigger ceiling.
export const MAX_RESULT_CHARS = 100_000;
// Same defensive parse the spend guard uses: empty, junk, zero and negative all
// mean "not configured" and take the default rather than yielding NaN — a NaN
// limit makes every length comparison false, which would silently restore the
// unbounded behaviour this exists to bound. Read per call (like ASK_AI_MODEL)
// so the var is settable without a redeploy and testable without module state.
export function resolveMaxResultChars() {
  return parsePositiveNumber(process.env.ASK_MAX_RESULT_CHARS, MAX_RESULT_CHARS);
}
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
// worst case. The 35s was sized when the default model ran with thinking
// switched off entirely; the current default (gemini-3.7-flash) only turns it
// DOWN to LOW — 3.x cannot disable thinking at all — so the normal path now
// carries some thinking time per round-trip. Revisit this budget if latency
// regresses.
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
    "- A tool result of { error: \"RESULT_TOO_LARGE\" } carries NO data at all.",
    "  Call the tool again with a narrower date range or a category filter.",
    "  Never answer from a result that errored.",
    "- A period, month or category ABSENT from a tool result is unknown, not",
    "  zero. Only report $0.00 when a tool returned a zero for it.",
    "- Keep answers concise. Respond in plain text (no markdown tables) and",
    "  format money like $1,234.56.",
  ].join("\n");
}

// ── Tool declarations (what the model sees) ───────────────────────────────────
// TWO SEPARATE CATEGORY TAXONOMIES live behind these tools and nothing in the
// data itself distinguishes them, so each description below says which one it
// speaks:
//   - PLAID categories (transactions.plaid_category) — Plaid's automatic
//     labelling, e.g. "FOOD_AND_DRINK". get_transactions and
//     get_spending_by_category use these.
//   - BUDGET categories (the user's own, assignments → categories.name) —
//     whatever the owner named them, e.g. "Personal - Jared". list_categories
//     and get_report_summary use these.
// A name from one namespace does not match the other, and a non-matching name
// returns zeros rather than an error, so a model that conflates them gets a
// confident $0.00. Saying so in the descriptions is the only signal the model
// ever sees — the tool results carry no namespace marker.
export const functionDeclarations = [
  {
    name: "get_transactions",
    description:
      "List individual transactions. Use for questions about specific purchases, merchants, dates, amounts. Positive amount = money out (spend); negative = money in. The `category` argument filters on PLAID's automatic category (e.g. FOOD_AND_DRINK), NOT the user's budget categories from list_categories — a budget-category name will not match here. INCLUDES pending transactions, unlike get_spending_by_category and get_report_summary, so its totals can exceed theirs for the same range.",
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
      "Spending totals grouped by PLAID's automatic category (e.g. FOOD_AND_DRINK), spend only (positive amounts). Use for 'how much did I spend on X' where X is a kind of purchase. These are NOT the user's budget categories from list_categories and the two sets of names do not correspond. Excludes pending transactions.",
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
    description:
      "List the user's own BUDGET categories (id, name, color) — the ones they created and assign transactions to, e.g. 'Personal - Jared'. These are the names get_report_summary reports and filters on. They are a different namespace from the Plaid categories used by get_transactions and get_spending_by_category. Call this first to get a budget-category name exactly right.",
  },
  {
    name: "get_latest_balances",
    description:
      "Latest snapshot of account balances (account, institution, type, balance, available, snapshot_date).",
  },
  {
    name: "get_report_summary",
    description:
      "Monthly income/spend/net plus per-category totals and top merchants for a date range. Best for overviews and trends. Its categories are the user's own BUDGET categories (as listed by list_categories, e.g. 'Personal - Jared'), NOT the Plaid categories used by get_transactions and get_spending_by_category. Excludes pending transactions. A long range returns a large result; prefer the `category` filter, or a shorter range, over asking for everything.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_date: { type: Type.STRING, description: "YYYY-MM-DD; defaults to 6 full months ago" },
        end_date:   { type: Type.STRING, description: "YYYY-MM-DD; defaults to today" },
        category:   { type: Type.STRING, description: "Optional BUDGET category name (case-insensitive, exactly as list_categories spells it, e.g. 'Personal - Jared'). Restricts monthly and total figures to that one category and makes the result far smaller. A Plaid category name here is an error, not an empty result. top_merchants is NOT filtered by it and always covers every category." },
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

// The pure half of the get_report_summary impl: model arguments in,
// getReportSummary options out. Split out for the same reason buildReportSummary
// is split from getReportSummary in db.js — it makes the mapping (defaults
// applied, `category` threaded through under its db.js name) assertable without
// a database behind it.
export function reportSummaryArgs({ start_date, end_date, category } = {}) {
  const defaults = reportRangeDefaults();
  return {
    startDate: start_date || defaults.startDate,
    endDate: end_date || defaults.endDate,
    category,
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
  get_report_summary: (args = {}) => getReportSummary(reportSummaryArgs(args)),
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

// One broad query must not blow the context — but the way this used to bound it
// caused a wrong answer, so read the whole note before changing it back.
//
// It used to slice the JSON at maxChars and append "(truncated)". Two things
// made that dangerous, and they compounded:
//   - the slice lands mid-token, so what the model received was NOT valid JSON;
//   - buildReportSummary emits months oldest-first (ORDER BY 1 on a 'YYYY-MM'
//     string), so the cut removed the MOST RECENT months — exactly the ones
//     questions are usually about.
// The observed failure: an 8-month get_report_summary went over the limit, the
// tail (June, July, August) was cut, and the model — seeing no August, and
// having nothing telling it August was withheld rather than empty — answered
// "$0.00 month-to-date" one turn after answering "$237.70" from a smaller call.
// A confidently formatted, plausible, wrong answer with no signal that anything
// was missing. Partial AGGREGATE data is worse than none precisely because it
// still looks complete: every month present carries a correct-looking total.
//
// So: over the limit we hand back NO data at all, only a structured refusal the
// model can act on (retry narrower, per the rule in buildSystemPrompt). The
// return value stays a JSON string either way — it is read back as
// functionResponse.response.result — and it is now always parseable, which the
// sliced string was not. The name is kept because it is the tested, imported
// surface; it no longer truncates anything.
export function truncateJson(value, maxChars = resolveMaxResultChars()) {
  const json = JSON.stringify(value);
  // JSON.stringify(undefined) is undefined; pass that through untouched rather
  // than reporting a length on a non-string.
  if (typeof json !== "string") return json;
  if (json.length <= maxChars) return json;
  // Both numbers are in the message on purpose: "too big" alone tells the model
  // nothing about how much narrower to go, and the sizes are the only guidance
  // it can act on. No fragment of `json` appears here — that is the point.
  return JSON.stringify({
    error: "RESULT_TOO_LARGE",
    message:
      `${json.length} chars exceeds the ${maxChars} limit. Narrow the date range ` +
      `or pass a category filter and try again. Do NOT treat missing periods as ` +
      `zero — this result contains no data.`,
  });
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
// Returns { answer, toolCalls, usage } where toolCalls is the ordered list of
// tool names invoked (the route logs it — acceptance criterion 1) and usage is
// the token counts SUMMED over every round-trip the question took. One question
// can cost up to MAX_ITERATIONS generateContent calls and they all land on the
// same bill, so anything less than the sum under-reports — and each round-trip
// re-sends the whole conversation so far, which means the later ones are the
// expensive ones. `usage` is additive to the old return shape: existing callers
// destructure { answer, toolCalls } and are unaffected.
// `now` is injected for the same reason `generate` is: the deadline has to be
// testable without spending real seconds in the suite.
//
// The one exit that can't return anything is a THROW out of `generate` — a 429,
// a socket timeout, an SDK parse failure — and it is the exit that matters most
// for accounting: a question that dies on its fifth round-trip has already paid
// for four, each of them re-sending the whole conversation, so those are the
// most expensive calls Ask AI makes. Letting the exception carry the running
// total up with it is what stops that spend from vanishing (POST /api/ask
// records `err.usage` in its catch). See the catch at the bottom.
export async function runAskLoop({
  question, history, generate, impl: tools,
  maxIterations = MAX_ITERATIONS, deadlineMs = ASK_DEADLINE_MS, now = () => Date.now(),
}) {
  const contents = [
    ...clampHistory(history),
    { role: "user", parts: [{ text: question }] },
  ];
  const toolCalls = [];
  // Every exit below returns whatever has accumulated so far: a run that gives
  // up on the deadline or the iteration cap has still spent the tokens it spent,
  // and those are the runs most worth accounting for. Responses that carry no
  // usageMetadata contribute zeros rather than NaN — that is the scripted-fake
  // case in the tests, and it is also what a future SDK dropping the field
  // would do, neither of which should corrupt a month's total.
  let usage = emptyUsage();
  const deadline = now() + deadlineMs;

  try {
    for (let i = 0; i < maxIterations; i++) {
      // Checked only between round-trips: a request already in flight is left to
      // finish (aborting it would waste tokens already paid for and buys nothing
      // — what we're preventing is *starting* work that can't land in time).
      // So the real worst case is the deadline plus one whole round-trip:
      // ASK_DEADLINE_MS 35s + httpOptions.timeout 20s = 55s, which is why the
      // budget is set below the proxy's assumed 60s timeout rather than at it.
      if (now() >= deadline) {
        return { answer: "That took too long to answer — try a narrower question.", toolCalls, usage };
      }
      const r = await generate(contents);
      usage = addUsage(usage, usageFromResponse(r));
      const calls = r.functionCalls;
      if (!calls || calls.length === 0) {
        return { answer: r.text || "(no answer)", toolCalls, usage };
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
        // Echo the call's id back when the model populated one. Gemini 3 matches
        // a response to its call by id (FunctionCall.id → FunctionResponse.id,
        // dist/genai.d.ts on 2.16.0: "return the response with the matching
        // id"); name alone is ambiguous the moment one turn contains parallel
        // calls to the same tool. gemini-2.5-flash doesn't populate ids, so the
        // key is spread in rather than written out: the object then carries no
        // `id` at all. On the wire it would make no difference — JSON.stringify
        // drops undefined-valued keys — but `Object.keys`/`in` would still see
        // one, and the tests pin that shape to keep the 2.5 request byte-for-byte
        // what it is today.
        contents.push({
          role: "user",
          parts: [{ functionResponse: {
            // `!= null` rather than truthiness: an id is a string, and "" should
            // be passed through as-is rather than silently dropped.
            ...(call.id != null ? { id: call.id } : {}),
            name: call.name,
            response: { result: truncateJson(result) },
          } }],
        });
      }
    }
  } catch (err) {
    // The accounting exit. Everything else here returns `usage`; a throw can't,
    // so the running total rides out on the error instead and POST /api/ask
    // records it from its catch. Without this, the ONE failure mode the route's
    // own comment calls expected — a 429 partway through a multi-round-trip
    // question — silently loses every token the question had already spent,
    // which is the direction geminiUsage.js says a budget guard must never be
    // wrong in.
    //
    // The SAME error object is rethrown, deliberately: the route branches on
    // `err.status === 429` to choose 429 over 502, and wrapping it in a new
    // Error (or rejecting with anything else) would turn every rate limit into
    // a 502. Rethrowing also keeps the stack. `typeof err === "object"` because
    // a thrown string or number is not something you can assign a property to —
    // this file is an ES module, so strict mode makes that a TypeError, and
    // failing to record must never become a second, worse failure.
    if (err && typeof err === "object") err.usage = usage;
    throw err;
  }

  // Iteration cap, not the clock — deliberately worded differently from the
  // deadline answer above so a log or a bug report tells you which limit bit.
  return { answer: "I couldn't finish answering that — try a narrower question.", toolCalls, usage };
}

// Resolved in one place because two things now depend on the model name: the
// request itself and how (or whether) thinking can be turned down for it.
// The default is a moving target — it tracks the current-generation flash
// model, so it changes as Google ships one — and ASK_AI_MODEL is the escape
// hatch for when a new default misbehaves in production: setting it (e.g.
// `fly secrets set ASK_AI_MODEL=gemini-2.5-flash`) rolls back to a known-good
// model without a deploy. Don't rename it or let the default win over it.
export function resolveAskModel() {
  return process.env.ASK_AI_MODEL || "gemini-3.7-flash";
}

// Thinking costs latency we don't need — Ask AI runs up to MAX_ITERATIONS
// round-trips, so per-call thinking time is multiplied by the loop. How you
// turn it down depends on the model GENERATION, and the two knobs are mutually
// exclusive: ThinkingConfig carries both `thinkingBudget` (a token count, "0 is
// DISABLED") and `thinkingLevel` (an enum), but Gemini 3 REPLACED the budget
// with the level and rejects a request that sets both. So each branch below
// emits exactly one field, never both.
//   - 2.5 flash tier → thinkingBudget 0, i.e. thinking fully off. Unchanged.
//   - 3.x flash tier → thinkingLevel LOW. LOW is the floor here, not MINIMAL:
//     gemini-3.7-flash does not support MINIMAL and fails request validation on
//     it, so thinking cannot be switched off entirely on 3.x — only turned down.
// Everything else keeps the model's own default, because the field is NOT
// universally settable and ASK_AI_MODEL is an env knob: sending it to a model
// that won't take it turns one env var into a config that 400s every single
// request — precisely the failure class removed from the tool declarations
// above. Three distinct ways to get that wrong:
//   - pro of any generation understands thinking but cannot switch it off
//     (gemini-2.5-pro has a minimum budget of 128), so 0 is rejected;
//   - gemini-2.0-flash / gemini-1.5-flash predate thinking entirely and have
//     no thinkingConfig to set — matching them on the substring "flash" would
//     reintroduce the same breakage from the other direction;
//   - crossing the generations, e.g. sending thinkingBudget to a 3.x model or
//     thinkingLevel to a 2.5 one, is wrong even though both models think.
// So this is an allow-list, not a keyword search: only the flash tiers whose
// accepted field is known (gemini-2.5-flash / gemini-3.N-flash, their -lite
// variants and dated/preview suffixes) get one. Anything unrecognised — new
// models, other vendors' naming, a typo — falls through to {}, so the failure
// mode of being wrong here is "slower than it could be", never "broken".
// Returns a spreadable fragment so "omit" really means absent, not an
// undefined key. (Field names verified against dist/genai.d.ts on 2.16.0.)
//
// ThinkingLevel mirrors the SDK's plain-string enum exactly as Type does at the
// top of this file, and only the one member we send. The casing is a live trap:
// the SDK declares the name TWICE. `ThinkingConfig.thinkingLevel` — the field
// generateContent takes, which is our path — is typed as the UPPERCASE enum
// `ThinkingLevel` (LOW = "LOW"). The lowercase spelling in the same file
// ("minimal" | "low" | "medium" | "high") is a different type that hangs off
// `GenerationConfig_2.thinking_level`, the agent/streaming surface, which
// nothing here uses. So the wire value must be "LOW"; lowercasing it sends
// generateContent a level its enum doesn't define.
const ThinkingLevel = { LOW: "LOW" };
export function thinkingConfigFor(model) {
  const name = String(model);
  if (/^gemini-2\.5-flash\b/.test(name)) return { thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-3\.\d+-flash\b/.test(name)) return { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
  return {};
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
