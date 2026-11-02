import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthEndReconciliation, buildMonthEndWorkbookSheets, parseMonthEndConfig,
  isValidMonth, previousMonth, monthRange, shareOfCents, isPersonalJaredCategory,
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

const HDR = ["Date", "Merchant", "Category", "Account", "Amount"];
const sheetsOf = (r) => buildMonthEndWorkbookSheets(r);
const byName = (r) => Object.fromEntries(sheetsOf(r).map((s) => [s.name, s.rows]));

test("workbook has three tabs in order with valid Excel names", () => {
  const sheets = sheetsOf(buildMonthEndReconciliation({ month: MONTH, rows: [] }));
  assert.deepEqual(sheets.map((s) => s.name), ["Kids to split", "Personal - Jared", "To review"]);
  for (const s of sheets) {
    assert.ok(s.name.length <= 31);
    assert.ok(!/[:\\/?*\[\]]/.test(s.name));
  }
});

test("tab 1 'Kids to split': kids, verizon, total due; positions match the old sheet's first part", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-02", "School", "Kids", 100), row("2", "2026-10-03", "X", null, 1)],
  });
  const rows = sheetsOf(r)[0].rows;
  assert.deepEqual(rows, [
    ["Health Equity for October 2026 not imported"],
    [],
    ["KIDS (Kids and Kids health) - 2026-10"],
    HDR,
    ["2026-10-02", "School", "Kids", "Chase", 100],
    ["", "", "", "Subtotal", 100],
    ["", "", "", "50% share", 50],
    [],
    ["VERIZON ALLOCATION"],
    ["Verizon: 2 lines x $37.49 (plan + surcharges + taxes/fees) = $74.98", "", "", "", 74.98],
    ["Account credit: $20.00 x 2/9 lines = -$4.44", "", "", "", -4.44],
    ["", "", "", "Net Verizon", 70.54],
    ["", "", "", "50% share", 35.27],
    [],
    ["", "", "", "TOTAL DUE", 85.27],
  ]);
});

test("tab 2 'Personal - Jared': title, header, rows, Subtotal; no share row", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-02", "School", "Kids", 100), row("2", "2026-10-03", "Gift", "Personal - Jared", 12.5)],
  });
  const rows = sheetsOf(r)[1].rows;
  assert.deepEqual(rows, [
    [PJ_TITLE],
    HDR,
    ["2026-10-03", "Gift", "Personal - Jared", "Chase", 12.5],
    ["", "", "", "Subtotal", 12.5],
  ]);
  assert.equal(rows.filter((x) => String(x[3]).includes("share")).length, 0);
});

test("tab 3 'To review': note, blank, uncategorized then health sections", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [row("1", "2026-10-03", "Mystery", null, 12), row("2", "2026-10-04", "Clinic", "Health", 80)],
  });
  assert.deepEqual(sheetsOf(r)[2].rows, [
    ["Transactions to check for missed kids items — not included in any total"],
    [],
    ["REVIEW - UNCATEGORIZED (not included in totals)"],
    HDR,
    ["2026-10-03", "Mystery", "", "Chase", 12],
    [],
    ["REVIEW - HEALTH (not included in totals)"],
    HDR,
    ["2026-10-04", "Clinic", "Health", "Chase", 80],
  ]);
});

test("empty month: each tab renders its titles/headers and zero subtotal", () => {
  const t = byName(buildMonthEndReconciliation({ month: "2026-10", rows: [{ ...row("h", "2026-10-01", "HE", "Medical", 1, "HealthEquity HSA") }] }));
  const e = byName(buildMonthEndReconciliation({ month: MONTH, rows: [] }));
  assert.deepEqual(e["Kids to split"].slice(0, 5), [
    ["Health Equity for October 2026 not imported"], [], ["KIDS (Kids and Kids health) - 2026-10"], HDR,
    ["", "", "", "Subtotal", 0],
  ]);
  assert.deepEqual(e["Personal - Jared"], [[PJ_TITLE], HDR, ["", "", "", "Subtotal", 0]]);
  assert.deepEqual(e["To review"], [
    ["Transactions to check for missed kids items — not included in any total"], [],
    ["REVIEW - UNCATEGORIZED (not included in totals)"], HDR, [],
    ["REVIEW - HEALTH (not included in totals)"], HDR,
  ]);
  assert.ok(t["Kids to split"]);
});

