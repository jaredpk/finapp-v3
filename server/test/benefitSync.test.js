import test from "node:test";
import assert from "node:assert/strict";
import { syncUsage, CREDIT_LOOKBACK_DAYS, CREDIT_GRACE_DAYS, CREDIT_AMOUNT_TOLERANCE } from "../benefits/sync.js";
import { evaluateBenefits } from "../benefits/periods.js";

// The recording half of card-benefit tracking, driven against a fake database.
// sync.js takes every query through an injected `io`, the same way periods.js
// takes no I/O at all, so the decision this file exists to pin down can be
// tested without pg:
//
//   WHERE does a posted statement credit land?
//
// It posts a cycle after the charge it confirms. Filing it where it landed
// leaves the charge's period `used-unconfirmed` forever and hands the NEXT
// period a use nobody made — it reads `used`, its allowance is gone before a
// cent of it is spent, and the "unused credit expiring" alert the owner needs
// never fires. That is the failure mode the whole feature exists to prevent.

// ── A fake cb_usage + transactions ───────────────────────────────────────────

// Mirrors the parts of repository.js sync.js depends on: the same conditions
// (account, window, direction, regex, amount bounds), the same bounded sample
// with a truncation flag, the same uniqueness on (benefit, period, txn) and the
// same sticky confirmation.
function fakeDb(transactions, { sampleLimit = 200 } = {}) {
  const usage = [];
  let nextId = 1;

  const selects = ({ accountId, startDate, endDate, direction, merchantRegex, amountMin, amountMax, excludeTxnIds }) =>
    transactions
      .filter((t) => t.account === accountId)
      .filter((t) => (!startDate || t.date >= startDate) && (!endDate || t.date <= endDate))
      .filter((t) => (direction === "credit" ? t.amount < 0 : t.amount > 0))
      .filter((t) => !merchantRegex || new RegExp(merchantRegex, "i").test(t.merchant || ""))
      .filter((t) => amountMin == null || Math.abs(t.amount) >= amountMin)
      .filter((t) => amountMax == null || Math.abs(t.amount) <= amountMax)
      .filter((t) => !excludeTxnIds?.includes(t.id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const io = {
    async findMatches(params) {
      if (params.merchantRegex === "BROKEN[") {
        const err = new Error("invalid regular expression: brackets [] not balanced");
        err.invalidRegex = true;
        throw err;
      }
      const rows = selects(params);
      return { rows: rows.slice(0, sampleLimit), truncated: rows.length > sampleLimit };
    },
    async sumMatches(params) {
      const rows = selects(params);
      return { count: rows.length, total: rows.reduce((sum, t) => sum + Math.abs(t.amount), 0) };
    },
    async upsertUsage({ benefitId, periodKey, amount, txnId, source, confirmedAt = null, note = null }) {
      const existing = usage.find((u) => u.benefit_id === benefitId && u.period_key === periodKey && u.txn_id === txnId);
      if (existing) {
        existing.amount = amount;
        existing.confirmed_at = existing.confirmed_at || confirmedAt;
        return { id: existing.id };
      }
      const row = {
        id: nextId++, benefit_id: benefitId, period_key: periodKey, amount,
        txn_id: txnId, source, confirmed_at: confirmedAt, confirmed_txn_id: null, note,
      };
      usage.push(row);
      return { id: row.id };
    },
    async confirmUsage({ usageId, confirmedAt, confirmedTxnId }) {
      const row = usage.find((u) => u.id === usageId);
      if (!row) return false;
      row.confirmed_at = row.confirmed_at || confirmedAt;
      row.confirmed_txn_id = row.confirmed_txn_id || confirmedTxnId;
      return true;
    },
    async deleteUsage(benefitId, periodKey, txnId) {
      const i = usage.findIndex((u) => u.benefit_id === benefitId && u.period_key === periodKey && u.txn_id === txnId);
      if (i < 0) return false;
      usage.splice(i, 1);
      return true;
    },
  };

  // What listUsage would hand back: the stored row plus the date and merchant
  // of the transaction behind it.
  const listUsage = () =>
    usage.map((row) => {
      const txn = transactions.find((t) => t.id === row.txn_id);
      return { ...row, date: txn?.date ?? null, merchant: txn?.merchant ?? null };
    });

  return { io, usage, listUsage };
}

const card = (over = {}) => ({
  id: 1,
  nickname: "Amex Platinum",
  account_id: "acct-1",
  anniversary_date: "2019-09-14",
  benefits: [],
  ...over,
});

const benefit = (over = {}) => ({
  id: 10,
  name: "Hotel credit",
  amount_limit: 100,
  period_unit: "month",
  period_count: 1,
  period_basis: "calendar",
  rules: [],
  ...over,
});

const chargeRule = (over = {}) => ({ id: 1, benefit_id: 10, merchant_regex: "HOTEL", direction: "charge", ...over });
const creditRule = (over = {}) => ({ id: 2, benefit_id: 10, merchant_regex: "STATEMENT CREDIT", direction: "credit", ...over });

const evaluate = (cards, usageRows, today, ruleErrors = []) =>
  evaluateBenefits({ cards, usageRows, historyByAccount: { "acct-1": "2019-01-01" }, ruleErrors }, today)[0].benefits[0];

const AUGUST = "cal:month:1:2026-08";
const SEPTEMBER = "cal:month:1:2026-09";

// ── The lagging statement credit ─────────────────────────────────────────────

test("a credit that posts a cycle late confirms August's charge instead of consuming September", async () => {
  const transactions = [
    { id: "t-charge", account: "acct-1", date: "2026-08-04", merchant: "HOTEL COLLECTION", amount: 100 },
    { id: "t-credit", account: "acct-1", date: "2026-09-02", merchant: "AMEX STATEMENT CREDIT", amount: -100 },
  ];
  const cards = [card({ benefits: [benefit({ rules: [chargeRule(), creditRule()] })] })];
  const { io, listUsage } = fakeDb(transactions);

  const { ruleErrors } = await syncUsage(cards, [], "2026-09-05", io);
  assert.deepEqual(ruleErrors, []);

  const rows = listUsage();
  // One row, in the period of the CHARGE, confirmed by the credit that settled it.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period_key, AUGUST);
  assert.equal(rows[0].txn_id, "t-charge");
  assert.ok(rows[0].confirmed_at, "the charge must be confirmed by the posted credit");
  assert.equal(rows[0].confirmed_txn_id, "t-credit");
  // Nothing at all was filed against September.
  assert.equal(rows.filter((r) => r.period_key === SEPTEMBER).length, 0);

  // August closes used and confirmed...
  const august = evaluate(cards, rows, "2026-08-31");
  assert.equal(august.period_key, AUGUST);
  assert.equal(august.status, "used");
  assert.equal(august.confidence, "confirmed");
  assert.equal(august.amount_used, 100);

  // ...and September opens with its whole allowance intact, which is what makes
  // the "unused credit expiring" alert still fire.
  const september = evaluate(cards, rows, "2026-09-05");
  assert.equal(september.period_key, SEPTEMBER);
  assert.equal(september.status, "available");
  assert.equal(september.confidence, "none");
  assert.equal(september.amount_used, 0);
  assert.equal(september.amount_remaining, 100);
  assert.deepEqual(september.matches, []);
});

test("re-running the sync neither re-files the credit nor re-counts anything", async () => {
  const transactions = [
    { id: "t-charge", account: "acct-1", date: "2026-08-04", merchant: "HOTEL COLLECTION", amount: 100 },
    { id: "t-credit", account: "acct-1", date: "2026-09-02", merchant: "AMEX STATEMENT CREDIT", amount: -100 },
  ];
  const cards = [card({ benefits: [benefit({ rules: [chargeRule(), creditRule()] })] })];
  const { io, listUsage } = fakeDb(transactions);

  await syncUsage(cards, [], "2026-09-05", io);
  // The second run is the dangerous one: the charge it would pair with is no
  // longer unconfirmed, and a credit that "found nothing" would be filed under
  // its own period — September — the very bug being fixed.
  await syncUsage(cards, listUsage(), "2026-09-05", io);

  const rows = listUsage();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period_key, AUGUST);
  assert.equal(evaluate(cards, rows, "2026-09-05").status, "available");
});

test("a credit with no charge to confirm is filed under its own period", async () => {
  // A benefit matched only on its posted credit still has to report the amount —
  // the confirmation path must not swallow it.
  const transactions = [
    { id: "t-credit", account: "acct-1", date: "2026-09-02", merchant: "AMEX STATEMENT CREDIT", amount: -100 },
  ];
  const cards = [card({ benefits: [benefit({ rules: [creditRule()] })] })];
  const { io, listUsage } = fakeDb(transactions);

  await syncUsage(cards, [], "2026-09-05", io);
  const rows = listUsage();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period_key, SEPTEMBER);
  assert.ok(rows[0].confirmed_at);

  const september = evaluate(cards, rows, "2026-09-05");
  assert.equal(september.status, "used");
  assert.equal(september.confidence, "confirmed");
  assert.equal(september.amount_used, 100);
});

