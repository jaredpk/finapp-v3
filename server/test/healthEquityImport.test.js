import test from "node:test";
import assert from "node:assert/strict";
import xlsxLib from "xlsx";
import {
  parseHealthEquityFile, buildHealthEquityPreview, parseMoneyToCents, parseHeDate,
  planHealthEquityImport, normalizeDescription,
  HealthEquityParseError,
} from "../healthEquityImport.js";

// SYNTHETIC data only (fake merchants and amounts) mimicking the structure of a
// HealthEquity "Completed Transactions" export: an HTML table saved as .xls.
const td = (v) => `<td nowrap style="vertical-align: middle" class="text">${v}</td>`;
const tr = (cells) => `<tr>${cells.map(td).join("")}<td></td></tr>`;
const HEADER = `<tr><td nowrap filter='All'><b>Date</b></td><td nowrap filter='All'><b>Transaction</b></td><td nowrap filter='All'><b>Amount</b></td><td nowrap filter='All'><b>HSA Cash Balance</b></td><td nowrap filter='All'><b>Attachments</b></td></tr>`;
const wrap = (body, header = HEADER) =>
  `<style> .text { mso-number-format:\\@; } </style> <table><tr><td colspan=9 style='font-size:99pt;'><center><b>Completed Transactions</b></center></td></tr>${header}${body}</table>`;

const FIXTURE = wrap([
  tr(["12/31/2026", "Employee Contribution (Tax year: 2026) (Tax year: 2026)", "$300.00", "$1,337.60", ""]),
  tr(["10/30/2026", "Acme Dental, Www.Acme, UT (Card Transaction ID: abc1234)", "($1,135.50)", "$37.60", ""]),
  tr(["1/9/2026", "Employer Contribution (Tax year: 2026)", "$100.00", "$1,173.10", ""]),
  tr(["7/31/2026", "Interest for Jul-26", "$0.03", "$1,173.13", ""]),
  tr(["2/3/2026", "Fake Pharmacy &amp; Co, 555-0100, CO (Card Transaction ID: zzz9999)", "$20.00", "$1,193.13", ""]),
  tr(["1/1/2026", "Balance Forward", "$0.00", "$1,000.00", ""]),
  tr(["13/45/2026", "Bad Date Shop, XX", "($5.00)", "$1.00", ""]),
  tr(["3/3/2026", "Bad Amount Shop, XX", "n/a", "$1.00", ""]),
].join(""));

test("parses an HTML-table .xls with a title row, from string and Buffer", () => {
  for (const input of [FIXTURE, Buffer.from(FIXTURE)]) {
    const { rows, skipped } = parseHealthEquityFile(input);
    assert.equal(rows.length, 5);
    assert.equal(skipped.length, 3);
  }
});

test("headers are located by name, case-insensitively and in any order", () => {
  const header = `<tr><td>ATTACHMENTS</td><td>hsa cash balance</td><td>AMOUNT</td><td>transaction</td><td>Date</td></tr>`;
  const html = wrap(`<tr><td></td><td>$5.00</td><td>($2.00)</td><td>Some Shop, UT</td><td>3/4/2026</td></tr>`, header);
  const { rows } = parseHealthEquityFile(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-03-04");
  assert.equal(rows[0].amountDb, 2);
  assert.equal(rows[0].balance, 5);
});

test("money parsing: $, commas, parentheses, minus", () => {
  assert.equal(parseMoneyToCents("$298.08"), 29808);
  assert.equal(parseMoneyToCents("($135.00)"), -13500);
  assert.equal(parseMoneyToCents("$1,037.60"), 103760);
  assert.equal(parseMoneyToCents("($1,037.60)"), -103760);
  assert.equal(parseMoneyToCents("-$5.00"), -500);
  assert.equal(parseMoneyToCents("0.1"), 10);
  assert.equal(parseMoneyToCents("abc"), null);
  assert.equal(parseMoneyToCents(""), null);
});

test("sign is flipped: file out (parentheses) is positive in the app, file in is negative", () => {
  const { rows } = parseHealthEquityFile(FIXTURE);
  const byDesc = (s) => rows.find((r) => r.description.startsWith(s));
  assert.equal(byDesc("Acme Dental").amountDb, 1135.5);
  assert.equal(byDesc("Employee Contribution").amountDb, -300);
  assert.equal(byDesc("Fake Pharmacy").amountDb, -20); // refund
  assert.equal(byDesc("Interest").amountDb, -0.03);
  assert.equal(byDesc("Employee Contribution").balance, 1337.6);
});

test("dates are built from the string with no timezone shift", () => {
  for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      assert.equal(parseHeDate("1/9/2026"), "2026-01-09");
      assert.equal(parseHeDate("10/30/2026"), "2026-10-30");
      assert.equal(parseHeDate("12/31/2026"), "2026-12-31");
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  }
  assert.equal(parseHeDate("2/29/2026"), null);
  assert.equal(parseHeDate("2/29/2028"), "2028-02-29");
  assert.equal(parseHeDate("garbage"), null);
});

