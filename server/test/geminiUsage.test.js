import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateCostUsd, budgetLevel, budgetPct, currentMonthKey, parsePositiveNumber,
  usageFromResponse, addUsage, emptyUsage,
  getBudgetStatus, checkGeminiBudget, recordGeminiCall,
  WARN_PCT, ASK_HARD_CEILING_PCT, DEFAULT_MONTHLY_BUDGET_USD, MONTHLY_BUDGET_USD,
} from "../geminiUsage.js";

// The pricing and budget half of geminiUsage.js: no database, no network, no
// wall clock. Everything date-dependent takes `now` injected (the same shape
// askAi.js uses for its deadline), which is the only way to test a price change
// that happens on 2027-01-01 without waiting for it.
//
// What these tests are actually protecting is a direction, not a number. Every
// estimate here is allowed to be a little high — Cloud Billing is authoritative
// and this is a guard, not an invoice — but an estimate that comes out LOW is a
// budget that never trips, which is the whole failure this module exists to
// prevent. So the assertions below pin the safe direction wherever the exact
// figure is a judgement call: unknown models, unpublished cached rates, junk
// env values.

const at = (iso) => () => Date.parse(iso);
const MILLION = 1_000_000;

// The boundary itself. Intro pricing runs through 2026-12-31 inclusive and the
// standard rates take over at 2027-01-01T00:00:00Z — in UTC, like every other
// date in this app.
const LAST_INTRO_INSTANT = at("2026-12-31T23:59:59.999Z");
const FIRST_STANDARD_INSTANT = at("2027-01-01T00:00:00Z");

test("gemini-3.7-flash is priced at introductory rates through the end of 2026", () => {
  const input = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: MILLION, outputTokens: 0, now: LAST_INTRO_INSTANT,
  });
  assert.deepEqual(input, { costUsd: 0.75, priced: "exact" });

  const output = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: 0, outputTokens: MILLION, now: LAST_INTRO_INSTANT,
  });
  assert.equal(output.costUsd, 3.75);

  // Mid-2026, nowhere near the boundary: same rates.
  const august = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: MILLION, outputTokens: MILLION, now: at("2026-08-16T12:00:00Z"),
  });
  assert.equal(august.costUsd, 0.75 + 3.75);
});

// The introductory rates expire; the standard ones are double. A guard that
// kept quoting the intro price into 2027 would under-count spend by half on the
// model Ask AI runs by default — which is why the switch is a function of the
// timestamp rather than a reminder to edit the table in January.
test("gemini-3.7-flash doubles at the 2027-01-01 UTC boundary", () => {
  const input = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: MILLION, outputTokens: 0, now: FIRST_STANDARD_INSTANT,
  });
  assert.deepEqual(input, { costUsd: 1.5, priced: "exact" });

  const output = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: 0, outputTokens: MILLION, now: FIRST_STANDARD_INSTANT,
  });
  assert.equal(output.costUsd, 7.5);

  // One millisecond apart, twice the price: the boundary is exactly where the
  // comment in geminiUsage.js says it is, not a day either side of it.
  const before = estimateCostUsd({ model: "gemini-3.7-flash", promptTokens: MILLION, now: LAST_INTRO_INSTANT });
  const after = estimateCostUsd({ model: "gemini-3.7-flash", promptTokens: MILLION, now: FIRST_STANDARD_INSTANT });
  assert.equal(after.costUsd, before.costUsd * 2);
});

// gemini-2.5-flash has one rate card and no expiry, so the date must not move
// it. It is also the receipt scanner's default model, i.e. the one doing the
// unattended spending.
test("gemini-2.5-flash is priced the same on both sides of the boundary", () => {
  for (const now of [LAST_INTRO_INSTANT, FIRST_STANDARD_INSTANT, at("2029-06-01T00:00:00Z")]) {
    const r = estimateCostUsd({ model: "gemini-2.5-flash", promptTokens: MILLION, outputTokens: MILLION, now });
    assert.deepEqual(r, { costUsd: 0.3 + 2.5, priced: "exact" });
  }
});

