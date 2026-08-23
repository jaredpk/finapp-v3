import test from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod, recentPeriods, evaluateBenefits, alertTiers, periodMonths } from "../benefits/periods.js";

// The I/O-free half of card-benefit tracking: which window a benefit is in,
// what its usage adds up to, and which nudge is due. No pg, no express, no
// network — the same split limits.js and geminiUsage.js are tested under.
//
// This file is where the bugs in this feature actually live. Two failures are
// worse than a wrong number here:
//
//   - a period boundary off by one day or one year, which reports a spent
//     credit as available (or the reverse) for a whole cardmember year, and
//   - an `available` claimed over a window the transaction history does not
//     cover, which is a confidently wrong alert rather than a missing one.
//
// Both get their own sections below.

const card = (over = {}) => ({
  id: 1,
  nickname: "Amex Platinum",
  issuer: "American Express",
  product: "Platinum",
  account_id: "acct-1",
  anniversary_date: "2019-09-14",
  annual_fee: 895,
  benefits: [],
  ...over,
});

const benefit = (over = {}) => ({
  id: 10,
  name: "Uber Cash",
  amount_limit: 15,
  period_unit: "month",
  period_count: 1,
  period_basis: "calendar",
  carryover: false,
  notes: "",
  verified_on: "2026-08-23",
  rules: [{ id: 1, merchant_regex: "UBER", direction: "charge" }],
  ...over,
});

// What benefits/derive.js hands evaluateBenefits for one benefit's CURRENT
// period. Nothing is read from a usage table any more — see the note at the top
// of derive.js — so these are the numbers, not the rows they came from. The
// derivation itself (pairing, totals, the SQL windows) is tested in
// test/benefitDerive.test.js.
const stat = (over = {}) => ({
  period: resolvePeriod({ unit: "month", count: 1, basis: "calendar" }, "2026-08-23"),
  amountUsed: 0,
  confirmedTotal: 0,
  matchCount: 0,
  matches: [],
  matchesTruncated: false,
  manual: null,
  overflow: null,
  ...over,
});

const match = (over = {}) => ({
  txn_id: "txn-a", date: "2026-08-04", merchant: "UBER *TRIP", amount: 15, ...over,
});

const evalOne = ({ cards, stats = {}, historyByAccount = { "acct-1": "2019-01-01" }, ruleErrors = [] }, today) =>
  evaluateBenefits({ cards, stats, historyByAccount, ruleErrors }, today)[0].benefits[0];

// ── Calendar boundaries ───────────────────────────────────────────────────────

test("calendar month periods start on the 1st and end on the last day, whatever its length", () => {
  assert.deepEqual(resolvePeriod({ unit: "month", basis: "calendar" }, "2026-08-23"), {
    key: "cal:month:1:2026-08", start: "2026-08-01", end: "2026-08-31", daysLeft: 8,
  });
  // February in a leap year and in a common year, from the same code path.
  assert.deepEqual(resolvePeriod({ unit: "month", basis: "calendar" }, "2024-02-10").end, "2024-02-29");
  assert.deepEqual(resolvePeriod({ unit: "month", basis: "calendar" }, "2026-02-10").end, "2026-02-28");
});

test("Dec 31 and Jan 1 land in different periods, at every calendar unit", () => {
  // The year-rollover trap: an off-by-one here means a December credit stays
  // "open" into January, or a January one opens a day early.
  const dec31 = "2026-12-31";
  const jan1 = "2027-01-01";

  const decMonth = resolvePeriod({ unit: "month", basis: "calendar" }, dec31);
  const janMonth = resolvePeriod({ unit: "month", basis: "calendar" }, jan1);
  assert.deepEqual(decMonth, { key: "cal:month:1:2026-12", start: "2026-12-01", end: "2026-12-31", daysLeft: 0 });
  assert.deepEqual(janMonth, { key: "cal:month:1:2027-01", start: "2027-01-01", end: "2027-01-31", daysLeft: 30 });

  assert.equal(resolvePeriod({ unit: "quarter", basis: "calendar" }, dec31).key, "cal:quarter:1:2026-Q4");
  assert.equal(resolvePeriod({ unit: "quarter", basis: "calendar" }, jan1).key, "cal:quarter:1:2027-Q1");
  assert.equal(resolvePeriod({ unit: "half", basis: "calendar" }, dec31).key, "cal:half:1:2026-H2");
  assert.equal(resolvePeriod({ unit: "half", basis: "calendar" }, jan1).key, "cal:half:1:2027-H1");
  assert.equal(resolvePeriod({ unit: "year", basis: "calendar" }, dec31).key, "cal:year:1:2026");
  assert.equal(resolvePeriod({ unit: "year", basis: "calendar" }, jan1).key, "cal:year:1:2027");
});

