import { isBlankRow, isSummaryRow, isUsageHeaderPresent, parseAmountCell, parseDateCell, postingMonthFromDate, indexHeaders } from "./rowShape.js";
import { detectColumnMap } from "./columnDetectors.js";
import { suggestCategoryFromText } from "../categories.js";

// Parses one year-tab's raw rows into transaction-like records, usage/allocation
// records (kept separate — they are not ledger transactions), and a review
// queue of rows that couldn't be confidently parsed.
//
// sheet: { year: number, rows: Array<Array<any>>, label?: string }
// returns: { transactions, usagePeriods, reviewQueue }
export function parseYearSheet(sheet) {
  const { year, rows, label } = sheet;
  const transactions = [];
  const usagePeriods = [];
  const reviewQueue = [];

  if (!rows || rows.length === 0) return { transactions, usagePeriods, reviewQueue };

  const headerRow = rows[0];
  const columnMap = detectColumnMap(headerRow);
  const headerIdx = indexHeaders(headerRow);
  const hasUsageColumns = isUsageHeaderPresent(headerIdx);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (isBlankRow(row)) continue;
    if (isSummaryRow(row)) continue; // e.g. "TOTAL", "Depreciation" footer blocks

    // Usage/allocation rows live alongside transaction rows but are not
    // transactions themselves — pull them into a separate stream when a row
    // only carries days-rented/days-personal data with no dollar amount.
    if (hasUsageColumns) {
      const usage = tryParseUsageRow(row, columnMap, year);
      if (usage) { usagePeriods.push(usage); continue; }
    }

    const parsed = parseTransactionRow(row, columnMap, year);
    if (parsed) {
      transactions.push(parsed);
    } else if (isZeroNoiseRow(row, columnMap)) {
      continue; // zero-value placeholder rows with no label — not worth review
    } else {
      reviewQueue.push({
        year,
        sheetLabel: label || `${year} Transactions`,
        rawRow: row,
        reason: classifyFailure(row, columnMap),
      });
    }
  }

  return { transactions, usagePeriods, reviewQueue };
}

// A row that failed to parse is silent noise (vs. review-worthy) when it has
// no descriptive text and no non-zero amount in any mapped amount column —
// e.g. "$0.00" placeholder rows carried down by spreadsheet fill.
function isZeroNoiseRow(row, columnMap) {
  for (const key of ["type", "category", "notes"]) {
    if (columnMap[key] !== undefined && String(row[columnMap[key]] ?? "").trim() !== "") return false;
  }
  for (const key of ["rents", "directExpense", "impliedExpense", "expense", "gross"]) {
    if (columnMap[key] === undefined) continue;
    const n = parseAmountCell(row[columnMap[key]]);
    if (n != null && n !== 0) return false;
  }
  return true;
}

function tryParseUsageRow(row, columnMap, year) {
  const daysRented = columnMap.daysRented !== undefined ? Number(row[columnMap.daysRented]) : null;
  const daysPersonal = columnMap.daysPersonal !== undefined ? Number(row[columnMap.daysPersonal]) : null;
  const hasDollarValue =
    (columnMap.rents !== undefined && parseAmountCell(row[columnMap.rents]) != null) ||
    (columnMap.gross !== undefined && parseAmountCell(row[columnMap.gross]) != null) ||
    (columnMap.expense !== undefined && parseAmountCell(row[columnMap.expense]) != null) ||
    (columnMap.directExpense !== undefined && parseAmountCell(row[columnMap.directExpense]) != null);

  if (hasDollarValue) return null; // has money → treat as a transaction row instead
  if (!Number.isFinite(daysRented) && !Number.isFinite(daysPersonal)) return null;

  const dateStr = columnMap.date !== undefined ? parseDateCell(row[columnMap.date], year) : null;
  return {
    year,
    startDate: dateStr,
    endDate: dateStr,
    usageType: (daysRented || 0) >= (daysPersonal || 0) ? "rental" : "personal",
    days: (daysRented || 0) + (daysPersonal || 0) || null,
    sourceNote: columnMap.notes !== undefined ? String(row[columnMap.notes] ?? "").trim() || null : null,
  };
}

