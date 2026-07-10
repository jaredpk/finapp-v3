import { read, utils } from "xlsx";
import { normalizeHeader } from "./rowShape.js";

// Converts a real uploaded workbook (base64) into the intermediate sheet shape
// parseWorkbook expects: [{ year, label, rows }]. Only tabs whose name contains
// a 4-digit year are treated as year-ledger tabs; everything else (estimates,
// furnishing lists) is skipped.
//
// Real tabs differ from the fixtures in ways this normalizes:
//  - a title row (e.g. "Monthly Rental") sits above the actual header row
//  - the transaction table may not start at column 0 (2021 starts at col 4,
//    with a second property's table further right — both are cropped out)
//  - side "Expense Breakdown" summary blocks share rows with transactions
//  - the same header label can appear twice (two "Notes" columns); duplicates
//    are renamed so indexHeaders keeps the first occurrence

const HEADER_ANCHOR = new Set(["month", "date", "transaction date"]);
const MAX_HEADER_SCAN_ROWS = 6;

export function workbookBase64ToSheets(base64) {
  const wb = read(Buffer.from(base64, "base64"), { type: "buffer", cellDates: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const yearMatch = name.match(/(20\d{2})/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);
    const rawRows = utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const cropped = cropToTransactionTable(rawRows);
    if (!cropped) continue;
    sheets.push({ year, label: name, rows: cropped });
  }
  sheets.sort((a, b) => a.year - b.year);
  return sheets;
}

// Finds the header row (the one containing a "Month"/"Date" cell), determines
// the contiguous extent of the transaction table from that anchor cell, and
// returns rows sliced to just that table with duplicate headers renamed.
function cropToTransactionTable(rawRows) {
  let headerRowIdx = -1;
  let startCol = -1;
  for (let r = 0; r < Math.min(rawRows.length, MAX_HEADER_SCAN_ROWS); r++) {
    const row = rawRows[r] || [];
    const c = row.findIndex((cell) => HEADER_ANCHOR.has(normalizeHeader(cell)));
    if (c !== -1) { headerRowIdx = r; startCol = c; break; }
  }
  if (headerRowIdx === -1) return null;

  const headerRow = rawRows[headerRowIdx];
  let endCol = startCol;
  while (endCol + 1 < headerRow.length && normalizeHeader(headerRow[endCol + 1]) !== "") endCol++;

  const seen = {};
  const header = headerRow.slice(startCol, endCol + 1).map((label) => {
    const key = normalizeHeader(label);
    seen[key] = (seen[key] || 0) + 1;
    return seen[key] > 1 ? `${label} ${seen[key]}` : label;
  });

  const rows = [header];
  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    rows.push((rawRows[r] || []).slice(startCol, endCol + 1));
  }
  return rows;
}