test("calendar quarters are the calendar's quarters, and halves are Jan-Jun / Jul-Dec", () => {
  assert.deepEqual(resolvePeriod({ unit: "quarter", basis: "calendar" }, "2026-08-23"), {
    key: "cal:quarter:1:2026-Q3", start: "2026-07-01", end: "2026-09-30", daysLeft: 38,
  });
  assert.equal(resolvePeriod({ unit: "quarter", basis: "calendar" }, "2026-03-31").end, "2026-03-31");
  assert.equal(resolvePeriod({ unit: "quarter", basis: "calendar" }, "2026-04-01").start, "2026-04-01");

  assert.deepEqual(resolvePeriod({ unit: "half", basis: "calendar" }, "2026-06-30"), {
    key: "cal:half:1:2026-H1", start: "2026-01-01", end: "2026-06-30", daysLeft: 0,
  });
  assert.deepEqual(resolvePeriod({ unit: "half", basis: "calendar" }, "2026-07-01"), {
    key: "cal:half:1:2026-H2", start: "2026-07-01", end: "2026-12-31", daysLeft: 183,
  });
});

test("a calendar year runs Jan 1 to Dec 31", () => {
  assert.deepEqual(resolvePeriod({ unit: "year", basis: "calendar" }, "2026-08-23"), {
    key: "cal:year:1:2026", start: "2026-01-01", end: "2026-12-31", daysLeft: 130,
  });
});

// ── Anniversary boundaries ────────────────────────────────────────────────────

test("an anniversary-basis year resets on the account anniversary, not on Jan 1", () => {
  // The single worst bug this feature can have: a Venture X travel credit is a
  // cardmember year, and treating it as a calendar year mis-states it for
  // months at a time.
  const period = resolvePeriod(
    { unit: "year", basis: "anniversary", anniversaryDate: "2019-09-14" },
    "2026-08-23"
  );
  assert.deepEqual(period, {
    key: "anniv:year:1:2025-09-14", start: "2025-09-14", end: "2026-09-13", daysLeft: 21,
  });
  // The same date on a calendar basis is a completely different window — which
  // is exactly why the basis has to be stored per benefit.
  assert.equal(resolvePeriod({ unit: "year", basis: "calendar" }, "2026-08-23").start, "2026-01-01");
});

test("the anniversary period flips on the anniversary date itself, not the day after", () => {
  const args = { unit: "year", basis: "anniversary", anniversaryDate: "2019-09-14" };
  assert.equal(resolvePeriod(args, "2026-09-13").key, "anniv:year:1:2025-09-14");
  assert.equal(resolvePeriod(args, "2026-09-13").daysLeft, 0);
  assert.equal(resolvePeriod(args, "2026-09-14").key, "anniv:year:1:2026-09-14");
  assert.equal(resolvePeriod(args, "2026-09-14").end, "2027-09-13");
});

test("a Feb 29 anniversary clamps to Feb 28 in a common year without drifting", () => {
  const args = { unit: "year", basis: "anniversary", anniversaryDate: "2020-02-29" };
  // 2027 is not a leap year: the boundary clamps back one day.
  assert.deepEqual(resolvePeriod(args, "2027-03-01"), {
    key: "anniv:year:1:2027-02-28", start: "2027-02-28", end: "2028-02-28", daysLeft: 364,
  });
  // ...and the day before that boundary is still the previous cardmember year.
  assert.equal(resolvePeriod(args, "2027-02-27").key, "anniv:year:1:2026-02-28");
  // The clamp must not accumulate: 2028 IS a leap year, and because every
  // boundary is computed from the original Feb 29 base the anniversary comes
  // back to the 29th instead of staying stuck on the 28th forever.
  assert.equal(resolvePeriod(args, "2028-06-01").start, "2028-02-29");
});

