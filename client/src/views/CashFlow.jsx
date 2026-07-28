import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  fetchCashflowPresets, saveCashflowPreset, deleteCashflowPreset,
  fetchCashflowStates, saveCashflowState,
  fetchCashflowMappings, saveCashflowMapping,
  fetchTransactionsForMonth,
  fetchAccounts,
  fetchAccountBalances,
  saveAssignment, createCategoryApi,
} from "../api";

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n, showSign = false) => {
  if (n == null) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (showSign && n > 0) return `+$${abs}`;
  if (n < 0) return `($${abs})`;
  return `$${abs}`;
};

const fmtShort = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `($${abs})` : `$${abs}`;
};

// Excel accounting-style format: $4,009 / ($1,900) — cents shown only when present.
const fmtAccounting = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return n < 0 ? `($${abs})` : `$${abs}`;
};

// Parses spreadsheet-style amount input: "-1900", "1900", "(1900)", "$1,900".
// Unsigned input inherits the sign of the previous amount (typing "250" into a
// cell showing ($250) keeps it an expense); explicit "-", "+" or parens win.
// Returns null for input that can't be parsed.
function parseAmountInput(raw, prevAmount) {
  let s = String(raw).trim();
  if (!s) return null;
  let sign = null;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
  else if (s.startsWith("+")) { sign = 1; s = s.slice(1); }
  if (!s || /[^0-9.]/.test(s)) return null;
  const n = parseFloat(s);
  if (isNaN(n) || !isFinite(n)) return null;
  if (sign === null) sign = prevAmount < 0 ? -1 : 1;
  return sign * Math.abs(n);
}

// Column order for Excel-style cell navigation in AccountTable (drag handle and
// delete column are intentionally excluded from keyboard navigation).
const NAV_COLS = ["day", "name", "freq", "amount", "running", "pending", "confirmed"];
const EDITABLE_COLS = new Set(["day", "amount"]);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const FREQS = ["Monthly","Bi-Monthly","Bi-Weekly","Weekly","One Time","As Needed","Quarterly"];

function toMonthKey(year, monthIdx) {
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
}

// ── Default template data ─────────────────────────────────────────────────────
const DEFAULT_ACCOUNTS = [
  {
    id: "amex",
    name: "Amex Checking",
    defaultStart: 1712,
    transactions: [
      { id: 1,  day: 1,  name: "Personal Jared",                  freq: "Monthly",    amount: -500,    isTransfer: true                        },
      { id: 2,  day: 5,  name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009                                             },
      { id: 3,  day: 7,  name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,   isTransfer: true                        },
      { id: 4,  day: 10, name: "UESP",                            freq: "Monthly",    amount: -100                                             },
      { id: 5,  day: 19, name: "Transfer Reserve Account",        freq: "Monthly",    amount: -500                                             },
      { id: 6,  day: 20, name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009                                             },
      { id: 7,  day: 24, name: "Jared Transfer to Personal Macu", freq: "Monthly",    amount: -629.84, isTransfer: true                        },
      { id: 8,  day: 27, name: "Transfer to Long-Term Purchases", freq: "Monthly",    amount: -250                                             },
      { id: 9,  day: 27, name: "Transfer to Emergency Fund",      freq: "Monthly",    amount: -250                                             },
      { id: 10, day: 27, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,   isTransfer: true                        },
      { id: 11, day: 28, name: "Transfer to Joint Savings",       freq: "Monthly",    amount: -385                                             },
      { id: 12, day: 30, name: "Transfer for PTO Reserve",        freq: "Monthly",    amount: -320                                             },
      { id: 13, day: 30, name: "Personal IRA Transfer",           freq: "Monthly",    amount: -500                                             },
      { id: 14, day: 30, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,   isTransfer: true, defaultPending: true  },
      { id: 15, day: 30, name: "Paycheck (Month End)",            freq: "Monthly",    amount: 4009,                     defaultPending: true  },
      { id: 16, day: 1,  name: "Supplementary Transfer In",       freq: "As Needed",  amount: 0                                               },
      { id: 17, day: 1,  name: "Extra Transfer Out",              freq: "As Needed",  amount: 0                                               },
    ],
  },
  {
    id: "macu",
    name: "MACU Checking",
    defaultStart: 1500,
    transactions: [
      { id: 1, day: 5,  name: "Child Support Out",         freq: "Bi-Monthly", amount: -314.93                    },
      { id: 2, day: 19, name: "Child Support Out",         freq: "Bi-Monthly", amount: -314.93                    },
      { id: 3, day: 23, name: "Jared Transfer (Personal)", freq: "Monthly",    amount: 629.84,  isTransfer: true  },
    ],
  },
  {
    id: "shared",
    name: "Shared Checking",
    defaultStart: 3610,
    transactions: [
      { id: 1,  day: 1,  name: "Other Misc. Shared",       freq: "Bi-Monthly", amount: -500                       },
      { id: 2,  day: 1,  name: "House Payment",            freq: "Bi-Monthly", amount: -2017                      },
      { id: 3,  day: 2,  name: "Personal Jared In",          freq: "Monthly",    amount: 500,    isTransfer: true   },
      { id: 4,  day: 7,  name: "Jared Transfer In",        freq: "Monthly",    amount: 1900,   isTransfer: true   },
      { id: 5,  day: 12, name: "Alta Transfer",            freq: "Bi-Weekly",  amount: 1500                       },
      { id: 6,  day: 15, name: "Car Payment",              freq: "Monthly",    amount: -500                       },
      { id: 7,  day: 24, name: "Alta Transfer",            freq: "Bi-Weekly",  amount: 1500                       },
      { id: 8,  day: 24, name: "Transfer for Credit Card", freq: "Monthly",    amount: -6000                      },
      { id: 9,  day: 28, name: "Jared Transfer In",        freq: "Monthly",    amount: 1900,   isTransfer: true   },
      { id: 10, day: 28, name: "Misc. Utilities",          freq: "Monthly",    amount: -500                       },
      { id: 11, day: 30, name: "Jared Transfer In",        freq: "Monthly",    amount: 1900,   isTransfer: true,  defaultPending: true },
      { id: 12, day: 30, name: "Alta Transfer",            freq: "Bi-Weekly",  amount: 1500,                      defaultPending: true },
      { id: 13, day: 1,  name: "Extra Transfer In",        freq: "As Needed",  amount: 0,      isTransfer: true   },
    ],
  },
];

const ALL_ROWS = DEFAULT_ACCOUNTS.flatMap(acct =>
  acct.transactions.map(t => ({
    accountId: acct.id,
    accountName: acct.name,
    txnId: t.id,
    txnName: t.name,
    txnDay: t.day,
    defaultAmount: t.amount,
  }))
);

const DEFAULT_FIXED = [
  { name: "Paycheck",                           amount: 4009,    freq: "Bi-Monthly", note: "Take-home w/ 15% into 401k" },
  { name: "Child Support Out",                  amount: -314.93, freq: "Bi-Monthly", note: "" },
  { name: "UESP",                               amount: -100,    freq: "Monthly",    note: "" },
  { name: "Transfer for PTO Reserve",           amount: -320,    freq: "Monthly",    note: "" },
  { name: "Alta Transfer",                      amount: 1500,    freq: "Bi-Monthly", note: "" },
  { name: "Jared Transfer to Shared",           amount: -1900,   freq: "Monthly",    note: "" },
  { name: "Jared Transfer to Personal Macu",    amount: -629.84, freq: "Monthly",    note: "Ashton/Brooklyn" },
  { name: "House Payment",                      amount: -2017,   freq: "Monthly",    note: "" },
  { name: "Transfer to Joint Savings",          amount: -385,    freq: "Monthly",    note: "" },
  { name: "Misc. Utilities",                    amount: -500,    freq: "Monthly",    note: "" },
  { name: "Transfer to Long-Term Purchases",    amount: -250,    freq: "Monthly",    note: "" },
  { name: "Transfer to Emergency Fund",         amount: -250,    freq: "Monthly",    note: "" },
  { name: "Transfer Reserve Account",           amount: -500,    freq: "Monthly",    note: "" },
  { name: "Personal IRA Transfer",              amount: -500,    freq: "Monthly",    note: "" },
  { name: "Car Payment",                        amount: -500,    freq: "Monthly",    note: "" },
];

// ── Credit Card Data ──────────────────────────────────────────────────────────
const CC_CARDS = [
  { id: "vcx",  label: "Venture X", dueDate: "12th–11th Each Month" },
  { id: "plat", label: "Platinum",  dueDate: "16th–17th Each Month" },
];

const DEFAULT_CC_CONFIG = {
  vcx:  { payment: 3000, recurring: 400, recurringNote: "Insurance on the 5th of each month", other: 500, defaultBalance: 2100 },
  plat: { payment: 1000, recurring: 0,   recurringNote: "",                                    other: 500, defaultBalance: 500  },
};

// When a preset is saved for these names, the paired name gets the negated amount automatically.
const TRANSFER_MIRRORS = {
  "Jared Transfer to Shared":  "Jared Transfer In",
  "Jared Transfer In":         "Jared Transfer to Shared",
  "Personal Jared":            "Personal Jared In",
  "Personal Jared In":         "Personal Jared",
  "Extra Transfer Out":        "Extra Transfer In",
  "Extra Transfer In":         "Extra Transfer Out",
};

// ── 3-paycheck month detection ────────────────────────────────────────────────
function computeThreePaycheckMonths(year, baseDateNum) {
  const by = Math.floor(baseDateNum / 10000);
  const bm = Math.floor((baseDateNum % 10000) / 100) - 1;
  const bd = baseDateNum % 100;
  const base = new Date(by, bm, bd);
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const diffDays = Math.floor((yearStart - base) / 86400000);
  const offsetCycles = Math.ceil(diffDays / 14);
  let current = new Date(base.getTime() + offsetCycles * 14 * 86400000);
  const count = {};
  while (current <= yearEnd) {
    if (current.getFullYear() === year) {
      const m = current.getMonth();
      count[m] = (count[m] || 0) + 1;
    }
    current = new Date(current.getTime() + 14 * 86400000);
  }
  return new Set(
    Object.entries(count).filter(([, c]) => c >= 3).map(([m]) => parseInt(m))
  );
}

function baseDateToDisplay(num) {
  const y = Math.floor(num / 10000);
  const m = Math.floor((num % 10000) / 100);
  const d = num % 100;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function displayToBaseDateNum(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return y * 10000 + m * 100 + d;
}

// ── Matching algorithm ────────────────────────────────────────────────────────
function scoreMatch(plaidTxn, row, presetsMap) {
  const plaidCashflowAmt = -plaidTxn.amount;
  const expectedAmt = presetsMap[row.txnName] ?? row.defaultAmount;
  const plaidDay = new Date(plaidTxn.date + "T12:00:00").getDate();
  const merchant = (plaidTxn.merchant_name || plaidTxn.name || "").toLowerCase();

  let score = 0;
  if ((plaidCashflowAmt > 0) !== (expectedAmt > 0)) return -99;

  if (Math.abs(expectedAmt) > 0) {
    const ratio = Math.abs(plaidCashflowAmt) / Math.abs(expectedAmt);
    if (ratio >= 0.97 && ratio <= 1.03) score += 5;
    else if (ratio >= 0.9 && ratio <= 1.1) score += 2;
  }

  const dayDiff = Math.abs(plaidDay - row.txnDay);
  if (dayDiff === 0) score += 3;
  else if (dayDiff <= 2) score += 2;
  else if (dayDiff <= 5) score += 1;

  const txnWords = row.txnName.toLowerCase().split(/[\s_\-&.,]+/).filter(w => w.length > 3);
  const overlap = txnWords.filter(w => merchant.includes(w)).length;
  score += Math.min(overlap * 2, 4);

  return score;
}

// Generic financial words that appear in many account names and must not drive matching
const GENERIC_ACCT_WORDS = new Set(["checking", "savings", "account", "credit", "debit", "draft"]);

function matchPlaidToAccount(plaidName, institutionName, acctId, acctDisplayName) {
  const p = plaidName.toLowerCase();
  const inst = (institutionName || "").toLowerCase();

  // Institution-specific matching for the three known cashflow accounts
  if (acctId === "amex") return inst.includes("american express");
  if (acctId === "macu") {
    // MACU personal: must be Mountain America, and must NOT look like the shared account
    if (!inst.includes("mountain america")) return false;
    if (p.includes("share") || p.includes("joint")) return false;
    return true;
  }
  if (acctId === "shared") {
    // Shared checking: Mountain America account with a shared/joint indicator in the name,
    // OR any account whose (possibly nicknames-applied) name contains "shared"
    if (inst.includes("mountain america") && (p.includes("share") || p.includes("joint"))) return true;
    return p.includes("shared");
  }

  // Generic fallback for any other account IDs — exclude common financial words to avoid
  // false matches (e.g. "checking" appearing in unrelated account names)
  if (p.includes(acctId.toLowerCase())) return true;
  return acctDisplayName.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC_ACCT_WORDS.has(w))
    .some(w => p.includes(w));
}

// Match imported account_balances row to a cashflow account ID
function matchImportedBalance(row, acctId) {
  const name = (row.account || "").toLowerCase();
  const inst = (row.institution || "").toLowerCase();
  const type = (row.type || "").toLowerCase();
  if (acctId === "amex") return inst.includes("american express") && type === "checking";
  if (acctId === "macu") return inst.includes("mountain america") && type === "checking" && (name.includes("personal") || name.includes("myfree") || name.includes("macu"));
  if (acctId === "shared") return name.includes("shared") && type === "checking";
  return false;
}