// promptTokenCount INCLUDES the cached tokens (the SDK says so), so the cached
// share has to come out before the full input rate is applied — otherwise the
// discounted half of a cached prompt is billed twice, at the wrong rate.
test("cached tokens are billed at the cached rate and not double-counted as input", () => {
  const { costUsd } = estimateCostUsd({
    model: "gemini-3.7-flash",
    promptTokens: MILLION,        // 1M total, of which…
    cachedTokens: 200_000,        // …200k came from the cache
    now: LAST_INTRO_INSTANT,
  });
  // 800k fresh at $0.75/M + 200k cached at $0.075/M
  assert.equal(costUsd, 0.6 + 0.015);

  // Cached can't exceed prompt, but a malformed pair must not produce a
  // negative cost that eats away at the month's total.
  const nonsense = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: 100, cachedTokens: 5000, now: LAST_INTRO_INSTANT,
  });
  assert.ok(nonsense.costUsd >= 0, "a cost estimate may never be negative");
});

// A tier with no published cached rate charges cached tokens at the full input
// rate. It over-states slightly, which is the safe direction; guessing a
// discount would under-state, which is not.
test("a model with no published cached rate bills cached tokens at the input rate", () => {
  const cached = estimateCostUsd({
    model: "gemini-2.5-flash", promptTokens: MILLION, cachedTokens: MILLION, now: LAST_INTRO_INSTANT,
  });
  const plain = estimateCostUsd({ model: "gemini-2.5-flash", promptTokens: MILLION, now: LAST_INTRO_INSTANT });
  assert.equal(cached.costUsd, plain.costUsd);
});

// An unknown model logs a line the first time it is priced, so the tests below
// that deliberately price unknown models silence console.warn rather than
// littering the suite's output with it. The logging itself is asserted on its
// own further down.
test("known models are marked exact, unknown ones fallback", (t) => {
  t.mock.method(console, "warn", () => {});
  for (const model of ["gemini-3.7-flash", "gemini-2.5-flash"]) {
    assert.equal(estimateCostUsd({ model, promptTokens: 1, now: LAST_INTRO_INSTANT }).priced, "exact");
  }
  for (const model of ["gemini-3.6-flash", "gemini-2.5-flash-lite", "gemini-4.0-pro", "", undefined, null]) {
    assert.equal(
      estimateCostUsd({ model, promptTokens: 1, now: LAST_INTRO_INSTANT }).priced, "fallback",
      `${model} is not in the price table and must be marked fallback`
    );
  }
});

// The load-bearing one. Zero is the intuitive default for an unpriced model and
// it is the dangerous one: a month that silently under-counts never reaches
// 100%, so the scanner is never cut off and nobody finds out until the bill
// arrives. An unknown model is charged the highest rate the table knows of
// instead — including the 2027 rates, even today.
test("an unknown model is priced at the highest known rate, never at zero", (t) => {
  t.mock.method(console, "warn", () => {});
  const unknown = estimateCostUsd({
    model: "gemini-9.9-flash-unreleased", promptTokens: MILLION, outputTokens: MILLION,
    now: LAST_INTRO_INSTANT,
  });
  assert.equal(unknown.priced, "fallback");
  assert.ok(unknown.costUsd > 0, "an unknown model must not be free");
  assert.equal(unknown.costUsd, 1.5 + 7.5); // the 2027 standard rates: the highest we know

  // And the property that actually matters: no known model, at any date, costs
  // more than the fallback for the same tokens.
  for (const now of [LAST_INTRO_INSTANT, FIRST_STANDARD_INSTANT]) {
    for (const model of ["gemini-3.7-flash", "gemini-2.5-flash"]) {
      const known = estimateCostUsd({ model, promptTokens: MILLION, outputTokens: MILLION, now });
      assert.ok(
        known.costUsd <= unknown.costUsd,
        `${model} at ${new Date(now()).toISOString()} costs more than the fallback rate`
      );
    }
  }

  // Cached tokens on an unknown model are guessed high too, for the same reason.
  const cachedOnly = estimateCostUsd({
    model: "gemini-9.9-flash-unreleased", promptTokens: MILLION, cachedTokens: MILLION,
    now: LAST_INTRO_INSTANT,
  });
  assert.equal(cachedOnly.costUsd, 1.5);
});

