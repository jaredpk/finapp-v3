import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePositiveInteger, exportMaxRows, DEFAULT_EXPORT_MAX_ROWS,
  resolveTransactionLimit, TRANSACTIONS_DEFAULT_LIMIT, TRANSACTIONS_MAX_LIMIT,
  fetchLimit, takeWithTruncation, truncationHeaders, TRUNCATION_HEADERS,
  validateDateRange, parseOffset, buildExportInfoRows, exportInfoSheetName, exportFilename,
  EXPORT_INFO_SHEET, EXPORT_TRUNCATED_SHEET,
} from "../limits.js";

// The I/O-free half of the row-cap machinery: cap arithmetic, truncation
// bookkeeping, date-range validation and the workbook's notice rows. No pg, no
// express, no network.
//
// What these tests protect is a direction, the same way geminiUsage.test.js
// does. The caps themselves are non-negotiable — a 256 MB VM that has already
// OOMed once cannot afford an unbounded query or an unbounded workbook — so the
// failure this file guards against is not "too few rows", it is "too few rows
// and nobody said so". Every assertion below is either about staying bounded or
// about the bound being announced when it bites.
//
// getTransactionStats (db.js) has no counterpart here on purpose: it is four
// SQL aggregates and a column rename, with no logic outside the query. A test
// with a faked pool would assert the SQL string I just wrote, which proves
// nothing about whether Postgres agrees with Transactions.jsx.

// ── Cap resolution ────────────────────────────────────────────────────────────

test("a junk or non-positive EXPORT_MAX_ROWS falls back to the default, never NaN", () => {
  // NaN is the dangerous one: every comparison against it is false, so a NaN
  // cap reads as "no cap" at exactly the moment the cap is load-bearing.
  for (const raw of ["", "  ", "abc", "0", "-1", "1e", null, undefined, {}]) {
    assert.equal(exportMaxRows({ EXPORT_MAX_ROWS: raw }), DEFAULT_EXPORT_MAX_ROWS, `raw: ${String(raw)}`);
  }
  // Fractional row counts are not row counts.
  assert.equal(exportMaxRows({ EXPORT_MAX_ROWS: "500.5" }), DEFAULT_EXPORT_MAX_ROWS);
  assert.equal(parsePositiveInteger("7", 3), 7);
  assert.equal(parsePositiveInteger(" 7 ", 3), 7);
});

test("a valid EXPORT_MAX_ROWS overrides the default", () => {
  assert.equal(exportMaxRows({ EXPORT_MAX_ROWS: "2500" }), 2500);
  assert.equal(exportMaxRows({ EXPORT_MAX_ROWS: 2500 }), 2500);
});

test("the default export cap is bounded and well above the old hard-coded 1000", () => {
  // The number is a memory budget: ~2.5 KB of transient per row through
  // SheetJS against ~83 MB of headroom on the production VM. It may be tuned,
  // but it may not become unbounded, and it must not silently regress to the
  // 1000 that made older history unexportable.
  assert.ok(DEFAULT_EXPORT_MAX_ROWS > 1000);
  assert.ok(Number.isInteger(DEFAULT_EXPORT_MAX_ROWS) && DEFAULT_EXPORT_MAX_ROWS <= TRANSACTIONS_MAX_LIMIT);
});

test("GET /api/transactions limit parsing is unchanged", () => {
  // Callers depend on exactly this: absent or unparseable → 2000, anything
  // over the ceiling clamps to 10000. Carried over verbatim from the route.
  assert.equal(resolveTransactionLimit(undefined), TRANSACTIONS_DEFAULT_LIMIT);
  assert.equal(resolveTransactionLimit(""), TRANSACTIONS_DEFAULT_LIMIT);
  assert.equal(resolveTransactionLimit("abc"), TRANSACTIONS_DEFAULT_LIMIT);
  assert.equal(resolveTransactionLimit("0"), TRANSACTIONS_DEFAULT_LIMIT);
  assert.equal(resolveTransactionLimit("200"), 200);
  assert.equal(resolveTransactionLimit("99999"), TRANSACTIONS_MAX_LIMIT);
  assert.equal(resolveTransactionLimit(String(TRANSACTIONS_MAX_LIMIT)), TRANSACTIONS_MAX_LIMIT);
});

