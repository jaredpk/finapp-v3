import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWindows, deriveBenefitStats, pairCreditsToCharges,
  PAIRING_ROW_LIMIT, MATCHES_DISPLAY_LIMIT, PAIR_DATE_SKEW_DAYS,
} from "../benefits/derive.js";
import { evaluateBenefits, alertTiers, hasCriteria } from "../benefits/periods.js";

// The derive half of card-benefit tracking: which transactions fall in which
// window, which posted credit settles which qualifying charge, and what that
// adds up to. No pg, no express, no network — the same split limits.js and
// periods.js are tested under.
//
// Two defects SHIPPED from the model this replaces, and both have a named
// regression test below:
//
//   - a confirmed charge dropping out of amount_used entirely (three $100
//     charges and one $100 credit reported $200 used against a $300 limit, and
//     fired a false expiry alert for the $100 "left"), and
//   - the annual lookback never reaching the prior period, so a January credit
//     for a December charge became fresh usage of the new year — the exact
//     failure mode this feature exists to prevent, and worse in August than in
//     February because the old model's answer depended on when it ran.
//
// Everything else here guards the invariant that makes both impossible: a
// charge always carries its own amount, a credit paired to a charge carries
// none, and only the residue of an unpairable credit is money of its own.

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

// A transaction as the app stores it: a positive amount is a qualifying charge,
// a negative one a posted statement credit.
const txn = (over = {}) => ({
  benefit_id: 10, txn_id: "txn-a", date: "2026-08-04", merchant: "UBER *TRIP", amount: 15, ...over,
});

// Stands in for the two SQL queries in repository.js: it buckets transactions
// into the windows buildWindows produced, exactly as the CTE's date join does,
// and derives Q-aggregate from the same set the way SUM/COUNT would. Keeping
// the two consistent here is the point — a test that let them disagree could
// not catch the bug where amount_used came from the wrong one.
function scan(cards, txns, today, options = {}) {
  const { windows, plans } = buildWindows(cards, today, options);
  const rows = [];
  for (const t of txns) {
    const window = windows.find(
      (w) => String(w.benefit_id) === String(t.benefit_id)
        && t.date >= w.start_date && t.date <= w.end_date
    );
    if (!window) continue;
    rows.push({
      benefit_id: t.benefit_id,
      period_key: window.period_key,
      txn_id: t.txn_id,
      date: t.date,
      merchant: t.merchant ?? null,
      amount: Math.abs(t.amount),
      is_credit: t.amount < 0,
    });
  }
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.benefit_id}|${r.period_key}|${r.is_credit}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        benefit_id: r.benefit_id, period_key: r.period_key, is_credit: r.is_credit,
        total: 0, count: 0, last_date: null,
      });
    }
    const b = buckets.get(key);
    b.total += r.amount;
    b.count += 1;
    if (!b.last_date || r.date > b.last_date) b.last_date = r.date;
  }
  return { windows, plans, rows, aggregates: [...buckets.values()] };
}

// derive → evaluate, the whole read path minus the SQL.
function status({ cards, txns = [], marks = [], historyByAccount = { "acct-1": "2019-01-01" }, options }, today) {
  const { plans, rows, aggregates } = scan(cards, txns, today, options);
  const stats = deriveBenefitStats({ plans, aggregates, rows, marks }, today);
  return { stats, benefits: evaluateBenefits({ cards, stats, historyByAccount }, today)[0].benefits };
}

const one = (args, today) => status(args, today).benefits[0];

// ── The two shipped defects ───────────────────────────────────────────────────