test("a Jan 31 anniversary + 1 month is the end of February, never March 3rd", () => {
  // JavaScript's Date.setMonth() overflows here; the period math clamps.
  const args = { unit: "month", basis: "anniversary", anniversaryDate: "2025-01-31" };
  assert.deepEqual(resolvePeriod(args, "2025-02-15"), {
    key: "anniv:month:1:2025-01-31", start: "2025-01-31", end: "2025-02-27", daysLeft: 12,
  });
  assert.equal(resolvePeriod(args, "2025-03-01").start, "2025-02-28");
  // March has a 31st, so the anniversary day returns — no permanent drift.
  assert.equal(resolvePeriod(args, "2025-04-02").start, "2025-03-31");
});

test("an anniversary basis with no anniversary on file falls back to the calendar", () => {
  const period = resolvePeriod({ unit: "year", basis: "anniversary", anniversaryDate: null }, "2026-08-23");
  assert.equal(period.key, "cal:year:1:2026");
  assert.equal(period.start, "2026-01-01");
});

// ── Anchored multi-year cycles ────────────────────────────────────────────────

test("months_n runs from the last use, not from a calendar boundary", () => {
  const period = resolvePeriod(
    { unit: "months_n", count: 48, anchorDate: "2024-03-15" },
    "2026-08-23"
  );
  assert.deepEqual(period, {
    key: "anchor:months_n:48:2024-03-15", start: "2024-03-15", end: "2028-03-14", daysLeft: 569,
  });
});

test("with no anchor a months_n benefit is available and has nothing to expire", () => {
  const period = resolvePeriod({ unit: "months_n", count: 48 }, "2026-08-23");
  assert.equal(period.key, "anchor:months_n:48:none");
  assert.equal(period.end, null);
  assert.equal(period.daysLeft, null);
  // `start` is the trailing 48 months we would have had to see to say "not used
  // since" honestly — it is what the history check below is measured against.
  assert.equal(period.start, "2022-08-24");
});

test("a lapsed anchor reads as available again, not as an expired period", () => {
  const period = resolvePeriod(
    { unit: "months_n", count: 48, anchorDate: "2020-01-01" },
    "2026-08-23"
  );
  assert.equal(period.key, "anchor:months_n:48:none");
  assert.equal(period.daysLeft, null);
});

// ── Period keys ───────────────────────────────────────────────────────────────

test("period keys are stable across calls and distinct between adjacent periods", () => {
  const cases = [
    [{ unit: "month", basis: "calendar" }, "2026-08-23", "2026-09-23"],
    [{ unit: "quarter", basis: "calendar" }, "2026-08-23", "2026-11-23"],
    [{ unit: "half", basis: "calendar" }, "2026-03-01", "2026-09-01"],
    [{ unit: "year", basis: "calendar" }, "2026-08-23", "2027-08-23"],
    [{ unit: "year", basis: "anniversary", anniversaryDate: "2019-09-14" }, "2026-08-23", "2026-10-23"],
    [{ unit: "months_n", count: 48, anchorDate: "2024-03-15" }, "2026-08-23", "2026-09-23"],
  ];
  for (const [args, first, second] of cases) {
    // Stable: same inputs, same key, every time. This is the idempotency key
    // for both cb_manual_marks and cb_alerts, so a key that moved would lose a
    // mark and re-fire alerts.
    assert.equal(resolvePeriod(args, first).key, resolvePeriod(args, first).key);
  }
  for (const [args, first, second] of cases.slice(0, 5)) {
    assert.notEqual(resolvePeriod(args, first).key, resolvePeriod(args, second).key, JSON.stringify(args));
  }
  // ...and an anchored cycle deliberately keeps its key while the anchor stands.
  const anchored = { unit: "months_n", count: 48, anchorDate: "2024-03-15" };
  assert.equal(resolvePeriod(anchored, "2026-08-23").key, resolvePeriod(anchored, "2027-08-23").key);
});