// Whatever comes in, a number comes out: a NaN cost would be written to the
// usage row and poison every SUM taken over it afterwards.
test("estimateCostUsd never returns NaN, whatever it is handed", (t) => {
  t.mock.method(console, "warn", () => {});
  const junk = [
    {},
    { model: "gemini-3.7-flash" },
    { model: "gemini-3.7-flash", promptTokens: "lots", outputTokens: null, cachedTokens: undefined },
    { model: 12345, promptTokens: -1, outputTokens: NaN },
    { model: "gemini-2.5-flash", promptTokens: Infinity },
  ];
  for (const args of junk) {
    const { costUsd } = estimateCostUsd({ ...args, now: LAST_INTRO_INSTANT });
    assert.ok(Number.isFinite(costUsd), `${JSON.stringify(args)} produced ${costUsd}`);
    assert.ok(costUsd >= 0);
  }
  // No argument object at all — the defaulted call still has to answer.
  assert.ok(Number.isFinite(estimateCostUsd().costUsd));
});

// A guessed price has to be visible, or the first anyone knows about a model
// missing from the table is a month that doesn't add up. Once per model name
// per process, though: a scan makes up to MAX_MESSAGES_PER_RUN calls in a row
// and forty copies of the same line would bury it.
test("an unpriced model is logged once, not once per call", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const model = "gemini-8.1-flash-never-seen-before";

  for (let i = 0; i < 5; i++) {
    estimateCostUsd({ model, promptTokens: 1000, now: LAST_INTRO_INSTANT });
  }

  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], new RegExp(model));
});

// ── Budget levels ─────────────────────────────────────────────────────────────
// Warn at 80%, block at 100%. The boundaries are inclusive on the way up, which
// is what "block at 100%" means: at exactly the budget, the scanner stops.
test("budgetLevel: ok below 80%, warn from 80%, over from 100%", () => {
  const budget = 10;
  assert.equal(budgetLevel(0, budget), "ok");        //   0%
  assert.equal(budgetLevel(7.9, budget), "ok");      //  79%
  assert.equal(budgetLevel(8, budget), "warn");      //  80% — the warn threshold, inclusive
  assert.equal(budgetLevel(9.9, budget), "warn");    //  99%
  assert.equal(budgetLevel(10, budget), "over");     // 100% — the scanner's cutoff, inclusive
  assert.equal(budgetLevel(15, budget), "over");     // 150% — Ask AI's default ceiling
  assert.equal(budgetPct(15, budget), 150);
});

test("budgetLevel: the warn threshold is WARN_PCT, not a second copy of 80", () => {
  const budget = 10;
  assert.equal(budgetLevel(budget * (WARN_PCT / 100), budget), "warn");
  assert.equal(budgetLevel(budget * ((WARN_PCT - 0.1) / 100), budget), "ok");
});

// A budget read back as NaN would report "ok" at any spend — every comparison
// against NaN is false — and the guard would be off with nothing in the logs to
// say so. Same for an unreadable spend figure, which fails open to 0% rather
// than to NaN.
test("budgetLevel and budgetPct never yield NaN on unreadable input", () => {
  for (const spent of [NaN, undefined, null, "abc", Infinity, -3]) {
    const pct = budgetPct(spent, 10);
    assert.ok(Number.isFinite(pct), `spent=${spent} produced ${pct}`);
    assert.equal(budgetLevel(spent, 10), "ok");
  }
  for (const budget of [NaN, 0, -5, "abc", undefined, null, ""]) {
    const pct = budgetPct(5, budget);
    assert.ok(Number.isFinite(pct), `budget=${budget} produced ${pct}`);
    // Falls back to the $10 default, so $5 spent is half of it.
    assert.equal(pct, 50);
  }
});

// ── Env parsing ───────────────────────────────────────────────────────────────
// GEMINI_MONTHLY_BUDGET_USD is a string typed by a human into `fly secrets set`.
// Anything unusable has to land on the default rather than on NaN (which
// disables the guard) or on 0 (which blocks everything forever) — neither is a
// plausible reading of a typo.
test("a malformed GEMINI_MONTHLY_BUDGET_USD falls back to the default, never NaN", () => {
  for (const raw of ["", "   ", "abc", "-5", "0", "0.0", "$10", "10abc", undefined, null, NaN, {}, []]) {
    const parsed = parsePositiveNumber(raw, DEFAULT_MONTHLY_BUDGET_USD);
    assert.ok(Number.isFinite(parsed), `${JSON.stringify(raw)} produced ${parsed}`);
    assert.ok(parsed > 0, `${JSON.stringify(raw)} produced a non-positive budget`);
    assert.equal(parsed, DEFAULT_MONTHLY_BUDGET_USD);
  }
});