test("three $100 charges settled by one $100 credit are $300 used, and nothing is due", () => {
  // REGRESSION. The stored model filed the credit by stamping confirmed_at on
  // one charge's usage row, and then counted `charged` rows only — so the
  // stamped charge fell out of the total. $300 of spend reported as $200 used
  // with $100 remaining, and an expiry nudge for money that was already gone.
  //
  // Here a charge always carries its amount and a paired credit carries none,
  // so there is no bucket for the settled charge to fall out of.
  const cards = [card({ benefits: [benefit({ amount_limit: 300, rules: [
    { id: 1, merchant_regex: "GRUBHUB", direction: "charge" },
    { id: 2, merchant_regex: "AMEX CREDIT", direction: "credit" },
  ] })] })];
  const txns = [
    txn({ txn_id: "c1", date: "2026-08-03", merchant: "GRUBHUB", amount: 100 }),
    txn({ txn_id: "c2", date: "2026-08-10", merchant: "GRUBHUB", amount: 100 }),
    txn({ txn_id: "c3", date: "2026-08-17", merchant: "GRUBHUB", amount: 100 }),
    txn({ txn_id: "r1", date: "2026-08-20", merchant: "AMEX CREDIT", amount: -100 }),
  ];
  const result = one({ cards, txns }, "2026-08-23");

  assert.equal(result.amount_used, 300);
  assert.equal(result.amount_remaining, 0);
  assert.equal(result.status, "used-unconfirmed");
  // Only $100 of the $300 has a statement credit behind it, so `confirmed`
  // would be a claim the statement does not support.
  assert.equal(result.confidence, "unconfirmed");
  // And nothing is nudged: chasing $0 of remaining credit is the false alert
  // this regression produced.
  assert.deepEqual(alertTiers({ benefit: result, daysLeft: result.days_left, status: result.status }), []);
  // The credit is still listed as evidence alongside the three charges.
  assert.equal(result.matches.length, 4);
});

test("an annual December charge and its January credit read the same in February and in August", () => {
  // REGRESSION. The lookback was "periods reaching into the last 120 days",
  // which never reaches out of a calendar YEAR — so the December charge was
  // invisible when the January credit was attributed, and the credit was filed
  // as fresh usage of 2026. In February the stale stored row still said
  // otherwise; by August the bug reproduced in full. The answer must not depend
  // on when the read runs.
  const cards = [card({ benefits: [benefit({
    name: "Travel credit", amount_limit: 300, period_unit: "year", period_count: 1,
    rules: [
      { id: 1, merchant_regex: "CAPITAL ONE TRAVEL", direction: "charge" },
      { id: 2, merchant_regex: "TRAVEL CREDIT", direction: "credit" },
    ],
  })] })];
  const txns = [
    txn({ txn_id: "chg", date: "2025-12-10", merchant: "CAPITAL ONE TRAVEL", amount: 300 }),
    txn({ txn_id: "crd", date: "2026-01-08", merchant: "TRAVEL CREDIT", amount: -300 }),
  ];

  for (const asOf of ["2026-02-14", "2026-08-23"]) {
    const { stats, benefits } = status({ cards, txns }, asOf);
    const result = benefits[0];
    assert.equal(result.period_key, "cal:year:1:2026", asOf);
    // 2026's allowance is untouched: the credit belongs to the 2025 charge.
    assert.equal(result.amount_used, 0, asOf);
    assert.equal(result.amount_remaining, 300, asOf);
    assert.equal(result.status, "available", asOf);
    assert.equal(result.confidence, "none", asOf);
    // ...and the credit is still shown, because it IS evidence for this period
    // even though its money is not.
    assert.deepEqual(result.matches.map((m) => m.txn_id), ["crd"], asOf);
    // The 2025 charge it settled was in scope and fully confirmed.
    assert.equal(stats["10"].confirmedTotal, 0, asOf); // current period only
  }

  // The previous period is genuinely in the scan, at both dates.
  for (const asOf of ["2026-02-14", "2026-08-23"]) {
    const { windows } = scan(cards, txns, asOf);
    assert.deepEqual(windows.map((w) => w.period_key), ["cal:year:1:2026", "cal:year:1:2025"], asOf);
  }
});

// ── Pairing ───────────────────────────────────────────────────────────────────

test("one $15 credit settles a $4 and an $11 charge, and is not usage of its own", () => {
  const { charges, credits } = pairCreditsToCharges({
    charges: [
      { txn_id: "a", date: "2026-08-04", amount: 4 },
      { txn_id: "b", date: "2026-08-06", amount: 11 },
    ],
    credits: [{ txn_id: "r", date: "2026-08-25", amount: 15 }],
  });
  assert.deepEqual(charges.map((c) => c.confirmed), [4, 11]);
  assert.equal(credits[0].standalone, 0);

  // ...and end to end: fully used, fully confirmed, no standalone usage.
  const cards = [card({ benefits: [benefit({ rules: [
    { id: 1, merchant_regex: "UBER", direction: "charge" },
    { id: 2, merchant_regex: "UBER CREDIT", direction: "credit" },
  ] })] })];
  const result = one({ cards, txns: [
    txn({ txn_id: "a", date: "2026-08-04", amount: 4 }),
    txn({ txn_id: "b", date: "2026-08-06", amount: 11 }),
    txn({ txn_id: "r", date: "2026-08-25", merchant: "UBER CREDIT", amount: -15 }),
  ] }, "2026-08-23");
  assert.equal(result.amount_used, 15);
  assert.equal(result.status, "used");
  assert.equal(result.confidence, "confirmed");
});