test("two period shapes that resolve to the same window still get different keys", () => {
  // year x1, half x2, quarter x4 and month x12 are all Jan 1 - Dec 31. The key
  // is the idempotency key for cb_manual_marks, and PATCH can change a benefit's
  // shape, so a key that did not encode the shape would let the old marks be
  // silently adopted by the new window — a credit reported spent that never was.
  const day = "2026-08-23";
  const calendar = [
    { unit: "year", count: 1, basis: "calendar" },
    { unit: "half", count: 2, basis: "calendar" },
    { unit: "quarter", count: 4, basis: "calendar" },
    { unit: "month", count: 12, basis: "calendar" },
  ].map((shape) => resolvePeriod(shape, day));
  for (const period of calendar) {
    assert.equal(period.start, "2026-01-01");
    assert.equal(period.end, "2026-12-31");
  }
  assert.equal(new Set(calendar.map((p) => p.key)).size, calendar.length);

  // Same trap on the anniversary basis, where every shape below is one
  // cardmember year starting 2025-09-14.
  const anniversary = [
    { unit: "year", count: 1 },
    { unit: "half", count: 2 },
    { unit: "month", count: 12 },
  ].map((shape) => resolvePeriod({ ...shape, basis: "anniversary", anniversaryDate: "2019-09-14" }, day));
  for (const period of anniversary) {
    assert.equal(period.start, "2025-09-14");
    assert.equal(period.end, "2026-09-13");
  }
  assert.equal(new Set(anniversary.map((p) => p.key)).size, anniversary.length);
});

test("recentPeriods returns the current period plus everything inside the lookback", () => {
  // The window a lagging statement credit is hunted over: without the preceding
  // periods a read can only ever see the current one, and the charge a credit
  // confirms is by definition in an earlier one.
  assert.deepEqual(
    recentPeriods({ unit: "month", basis: "calendar" }, "2026-09-05", 120).map((p) => p.key),
    [
      "cal:month:1:2026-09", "cal:month:1:2026-08", "cal:month:1:2026-07",
      "cal:month:1:2026-06", "cal:month:1:2026-05",
    ]
  );
  // An anchored cycle has exactly one window at a time — "the period before it"
  // is not something an anchor can express.
  assert.equal(
    recentPeriods({ unit: "months_n", count: 48, anchorDate: "2024-03-15" }, "2026-09-05", 120).length,
    1
  );
});

test("one preceding period is always in scope, however long the period is", () => {
  // The annual bug, at its source. 120 days does not reach out of a calendar
  // year, so a days-only rule returned 2026 alone: the December 2025 charge was
  // invisible when its January 2026 credit was attributed, and the credit became
  // standalone usage of a year nobody had spent. The floor puts the previous
  // period in scope regardless of length.
  assert.deepEqual(
    recentPeriods({ unit: "year", basis: "calendar" }, "2026-09-05", 120).map((p) => p.key),
    ["cal:year:1:2026", "cal:year:1:2025"]
  );
  // And it does not depend on WHEN in the period the read happens — month 1 and
  // month 8 produce the same scope, which is what makes a first read and a read
  // after a long gap agree.
  assert.deepEqual(
    recentPeriods({ unit: "year", basis: "calendar" }, "2026-02-14", 120).map((p) => p.key),
    ["cal:year:1:2026", "cal:year:1:2025"]
  );
  // Even with no lookback at all.
  assert.deepEqual(
    recentPeriods({ unit: "month", basis: "calendar" }, "2026-09-05").map((p) => p.key),
    ["cal:month:1:2026-09", "cal:month:1:2026-08"]
  );
  // ...and an explicit floor of 0 turns it off again.
  assert.deepEqual(
    recentPeriods({ unit: "month", basis: "calendar" }, "2026-09-05", 0, { minPrevious: 0 }).map((p) => p.key),
    ["cal:month:1:2026-09"]
  );
  // A 4-yearly anchored cycle still gets exactly one window; the floor does not
  // apply to it.
  assert.equal(
    recentPeriods({ unit: "months_n", count: 48 }, "2026-09-05", 120, { minPrevious: 3 }).length,
    1
  );
});

test("period length in months covers every unit, and junk counts fall back to 1", () => {
  assert.equal(periodMonths({ unit: "month" }), 1);
  assert.equal(periodMonths({ unit: "quarter" }), 3);
  assert.equal(periodMonths({ unit: "half" }), 6);
  assert.equal(periodMonths({ unit: "year" }), 12);
  assert.equal(periodMonths({ unit: "months_n", count: 48 }), 48);
  assert.equal(periodMonths({ unit: "month", count: "not a number" }), 1);
});

// ── History coverage ──────────────────────────────────────────────────────────