test("banner appears only on tab 1 and only when HealthEquity is not imported", () => {
  const banner = "Health Equity for October 2026 not imported";
  const missing = byName(buildMonthEndReconciliation({ month: MONTH, rows: [KIDS_ROW] }));
  assert.deepEqual(missing["Kids to split"][0], [banner]);
  assert.deepEqual(missing["Kids to split"][1], []);
  assert.deepEqual(missing["Kids to split"][2], ["KIDS (Kids and Kids health) - 2026-10"]);
  for (const n of ["Personal - Jared", "To review"]) {
    assert.ok(!missing[n].some((x) => x[0] === banner));
  }
  const present = byName(
    buildMonthEndReconciliation({ month: MONTH, rows: [KIDS_ROW, row("2", "2026-10-04", "P", "", 1, "Health Equity")] })
  );
  assert.deepEqual(present["Kids to split"][0], ["KIDS (Kids and Kids health) - 2026-10"]);
  for (const s of Object.values(present)) assert.ok(!s.some((x) => x[0] === banner));
});

test("no row appears on two tabs", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("1", "2026-10-02", "School", "Kids", 100),
      row("2", "2026-10-03", "Gift", "Personal - Jared", 12.5),
      row("3", "2026-10-04", "Mystery", null, 12),
      row("4", "2026-10-05", "Clinic", "Health", 80),
    ],
  });
  const [k, p, rv] = sheetsOf(r).map((s) => s.rows.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x[0])).map((x) => JSON.stringify(x)));
  assert.equal(k.length, 1);
  assert.equal(p.length, 1);
  assert.equal(rv.length, 2);
  const all = [...k, ...p, ...rv];
  assert.equal(new Set(all).size, all.length);
});

test("HealthEquity HSA kids row lands on tab 1 only; same row uncategorized lands on tab 3 only", () => {
  const he = (category) => row("he1", "2026-10-28", "Meadowbrook Counseling", category, 135, "HealthEquity HSA");
  const line = (category) => ["2026-10-28", "Meadowbrook Counseling", category, "HealthEquity HSA", 135];
  const has = (rows, l) => rows.some((x) => JSON.stringify(x) === JSON.stringify(l));

  const kids = byName(buildMonthEndReconciliation({ month: MONTH, rows: [he("Kids - Healthcare")] }));
  assert.ok(has(kids["Kids to split"], line("Kids - Healthcare")));
  assert.ok(!has(kids["To review"], line("Kids - Healthcare")));
  assert.ok(!has(kids["Personal - Jared"], line("Kids - Healthcare")));

  const unc = byName(buildMonthEndReconciliation({ month: MONTH, rows: [he("")] }));
  assert.ok(has(unc["To review"], line("")));
  assert.ok(!has(unc["Kids to split"], line("")));
  assert.ok(!has(unc["Personal - Jared"], line("")));
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

// ── HealthEquity import banner ───────────────────────────────────────────────
const KIDS_ROW = row("1", "2026-10-02", "School", "Kids", 100);

test("health equity: no rows -> not imported, exact banner for 2026-10", () => {
  const r = buildMonthEndReconciliation({ month: "2026-10", rows: [] });
  assert.deepEqual(r.health_equity, {
    imported: false,
    row_count: 0,
    banner: "Health Equity for October 2026 not imported",
  });
});

test("health equity: only non-HE rows -> not imported; banner for 2026-01 is January 2026", () => {
  const r = buildMonthEndReconciliation({ month: "2026-01", rows: [KIDS_ROW, row("2", "2026-01-03", "Shop", "", 5, "Health Savings")] });
  assert.deepEqual(r.health_equity, {
    imported: false,
    row_count: 0,
    banner: "Health Equity for January 2026 not imported",
  });
});

test("health equity: imported via nickname-style label, uncategorized included", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [KIDS_ROW, row("2", "2026-10-04", "Pharmacy", "", 12.5, "HealthEquity HSA")],
  });
  assert.deepEqual(r.health_equity, { imported: true, row_count: 1, banner: null });
});

test("health equity: imported via raw account string when nickname does not match", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [{ ...row("2", "2026-10-04", "Dentist", "Medical", 30, "My HSA"), account_raw: "acct_Health Equity_1234" }],
  });
  assert.deepEqual(r.health_equity, { imported: true, row_count: 1, banner: null });
});

test("health equity: case and spacing variants all match", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("1", "2026-10-02", "A", "Medical", 1, "HEALTHEQUITY HSA"),
      row("2", "2026-10-03", "B", "Medical", 1, "Health Equity"),
      row("3", "2026-10-04", "C", "Medical", 1, "health   equity"),
      row("4", "2026-10-05", "D", "Medical", 1, "Chase"),
    ],
  });
  assert.equal(r.health_equity.imported, true);
  assert.equal(r.health_equity.row_count, 3);
  assert.equal(r.health_equity.banner, null);
});