test("a $50 credit against a $100 charge confirms half of it and spends nothing new", () => {
  // The mismatched-amount case. Exact-only pairing filed this credit as
  // standalone usage of the period it LANDED in — the annual bug through the
  // side door — so the partial pass is required, not an optimisation.
  const cards = [card({ benefits: [benefit({ amount_limit: 100, rules: [
    { id: 1, merchant_regex: "SAKS", direction: "charge" },
    { id: 2, merchant_regex: "SAKS CREDIT", direction: "credit" },
  ] })] })];

  // Both halves inside one period: $100 of usage, $50 of it confirmed. The
  // charge keeps its whole amount; the credit adds none of its own.
  const same = status({ cards, txns: [
    txn({ txn_id: "chg", date: "2026-08-04", merchant: "SAKS", amount: 100 }),
    txn({ txn_id: "crd", date: "2026-08-18", merchant: "SAKS CREDIT", amount: -50 }),
  ] }, "2026-08-23");
  assert.equal(same.benefits[0].amount_used, 100);
  assert.equal(same.stats["10"].confirmedTotal, 50);
  assert.equal(same.benefits[0].confidence, "unconfirmed");
  assert.equal(same.benefits[0].status, "used-unconfirmed");

  // A cycle apart: the credit lands in August and leaves August untouched.
  const split = status({ cards, txns: [
    txn({ txn_id: "chg", date: "2026-07-04", merchant: "SAKS", amount: 100 }),
    txn({ txn_id: "crd", date: "2026-08-06", merchant: "SAKS CREDIT", amount: -50 }),
  ] }, "2026-08-23");
  assert.equal(split.benefits[0].period_key, "cal:month:1:2026-08");
  assert.equal(split.benefits[0].amount_used, 0);
  assert.equal(split.benefits[0].amount_remaining, 100);
  assert.equal(split.benefits[0].status, "available");
  // ...because the credit was spent confirming July's charge, not filed as new
  // usage of its own landing period.
  assert.equal(split.stats["10"].confirmedTotal, 0);
  assert.deepEqual(split.benefits[0].matches.map((m) => m.txn_id), ["crd"]);
  const paired = pairCreditsToCharges({
    charges: [{ txn_id: "chg", date: "2026-07-04", amount: 100 }],
    credits: [{ txn_id: "crd", date: "2026-08-06", amount: 50 }],
  });
  assert.equal(paired.charges[0].confirmed, 50);
  assert.equal(paired.credits[0].standalone, 0);
});

test("pairing is deterministic: shuffling the input cannot change the answer", () => {
  // Nothing persisted depends on the pairing, which is only safe because the
  // pairing is a pure function of a total order on (date, txn_id). If row order
  // could change it, a re-read could move money between periods.
  const charges = [
    { txn_id: "c3", date: "2026-08-17", amount: 100 },
    { txn_id: "c1", date: "2026-08-03", amount: 40 },
    { txn_id: "c2", date: "2026-08-10", amount: 60 },
    { txn_id: "c4", date: "2026-08-18", amount: 100 },
  ];
  const credits = [
    { txn_id: "r2", date: "2026-08-26", amount: 100 },
    { txn_id: "r1", date: "2026-08-20", amount: 75 },
  ];
  const fingerprint = (result) => JSON.stringify({
    charges: result.charges.map((c) => [c.txn_id, c.confirmed]),
    credits: result.credits.map((c) => [c.txn_id, c.standalone]),
  });

  const expected = fingerprint(pairCreditsToCharges({ charges, credits }));
  // Every rotation of both inputs, plus both reversed.
  for (let i = 0; i < charges.length; i++) {
    for (let j = 0; j < credits.length; j++) {
      const rotate = (xs, n) => [...xs.slice(n), ...xs.slice(0, n)];
      assert.equal(fingerprint(pairCreditsToCharges({
        charges: rotate(charges, i), credits: rotate(credits, j),
      })), expected, `rotation ${i}/${j}`);
    }
  }
  assert.equal(fingerprint(pairCreditsToCharges({
    charges: [...charges].reverse(), credits: [...credits].reverse(),
  })), expected);
});

