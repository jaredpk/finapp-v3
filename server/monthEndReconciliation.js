// Month-end reconciliation: kids spending split 50/50, plus a share of the
// Verizon bill, with review lists of uncategorized and Health transactions so
// nothing that belongs in the kids bucket is missed.
//
// Everything here is pure (no DB, no Express) so it can be unit-tested. The
// rows come from getMonthEndRows in db.js (split-aware: a split transaction
// arrives as one row per split, each under that split's category).
//
// Money is handled in integer cents throughout; the 50% share is rounded
// half-up to the cent. Amount sign follows the app: positive = spend,
// negative = refund / money in, so refunds reduce the subtotal.

export const DEFAULT_MONTH_END_CONFIG = {
  verizonLines: 2,
  // dollars, per line: exact Oct 2026 bill charge = $30.00 plan + $4.89
  // surcharges + $2.60 taxes/fees
  verizonLineAmount: 37.49,
  // dollars: the account-wide "$20 NURSES DISCOUNT 4+ PHNS" credit, spread
  // evenly over every line on the account (9 lines on the Oct 2026 bill).
  // 0 disables it.
  verizonAccountCredit: 20.0,
  verizonAccountLines: 9,
  share: 0.5,
};

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month) {
  return typeof month === "string" && MONTH_RE.test(month);
}

// The full calendar month before `now`, as 'YYYY-MM' (UTC, like the reports).
export function previousMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

// { startDate, endDate } (YYYY-MM-DD, inclusive) for a valid 'YYYY-MM'.
export function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  return { startDate: first.toISOString().slice(0, 10), endDate: last.toISOString().slice(0, 10) };
}

const toCents = (dollars) => Math.round(Number(dollars) * 100);
const toDollars = (cents) => cents / 100;

// Half-up to the cent. Math.floor(x + 0.5) rounds .5 toward +infinity.
export function shareOfCents(cents, share) {
  return Math.floor(cents * share + 0.5);
}