test("a credit only pairs with a charge of the same amount", async () => {
  // $100 of hotel spend and a $50 credit are not the same use, so the credit is
  // its own row rather than a false confirmation of the charge.
  const transactions = [
    { id: "t-charge", account: "acct-1", date: "2026-08-04", merchant: "HOTEL COLLECTION", amount: 100 },
    { id: "t-credit", account: "acct-1", date: "2026-09-02", merchant: "AMEX STATEMENT CREDIT", amount: -50 },
  ];
  const cards = [card({ benefits: [benefit({ rules: [chargeRule(), creditRule()] })] })];
  const { io, listUsage } = fakeDb(transactions);

  await syncUsage(cards, [], "2026-09-05", io);
  const rows = listUsage();
  assert.equal(rows.find((r) => r.txn_id === "t-charge").confirmed_at, null);
  assert.equal(rows.find((r) => r.txn_id === "t-credit").period_key, SEPTEMBER);

  // ...but a cent of float round-trip is still the same use.
  const near = fakeDb([
    { id: "t-charge", account: "acct-1", date: "2026-08-04", merchant: "HOTEL COLLECTION", amount: 100 },
    { id: "t-credit", account: "acct-1", date: "2026-09-02", merchant: "AMEX STATEMENT CREDIT", amount: -(100 - CREDIT_AMOUNT_TOLERANCE / 2) },
  ]);
  await syncUsage(cards, [], "2026-09-05", near.io);
  assert.equal(near.listUsage().length, 1);
  assert.equal(near.listUsage()[0].confirmed_txn_id, "t-credit");
});