test("a credit never settles a charge dated far beyond it", () => {
  const { charges, credits } = pairCreditsToCharges({
    charges: [{ txn_id: "later", date: "2026-08-20", amount: 50 }],
    credits: [{ txn_id: "earlier", date: "2026-08-01", amount: 50 }],
  });
  assert.equal(charges[0].confirmed, 0);
  // With nothing to settle, the credit is standalone usage of its own period —
  // the only path by which a credit counts as money.
  assert.equal(credits[0].standalone, 50);
});

test("a credit dated one day BEFORE its charge still settles it", () => {
  // REGRESSION. Pairing used to require charge.date <= credit.date exactly, so
  // a credit that posted a day ahead of its charge could never pair: the charge
  // counted in full AND the credit fell through to residue as standalone usage
  // of the same period. $100 of spend refunded by $100 reported as $200 used.
  //
  // The two dates come from different clocks (statement date vs post date), so
  // a one-day inversion is an artefact, not a second use.
  const cards = [card({ benefits: [benefit({
    amount_limit: 100,
    rules: [
      { id: 1, merchant_regex: "SAKS", direction: "charge" },
      { id: 2, merchant_regex: "SAKS", direction: "credit" },
    ],
  })] })];
  const txns = [
    txn({ txn_id: "credit-1", date: "2026-08-01", merchant: "SAKS CREDIT", amount: -100 }),
    txn({ txn_id: "charge-1", date: "2026-08-02", merchant: "SAKS FIFTH AVE", amount: 100 }),
  ];
  const result = one({ cards, txns }, "2026-08-23");
  assert.equal(result.amount_used, 100);
  assert.equal(result.amount_remaining, 0);
  assert.equal(result.confidence, "confirmed");
  assert.equal(result.status, "used");
});

test("the skew window is a few days wide and stops dead at its edge", () => {
  // A reach FORWARD in time has to stay short: a credit that could reach far
  // enough forward would confirm a genuinely later, unrelated charge.
  const pair = (chargeDate) => pairCreditsToCharges({
    charges: [{ txn_id: "a", date: chargeDate, amount: 50 }],
    credits: [{ txn_id: "r", date: "2026-08-01", amount: 50 }],
  });

  assert.equal(PAIR_DATE_SKEW_DAYS, 5);
  // Just inside: the last day the credit can reach.
  const inside = pair("2026-08-06");
  assert.equal(inside.charges[0].confirmed, 50);
  assert.equal(inside.credits[0].standalone, 0);
  // Just outside: no pairing at all, and the credit is standalone usage again.
  const outside = pair("2026-08-07");
  assert.equal(outside.charges[0].confirmed, 0);
  assert.equal(outside.credits[0].standalone, 50);
});

test("pairing stays deterministic when charges and credits are date-inverted", () => {
  // The skew window widens which charges a credit MAY settle; it must not make
  // the choice depend on the order the rows arrived in. Same total order on
  // (date, txn_id), same answer.
  const charges = [
    { txn_id: "c2", date: "2026-08-04", amount: 40 },
    { txn_id: "c1", date: "2026-08-03", amount: 40 },
    { txn_id: "c3", date: "2026-08-05", amount: 25 },
  ];
  const credits = [
    { txn_id: "r2", date: "2026-08-02", amount: 40 },
    { txn_id: "r1", date: "2026-08-01", amount: 40 },
  ];
  const byId = (a, b) => String(a.txn_id).localeCompare(String(b.txn_id));
  const fingerprint = (result) => JSON.stringify({
    charges: [...result.charges].sort(byId).map((c) => [c.txn_id, c.confirmed]),
    credits: [...result.credits].sort(byId).map((c) => [c.txn_id, c.standalone]),
  });

  const expected = fingerprint(pairCreditsToCharges({ charges, credits }));
  // Both charges are settled — neither credit is money of its own — and the
  // $25 charge outside either credit's reach is untouched.
  assert.equal(expected, JSON.stringify({
    charges: [["c1", 40], ["c2", 40], ["c3", 0]],
    credits: [["r1", 0], ["r2", 0]],
  }));
  for (let i = 0; i < charges.length; i++) {
    for (let j = 0; j < credits.length; j++) {
      const rotate = (xs, n) => [...xs.slice(n), ...xs.slice(0, n)];
      assert.equal(fingerprint(pairCreditsToCharges({
        charges: rotate(charges, i), credits: rotate(credits, j),
      })), expected, `rotation ${i}/${j}`);
    }
  }
  assert.equal(fingerprint(pairCreditsToCharges({
    charges: [...charges].reverse(), credits: [...credits].reverse(),
  })), expected);
});