// Our lines' portion of the account-wide credit: round half-up of
// creditCents * lines / accountLines, in pure integer math on the aggregate.
function creditAllocationCents(creditCents, lines, accountLines) {
  if (!accountLines) return 0;
  return Math.floor((2 * creditCents * lines + accountLines) / (2 * accountLines));
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// "Kids", "Kids - Healthcare", "Healthcare - Kids", "Kids Health", ...
export function isKidsCategory(name) {
  return /\bkids?\b/.test(norm(name));
}

// Health-related categories to review (kids ones are handled separately).
export function isHealthCategory(name) {
  const n = norm(name);
  return !isKidsCategory(n) && /health|medical|dental|vision|pharm|doctor/.test(n);
}

// Exactly "Personal - Jared" (case-insensitive, trimmed). Listed only: never
// part of the kids share, Verizon, total due, or the review lists.
export function isPersonalJaredCategory(name) {
  return norm(name) === "personal - jared";
}

export function isUncategorized(name) {
  return norm(name) === "";
}

// Account label or raw account string that identifies a HealthEquity (HSA) import.
export const HEALTH_EQUITY_RE = /health\s*equity/i;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "Health Equity for October 2026 not imported" (no Date/timezone involved).
export function healthEquityBanner(month) {
  const [y, m] = month.split("-");
  return `Health Equity for ${MONTH_NAMES[Number(m) - 1]} ${y} not imported`;
}

// Rows are already filtered in SQL (not pending, not hidden, not hidden
// account); the pending/hidden checks here are a defensive repeat of that.
function healthEquityStatus(month, rows) {
  const rowCount = rows.filter(
    (r) =>
      r.pending !== true && r.status !== "pending" && r.hidden !== true &&
      (HEALTH_EQUITY_RE.test(String(r.account ?? "")) || HEALTH_EQUITY_RE.test(String(r.account_raw ?? "")))
  ).length;
  const imported = rowCount > 0;
  return { imported, row_count: rowCount, banner: imported ? null : healthEquityBanner(month) };
}

function shapeRow(r) {
  const cents = toCents(r.amount);
  return {
    transaction_id: r.transaction_id ?? null,
    date: r.date,
    merchant: r.merchant ?? "",
    category: r.category ? String(r.category) : "",
    account: r.account ?? "",
    amount: toDollars(cents),
    _cents: cents,
  };
}

const byDate = (a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.transaction_id).localeCompare(String(b.transaction_id));

const publicRow = ({ _cents, ...rest }) => rest;

export function buildMonthEndReconciliation({ month, rows = [], config = {} } = {}) {
  const cfg = { ...DEFAULT_MONTH_END_CONFIG, ...config };
  const shaped = rows.map(shapeRow).sort(byDate);

  const kids = shaped.filter((r) => isKidsCategory(r.category));
  const personalJared = shaped.filter((r) => isPersonalJaredCategory(r.category));
  const uncategorized = shaped.filter((r) => isUncategorized(r.category));
  const health = shaped.filter((r) => isHealthCategory(r.category));

  const kidsSubtotalCents = kids.reduce((s, r) => s + r._cents, 0);
  const personalJaredSubtotalCents = personalJared.reduce((s, r) => s + r._cents, 0);
  const kidsShareCents = shareOfCents(kidsSubtotalCents, cfg.share);

  const lineCents = toCents(cfg.verizonLineAmount);
  const verizonGrossCents = cfg.verizonLines * lineCents;
  const accountCreditCents = toCents(cfg.verizonAccountCredit);
  const creditAllocatedCents = creditAllocationCents(accountCreditCents, cfg.verizonLines, cfg.verizonAccountLines);
  const verizonNetCents = verizonGrossCents - creditAllocatedCents;
  const verizonShareCents = shareOfCents(verizonNetCents, cfg.share);

  const totalDueCents = kidsShareCents + verizonShareCents;

  const money = (c) => toDollars(c);
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;

  return {
    month,
    config: {
      verizonLines: cfg.verizonLines,
      verizonLineAmount: money(lineCents),
      verizonAccountCredit: money(accountCreditCents),
      verizonAccountLines: cfg.verizonAccountLines,
      share: cfg.share,
    },
    kids: {
      rows: kids.map(publicRow),
      subtotal: money(kidsSubtotalCents),
      share: money(kidsShareCents),
    },
    verizon: {
      lines: cfg.verizonLines,
      line_amount: money(lineCents),
      // `total` is the NET (after credit) and `share` the share of net, so
      // existing consumers keep working; gross is in `gross_total`.
      total: money(verizonNetCents),
      share: money(verizonShareCents),
      label: `Verizon: ${cfg.verizonLines} lines x ${fmt(lineCents)} (plan + surcharges + taxes/fees) = ${fmt(verizonGrossCents)}`,
      account_credit_total: money(accountCreditCents),
      account_credit_lines: cfg.verizonAccountLines,
      credit_allocated: money(creditAllocatedCents),
      gross_total: money(verizonGrossCents),
      net_total: money(verizonNetCents),
      credit_label: `Account credit: ${fmt(accountCreditCents)} x ${cfg.verizonLines}/${cfg.verizonAccountLines} lines = -${fmt(creditAllocatedCents)}`,
    },
    total_due: money(totalDueCents),
    health_equity: healthEquityStatus(month, rows),
    personal_jared: {
      rows: personalJared.map(publicRow),
      subtotal: money(personalJaredSubtotalCents),
    },
    review: {
      uncategorized: uncategorized.map(publicRow),
      health: health.map(publicRow),
    },
  };
}

export function monthEndSheetName(month) {
  return `Month-End ${month}`;
}

// Array-of-arrays for the single stacked sheet. Review sections are
// informational and not part of any total.
export function buildMonthEndSheetRows(result) {
  const pct = `${Math.round(result.config.share * 10000) / 100}%`;
  const header = ["Date", "Merchant", "Category", "Account", "Amount"];
  const line = (r) => [r.date, r.merchant, r.category, r.account, r.amount];
  const out = [];

  if (result.health_equity?.banner) {
    out.push([result.health_equity.banner]);
    out.push([]);
  }

  out.push([`KIDS (Kids and Kids health) - ${result.month}`]);
  out.push(header);
  for (const r of result.kids.rows) out.push(line(r));
  out.push(["", "", "", "Subtotal", result.kids.subtotal]);
  out.push(["", "", "", `${pct} share`, result.kids.share]);
  out.push([]);

  out.push(["VERIZON ALLOCATION"]);
  out.push([result.verizon.label, "", "", "", result.verizon.gross_total]);
  out.push([result.verizon.credit_label, "", "", "", -result.verizon.credit_allocated]);
  out.push(["", "", "", "Net Verizon", result.verizon.net_total]);
  out.push(["", "", "", `${pct} share`, result.verizon.share]);
  out.push([]);

  out.push(["", "", "", "TOTAL DUE", result.total_due]);
  out.push([]);

  out.push(["PERSONAL - JARED (listed only - not included in total due)"]);
  out.push(header);
  for (const r of result.personal_jared.rows) out.push(line(r));
  out.push(["", "", "", "Subtotal", result.personal_jared.subtotal]);
  out.push([]);

  out.push(["REVIEW - UNCATEGORIZED (not included in totals)"]);
  out.push(header);
  for (const r of result.review.uncategorized) out.push(line(r));
  out.push([]);

  out.push(["REVIEW - HEALTH (not included in totals)"]);
  out.push(header);
  for (const r of result.review.health) out.push(line(r));

  return out;
}

// Query-string overrides -> config, or { error } for the 400.
export function parseMonthEndConfig({
  verizonLines, verizonLineAmount, verizonAccountCredit, verizonAccountLines,
} = {}) {
  const config = {};
  if (verizonLines !== undefined && verizonLines !== "") {
    const s = String(verizonLines);
    if (!/^\d{1,3}$/.test(s)) return { error: "verizonLines must be a non-negative integer" };
    config.verizonLines = Number(s);
  }
  if (verizonLineAmount !== undefined && verizonLineAmount !== "") {
    const s = String(verizonLineAmount);
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) {
      return { error: "verizonLineAmount must be a non-negative dollar amount with at most 2 decimals" };
    }
    config.verizonLineAmount = Number(s);
  }
  if (verizonAccountCredit !== undefined && verizonAccountCredit !== "") {
    const s = String(verizonAccountCredit);
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) {
      return { error: "verizonAccountCredit must be a non-negative dollar amount with at most 2 decimals" };
    }
    config.verizonAccountCredit = Number(s);
  }
  if (verizonAccountLines !== undefined && verizonAccountLines !== "") {
    const s = String(verizonAccountLines);
    const n = Number(s);
    if (!/^\d{1,3}$/.test(s) || n < 1 || n > 999) {
      return { error: "verizonAccountLines must be an integer from 1 to 999" };
    }
    config.verizonAccountLines = n;
  }
  const lines = config.verizonLines ?? DEFAULT_MONTH_END_CONFIG.verizonLines;
  const accountLines = config.verizonAccountLines ?? DEFAULT_MONTH_END_CONFIG.verizonAccountLines;
  if (accountLines < lines) return { error: "verizonAccountLines must be at least verizonLines" };
  return { config };
}
