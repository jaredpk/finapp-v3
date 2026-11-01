import { createHash } from "crypto";
import xlsxLib from "xlsx";

// HealthEquity "Completed Transactions" export. The file HealthEquity calls
// .xls is really an HTML table (title row, header row, one <tr> per
// transaction), but a real .xlsx/.xls/.csv with the same headers is accepted
// too. Everything here is pure: no DB, no network, no Date objects (a Date
// round-trip is how 1/9/2026 turns into 2026-01-08 on a UTC-negative host).
//
// Sign convention: the FILE says negative = money out of the HSA. The app says
// positive = money out / expense, negative = money in. amountDb is the file
// amount negated; the preview totals are reported in file terms.

export class HealthEquityParseError extends Error {}

export const HE_ACCOUNT_DEFAULT = "HealthEquity HSA";
const REQUIRED_HEADERS = ["date", "transaction", "amount", "hsa cash balance"];

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = HTML_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const cleanText = (s) => decodeEntities(String(s)).replace(/\s+/g, " ").trim();

// Tiny regex table reader: enough for the flat <tr><td> export, and immune to
// the unquoted/odd attributes HealthEquity emits.
function parseHtmlTable(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr\s*>|<\/table\s*>|$)/gi;
  let tr;
  while ((tr = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]\s*>|<\/tr\s*>|$)/gi;
    let td;
    while ((td = tdRe.exec(tr[1]))) cells.push(cleanText(td[1].replace(/<[^>]*>/g, " ")));
    rows.push(cells);
  }
  return rows;
}

const looksLikeHtml = (text) => /<\s*(table|tr|td|html)\b/i.test(text.slice(0, 4096));

function readSheetRows(buf) {
  let wb;
  try {
    wb = xlsxLib.read(buf, { type: "buffer", raw: true });
  } catch {
    throw new HealthEquityParseError("Could not read this file. Upload the HealthEquity transaction export (.xls, .xlsx or .csv).");
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new HealthEquityParseError("The file contains no sheets.");
  return xlsxLib.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false });
}

function toRows(input) {
  const buf = Buffer.isBuffer(input) ? input : typeof input === "string" ? null : Buffer.from(input ?? []);
  if (buf && buf.length === 0) throw new HealthEquityParseError("The file is empty.");
  if (!buf && !input.trim()) throw new HealthEquityParseError("The file is empty.");
  const text = buf ? buf.toString("utf8") : input;
  if (looksLikeHtml(text)) return parseHtmlTable(text);
  // Binary workbooks (xlsx/xls) are not text; csv text goes through SheetJS too
  // so quoting is handled. A string is wrapped in a Buffer for the same call.
  return readSheetRows(buf || Buffer.from(input, "utf8"));
}

// "$1,037.60" / "($135.00)" / "-$5.00" / 12.5 -> integer cents (file sign), or null.
export function parseMoneyToCents(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v ?? "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1).trim(); }
  s = s.replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return neg ? -cents : cents;
}

const pad2 = (n) => String(n).padStart(2, "0");

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

// M/D/YYYY (also M/D/YY, YYYY-MM-DD, and Excel serial numbers) -> 'YYYY-MM-DD'.
// String arithmetic only.
export function parseHeDate(v) {
  let y, m, d;
  if (typeof v === "number") {
    const p = xlsxLib.SSF.parse_date_code(v);
    if (!p) return null;
    ({ y, m, d } = p);
  } else {
    const s = String(v ?? "").trim();
    let mt;
    if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/))) {
      m = +mt[1]; d = +mt[2]; y = +mt[3];
      if (mt[3].length === 2) y += 2000;
    } else if ((mt = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/))) {
      y = +mt[1]; m = +mt[2]; d = +mt[3];
    } else return null;
  }
  if (!validYmd(y, m, d)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function classify(description) {
  const base = description.replace(/\s*\((?:Card Transaction ID|Tax year)[^)]*\)/gi, "").trim();
  if (/^interest\b/i.test(base)) return { kind: "interest", merchant: "Interest" };
  if (/\bcontribution\b/i.test(base)) return { kind: "contribution", merchant: base.split(",")[0].trim() || "Contribution" };
  return { kind: "card", merchant: base.split(",")[0].trim() || base || description };
}

