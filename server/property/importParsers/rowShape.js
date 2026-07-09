// ── Intermediate row shape ──────────────────────────────────────────────────
//
// The old spreadsheet has one tab per year (2021-2026), each an array of rows
// where row[0] is a header row of column labels and every subsequent row is
// an array of cell values in the same column order (this mirrors what
// xlsx's `sheet_to_json({ header: 1 })` produces, which is already used
// elsewhere in this app for audit-sheet import — see parseAuditXlsx in db.js).
//
// Observed header variants across years (not all columns present every year):
//   Date | Month | Monthly Rents | Direct Expense | Deposits Received |
//   Implied Expense | Expense | Gross | Type | Category | Notes |
//   Reconciled out of Reserve Account | Days Rented | Days Personal Use
//
// Some tabs also embed a trailing summary block (e.g. "TOTAL", "Depreciation",
// "Net Income") a few rows below the transaction rows, in the same columns.
// Those rows are not transactions and must be skipped, not misparsed.
//
// A "sheet" for the parser is: { year, rows: Array<Array<any>> }

export const SUMMARY_ROW_PATTERN =
  /^\s*(total|totals|subtotal|depreciation|net income|net rental income|gross income|summary|grand total)\s*:?\s*$/i;

const USAGE_HEADER_ALIASES = ["days rented", "days personal use", "days vacant"];

export function normalizeHeader(label) {
  return String(label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Builds a { normalizedHeader -> columnIndex } map from a sheet's header row.
export function indexHeaders(headerRow) {
  const map = {};
  (headerRow || []).forEach((label, idx) => {
    const key = normalizeHeader(label);
    if (key) map[key] = idx;
  });
  return map;
}

export function isBlankRow(row) {
  return !row || row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
}

// A row is a "summary/total" row (not a transaction) if its first non-empty
// cell matches known summary labels, regardless of which column it's in —
// these rows are frequently mis-shifted by a column in the source sheet.
export function isSummaryRow(row) {
  if (!row) return false;
  const firstText = row.find((c) => c !== null && c !== undefined && String(c).trim() !== "");
  return firstText != null && SUMMARY_ROW_PATTERN.test(String(firstText));
}

export function isUsageHeaderPresent(headerMap) {
  return USAGE_HEADER_ALIASES.some((h) => headerMap[h] !== undefined);
}

// Parses a currency-ish cell ("$1,200.00", "(300)", 1200, "") into a float.
// Parenthesized values are treated as negative, matching common spreadsheet
// convention for expenses/refunds.
export function parseAmountCell(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw;
  let s = String(raw).trim();
  if (s === "" || s === "-") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-") return null;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function parseDateCell(raw, fallbackYear) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === "number") {
    // Excel serial date (days since 1899-12-30).
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  const monthNameMatch = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i);
  if (monthNameMatch) {
    const monthIdx = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(monthNameMatch[1].toLowerCase());
    const year = fallbackYear || new Date().getFullYear();
    return `${year}-${String(monthIdx + 1).padStart(2, "0")}-01`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // MM/YYYY style month-only cells.
  const monthYear = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) return `${monthYear[2]}-${monthYear[1].padStart(2, "0")}-01`;
  return null;
}

export function postingMonthFromDate(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : null;
}