test("a period that opens before the card's history reports insufficient-history, never available", () => {
  const cards = [card({ benefits: [benefit({ name: "Airline fee credit", period_unit: "year", amount_limit: 200 })] })];
  const result = evalOne({ cards, historyByAccount: { "acct-1": "2026-05-01" } }, "2026-08-23");
  assert.equal(result.period_start, "2026-01-01");
  assert.equal(result.status, "insufficient-history");
  assert.equal(result.confidence, "none");
});

test("history that covers the whole period allows available", () => {
  const cards = [card({ benefits: [benefit({ period_unit: "year", amount_limit: 200 })] })];
  const result = evalOne({ cards, historyByAccount: { "acct-1": "2025-12-01" } }, "2026-08-23");
  assert.equal(result.status, "available");
});

test("a card with no history at all cannot claim available", () => {
  const cards = [card({ benefits: [benefit()] })];
  assert.equal(evalOne({ cards, historyByAccount: {} }, "2026-08-23").status, "insufficient-history");
  // Same for a card that isn't linked to a Plaid account yet.
  const unlinked = [card({ account_id: null, benefits: [benefit()] })];
  assert.equal(evalOne({ cards: unlinked, historyByAccount: { "acct-1": "2019-01-01" } }, "2026-08-23").status, "insufficient-history");
});

test("a 48-month cycle whose trailing window predates the history is insufficient-history", () => {
  const cards = [card({ benefits: [benefit({ period_unit: "months_n", period_count: 48, amount_limit: 120 })] })];
  assert.equal(evalOne({ cards, historyByAccount: { "acct-1": "2025-01-01" } }, "2026-08-23").status, "insufficient-history");
  assert.equal(evalOne({ cards, historyByAccount: { "acct-1": "2020-01-01" } }, "2026-08-23").status, "available");
});

test("derived usage outranks a short history — we can see what we matched", () => {
  const cards = [card({ benefits: [benefit()] })];
  const stats = { 10: stat({ amountUsed: 15, matchCount: 1, matches: [match()] }) };
  const result = evalOne({ cards, stats, historyByAccount: { "acct-1": "2026-08-20" } }, "2026-08-23");
  assert.equal(result.status, "used-unconfirmed");
});

// ── Status derivation ─────────────────────────────────────────────────────────

test("a benefit with no match rules is manual-only", () => {
  const cards = [card({ benefits: [benefit({ name: "Centurion Lounge access", amount_limit: null, rules: [] })] })];
  const result = evalOne({ cards, historyByAccount: {} }, "2026-08-23");
  // manual-only takes precedence over the history check: a benefit with no
  // transaction footprint is not made more or less knowable by how far back the
  // card's transactions go.
  assert.equal(result.status, "manual-only");
  assert.equal(result.confidence, "none");
});

test("a manual mark on an untracked benefit reads as used, with manual confidence", () => {
  const cards = [card({ benefits: [benefit({ amount_limit: null, rules: [] })] })];
  const stats = { 10: stat({ manual: { amount: 0, note: null, date: "2026-08-10" } }) };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.status, "used");
  assert.equal(result.confidence, "manual");
  assert.deepEqual(result.matches, [
    { txn_id: null, date: "2026-08-10", merchant: null, amount: 0, source: "manual" },
  ]);
});

test("a matching charge alone is used-unconfirmed; a posted credit promotes it to used", () => {
  const cards = [card({ benefits: [benefit()] })];
  const chargeOnly = { 10: stat({ amountUsed: 15, confirmedTotal: 0, matchCount: 1, matches: [match({ txn_id: "txn-charge" })] }) };
  const chargeResult = evalOne({ cards, stats: chargeOnly }, "2026-08-23");
  assert.equal(chargeResult.status, "used-unconfirmed");
  assert.equal(chargeResult.confidence, "unconfirmed");
  assert.equal(chargeResult.amount_used, 15);

  // The posted credit arrives a cycle later, as its own transaction. Its amount
  // is never added to the charge's — it IS the charge — so it moves
  // confirmedTotal and nothing else, and both transactions are still listed.
  const withCredit = {
    10: stat({
      amountUsed: 15, confirmedTotal: 15, matchCount: 2,
      matches: [match({ txn_id: "txn-charge" }), match({ txn_id: "txn-credit", date: "2026-08-20", merchant: "AMEX CREDIT" })],
    }),
  };
  const confirmed = evalOne({ cards, stats: withCredit }, "2026-08-23");
  assert.equal(confirmed.status, "used");
  assert.equal(confirmed.confidence, "confirmed");
  assert.equal(confirmed.amount_used, 15);
  assert.equal(confirmed.matches.length, 2);
});