test("the exact pass runs before the partial pass, so an exact match is not eaten piecemeal", () => {
  const { charges, credits } = pairCreditsToCharges({
    charges: [
      { txn_id: "a", date: "2026-08-01", amount: 15 },
      { txn_id: "b", date: "2026-08-02", amount: 4 },
      { txn_id: "c", date: "2026-08-03", amount: 11 },
    ],
    credits: [{ txn_id: "r", date: "2026-08-10", amount: 15 }],
  });
  // The $15 charge, not the $11 + $4 that sit nearer the credit.
  assert.deepEqual(charges.map((c) => [c.txn_id, c.confirmed]), [["a", 15], ["b", 0], ["c", 0]]);
  assert.equal(credits[0].standalone, 0);
});

test("a credit larger than everything it can settle leaves the remainder as standalone usage", () => {
  const { charges, credits } = pairCreditsToCharges({
    charges: [{ txn_id: "a", date: "2026-08-01", amount: 30 }],
    credits: [{ txn_id: "r", date: "2026-08-10", amount: 50 }],
  });
  assert.equal(charges[0].confirmed, 30);
  assert.equal(credits[0].standalone, 20);
});

test("cent-level float residue is not left behind as a standalone credit", () => {
  const { credits } = pairCreditsToCharges({
    charges: [{ txn_id: "a", date: "2026-08-01", amount: 4.1 }, { txn_id: "b", date: "2026-08-02", amount: 10.9 }],
    credits: [{ txn_id: "r", date: "2026-08-10", amount: 15 }],
  });
  assert.equal(credits[0].standalone, 0);
});

// ── Invariants ────────────────────────────────────────────────────────────────

test("the same transaction id is only ever counted once", () => {
  // SELECT DISTINCT in the SQL already guarantees this for a transaction two
  // overlapping rules both match (DOORDASH and DOOR). The invariant is enforced
  // here as well, where a unit test can reach it, because everything downstream
  // rests on it: a charge counted twice inflates amount_used and suppresses the
  // alert the owner needs.
  const cards = [card({ benefits: [benefit({ amount_limit: 100 })] })];
  const { plans } = buildWindows(cards, "2026-08-23");
  const row = {
    benefit_id: 10, period_key: "cal:month:1:2026-08", txn_id: "dupe",
    date: "2026-08-04", merchant: "DOORDASH", amount: 50, is_credit: false,
  };
  const stats = deriveBenefitStats({
    plans,
    rows: [row, { ...row }, { ...row }],
    // The aggregate is DISTINCT-derived and therefore already correct; the rows
    // are the half that could arrive duplicated.
    aggregates: [{ benefit_id: 10, period_key: "cal:month:1:2026-08", is_credit: false, total: 50, count: 1, last_date: "2026-08-04" }],
  }, "2026-08-23");
  assert.equal(stats["10"].matches.length, 1);
  assert.equal(stats["10"].amountUsed, 50);
  assert.equal(stats["10"].matchesTruncated, false);
});

test("a rule matching more transactions than pairing can hold reports rule-error", () => {
  // The row cap announces itself rather than degrading: pairing over a subset
  // of the candidates misclassifies standalone-vs-paired credits, and an
  // unreliable classification inflates amount_used and suppresses an alert.
  const cards = [card({ benefits: [benefit({ amount_limit: 100000 })] })];
  const txns = [];
  for (let i = 0; i <= PAIRING_ROW_LIMIT; i++) {
    txns.push(txn({ txn_id: `bulk-${i}`, date: "2026-08-04", amount: 1 }));
  }
  const over = one({ cards, txns }, "2026-08-23");
  assert.equal(over.status, "rule-error");
  assert.match(over.rule_error, /more than 2000 transactions/);
  // It gets one message per period of its own, and no expiry nudge — the figure
  // an expiry nudge would quote was never trustworthy.
  assert.deepEqual(alertTiers({ benefit: over, daysLeft: over.days_left, status: over.status }), ["rule-error"]);

  // Exactly at the cap is fine, and the money is still exact.
  const at = one({ cards, txns: txns.slice(0, PAIRING_ROW_LIMIT) }, "2026-08-23");
  assert.equal(at.status, "partially-used");
  assert.equal(at.rule_error, null);
  assert.equal(at.amount_used, PAIRING_ROW_LIMIT);
});

