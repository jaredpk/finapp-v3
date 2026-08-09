import test from "node:test";
import assert from "node:assert/strict";
import { buildReportSummary } from "../db.js";

// buildReportSummary is the pure half of getReportSummary: it takes the
// per-month × per-category rows the SQL CTE emits —
//   { month: 'YYYY-MM', category_id, name, color, spend, income }
// — and assembles the response shape. The SQL contract these tests encode:
//
// - Exclusions happen in the WHERE clause (mirroring getSpendingByCategory):
//   hidden IS NOT TRUE, status != 'pending', account NOT IN hidden_accounts.
//   An excluded transaction therefore produces NO row at all — modelled here
//   by simply not passing one.
// - A split transaction contributes each split's amount under that split's
//   category instead of its full amount under the assigned category.
// - Split-leftover convention: if the splits don't sum to the transaction
//   total, the leftover stays with the assigned category. This matches the
//   split editor in Transactions.jsx: recalcLine0 keeps line 0 — which is
//   pre-filled with the ASSIGNED category — equal to total minus the other
//   lines, so the remainder is deliberately parked on the assigned category.
//   replaceSplits (db.js) stores rows verbatim with no sum constraint, so the
//   report's CTE re-derives the leftover as (t.amount - SUM(splits)) and
//   attributes it to assignments.category_id.
// - Unassigned, unsplit transactions arrive with category_id/name/color null
//   and land in the "Uncategorized" bucket here.

const row = (month, category_id, name, color, spend, income = 0) => ({
  month, category_id, name, color, spend, income,
});

test("a split transaction counts under its split categories, with the leftover on the assigned category", () => {
  // $100 Costco charge assigned to Shopping, split $60 Groceries + $30 Gas.
  // The CTE emits the two split contributions plus a $10 leftover under the
  // assignment; nothing lands under Shopping beyond that leftover.
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 60),
      row("2026-01", "cat-gas", "Auto - Gas & Fuel", "#f59e0b", 30),
      row("2026-01", "cat-shop", "Shopping", "#6366f1", 10),
    ],
  });
  assert.equal(out.monthly.length, 1);
  assert.equal(out.monthly[0].spend, 100);
  assert.deepEqual(
    out.monthly[0].by_category.map((c) => [c.name, c.amount]),
    [["Groceries", 60], ["Auto - Gas & Fuel", 30], ["Shopping", 10]]
  );
  assert.equal(out.totals.spend, 100);
});

test("hidden, pending, and hidden-account transactions contribute nothing", () => {
  // The SQL excludes them before any row exists, so the assembler sees an
  // empty rowset and must return zeroed months — not crash.
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-02-28",
    rows: [],
  });
  assert.equal(out.monthly.length, 2);
  for (const m of out.monthly) {
    assert.deepEqual(
      { income: m.income, spend: m.spend, net: m.net, by_category: m.by_category },
      { income: 0, spend: 0, net: 0, by_category: [] }
    );
  }
  assert.deepEqual(out.totals, { income: 0, spend: 0, net: 0, by_category: [] });
  assert.deepEqual(out.top_merchants, []);
});

test("unassigned, unsplit transactions land in the Uncategorized bucket", () => {
  const out = buildReportSummary({
    startDate: "2026-03-01",
    endDate: "2026-03-31",
    rows: [row("2026-03", null, null, null, 25.5)],
  });
  assert.deepEqual(out.monthly[0].by_category, [
    { category_id: null, name: "Uncategorized", color: "#6b7280", amount: 25.5 },
  ]);
  assert.equal(out.monthly[0].spend, 25.5);
});

test("income, spend, and net math match hand-computed sums", () => {
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [
      row("2026-01", "cat-inc", "Personal Income", "#0f766e", 0, 8200),
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 812.4),
      row("2026-01", "cat-din", "Dining Out", "#e11d48", 287.85),
      // A refund shows up as income on a spend category; it still counts as inflow.
      row("2026-01", "cat-shop", "Shopping", "#6366f1", 5000, 100),
    ],
  });
  const m = out.monthly[0];
  assert.equal(m.income, 8300);
  assert.equal(m.spend, 6100.25);
  assert.equal(m.net, 2199.75);
  assert.equal(out.totals.income, 8300);
  assert.equal(out.totals.spend, 6100.25);
  assert.equal(out.totals.net, 2199.75);
});

test("transfer categories are excluded from income/spend totals but stay in the by-category list", () => {
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 500),
      row("2026-01", "cat-xfer", "Transfer", "#64748b", 1900, 1900),
    ],
  });
  const m = out.monthly[0];
  assert.equal(m.spend, 500);
  assert.equal(m.income, 0);
  assert.equal(m.net, -500);
  assert.deepEqual(
    m.by_category.map((c) => [c.name, c.amount]),
    [["Transfer", 1900], ["Groceries", 500]]
  );
  assert.equal(out.totals.spend, 500);
});

test("months are bucketed across year boundaries and empty months are filled in", () => {
  const out = buildReportSummary({
    startDate: "2025-11-01",
    endDate: "2026-02-28",
    rows: [
      row("2025-11", "cat-groc", "Groceries", "#22c55e", 100),
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 200),
      // Outside the requested range — must be ignored, not crash.
      row("2026-03", "cat-groc", "Groceries", "#22c55e", 999),
    ],
  });
  assert.deepEqual(out.monthly.map((m) => m.month), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(out.monthly.map((m) => m.spend), [100, 0, 200, 0]);
  assert.equal(out.totals.spend, 300);
});

test("range totals sum each category across months and sort descending", () => {
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-02-28",
    rows: [
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 100),
      row("2026-02", "cat-groc", "Groceries", "#22c55e", 150),
      row("2026-02", "cat-din", "Dining Out", "#e11d48", 300),
    ],
  });
  assert.deepEqual(out.totals.by_category, [
    { category_id: "cat-din", name: "Dining Out", color: "#e11d48", amount: 300 },
    { category_id: "cat-groc", name: "Groceries", color: "#22c55e", amount: 250 },
  ]);
});

test("floating-point sums round to cents", () => {
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 0.1),
      row("2026-01", "cat-groc", "Groceries", "#22c55e", 0.2),
    ],
  });
  assert.equal(out.monthly[0].spend, 0.3);
  assert.equal(out.monthly[0].by_category[0].amount, 0.3);
});

test("top merchants pass through with normalized numbers", () => {
  const out = buildReportSummary({
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    rows: [],
    merchantRows: [
      { merchant: "Costco", amount: 1240.1, count: 9 },
      { merchant: null, amount: "42.50", count: "1" },
    ],
  });
  assert.deepEqual(out.top_merchants, [
    { merchant: "Costco", amount: 1240.1, count: 9 },
    { merchant: "Unknown", amount: 42.5, count: 1 },
  ]);
});

test("the response echoes the requested range", () => {
  const out = buildReportSummary({ startDate: "2026-01-01", endDate: "2026-06-30", rows: [] });
  assert.equal(out.start_date, "2026-01-01");
  assert.equal(out.end_date, "2026-06-30");
  assert.equal(out.monthly.length, 6);
});