test("a charge inside a closed period is still recorded on a later sync", async () => {
  // A backfilled transaction lands in a period that has already closed; a sync
  // that only ever looked at the current period would never see it.
  const transactions = [
    { id: "t-june", account: "acct-1", date: "2026-06-11", merchant: "HOTEL COLLECTION", amount: 100 },
  ];
  const cards = [card({ benefits: [benefit({ rules: [chargeRule()] })] })];
  const { io, listUsage } = fakeDb(transactions);

  await syncUsage(cards, [], "2026-09-05", io);
  assert.deepEqual(listUsage().map((r) => r.period_key), ["cal:month:1:2026-06"]);
  // ...and nothing older than the lookback is touched.
  const old = fakeDb([{ id: "t-old", account: "acct-1", date: "2026-01-11", merchant: "HOTEL COLLECTION", amount: 100 }]);
  await syncUsage(cards, [], "2026-09-05", old.io);
  assert.deepEqual(old.listUsage(), []);
});

// ── Rule failures ────────────────────────────────────────────────────────────

test("a rule that will not run is reported, not silently skipped", async () => {
  const cards = [card({ benefits: [benefit({ rules: [chargeRule({ merchant_regex: "BROKEN[" })] })] })];
  const { io, listUsage } = fakeDb([]);

  const { ruleErrors } = await syncUsage(cards, [], "2026-09-05", io);
  assert.equal(ruleErrors.length > 0, true);
  assert.equal(ruleErrors[0].benefit_id, 10);
  assert.equal(ruleErrors[0].rule_id, 1);

  // ...and the benefit it belongs to reads as a problem, never as available.
  assert.equal(evaluate(cards, listUsage(), "2026-09-05", ruleErrors).status, "rule-error");
});

