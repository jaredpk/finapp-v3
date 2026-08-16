// Gemini token accounting and the monthly budget guard. Two callers spend the
// same GEMINI_API_KEY — the interactive Ask AI loop and the unattended daily
// receipt scanner — and only one of them has anybody watching while it runs, so
// every completed call writes a row (gemini_usage in db.js) and both check the
// month-to-date total before starting work.
//
// The first half of this file is deliberately I/O-free and takes its clock
// injected (`now = () => Date.now()`, the same shape askAi.js uses for its
// deadline) so the pricing and budget math is unit-testable without a database
// or a wall clock — test/geminiUsage.test.js exercises exactly that. The second
// half is the shared gate, which does read and write the DB.
import { getGeminiSpendForMonth, recordGeminiUsage } from "./db.js";

// ── Pricing ───────────────────────────────────────────────────────────────────
// USD per 1,000,000 tokens, verified against Google's published Gemini API
// pricing on 2026-08-16. These are POINT-IN-TIME numbers hard-coded into the
// app: Google moves them and nothing here notices. Everything computed from
// this table is therefore an ESTIMATE, good enough to stop a runaway bill and
// nothing more — it is NOT authoritative. Cloud Billing is, and where the two
// disagree, Cloud Billing is right.
//
// gemini-3.7-flash shipped at introductory rates that expire at the end of
// 2026; from 2027-01-01 UTC both input and output double. That switch is a pure
// function of the call's timestamp rather than a note to edit this file in
// January, because the cost of forgetting is under-reporting spend by half on
// the model Ask AI runs by default.
const STANDARD_PRICING_FROM_MS = Date.parse("2027-01-01T00:00:00Z");

const PRICING = {
  "gemini-3.7-flash": {
    intro:    { input: 0.75, output: 3.75, cachedInput: 0.075 },
    standard: { input: 1.50, output: 7.50 },
  },
  "gemini-2.5-flash": {
    standard: { input: 0.30, output: 2.50 },
  },
};

// Google publishes a cached-input rate for some tiers and not others (the 2027
// standard tier for 3.7-flash has not been published at all yet). Rather than
// invent a discount, an unpublished cached rate bills at the full input rate:
// that over-states the cost a little, and over-stating is the only safe
// direction for a guard whose whole job is to stop spending. The spread comes
// second so a published rate always wins over the default.
function withCachedRate(rates) {
  return { cachedInput: rates.input, ...rates };
}

// The highest rate this table knows of in each dimension, across every model
// and both pricing eras. Unknown models — a Gemini release newer than this
// file, a typo in ASK_AI_MODEL/RECEIPT_MODEL, gemini-2.5-flash-lite, anything
// future — are priced with it. Zero would be the intuitive default and it is
// the dangerous one: a budget that silently under-counts never trips, which is
// precisely the runaway this module exists to catch. Over-counting only ever
// stops us early, and it is visible rather than silent — the row is marked
// "fallback" and surfaces as `unpricedCalls` on the card. Deliberately not
// date-aware either: the 2027 rates are the highest we know, so an unknown
// model is charged at them today.
const ALL_RATE_CARDS = Object.values(PRICING)
  .flatMap((tiers) => Object.values(tiers))
  .map(withCachedRate);
const FALLBACK_RATES = {
  input:       Math.max(...ALL_RATE_CARDS.map((r) => r.input)),
  output:      Math.max(...ALL_RATE_CARDS.map((r) => r.output)),
  cachedInput: Math.max(...ALL_RATE_CARDS.map((r) => r.cachedInput)),
};

// Once per model name per process. A scan runs up to MAX_MESSAGES_PER_RUN
// Gemini calls in a row, and forty identical lines would bury the one thing
// this is trying to say: a model is being billed at a guessed rate and the
// table above needs a new entry.
const loggedFallbackModels = new Set();
function noteFallbackPricing(model) {
  if (loggedFallbackModels.has(model)) return;
  loggedFallbackModels.add(model);
  console.warn(
    `gemini-usage: no published price for model "${model}" — estimating at the highest known ` +
      `rate ($${FALLBACK_RATES.input}/$${FALLBACK_RATES.output} per 1M in/out). Add it to PRICING in geminiUsage.js.`
  );
}

// A NaN timestamp (a caller injecting a bad date) resolves to the standard —
// i.e. more expensive — tier, because `NaN < x` is false. That is the same safe
// direction as everything else here, so it is left as-is rather than guarded.
function resolveRates(model, nowMs) {
  const tiers = PRICING[String(model)];
  if (!tiers) return { rates: FALLBACK_RATES, priced: "fallback" };
  const useIntro = Boolean(tiers.intro) && nowMs < STANDARD_PRICING_FROM_MS;
  return { rates: withCachedRate(useIntro ? tiers.intro : tiers.standard), priced: "exact" };
}