export function healthEquityRowId(date, description, amountCents, balanceCents, occurrence = 1) {
  const h = createHash("sha256")
    .update(`${date}|${description}|${amountCents}|${balanceCents ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return occurrence > 1 ? `csv_he_${h}_${occurrence}` : `csv_he_${h}`;
}

const centsToDollars = (c) => (c === 0 ? 0 : c / 100);

export function parseHealthEquityFile(input) {
  const table = toRows(input);
  const norm = (c) => String(c ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(table.length, 25); i++) {
    const names = (table[i] || []).map(norm);
    if (REQUIRED_HEADERS.every((h) => names.includes(h))) {
      headerIdx = i;
      cols = Object.fromEntries(REQUIRED_HEADERS.map((h) => [h, names.indexOf(h)]));
      break;
    }
  }
  if (headerIdx < 0) {
    throw new HealthEquityParseError(
      "This does not look like a HealthEquity transaction export: could not find the header row (Date, Transaction, Amount, HSA Cash Balance)."
    );
  }

  const rows = [];
  const skipped = [];
  const seen = new Map();
  for (let i = headerIdx + 1; i < table.length; i++) {
    const cells = table[i] || [];
    if (cells.every((c) => String(c ?? "").trim() === "")) continue;
    const rawDate = cells[cols.date] ?? "";
    const description = cleanText(cells[cols.transaction] ?? "");
    const rawAmount = cells[cols.amount] ?? "";
    const rowNo = i + 1;

    if (/^balance forward\b/i.test(description)) {
      skipped.push({ reason: "Balance Forward (opening balance, not a transaction)", row: rowNo });
      continue;
    }
    const date = parseHeDate(rawDate);
    if (!date) { skipped.push({ reason: "unparseable date", row: rowNo, description }); continue; }
    const amountCents = parseMoneyToCents(rawAmount);
    if (amountCents === null) { skipped.push({ reason: "unparseable amount", row: rowNo, description }); continue; }
    if (!description) { skipped.push({ reason: "missing description", row: rowNo }); continue; }
    const balanceCents = parseMoneyToCents(cells[cols["hsa cash balance"]] ?? "");

    const key = `${date}|${description}|${amountCents}|${balanceCents ?? ""}`;
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);
    const { kind, merchant } = classify(description);
    rows.push({
      id: healthEquityRowId(date, description, amountCents, balanceCents, occurrence),
      date,
      description,
      merchant,
      kind,
      amountDb: centsToDollars(-amountCents),
      balance: balanceCents === null ? null : centsToDollars(balanceCents),
    });
  }
  return { rows, skipped };
}

// Pure preview math. existingIds: Set/array of ids already in transactions.
export function buildHealthEquityPreview({ filename, rows, skipped, existingIds = [] }) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const toCents = (n) => Math.round(n * 100);
  let spend = 0, contributions = 0, interest = 0, already = 0;
  const byMonth = new Map();
  let from = null, to = null;
  for (const r of rows) {
    if (existing.has(r.id)) already++;
    const c = toCents(r.amountDb);
    if (r.kind === "card") spend += c;
    else if (r.kind === "contribution") contributions -= c;
    else interest -= c;
    const month = r.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    if (from === null || r.date < from) from = r.date;
    if (to === null || r.date > to) to = r.date;
  }
  const reasons = new Map();
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) || 0) + 1);
  return {
    filename: filename || null,
    total_rows: rows.length + skipped.length,
    importable: rows.length,
    new_rows: rows.length - already,
    already_imported: already,
    skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
    date_range: { from, to },
    totals: {
      spend: centsToDollars(spend),
      contributions: centsToDollars(contributions),
      interest: centsToDollars(interest),
    },
    by_month: [...byMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, count]) => ({ month, count })),
  };
}