// ── Auto-Match helpers ──────────────────────────────────────────────────────────
// Days since epoch, for comparing transaction dates independent of timezone.
const dayNumber = (dateStr) => Math.floor(new Date((dateStr || "").slice(0, 10) + "T12:00:00").getTime() / 86400000);
const merchantLabel = (txn) => txn.merchant_name || txn.name || "Unknown";
// Normalized merchant key for grouping recurring charges — strips digits, punctuation, and common payment-processor noise words.
function merchantKey(txn) {
  return merchantLabel(txn)
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\b(payment|pmt|ach|pos|debit|credit|purchase|recurring|autopay|auto|web|online|id|ref|xx+|x+)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds outflow/inflow transaction pairs across different accounts with equal
// (opposite-signed) amounts within a few days of each other — i.e. transfers
// between your own accounts, so both sides can be tagged "Transfer" together.
function findTransferMatches(transactions) {
  const candidates = transactions.filter((t) => !t.hidden && t.account_id && Math.abs(t.amount) >= 1 && t.date);
  const inflows = candidates.filter((t) => t.amount > 0).sort((a, b) => (a.date < b.date ? 1 : -1));
  const outflows = candidates.filter((t) => t.amount < 0);
  const usedOutflowIds = new Set();
  const matches = [];
  for (const inTxn of inflows) {
    let best = null;
    let bestDayDiff = 4; // must be within 4 days to count as a match
    for (const outTxn of outflows) {
      if (usedOutflowIds.has(outTxn.transaction_id)) continue;
      if (outTxn.account_id === inTxn.account_id) continue;
      if (Math.abs(inTxn.amount + outTxn.amount) > 0.01) continue;
      const dayDiff = Math.abs(dayNumber(inTxn.date) - dayNumber(outTxn.date));
      if (dayDiff < bestDayDiff) { best = outTxn; bestDayDiff = dayDiff; }
    }
    if (best) {
      usedOutflowIds.add(best.transaction_id);
      matches.push({ key: `xfer_${inTxn.transaction_id}_${best.transaction_id}`, out: best, in: inTxn, amount: Math.abs(inTxn.amount), dayDiff: bestDayDiff });
    }
  }
  return matches.sort((a, b) => (a.out.date < b.out.date ? 1 : -1));
}

// Groups transactions by normalized merchant + direction, then flags groups
// whose intervals cluster around a known cadence (weekly/bi-weekly/monthly/
// quarterly) as likely recurring charges (paychecks, card payments, etc).
function findRecurringGroups(transactions, excludeIds) {
  const groups = {};
  for (const t of transactions) {
    if (t.hidden || excludeIds.has(t.transaction_id) || !t.date || Math.abs(t.amount) < 1) continue;
    const key = merchantKey(t);
    if (key.length < 3) continue;
    const groupKey = `${t.amount > 0 ? "out" : "in"}|${key}`;
    (groups[groupKey] = groups[groupKey] || []).push(t);
  }
  const CADENCES = [
    { label: "weekly", days: 7 },
    { label: "bi-weekly", days: 14 },
    { label: "monthly", days: 30 },
    { label: "quarterly", days: 91 },
  ];
  const results = [];
  for (const [groupKey, txns] of Object.entries(groups)) {
    if (txns.length < 3) continue;
    const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : 1));
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) intervals.push(dayNumber(sorted[i].date) - dayNumber(sorted[i - 1].date));
    const medianInterval = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    let cadence = null;
    for (const c of CADENCES) {
      const withinTolerance = intervals.filter((d) => Math.abs(d - c.days) <= c.days * 0.3).length / intervals.length;
      if (withinTolerance >= 0.6) { cadence = c.label; break; }
    }
    if (!cadence) continue;
    const amounts = sorted.map((t) => Math.abs(t.amount));
    results.push({
      key: groupKey,
      txns: sorted,
      merchant: merchantLabel(sorted[sorted.length - 1]),
      direction: groupKey.startsWith("out") ? "expense" : "income",
      cadence,
      count: sorted.length,
      minAmt: Math.min(...amounts),
      maxAmt: Math.max(...amounts),
      medianInterval,
    });
  }
  return results.sort((a, b) => b.count - a.count);
}

// ── Summary helper ────────────────────────────────────────────────────────────
function computeSummary(accounts, effectiveAmtFn, isThreePaycheck) {
  let takeHome = 0, expenses = 0;
  accounts.forEach(a => {
    a.transactions.filter(t => !t.defaultPending || isThreePaycheck).forEach(t => {
      const amt = effectiveAmtFn(t, a.id);
      if (!t.isTransfer && amt > 0) takeHome += amt;
      if (!t.isTransfer && amt < 0) expenses += amt;
    });
  });
  return { takeHome, expenses, freeCashflow: takeHome + expenses };
}