test("amount_used is the period total even when `matches` only lists a sample", () => {
  const cards = [card({ benefits: [benefit({ amount_limit: 1000 })] })];
  const txns = [];
  for (let i = 0; i < MATCHES_DISPLAY_LIMIT + 50; i++) {
    txns.push(txn({ txn_id: `t-${i}`, date: "2026-08-04", amount: 1 }));
  }
  const result = one({ cards, txns }, "2026-08-23");
  assert.equal(result.amount_used, MATCHES_DISPLAY_LIMIT + 50);
  assert.equal(result.matches.length, MATCHES_DISPLAY_LIMIT);
  assert.equal(result.matches_truncated, true);
});

test("a manual mark outranks automatic matching for its period", () => {
  const cards = [card({ benefits: [benefit({ amount_limit: 100, rules: [
    { id: 1, merchant_regex: "SAKS", direction: "charge" },
  ] })] })];
  const txns = [txn({ txn_id: "chg", date: "2026-08-04", merchant: "SAKS", amount: 100 })];
  const marks = [{ benefit_id: 10, period_key: "cal:month:1:2026-08", amount: 100, note: "used it", created_at: "2026-08-05" }];
  const result = one({ cards, txns, marks }, "2026-08-23");
  // One $100 use seen twice, not $200 of spend.
  assert.equal(result.amount_used, 100);
  assert.equal(result.amount_remaining, 0);
  assert.equal(result.confidence, "manual");
  assert.equal(result.status, "used");
  // The automatic match is still listed — it is the evidence the mark is
  // checked against.
  assert.deepEqual(result.matches.map((m) => m.source), ["auto", "manual"]);

  // A mark on a DIFFERENT period does not reach this one.
  const elsewhere = [{ ...marks[0], period_key: "cal:month:1:2026-07" }];
  const unmarked = one({ cards, txns, marks: elsewhere }, "2026-08-23");
  assert.equal(unmarked.confidence, "unconfirmed");
  assert.equal(unmarked.status, "used-unconfirmed");
});

test("a period that opens before the card's history is insufficient-history, never available", () => {
  // The honesty gate, kept verbatim through the rebuild: claiming a benefit
  // unused over a window we cannot see is the failure this status exists to
  // prevent.
  const cards = [card({ benefits: [benefit({ name: "Airline fee credit", period_unit: "year", amount_limit: 200 })] })];
  const short = one({ cards, historyByAccount: { "acct-1": "2026-05-01" } }, "2026-08-23");
  assert.equal(short.period_start, "2026-01-01");
  assert.equal(short.status, "insufficient-history");
  assert.equal(short.confidence, "none");
  assert.deepEqual(alertTiers({ benefit: short, daysLeft: short.days_left, status: short.status }), []);

  // History that covers the window allows `available`.
  assert.equal(one({ cards, historyByAccount: { "acct-1": "2025-12-01" } }, "2026-08-23").status, "available");
  // No history at all, and an unlinked card, cannot claim it either.
  assert.equal(one({ cards, historyByAccount: {} }, "2026-08-23").status, "insufficient-history");
  const unlinked = [card({ account_id: null, benefits: [benefit()] })];
  assert.equal(one({ cards: unlinked }, "2026-08-23").status, "insufficient-history");
});

test("a benefit whose only rule has no criteria is manual-only, never available", () => {
  // The same honesty gate. A rule with no regex, no amount bounds and no
  // category is skipped by the scan, so a benefit holding nothing else can
  // never match automatically — and counting it as a rule reported the benefit
  // as `available`, in green, meaning "nothing has matched this period yet"
  // about a benefit where nothing ever could.
  //
  // Not `rule-error` either: an unfinished row in the editor is not a broken
  // regex, and saying a rule failed would send the owner hunting for a fault
  // that is not there. It is a benefit with no automatic footprint, which is
  // exactly what manual-only means.
  const cards = [card({ benefits: [benefit({ rules: [{ id: 1, direction: "charge" }] })] })];
  const result = one({ cards }, "2026-08-23");
  assert.equal(result.status, "manual-only");
  assert.equal(result.confidence, "none");
  assert.equal(result.rule_error, null);
});