// ── Truncation bookkeeping ────────────────────────────────────────────────────

test("a full page is only reported truncated when a further row actually exists", () => {
  // The point of fetching limit + 1. A month holding exactly 200 transactions
  // is complete, and reporting it truncated would train the owner to ignore
  // the warning on the month that really is short.
  const limit = 3;
  assert.equal(fetchLimit(limit), 4);

  const exact = takeWithTruncation([1, 2, 3], limit);
  assert.deepEqual(exact.rows, [1, 2, 3]);
  assert.equal(exact.truncated, false);

  const overflowing = takeWithTruncation([1, 2, 3, 4], limit);
  assert.deepEqual(overflowing.rows, [1, 2, 3], "the probe row never reaches the caller");
  assert.equal(overflowing.truncated, true);

  const short = takeWithTruncation([1], limit);
  assert.deepEqual(short.rows, [1]);
  assert.equal(short.truncated, false);

  const empty = takeWithTruncation([], limit);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.truncated, false);
});

test("truncation headers are always sent, so absent means 'old server' and not 'complete'", () => {
  const complete = truncationHeaders({ truncated: false, limit: 200, count: 47 });
  assert.deepEqual(complete, {
    [TRUNCATION_HEADERS.truncated]: "false",
    [TRUNCATION_HEADERS.limit]: "200",
    [TRUNCATION_HEADERS.count]: "47",
  });

  const cut = truncationHeaders({ truncated: true, limit: 200, count: 200 });
  assert.equal(cut[TRUNCATION_HEADERS.truncated], "true");
  assert.equal(cut[TRUNCATION_HEADERS.count], "200");

  // Header values must be strings; a number would be coerced by express but a
  // 0 count is the case where a stray falsy check would drop the header.
  for (const v of Object.values(truncationHeaders({ truncated: false, limit: 0, count: 0 }))) {
    assert.equal(typeof v, "string");
  }
});

// ── Date range validation ─────────────────────────────────────────────────────

test("date params follow the /api/reports/summary convention", () => {
  assert.equal(validateDateRange({ startDate: "2026-01-01", endDate: "2026-12-31" }), null);
  assert.equal(validateDateRange({ startDate: "2026-01-01", endDate: "2026-01-01" }), null, "single day");

  assert.deepEqual(validateDateRange({ startDate: "01/01/2026" }),
    { error: "start_date and end_date must be YYYY-MM-DD" });
  assert.deepEqual(validateDateRange({ endDate: "2026-1-1" }),
    { error: "start_date and end_date must be YYYY-MM-DD" });
  assert.deepEqual(validateDateRange({ startDate: "2026-13-45" }),
    { error: "start_date and end_date must be valid dates" });
  assert.deepEqual(validateDateRange({ startDate: "2026-12-31", endDate: "2026-01-01" }),
    { error: "start_date must be on or before end_date" });
});

test("either end of the range may be omitted", () => {
  // Unlike the summary route: getTransactions treats a missing bound as
  // open-ended, and "everything before 2020" is a reasonable export request.
  // No params at all is the pre-existing behaviour — the whole table, capped.
  assert.equal(validateDateRange({}), null);
  assert.equal(validateDateRange(), null);
  assert.equal(validateDateRange({ startDate: "2020-01-01" }), null);
  assert.equal(validateDateRange({ endDate: "2020-01-01" }), null);
  assert.equal(validateDateRange({ startDate: "", endDate: undefined }), null);
});

// ── Offset validation ─────────────────────────────────────────────────────────