// ── Projected ending balance helper ──────────────────────────────────────────
function computeProjectedEndBals(accounts, startBals, effectiveAmtFn, isThreePaycheck, monthStates) {
  const result = {};
  accounts.forEach(acct => {
    const start = startBals[acct.id] ?? acct.defaultStart;
    const sorted = [...acct.transactions].sort((a, b) => a.day - b.day);
    const filtered = sorted.filter(t => !t.defaultPending || isThreePaycheck);
    let running = start;
    filtered.forEach(t => {
      // Use confirmed (non-pending) balance as the carry-forward to the next month
      const stateKey = `${acct.id}_${t.id}`;
      const state = monthStates?.[stateKey] ?? {};
      const isPending = state.isPending !== undefined
        ? state.isPending
        : !!(t.defaultPending && isThreePaycheck);
      if (!isPending) running += effectiveAmtFn(t, acct.id);
    });
    result[acct.id] = running;
  });
  return result;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MonthBadge({ label }) {
  return (
    <div style={styles.monthBadge}>
      <span style={styles.monthLabel}>{label}</span>
    </div>
  );
}

function SummaryBar({ takeHome, expenses, freeCashflow, labels }) {
  const [inLabel, outLabel, netLabel] = labels ?? ["Take-Home Income", "Est. Expenses", "Free Cashflow"];
  const rows = [
    { label: inLabel,  value: takeHome,     color: "var(--green)" },
    { label: outLabel, value: expenses,     color: "var(--red)" },
    { label: netLabel, value: freeCashflow, color: freeCashflow >= 0 ? "var(--accent)" : "var(--red)" },
  ];
  return (
    <table className="cf-grid" style={styles.summaryTable}>
      <thead>
        <tr><th colSpan={2} style={styles.summaryHeadCell}>Monthly Cashflow</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} style={{ background: "var(--surface)" }}>
            <td style={styles.summaryLabelCell}>{row.label}</td>
            <td style={{ ...styles.summaryValCell, color: row.color }}>{fmtAccounting(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// `compact` is accepted (used in the "All Accounts" tab, which shows every account
// side by side) but currently has no visual effect — the original compact styling
// couldn't be reliably reconstructed from minified code, so this renders full-size.
function AccountTable({ account, startingBalance, allowEditStart, isLinked, presetsMap, monthStates, monthAmounts, dynamicAmounts, isThreePaycheckMonth, onTogglePending, onEditNote, onEditAmount, onCommitMonthAmount, onUpdateDay, onEditStart, onLinkAccount, onAddRow, onDeleteRow, txnOrder, onReorder, compact }) {
  const [dragOverId, setDragOverId] = useState(null);
  const [noteEditId, setNoteEditId] = useState(null);
  const [noteEditVal, setNoteEditVal] = useState("");
  const dragItemId = useRef(null);
  // Excel-style active cell + in-cell edit state
  const [sel, setSel] = useState(null);   // { row, col }
  const [edit, setEdit] = useState(null); // { row, col, value }
  const containerRef = useRef(null);
  const skipBlurRef = useRef(false);

  // Use custom drag order if set, otherwise sort by day
  let filtered;
  if (txnOrder) {
    const sortedByOrder = [...account.transactions].sort((a, b) => {
      const ai = txnOrder.indexOf(a.id);
      const bi = txnOrder.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    filtered = sortedByOrder.filter(t => !t.defaultPending || isThreePaycheckMonth);
  } else {
    const sorted = [...account.transactions].sort((a, b) => {
      const aDay = monthStates[`${account.id}_${a.id}`]?.actualDay ?? a.day;
      const bDay = monthStates[`${account.id}_${b.id}`]?.actualDay ?? b.day;
      return aDay - bDay;
    });
    filtered = sorted.filter(t => !t.defaultPending || isThreePaycheckMonth);
  }

  // Keep a ref so handleDrop always reads the latest filtered order, not a stale closure
  const filteredRef = useRef([]);
  filteredRef.current = filtered;

  const handleDragStart = (e, id) => {
    dragItemId.current = id;
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragEnter = (id) => setDragOverId(id);
  const handleDragEnd = () => { setDragOverId(null); dragItemId.current = null; };
  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const fromId = dragItemId.current;
    if (!fromId || fromId === targetId) { setDragOverId(null); return; }
    const rows = filteredRef.current;
    const ids = rows.map(t => t.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) { setDragOverId(null); return; }
    const newOrder = [...ids];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, fromId);

    // Compute interpolated day for the dragged item based on its new neighbours
    const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));
    const dropIdx = newOrder.indexOf(fromId);
    const prevRow = dropIdx > 0 ? rowMap[newOrder[dropIdx - 1]] : null;
    const nextRow = dropIdx < newOrder.length - 1 ? rowMap[newOrder[dropIdx + 1]] : null;
    const prevDay = prevRow ? (prevRow.displayDay ?? prevRow.day) : 1;
    const nextDay = nextRow ? (nextRow.displayDay ?? nextRow.day) : 31;
    const newDay = Math.max(1, Math.min(31, Math.round((prevDay + nextDay) / 2)));

    onReorder(account.id, newOrder);
    if (onUpdateDay) onUpdateDay(account.id, fromId, newDay);
    setDragOverId(null);
  };
  const effectiveAmt = (t) => {
    const key = `${account.id}_${t.id}`;
    if (dynamicAmounts && dynamicAmounts[t.name] != null) return dynamicAmounts[t.name];
    if (monthAmounts?.[key] != null) return monthAmounts[key];
    return presetsMap[t.name] ?? t.amount;
  };

  let running = startingBalance;    // all items: full month projection
  let confirmed = startingBalance;  // N items only: projection from real bank balance
  const rows = filtered.map((t) => {
    const state = monthStates[`${account.id}_${t.id}`] || {};
    const displayDay = state.actualDay ?? t.day;
    const isPending = state.isPending !== undefined
      ? state.isPending
      : !!(t.defaultPending && isThreePaycheckMonth);
    const amt = effectiveAmt(t);
    running += amt;                    // always accumulate (full picture)
    if (!isPending) confirmed += amt;  // Y already counted → skip; N not yet → accumulate
    return { ...t, displayDay, effectiveAmt: amt, isPending, note: state.note ?? null, runningBalance: running, confirmedBalance: confirmed };
  });

  const endBal = rows.length ? rows[rows.length - 1].runningBalance : startingBalance;

  // Track minimum balance and which day it occurs
  let minBal = startingBalance;
  let minDay = null;
  rows.forEach(r => {
    if (r.runningBalance < minBal) { minBal = r.runningBalance; minDay = r.displayDay; }
  });

  const pendingRows = rows.filter((r) => r.isPending);
  const nRows = rows.filter((r) => !r.isPending);
  const nTotal = nRows.reduce((s, r) => s + r.effectiveAmt, 0);

  const minColor = minBal < 0 ? "var(--red)" : minBal < 500 ? "var(--accent)" : "var(--muted)";

  // ── Excel-style cell selection + in-cell editing ────────────────────────────
  const moveSel = (dr, dc) => {
    setSel(s => {
      if (!s) return s;
      const r = Math.max(0, Math.min(rows.length - 1, s.row + dr));
      const ci = Math.max(0, Math.min(NAV_COLS.length - 1, NAV_COLS.indexOf(s.col) + dc));
      return { row: r, col: NAV_COLS[ci] };
    });
  };

  const selectCell = (r, colKey) => {
    setSel({ row: r, col: colKey });
    containerRef.current?.focus();
  };

  // F2 / double-click / Enter: start editing with the current content preserved
  const startEditPreserve = (r, colKey) => {
    const row = rows[r];
    if (!row || !EDITABLE_COLS.has(colKey)) return;
    setSel({ row: r, col: colKey });
    setEdit({ row: r, col: colKey, value: colKey === "day" ? String(row.displayDay) : String(row.effectiveAmt) });
  };

  const commitEdit = (dr = 0, dc = 0, refocus = true) => {
    if (!edit) return;
    const row = rows[edit.row];
    if (row) {
      if (edit.col === "day") {
        const n = parseInt(String(edit.value).trim(), 10);
        if (!isNaN(n)) onUpdateDay(account.id, row.id, Math.max(1, Math.min(31, n)));
        // invalid input → revert (no commit)
      } else if (edit.col === "amount") {
        const parsed = parseAmountInput(edit.value, row.effectiveAmt);
        if (parsed != null && onCommitMonthAmount) onCommitMonthAmount(account.id, row.id, parsed);
        // invalid input → revert (no commit)
      }
    }
    setEdit(null);
    if (dr || dc) moveSel(dr, dc);
    if (refocus) containerRef.current?.focus();
  };

  const cancelEdit = () => { setEdit(null); containerRef.current?.focus(); };

  const handleEditKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter")      { e.preventDefault(); skipBlurRef.current = true; commitEdit(e.shiftKey ? -1 : 1, 0); }
    else if (e.key === "Tab")   { e.preventDefault(); skipBlurRef.current = true; commitEdit(0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); skipBlurRef.current = true; cancelEdit(); }
  };

  const handleEditBlur = () => {
    if (skipBlurRef.current) { skipBlurRef.current = false; return; }
    commitEdit(0, 0, false);
  };

  const handleGridKeyDown = (e) => {
    if (edit) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // e.g. note editing
    if (!sel) return;
    const row = rows[sel.row];
    if (!row) return;
    const k = e.key;
    if (k === "ArrowUp")         { e.preventDefault(); moveSel(-1, 0); }
    else if (k === "ArrowDown")  { e.preventDefault(); moveSel(1, 0); }
    else if (k === "ArrowLeft")  { e.preventDefault(); moveSel(0, -1); }
    else if (k === "ArrowRight") { e.preventDefault(); moveSel(0, 1); }
    else if (k === "Tab")        { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1); }
    else if (k === "F2")         { e.preventDefault(); startEditPreserve(sel.row, sel.col); }
    else if (k === "Enter") {
      e.preventDefault();
      if (sel.col === "pending") onTogglePending(account.id, row.id);
      else if (EDITABLE_COLS.has(sel.col)) startEditPreserve(sel.row, sel.col);
      else moveSel(e.shiftKey ? -1 : 1, 0);
    }
    else if (sel.col === "pending" && (k === " " || k.toLowerCase() === "y" || k.toLowerCase() === "n")) {
      e.preventDefault();
      const want = k === " " ? !row.isPending : k.toLowerCase() === "y";
      if (row.isPending !== want) onTogglePending(account.id, row.id);
    }
    else if (k === "Delete" || k === "Backspace") { e.preventDefault(); } // no destructive clearing
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && EDITABLE_COLS.has(sel.col)) {
      // Excel type-to-overwrite: typed character replaces the content
      e.preventDefault();
      setEdit({ row: sel.row, col: sel.col, value: k });
    }
  };

  const isSel = (r, colKey) => sel && sel.row === r && sel.col === colKey;
  const isEditingCell = (r, colKey) => edit && edit.row === r && edit.col === colKey;
  const selStyle = (r, colKey) => (isSel(r, colKey) ? { boxShadow: "inset 0 0 0 2px var(--accent)" } : null);

  const cellClick = (r, colKey) => {
    if (isEditingCell(r, colKey)) return;
    if (colKey === "pending" && isSel(r, colKey)) { onTogglePending(account.id, rows[r].id); return; }
    selectCell(r, colKey);
  };

  const editInput = (colKey) => (
    <input
      autoFocus
      value={edit.value}
      onChange={(e) => setEdit(ed => ({ ...ed, value: e.target.value }))}
      onFocus={(e) => { const v = e.target.value; e.target.setSelectionRange(v.length, v.length); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleEditKeyDown}
      onBlur={handleEditBlur}
      style={{ ...styles.cellInput, textAlign: colKey === "day" ? "center" : "right" }}
    />
  );

  return (
    <div style={styles.accountBlock}>
      <div style={styles.accountHeader}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <p style={{ ...styles.accountName, marginBottom: 0 }}>{account.name}</p>
            <button
              onClick={onLinkAccount}
              title={isLinked ? "Plaid account linked — click to change" : "Link a Plaid account for automatic balance"}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "1px 5px",
                fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600,
                color: isLinked ? "var(--green)" : "var(--muted)",
                borderRadius: 4, border: `1px solid ${isLinked ? "var(--green)" : "var(--border2)"}`,
                opacity: isLinked ? 1 : 0.7, lineHeight: 1.4,
              }}
            >
              {isLinked ? "plaid ✓" : "link plaid"}
            </button>
          </div>
          <p
            style={{
              ...styles.accountStartBal,
              cursor: allowEditStart ? "pointer" : "default",
              borderBottom: allowEditStart ? "1px dashed var(--border2)" : "none",
            }}
            onClick={allowEditStart ? onEditStart : undefined}
            title={allowEditStart ? "Click to edit starting balance" : "Projected from prior month"}
          >
            Starting: {fmt(startingBalance)}
            {!allowEditStart && <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6, opacity: 0.6 }}>projected</span>}
          </p>
        </div>
        <div style={{ textAlign: "right", display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div>
            <p style={styles.accountEndLabel}>Est. Min</p>
            <p style={{ ...styles.accountEndBal, fontSize: 18, color: minColor }}>{fmtShort(minBal)}</p>
            {minDay != null && (
              <p style={{ fontSize: 10, color: minColor, fontFamily: "var(--font-mono)", marginTop: 2, fontWeight: minBal < 500 ? 600 : 400 }}>
                day {minDay}
              </p>
            )}
          </div>
          <div>
            <p style={styles.accountEndLabel}>Est. Ending</p>
            <p style={{ ...styles.accountEndBal, color: endBal >= 0 ? "var(--green)" : "var(--red)" }}>{fmtShort(endBal)}</p>
          </div>
        </div>
      </div>

      {pendingRows.length > 0 && (
        <div style={styles.pendingBar}>
          <span style={styles.pendingDot} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {pendingRows.length} done · {nRows.length} remaining ·{" "}
            <span style={{ color: "var(--accent)" }}>conf. projected ending: {fmt(confirmed)}</span>
          </span>
        </div>
      )}

      <div ref={containerRef} tabIndex={0} onKeyDown={handleGridKeyDown} style={styles.tableWrap}>
        <table className="cf-grid" style={styles.grid}>
          <colgroup>
            <col style={{ width: 18 }} />
            <col style={{ width: 34 }} />
            <col />
            <col style={{ width: 72 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 24 }} />
          </colgroup>
          <thead>
            <tr>
              <th style={styles.gridHeadCell} />
              <th style={{ ...styles.gridHeadCell, textAlign: "center" }}>Day</th>
              <th style={styles.gridHeadCell}>Transaction</th>
              <th style={styles.gridHeadCell}>Freq</th>
              <th style={{ ...styles.gridHeadCell, textAlign: "right" }}>Amount</th>
              <th style={{ ...styles.gridHeadCell, textAlign: "right" }}>Running Bal</th>
              <th style={{ ...styles.gridHeadCell, textAlign: "center" }}>Done</th>
              <th style={{ ...styles.gridHeadCell, textAlign: "right" }}>Conf. Bal</th>
              <th style={styles.gridHeadCell} />
            </tr>
          </thead>
          <tbody>
            {rows.map((t, r) => (
              <tr
                key={t.id}
                onDragEnter={() => handleDragEnter(t.id)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, t.id)}
                style={{ background: dragOverId === t.id ? "rgba(240,180,41,0.1)" : t.isPending ? "rgba(240,180,41,0.04)" : "var(--surface)" }}
              >
                <td style={{ ...styles.gridCell, padding: 0, textAlign: "center" }}>
                  <span
                    className="cf-hover-show"
                    draggable
                    onDragStart={(e) => handleDragStart(e, t.id)}
                    style={styles.dragHandle}
                    title="Drag to reorder"
                  >⠿</span>
                </td>
                <td
                  onClick={() => cellClick(r, "day")}
                  onDoubleClick={() => startEditPreserve(r, "day")}
                  style={{ ...styles.gridNumCell, textAlign: "center", color: t.displayDay !== t.day ? "var(--accent)" : "var(--muted)", ...selStyle(r, "day") }}
                  title={t.displayDay !== t.day ? `Template day: ${t.day}` : undefined}
                >
                  {isEditingCell(r, "day") ? editInput("day") : t.displayDay}
                </td>
                <td onClick={() => cellClick(r, "name")} style={{ ...styles.gridCell, ...selStyle(r, "name") }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                    {monthAmounts?.[`${account.id}_${t.id}`] != null
                      ? <span style={{ fontSize: 9, color: "var(--green)", fontFamily: "var(--font-mono)", opacity: 0.7, flexShrink: 0 }}>custom</span>
                      : (dynamicAmounts && dynamicAmounts[t.name] != null)
                      ? <span style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", opacity: 0.6, flexShrink: 0 }}>auto</span>
                      : presetsMap[t.name] !== undefined && <span style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", opacity: 0.6, flexShrink: 0 }}>preset</span>
                    }
                    {noteEditId === t.id ? (
                      <input
                        autoFocus
                        value={noteEditVal}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setNoteEditVal(e.target.value)}
                        onBlur={() => { onEditNote(account.id, t.id, noteEditVal); setNoteEditId(null); }}
                        onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") { onEditNote(account.id, t.id, noteEditVal); setNoteEditId(null); } }}
                        style={{ ...styles.noteInput, width: 130, flexShrink: 0 }}
                        placeholder="Add a note…"
                      />
                    ) : (
                      <span
                        className={t.note ? undefined : "cf-hover-show"}
                        onClick={(e) => { e.stopPropagation(); setNoteEditId(t.id); setNoteEditVal(t.note ?? ""); }}
                        style={{ ...(t.note ? styles.noteText : styles.noteAdd), flexShrink: t.note ? 1 : 0 }}
                      >
                        {t.note || "+ note"}
                      </span>
                    )}
                  </div>
                </td>
                <td onClick={() => cellClick(r, "freq")} style={{ ...styles.gridCell, fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", ...selStyle(r, "freq") }}>
                  {t.freq}
                </td>
                <td
                  onClick={() => cellClick(r, "amount")}
                  onDoubleClick={() => startEditPreserve(r, "amount")}
                  style={{ ...styles.gridNumCell, color: t.effectiveAmt >= 0 ? "var(--green)" : "var(--red)", ...selStyle(r, "amount") }}
                >
                  {isEditingCell(r, "amount") ? editInput("amount") : fmtAccounting(t.effectiveAmt)}
                </td>
                <td onClick={() => cellClick(r, "running")} style={{ ...styles.gridNumCell, color: t.runningBalance >= 0 ? "var(--text)" : "var(--red)", ...selStyle(r, "running") }}>
                  {fmtAccounting(t.runningBalance)}
                </td>
                <td
                  onClick={() => cellClick(r, "pending")}
                  style={{ ...styles.gridCell, textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11, cursor: "pointer", color: t.isPending ? "var(--accent)" : "var(--muted)", ...selStyle(r, "pending") }}
                >
                  {t.isPending ? "Y" : "N"}
                </td>
                <td onClick={() => cellClick(r, "confirmed")} style={{ ...styles.gridNumCell, color: t.isPending ? "var(--accent)" : "var(--muted)", opacity: t.isPending ? 1 : 0.45, ...selStyle(r, "confirmed") }}>
                  {fmtAccounting(t.confirmedBalance)}
                </td>
                <td style={{ ...styles.gridCell, padding: 0, textAlign: "center" }}>
                  <button className="cf-hover-show" onClick={() => onDeleteRow(account.id, t.id)} style={styles.gridDeleteBtn} title="Remove">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button onClick={() => onAddRow(account.id)} style={styles.addRowBtn}>+ Add Transaction</button>
      </div>
    </div>
  );
}

// ── Fixed Amounts Panel ───────────────────────────────────────────────────────
function FixedAmountsPanel({ presets, year, payBaseDate, threePaycheckMonths, onEditPreset, onEditPayCycle }) {
  const [editingName, setEditingName] = useState(null);
  const [editVal, setEditVal] = useState("");

  const startEdit = (item) => { setEditingName(item.name); setEditVal(String(Math.abs(item.amount))); };

  const commitEdit = (item) => {
    const raw = parseFloat(editVal);
    if (!isNaN(raw)) onEditPreset(item.name, (item.amount <= 0 ? -1 : 1) * raw, item.freq, item.note);
    setEditingName(null);
  };

  const income = presets.filter((i) => i.amount > 0);
  const expenses = presets.filter((i) => i.amount <= 0);
  const totalIn = income.reduce((s, i) => s + i.amount, 0);
  const totalOut = expenses.reduce((s, i) => s + i.amount, 0);

  const payCycleMonthNames = Array.from(threePaycheckMonths).sort((a, b) => a - b).map(m => MONTHS[m]);

  return (
    <div style={styles.fixedPanel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <p style={styles.fixedTitle}>Fixed Monthly Reference</p>
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>Click any amount to edit</span>
      </div>
      <div style={styles.fixedGrid}>
        {presets.map((item) => (
          <div key={item.name} style={styles.fixedRow}>
            <span style={{ flex: 1, fontSize: 11, color: "var(--text)" }}>{item.name}</span>
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", marginRight: 12 }}>{item.freq}</span>
            {editingName === item.name ? (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{item.amount <= 0 ? "−$" : "$"}</span>
                <input
                  autoFocus type="number" min="0" step="0.01"
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  onBlur={() => commitEdit(item)}
                  onKeyDown={(e) => { if (e.key === "Enter") commitEdit(item); if (e.key === "Escape") setEditingName(null); }}
                  style={styles.presetInput}
                />
              </div>
            ) : (
              <span
                onClick={() => startEdit(item)}
                style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: item.amount >= 0 ? "var(--green)" : "var(--red)", minWidth: 72, textAlign: "right", cursor: "pointer", borderBottom: "1px dashed var(--border2)" }}
                title="Click to edit"
              >
                {fmt(item.amount)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div style={styles.fixedFooter}>
        <span style={{ color: "var(--green)", fontFamily: "var(--font-mono)", fontSize: 12 }}>In: {fmt(totalIn)}</span>
        <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" }}>|</span>
        <span style={{ color: "var(--red)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Out: {fmt(totalOut)}</span>
        <span style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" }}>|</span>
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>Net: {fmt(totalIn + totalOut, true)}</span>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Pay cycle:
        </span>
        <span
          onClick={onEditPayCycle}
          style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", cursor: "pointer", borderBottom: "1px dashed var(--border2)" }}
          title="Click to change pay cycle base date"
        >
          {baseDateToDisplay(payBaseDate)}
        </span>
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>·</span>
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
          3-paycheck months {year}:{" "}
          <span style={{ color: "var(--accent)" }}>
            {payCycleMonthNames.length ? payCycleMonthNames.join(", ") : "none"}
          </span>
        </span>
      </div>
    </div>
  );
}

// ── Credit Card Block ─────────────────────────────────────────────────────────
function CreditCardBlock({ card, config, monthData, isLinked, onLinkAccount, onUpdateConfig, onUpdateMonthData }) {
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [noteVal, setNoteVal] = useState("");

  const balance      = monthData?.balance  ?? config.defaultBalance ?? 0;
  const pending      = monthData?.pending  ?? 0;
  const recurring    = config.recurring;
  const recurringNote = config.recurringNote;
  const other        = config.other;
  const net = balance + pending + recurring + other;

  const startEdit = (field, value) => { setEditing(field); setEditVal(String(value)); };
  const commitEdit = (field, isMonthly) => {
    const raw = parseFloat(editVal);
    if (!isNaN(raw)) isMonthly ? onUpdateMonthData(field, raw) : onUpdateConfig(field, raw);
    setEditing(null);
  };

  const editableNum = (field, value, isMonthly = false) =>
    editing === field ? (
      <input
        autoFocus type="number" min="0" step="0.01" value={editVal}
        onChange={e => setEditVal(e.target.value)}
        onBlur={() => commitEdit(field, isMonthly)}
        onKeyDown={e => { if (e.key === "Enter") commitEdit(field, isMonthly); if (e.key === "Escape") setEditing(null); }}
        style={styles.ccInput}
      />
    ) : (
      <span style={styles.ccEditable} onClick={() => startEdit(field, value)} title="Click to edit">
        {fmt(value)}
      </span>
    );

  const rows = [
    { label: "Current Balance",                       field: "balance",   value: balance,   monthly: true  },
    { label: "Pending",                               field: "pending",   value: pending,   monthly: true  },
    { label: "Known Recurring Charges Still To Come", field: "recurring", value: recurring, monthly: false, hasNote: true },
    { label: "Known or Estimated Other Charges",      field: "other",     value: other,     monthly: false },
  ];

  return (
    <div style={styles.ccBlock}>
      <div style={styles.ccCardHeader}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={styles.ccCardName}>{card.label}</span>
          <span style={styles.ccCardDue}>({card.dueDate})</span>
        </div>
        <button
          onClick={onLinkAccount}
          title={isLinked ? "Plaid account linked — click to change" : "Link a Plaid account for automatic balance"}
          style={{
            background: "none", cursor: "pointer", padding: "1px 5px",
            fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 600,
            color: isLinked ? "var(--green)" : "var(--muted)",
            borderRadius: 4, border: `1px solid ${isLinked ? "var(--green)" : "var(--border2)"}`,
            opacity: isLinked ? 1 : 0.7, lineHeight: 1.4, alignSelf: "center",
          }}
        >
          {isLinked ? "plaid ✓" : "link plaid"}
        </button>
      </div>
      <div style={styles.ccTableWrap}>
        <div style={styles.ccColHeader}>
          <span style={{ flex: 1 }} />
          <span style={styles.ccColLabel}>Amount</span>
        </div>
        {rows.map(row => (
          <div key={row.field} style={styles.ccTableRow}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={styles.ccRowLabel}>{row.label}</span>
              {row.hasNote ? (
                editingNote ? (
                  <input
                    autoFocus value={noteVal}
                    onChange={e => setNoteVal(e.target.value)}
                    onBlur={() => { onUpdateConfig("recurringNote", noteVal); setEditingNote(false); }}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") { onUpdateConfig("recurringNote", noteVal); setEditingNote(false); } }}
                    style={{ ...styles.ccInput, width: 200, textAlign: "left", fontSize: 10 }}
                  />
                ) : (
                  <span
                    style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", cursor: "pointer", opacity: recurringNote ? 1 : 0.5 }}
                    onClick={() => { setEditingNote(true); setNoteVal(recurringNote); }}
                  >
                    {recurringNote || "+ note"}
                  </span>
                )
              ) : null}
            </div>
            <span style={{ width: 110, textAlign: "right" }}>
              {editableNum(row.field, row.value, row.monthly ?? false)}
            </span>
          </div>
        ))}
        <div style={{ ...styles.ccTableRow, borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 8 }}>
          <span style={{ ...styles.ccRowLabel, fontWeight: 700, color: "var(--text)" }}>Estimated Payment</span>
          <span style={{ width: 110, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: net > 0 ? "var(--red)" : "var(--green)" }}>
            {fmt(net)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────
function LinkAccountModal({ accountName, currentLinkId, plaidAccounts, onSelect, onClose }) {
  const checking = plaidAccounts.filter(p => p.subtype === "checking" || p.type === "depository");
  const others = plaidAccounts.filter(p => p.subtype !== "checking" && p.type !== "depository");
  const all = [...checking, ...others];

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 440, maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Link Plaid Account</p>
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 12 }}>
          Select the Plaid account that maps to <strong>{accountName}</strong>
        </p>
        {all.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>No Plaid accounts found. Make sure a bank is linked.</p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {all.map(p => {
            const isLinked = p.account_id === currentLinkId;
            return (
              <button
                key={p.account_id}
                onClick={() => onSelect(p.account_id)}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "10px 14px", borderRadius: "var(--radius)",
                  border: isLinked ? "2px solid var(--accent)" : "1px solid var(--border)",
                  background: isLinked ? "rgba(123,44,191,0.08)" : "var(--surface2)",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{p.name}</p>
                  <p style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                    {p.institutionName} · {p.subtype ?? p.type} {p.mask ? `·· ${p.mask}` : ""}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--green)" }}>
                    {p.balances?.current != null ? fmt(p.balances.current) : "—"}
                  </p>
                  {isLinked && <p style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 700 }}>LINKED</p>}
                </div>
              </button>
            );
          })}
        </div>
        <div style={{ ...styles.modalActions, marginTop: 16 }}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AddModal({ accountName, onSave, onClose }) {
  const [form, setForm] = useState({ day: "", name: "", freq: "Monthly", amount: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <p style={styles.modalTitle}>Add to {accountName}</p>
        <div style={styles.modalFields}>
          <label style={styles.fieldLabel}>Day of Month</label>
          <input type="number" min="1" max="31" value={form.day} onChange={e => set("day", e.target.value)} style={styles.fieldInput} placeholder="15" />
          <label style={styles.fieldLabel}>Transaction Name</label>
          <input type="text" value={form.name} onChange={e => set("name", e.target.value)} style={styles.fieldInput} placeholder="Paycheck" />
          <label style={styles.fieldLabel}>Amount (negative = outflow)</label>
          <input type="number" value={form.amount} onChange={e => set("amount", e.target.value)} style={styles.fieldInput} placeholder="-500" />
          <label style={styles.fieldLabel}>Frequency</label>
          <select value={form.freq} onChange={e => set("freq", e.target.value)} style={styles.fieldSelect}>
            {FREQS.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={() => {
              if (!form.day || !form.name || !form.amount) return;
              onSave({ day: parseInt(form.day), name: form.name, freq: form.freq, amount: parseFloat(form.amount) });
            }}
            style={styles.saveBtn}
          >Add</button>
        </div>
      </div>
    </div>
  );
}

function EditPresetModal({ presetName, currentAmount, onSave, onClose, subtitle }) {
  const [val, setVal] = useState(currentAmount != null ? String(currentAmount) : "");

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Edit: {presetName}</p>
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          {subtitle ?? "Positive = inflow · Negative = outflow · All rows with this name update."}
        </p>
        <label style={styles.fieldLabel}>Amount</label>
        <input
          type="number" step="0.01"
          value={val}
          onChange={e => setVal(e.target.value)}
          style={styles.fieldInput}
          autoFocus
        />
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={() => { const raw = parseFloat(val); if (!isNaN(raw)) onSave(raw); }}
            style={styles.saveBtn}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

function EditPayCycleModal({ currentDateNum, onSave, onClose }) {
  const y = Math.floor(currentDateNum / 10000);
  const m = String(Math.floor((currentDateNum % 10000) / 100)).padStart(2, "0");
  const d = String(currentDateNum % 100).padStart(2, "0");
  const [val, setVal] = useState(`${y}-${m}-${d}`);

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Pay Cycle Base Date</p>
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          Enter any known payday. 3-paycheck months are computed from bi-weekly intervals.
        </p>
        <label style={styles.fieldLabel}>Payday Date</label>
        <input
          type="date"
          value={val}
          onChange={e => setVal(e.target.value)}
          style={styles.fieldInput}
          autoFocus
        />
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={() => { if (val) onSave(displayToBaseDateNum(val)); }}
            style={styles.saveBtn}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Month Notes ───────────────────────────────────────────────────────────────
function MonthNotes({ note, onSave }) {
  const [text, setText] = useState(note ?? "");
  const timerRef = useRef(null);

  useEffect(() => { setText(note ?? ""); }, [note]);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSave(v), 800);
  };

  return (
    <div style={styles.notesSection}>
      <p style={styles.notesLabel}>Notes</p>
      <textarea
        value={text}
        onChange={handleChange}
        style={styles.notesTextarea}
        placeholder="Add notes for this month..."
      />
    </div>
  );
}

// ── Temp Loans panel ─────────────────────────────────────────────────────────
// Tracks money that temporarily left one of your pots (e.g. paid for something
// shared out of Personal, to be paid back from Shared later). Stored as rows in
// the generic cashflow_presets key/value table under __tloan_<id> / __tpay_<loanId>_<id>.
function formatMonthKey(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey || "");
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : monthKey || "—";
}

function TempLoansPanel({ loans, currentMonthKey, onAddLoan, onAddPayback, onDeleteLoan, onDeletePayback }) {
  const [editing, setEditing] = useState(null); // { type: "loan" } | { type: "payback", loanId }
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState(currentMonthKey);

  const startEditing = (target) => { setEditing(target); setDesc(""); setAmount(""); setMonth(currentMonthKey); };

  const commit = () => {
    const amt = Math.abs(parseFloat(amount));
    const monthKey = /^\d{4}-\d{2}$/.test(month) ? month : currentMonthKey;
    if (!isNaN(amt) && amt > 0) {
      if (editing.type === "loan" && desc.trim()) onAddLoan(desc.trim(), amt, monthKey);
      if (editing.type === "payback") onAddPayback(editing.loanId, amt, monthKey, desc.trim() || null);
    }
    setEditing(null);
  };

  const withTotals = loans.map((loan) => {
    const repaid = loan.paybacks.reduce((sum, p) => sum + p.amount, 0);
    return { ...loan, repaid, outstanding: loan.amount - repaid };
  });
  const totalOutstanding = withTotals.reduce((sum, l) => sum + l.outstanding, 0);

  const editRow = editing && (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)", textTransform: "uppercase" }}>
        {editing.type === "loan" ? "New loan" : "Payback"}
      </span>
      <input
        autoFocus
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={editing.type === "loan" ? "Description (e.g. Trip reimbursement → Joint)" : "Note (optional)"}
        style={{ ...styles.noteInput, width: 280 }}
        onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
      />
      <input
        type="number" min="0" step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount"
        style={styles.presetInput}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(null); }}
      />
      <input
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        placeholder="YYYY-MM"
        style={{ ...styles.presetInput, width: 70 }}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(null); }}
      />
      <button onClick={commit} style={styles.loanBtn}>Save</button>
      <button onClick={() => setEditing(null)} style={{ ...styles.loanBtn, color: "var(--muted)", borderColor: "var(--border2)" }}>Cancel</button>
    </div>
  );

  return (
    <div style={styles.fixedPanel}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <p style={styles.fixedTitle}>Temp Loans</p>
        {editing?.type !== "loan" && (
          <button onClick={() => startEditing({ type: "loan" })} style={styles.loanBtn}>+ Add Loan</button>
        )}
      </div>
      {editing?.type === "loan" && editRow}
      {withTotals.length === 0 && !editing && (
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          Nothing outstanding. Add a loan when money temporarily leaves one of your pots.
        </p>
      )}
      <div style={styles.fixedGrid}>
        {withTotals.map((loan) => (
          <div key={loan.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{loan.desc}</span>
              <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{formatMonthKey(loan.month)}</span>
              <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--red)", minWidth: 80, textAlign: "right" }}>{fmt(-loan.amount)}</span>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, minWidth: 130, textAlign: "right", color: loan.outstanding <= 0 ? "var(--green)" : "var(--accent)" }}>
                {loan.outstanding <= 0 ? "✓ settled" : `${fmt(loan.outstanding)} outstanding`}
              </span>
              <button onClick={() => startEditing({ type: "payback", loanId: loan.id })} style={styles.loanBtn}>+ Payback</button>
              <button onClick={() => onDeleteLoan(loan.id)} style={styles.deleteBtn} title="Remove loan and its paybacks">×</button>
            </div>
            {loan.paybacks.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, paddingLeft: 16 }}>
                <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>↳ payback</span>
                <span style={{ flex: 1, fontSize: 11, color: "var(--muted)" }}>{p.note}</span>
                <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{formatMonthKey(p.month)}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--green)", minWidth: 80, textAlign: "right" }}>{fmt(p.amount)}</span>
                <button onClick={() => onDeletePayback(loan.id, p.id)} style={styles.deleteBtn} title="Remove payback">×</button>
              </div>
            ))}
            {editing?.type === "payback" && editing.loanId === loan.id && editRow}
          </div>
        ))}
      </div>
      {withTotals.length > 0 && (
        <div style={styles.fixedFooter}>
          <span style={{ color: totalOutstanding <= 0 ? "var(--green)" : "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>
            Total outstanding: {fmt(totalOutstanding)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Auto-Match modal ─────────────────────────────────────────────────────────
function AutoMatchModal({ transferPairs, recurringGroups, acctNameMap, categories, assignments, onApplyTransfer, onApplyRecurring, onClose }) {
  const [status, setStatus] = useState({}); // { [key]: "busy" | "accepted" | "rejected" | "skipped" }
  const [selectedCategory, setSelectedCategory] = useState(() => {
    // Pre-select whichever category is already most common among a recurring group's transactions.
    const initial = {};
    recurringGroups.forEach((group) => {
      const counts = {};
      group.txns.forEach((t) => {
        const catId = assignments[t.transaction_id];
        if (catId) counts[catId] = (counts[catId] || 0) + 1;
      });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      initial[group.key] = top ? top[0] : "";
    });
    return initial;
  });

  const setRowStatus = (key, value) => setStatus((s) => ({ ...s, [key]: value }));

  const acceptTransfer = async (pair) => {
    setRowStatus(pair.key, "busy");
    try {
      await onApplyTransfer(pair);
      setRowStatus(pair.key, "accepted");
    } catch (e) {
      console.error("Apply transfer failed", e);
      setRowStatus(pair.key, undefined);
      alert("Could not apply: " + e.message);
    }
  };

  const acceptRecurring = async (group) => {
    const catId = selectedCategory[group.key];
    if (!catId) { alert("Pick a category for this group first."); return; }
    setRowStatus(group.key, "busy");
    try {
      await onApplyRecurring(group, catId);
      setRowStatus(group.key, "accepted");
    } catch (e) {
      console.error("Apply recurring failed", e);
      setRowStatus(group.key, undefined);
      alert("Could not apply: " + e.message);
    }
  };

  const amountRange = (min, max) => (min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`);
  const shortDate = (d) => (d || "").slice(5, 10);
  const isResolved = (key) => ["accepted", "rejected", "skipped"].includes(status[key]);
  const visibleTransfers = transferPairs.filter((p) => !isResolved(p.key));
  const visibleRecurring = recurringGroups.filter((g) => !isResolved(g.key));
  const isEmpty = transferPairs.length === 0 && recurringGroups.length === 0;

  const StatusTag = ({ s }) => {
    if (s === "accepted") return <span style={{ ...styles.matchTag, color: "var(--green)", borderColor: "var(--green)" }}>✓ applied</span>;
    if (s === "rejected") return <span style={{ ...styles.matchTag, color: "var(--red)", borderColor: "var(--red)" }}>rejected</span>;
    if (s === "skipped") return <span style={{ ...styles.matchTag, color: "var(--muted)" }}>skipped</span>;
    return null;
  };

  return (
    <div style={styles.matchOverlay} onClick={onClose}>
      <div style={styles.matchModal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.matchHeader}>
          <div>
            <p style={styles.matchTitle}>Auto-Match Review</p>
            <p style={styles.matchSub}>High-confidence suggestions from your last 90 days. Nothing is applied until you accept it.</p>
          </div>
          <button style={styles.matchClose} onClick={onClose}>×</button>
        </div>
        <div style={styles.matchBody}>
          {isEmpty && <p style={styles.matchEmpty}>No high-confidence transfers or recurring transactions found right now.</p>}

          {transferPairs.length > 0 && (
            <>
              <p style={styles.matchSectionLabel}>Transfers <span style={styles.matchSectionCount}>{visibleTransfers.length} to review</span></p>
              <p style={styles.matchSectionHint}>Matched an outflow to an equal inflow in another account. Accepting tags both as <strong>Transfer</strong>.</p>
              {transferPairs.map((pair) => (
                <div key={pair.key} style={{ ...styles.matchRow, opacity: isResolved(pair.key) ? 0.55 : 1 }}>
                  <div style={styles.matchRowMain}>
                    <span style={styles.matchAmount}>{fmt(pair.amount)}</span>
                    <span style={styles.matchDetail}>
                      {acctNameMap[pair.out.account_id] || pair.out.account_id} → {acctNameMap[pair.in.account_id] || pair.in.account_id}
                      {"  ·  "}{shortDate(pair.out.date)}{pair.dayDiff > 0 ? ` / ${shortDate(pair.in.date)}` : ""}
                    </span>
                    <span style={styles.matchDetailMuted}>{merchantLabel(pair.out)}</span>
                  </div>
                  {isResolved(pair.key) ? <StatusTag s={status[pair.key]} /> : (
                    <div style={styles.matchActions}>
                      <button style={styles.matchAccept} disabled={status[pair.key] === "busy"} onClick={() => acceptTransfer(pair)}>
                        {status[pair.key] === "busy" ? "…" : "Accept"}
                      </button>
                      <button style={styles.matchReject} onClick={() => setRowStatus(pair.key, "rejected")}>Reject</button>
                      <button style={styles.matchSkip} onClick={() => setRowStatus(pair.key, "skipped")}>Skip</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {recurringGroups.length > 0 && (
            <>
              <p style={{ ...styles.matchSectionLabel, marginTop: transferPairs.length ? 22 : 0 }}>
                Recurring <span style={styles.matchSectionCount}>{visibleRecurring.length} to review</span>
              </p>
              <p style={styles.matchSectionHint}>
                Same payee on a steady cadence (paychecks, car & card payments). Pick a category, then accept to apply it to all {recurringGroups.reduce((s, g) => s + g.count, 0)} matched transactions.
              </p>
              {recurringGroups.map((group) => (
                <div key={group.key} style={{ ...styles.matchRow, opacity: isResolved(group.key) ? 0.55 : 1 }}>
                  <div style={styles.matchRowMain}>
                    <span style={styles.matchDetail}>{group.merchant}</span>
                    <span style={styles.matchDetailMuted}>{group.count}× · {group.cadence} · {group.direction} · {amountRange(group.minAmt, group.maxAmt)}</span>
                  </div>
                  {isResolved(group.key) ? <StatusTag s={status[group.key]} /> : (
                    <div style={styles.matchActions}>
                      <select
                        value={selectedCategory[group.key] || ""}
                        onChange={(e) => setSelectedCategory((s) => ({ ...s, [group.key]: e.target.value }))}
                        style={styles.matchCatSelect}
                      >
                        <option value="">— category —</option>
                        {(categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <button style={styles.matchAccept} disabled={status[group.key] === "busy"} onClick={() => acceptRecurring(group)}>
                        {status[group.key] === "busy" ? "…" : "Accept"}
                      </button>
                      <button style={styles.matchReject} onClick={() => setRowStatus(group.key, "rejected")}>Reject</button>
                      <button style={styles.matchSkip} onClick={() => setRowStatus(group.key, "skipped")}>Skip</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
        <div style={styles.matchFooter}>
          <button style={styles.matchDoneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Main CashFlow View ────────────────────────────────────────────────────────
const now = new Date();

export default function CashFlow({ transactions = [], categories = [], assignments = {}, setAssignments, setCategories }) {
  // monthOffset: 0 = current month is first, 1 = next month is first, etc.
  const [monthOffset, setMonthOffset] = useState(0);
  const [activeTab, setActiveTab] = useState("all");

  // Compute the 3 months to display
  const months = useMemo(() => {
    return [0, 1, 2].map(i => {
      const d = new Date(now.getFullYear(), now.getMonth() + monthOffset + i, 1);
      const mi = d.getMonth();
      const y = d.getFullYear();
      return { monthIdx: mi, year: y, monthKey: toMonthKey(y, mi) };
    });
  }, [monthOffset]);

  const [presets, setPresets] = useState(DEFAULT_FIXED);
  const [payBaseDate, setPayBaseDate] = useState(20260405);
  const [startingBals, setStartingBals] = useState(() =>
    Object.fromEntries(DEFAULT_ACCOUNTS.map(a => [a.id, a.defaultStart]))
  );
  const [userSetStartIds, setUserSetStartIds] = useState(new Set());
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [mappings, setMappings] = useState([]);
  // allMonthStates: { [monthKey]: { [acctId_txnId]: { isPending, plaidTxnId, actualDay, note } } }
  const [allMonthStates, setAllMonthStates] = useState({});
  // allMonthAmounts: per-month user overrides — kept separate from actual_amount (which is reconciliation only)
  // { [monthKey]: { [acctId_txnId]: number } }
  const [allMonthAmounts, setAllMonthAmounts] = useState({});
  // allRecentTxns: { [monthKey]: txns[] }
  const [allRecentTxns, setAllRecentTxns] = useState({});
  const [txnOrders, setTxnOrders] = useState({});
  const [allMonthNotes, setAllMonthNotes] = useState({});
  const [modal, setModal] = useState(null);
  const [ccConfig, setCcConfig] = useState(DEFAULT_CC_CONFIG);
  const [ccMonthData, setCcMonthData] = useState({});
  // plaidAcctLinks: { [cashflowAcctId]: plaid_account_id string }
  const [plaidAcctLinks, setPlaidAcctLinks] = useState({});
  // ccPlaidLinks: { [cardId]: plaid_account_id string }
  const [ccPlaidLinks, setCcPlaidLinks] = useState({});
  // allPlaidAccts: full list from /api/accounts, used for the link-picker modal
  const [allPlaidAccts, setAllPlaidAccts] = useState([]);
  const autoConfirmedRef = useRef(new Set());

  // Temp loans (money that temporarily left one pot, tracked until paid back)
  const [loans, setLoans] = useState([]);
  // Auto-Match modal
  const [showAutoMatch, setShowAutoMatch] = useState(false);

  const presetsMap = useMemo(() => {
    const m = {};
    presets.forEach(p => { m[p.name] = p.amount; });
    return m;
  }, [presets]);

  // 3-paycheck months keyed by year (to handle year boundaries in 3-month window)
  const threePaycheckMonthsByYear = useMemo(() => {
    const years = [...new Set(months.map(m => m.year))];
    const result = {};
    years.forEach(y => { result[y] = computeThreePaycheckMonths(y, payBaseDate); });
    return result;
  }, [months, payBaseDate]);

  const isThreePaycheck = useCallback((monthIdx, year) => {
    return !!(threePaycheckMonthsByYear[year]?.has(monthIdx));
  }, [threePaycheckMonthsByYear]);

  // Helper to compute dynamic CC transfer amount for a month
  const computeDynamicCcPayment = useCallback((monthKey) => {
    let sum = 0;
    CC_CARDS.forEach(card => {
      const md = ccMonthData[monthKey]?.[card.id];
      const cfg = ccConfig[card.id] || DEFAULT_CC_CONFIG[card.id];
      const bal = md?.balance ?? cfg.defaultBalance ?? 0;
      const pen = md?.pending ?? 0;
      sum += bal + pen + (cfg.recurring || 0) + (cfg.other || 0);
    });
    return -sum; // transfer is an outflow
  }, [ccMonthData, ccConfig]);

  // Carry-forward starting balances: month 0 uses real startingBals,
  // month 1 uses projected end of month 0, month 2 uses projected end of month 1.
  const startBalsPerMonth = useMemo(() => {
    const result = [startingBals];
    let prev = startingBals;
    for (let i = 0; i < 2; i++) {
      const { monthIdx, year, monthKey } = months[i];
      const mAmts = allMonthAmounts[monthKey] ?? {};
      const mStates = allMonthStates[monthKey] ?? {};
      const dynamicCcAmount = computeDynamicCcPayment(monthKey);
      
      const effFn = (t, acctId) => {
        if (t.name === "Transfer for Credit Card") {
          return dynamicCcAmount;
        }
        return mAmts[`${acctId}_${t.id}`] ?? presetsMap[t.name] ?? t.amount;
      };
      
      const endBals = computeProjectedEndBals(accounts, prev, effFn, isThreePaycheck(monthIdx, year), mStates);
      result.push(endBals);
      prev = endBals;
    }
    return result;
  }, [months, startingBals, accounts, presetsMap, isThreePaycheck, allMonthAmounts, allMonthStates, computeDynamicCcPayment]);

  // Summary per month
  const summaries = useMemo(() => {
    return months.map(({ monthIdx, year, monthKey }) => {
      const mAmts = allMonthAmounts[monthKey] ?? {};
      const dynamicCcAmount = computeDynamicCcPayment(monthKey);
      
      const effFn = (t, acctId) => {
        if (t.name === "Transfer for Credit Card") {
          return dynamicCcAmount;
        }
        return mAmts[`${acctId}_${t.id}`] ?? presetsMap[t.name] ?? t.amount;
      };
      
      return computeSummary(accounts, effFn, isThreePaycheck(monthIdx, year));
    });
  }, [months, accounts, presetsMap, isThreePaycheck, allMonthAmounts, computeDynamicCcPayment]);

  // Load all startup data sequentially so DB-saved balances are never overwritten by Plaid.
  // The race condition with separate effects: Plaid fires immediately with an empty userSetStartIds
  // closure, then its .then() callback arrives after DB presets have loaded and overwrites them.
  // Sequential async loading uses a local variable so Plaid always sees the DB-saved IDs.
  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      // 1. DB presets — amounts, starting balances, pay cycle, row order, notes
      let userSetIds = new Set();
      let newLinks = {};   // hoisted so step 2 can read the saved Plaid account_id links
      let newCcLinks = {}; // hoisted for credit cards
      try {
        const dbPresets = await fetchCashflowPresets();
        if (!cancelled && Array.isArray(dbPresets) && dbPresets.length > 0) {
          const cyclePref = dbPresets.find(p => p.name === "__pay_cycle_date");
          if (cyclePref?.amount) setPayBaseDate(cyclePref.amount);

          // DB values matching these amounts were saved as old code defaults — ignore them.
          const STALE_DEFAULTS = { "Jared Transfer to Shared": -500, "Jared Transfer In": 500 };
          const merged = DEFAULT_FIXED.map(d => {
            const db = dbPresets.find(p => p.name === d.name);
            if (!db) return d;
            const isStale = STALE_DEFAULTS[d.name] !== undefined && db.amount === STALE_DEFAULTS[d.name];
            return isStale ? d : { ...d, amount: db.amount, freq: db.freq ?? d.freq, note: db.note ?? d.note };
          });
          dbPresets.forEach(p => {
            if (!merged.find(m => m.name === p.name) && !p.name.startsWith("__")) merged.push(p);
          });
          setPresets(merged);

          const newBals = {};
          const newOrders = {};
          DEFAULT_ACCOUNTS.forEach(a => {
            const db = dbPresets.find(p => p.name === `__start_${a.id}`);
            if (db) { newBals[a.id] = db.amount; userSetIds.add(a.id); } // protect user-set balance from Plaid overwrite
            const orderPref = dbPresets.find(p => p.name === `__order_${a.id}`);
            if (orderPref?.note) { try { newOrders[a.id] = JSON.parse(orderPref.note); } catch {} }
            const linkPref = dbPresets.find(p => p.name === `__plaid_id_${a.id}`);
            if (linkPref?.note) newLinks[a.id] = linkPref.note;
          });
          CC_CARDS.forEach(card => {
            const linkPref = dbPresets.find(p => p.name === `__plaid_id_cc_${card.id}`);
            if (linkPref?.note) newCcLinks[card.id] = linkPref.note;
          });
          if (Object.keys(newBals).length > 0) setStartingBals(prev => ({ ...prev, ...newBals }));
          if (userSetIds.size > 0) setUserSetStartIds(userSetIds);
          if (Object.keys(newOrders).length > 0) setTxnOrders(newOrders);
          if (Object.keys(newLinks).length > 0) setPlaidAcctLinks(newLinks);
          if (Object.keys(newCcLinks).length > 0) setCcPlaidLinks(newCcLinks);

          const newNotes = {};
          dbPresets.forEach(p => {
            if (p.name.startsWith("__note_")) newNotes[p.name.replace("__note_", "")] = p.note ?? "";
          });
          if (Object.keys(newNotes).length > 0) setAllMonthNotes(newNotes);

          // CC config + per-month data
          const newCcConfig = {
            vcx:  { ...DEFAULT_CC_CONFIG.vcx },
            plat: { ...DEFAULT_CC_CONFIG.plat },
          };
          CC_CARDS.forEach(card => {
            const pm = dbPresets.find(p => p.name === `__cc_${card.id}_payment`);
            const rc = dbPresets.find(p => p.name === `__cc_${card.id}_recurring`);
            const ot = dbPresets.find(p => p.name === `__cc_${card.id}_other`);
            if (pm) newCcConfig[card.id].payment = pm.amount;
            if (rc) { newCcConfig[card.id].recurring = rc.amount; if (rc.note != null) newCcConfig[card.id].recurringNote = rc.note; }
            if (ot) newCcConfig[card.id].other = ot.amount;
          });
          setCcConfig(newCcConfig);

          const newCcMonthData = {};
          dbPresets.forEach(p => {
            const m = p.name.match(/^__cc_(vcx|plat)_(balance|pending)_(.+)$/);
            if (m) {
              const [, cardId, field, monthKey] = m;
              if (!newCcMonthData[monthKey]) newCcMonthData[monthKey] = {};
              if (!newCcMonthData[monthKey][cardId]) newCcMonthData[monthKey][cardId] = {};
              newCcMonthData[monthKey][cardId][field] = p.amount;
            }
          });
          if (Object.keys(newCcMonthData).length > 0) setCcMonthData(newCcMonthData);

          // Per-month amount overrides stored as __mamt_YYYY-MM_acctId_txnId
          const newMonthAmts = {};
          dbPresets.forEach(p => {
            const m = p.name.match(/^__mamt_(\d{4}-\d{2})_([a-z]+)_(\d+)$/);
            if (m) {
              const [, mk, acctId, txnId] = m;
              if (!newMonthAmts[mk]) newMonthAmts[mk] = {};
              newMonthAmts[mk][`${acctId}_${txnId}`] = p.amount;
            }
          });
          if (Object.keys(newMonthAmts).length > 0) setAllMonthAmounts(newMonthAmts);

          // Temp loans, stored as __tloan_<id> (the loan) + __tpay_<loanId>_<paybackId> (each payback)
          const newLoans = {};
          dbPresets.forEach(p => {
            const m = p.name.match(/^__tloan_(\d+)$/);
            if (m) newLoans[m[1]] = { id: m[1], amount: p.amount, month: p.freq ?? "", desc: p.note ?? "", paybacks: [] };
          });
          dbPresets.forEach(p => {
            const m = p.name.match(/^__tpay_(\d+)_(\d+)$/);
            if (m && newLoans[m[1]]) newLoans[m[1]].paybacks.push({ id: m[2], amount: p.amount, month: p.freq ?? "", note: p.note ?? "" });
          });
          if (Object.keys(newLoans).length > 0) {
            setLoans(Object.values(newLoans).sort((a, b) => a.id.localeCompare(b.id)));
          }
        }
      } catch {}

      if (cancelled) return;

      // 2. Live Plaid balances — prefer direct account_id link; fall back to fuzzy name matching
      try {
        const data = await fetchAccounts();
        const plaidAccts = data?.accounts ?? [];
        if (!cancelled && plaidAccts.length) {
          setAllPlaidAccts(plaidAccts);
          setStartingBals(prev => {
            const next = { ...prev };
            DEFAULT_ACCOUNTS.forEach(acct => {
              if (userSetIds.has(acct.id)) return;
              const linkedId = newLinks[acct.id];
              const match = linkedId
                ? plaidAccts.find(p => p.account_id === linkedId)
                : plaidAccts.find(p => matchPlaidToAccount(p.name, p.institutionName, acct.id, acct.name));
              if (match?.balances?.current != null) next[acct.id] = match.balances.current;
            });
            return next;
          });
          
          setCcMonthData(prev => {
            const next = { ...prev };
            const currentMonthKey = months[0]?.monthKey || toMonthKey(now.getFullYear(), now.getMonth());
            const currentMonthData = { ...(next[currentMonthKey] || {}) };
            let updated = false;
            
            CC_CARDS.forEach(card => {
              const linkedId = newCcLinks[card.id];
              const match = linkedId 
                ? plaidAccts.find(p => p.account_id === linkedId)
                : null;
              if (match?.balances?.current != null) {
                currentMonthData[card.id] = {
                  ...(currentMonthData[card.id] || {}),
                  balance: match.balances.current
                };
                updated = true;
              }
            });
            if (updated) next[currentMonthKey] = currentMonthData;
            return next;
          });
        }
      } catch {}

      if (cancelled) return;

      // 3. Imported account balances — overwrites Plaid if more recent data is available
      try {
        const rows = await fetchAccountBalances();
        if (!cancelled && Array.isArray(rows) && rows.length) {
          setStartingBals(prev => {
            const next = { ...prev };
            DEFAULT_ACCOUNTS.forEach(acct => {
              if (userSetIds.has(acct.id)) return;
              const match = rows.find(r => matchImportedBalance(r, acct.id));
              if (match?.balance != null) next[acct.id] = parseFloat(match.balance);
            });
            return next;
          });
        }
      } catch {}
    }
    loadAll();
    return () => { cancelled = true; };
  }, []);

  // Load mapping rules once
  useEffect(() => {
    fetchCashflowMappings().then(rows => {
      if (Array.isArray(rows)) setMappings(rows);
    }).catch(() => {});
  }, []);

  // Load per-month states + transactions when the window shifts
  useEffect(() => {
    months.forEach(({ monthKey }) => {
      fetchCashflowStates(monthKey).then((rows) => {
        if (!Array.isArray(rows)) return;
        const map = {};
        rows.forEach(r => {
          map[`${r.account_id}_${r.txn_id}`] = { isPending: r.is_pending, plaidTxnId: r.plaid_txn_id, actualDay: r.actual_day ?? null, note: r.note ?? null };
        });
        setAllMonthStates(prev => ({ ...prev, [monthKey]: map }));
      }).catch(() => {});

      fetchTransactionsForMonth(monthKey).then(data => {
        setAllRecentTxns(prev => ({ ...prev, [monthKey]: data?.transactions ?? [] }));
      }).catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset]);

  // Silent auto-confirm via saved mapping rules or high-confidence score matching
  useEffect(() => {
    months.forEach(({ monthKey }) => {
      const recentTxns = allRecentTxns[monthKey] ?? [];
      if (!recentTxns.length) return;
      const monthStates = allMonthStates[monthKey] ?? {};

      const confirmedIds = new Set(
        Object.values(monthStates).map(s => s.plaidTxnId).filter(Boolean)
      );

      for (const txn of recentTxns) {
        const id = txn.transaction_id;
        if (confirmedIds.has(id)) continue;
        if (autoConfirmedRef.current.has(id)) continue;
        if (Math.abs(txn.amount) < 5) continue;

        const merchant = (txn.merchant_name || txn.name || "").toLowerCase();
        const matchedRule = mappings.find(m => merchant.includes(m.merchant_pattern));
        let row = null;
        let isRuleMatch = false;
        if (matchedRule) {
          row = ALL_ROWS.find(r => r.accountId === matchedRule.account_id && r.txnName === matchedRule.txn_name);
          if (row) isRuleMatch = true;
        }

        if (!row) {
          let best = null;
          let bestScore = 7;
          for (const r of ALL_ROWS) {
            const s = scoreMatch(txn, r, presetsMap);
            if (s > bestScore) { bestScore = s; best = r; }
          }
          row = best;
        }

        if (!row) continue;

        autoConfirmedRef.current.add(id);
        const { accountId, txnId, txnName } = row;
        const key = `${accountId}_${txnId}`;
        const actualDay = new Date(txn.date + "T12:00:00").getDate();
        setAllMonthStates(prev => ({
          ...prev,
          [monthKey]: { ...(prev[monthKey] ?? {}), [key]: { isPending: true, plaidTxnId: id, actualDay } },
        }));
        saveCashflowState(accountId, txnId, monthKey, true, Math.abs(txn.amount), id, actualDay, null).catch(() => {});
        if (!isRuleMatch) {
          const pattern = merchant.trim();
          if (pattern.length > 3) {
            saveCashflowMapping(pattern, accountId, txnName).catch(() => {});
            setMappings(prev => {
              const filtered = prev.filter(m => m.merchant_pattern !== pattern);
              return [...filtered, { merchant_pattern: pattern, account_id: accountId, txn_name: txnName }];
            });
          }
        }
      }
    });
  }, [months, allRecentTxns, mappings, allMonthStates, presetsMap]);

  const updateDay = useCallback((monthKey, accountId, txnId, newDay) => {
    const key = `${accountId}_${txnId}`;
    const existing = allMonthStates[monthKey]?.[key] ?? {};
    setAllMonthStates(prev => ({
      ...prev,
      [monthKey]: { ...(prev[monthKey] ?? {}), [key]: { ...existing, actualDay: newDay } },
    }));
    saveCashflowState(accountId, txnId, monthKey, existing.isPending ?? false, null, existing.plaidTxnId ?? null, newDay, existing.note ?? null).catch(() => {});
  }, [allMonthStates]);

  const togglePending = useCallback((monthKey, accountId, txnId) => {
    const key = `${accountId}_${txnId}`;
    const existing = allMonthStates[monthKey]?.[key] ?? {};
    const next = !existing.isPending;
    setAllMonthStates(prev => ({
      ...prev,
      [monthKey]: { ...(prev[monthKey] ?? {}), [key]: { ...existing, isPending: next } },
    }));
    saveCashflowState(accountId, txnId, monthKey, next, null, existing.plaidTxnId ?? null, existing.actualDay ?? null, existing.note ?? null).catch(() => {});
  }, [allMonthStates]);

  const editNote = useCallback((monthKey, accountId, txnId, note) => {
    const key = `${accountId}_${txnId}`;
    const existing = allMonthStates[monthKey]?.[key] ?? {};
    const trimmed = note?.trim() || null;
    setAllMonthStates(prev => ({
      ...prev,
      [monthKey]: { ...(prev[monthKey] ?? {}), [key]: { ...existing, note: trimmed } },
    }));
    saveCashflowState(accountId, txnId, monthKey, existing.isPending ?? false, null, existing.plaidTxnId ?? null, existing.actualDay ?? null, trimmed).catch(() => {});
  }, [allMonthStates]);

  const editAmount = useCallback((monthKey, accountId, txnId, txnName) => {
    const key = `${accountId}_${txnId}`;
    const acct = accounts.find(a => a.id === accountId);
    const txn = acct?.transactions.find(t => t.id === txnId);
    const amt = allMonthAmounts[monthKey]?.[key] ?? presetsMap[txnName] ?? txn?.amount;
    setModal({ type: "editMonthAmount", monthKey, accountId, txnId, txnName, amount: amt });
  }, [allMonthAmounts, presetsMap, accounts]);

  const savePreset = useCallback((name, amount, freq, note) => {
    const existing = presets.find(p => p.name === name);
    setPresets(prev => {
      const idx = prev.findIndex(p => p.name === name);
      if (idx >= 0) {
        const u = [...prev];
        u[idx] = { ...u[idx], amount, freq: freq ?? u[idx].freq, note: note ?? u[idx].note };
        return u;
      }
      return [...prev, { name, amount, freq: freq ?? "Monthly", note: note ?? "" }];
    });
    saveCashflowPreset(name, amount, freq ?? existing?.freq, note ?? existing?.note).catch(() => {});

    const mirrorName = TRANSFER_MIRRORS[name];
    if (mirrorName) {
      const mirrorAmt = -amount;
      setPresets(prev => {
        const idx = prev.findIndex(p => p.name === mirrorName);
        if (idx >= 0) {
          const u = [...prev]; u[idx] = { ...u[idx], amount: mirrorAmt }; return u;
        }
        return [...prev, { name: mirrorName, amount: mirrorAmt, freq: freq ?? "Monthly", note: "" }];
      });
      saveCashflowPreset(mirrorName, mirrorAmt, null, null).catch(() => {});
    }

    setModal(null);
  }, [presets]);

  const saveMonthAmount = useCallback((monthKey, accountId, txnId, amount) => {
    const key = `${accountId}_${txnId}`;
    setAllMonthAmounts(prev => ({
      ...prev,
      [monthKey]: { ...(prev[monthKey] ?? {}), [key]: amount },
    }));
    saveCashflowPreset(`__mamt_${monthKey}_${accountId}_${txnId}`, amount, null, null).catch(() => {});
    setModal(null);
  }, []);

  const editStartingBalance = useCallback((accountId) => {
    setModal({ type: "editStart", accountId, amount: startingBals[accountId] });
  }, [startingBals]);

  const saveStartingBalance = useCallback((accountId, amount) => {
    setStartingBals(prev => ({ ...prev, [accountId]: amount }));
    setUserSetStartIds(prev => new Set([...prev, accountId]));
    saveCashflowPreset(`__start_${accountId}`, amount, null, null).catch(() => {});
    setModal(null);
  }, []);

  const savePlaidLink = useCallback((accountId, plaidAccountId) => {
    setPlaidAcctLinks(prev => ({ ...prev, [accountId]: plaidAccountId }));
    saveCashflowPreset(`__plaid_id_${accountId}`, 0, null, plaidAccountId).catch(() => {});
    // Immediately apply the balance from the newly-linked account
    const matched = allPlaidAccts.find(p => p.account_id === plaidAccountId);
    if (matched?.balances?.current != null) {
      setStartingBals(prev => ({ ...prev, [accountId]: matched.balances.current }));
    }
    setModal(null);
  }, [allPlaidAccts]);

  const saveCcPlaidLink = useCallback((cardId, plaidAccountId) => {
    setCcPlaidLinks(prev => ({ ...prev, [cardId]: plaidAccountId }));
    saveCashflowPreset(`__plaid_id_cc_${cardId}`, 0, null, plaidAccountId).catch(() => {});
    // Immediately apply the balance for the current month
    const matched = allPlaidAccts.find(p => p.account_id === plaidAccountId);
    if (matched?.balances?.current != null) {
      const currentMonthKey = months[0]?.monthKey || toMonthKey(now.getFullYear(), now.getMonth());
      setCcMonthData(prev => ({
        ...prev,
        [currentMonthKey]: {
          ...(prev[currentMonthKey] || {}),
          [cardId]: {
            ...(prev[currentMonthKey]?.[cardId] || {}),
            balance: matched.balances.current
          }
        }
      }));
    }
    setModal(null);
  }, [allPlaidAccts, months]);

  const savePayCycleDate = useCallback((newDateNum) => {
    setPayBaseDate(newDateNum);
    saveCashflowPreset("__pay_cycle_date", newDateNum, null, null).catch(() => {});
    setModal(null);
  }, []);

  const reorderAccount = useCallback((accountId, newOrderedIds) => {
    setTxnOrders(prev => ({ ...prev, [accountId]: newOrderedIds }));
    saveCashflowPreset(`__order_${accountId}`, 0, null, JSON.stringify(newOrderedIds)).catch(() => {});
  }, []);

  const saveNote = useCallback((monthKey, text) => {
    setAllMonthNotes(prev => ({ ...prev, [monthKey]: text }));
    saveCashflowPreset(`__note_${monthKey}`, 0, null, text).catch(() => {});
  }, []);

  // ── Temp loans ──────────────────────────────────────────────────────────────
  const addLoan = useCallback((desc, amount, monthKey) => {
    const id = String(Date.now());
    setLoans(prev => [...prev, { id, desc, amount, month: monthKey, paybacks: [] }]);
    saveCashflowPreset(`__tloan_${id}`, amount, monthKey, desc).catch(() => {});
  }, []);

  const addPayback = useCallback((loanId, amount, monthKey, note) => {
    const id = String(Date.now());
    setLoans(prev => prev.map(l => l.id === loanId ? { ...l, paybacks: [...l.paybacks, { id, amount, month: monthKey, note: note ?? "" }] } : l));
    saveCashflowPreset(`__tpay_${loanId}_${id}`, amount, monthKey, note ?? null).catch(() => {});
  }, []);

  const deleteLoan = useCallback((loanId) => {
    const loan = loans.find(l => l.id === loanId);
    setLoans(prev => prev.filter(l => l.id !== loanId));
    deleteCashflowPreset(`__tloan_${loanId}`).catch(() => {});
    loan?.paybacks.forEach(p => deleteCashflowPreset(`__tpay_${loanId}_${p.id}`).catch(() => {}));
  }, [loans]);

  const deletePayback = useCallback((loanId, paybackId) => {
    setLoans(prev => prev.map(l => l.id === loanId ? { ...l, paybacks: l.paybacks.filter(p => p.id !== paybackId) } : l));
    deleteCashflowPreset(`__tpay_${loanId}_${paybackId}`).catch(() => {});
  }, []);

  // ── Auto-Match ──────────────────────────────────────────────────────────────
  const transferMatches = useMemo(() => findTransferMatches(transactions), [transactions]);
  const matchedTxnIds = useMemo(() => {
    const ids = new Set();
    transferMatches.forEach(m => { ids.add(m.out.transaction_id); ids.add(m.in.transaction_id); });
    return ids;
  }, [transferMatches]);
  const recurringGroups = useMemo(() => findRecurringGroups(transactions, matchedTxnIds), [transactions, matchedTxnIds]);
  // Unresolved transfer pairs — both legs not already categorized as a transfer.
  const unresolvedTransferMatches = useMemo(() => {
    const alreadyTransfer = new Set();
    (categories || []).forEach(c => { if (/transfer/i.test(c.name)) alreadyTransfer.add(c.id); });
    return transferMatches.filter(m => !(alreadyTransfer.has(assignments[m.out.transaction_id]) && alreadyTransfer.has(assignments[m.in.transaction_id])));
  }, [transferMatches, categories, assignments]);
  const autoMatchBadgeCount = unresolvedTransferMatches.length + recurringGroups.length;

  const acctNameMap = useMemo(() => {
    const map = {};
    allPlaidAccts.forEach(a => { map[a.account_id] = a.name || a.official_name || a.account_id; });
    return map;
  }, [allPlaidAccts]);

  const findOrCreateCategoryId = useCallback(async (name) => {
    const existing = (categories || []).find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const created = await createCategoryApi(name, "#64748b");
    const category = created.category || created;
    if (category?.id && setCategories) setCategories(prev => [...prev, category]);
    return category?.id ?? null;
  }, [categories, setCategories]);

  const applyAssignments = useCallback(async (transactionIds, categoryId) => {
    if (!categoryId) return;
    await Promise.all(transactionIds.map(id => saveAssignment(id, categoryId)));
    if (setAssignments) {
      setAssignments(prev => {
        const next = { ...prev };
        transactionIds.forEach(id => { next[id] = categoryId; });
        return next;
      });
    }
  }, [setAssignments]);

  const applyTransferMatch = useCallback(async (pair) => {
    const categoryId = await findOrCreateCategoryId("Transfer");
    await applyAssignments([pair.out.transaction_id, pair.in.transaction_id], categoryId);
  }, [findOrCreateCategoryId, applyAssignments]);

  const applyRecurringMatch = useCallback(async (group, categoryId) => {
    await applyAssignments(group.txns.map(t => t.transaction_id), categoryId);
  }, [applyAssignments]);

  const saveCcConfig = useCallback((cardId, field, value) => {
    setCcConfig(prev => ({
      ...prev,
      [cardId]: { ...prev[cardId], [field]: value },
    }));
    if (field === "recurringNote") {
      saveCashflowPreset(`__cc_${cardId}_recurring`, ccConfig[cardId]?.recurring ?? DEFAULT_CC_CONFIG[cardId].recurring, null, value).catch(() => {});
    } else {
      saveCashflowPreset(`__cc_${cardId}_${field}`, value, null, null).catch(() => {});
    }
    // "payment" field is deprecated now that it computes automatically
  }, [ccConfig]);

  const saveCcMonthData = useCallback((monthKey, cardId, field, value) => {
    setCcMonthData(prev => ({
      ...prev,
      [monthKey]: { ...(prev[monthKey] ?? {}), [cardId]: { ...(prev[monthKey]?.[cardId] ?? {}), [field]: value } },
    }));
    saveCashflowPreset(`__cc_${cardId}_${field}_${monthKey}`, value, null, null).catch(() => {});
  }, []);

  const addRow = (accountId) => setModal({ type: "add", accountId });

  const saveAdd = (data) => {
    setAccounts(prev => prev.map(a =>
      a.id !== modal.accountId ? a : { ...a, transactions: [...a.transactions, { ...data, id: Date.now() }] }
    ));
    setModal(null);
  };

  const deleteRow = (accountId, txnId) => {
    setAccounts(prev => prev.map(a =>
      a.id !== accountId ? a : { ...a, transactions: a.transactions.filter(t => t.id !== txnId) }
    ));
  };

  // Label for the 3-month window in the navigator
  const windowLabel = (() => {
    const first = months[0];
    const last = months[2];
    if (first.year === last.year) {
      return `${MONTHS[first.monthIdx]} – ${MONTHS[last.monthIdx]} ${first.year}`;
    }
    return `${MONTHS[first.monthIdx]} ${first.year} – ${MONTHS[last.monthIdx]} ${last.year}`;
  })();

  // The primary year shown in FixedAmountsPanel (use first month's year)
  const primaryYear = months[0].year;
  const primaryThreePaycheckMonths = threePaycheckMonthsByYear[primaryYear] ?? new Set();

  return (
    <div style={{ ...styles.wrap, maxWidth: activeTab === "all" ? 1500 : styles.wrap.maxWidth }}>
      <div className="fade-up" style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>Cash Flow</h1>
          <p style={styles.sub}>3-month projected balances with carry-forward</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setShowAutoMatch(true)} style={styles.autoMatchBtn} title="Review suggested transfer & recurring matches">
            ⇄ Auto-Match
            {autoMatchBadgeCount > 0 && <span style={styles.autoMatchBadge}>{autoMatchBadgeCount}</span>}
          </button>
          <div style={styles.monthNav}>
            <button onClick={() => setMonthOffset(o => o - 1)} style={styles.navBtn}>‹</button>
            <div style={styles.monthBadge}>
              <span style={styles.monthLabel}>{windowLabel}</span>
            </div>
            <button onClick={() => setMonthOffset(o => o + 1)} style={styles.navBtn}>›</button>
          </div>
        </div>
      </div>

      <div style={styles.tabBar}>
        {[
          { id: "all",    label: "All Accounts" },
          { id: "amex",   label: "Amex" },
          { id: "macu",   label: "Personal MACU" },
          { id: "shared", label: "Shared MACU" },
          { id: "credit", label: "Credit Cards" },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={activeTab === tab.id ? styles.tabBtnActive : styles.tabBtn}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {months.map(({ monthIdx, year, monthKey }, i) => {
        const isThree = isThreePaycheck(monthIdx, year);
        const monthStates = allMonthStates[monthKey] ?? {};
        const startBals = startBalsPerMonth[i];
        const summary = summaries[i];
        const isFirstMonth = i === 0;

        return (
          <div key={monthKey} style={i > 0 ? styles.monthSection : undefined}>
            {/* Month header */}
            <div className={i === 0 ? "fade-up" : undefined} style={styles.monthHeader}>
              <div style={styles.monthBadge}>
                <span style={styles.monthLabel}>{MONTHS[monthIdx]} {year}</span>
              </div>
              {isThree && (
                <span style={styles.threePaycheckBadge}>3-paycheck month</span>
              )}
            </div>

            {activeTab !== "credit" && (
              <div className={i === 0 ? "fade-up" : undefined}>
                <SummaryBar {...summary} labels={activeTab === "amex" || activeTab === "all" ? undefined : ["Money In", "Money Out", "Net"]} />
              </div>
            )}

            <div className={i === 0 ? "fade-up-2" : undefined} style={activeTab === "all" ? styles.accountsGridAll : styles.accountsGrid}>
              {activeTab === "credit" ? (
                <>
                  {CC_CARDS.map(card => (
                    <CreditCardBlock
                      key={card.id}
                      card={card}
                      config={ccConfig[card.id]}
                      monthData={ccMonthData[monthKey]?.[card.id]}
                      isLinked={!!ccPlaidLinks[card.id]}
                      onLinkAccount={() => setModal({ type: "linkCc", cardId: card.id })}
                      onUpdateConfig={(field, value) => saveCcConfig(card.id, field, value)}
                      onUpdateMonthData={(field, value) => saveCcMonthData(monthKey, card.id, field, value)}
                    />
                  ))}
                  <div style={styles.ccTotalBlock}>
                    <span style={styles.ccTotalLabel}>Total Balance</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 700, color: "var(--red)" }}>
                      {fmt(CC_CARDS.reduce((sum, card) => {
                        const md = ccMonthData[monthKey]?.[card.id];
                        const cfg = ccConfig[card.id];
                        return sum + (md?.balance ?? cfg.defaultBalance ?? 0) + (md?.pending ?? 0) + cfg.recurring + cfg.other;
                      }, 0))}
                    </span>
                  </div>
                </>
              ) : (
                accounts.filter(a => activeTab === "all" || a.id === activeTab).map(acct => (
                  <AccountTable
                    key={acct.id}
                    compact={activeTab === "all"}
                    account={acct}
                    startingBalance={startBals[acct.id] ?? acct.defaultStart}
                    allowEditStart={isFirstMonth}
                    isLinked={!!plaidAcctLinks[acct.id]}
                    presetsMap={presetsMap}
                    monthStates={monthStates}
                    monthAmounts={allMonthAmounts[monthKey] ?? {}}
                    dynamicAmounts={{ "Transfer for Credit Card": computeDynamicCcPayment(monthKey) }}
                    isThreePaycheckMonth={isThree}
                    onTogglePending={(aId, tId) => togglePending(monthKey, aId, tId)}
                    onEditNote={(aId, tId, note) => editNote(monthKey, aId, tId, note)}
                    onEditAmount={(aId, tId, tName) => editAmount(monthKey, aId, tId, tName)}
                    onCommitMonthAmount={(aId, tId, amt) => saveMonthAmount(monthKey, aId, tId, amt)}
                    onUpdateDay={(aId, tId, day) => updateDay(monthKey, aId, tId, day)}
                    onEditStart={() => editStartingBalance(acct.id)}
                    onLinkAccount={() => setModal({ type: "linkAccount", accountId: acct.id })}
                    onAddRow={addRow}
                    onDeleteRow={deleteRow}
                    txnOrder={txnOrders[acct.id]}
                    onReorder={reorderAccount}
                  />
                ))
              )}
            </div>

            <MonthNotes
              note={allMonthNotes[monthKey]}
              onSave={(text) => saveNote(monthKey, text)}
            />
          </div>
        );
      })}

      <div className="fade-up-3" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 20 }}>
        <TempLoansPanel
          loans={loans}
          currentMonthKey={months[0]?.monthKey}
          onAddLoan={addLoan}
          onAddPayback={addPayback}
          onDeleteLoan={deleteLoan}
          onDeletePayback={deletePayback}
        />
        <FixedAmountsPanel
          presets={presets}
          year={primaryYear}
          payBaseDate={payBaseDate}
          threePaycheckMonths={primaryThreePaycheckMonths}
          onEditPreset={savePreset}
          onEditPayCycle={() => setModal({ type: "editPayCycle" })}
        />
      </div>

      {showAutoMatch && (
        <AutoMatchModal
          transferPairs={unresolvedTransferMatches}
          recurringGroups={recurringGroups}
          acctNameMap={acctNameMap}
          categories={categories}
          assignments={assignments}
          onApplyTransfer={applyTransferMatch}
          onApplyRecurring={applyRecurringMatch}
          onClose={() => setShowAutoMatch(false)}
        />
      )}

      {modal?.type === "add" && (
        <AddModal
          accountName={accounts.find(a => a.id === modal.accountId)?.name}
          onSave={saveAdd}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "editPreset" && (
        <EditPresetModal
          presetName={modal.name}
          currentAmount={modal.amount}
          onSave={(newAmt) => savePreset(modal.name, newAmt)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "editMonthAmount" && (
        <EditPresetModal
          presetName={modal.txnName}
          currentAmount={modal.amount}
          subtitle="This month only · Positive = inflow · Negative = outflow"
          onSave={(newAmt) => saveMonthAmount(modal.monthKey, modal.accountId, modal.txnId, newAmt)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "editStart" && (
        <EditPresetModal
          presetName={`Starting Balance — ${accounts.find(a => a.id === modal.accountId)?.name}`}
          currentAmount={modal.amount}
          onSave={(newAmt) => saveStartingBalance(modal.accountId, newAmt)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "editPayCycle" && (
        <EditPayCycleModal
          currentDateNum={payBaseDate}
          onSave={savePayCycleDate}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "linkAccount" && (
        <LinkAccountModal
          accountName={accounts.find(a => a.id === modal.accountId)?.name}
          currentLinkId={plaidAcctLinks[modal.accountId]}
          plaidAccounts={allPlaidAccts}
          onSelect={(plaidAccountId) => savePlaidLink(modal.accountId, plaidAccountId)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "linkCc" && (
        <LinkAccountModal
          accountName={CC_CARDS.find(c => c.id === modal.cardId)?.label}
          currentLinkId={ccPlaidLinks[modal.cardId]}
          plaidAccounts={allPlaidAccts}
          onSelect={(plaidAccountId) => saveCcPlaidLink(modal.cardId, plaidAccountId)}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Shared spreadsheet cell base — every grid cell gets a 1px shared gridline border.
const gridCellBase = { border: "1px solid var(--grid-line)", padding: "2px 6px", height: 25, fontSize: 12, color: "var(--text)", verticalAlign: "middle", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "default" };

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 1100 },
  topRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, flexWrap: "wrap", gap: 16 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text)", marginBottom: 4 },
  sub: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },

  monthNav: { display: "flex", alignItems: "center", gap: 8 },
  monthBadge: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 16px" },
  monthLabel: { fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--text)" },
  navBtn: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 18, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },

  tabBar: { display: "flex", overflowX: "auto", gap: 2, marginBottom: 24, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 4 },
  tabBtn: { flex: 1, padding: "8px 16px", borderRadius: "calc(var(--radius) - 2px)", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, fontFamily: "var(--font-display)", background: "transparent", color: "var(--muted)", transition: "all 0.15s", whiteSpace: "nowrap" },
  tabBtnActive: { flex: 1, padding: "8px 16px", borderRadius: "calc(var(--radius) - 2px)", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-display)", background: "var(--accent)", color: "#fff", transition: "all 0.15s", whiteSpace: "nowrap" },

  monthSection: { marginTop: 40, paddingTop: 32, borderTop: "1px solid var(--border)" },
  monthHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  threePaycheckBadge: { fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--accent)", background: "rgba(240,180,41,0.12)", border: "1px solid rgba(240,180,41,0.3)", borderRadius: "var(--radius)", padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.08em" },

  summaryTable: { borderCollapse: "collapse", tableLayout: "fixed", width: 320, maxWidth: "100%", marginBottom: 24, background: "var(--surface)" },
  summaryHeadCell: { background: "#1a1a1a", color: "#fff", fontWeight: 700, fontSize: 11, fontFamily: "var(--font-display)", padding: "3px 8px", border: "1px solid var(--grid-line)", textAlign: "left", height: 24 },
  summaryLabelCell: { border: "1px solid var(--grid-line)", padding: "2px 8px", height: 25, fontSize: 12, color: "var(--text)" },
  summaryValCell: { border: "1px solid var(--grid-line)", padding: "2px 8px", height: 25, fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)", fontWeight: 600 },

  accountsGrid: { display: "flex", flexDirection: "column", gap: 20, marginBottom: 24 },
  accountsGridAll: { display: "flex", overflowX: "auto", gap: 14, marginBottom: 24, alignItems: "start", paddingBottom: 8 },

  autoMatchBtn: { display: "flex", alignItems: "center", gap: 7, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-display)", padding: "7px 14px", cursor: "pointer" },
  autoMatchBadge: { background: "var(--accent)", color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", borderRadius: 99, padding: "1px 6px" },

  loanBtn: { background: "none", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-display)" },

  matchOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
  matchModal: { background: "var(--surface)", border: "1px solid var(--border2)", borderRadius: "var(--radius2)", width: 640, maxWidth: "96vw", maxHeight: "88vh", display: "flex", flexDirection: "column" },
  matchHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "20px 24px 14px", borderBottom: "1px solid var(--border)" },
  matchTitle: { fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 3 },
  matchSub: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", lineHeight: 1.5 },
  matchClose: { background: "none", border: "none", color: "var(--muted)", fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 0 },
  matchBody: { padding: "16px 24px", overflowY: "auto", flex: 1 },
  matchEmpty: { fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-mono)", textAlign: "center", padding: "32px 0" },
  matchSectionLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)", fontFamily: "var(--font-mono)", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 },
  matchSectionCount: { fontSize: 10, fontWeight: 500, color: "var(--muted)", letterSpacing: "0.04em" },
  matchSectionHint: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", lineHeight: 1.5, marginBottom: 10 },
  matchRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" },
  matchRowMain: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
  matchAmount: { fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" },
  matchDetail: { fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  matchDetailMuted: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  matchActions: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  matchCatSelect: { padding: "5px 7px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer", maxWidth: 130 },
  matchAccept: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, padding: "5px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-display)" },
  matchReject: { background: "none", color: "var(--red)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 9px", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-display)" },
  matchSkip: { background: "none", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 9px", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-display)" },
  matchTag: { fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)", border: "1px solid var(--border)", borderRadius: 99, padding: "2px 8px" },
  matchFooter: { padding: "14px 24px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" },
  matchDoneBtn: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-display)" },

  accountBlock: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden", minWidth: 320, flexShrink: 0 },
  accountHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" },
  accountName: { fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 2 },
  accountStartBal: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  accountEndLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 3 },
  accountEndBal: { fontSize: 20, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em" },

  pendingBar: { display: "flex", alignItems: "center", gap: 8, padding: "7px 20px", background: "rgba(240,180,41,0.06)", borderBottom: "1px solid var(--border)" },
  pendingDot: { width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 },

  tableWrap: { padding: "0 0 8px", outline: "none" },
  grid: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: 12 },
  gridHeadCell: { background: "#1a1a1a", color: "#fff", fontWeight: 700, fontSize: 11, fontFamily: "var(--font-display)", padding: "3px 6px", border: "1px solid var(--grid-line)", textAlign: "left", whiteSpace: "nowrap", height: 24 },
  gridCell: gridCellBase,
  gridNumCell: { ...gridCellBase, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)" },
  cellInput: { width: "100%", height: 21, border: "none", outline: "none", background: "var(--surface)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", padding: "0 2px", boxSizing: "border-box" },

  dragHandle: { display: "inline-block", width: "100%", fontSize: 12, color: "var(--border2)", cursor: "grab", userSelect: "none", lineHeight: "23px" },
  gridDeleteBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", width: "100%", padding: 0, lineHeight: 1 },
  deleteBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", width: 28, padding: 0, textAlign: "center", lineHeight: 1, opacity: 0.5 },
  addRowBtn: { display: "block", width: "calc(100% - 40px)", margin: "8px 20px 4px", padding: "7px 0", background: "none", border: "1px dashed var(--border2)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer" },

  fixedPanel: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 24px" },
  fixedTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  fixedGrid: { display: "flex", flexDirection: "column", gap: 6 },
  fixedRow: { display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: 6 },
  fixedFooter: { display: "flex", gap: 16, alignItems: "center", marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border2)" },
  presetInput: { width: 80, padding: "2px 6px", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 4, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none", textAlign: "right" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: "var(--radius2)", padding: 28, width: 340, display: "flex", flexDirection: "column", gap: 14 },
  modalTitle: { fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4 },
  modalFields: { display: "flex", flexDirection: "column", gap: 10 },
  fieldLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  fieldInput: { width: "100%", padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none", marginTop: 4 },
  fieldSelect: { width: "100%", padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none", marginTop: 4 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 },
  cancelBtn: { padding: "8px 18px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-display)", cursor: "pointer" },
  saveBtn: { padding: "8px 18px", background: "var(--accent)", border: "none", borderRadius: "var(--radius)", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-display)", cursor: "pointer" },

  noteText: { fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderBottom: "1px dashed var(--border2)" },
  noteAdd: { fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", cursor: "pointer", opacity: 0.55 },
  noteInput: { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text)", background: "transparent", border: "none", borderBottom: "1px solid var(--accent)", outline: "none", width: "100%", padding: "1px 0" },

  notesSection: { marginTop: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "14px 18px" },
  notesLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 8 },
  notesTextarea: { width: "100%", minHeight: 64, background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", padding: "8px 10px", resize: "vertical", outline: "none", lineHeight: 1.5, boxSizing: "border-box" },

  ccBlock: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  ccCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "14px 20px 10px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" },
  ccCardName: { fontSize: 15, fontWeight: 700, color: "var(--text)" },
  ccCardDue: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  ccTableWrap: { padding: "0 20px 12px" },
  ccColHeader: { display: "flex", alignItems: "center", padding: "8px 0 4px", borderBottom: "1px solid var(--border)", marginBottom: 4 },
  ccColLabel: { width: 110, textAlign: "right", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase" },
  ccColLabelWide: { width: 160, textAlign: "right", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase" },
  ccTableRow: { display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)" },
  ccRowLabel: { flex: 1, fontSize: 12, color: "var(--text)" },
  ccEditable: { fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text)", cursor: "pointer", borderBottom: "1px dashed var(--border2)" },
  ccInput: { width: 90, padding: "2px 6px", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 4, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none", textAlign: "right" },

  ccTotalBlock: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "16px 24px" },
  ccTotalLabel: { fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" },
};