test("Balance Forward and unparsable rows are skipped with reasons", () => {
  const { rows, skipped } = parseHealthEquityFile(FIXTURE);
  assert.ok(!rows.some((r) => /balance forward/i.test(r.description)));
  const reasons = skipped.map((s) => s.reason);
  assert.ok(reasons.some((r) => /^Balance Forward/.test(r)));
  assert.ok(reasons.includes("unparseable date"));
  assert.ok(reasons.includes("unparseable amount"));
  assert.ok(skipped.every((s) => s.reason));
});

test("missing headers are rejected with a clear error", () => {
  const html = wrap(tr(["1/1/2026", "x", "$1.00", "$1.00", ""]), `<tr><td>Date</td><td>Memo</td><td>Amount</td></tr>`);
  assert.throws(() => parseHealthEquityFile(html), (e) => e instanceof HealthEquityParseError && /header/i.test(e.message));
  assert.throws(() => parseHealthEquityFile(""), HealthEquityParseError);
  assert.throws(() => parseHealthEquityFile(Buffer.from("just some text\nnothing here")), HealthEquityParseError);
});

test("kinds and merchant cleanup", () => {
  const { rows } = parseHealthEquityFile(FIXTURE);
  const m = Object.fromEntries(rows.map((r) => [r.description.split(" ")[0], r]));
  assert.deepEqual([m.Employee.kind, m.Employee.merchant], ["contribution", "Employee Contribution"]);
  assert.deepEqual([m.Employer.kind, m.Employer.merchant], ["contribution", "Employer Contribution"]);
  assert.deepEqual([m.Interest.kind, m.Interest.merchant], ["interest", "Interest"]);
  assert.deepEqual([m.Acme.kind, m.Acme.merchant], ["card", "Acme Dental"]);
  assert.equal(m.Fake.merchant, "Fake Pharmacy & Co"); // entity decoded, cut at first comma
});

// ── planHealthEquityImport ───────────────────────────────────────────────────
// file(): newest-first list of [date, description, fileAmount, balance] -> parsed rows.
const file = (list) => parseHealthEquityFile(wrap(list.map((c) => tr([...c, ""])).join(""))).rows;
// Simulates what is stored after importing: arbitrary (old-scheme) ids, app sign.
const stored = (rows) => rows.map((r, i) => ({ id: `csv_he_old${i}`, date: r.date, original_description: r.description, amount: r.amountDb }));
const plan = (rows, existing = []) => planHealthEquityImport(rows, existing);

const YTD = [
  ["10/15/2026", "Employee Contribution (Tax year: 2026)", "$300.00", "$900.00"],
  ["10/10/2026", "Acme Dental, UT (Card Transaction ID: c3)", "($50.00)", "$600.00"],
  ["9/15/2026", "Employee Contribution (Tax year: 2026)", "$300.00", "$650.00"],
  ["9/1/2026", "Interest for Aug-26", "$0.10", "$350.00"],
  ["8/20/2026", "Acme Dental, UT (Card Transaction ID: c2)", "($25.00)", "$349.90"],
  ["8/15/2026", "Employee Contribution (Tax year: 2026)", "$300.00", "$374.90"],
];

test("normalizeDescription strips case, whitespace, Pending tag and Tax year groups", () => {
  assert.equal(normalizeDescription("  Employee   Contribution (Tax year: 2026) (Tax year: 2026) "), "employee contribution");
  assert.equal(normalizeDescription("Pending - Employee Contribution"), "employee contribution");
  assert.equal(normalizeDescription("PENDING: Interest for Jul-26."), "interest for jul-26");
  assert.equal(normalizeDescription("Interest for  Jul-26"), "interest for jul-26");
});

test("identical file => 0 new; first import => all new with unique prefixed ids", () => {
  const rows = file(YTD);
  const first = plan(rows);
  assert.equal(first.newRows.length, 6);
  assert.equal(first.alreadyImported.length, 0);
  assert.equal(first.backdatedNew, 0);
  assert.ok(first.newRows.every((r) => /^csv_he_[0-9a-f]{16}$/.test(r.id)));
  assert.equal(new Set(first.newRows.map((r) => r.id)).size, 6);
  const again = plan(rows, stored(rows));
  assert.equal(again.newRows.length, 0);
  assert.equal(again.alreadyImported.length, 6);
});

