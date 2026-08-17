// Row caps, and saying so out loud when one is hit.
//
// Every list endpoint here is bounded on purpose: production is a 256 MB Fly VM
// that sits around 173 MB RSS before it serves anything (see the note in
// gmail.js about the googleapis monolith that OOMed it), so an unbounded
// SELECT — or an unbounded workbook built from one — trades a truncation bug
// for a crash, which is strictly worse. The caps stay. What changes is that a
// truncated result now announces itself instead of looking complete:
//
//   - /api/transactions and /api/export-xlsx both set X-Result-Truncated /
//     X-Result-Limit / X-Result-Count (see TRUNCATION_HEADERS below),
//   - the export additionally carries the notice INSIDE the workbook, because
//     a spreadsheet gets forwarded, filed and re-opened long after the HTTP
//     response that produced it is gone.
//
// This module is deliberately I/O-free — no pg, no express — so the cap
// arithmetic and the truncation bookkeeping are unit-testable without a
// database (test/limits.test.js), the same split geminiUsage.js uses for its
// budget math.

// ── Env knobs ─────────────────────────────────────────────────────────────────
// Parsed the same defensive way parsePositiveNumber in geminiUsage.js is: a
// malformed value lands on the default, never on NaN. A NaN cap would compare
// false against everything and effectively switch the bound off, which on this
// VM means an OOM instead of a short file. Zero and negative mean "not
// configured" for the same reason a budget of 0 does.
export function parsePositiveInteger(raw, fallback) {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Transaction rows the xlsx export will carry, most recent first.
//
// 10,000 is 10× the old hard-coded 1,000 and is the same ceiling
// /api/transactions already enforces, so nothing in this app can now ask the
// database for more transactions in one go than any other path already does.
// The number is a memory budget, not a preference: a run at the cap holds, at
// once, the pg row objects (~1.5 KB each — getTransactions selects ~28 columns
// including the receipt-match join), the array-of-arrays handed to SheetJS
// (~0.3 KB/row), the worksheet cell objects SheetJS builds from it (~0.6 KB/row)
// and the sheet XML string it serialises before zipping (~0.25 KB/row). That is
// roughly 25-30 MB of peak transient on top of the ~173 MB baseline, inside the
// ~83 MB headroom with enough left for a second request to be in flight.
// Raising this via the env var scales that peak linearly — 25,000 rows is
// already an OOM-shaped number on the current VM.
//
// Read per request rather than frozen into a module constant at import time:
// index.js calls dotenv.config() after its import block, so anything resolved
// while this module is being imported would see the process env without .env
// applied and silently take the default on a local run.
export const DEFAULT_EXPORT_MAX_ROWS = 10000;
export function exportMaxRows(env = process.env) {
  return parsePositiveInteger(env.EXPORT_MAX_ROWS, DEFAULT_EXPORT_MAX_ROWS);
}

// GET /api/transactions: unchanged semantics, moved here so the truncation
// bookkeeping and the number it is bookkeeping against live together. The
// `|| DEFAULT` idiom is carried over verbatim (NaN from a non-numeric ?limit=
// falls back to the default) because callers — the client, the MCP tools, any
// API-key consumer — already depend on exactly this behaviour.
export const TRANSACTIONS_DEFAULT_LIMIT = 2000;
export const TRANSACTIONS_MAX_LIMIT = 10000;
export function resolveTransactionLimit(raw) {
  return Math.min(parseInt(raw) || TRANSACTIONS_DEFAULT_LIMIT, TRANSACTIONS_MAX_LIMIT);
}

// ── Truncation bookkeeping ────────────────────────────────────────────────────
// "Did we hit the cap?" is only answerable exactly by asking for one row more
// than we intend to keep: rows.length === limit is ambiguous — a table holding
// exactly `limit` matching rows would report itself truncated forever, and
// crying wolf on a complete export is its own kind of lie. So callers query
// with limit + 1 and hand the result here; the extra row costs nothing and is
// dropped before anything sees it. Deliberately no COUNT(*) companion query:
// this answers "is there more" without making the database count rows nobody
// asked for.
export function fetchLimit(limit) {
  return limit + 1;
}

export function takeWithTruncation(rows, limit) {
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
}

// Response headers rather than a body field, for both endpoints, because
// neither body can absorb one: /api/transactions' JSON shape is consumed by the
// client, the MCP tools and any API-key caller, and the export's body is xlsx
// bytes. Headers ride alongside both without touching either.
//
// Always sent, including on a complete result, so a client can tell "not
// truncated" apart from "server too old to say" — an absent header is the one
// answer that means nothing. X-Result-Count is the row count actually returned,
// which for the export is transaction rows only (balances and holdings are
// small, whole-table reads and are never capped).
export const TRUNCATION_HEADERS = {
  truncated: "X-Result-Truncated",
  limit: "X-Result-Limit",
  count: "X-Result-Count",
};

export function truncationHeaders({ truncated, limit, count }) {
  return {
    [TRUNCATION_HEADERS.truncated]: truncated ? "true" : "false",
    [TRUNCATION_HEADERS.limit]: String(limit),
    [TRUNCATION_HEADERS.count]: String(count),
  };
}

// ── Date range validation ─────────────────────────────────────────────────────
// Same convention as GET /api/reports/summary: YYYY-MM-DD only, both ends must
// parse, start on or before end. Returns null when the range is acceptable, or
// { error } carrying the message to put in a 400 — the caller owns the status
// code so this stays express-free.
//
// Unlike the summary route, either end may be omitted: getTransactions treats a
// missing bound as open-ended, and "everything before 2020" is a reasonable
// export. Omitting both means the whole table, which is what the export did
// before it took dates at all.
export const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDateRange({ startDate, endDate } = {}) {
  for (const v of [startDate, endDate]) {
    if (v === undefined || v === null || v === "") continue;
    if (!DATE_PARAM_RE.test(v)) {
      return { error: "start_date and end_date must be YYYY-MM-DD" };
    }
    if (Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
      return { error: "start_date and end_date must be valid dates" };
    }
  }
  if (startDate && endDate && startDate > endDate) {
    return { error: "start_date must be on or before end_date" };
  }
  return null;
}

// ── Offset validation ─────────────────────────────────────────────────────────
// The export's paging parameter, and the whole reason the truncation notice can
// now give a terminating instruction. A date range cannot paginate WITHIN a
// date — no end_date splits a day — so on any date holding more rows than the
// cap, "export again ending on the oldest date included" is a fixed point:
// every run returns the same page and the rows behind it are unreachable
// through any combination of start_date/end_date. OFFSET is not, because it
// counts rows in the (date DESC, id DESC) total order getTransactions imposes,
// and that order is what makes consecutive pages abut exactly.
//
// Returns { offset } or { error }, the same shape/ownership split as
// validateDateRange: the message is here, the 400 is the caller's. Absent,
// null and "" mean 0, so the parameter is invisible to a caller that never
// passes it. Anything else must be digits only — Number() would happily take
// "1e3", " 12 ", "0x10" and "-0", and an OFFSET of the wrong magnitude silently
// returns the wrong slice rather than failing. Safe-integer bounded because a
// 20-digit offset is not an offset, it is a typo Postgres would reject.
export const OFFSET_PARAM_RE = /^\d+$/;

export function parseOffset(raw) {
  if (raw === undefined || raw === null || raw === "") return { offset: 0 };
  const s = String(raw);
  const n = Number(s);
  if (!OFFSET_PARAM_RE.test(s) || !Number.isSafeInteger(n)) {
    return { error: "offset must be a non-negative integer" };
  }
  return { offset: n };
}

// ── Export truncation notice ──────────────────────────────────────────────────
// The workbook's own record of what it is and is not. A separate sheet, because
// the other three are shaped for the import parsers — parseXlsxBase64 looks up
// "Account Balances" / "Investment Holdings" / "Transactions" by name and
// sheet_to_json treats row 1 as the header — so a banner row or an extra column
// on any of them would either corrupt a re-import or be silently swallowed by
// it. A sheet nobody parses can say anything it likes. The name must not end in
// " Balances" or "Transactions" or the import parsers would try to read it as
// data; "Export Info" and the truncated variant below satisfy that.
//
// (Shaped for, not currently accepted by: re-importing this workbook does not
// actually round-trip today — see the note on the export route in index.js.
// That is a pre-existing parser bug, not something this sheet introduces, and
// the layout is kept intact so fixing the parser is all it takes.)
export const EXPORT_INFO_SHEET = "Export Info";
export const EXPORT_TRUNCATED_SHEET = "TRUNCATED - READ ME";

export function exportInfoSheetName(truncated) {
  return truncated ? EXPORT_TRUNCATED_SHEET : EXPORT_INFO_SHEET;
}

// Truncation also shows in the filename, so the incomplete file stays labelled
// after it has been renamed-by-download, mailed on, or dropped in a folder next
// to a complete one. The client already reads the name out of
// Content-Disposition (api.js downloadXlsx), so this needs no client change.
export function exportFilename(snapshotDate, truncated) {
  return `finapp-${snapshotDate}${truncated ? "-TRUNCATED" : ""}.xlsx`;
}

const rangeLabel = (startDate, endDate) => {
  if (startDate && endDate) return `${startDate} to ${endDate}`;
  if (startDate) return `${startDate} onwards`;
  if (endDate) return `up to ${endDate}`;
  return "All dates (no start_date/end_date given)";
};

const count = (n) => Number(n).toLocaleString("en-US");

// Rows for the info sheet, as the array-of-arrays SheetJS' aoa_to_sheet takes.
// Label/value pairs rather than a header + data row: this is a fact sheet a
// human reads, not a table anything joins on.
//
// The remedy is offset paging, and it is the whole point of the sheet: an
// instruction the owner can follow MECHANICALLY, that TERMINATES, and whose
// files union to the requested range with every transaction in it exactly once.
// This file is rows offset+1 .. offset+rowCount of one (date DESC, id DESC)
// list; the next file starts at offset+rowCount. Consecutive slices of a total
// order abut exactly, so there is no seam to describe, no boundary date to
// reason about, and nothing to de-duplicate.
//
// The remedy this replaced was end_date = "oldest date included", inclusive. It
// does not terminate. `date` is a DATE, so no end_date can split a single day:
// on a date holding more rows than the cap, that instruction returns the very
// same page forever and points at itself again — 123 rows on one date under a
// cap of 5 leaves 118 of them unreachable through ANY start_date/end_date pair.
// It also told the owner to "de-duplicate by transaction id", which the
// Transactions sheet has no column for, and asserted unconditionally that the
// boundary date was only partly present, which is false whenever the cap lands
// on a date boundary. Offset paging needs none of those three claims.
export function buildExportInfoRows({
  truncated, rowCount, rowCap, offset = 0, startDate, endDate, oldestIncluded, generatedAt,
}) {
  const nextOffset = offset + rowCount;
  const rows = [
    ["Export status", truncated ? "INCOMPLETE - ROW CAP REACHED" : "Complete"],
    ["Generated (UTC)", generatedAt],
    ["Date range requested", rangeLabel(startDate, endDate)],
    ["Offset requested", offset],
    ["Transactions in this file", rowCount],
    ["Rows covered", rowCount ? `${count(offset + 1)}-${count(nextOffset)} of the selected range, newest first` : "(none)"],
    ["Transaction row cap", rowCap],
    ["Oldest transaction included", oldestIncluded || "(none)"],
  ];
  if (truncated) {
    rows.push(
      [],
      ["WARNING", `This file does NOT contain every transaction in the requested range.`],
      ["", `It holds rows ${count(offset + 1)}-${count(nextOffset)} of that range, newest first. The row cap is ${count(rowCap)} per file.`],
      ["", `To continue, export again with the same start_date/end_date and offset=${nextOffset}. Keep going the same way — each file tells you its own next offset — until a file's Export status reads "Complete". That file is the last one.`],
      ["", `The slices do not overlap and leave no gaps, so the files simply append in order: nothing is duplicated and nothing is missing. Run them back-to-back, though — transactions imported partway through a series shift the numbering.`],
      ["", `The cap protects a 256 MB server from running out of memory mid-export; raise it with the EXPORT_MAX_ROWS env var only if that server has the headroom.`],
    );
  }
  return rows;
}