// Token counts arrive from an SDK field that is optional everywhere, so anything
// missing, negative or unparseable counts as zero rather than poisoning the sum
// with NaN.
const tokens = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
// Matches the estimated_cost_usd column, NUMERIC(12,6): rounding here means the
// number we log is the number Postgres stores.
const round6 = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// { costUsd, priced } for one call. `priced` is "exact" when the model was in
// the table and "fallback" when its cost was guessed, and it is stored per row
// so a month's total can say how much of itself it actually knows.
export function estimateCostUsd({ model, promptTokens, outputTokens, cachedTokens, now = () => Date.now() } = {}) {
  const { rates, priced } = resolveRates(model, now());
  if (priced === "fallback") noteFallbackPricing(String(model));
  const cached = tokens(cachedTokens);
  // promptTokenCount already INCLUDES the cached tokens ("when `cached_content`
  // is set, this also includes the number of tokens in the cached content" —
  // GenerateContentResponseUsageMetadata, dist/genai.d.ts on @google/genai
  // 2.16.0), so the cached share comes out before the full input rate is
  // applied. Charging both would bill the discounted half of a cached prompt
  // twice, at the wrong rate.
  const freshPrompt = Math.max(0, tokens(promptTokens) - cached);
  const costUsd = round6(
    (freshPrompt * rates.input + tokens(outputTokens) * rates.output + cached * rates.cachedInput) / 1_000_000
  );
  return { costUsd, priced };
}