test("confirmed means every counted dollar is confirmed, not that some credit exists", () => {
  // The semantic change 05-api-contract.md records. Three $100 charges settled
  // by one $100 credit are $300 used with $100 confirmed; calling that
  // `confirmed` would claim a statement said something it did not.
  const cards = [card({ benefits: [benefit({ amount_limit: 300 })] })];
  const partly = { 10: stat({ amountUsed: 300, confirmedTotal: 100, matchCount: 4 }) };
  const result = evalOne({ cards, stats: partly }, "2026-08-23");
  assert.equal(result.amount_used, 300);
  assert.equal(result.confidence, "unconfirmed");
  assert.equal(result.status, "used-unconfirmed");
  // Half a cent of float slack, not exact equality: NUMERIC(12,2) round-tripped
  // through a float must not read as "not quite confirmed".
  const whole = { 10: stat({ amountUsed: 300, confirmedTotal: 299.999, matchCount: 4 }) };
  assert.equal(evalOne({ cards, stats: whole }, "2026-08-23").confidence, "confirmed");
});

test("a benefit matched only on its posted credit still reports the amount", () => {
  // A credit with no charge to confirm is standalone usage of its own period,
  // and confirmed by nature: the statement credit IS the evidence.
  const cards = [card({ benefits: [benefit()] })];
  const stats = { 10: stat({ amountUsed: 15, confirmedTotal: 15, matchCount: 1, matches: [match({ txn_id: "txn-credit" })] }) };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.amount_used, 15);
  assert.equal(result.status, "used");
  assert.equal(result.confidence, "confirmed");
});

test("a matched transaction whose money belongs to an earlier period leaves this one available", () => {
  // The January credit for a December charge. It is evidence in January and
  // usage of nothing: counting ROWS rather than dollars is what made it spend
  // the new year's allowance.
  const cards = [card({ benefits: [benefit({ period_unit: "year", amount_limit: 300 })] })];
  const stats = {
    10: stat({
      period: resolvePeriod({ unit: "year", count: 1, basis: "calendar" }, "2026-08-23"),
      amountUsed: 0, confirmedTotal: 0, matchCount: 1,
      matches: [match({ txn_id: "txn-credit", date: "2026-01-08", amount: 300 })],
    }),
  };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.status, "available");
  assert.equal(result.amount_used, 0);
  assert.equal(result.amount_remaining, 300);
  assert.equal(result.matches.length, 1);
});

test("usage accumulates within the period and reports partially-used in between", () => {
  const cards = [card({ benefits: [benefit()] })];
  const partial = evalOne({ cards, stats: { 10: stat({ amountUsed: 4.12, matchCount: 1 }) } }, "2026-08-23");
  assert.equal(partial.status, "partially-used");
  assert.equal(partial.amount_used, 4.12);
  assert.equal(partial.amount_remaining, 10.88);

  const both = evalOne({ cards, stats: { 10: stat({ amountUsed: 15, matchCount: 2 }) } }, "2026-08-23");
  assert.equal(both.status, "used-unconfirmed");
  assert.equal(both.amount_used, 15);
  assert.equal(both.amount_remaining, 0);
});

test("a manual mark outranks an automatic match instead of stacking on top of it", () => {
  // The owner marking the credit used and the matcher finding the charge are two
  // views of ONE $100 use. Summing them reported $200 against a $100 limit and
  // dragged confidence from `manual` down to `unconfirmed`. The two now live in
  // different tables entirely, so this is a branch rather than a race.
  const cards = [card({ benefits: [benefit({ amount_limit: 100 })] })];
  const stats = {
    10: stat({
      amountUsed: 100, confirmedTotal: 0, matchCount: 1,
      matches: [match({ txn_id: "txn-charge", amount: 100 })],
      manual: { amount: 100, note: null, date: "2026-08-05" },
    }),
  };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.amount_used, 100);
  assert.equal(result.amount_remaining, 0);
  assert.equal(result.confidence, "manual");
  assert.equal(result.status, "used");
  // The automatic match is still shown — it is the evidence the mark is checked
  // against — it just does not add to the amount.
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.map((m) => m.source), ["auto", "manual"]);
});

