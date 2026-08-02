import test from "node:test";
import assert from "node:assert/strict";
import { groupDuplicates, findUnmatchedPaymentLegs, isImportedId, duplicateKey } from "../transactionMatching.js";

// The cases below are the real July 2026 rows that the old (date, ABS(amount))
// key destroyed. Each one must produce NO duplicate group.

test("opposite-sign legs of the same card payment on different accounts are not duplicates", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-13", merchant: "Capital One Payment", amount: 6054.25, account: "checking", created_at: "2026-07-13T10:00:00Z" },
    { id: "plaid_b", date: "2026-07-13", merchant: "Capital One Payment", amount: -6054.25, account: "venture_x", created_at: "2026-07-13T10:00:00Z" },
  ];
  assert.deepEqual(groupDuplicates(rows), []);
});

test("same account and same magnitude but different merchants and signs is not a duplicate", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-22", merchant: "Beartooth Market", amount: 9.99, account: "venture_x", created_at: "2026-07-22T10:00:00Z" },
    { id: "plaid_b", date: "2026-07-22", merchant: "Uber One", amount: -9.99, account: "venture_x", created_at: "2026-07-22T11:00:00Z" },
  ];
  assert.deepEqual(groupDuplicates(rows), []);
});

test("a charge and its same-day exact reversal are distinct transactions", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-22", merchant: "Uber One", amount: 9.99, account: "venture_x", created_at: "2026-07-22T10:00:00Z" },
    { id: "plaid_b", date: "2026-07-22", merchant: "Uber One", amount: -9.99, account: "venture_x", created_at: "2026-07-22T12:00:00Z" },
  ];
  assert.deepEqual(groupDuplicates(rows), []);
});

test("an imported row matching a Plaid row on every field is a real duplicate", () => {
  const rows = [
    { id: "simplifi_123", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-15T09:00:00Z" },
    { id: "plaid_native_1", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-14T09:00:00Z" },
  ];
  const groups = groupDuplicates(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep, "plaid_native_1");
  assert.deepEqual(groups[0].remove, ["simplifi_123"]);
  assert.equal(groups[0].account, "venture_x");
  assert.equal(groups[0].amount, 42.5);
});

test("two Plaid-native rows that look identical are never proposed for removal", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-14T09:00:00Z" },
    { id: "plaid_b", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-14T09:30:00Z" },
  ];
  assert.deepEqual(groupDuplicates(rows), []);
});

test("an all-imported group keeps the earliest copy and removes the rest", () => {
  const rows = [
    { id: "csv_late", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-20T09:00:00Z" },
    { id: "simplifi_early", date: "2026-07-14", merchant: "Trader Joe's", amount: 42.5, account: "venture_x", created_at: "2026-07-15T09:00:00Z" },
  ];
  const groups = groupDuplicates(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep, "simplifi_early");
  assert.deepEqual(groups[0].remove, ["csv_late"]);
});

test("duplicateKey keeps the sign and the account, and normalizes merchant casing", () => {
  const base = { date: "2026-07-13", account: "checking", amount: 6054.25, merchant: "Capital One" };
  assert.notEqual(duplicateKey(base), duplicateKey({ ...base, amount: -6054.25 }));
  assert.notEqual(duplicateKey(base), duplicateKey({ ...base, account: "venture_x" }));
  assert.equal(duplicateKey(base), duplicateKey({ ...base, merchant: "  CAPITAL ONE " }));
  assert.equal(duplicateKey(base), duplicateKey({ ...base, date: new Date("2026-07-13T00:00:00Z"), amount: "6054.25" }));
});

test("isImportedId only matches ids we generated ourselves", () => {
  assert.equal(isImportedId("csv_abc"), true);
  assert.equal(isImportedId("simplifi_abc"), true);
  assert.equal(isImportedId("dLKG0Vp7bBIzR3EJ8jNyt5aWXZ"), false);
  assert.equal(isImportedId(null), false);
});

// ── Reconciliation ────────────────────────────────────────────────────────────

const depositoryAccounts = new Set(["checking"]);

test("a card payment with no card-side credit is flagged", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-13", merchant: "Capital One Online Payment", amount: 6054.25, account: "checking" },
  ];
  const unmatched = findUnmatchedPaymentLegs(rows, { depositoryAccounts });
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].fundingLeg.id, "plaid_a");
  assert.equal(unmatched[0].reason, "no matching card-side credit");
});

test("a card payment whose credit posted a day earlier on the card is not flagged", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-31", merchant: "AMEX EPAYMENT ACH PMT", amount: 4643.76, account: "checking" },
    { id: "plaid_b", date: "2026-07-30", merchant: "Online Payment Thank You", amount: -4643.76, account: "amex_plat" },
  ];
  assert.deepEqual(findUnmatchedPaymentLegs(rows, { depositoryAccounts }), []);
});

test("a credit outside the window does not settle the funding leg", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-13", merchant: "Capital One Online Payment", amount: 6054.25, account: "checking" },
    { id: "plaid_b", date: "2026-07-20", merchant: "Payment Thank You", amount: -6054.25, account: "venture_x" },
  ];
  assert.equal(findUnmatchedPaymentLegs(rows, { depositoryAccounts }).length, 1);
});

test("two identical payments need two credits", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-13", merchant: "Capital One Online Payment", amount: 500, account: "checking" },
    { id: "plaid_b", date: "2026-07-13", merchant: "Capital One Online Payment", amount: 500, account: "checking" },
    { id: "plaid_c", date: "2026-07-13", merchant: "Payment Thank You", amount: -500, account: "venture_x" },
  ];
  assert.equal(findUnmatchedPaymentLegs(rows, { depositoryAccounts }).length, 1);
});

test("ordinary depository outflows are not treated as card payments", () => {
  const rows = [
    { id: "plaid_a", date: "2026-07-13", merchant: "Beartooth Market", amount: 6054.25, account: "checking" },
  ];
  assert.deepEqual(findUnmatchedPaymentLegs(rows, { depositoryAccounts }), []);
});