test("a usable GEMINI_MONTHLY_BUDGET_USD wins over the default", () => {
  assert.equal(parsePositiveNumber("25", DEFAULT_MONTHLY_BUDGET_USD), 25);
  assert.equal(parsePositiveNumber(" 2.50 ", DEFAULT_MONTHLY_BUDGET_USD), 2.5);
  assert.equal(parsePositiveNumber(0.01, DEFAULT_MONTHLY_BUDGET_USD), 0.01);
  // The Ask AI ceiling uses the same parser, in percent rather than dollars.
  assert.equal(parsePositiveNumber("200", 150), 200);
  assert.equal(parsePositiveNumber("not-a-percent", 150), 150);
});

// ── Month keys ────────────────────────────────────────────────────────────────
// The budget month is a UTC month, matching the reports. This is the difference
// between the guard resetting when the reports say the month turned over and it
// resetting five hours late (or early) depending on where the machine runs.
test("currentMonthKey is UTC and zero-pads the month", () => {
  assert.equal(currentMonthKey(at("2026-08-16T12:00:00Z")), "2026-08");
  assert.equal(currentMonthKey(at("2026-01-01T00:00:00Z")), "2026-01");
  assert.equal(currentMonthKey(at("2026-10-05T00:00:00Z")), "2026-10");
});

test("currentMonthKey rolls over at the UTC new year, not a moment before", () => {
  assert.equal(currentMonthKey(at("2026-12-31T23:59:59.999Z")), "2026-12");
  assert.equal(currentMonthKey(at("2027-01-01T00:00:00.000Z")), "2027-01");
  assert.equal(currentMonthKey(at("2027-01-31T23:59:59.999Z")), "2027-01");
  assert.equal(currentMonthKey(at("2027-02-01T00:00:00.000Z")), "2027-02");
});

// The instants where a local-time reading would name a different month. In
// US Eastern, 2026-09-01T02:00Z is still August 31st; in Asia/Tokyo,
// 2026-08-31T23:00Z is already September 1st. Both must answer in UTC.
test("currentMonthKey answers in UTC even where the local month differs", () => {
  assert.equal(currentMonthKey(at("2026-09-01T02:00:00Z")), "2026-09"); // Aug 31, 22:00 in New York
  assert.equal(currentMonthKey(at("2026-08-31T23:00:00Z")), "2026-08"); // Sep 1, 08:00 in Tokyo
  assert.equal(currentMonthKey(at("2027-01-01T04:00:00Z")), "2027-01"); // Dec 31, 23:00 in New York

  // And it is genuinely reading the UTC fields, not the local ones: the two
  // only agree when the process runs in UTC, so assert against getUTCMonth
  // directly rather than against a hard-coded string that would pass anywhere.
  const d = new Date("2026-09-01T02:00:00Z");
  assert.equal(currentMonthKey(() => d.getTime()),
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
});

// ── Reading usage off a response ──────────────────────────────────────────────
// Field names verified against dist/genai.d.ts on @google/genai 2.16.0
// (GenerateContentResponseUsageMetadata). Every field on it is optional, and
// the scripted fakes in askAi.test.js carry none of them at all.
test("usageFromResponse reads the SDK's field names and folds thinking into output", () => {
  const usage = usageFromResponse({
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 300,
      thoughtsTokenCount: 50,     // billed at the output rate, so it counts as output
      cachedContentTokenCount: 200,
      totalTokenCount: 1550,
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 1200, outputTokens: 350, cachedTokens: 200, totalTokens: 1550,
  });
});

// toolUsePromptTokenCount is "the number of tokens in the results from tool
// executions, which are provided back to the model as input" and totalTokenCount
// names it as a summand of its own next to prompt/candidates/thoughts — so it is
// billable input that promptTokenCount does NOT already include. Ask AI is the
// tool-use path, so omitting it under-reports the biggest spender in the app.
test("usageFromResponse counts tool-use prompt tokens as input, not as free", () => {
  const usage = usageFromResponse({
    usageMetadata: {
      promptTokenCount: 1000,
      toolUsePromptTokenCount: 400,   // tool results fed back in: billable input
      candidatesTokenCount: 100,
      totalTokenCount: 1500,
    },
  });
  assert.equal(usage.promptTokens, 1400);
  assert.equal(usage.totalTokens, 1500); // as reported by the SDK

  // And it reaches the money: the same call priced with and without the tool
  // results must not cost the same.
  const withTools = estimateCostUsd({ model: "gemini-3.7-flash", ...usage, now: LAST_INTRO_INSTANT });
  const withoutTools = estimateCostUsd({
    model: "gemini-3.7-flash", promptTokens: 1000, outputTokens: 100, now: LAST_INTRO_INSTANT,
  });
  assert.ok(withTools.costUsd > withoutTools.costUsd, "tool-use tokens must be billed, not dropped");

  // A response with no tool use is unchanged by the folding.
  const plain = usageFromResponse({ usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } });
  assert.equal(plain.promptTokens, 1000);

  // Reconstruction covers them too when the SDK omits totalTokenCount.
  const noTotal = usageFromResponse({
    usageMetadata: { promptTokenCount: 1000, toolUsePromptTokenCount: 400, candidatesTokenCount: 100 },
  });
  assert.equal(noTotal.totalTokens, 1500);
});