test("a missing offset means 0, so the parameter is invisible to callers that never pass it", () => {
  for (const raw of [undefined, null, ""]) {
    assert.deepEqual(parseOffset(raw), { offset: 0 }, `raw: ${String(raw)}`);
  }
  assert.deepEqual(parseOffset("0"), { offset: 0 });
  assert.deepEqual(parseOffset("10000"), { offset: 10000 });
  assert.deepEqual(parseOffset(10000), { offset: 10000 });
});

test("a junk offset is a 400, never a silently different slice", () => {
  // Number() would accept every one of these and hand SQL an OFFSET the caller
  // did not ask for — which does not fail, it just returns the wrong rows, and
  // a paging sequence built on the wrong rows loses transactions without ever
  // saying so. Digits only.
  for (const raw of ["-1", "1.5", "1e3", " 12 ", "0x10", "abc", "10,000", "+5", "Infinity", "99999999999999999999"]) {
    assert.deepEqual(parseOffset(raw), { error: "offset must be a non-negative integer" }, `raw: ${raw}`);
  }
});

// ── Export notice ─────────────────────────────────────────────────────────────

const infoValue = (rows, label) => rows.find((r) => r[0] === label)?.[1];

test("a complete export says so and carries no warning", () => {
  const rows = buildExportInfoRows({
    truncated: false,
    rowCount: 412,
    rowCap: DEFAULT_EXPORT_MAX_ROWS,
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    oldestIncluded: "2026-01-03",
    generatedAt: "2026-08-17T12:00:00.000Z",
  });
  assert.equal(infoValue(rows, "Export status"), "Complete");
  assert.equal(infoValue(rows, "Transactions in this file"), 412);
  assert.equal(infoValue(rows, "Date range requested"), "2026-01-01 to 2026-06-30");
  assert.equal(rows.find((r) => r[0] === "WARNING"), undefined);
  assert.equal(exportInfoSheetName(false), EXPORT_INFO_SHEET);
  assert.equal(exportFilename("2026-08-17", false), "finapp-2026-08-17.xlsx");
});

const noticeText = (rows) =>
  rows.filter((r) => r[0] === "WARNING" || r[0] === "").map((r) => r[1]).join(" ");

test("a truncated export names the slice it holds and the exact next call", () => {
  // The difference between a warning and an instruction: not just "some rows
  // are missing" but "here are the rows you have, here is the one call that
  // gets the next ones".
  const rows = buildExportInfoRows({
    truncated: true,
    rowCount: 10000,
    rowCap: 10000,
    offset: 0,
    startDate: undefined,
    endDate: undefined,
    oldestIncluded: "2024-02-11",
    generatedAt: "2026-08-17T12:00:00.000Z",
  });
  assert.equal(infoValue(rows, "Export status"), "INCOMPLETE - ROW CAP REACHED");
  assert.equal(infoValue(rows, "Offset requested"), 0);
  assert.equal(infoValue(rows, "Rows covered"), "1-10,000 of the selected range, newest first");
  assert.equal(infoValue(rows, "Oldest transaction included"), "2024-02-11");
  assert.equal(infoValue(rows, "Transaction row cap"), 10000);
  assert.match(infoValue(rows, "Date range requested"), /^All dates/);

  const text = noticeText(rows);
  assert.match(text, /does NOT contain every transaction/);
  assert.match(text, /offset=10000/, "the next call is spelled out, not described");
  assert.match(text, /same start_date\/end_date/, "with the dates held fixed");
  assert.match(text, /EXPORT_MAX_ROWS/, "and how to raise the cap, with the caveat");

  // A second page reports its own position and its own successor.
  const second = buildExportInfoRows({
    truncated: true, rowCount: 10000, rowCap: 10000, offset: 10000,
    startDate: "2020-01-01", endDate: "2026-01-01",
    oldestIncluded: "2022-07-04", generatedAt: "2026-08-17T12:00:00.000Z",
  });
  assert.equal(infoValue(second, "Rows covered"), "10,001-20,000 of the selected range, newest first");
  assert.match(noticeText(second), /offset=20000/);
});