function parseTransactionRow(row, columnMap, year) {
  const dateStr = columnMap.date !== undefined ? parseDateCell(row[columnMap.date], year) : null;
  const notes = columnMap.notes !== undefined ? String(row[columnMap.notes] ?? "").trim() : "";
  const sourceCategory = columnMap.category !== undefined ? String(row[columnMap.category] ?? "").trim() : (
    columnMap.type !== undefined ? String(row[columnMap.type] ?? "").trim() : ""
  );

  let amount = null;
  let direction = null;

  switch (columnMap.shape) {
    case "direct_expense": {
      const rent = columnMap.rents !== undefined ? parseAmountCell(row[columnMap.rents]) : null;
      const expense = columnMap.directExpense !== undefined ? parseAmountCell(row[columnMap.directExpense]) : null;
      if (rent != null && rent !== 0) { amount = Math.abs(rent); direction = "income"; }
      else if (expense != null && expense !== 0) { amount = Math.abs(expense); direction = "expense"; }
      break;
    }
    case "gross_type": {
      const gross = columnMap.gross !== undefined ? parseAmountCell(row[columnMap.gross]) : null;
      if (gross != null && gross !== 0) {
        amount = Math.abs(gross);
        const type = (columnMap.type !== undefined ? String(row[columnMap.type] ?? "") : "").toLowerCase();
        direction = type.includes("expense") || type.includes("exp") || gross < 0 ? "expense" : "income";
      }
      break;
    }
    case "deposits_implied": {
      const deposit = columnMap.rents !== undefined ? parseAmountCell(row[columnMap.rents]) : null;
      const implied = columnMap.impliedExpense !== undefined ? parseAmountCell(row[columnMap.impliedExpense]) : null;
      const expense = columnMap.expense !== undefined ? parseAmountCell(row[columnMap.expense]) : null;
      if (deposit != null && deposit !== 0) { amount = Math.abs(deposit); direction = "income"; }
      else if (expense != null && expense !== 0) { amount = Math.abs(expense); direction = "expense"; }
      else if (implied != null && implied !== 0) { amount = Math.abs(implied); direction = "expense"; }
      break;
    }
    default: {
      // Unknown shape: last-resort scan of every numeric-looking cell.
      for (const cell of row) {
        const n = parseAmountCell(cell);
        if (n != null && n !== 0) { amount = Math.abs(n); direction = n < 0 ? "expense" : "income"; break; }
      }
    }
  }

  if (!dateStr || amount == null || !direction) return null;

  const normalizedCategory = mapSourceCategory(sourceCategory, notes, direction);
  const reconciledCell = columnMap.reconciled !== undefined ? row[columnMap.reconciled] : null;
  const isReconciledViaReserve = /^(y|yes|true|1)$/i.test(String(reconciledCell ?? "").trim());

  return {
    year,
    transactionDate: dateStr,
    postingMonth: postingMonthFromDate(dateStr),
    amount,
    direction,
    normalizedCategory,
    sourceCategory: sourceCategory || null,
    merchant: null,
    memo: notes || null,
    sourceType: "import",
    reconciledViaReserveAccount: isReconciledViaReserve,
    isReconciled: isReconciledViaReserve,
  };
}

function mapSourceCategory(sourceCategory, notes, direction) {
  if (direction === "income") return "Rents";
  const fromSource = suggestCategoryFromText(sourceCategory);
  if (fromSource !== "Uncategorized") return fromSource;
  return suggestCategoryFromText(notes);
}

function classifyFailure(row, columnMap) {
  if (columnMap.date === undefined) return "no_date_column_detected";
  const dateStr = parseDateCell(row[columnMap.date]);
  if (!dateStr) return "unparseable_date";
  return "no_amount_found";
}
