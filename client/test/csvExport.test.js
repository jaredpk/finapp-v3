import test from "node:test";
import assert from "node:assert/strict";
import {
  csvCell, buildCsv, transactionCsvRows, csvFilename, CSV_HEADERS,
} from "../src/csvExport.js";

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("csvCell guards strings that a spreadsheet would read as a formula", () => {
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("+1-800-FLOWERS"), "'+1-800-FLOWERS");
  assert.equal(csvCell("@merchant"), "'@merchant");
  assert.equal(csvCell("-CHASE REFUND"), "'-CHASE REFUND");
});

test("csvCell leaves numbers alone so amounts still sum", () => {
  // The guard must not reach negative amounts: '-42.5 imports as text and
  // silently breaks every SUM over the column.
  assert.equal(csvCell(-42.5), "-42.5");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(12.34), "12.34");
  assert.equal(csvCell(NaN), "");
});

test("buildCsv writes a header row and CRLF line endings", () => {
  assert.equal(buildCsv(["A", "B"], [[1, "x"], [2, "y,z"]]), 'A,B\r\n1,x\r\n2,"y,z"\r\n');
});

const categoryNames = { c1: "Groceries", c2: "Dining" };
const accountNames = { a1: "Amex Gold" };

test("one row per transaction, with the assigned category name", () => {
  const rows = transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", merchant_name: "Costco", account_id: "a1", amount: 84.2, reviewed_at: "2026-03-02" }],
    accountNames,
    categoryNames,
    assignments: { t1: "c1" },
  });
  assert.deepEqual(rows, [["2026-03-01", "Costco", "Amex Gold", 84.2, "Groceries", "", "", "Approved", "t1"]]);
  assert.equal(rows[0].length, CSV_HEADERS.length);
});

test("merchant overrides win over the feed name", () => {
  const [row] = transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", merchant_name: "SQ *COFFEE 4421", account_id: "a1", amount: 5 }],
    accountNames,
    merchantOverrides: { t1: "Blue Bottle" },
  });
  assert.equal(row[1], "Blue Bottle");
});

test("a split transaction expands to one row per split line and still sums to the total", () => {
  const rows = transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", merchant_name: "Target", account_id: "a1", amount: 100, reviewed_at: null }],
    accountNames,
    categoryNames,
    splits: { t1: [
      { id: "s1", category_id: "c1", category_name: "Groceries", amount: 60, note: "food" },
      { id: "s2", category_id: "c2", category_name: "Dining", amount: 40, note: null },
    ] },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ["2026-03-01", "Target", "Amex Gold", 60, "Groceries", "1 of 2", "food", "Awaiting approval", "t1"]);
  assert.deepEqual(rows[1], ["2026-03-01", "Target", "Amex Gold", 40, "Dining", "2 of 2", "", "Awaiting approval", "t1"]);
  assert.equal(rows.reduce((n, r) => n + r[3], 0), 100);
});

test("split rows inherit the parent's sign, so a split refund stays a refund", () => {
  const rows = transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", merchant_name: "Target", account_id: "a1", amount: -50 }],
    splits: { t1: [{ id: "s1", category_name: "Groceries", amount: 30 }, { id: "s2", category_name: "Dining", amount: 20 }] },
  });
  assert.deepEqual(rows.map((r) => r[3]), [-30, -20]);
  assert.equal(rows.reduce((n, r) => n + r[3], 0), -50);
});

test("status reflects hidden, pending and approval state", () => {
  const base = { date: "2026-03-01", merchant_name: "X", account_id: "a1", amount: 1 };
  const status = (t) => transactionCsvRows({ transactions: [{ ...base, ...t }] })[0][7];
  assert.equal(status({ transaction_id: "1", hidden: true, reviewed_at: "2026-03-02" }), "Hidden");
  assert.equal(status({ transaction_id: "2", pending: true }), "Pending");
  assert.equal(status({ transaction_id: "3", reviewed_at: null }), "Awaiting approval");
  assert.equal(status({ transaction_id: "4", reviewed_at: "2026-03-02" }), "Approved");
});

test("unnamed transactions fall back the same way the table does", () => {
  const [row] = transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", amount: 1, suggested_category: "Travel" }],
  });
  assert.equal(row[1], "Travel");
  assert.equal(row[2], "");
  assert.equal(row[4], "");
});

test("filename records the date range, the category and the partial flag", () => {
  assert.equal(
    csvFilename({ from: "2026-01-01", to: "2026-04-01", categoryLabel: "Dining Out", generatedOn: "2026-09-02" }),
    "finapp-transactions-2026-01-01_to_2026-04-01-dining-out-2026-09-02.csv",
  );
  assert.equal(csvFilename({ generatedOn: "2026-09-02" }), "finapp-transactions-2026-09-02.csv");
  assert.equal(csvFilename({ from: "2026-01-01", generatedOn: "2026-09-02" }), "finapp-transactions-from-2026-01-01-2026-09-02.csv");
  assert.equal(csvFilename({ to: "2026-01-01", generatedOn: "2026-09-02" }), "finapp-transactions-to-2026-01-01-2026-09-02.csv");
  assert.equal(
    csvFilename({ generatedOn: "2026-09-02", partial: true }),
    "finapp-transactions-2026-09-02-partial.csv",
  );
});

test("a full export round-trips through buildCsv with the header intact", () => {
  const csv = buildCsv(CSV_HEADERS, transactionCsvRows({
    transactions: [{ transaction_id: "t1", date: "2026-03-01", merchant_name: 'Bob"s, Diner', account_id: "a1", amount: -12.5, reviewed_at: "x" }],
    accountNames,
  }));
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "Date,Merchant,Account,Amount (USD),Category,Split Line,Note,Status,Transaction ID");
  assert.equal(lines[1], '2026-03-01,"Bob""s, Diner",Amex Gold,-12.5,,,,Approved,t1');
});