test("usageFromResponse yields zeros when the response carries no usageMetadata", () => {
  for (const res of [undefined, null, {}, { text: "hi" }, { usageMetadata: {} }]) {
    assert.deepEqual(usageFromResponse(res), emptyUsage());
  }
});

test("usageFromResponse reconstructs a missing totalTokenCount rather than reporting zero", () => {
  const usage = usageFromResponse({
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 },
  });
  assert.equal(usage.totalTokens, 140);
});

// One question can cost up to MAX_ITERATIONS round-trips and they all land on
// the same bill, so the accumulator is what makes the month's total real.
test("addUsage sums the four counts and tolerates missing operands", () => {
  const a = { promptTokens: 100, outputTokens: 10, cachedTokens: 5, totalTokens: 110 };
  const b = { promptTokens: 250, outputTokens: 20, cachedTokens: 0, totalTokens: 270 };
  assert.deepEqual(addUsage(a, b), {
    promptTokens: 350, outputTokens: 30, cachedTokens: 5, totalTokens: 380,
  });
  assert.deepEqual(addUsage(emptyUsage(), a), a);
  assert.deepEqual(addUsage(undefined, undefined), emptyUsage());
  assert.deepEqual(addUsage(a, {}), a);
});

// ── The shared gate (the half that touches the DB) ────────────────────────────
// getBudgetStatus, checkGeminiBudget and recordGeminiCall are the only
// functions here that read or write Postgres, and they take that access
// injected (`getSpend` / `record`, defaulting to the db.js bindings) for the
// same reason `now` is injected above: none of this needs a database to be
// worth testing, and the interesting cases — an unreadable table, a failed
// insert — are precisely the ones a real database won't produce on request.
// Same fake-injection style as test/askAi.test.js's scripted `generate`/`impl`.
//
// Everything below is expressed relative to MONTHLY_BUDGET_USD rather than a
// hard-coded 10, because that constant is read from the environment at import
// time and a machine with GEMINI_MONTHLY_BUDGET_USD set would otherwise fail a
// suite that has nothing to do with its value.

// Stands in for db.js's getGeminiSpendForMonth: records the month key it was
// asked for and answers with a fixed row.
function fakeSpend(row) {
  const fn = async (month) => { fn.months.push(month); return row; };
  fn.months = [];
  return fn;
}
const throwingSpend = (message = "connection terminated unexpectedly") => async () => {
  throw new Error(message);
};
const AUGUST = at("2026-08-16T12:00:00Z");

// A month with no rows at all — the state every fresh deploy is in on the 1st.
// SUM over no rows is NULL, which db.js already COALESCEs to 0; what matters
// here is that a genuinely empty month reads as $0 / 0% / ok rather than as
// anything NaN-shaped, and that it is NOT flagged unknown: zero spend is a fact,
// not an absence of information.
test("getBudgetStatus reports a zero-row month as $0 at 0%, level ok", async () => {
  const getSpend = fakeSpend({ spentUsd: 0, calls: 0, unpricedCalls: 0 });
  const status = await getBudgetStatus(AUGUST, { getSpend });

  assert.deepEqual(status, {
    month: "2026-08",
    spentUsd: 0,
    budgetUsd: MONTHLY_BUDGET_USD,
    pct: 0,
    level: "ok",
    calls: 0,
    unpricedCalls: 0,
    unknown: false,
  });
  // And it asked the database for the UTC month it reported, not some other one.
  assert.deepEqual(getSpend.months, ["2026-08"]);
});