test("next-month YTD: exactly the new rows on top are new", () => {
  const old = file(YTD);
  const next = file([
    ["11/15/2026", "Employee Contribution (Tax year: 2026)", "$300.00", "$1,150.00"],
    ["11/2/2026", "Acme Dental, UT (Card Transaction ID: c4)", "($50.00)", "$850.00"],
    ["10/31/2026", "Interest for Oct-26", "$0.12", "$900.12"],
    ...YTD,
  ]);
  const p = plan(next, stored(old));
  assert.equal(p.newRows.length, 3);
  assert.deepEqual(p.newRows.map((r) => r.date), ["2026-11-15", "2026-11-02", "2026-10-31"]);
  assert.equal(p.alreadyImported.length, 6);
  assert.equal(p.backdatedNew, 0);
});

test("back-dated row mid-history shifts later balances but only 1 row is new", () => {
  const old = file(YTD);
  // Same history, plus a back-dated 9/10 contribution; every later (newer) balance shifts by 75.
  const shifted = YTD.map((c, i) => (i < 4 ? [c[0], c[1], c[2], `$${(Number(c[3].slice(1)) + 75).toFixed(2)}`] : c));
  const next = file([
    shifted[0], shifted[1], shifted[2],
    ["9/10/2026", "Employer Contribution (Tax year: 2026)", "$75.00", "$425.00"],
    shifted[3], shifted[4], shifted[5],
  ]);
  const p = plan(next, stored(old));
  assert.equal(p.newRows.length, 1);
  assert.equal(p.newRows[0].description, "Employer Contribution (Tax year: 2026)");
  assert.equal(p.alreadyImported.length, 6);
  assert.equal(p.backdatedNew, 1);
});

test("ids are stable across runs and independent of the running balance", () => {
  const a = plan(file(YTD)).newRows.map((r) => r.id);
  const b = plan(file(YTD.map((c) => [c[0], c[1], c[2], "$1.00"]))).newRows.map((r) => r.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, plan(file(YTD)).newRows.map((r) => r.id));
  // Card ids depend only on the Card Transaction ID.
  const card = (date, desc) => plan(file([[date, desc, "($5.00)", "$1.00"]])).newRows[0].id;
  assert.equal(card("3/3/2026", "Shop A (Card Transaction ID: ABC1)"), card("3/4/2026", "pending - SHOP A (card transaction id: abc1)"));
  // None equal an old balance-based id shape input; v2 hash input differs by construction.
  assert.match(a[0], /^csv_he_[0-9a-f]{16}$/);
});

test("old-scheme ids in storage are matched by count, not by id", () => {
  const rows = file(YTD);
  const existing = stored(rows).map((e, i) => ({ ...e, id: `csv_he_legacy${i}_2` }));
  assert.equal(plan(rows, existing).newRows.length, 0);
});

test("description rewording does not duplicate non-card rows", () => {
  const rows = file(YTD);
  const reworded = file([
    ["10/15/2026", "EMPLOYEE CONTRIBUTION", "$300.00", "$1.00"],
    ["10/10/2026", "Acme Dental, UT (Card Transaction ID: c3)", "($50.00)", "$1.00"],
    ["9/15/2026", "Pending - Employee   Contribution (Tax year: 2026)", "$300.00", "$1.00"],
    ["9/1/2026", "interest for aug-26", "$0.10", "$1.00"],
    ["8/20/2026", "Acme Dental, UT (Card Transaction ID: c2)", "($25.00)", "$1.00"],
    ["8/15/2026", "Employee Contribution (Tax year: 2026) (Tax year: 2026)", "$300.00", "$1.00"],
  ]);
  assert.equal(plan(reworded, stored(rows)).newRows.length, 0);
  // and the other direction: stored text reworded, file original
  assert.equal(plan(rows, stored(reworded)).newRows.length, 0);
});

test("reworded CARD row with the same Card Transaction ID is already imported, even with other date/amount", () => {
  const rows = file([["5/5/2026", "Fake Clinic, UT (Card Transaction ID: AbC123)", "($40.00)", "$10.00"]]);
  const existing = [{ id: "csv_he_x", date: "2026-05-04", original_description: "Pending - FAKE CLINIC (card transaction id: abc123)", amount: 41 }];
  const p = plan(rows, existing);
  assert.equal(p.newRows.length, 0);
  assert.equal(p.alreadyImported.length, 1);
  assert.equal(plan(rows, []).newRows.length, 1);
});

