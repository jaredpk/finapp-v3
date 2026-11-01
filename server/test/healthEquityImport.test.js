import test from "node:test";
import assert from "node:assert/strict";
import xlsxLib from "xlsx";
import {
  parseHealthEquityFile, buildHealthEquityPreview, parseMoneyToCents, parseHeDate,
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

test("ids are stable, prefixed, and distinct across balances; collisions get an occurrence index", () => {
  const a = parseHealthEquityFile(FIXTURE).rows;
  const b = parseHealthEquityFile(FIXTURE).rows;
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
  assert.ok(a.every((r) => /^csv_he_[0-9a-f]{16}$/.test(r.id)));
  assert.equal(new Set(a.map((r) => r.id)).size, a.length);

  const same = tr(["5/5/2026", "Twin Shop, UT (Card Transaction ID: q)", "($10.00)", "$50.00", ""]);
  const twins = parseHealthEquityFile(wrap(same + same)).rows;
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].id, twins[1].id);
  assert.match(twins[0].id, /^csv_he_[0-9a-f]{16}$/);
  assert.match(twins[1].id, /^csv_he_[0-9a-f]{16}_2$/);

  // Same text, different running balance => different ids with no suffix.
  const diff = parseHealthEquityFile(wrap(same + tr(["5/5/2026", "Twin Shop, UT (Card Transaction ID: q)", "($10.00)", "$40.00", ""]))).rows;
  assert.ok(diff.every((r) => !r.id.endsWith("_2")));
  assert.notEqual(diff[0].id, diff[1].id);
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
  const existing = new Set([rows[0].id, rows[1].id, "csv_he_unrelated"]);
  const p = buildHealthEquityPreview({ filename: "th.xls", rows, skipped, existingIds: existing });
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