test("the amount is the SQL total, not the sum of the listed sample, and says when it is a sample", () => {
  // A rule matching more transactions than `matches` lists must not report a
  // fully-used credit as partially-used just because the display cap was hit.
  // amount_used comes from the aggregate; the list says it is a sample.
  const cards = [card({ benefits: [benefit({ amount_limit: 500 })] })];
  const stats = {
    10: stat({
      amountUsed: 500, matchCount: 400, matchesTruncated: true,
      matches: [match({ txn_id: "txn-a", amount: 120 })],
    }),
  };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.amount_used, 500);
  assert.equal(result.amount_remaining, 0);
  assert.equal(result.status, "used-unconfirmed");
  assert.deepEqual(result.matches.map((m) => m.txn_id), ["txn-a"]);
  assert.equal(result.matches_truncated, true);
  // ...and an ordinary period does not claim to be a sample.
  const whole = { 10: stat({ amountUsed: 120, matchCount: 1, matches: [match({ txn_id: "txn-a", amount: 120 })] }) };
  assert.equal(evalOne({ cards, stats: whole }, "2026-08-23").matches_truncated, false);
});

test("a benefit whose rules match more transactions than pairing can hold is rule-error", () => {
  // The row cap announces itself instead of degrading. Pairing over a subset of
  // the candidates misclassifies standalone-vs-paired credits, which inflates
  // amount_used and suppresses the expiry nudge — so it is reported, not
  // guessed at (limits.js doctrine).
  const cards = [card({ benefits: [benefit({ amount_limit: 500 })] })];
  const stats = { 10: stat({ amountUsed: 2001, matchCount: 2001, overflow: "too many rows; narrow the rule" }) };
  const result = evalOne({ cards, stats }, "2026-08-23");
  assert.equal(result.status, "rule-error");
  assert.equal(result.rule_error, "too many rows; narrow the rule");
  assert.deepEqual(alertTiers({ benefit: result, daysLeft: result.days_left, status: result.status }), ["rule-error"]);
});

test("a match rule that failed to run reports rule-error, never available", () => {
  // A stored regex that stops parsing leaves the benefit with rules and no
  // usage, which fell through to `available` — a credit reported unused forever
  // because of one unbalanced bracket.
  const cards = [card({ benefits: [benefit()] })];
  const ruleErrors = [{ benefit_id: 10, rule_id: 1, message: "invalid regular expression: brackets [] not balanced" }];
  const evaluate = (stats) => evalOne({ cards, stats, ruleErrors }, "2026-08-23");

  const empty = evaluate({});
  assert.equal(empty.status, "rule-error");
  assert.equal(empty.rule_error, "rule 1: invalid regular expression: brackets [] not balanced");

  // Even with something derived, the figure is a floor and not a total: the
  // rule that did not run might have found more.
  assert.equal(evaluate({ 10: stat({ amountUsed: 4.12, matchCount: 1 }) }).status, "rule-error");
  // A benefit with no failing rule is unaffected.
  assert.equal(evalOne({ cards }, "2026-08-23").rule_error, null);
});

test("a benefit derive found nothing for is available, not partially used", () => {
  const cards = [card({ benefits: [benefit()] })];
  const result = evalOne({ cards, stats: { 10: stat() } }, "2026-08-23");
  assert.equal(result.status, "available");
  assert.equal(result.amount_used, 0);
  assert.deepEqual(result.matches, []);
});

test("the evaluated card carries the contract's fields", () => {
  const cards = [card({ benefits: [benefit()] })];
  const [evaluated] = evaluateBenefits(
    {
      cards,
      stats: { 10: stat({ amountUsed: 4.12, matchCount: 1, matches: [match({ amount: 4.12 })] }) },
      historyByAccount: { "acct-1": "2024-01-03" },
    },
    "2026-08-23"
  );
  assert.equal(evaluated.history_start, "2024-01-03");
  assert.equal(evaluated.annual_fee, 895);
  assert.deepEqual(evaluated.benefits[0].period, { unit: "month", count: 1, basis: "calendar" });
  assert.equal(evaluated.benefits[0].period_key, "cal:month:1:2026-08");
  assert.equal(evaluated.benefits[0].days_left, 8);
  assert.deepEqual(evaluated.benefits[0].matches, [
    { txn_id: "txn-a", date: "2026-08-04", merchant: "UBER *TRIP", amount: 4.12, source: "auto" },
  ]);
});