test("one usable rule alongside a criteria-less one still evaluates normally", () => {
  // The criteria-less rule is simply not there as far as evaluation goes; the
  // benefit is judged on the rule that can actually match.
  const cards = [card({ benefits: [benefit({
    amount_limit: 100,
    rules: [
      { id: 1, merchant_regex: "SAKS", direction: "charge" },
      { id: 2, direction: "charge" },
    ],
  })] })];
  // Nothing matched yet, and the history covers the window: available, as it
  // would be with the usable rule on its own.
  const idle = one({ cards }, "2026-08-23");
  assert.equal(idle.status, "available");
  assert.equal(idle.rule_error, null);

  const txns = [txn({ txn_id: "chg", date: "2026-08-04", merchant: "SAKS FIFTH AVE", amount: 100 })];
  const used = one({ cards, txns }, "2026-08-23");
  assert.equal(used.amount_used, 100);
  assert.equal(used.status, "used-unconfirmed");
  assert.equal(used.rule_error, null);
});

// ── Windows ───────────────────────────────────────────────────────────────────

test("windows tile the scope contiguously, newest first, one row per benefit-period", () => {
  const cards = [card({ benefits: [benefit()] })];
  const { windows } = buildWindows(cards, "2026-08-23");
  assert.deepEqual(windows.map((w) => w.period_key), [
    "cal:month:1:2026-08", "cal:month:1:2026-07", "cal:month:1:2026-06",
    "cal:month:1:2026-05", "cal:month:1:2026-04",
  ]);
  // Contiguous: each window starts the day after the previous one ends. That is
  // what makes "the window a credit for period P posts in" simply the next
  // period, and why no separate grace tail is needed any more.
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  for (let i = 1; i < windows.length; i++) {
    assert.equal((day(windows[i - 1].start_date) - day(windows[i].end_date)) / 86400000, 1);
  }
  assert.equal(new Set(windows.map((w) => `${w.benefit_id}|${w.period_key}`)).size, windows.length);
});

test("a card with no linked account, and a benefit with no usable rule, get no window", () => {
  // Nothing to scan, so nothing is asked of the transactions table — but the
  // benefit still gets a plan, because the response has to carry a period for it.
  const unlinked = [card({ account_id: null, benefits: [benefit()] })];
  assert.equal(buildWindows(unlinked, "2026-08-23").windows.length, 0);
  assert.equal(buildWindows(unlinked, "2026-08-23").plans.length, 1);

  const noRules = [card({ benefits: [benefit({ rules: [] })] })];
  assert.equal(buildWindows(noRules, "2026-08-23").windows.length, 0);

  // A rule with no criteria at all would match the entire statement and mark
  // every benefit used, so it is skipped rather than obeyed.
  assert.equal(hasCriteria({ id: 1, direction: "charge" }), false);
  assert.equal(hasCriteria({ id: 1, amount_min: 5 }), true);
  const empty = [card({ benefits: [benefit({ rules: [{ id: 1, direction: "charge" }] })] })];
  assert.equal(buildWindows(empty, "2026-08-23").windows.length, 0);

  // ...and so is a rule this read has excluded because its regex no longer
  // compiles.
  const broken = [card({ benefits: [benefit({ rules: [{ id: 7, merchant_regex: "[bad", direction: "charge" }] })] })];
  assert.equal(buildWindows(broken, "2026-08-23", { excludedRuleIds: [7] }).windows.length, 0);
});