test("getBudgetStatus prices a populated month against the budget", async () => {
  const getSpend = fakeSpend({ spentUsd: MONTHLY_BUDGET_USD * 0.9, calls: 42, unpricedCalls: 3 });
  const status = await getBudgetStatus(AUGUST, { getSpend });

  assert.equal(status.pct, 90);
  assert.equal(status.level, "warn");  // past WARN_PCT, short of the cutoff
  assert.equal(status.calls, 42);
  assert.equal(status.unpricedCalls, 3);
  assert.equal(status.unknown, false);

  // The stored figure is rounded to the estimated_cost_usd column's precision,
  // so the card and the row can't disagree in the seventh decimal.
  const noisy = await getBudgetStatus(AUGUST, {
    getSpend: fakeSpend({ spentUsd: 1.23456789, calls: 1, unpricedCalls: 0 }),
  });
  assert.equal(noisy.spentUsd, 1.234568);
});

// The load-bearing one for the gate. A spend guard exists to stop overspending;
// it must never itself become the reason Ask AI or the nightly scan stops
// working. If the gemini_usage read throws, the caller gets a permissive status
// and a warning line — unprotected but working, which beats protected but
// broken, with the Cloud Billing alert as the remaining backstop.
test("checkGeminiBudget fails OPEN when month-to-date spend can't be read", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});

  const status = await checkGeminiBudget("ask_ai", { now: AUGUST, getSpend: throwingSpend() });

  assert.equal(status.level, "ok");
  assert.equal(status.pct, 0);
  assert.equal(status.month, "2026-08");
  assert.equal(status.budgetUsd, MONTHLY_BUDGET_USD);
  // The flag is the only thing separating this from a quiet month: spend of 0
  // here means "not known", not "nothing spent".
  assert.equal(status.unknown, true);
  // Numbers, not nulls — every consumer interpolates them into a message.
  for (const n of [status.spentUsd, status.calls, status.unpricedCalls]) assert.equal(n, 0);

  // Loud about it, and specific enough to act on.
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /ask_ai/);
  assert.match(warn.mock.calls[0].arguments[0], /connection terminated/);
});

// The two call sites, asserted as the predicates they actually apply: POST
// /api/ask compares pct against ASK_HARD_CEILING_PCT (a 503 otherwise) and
// runReceiptScan checks level === "over" (a thrown Error otherwise). Both must
// come out permissive on an unreadable table, or a broken gemini_usage table
// turns into a 502 on Ask AI and a failed scan — features that worked fine
// before this module existed.
test("both call sites still proceed when the budget read fails", async (t) => {
  t.mock.method(console, "warn", () => {});

  const ask = await checkGeminiBudget("ask_ai", { now: AUGUST, getSpend: throwingSpend() });
  assert.ok(ask.pct < ASK_HARD_CEILING_PCT, "/api/ask would have returned 503");

  const scan = await checkGeminiBudget("receipt_scan", { now: AUGUST, getSpend: throwingSpend() });
  assert.notEqual(scan.level, "over", "runReceiptScan would have thrown");
});

// Failing open is for failures only. A month that really is over budget still
// reports "over", or the guard would have been switched off rather than made
// resilient.
test("checkGeminiBudget still blocks and warns on a genuinely over-budget month", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const getSpend = fakeSpend({ spentUsd: MONTHLY_BUDGET_USD * 1.2, calls: 60, unpricedCalls: 0 });

  const status = await checkGeminiBudget("receipt_scan", { now: AUGUST, getSpend });

  assert.equal(status.level, "over");
  assert.equal(status.pct, 120);
  assert.equal(status.unknown, false);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /receipt_scan/);
});

// The card refreshes on every visit to Settings; the gate runs once per question
// and once per scan. Only the second is allowed to write to the log at all, and
// only when there is something to say.
test("checkGeminiBudget is silent while spend is under the warn threshold", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const getSpend = fakeSpend({ spentUsd: MONTHLY_BUDGET_USD * 0.5, calls: 5, unpricedCalls: 0 });

  const status = await checkGeminiBudget("ask_ai", { now: AUGUST, getSpend });

  assert.equal(status.level, "ok");
  assert.equal(status.pct, 50);
  assert.equal(warn.mock.callCount(), 0);
});

