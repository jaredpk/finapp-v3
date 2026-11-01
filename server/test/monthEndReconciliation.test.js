import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthEndReconciliation, buildMonthEndSheetRows, parseMonthEndConfig,
  isValidMonth, previousMonth, monthRange, shareOfCents,
} from "../monthEndReconciliation.js";

const row = (id, date, merchant, category, amount, account = "Chase") => ({
  transaction_id: id, date, merchant, category, account, amount,
});

const MONTH = "2026-10";

test("kids variants match case-insensitively and are totalled with 50% share", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("1", "2026-10-02", "School", "Kids", 100),
      row("2", "2026-10-03", "Dentist", "Kids - Healthcare", 40.5),
      row("3", "2026-10-04", "Pharmacy", "kids healthcare", 10),
      row("4", "2026-10-05", "Doc", "KIDS HEALTH", 20),
      row("5", "2026-10-06", "Grocery", "Groceries", 999),
    ],
  });
  assert.equal(r.kids.rows.length, 4);
  assert.equal(r.kids.subtotal, 170.5);
  assert.equal(r.kids.share, 85.25);
});

test("refunds reduce the kids subtotal", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-02", "Toys", "Kids", 50), row("2", "2026-10-09", "Toys refund", "Kids", -20)],
  });
  assert.equal(r.kids.subtotal, 30);
  assert.equal(r.kids.share, 15);
});

test("50% share rounds half-up to the cent without float drift", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-02", "A", "Kids", 0.1), row("2", "2026-10-02", "B", "Kids", 0.2), row("3", "2026-10-02", "C", "Kids", 0.01)],
  });
  assert.equal(r.kids.subtotal, 0.31);
  assert.equal(r.kids.share, 0.16); // 15.5 cents -> 16
  assert.equal(shareOfCents(1, 0.5), 1);
  assert.equal(shareOfCents(3, 0.5), 2);
  assert.equal(shareOfCents(4, 0.5), 2);
});

test("verizon: gross 74.98, credit 4.44 (2/9 of $20), net 70.54, 50% = 35.27; total due combines both shares", () => {
  const r = buildMonthEndReconciliation({ month: MONTH, rows: [row("1", "2026-10-02", "School", "Kids", 100)] });
  assert.equal(r.verizon.lines, 2);
  assert.equal(r.verizon.line_amount, 37.49);
  assert.equal(r.verizon.gross_total, 74.98);
  assert.equal(r.verizon.account_credit_total, 20);
  assert.equal(r.verizon.account_credit_lines, 9);
  assert.equal(r.verizon.credit_allocated, 4.44);
  assert.equal(r.verizon.net_total, 70.54);
  assert.equal(r.verizon.total, 70.54);
  assert.equal(r.verizon.share, 35.27);
  assert.equal(r.verizon.label, "Verizon: 2 lines x $37.49 (plan + surcharges + taxes/fees) = $74.98");
  assert.equal(r.verizon.credit_label, "Account credit: $20.00 x 2/9 lines = -$4.44");
  assert.equal(r.total_due, 85.27);
});

test("verizon defaults (no config) give gross 74.98, credit 4.44, net 70.54, share 35.27", () => {
  const r = buildMonthEndReconciliation({ month: MONTH, rows: [] });
  assert.equal(r.verizon.gross_total, 74.98);
  assert.equal(r.verizon.credit_allocated, 4.44);
  assert.equal(r.verizon.net_total, 70.54);
  assert.equal(r.verizon.share, 35.27);
  assert.equal(r.total_due, 35.27);
});

test("verizonAccountCredit=0 disables the credit", () => {
  const r = buildMonthEndReconciliation({ month: MONTH, rows: [], config: { verizonAccountCredit: 0 } });
  assert.equal(r.verizon.credit_allocated, 0);
  assert.equal(r.verizon.gross_total, 74.98);
  assert.equal(r.verizon.net_total, 74.98);
  assert.equal(r.verizon.total, 74.98);
  assert.equal(r.verizon.share, 37.49);
  assert.equal(r.total_due, 37.49);
});

test("verizon config overrides; credit allocation rounds half-up on the aggregate", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH, rows: [], config: { verizonLines: 3, verizonLineAmount: 25.5 },
  });
  assert.equal(r.verizon.gross_total, 76.5);
  assert.equal(r.verizon.credit_allocated, 6.67); // 2000 * 3 / 9 = 666.67 cents
  assert.equal(r.verizon.net_total, 69.83);
  assert.equal(r.verizon.share, 34.92); // 3491.5 cents -> 3492
  assert.equal(r.total_due, 34.92);
  const half = buildMonthEndReconciliation({
    month: MONTH, rows: [], config: { verizonLines: 1, verizonAccountLines: 4, verizonAccountCredit: 0.1 },
  });
  assert.equal(half.verizon.credit_allocated, 0.03); // 10 / 4 = 2.5 cents -> 3
});