// ── The money the sample does not carry ──────────────────────────────────────

test("a rule matching more transactions than the sample holds still reports the exact total", async () => {
  // The recording path used to stop at its row cap, so a fully-used credit could
  // report partially-used — or available — purely because the cap was hit.
  const transactions = Array.from({ length: 12 }, (_, i) => ({
    id: `t-${String(i).padStart(2, "0")}`,
    account: "acct-1",
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    merchant: "HOTEL COLLECTION",
    amount: 25,
  }));
  const cards = [card({ benefits: [benefit({ amount_limit: 300, rules: [chargeRule()] })] })];
  const { io, listUsage } = fakeDb(transactions, { sampleLimit: 5 });

  await syncUsage(cards, [], "2026-09-30", io);
  const rows = listUsage();
  const rollup = rows.find((r) => r.txn_id === "rollup:rule:1");
  assert.ok(rollup, "the money beyond the sample has to go somewhere");
  assert.equal(rows.filter((r) => r.txn_id !== "rollup:rule:1").length, 5);
  assert.equal(rollup.amount, 175); // the 7 transactions no row accounts for

  const september = evaluate(cards, rows, "2026-09-30");
  assert.equal(september.amount_used, 300); // 12 x 25, not 5 x 25
  assert.equal(september.status, "used-unconfirmed");
  assert.equal(september.matches.length, 5);
  assert.equal(september.matches_truncated, true);
});

test("a rollup that is no longer needed is removed rather than left to double-count", async () => {
  const transactions = Array.from({ length: 6 }, (_, i) => ({
    id: `t-${i}`, account: "acct-1", date: `2026-09-0${i + 1}`, merchant: "HOTEL COLLECTION", amount: 25,
  }));
  const cards = [card({ benefits: [benefit({ amount_limit: 300, rules: [chargeRule()] })] })];
  const tight = fakeDb(transactions, { sampleLimit: 5 });
  await syncUsage(cards, [], "2026-09-30", tight.io);
  assert.ok(tight.listUsage().some((r) => r.txn_id === "rollup:rule:1"));

  // Same rows, a sample big enough to hold them all: every transaction is now
  // recorded individually and the rollup would be counted twice.
  const roomy = fakeDb(transactions, { sampleLimit: 200 });
  for (const row of tight.usage) roomy.usage.push({ ...row });
  await syncUsage(cards, roomy.listUsage(), "2026-09-30", roomy.io);
  const rows = roomy.listUsage();
  assert.equal(rows.some((r) => r.txn_id === "rollup:rule:1"), false);
  assert.equal(evaluate(cards, rows, "2026-09-30").amount_used, 150);
});

test("the lookback and grace windows are named, bounded and cover a full cycle of lag", () => {
  // Both are the reason the credit above is found at all: 120 days of periods to
  // revisit, and 45 days past a period's end to keep looking for its credit.
  assert.equal(CREDIT_LOOKBACK_DAYS, 120);
  assert.equal(CREDIT_GRACE_DAYS, 45);
  assert.ok(CREDIT_GRACE_DAYS >= 31, "a credit that posts one full cycle late must still be found");
  assert.ok(CREDIT_LOOKBACK_DAYS > CREDIT_GRACE_DAYS, "there is no point looking past a period we no longer sync");
});