// ── Budget knobs ──────────────────────────────────────────────────────────────
// Env numbers that gate spending are parsed defensively: a malformed value has
// to land on the default and never on NaN. Every comparison against NaN is
// false, so a NaN budget would report "ok" at any spend and switch the guard
// off without a word — the one failure mode this module cannot have. Empty,
// junk, zero and negative all mean "not configured", so they take the default:
// a budget of 0 would block everything forever, which is no more likely to be
// what someone typing it meant than "abc" was.
export function parsePositiveNumber(raw, fallback) {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_MONTHLY_BUDGET_USD = 10;
export const MONTHLY_BUDGET_USD = parsePositiveNumber(
  process.env.GEMINI_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD);

// Warn at 80% of the budget, cut the scanner off at 100%. Ask AI runs on past
// both up to ASK_HARD_CEILING_PCT — it is the interactive caller, and telling
// the owner "no" mid-question over a couple of dollars is the worse outcome;
// the scanner has no such excuse because nobody is watching it spend.
export const WARN_PCT = 80;
export const ASK_HARD_CEILING_PCT = parsePositiveNumber(process.env.GEMINI_ASK_CEILING_PCT, 150);

// Percentage of the monthly budget already spent, rounded to cents-of-a-percent
// so the guard and the card agree on the boundary cases rather than differing
// in the sixth decimal. A spend figure that isn't a finite number degrades to 0
// (fail open) rather than to NaN: the SUM in db.js is cast to float precisely so
// this can't happen, and if it somehow does, a guard that can't read the total
// should not brick the app.
export function budgetPct(spentUsd, budgetUsd = MONTHLY_BUDGET_USD) {
  const budget = parsePositiveNumber(budgetUsd, MONTHLY_BUDGET_USD);
  const spent = Number(spentUsd);
  return round2(((Number.isFinite(spent) && spent > 0 ? spent : 0) / budget) * 100);
}

export function budgetLevel(spentUsd, budgetUsd = MONTHLY_BUDGET_USD) {
  const pct = budgetPct(spentUsd, budgetUsd);
  if (pct >= 100) return "over";
  if (pct >= WARN_PCT) return "warn";
  return "ok";
}

// YYYY-MM in UTC, the same convention the reports already use (TO_CHAR(date,
// 'YYYY-MM') and the Date.UTC month arithmetic behind /api/reports/summary), so
// "this month" means one thing everywhere regardless of what the machine or the
// browser thinks its timezone is. The budget therefore resets on the UTC first.
export function currentMonthKey(now = () => Date.now()) {
  const d = new Date(now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Reading usage off a response ──────────────────────────────────────────────
// GenerateContentResponse.usageMetadata → the four numbers we store. Field
// names verified against dist/genai.d.ts on @google/genai 2.16.0
// (GenerateContentResponseUsageMetadata): promptTokenCount,
// candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount,
// toolUsePromptTokenCount and totalTokenCount. Every one of them is declared
// optional, which is why they all go through tokens() and why a response
// carrying no usageMetadata at all yields zeros instead of NaN — the scripted
// fakes in test/askAi.test.js are exactly that case, and zeros are the honest
// answer there: we don't know what it cost, and a fake cost nothing.
//
// Two of the six are folded into the pair the rate table actually prices, both
// in the same direction: toward counting more, never less.
//
//   - thoughtsTokenCount → outputTokens. The SDK reports thinking separately,
//     but Google bills it at the OUTPUT rate, and Ask AI's default model can't
//     switch thinking off at all — thinkingConfigFor in askAi.js only turns 3.x
//     down to LOW — so on the normal path it is a real, recurring share of every
//     call. Counting candidatesTokenCount alone under-reports every 3.x request.
//
//   - toolUsePromptTokenCount → promptTokens. "The number of tokens in the
//     results from tool executions, which are provided back to the model as
//     input" (dist/genai.d.ts), and totalTokenCount's own doc names it as a
//     separate summand alongside prompt/candidates/thoughts — i.e. it is
//     billable input that promptTokenCount does NOT already contain. Ask AI is
//     precisely the tool-use path (up to MAX_ITERATIONS round-trips, every one
//     of them feeding a tool result back in), so leaving it out under-reported
//     the single biggest spender here. Cached tokens still come out of this sum
//     in estimateCostUsd, which is correct: the cache discount applies to the
//     prompt share, and a tool result is never the cached share.
//
// Under-reporting is the one direction a budget guard must not be wrong in,
// which is why both foldings exist. totalTokenCount is still taken as reported
// and only reconstructed when the SDK omits it — the reconstruction now covers
// tool-use tokens for free, since they are inside promptTokens.
export function usageFromResponse(res) {
  const u = res?.usageMetadata;
  const promptTokens = tokens(u?.promptTokenCount) + tokens(u?.toolUsePromptTokenCount);
  const outputTokens = tokens(u?.candidatesTokenCount) + tokens(u?.thoughtsTokenCount);
  const cachedTokens = tokens(u?.cachedContentTokenCount);
  const totalTokens = tokens(u?.totalTokenCount) || promptTokens + outputTokens;
  return { promptTokens, outputTokens, cachedTokens, totalTokens };
}

export const emptyUsage = () => ({ promptTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 });

// Accumulator for loops that make several calls under one user request (Ask AI
// makes up to MAX_ITERATIONS of them and they all land on one bill). Returns a
// new object rather than mutating, so a partial total can be returned from any
// early exit without the caller worrying about aliasing.
export function addUsage(a, b) {
  return {
    promptTokens: tokens(a?.promptTokens) + tokens(b?.promptTokens),
    outputTokens: tokens(a?.outputTokens) + tokens(b?.outputTokens),
    cachedTokens: tokens(a?.cachedTokens) + tokens(b?.cachedTokens),
    totalTokens:  tokens(a?.totalTokens)  + tokens(b?.totalTokens),
  };
}

// ── The shared gate (this half touches the DB) ────────────────────────────────

// The one budget snapshot everything shares: both call sites gate on it and GET
// /api/gemini-usage renders it, so the number the card shows is by construction
// the number the guard acted on. Silent by design — see checkGeminiBudget for
// the logging and fail-open variant.
//
// `getSpend` is injected for the same reason `now` is: it is the only line in
// here that touches Postgres, so handing it in lets test/geminiUsage.test.js
// drive the empty month, a populated month and a throwing read without a
// database. Both parameters default to production, so no call site passes them.
export async function getBudgetStatus(now = () => Date.now(), { getSpend = getGeminiSpendForMonth } = {}) {
  const month = currentMonthKey(now);
  const { spentUsd, calls, unpricedCalls } = await getSpend(month);
  return {
    month,
    spentUsd: round6(spentUsd),
    budgetUsd: MONTHLY_BUDGET_USD,
    pct: budgetPct(spentUsd),
    level: budgetLevel(spentUsd),
    calls,
    unpricedCalls,
    // False here because a failed read throws out of this function rather than
    // returning; only checkGeminiBudget's fail-open path sets it true. It is on
    // the success shape too so both shapes a checkGeminiBudget caller can get
    // carry the field rather than one of them leaving it undefined.
    //
    // On the wire it is therefore always false: /api/gemini-usage spreads this
    // object into its response but calls getBudgetStatus directly, so the
    // failing-open case never reaches it — that read having thrown is a 500
    // there. The settings card treats that 500 as the failing-open state
    // anyway, which is honest: it is the same gemini_usage read, so if the card
    // can't get a number, neither can the guard, and the guard's answer to that
    // is to allow the call. Keep the two facts in step if this route ever
    // starts degrading to a body instead of a 500 — the card already reads
    // `unknown` for that day.
    unknown: false,
  };
}

// What a caller gets when the usage table could not be read: level "ok", so the
// call it was about to make goes ahead, and `unknown` so nobody mistakes it for
// a genuinely quiet month. The counts are 0 rather than null because every
// consumer formats them ($${spentUsd}, ${pct}%) and "$null" helps no one — the
// flag is what carries "we don't know", not the numbers.
function unknownBudgetStatus(now) {
  return {
    month: currentMonthKey(now),
    spentUsd: 0,
    budgetUsd: MONTHLY_BUDGET_USD,
    pct: 0,
    level: "ok",
    calls: 0,
    unpricedCalls: 0,
    unknown: true,
  };
}

// The same snapshot plus the warning line, for callers that are about to spend.
// The read-only card route uses getBudgetStatus instead, so opening the card
// can't fill the log. No attempt is made to detect the crossing edge: there is
// no durable "already warned" state, and the gate runs once per Ask AI question
// and once per scan run — a handful of lines a day at most — so warning every
// time is what puts it in whatever log window someone is actually reading.
//
// FAILS OPEN. A spend guard must never be the reason the app stops working: if
// the gemini_usage read throws, this returns the permissive status above rather
// than propagating, because an unreadable usage table degrades us to
// "unprotected but working", which is strictly better than "protected but
// broken" — Ask AI and the nightly scan both worked fine before this module
// existed and must keep working when its storage doesn't. The Cloud Billing
// budget alert is the backstop that still holds while we're blind. This is the
// exception-path half of the same rule budgetPct already applies to values: a
// guard that can't read the total should not brick the app.
export async function checkGeminiBudget(feature, { now = () => Date.now(), getSpend = getGeminiSpendForMonth } = {}) {
  let status;
  try {
    status = await getBudgetStatus(now, { getSpend });
  } catch (err) {
    console.warn(
      // `err?.message`, not `err.message`: a rejection carrying null/undefined
      // would throw INSIDE this handler, which turns the documented fail-open
      // into a throw — the exact opposite of what this block exists to do.
      `gemini-usage: could not read month-to-date spend for ${feature} (${err?.message}) — ` +
        `allowing the call and treating spend as unknown. The Gemini budget guard is OFF until ` +
        `this read succeeds; the Cloud Billing budget alert is the remaining backstop.`
    );
    return unknownBudgetStatus(now);
  }
  if (status.level !== "ok") {
    console.warn(
      `gemini-usage: ${feature} at ${status.pct}% of the $${status.budgetUsd} monthly Gemini budget ` +
        `($${status.spentUsd} spent in ${status.month}) — level ${status.level}`
    );
  }
  return status;
}

// Prices one completed call and writes its row, swallowing anything that goes
// wrong doing so. A usage row is bookkeeping: losing one costs a slightly low
// month-to-date total, while letting its failure propagate would fail the
// user's actual answer, or abort a scan mid-run, over a DB hiccup on a table
// nothing else reads. So this must never throw — keep the try/catch around
// everything, including the pricing.
//
// `record` is injected on the same terms as getBudgetStatus's `getSpend`: the
// default is production and no call site passes it, but a fake lets the tests
// prove the swallowing above without a database to break on cue.
export async function recordGeminiCall({ feature, model, usage, now = () => Date.now(), record = recordGeminiUsage }) {
  try {
    const { costUsd, priced } = estimateCostUsd({ model, ...usage, now });
    await record({
      feature,
      model,
      promptTokens: tokens(usage?.promptTokens),
      outputTokens: tokens(usage?.outputTokens),
      cachedTokens: tokens(usage?.cachedTokens),
      totalTokens: tokens(usage?.totalTokens),
      estimatedCostUsd: costUsd,
      priced,
    });
  } catch (err) {
    // `err?.message` is load-bearing, not defensive habit. This function is
    // awaited inside POST /api/ask's catch, BEFORE the error response is sent.
    // An unguarded `err.message` on a rejection carrying null/undefined throws
    // out of this handler, past that await, and `res.status(...).json(...)`
    // never runs — the request then hangs until a gateway timeout and the user
    // gets an un-parseable 502. That is the precise failure this whole module
    // was added to help diagnose, so it must not be reintroduced here.
    // Unreachable through the pg path (node-postgres rejects with Errors), but
    // that is the callee's discipline, not ours.
    console.error(`gemini-usage: failed to record ${feature} usage (non-fatal):`, err?.message);
  }
}