test("review lists: uncategorized and health-related only, excluded from totals and kids", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("1", "2026-10-02", "Mystery", null, 12),
      row("2", "2026-10-03", "Blank", "", 5),
      row("3", "2026-10-04", "Clinic", "Health", 80),
      row("4", "2026-10-05", "Kid clinic", "Kids - Healthcare", 60),
      row("6", "2026-10-06", "Gym", "Healthcare", 9),
    ],
  });
  assert.deepEqual(r.review.uncategorized.map((x) => x.transaction_id), ["1", "2"]);
  assert.deepEqual(r.review.health.map((x) => x.transaction_id), ["3", "6"]);
  assert.equal(r.kids.rows.length, 1);
  assert.equal(r.kids.subtotal, 60);
  assert.equal(r.total_due, 65.27);
});

test("empty month yields zeros plus the Verizon share", () => {
  const r = buildMonthEndReconciliation({ month: MONTH, rows: [] });
  assert.equal(r.kids.subtotal, 0);
  assert.equal(r.kids.share, 0);
  assert.deepEqual(r.review, { uncategorized: [], health: [] });
  assert.equal(r.total_due, 35.27);
});

test("sheet rows are stacked in the requested order", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-02", "School", "Kids", 100), row("2", "2026-10-03", "X", null, 1)],
  });
  const flat = buildMonthEndSheetRows(r).map((x) => String(x[0] ?? "") + "|" + String(x[3] ?? ""));
  const idx = (s) => flat.findIndex((l) => l.includes(s));
  assert.ok(idx("KIDS") < idx("VERIZON ALLOCATION"));
  assert.ok(idx("VERIZON ALLOCATION") < idx("TOTAL DUE"));
  assert.ok(idx("TOTAL DUE") < idx("REVIEW - UNCATEGORIZED"));
  assert.ok(idx("REVIEW - UNCATEGORIZED") < idx("REVIEW - HEALTH"));
});

test("sheet VERIZON ALLOCATION: gross, negative credit, net, then 50% share", () => {
  const r = buildMonthEndReconciliation({ month: MONTH, rows: [] });
  const rows = buildMonthEndSheetRows(r);
  const start = rows.findIndex((x) => x[0] === "VERIZON ALLOCATION");
  assert.deepEqual(rows.slice(start + 1, start + 5), [
    [r.verizon.label, "", "", "", 74.98],
    ["Account credit: $20.00 x 2/9 lines = -$4.44", "", "", "", -4.44],
    ["", "", "", "Net Verizon", 70.54],
    ["", "", "", "50% share", 35.27],
  ]);
});

test("month and config validation helpers", () => {
  assert.ok(isValidMonth("2026-10"));
  assert.ok(!isValidMonth("2026-13"));
  assert.ok(!isValidMonth("2026-1"));
  assert.ok(!isValidMonth("2026-10-01"));
  assert.equal(previousMonth(new Date("2026-01-15T00:00:00Z")), "2025-12");
  assert.deepEqual(monthRange("2024-02"), { startDate: "2024-02-01", endDate: "2024-02-29" });
  assert.deepEqual(parseMonthEndConfig({}), { config: {} });
  assert.deepEqual(parseMonthEndConfig({ verizonLines: "3", verizonLineAmount: "29.99" }), {
    config: { verizonLines: 3, verizonLineAmount: 29.99 },
  });
  assert.ok(parseMonthEndConfig({ verizonLines: "-1" }).error);
  assert.ok(parseMonthEndConfig({ verizonLineAmount: "abc" }).error);
  assert.deepEqual(parseMonthEndConfig({ verizonAccountCredit: "0", verizonAccountLines: "12" }), {
    config: { verizonAccountCredit: 0, verizonAccountLines: 12 },
  });
  assert.deepEqual(parseMonthEndConfig({ verizonAccountCredit: "15.5" }), { config: { verizonAccountCredit: 15.5 } });
  assert.ok(parseMonthEndConfig({ verizonAccountCredit: "-1" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountCredit: "1.234" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountCredit: "abc" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountLines: "0" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountLines: "1000" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountLines: "2.5" }).error);
  assert.ok(parseMonthEndConfig({ verizonAccountLines: "abc" }).error);
  // account lines must be >= our lines (defaults 2 and 9 when omitted)
  assert.ok(parseMonthEndConfig({ verizonAccountLines: "1" }).error);
  assert.ok(parseMonthEndConfig({ verizonLines: "10" }).error);
  assert.ok(parseMonthEndConfig({ verizonLines: "5", verizonAccountLines: "4" }).error);
  assert.deepEqual(parseMonthEndConfig({ verizonLines: "5", verizonAccountLines: "5" }), {
    config: { verizonLines: 5, verizonAccountLines: 5 },
  });
});

import { isKidsCategory as _isKids, isHealthCategory as _isHealth } from "../monthEndReconciliation.js";
import test2 from "node:test";
import assert2 from "node:assert/strict";
test2("kids matches 'Healthcare - Kids'; health review excludes kids", () => {
  assert2.ok(_isKids("Healthcare - Kids"));
  assert2.ok(_isKids("Kids - Healthcare"));
  assert2.ok(!_isKids("Health"));
  assert2.ok(_isHealth("Health"));
  assert2.ok(_isHealth("Medical"));
  assert2.ok(!_isHealth("Healthcare - Kids"));
});
