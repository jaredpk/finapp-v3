// CSV export for the Transactions view.
//
// This exports what the view is SHOWING — the `filtered` array, after every
// toolbar filter (search, category, account, date range, min/max, awaiting
// approval, show hidden) and in the current sort order. That is deliberate,
// and it is the reason this lives in the client rather than as a sibling of
// /api/export-xlsx: three of those filters have no server-side equivalent.
// Category, in this app, is the user's own assignment (the `assignments` map
// and the `splits` table), not `transactions.plaid_category`, which is what
// getTransactions' `category` parameter matches on; merchant is the user's
// `merchantOverrides` name, not `transactions.merchant`. A server-side export
// would answer a different question with the same words on the button.
//
// The consequence is the cap: the view holds one page of the table (/api/
// transactions returns the 2000 most recent by default), so on an account with
// more than that, a filter — a date range especially — reaches only the loaded
// rows. That is already true of the search box, the filters and "Approve all
// shown", and the view already says so above the toolbar. The export says it
// too, in the button's tooltip and in the filename (`-partial`), because a
// CSV outlives the screen that produced it. Same reasoning as the xlsx
// export's "-TRUNCATED" filename and Export Info sheet (server/limits.js).
//
// Everything above `downloadCsv` is pure and side-effect free so it can be
// unit-tested without a DOM (test/csvExport.test.js).

// ── RFC 4180 quoting, plus the spreadsheet-formula guard ──────────────────────
// Quote when the value contains a comma, a quote or a newline; double any
// quote inside. On top of that: merchant names arrive from bank feeds and from
// the rename box, so a cell can start with a character that Excel, Sheets and
// Numbers treat as the start of a FORMULA rather than as text (=, +, -, @, and
// the two whitespace characters that are stripped before that check). Prefixing
// those with an apostrophe is the standard mitigation — the apostrophe is
// consumed by the spreadsheet, so `=SUM(A1)` still reads as "=SUM(A1)" on
// screen, and a plain-text reader sees one extra character rather than a cell
// that executes.
//
// Applied to strings only. Numbers are formatted by the caller and a negative
// amount must stay `-42.5`, not `'-42.5` — a guarded number would import as
// text and silently break every SUM in the sheet, which is the exact failure
// this export exists to avoid.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CRLF line endings: RFC 4180 specifies them, and Excel on Windows is the
// consumer most likely to be handed this file. A leading UTF-8 BOM is added by
// downloadCsv, not here, so the string this returns stays comparable in tests.
export function buildCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const CSV_HEADERS = [
  "Date",
  "Merchant",
  "Account",
  "Amount (USD)",
  "Category",
  "Split Line",
  "Note",
  "Status",
  "Transaction ID",
];

// Sign convention is the stored one, which the xlsx export also writes raw:
// a positive amount is money out, a negative amount is money in. Split rows
// carry the parent's sign — `splits.amount` is stored as a positive magnitude,
// so a split of a refund would otherwise flip direction and break the column's
// total.
const signedSplitAmount = (parentAmount, splitAmount) => {
  const a = Math.abs(Number(splitAmount) || 0);
  return (Number(parentAmount) || 0) < 0 ? -a : a;
};

function statusOf(t) {
  if (t.hidden) return "Hidden";
  if (t.pending) return "Pending";
  return t.reviewed_at == null ? "Awaiting approval" : "Approved";
}

// One row per transaction, EXCEPT a split transaction, which becomes one row
// per split line. That keeps the two things a spreadsheet is actually used for
// correct: the Amount column sums to the true total, and a pivot on Category
// gives real per-category totals. Collapsing a split into a single row with
// several category names in one cell would break both. "Split Line" ("1 of 2")
// marks the expanded rows; the Transaction ID repeats across them, which is
// what ties them back together.
export function transactionCsvRows({
  transactions = [],
  accountNames = {},
  categoryNames = {},
  assignments = {},
  splits = {},
  merchantOverrides = {},
}) {
  const rows = [];
  for (const t of transactions) {
    const id = t.transaction_id;
    const merchant =
      merchantOverrides?.[id] || t.merchant_name || t.name || t.suggested_category || "Unknown";
    const account = accountNames?.[t.account_id] || t.account_id || "";
    const status = statusOf(t);
    const lines = splits?.[id] || [];

    if (lines.length > 0) {
      lines.forEach((s, i) => {
        rows.push([
          t.date || "",
          merchant,
          account,
          signedSplitAmount(t.amount, s.amount),
          s.category_name || categoryNames?.[s.category_id] || "",
          `${i + 1} of ${lines.length}`,
          s.note || "",
          status,
          id,
        ]);
      });
    } else {
      rows.push([
        t.date || "",
        merchant,
        account,
        Number(t.amount) || 0,
        categoryNames?.[assignments?.[id]] || "",
        "",
        "",
        status,
        id,
      ]);
    }
  }
  return rows;
}

// ── Filename ──────────────────────────────────────────────────────────────────
// The name records what the file IS, because by the time it is opened the
// filter bar that produced it is gone: the date range if one was set, the
// category if one was picked, and `-partial` when the view was holding less
// than the whole table, so an incomplete export stays labelled after it has
// been renamed by a download, mailed on, or filed next to a complete one.
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export function csvFilename({ from, to, categoryLabel, partial, generatedOn } = {}) {
  const parts = ["finapp-transactions"];
  if (from && to) parts.push(`${from}_to_${to}`);
  else if (from) parts.push(`from-${from}`);
  else if (to) parts.push(`to-${to}`);
  if (categoryLabel) {
    const s = slug(categoryLabel);
    if (s) parts.push(s);
  }
  if (generatedOn) parts.push(generatedOn);
  if (partial) parts.push("partial");
  return parts.join("-") + ".csv";
}

// ── Download ──────────────────────────────────────────────────────────────────
// The only part that touches the DOM. The BOM is what makes Excel open a UTF-8
// CSV as UTF-8 rather than as the local ANSI codepage — without it a merchant
// name with an accent or a curly apostrophe arrives mojibaked.
export function downloadCsv(filename, csvText) {
  const blob = new Blob(["﻿" + csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
