import test from "node:test";
import assert from "node:assert/strict";
import { matchReceiptToTransaction, stripHtml } from "../receiptScan.js";

// Candidate rows mirror what receiptScan.js's findCandidates SQL produces:
// { id, amount, date, status, has_match }. Amounts follow the DB convention
// (positive = expense), same as receipt totals.
const cand = (over = {}) => ({
  id: "txn_1",
  amount: 42.5,
  date: "2026-08-05",
  status: "reviewed",
  has_match: false,
  ...over,
});

const receipt = { total: 42.5, date: "2026-08-05" };

test("exact amount on the receipt date matches", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand()]), "txn_1");
});

test("amount within $0.01 counts as exact", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ amount: 42.505 })]), "txn_1");
});

test("no exact candidate falls back to within 1%", () => {
  // 42.50 * 1% = 0.425 — 42.80 is within tolerance, but not within $0.01
  assert.equal(matchReceiptToTransaction(receipt, [cand({ amount: 42.8 })]), "txn_1");
});

test("outside 1% tolerance does not match", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ amount: 43.5 })]), null);
});

test("an exact candidate wins without widening to the 1% pool", () => {
  const rows = [
    cand({ id: "exact", amount: 42.5 }),
    cand({ id: "near", amount: 42.8 }), // inside 1%, outside $0.01
  ];
  assert.equal(matchReceiptToTransaction(receipt, rows), "exact");
});

test("date window: receipt date - 1 is included", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ date: "2026-08-04" })]), "txn_1");
});

test("date window: receipt date + 4 is included", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ date: "2026-08-09" })]), "txn_1");
});

test("date window: receipt date - 2 is excluded", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ date: "2026-08-03" })]), null);
});

test("date window: receipt date + 5 is excluded", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ date: "2026-08-10" })]), null);
});

test("multiple candidates mean no match — never guess", () => {
  const rows = [cand({ id: "a" }), cand({ id: "b", date: "2026-08-06" })];
  assert.equal(matchReceiptToTransaction(receipt, rows), null);
});

test("pending transactions are excluded", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ status: "pending" })]), null);
});

test("a pending duplicate does not block the posted row", () => {
  const rows = [cand({ id: "posted" }), cand({ id: "pend", status: "pending" })];
  assert.equal(matchReceiptToTransaction(receipt, rows), "posted");
});

test("transactions that already have a receipt match are excluded", () => {
  assert.equal(matchReceiptToTransaction(receipt, [cand({ has_match: true })]), null);
});

test("an already-matched duplicate does not block the unmatched row", () => {
  const rows = [cand({ id: "free" }), cand({ id: "taken", has_match: true })];
  assert.equal(matchReceiptToTransaction(receipt, rows), "free");
});

test("no candidates means no match", () => {
  assert.equal(matchReceiptToTransaction(receipt, []), null);
});

test("a receipt without a usable total or date never matches", () => {
  assert.equal(matchReceiptToTransaction({ total: 0, date: "2026-08-05" }, [cand({ amount: 0 })]), null);
  assert.equal(matchReceiptToTransaction({ total: 42.5 }, [cand()]), null);
  assert.equal(matchReceiptToTransaction(null, [cand()]), null);
});

test("stripHtml flattens tags, entities and hidden content", () => {
  const html =
    "<html><head><style>body{color:red}</style></head><body>" +
    "<h1>Your receipt</h1><script>alert(1)</script>" +
    "<p>Total:&nbsp;<b>$42.50</b></p><!-- hidden --></body></html>";
  const text = stripHtml(html);
  assert.ok(text.includes("Your receipt"));
  assert.ok(text.includes("$42.50"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("hidden"));
});