test("an anchored months_n cycle scans the trailing window and anchors on what it finds", () => {
  // A use recorded while the benefit was available carries the "anchor:none"
  // key and then BECOMES the anchor, at which point the key changes. Selecting
  // by key would lose the very transaction that defined the period, so anchored
  // cycles select by date.
  const cards = [card({ benefits: [benefit({
    id: 20, name: "Global Entry", amount_limit: 120, period_unit: "months_n", period_count: 48,
    rules: [{ id: 1, merchant_regex: "GLOBAL ENTRY", direction: "charge" }],
  })] })];
  const { windows } = buildWindows(cards, "2026-08-23");
  assert.deepEqual(windows.map((w) => [w.period_key, w.start_date, w.end_date]), [
    ["anchor:months_n:48:none", "2022-08-24", "2026-08-23"],
  ]);

  const txns = [txn({ benefit_id: 20, txn_id: "ge-1", date: "2024-03-15", merchant: "TSA GLOBAL ENTRY", amount: 120 })];
  const result = one({ cards, txns }, "2026-08-23");
  assert.equal(result.period_key, "anchor:months_n:48:2024-03-15");
  assert.equal(result.period_start, "2024-03-15");
  assert.equal(result.amount_used, 120);
  assert.equal(result.status, "used-unconfirmed");

  // With nothing in the trailing window the cycle is available again and has
  // nothing to expire.
  const fresh = one({ cards }, "2026-08-23");
  assert.equal(fresh.period_key, "anchor:months_n:48:none");
  assert.equal(fresh.status, "available");
  assert.equal(fresh.days_left, null);
});

test("a months_n mark anchors the cycle even though its key no longer matches", () => {
  const cards = [card({ benefits: [benefit({
    id: 20, name: "Global Entry", amount_limit: 120, period_unit: "months_n", period_count: 48,
    rules: [{ id: 1, merchant_regex: "GLOBAL ENTRY", direction: "charge" }],
  })] })];
  const marks = [{ benefit_id: 20, period_key: "anchor:months_n:48:none", amount: 120, note: null, created_at: "2025-06-01" }];
  const result = one({ cards, marks }, "2026-08-23");
  assert.equal(result.period_key, "anchor:months_n:48:2025-06-01");
  assert.equal(result.amount_used, 120);
  assert.equal(result.confidence, "manual");
  assert.equal(result.status, "used");
});

// The skew window that lets a credit settle a slightly-later charge must never
// become a peer of the ordinary "the charge came first" case. Selection takes
// the LATEST qualifying charge, so while forward charges were equal candidates
// an unrelated later charge outranked the true earlier one, and a credit could
// reach across a period boundary to confirm the next period's spend. The whole
// suite passed while that was live, hence these.
test("a credit settles the charge that preceded it, not a later lookalike", () => {
  const { charges } = pairCreditsToCharges({
    charges: [
      { txn_id: "true",  date: "2026-08-01", amount: 100, period_key: "2026-08" },
      { txn_id: "decoy", date: "2026-08-12", amount: 100, period_key: "2026-08" },
    ],
    credits: [{ txn_id: "cr", date: "2026-08-10", amount: 100, period_key: "2026-08" }],
  });
  const by = Object.fromEntries(charges.map((c) => [c.txn_id, c.confirmed]));
  assert.equal(by.true, 100, "the charge the credit actually reimbursed");
  assert.equal(by.decoy, 0, "a charge three days later did not earn this credit");
});

test("a charge on both sides of a credit settles from the earlier one", () => {
  const { charges } = pairCreditsToCharges({
    charges: [
      { txn_id: "before", date: "2026-08-05", amount: 50, period_key: "2026-08" },
      { txn_id: "after",  date: "2026-08-08", amount: 50, period_key: "2026-08" },
    ],
    credits: [{ txn_id: "cr", date: "2026-08-06", amount: 50, period_key: "2026-08" }],
  });
  const by = Object.fromEntries(charges.map((c) => [c.txn_id, c.confirmed]));
  assert.equal(by.before, 50);
  assert.equal(by.after, 0);
});

test("the skew window still settles a charge that posts after its own credit", () => {
  // Nothing precedes, so the fallback is the only candidate — which is exactly
  // what the window is for. Statement date and post date come off different
  // clocks and small inversions are real.
  const inside = pairCreditsToCharges({
    charges: [{ txn_id: "ch", date: "2026-08-06", amount: 100, period_key: "2026-08" }],
    credits: [{ txn_id: "cr", date: "2026-08-01", amount: 100, period_key: "2026-08" }],
  });
  assert.equal(inside.charges[0].confirmed, 100, `pairs at exactly +${PAIR_DATE_SKEW_DAYS} days`);

  const outside = pairCreditsToCharges({
    charges: [{ txn_id: "ch", date: "2026-08-07", amount: 100, period_key: "2026-08" }],
    credits: [{ txn_id: "cr", date: "2026-08-01", amount: 100, period_key: "2026-08" }],
  });
  assert.equal(outside.charges[0].confirmed, 0, "one day past the window does not pair");
});