test("health equity: pending and hidden rows do not count (SQL also excludes them)", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      { ...row("1", "2026-10-02", "A", "Medical", 1, "Health Equity"), pending: true },
      { ...row("2", "2026-10-03", "B", "Medical", 1, "Health Equity"), hidden: true },
      { ...row("3", "2026-10-04", "C", "Medical", 1, "Health Equity"), status: "pending" },
    ],
  });
  assert.deepEqual(r.health_equity, {
    imported: false,
    row_count: 0,
    banner: "Health Equity for October 2026 not imported",
  });
});

test("health equity: totals are unchanged by the check", () => {
  const without = buildMonthEndReconciliation({ month: MONTH, rows: [KIDS_ROW] });
  const withHe = buildMonthEndReconciliation({
    month: MONTH,
    rows: [KIDS_ROW, row("2", "2026-10-04", "Pharmacy", "", 12.5, "Health Equity")],
  });
  assert.equal(without.kids.subtotal, 100);
  assert.equal(without.kids.share, 50);
  assert.equal(without.total_due, 85.27);
  assert.equal(withHe.kids.subtotal, 100);
  assert.equal(withHe.kids.share, 50);
  assert.equal(withHe.total_due, 85.27);
});

const PJ_TITLE = "PERSONAL - JARED (listed only - not included in total due)";

test("personal jared: matches case-insensitively with trim; near-misses do not match", () => {
  for (const n of ["Personal - Jared", "personal - jared", " Personal - Jared "]) {
    assert.equal(isPersonalJaredCategory(n), true, n);
  }
  for (const n of ["Personal - Alta", "Personal Income", "Personal - Jared Savings", "", null]) {
    assert.equal(isPersonalJaredCategory(n), false, String(n));
  }
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("1", "2026-10-02", "A", "personal - jared", 10),
      row("2", "2026-10-03", "B", " Personal - Jared ", 5),
      row("3", "2026-10-04", "C", "Personal - Alta", 7),
      row("4", "2026-10-05", "D", "Personal Income", 8),
      row("5", "2026-10-06", "E", "Personal - Jared Savings", 9),
    ],
  });
  assert.deepEqual(r.personal_jared.rows.map((x) => x.transaction_id), ["1", "2"]);
  assert.equal(r.personal_jared.subtotal, 15);
});

test("personal jared: refund reduces subtotal; rows sorted by date; empty is rows [] subtotal 0", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("2", "2026-10-09", "Refund", "Personal - Jared", -20.25),
      row("1", "2026-10-02", "Shop", "Personal - Jared", 50.5),
    ],
  });
  assert.deepEqual(r.personal_jared.rows.map((x) => x.date), ["2026-10-02", "2026-10-09"]);
  assert.equal(r.personal_jared.subtotal, 30.25);
  const e = buildMonthEndReconciliation({ month: MONTH, rows: [] });
  assert.deepEqual(e.personal_jared, { rows: [], subtotal: 0 });
});

test("personal jared: kids, verizon, total_due and review lists unchanged by its rows", () => {
  const base = [
    row("1", "2026-10-02", "School", "Kids", 100),
    row("2", "2026-10-03", "Mystery", "", 4),
    row("3", "2026-10-04", "Clinic", "Medical", 6),
  ];
  const pj = [row("9", "2026-10-05", "Gift", "Personal - Jared", 77), row("10", "2026-10-06", "Back", "Personal - Jared", -7)];
  const a = buildMonthEndReconciliation({ month: MONTH, rows: base });
  const b = buildMonthEndReconciliation({ month: MONTH, rows: [...base, ...pj] });
  assert.deepEqual(b.kids, a.kids);
  assert.deepEqual(b.verizon, a.verizon);
  assert.equal(b.total_due, a.total_due);
  assert.equal(b.total_due, 85.27);
  assert.deepEqual(b.review, a.review);
  assert.equal(b.review.uncategorized.length, 1);
  assert.equal(b.review.health.length, 1);
  assert.equal(b.personal_jared.subtotal, 70);
});

test("personal jared: a split line categorized Personal - Jared appears by category", () => {
  const r = buildMonthEndReconciliation({
    month: MONTH,
    rows: [
      row("t1", "2026-10-04", "Target", "Kids", 30),
      row("t1", "2026-10-04", "Target", "Personal - Jared", 20),
    ],
  });
  assert.equal(r.personal_jared.rows.length, 1);
  assert.equal(r.personal_jared.rows[0].transaction_id, "t1");
  assert.equal(r.personal_jared.rows[0].amount, 20);
  assert.equal(r.personal_jared.subtotal, 20);
  assert.equal(r.kids.subtotal, 30);
});