test("the remedy no longer tells the owner to do something they cannot do", () => {
  // Two instructions are gone for good, and both were unfollowable.
  //
  // "De-duplicate by transaction id": the Transactions sheet is
  // ["Date","Merchant","Category","Amount (USD)","Account"] — there is no id
  // column to de-duplicate on, and adding one would change a sheet layout the
  // import parsers treat as a contract. Offset slices do not overlap, so there
  // is nothing to remove either.
  //
  // "Export again with end_date on the oldest date included": a DATE bound
  // cannot split a day, so on any date holding more rows than the cap that
  // instruction returns the identical page and points at itself again, forever
  // (see the termination test below). And "that date is only partly here" was
  // asserted unconditionally, which is simply false when the cap happens to
  // land on a date boundary.
  const rows = buildExportInfoRows({
    truncated: true, rowCount: 5, rowCap: 5, offset: 0,
    startDate: undefined, endDate: undefined,
    oldestIncluded: "2026-08-17", generatedAt: "2026-08-17T12:00:00.000Z",
  });
  const text = noticeText(rows);

  assert.doesNotMatch(text, /de-duplicat/i, "there is no id column to de-duplicate on");
  assert.doesNotMatch(text, /transaction id/i);
  assert.doesNotMatch(text, /end_date set to/i, "the remedy must not move the date bound");
  assert.doesNotMatch(text, /day before/i);
  assert.doesNotMatch(text, /only partly here/i, "an unconditional claim that is sometimes false");
  assert.match(text, /offset=5/);
});

// Paging simulated end to end against an in-memory list. `LIMIT n OFFSET k` over
// a total order IS list.slice(k, k + n), which is what makes this a faithful
// model — but only because getTransactions orders by t.date DESC, t.id DESC.
// The SQL clause itself (db.js) has no test here on purpose: asserting the
// query string I just wrote proves nothing about what Postgres does with it.
// What is testable without a database, and is the thing that was actually
// broken, is whether the notice's instructions terminate and cover everything.
const pageAt = (all, offset, cap) => {
  const fetched = all.slice(offset, offset + fetchLimit(cap));
  const { rows, truncated } = takeWithTruncation(fetched, cap);
  return {
    rows,
    info: buildExportInfoRows({
      truncated, rowCount: rows.length, rowCap: cap, offset,
      startDate: "2026-01-01", endDate: "2026-12-31",
      oldestIncluded: rows[rows.length - 1]?.date,
      generatedAt: "2026-08-17T12:00:00.000Z",
    }),
  };
};

// Follow the notice the way an owner would: read the offset out of it, ask
// again, stop when a file says Complete. Returns every row collected, in order,
// plus the sequence of calls made.
function followTheInstructions(all, cap) {
  const collected = [];
  const offsets = [];
  let offset = 0;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 500, "following the notice must terminate");
    offsets.push(offset);
    const { rows, info } = pageAt(all, offset, cap);
    collected.push(...rows);
    if (infoValue(info, "Export status") === "Complete") {
      assert.equal(noticeText(info), "", "a complete file carries no further instruction");
      return { collected, offsets };
    }
    const next = noticeText(info).match(/offset=(\d+)/);
    assert.ok(next, "a truncated file must name a concrete next offset");
    const nextOffset = Number(next[1]);
    assert.ok(nextOffset > offset, `the offset must advance: got ${nextOffset} after ${offset}`);
    assert.ok(!offsets.includes(nextOffset), `the notice must not re-issue a call already made: ${nextOffset}`);
    offset = nextOffset;
  }
}