// ── Alert tiers ───────────────────────────────────────────────────────────────

const tierArgs = (over = {}) => ({
  benefit: { period: { unit: "month", count: 1 }, period_start: "2026-08-01", period_end: "2026-08-31", ...over.benefit },
  daysLeft: over.daysLeft,
  status: over.status ?? "available",
});

test("a monthly credit nudges at 7 days out and not before", () => {
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 8 })), []);
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 7 })), ["expiring-7d"]);
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 0 })), ["expiring-7d"]);
});

test("quarterly and semiannual credits nudge at 21 days", () => {
  const quarterly = { period: { unit: "quarter", count: 1 }, period_start: "2026-07-01", period_end: "2026-09-30" };
  assert.deepEqual(alertTiers(tierArgs({ benefit: quarterly, daysLeft: 22 })), []);
  assert.deepEqual(alertTiers(tierArgs({ benefit: quarterly, daysLeft: 21 })), ["expiring-21d"]);
  const half = { period: { unit: "half", count: 1 }, period_start: "2026-07-01", period_end: "2026-12-31" };
  assert.deepEqual(alertTiers(tierArgs({ benefit: half, daysLeft: 21 })), ["expiring-21d"]);
});

test("an annual credit nudges at 45 days and again at 14, most urgent first", () => {
  const annual = { period: { unit: "year", count: 1 }, period_start: "2026-01-01", period_end: "2026-12-31" };
  assert.deepEqual(alertTiers(tierArgs({ benefit: annual, daysLeft: 46 })), []);
  assert.deepEqual(alertTiers(tierArgs({ benefit: annual, daysLeft: 45 })), ["expiring-45d"]);
  // Both are due at once for a benefit that was never nudged at 45; the caller
  // labels the item with the first (most urgent) and records the rest as
  // superseded, so neither fires twice.
  assert.deepEqual(alertTiers(tierArgs({ benefit: annual, daysLeft: 14 })), ["expiring-14d", "expiring-45d"]);
});

test("a period that opened today announces itself", () => {
  // Derived without a clock: on day one, the days remaining equal the whole
  // span from period_start to period_end.
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 30 })), ["period-opened"]);
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 29 })), []);
});

test("nothing is ever alerted on used, used-unconfirmed or insufficient-history", () => {
  for (const status of ["used", "used-unconfirmed", "insufficient-history"]) {
    assert.deepEqual(alertTiers(tierArgs({ daysLeft: 1, status })), [], status);
    // Not even the positive "your period reset" note.
    assert.deepEqual(alertTiers(tierArgs({ daysLeft: 30, status })), [], status);
  }
  // The states that DO get chased.
  for (const status of ["available", "partially-used", "manual-only"]) {
    assert.deepEqual(alertTiers(tierArgs({ daysLeft: 3, status })), ["expiring-7d"], status);
  }
});

test("a broken match rule gets one tier of its own, and no expiry nudges", () => {
  // The only status in the never-alert set that still says something: a benefit
  // nobody can evaluate is worth exactly one message per period (cb_alerts keys
  // on benefit + period + tier), and no "expiring" nudge, because the figure it
  // would quote was never computed.
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 30, status: "rule-error" })), ["rule-error"]);
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 3, status: "rule-error" })), ["rule-error"]);
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: null, status: "rule-error" })), ["rule-error"]);
});

test("only a finite number of days left can fire a tier", () => {
  // Number(false), Number([]), Number("") and Number(null) are all 0, and a 0
  // would read as "expires today" and fire every tier the benefit has.
  // days_left is a number or null in the contract, so anything else is junk.
  for (const daysLeft of [null, undefined, "", false, true, [], {}, NaN, "3"]) {
    assert.deepEqual(alertTiers(tierArgs({ daysLeft })), [], JSON.stringify(daysLeft) ?? String(daysLeft));
  }
  assert.deepEqual(alertTiers(tierArgs({ daysLeft: 3 })), ["expiring-7d"]);
});

test("a benefit with no expiry is never nagged", () => {
  // An anchored cycle that is available again: no end date, nothing to count
  // down to, so there is nothing worth sending.
  const anchored = { period: { unit: "months_n", count: 48 }, period_start: "2022-08-24", period_end: null };
  assert.deepEqual(alertTiers({ benefit: anchored, daysLeft: null, status: "available" }), []);
});