// A usage row is bookkeeping. Losing one costs a slightly low month-to-date
// total; letting its failure propagate would fail the answer the user is
// waiting on, or abort a scan mid-run, over a table nothing else reads.
test("recordGeminiCall swallows an insert failure instead of failing the call", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const record = async () => { throw new Error("relation \"gemini_usage\" does not exist"); };

  await recordGeminiCall({
    feature: "ask_ai",
    model: "gemini-3.7-flash",
    usage: { promptTokens: 1000, outputTokens: 200, cachedTokens: 0, totalTokens: 1200 },
    now: LAST_INTRO_INSTANT,
    record,
  });

  assert.equal(error.mock.callCount(), 1);
  assert.match(error.mock.calls[0].arguments[0], /ask_ai/);
});

// The swallowing handler itself has to survive what it is handed. It logs
// err?.message, and these are the shapes that made the unguarded version throw
// OUT of the catch — which matters more than it sounds: recordGeminiCall is
// awaited inside POST /api/ask's catch BEFORE the error response is sent, so a
// throw here strands the request open until a gateway timeout and the client
// gets an un-parseable 502 instead of JSON. pg rejects with Errors, so this is
// not reachable in production today — but that is pg's discipline, not ours.
test("recordGeminiCall survives a rejection that is not an Error", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const usage = { promptTokens: 1000, outputTokens: 200, cachedTokens: 0, totalTokens: 1200 };

  for (const thrown of [null, undefined, "a bare string", 42]) {
    await recordGeminiCall({
      feature: "ask_ai",
      model: "gemini-3.7-flash",
      usage,
      now: LAST_INTRO_INSTANT,
      record: async () => { throw thrown; },
    });
  }

  assert.equal(error.mock.callCount(), 4);
});

// Same hole, same one-character fix, in the fail-open handler: a non-Error
// rejection must still fail OPEN rather than turning the guard into a throw.
test("checkGeminiBudget fails open even when the read rejects with a non-Error", async (t) => {
  t.mock.method(console, "warn", () => {});

  for (const thrown of [null, undefined, "a bare string", 42]) {
    const status = await checkGeminiBudget("ask_ai", {
      now: AUGUST,
      getSpend: async () => { throw thrown; },
    });

    assert.equal(status.level, "ok");
    assert.equal(status.unknown, true);
  }
});

// The pricing is inside the try for the same reason: an unknown model, junk
// token counts, anything at all in estimateCostUsd must not reach the caller.
test("recordGeminiCall swallows a pricing failure too, whatever it is handed", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const rows = [];
  const record = async (row) => { rows.push(row); };

  await recordGeminiCall({ feature: "ask_ai", model: undefined, usage: undefined, now: LAST_INTRO_INSTANT, record });
  await recordGeminiCall({ feature: "receipt_scan", model: {}, usage: { promptTokens: "lots" }, now: LAST_INTRO_INSTANT, record });

  for (const row of rows) {
    for (const n of [row.promptTokens, row.outputTokens, row.cachedTokens, row.totalTokens, row.estimatedCostUsd]) {
      assert.ok(Number.isFinite(n), `${JSON.stringify(row)} carries a non-numeric count`);
    }
  }
});

// The happy path: what actually lands in the row. `priced` is stored per row so
// a month's total can say how much of itself it knows.
test("recordGeminiCall writes the priced row it estimated", async () => {
  const rows = [];
  const record = async (row) => { rows.push(row); };

  await recordGeminiCall({
    feature: "ask_ai",
    model: "gemini-3.7-flash",
    usage: { promptTokens: MILLION, outputTokens: MILLION, cachedTokens: 0, totalTokens: 2 * MILLION },
    now: LAST_INTRO_INSTANT,
    record,
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    feature: "ask_ai",
    model: "gemini-3.7-flash",
    promptTokens: MILLION,
    outputTokens: MILLION,
    cachedTokens: 0,
    totalTokens: 2 * MILLION,
    estimatedCostUsd: 0.75 + 3.75,   // intro rates, the same figure estimateCostUsd quotes
    priced: "exact",
  });
});