test("the remedy terminates and its files reconstruct the range exactly once each", () => {
  // The shape that defeated the date-based remedy, taken from a real database:
  // 135 rows of which 123 share one date, under a cap of 5. No end_date can cut
  // inside that date, so the old instruction handed back the same five rows on
  // every run and left 124 rows unreachable through ANY combination of the
  // route's parameters. This is the acceptance criterion for the replacement.
  const all = [];
  const push = (date, n) => {
    for (let k = 0; k < n; k++) all.push({ id: `${date}-${String(n - k).padStart(3, "0")}`, date });
  };
  push("2026-03-05", 7);
  push("2026-03-04", 123);
  push("2026-03-03", 4);
  push("2026-03-02", 1);
  assert.equal(all.length, 135);

  const { collected, offsets } = followTheInstructions(all, 5);
  assert.deepEqual(collected.map((r) => r.id), all.map((r) => r.id),
    "every row, in order, exactly once — no gap, no duplicate");
  assert.equal(new Set(collected.map((r) => r.id)).size, 135);
  assert.deepEqual(offsets.slice(0, 3), [0, 5, 10]);
  assert.equal(offsets.length, 27, "135 rows at 5 per file is 27 files, then it stops");
});

test("paging terminates on the awkward totals too", () => {
  const rows = (n) => Array.from({ length: n }, (_, k) => ({ id: `t${k}`, date: "2026-03-04" }));

  // An exact multiple of the cap: the probe row is what keeps this from
  // producing a pointless empty final file — the second page holds exactly 5
  // rows with nothing behind them, so it reports Complete and the sequence ends
  // there rather than sending the owner to an offset past the end.
  const exact = followTheInstructions(rows(10), 5);
  assert.equal(exact.collected.length, 10);
  assert.deepEqual(exact.offsets, [0, 5]);

  // Under the cap: one file, Complete, no instruction at all.
  const small = followTheInstructions(rows(3), 5);
  assert.deepEqual(small.offsets, [0]);
  assert.equal(small.collected.length, 3);

  // Nothing in range at all.
  const none = followTheInstructions([], 5);
  assert.deepEqual(none.offsets, [0]);
  assert.equal(none.collected.length, 0);
});

test("truncation is visible from the tab bar and the filename, not just inside a cell", () => {
  assert.equal(exportInfoSheetName(true), EXPORT_TRUNCATED_SHEET);
  assert.match(EXPORT_TRUNCATED_SHEET, /TRUNCATED/);
  assert.equal(exportFilename("2026-08-17", true), "finapp-2026-08-17-TRUNCATED.xlsx");
  // Sheet names are a contract with the import parsers: parseXlsxBase64 reads
  // "Account Balances"/"Investment Holdings"/"Transactions" by exact name,
  // parseQuadraticXlsx claims anything ending " Transactions"/" Balances", and
  // parseAuditXlsx claims anything ending "Transactions" (no space). The info
  // sheet must be invisible to all three.
  for (const name of [EXPORT_INFO_SHEET, EXPORT_TRUNCATED_SHEET]) {
    assert.ok(!/Transactions$/.test(name) && !/ Balances$/.test(name), name);
    assert.ok(!["Account Balances", "Investment Holdings", "Transactions"].includes(name), name);
    assert.ok(name.length <= 31 && !/[:\\/?*[\]]/.test(name), `${name} must be a legal sheet name`);
  }
});

test("the notice degrades rather than lying when there are no rows at all", () => {
  const rows = buildExportInfoRows({
    truncated: false, rowCount: 0, rowCap: DEFAULT_EXPORT_MAX_ROWS,
    startDate: "2030-01-01", endDate: undefined,
    oldestIncluded: undefined, generatedAt: "2026-08-17T12:00:00.000Z",
  });
  assert.equal(infoValue(rows, "Transactions in this file"), 0);
  assert.equal(infoValue(rows, "Oldest transaction included"), "(none)");
  assert.equal(infoValue(rows, "Date range requested"), "2030-01-01 onwards");
});