test("two identical non-card rows: 2 on first import, 0 on re-import, 1 when a third appears", () => {
  const two = file([
    ["6/1/2026", "Employee Contribution", "$100.00", "$300.00"],
    ["6/1/2026", "Employee Contribution", "$100.00", "$200.00"],
  ]);
  const first = plan(two);
  assert.equal(first.newRows.length, 2);
  assert.notEqual(first.newRows[0].id, first.newRows[1].id);
  assert.equal(plan(two, stored(two)).newRows.length, 0);
  const three = file([["6/1/2026", "Employee Contribution", "$100.00", "$400.00"], ...[
    ["6/1/2026", "Employee Contribution", "$100.00", "$300.00"],
    ["6/1/2026", "Employee Contribution", "$100.00", "$200.00"],
  ]]);
  const p = plan(three, stored(two));
  assert.equal(p.newRows.length, 1);
  assert.equal(p.alreadyImported.length, 2);
  // The new row is the newest occurrence (index 2 from oldest), not a re-keyed old one.
  assert.equal(p.newRows[0].id, plan(three).newRows[0].id);
  assert.ok(!first.newRows.some((r) => r.id === p.newRows[0].id));
});

test("a user-deleted stored row comes back as 1 new row (intended: the file is the source of truth for what exists)", () => {
  const rows = file(YTD);
  const existing = stored(rows).filter((e) => e.date !== "2026-09-15");
  const p = plan(rows, existing);
  assert.equal(p.newRows.length, 1);
  assert.equal(p.newRows[0].date, "2026-09-15");
  assert.equal(p.backdatedNew, 1);
});

test("preview and import use the same plan", () => {
  const { rows, skipped } = parseHealthEquityFile(wrap(YTD.map((c) => tr([...c, ""])).join("")));
  const existing = stored(rows.slice(2));
  const pl = plan(rows, existing);
  const p = buildHealthEquityPreview({ filename: "x.xls", rows, skipped, plan: pl });
  assert.equal(p.new_rows, pl.newRows.length);
  assert.equal(p.already_imported, pl.alreadyImported.length);
  assert.equal(p.new_rows, 2);
  assert.equal(p.backdated_new, 0);
});

test("a real .xlsx and a .csv with the same headers are accepted", () => {
  const aoa = [["Date", "Transaction", "Amount", "HSA Cash Balance"], ["1/9/2026", "Acme Dental, UT", "($10.00)", "$90.00"]];
  const ws = xlsxLib.utils.aoa_to_sheet(aoa);
  const wb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(wb, ws, "Sheet1");
  const xlsx = xlsxLib.write(wb, { type: "buffer", bookType: "xlsx" });
  const csv = 'Date,Transaction,Amount,HSA Cash Balance\n1/9/2026,"Acme Dental, UT","($10.00)","$90.00"\n';
  for (const input of [xlsx, Buffer.from(csv), csv]) {
    const { rows } = parseHealthEquityFile(input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-01-09");
    assert.equal(rows[0].amountDb, 10);
    assert.equal(rows[0].merchant, "Acme Dental");
  }
});

test("preview math: counts, already imported, totals in file terms, months, range", () => {
  const { rows, skipped } = parseHealthEquityFile(FIXTURE);
  const existing = rows.slice(0, 2).map((r, i) => ({ id: `csv_he_old${i}`, date: r.date, original_description: r.description, amount: r.amountDb }));
  const p = buildHealthEquityPreview({ filename: "th.xls", rows, skipped, plan: planHealthEquityImport(rows, existing) });
  assert.equal(p.filename, "th.xls");
  assert.equal(p.total_rows, 8);
  assert.equal(p.importable, 5);
  assert.equal(p.already_imported, 2);
  assert.equal(p.new_rows, 3);
  assert.equal(p.totals.spend, 1115.5); // 1135.50 out less 20.00 refund
  assert.equal(p.totals.contributions, 400);
  assert.equal(p.totals.interest, 0.03);
  assert.deepEqual(p.date_range, { from: "2026-01-09", to: "2026-12-31" });
  assert.deepEqual(p.by_month, [
    { month: "2026-01", count: 1 }, { month: "2026-02", count: 1 },
    { month: "2026-07", count: 1 }, { month: "2026-10", count: 1 }, { month: "2026-12", count: 1 },
  ]);
  assert.equal(p.skipped.reduce((n, s) => n + s.count, 0), 3);
  assert.ok(p.skipped.every((s) => s.reason && s.count === 1));
});

test("normalizeDescription ignores spacing around commas", async () => {
  const { normalizeDescription } = await import("../healthEquityImport.js");
  assert.equal(normalizeDescription("Foo Bar,Baz"), "foo bar, baz");
  assert.equal(normalizeDescription("Foo Bar ,  Baz"), "foo bar, baz");
  assert.equal(normalizeDescription("Foo Bar, Baz"), normalizeDescription("Foo Bar,Baz"));
});
