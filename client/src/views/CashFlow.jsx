import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  fetchCashflowPresets, saveCashflowPreset,
  fetchCashflowStates, saveCashflowState,
  fetchCashflowMappings, saveCashflowMapping,
  fetchTransactionsForMonth,
  fetchAccounts,
  fetchAccountBalances,
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
      { id: 1,  day: 1,  name: "Personal Jared",                  freq: "Monthly",    amount: -2637,   isTransfer: true                        },
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
      { id: 18, day: 1,  name: "Personal Expenses Transfer",      freq: "Monthly",    amount: -500,    isTransfer: true                        },
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
      { id: 3,  day: 2,  name: "Personal Jared",           freq: "Monthly",    amount: 2637,   isTransfer: true   },
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
      { id: 14, day: 1,  name: "Personal Expenses In",     freq: "Monthly",    amount: 500,    isTransfer: true   },
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
  { name: "Personal Expenses Transfer",         amount: -500,    freq: "Monthly",    note: "" },
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

// When a preset is saved for these names, the paired name gets the negated amount automatically.
const TRANSFER_MIRRORS = {
  "Jared Transfer to Shared":  "Jared Transfer In",
  "Jared Transfer In":         "Jared Transfer to Shared",
  "Extra Transfer Out":        "Extra Transfer In",
  "Extra Transfer In":         "Extra Transfer Out",
  "Personal Expenses Transfer": "Personal Expenses In",
  "Personal Expenses In":      "Personal Expenses Transfer",
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

function matchPlaidToAccount(plaidName, institutionName, acctId, acctDisplayName) {
  const p = plaidName.toLowerCase();
  const inst = (institutionName || "").toLowerCase();
  if (p.includes(acctId.toLowerCase())) return true;
  // MACU accounts are named "PERSONAL MYFREE", "ASHTON", etc. — match by institution
  if (acctId === "macu" && inst.includes("mountain america")) return true;
  return acctDisplayName.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3)
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

// ── Summary helper ────────────────────────────────────────────────────────────
function computeSummary(accounts, presetsMap, isThreePaycheck) {
  const allTxns = accounts.flatMap(a =>
    a.transactions.filter(t => !t.defaultPending || isThreePaycheck)
  );
  const eff = t => presetsMap[t.name] ?? t.amount;
  // Take-home = all non-transfer income (paychecks + Alta transfers)
  const takeHome = allTxns
    .filter(t => !t.isTransfer && eff(t) > 0)
    .reduce((s, t) => s + eff(t), 0);
  // Expenses = all non-transfer outflows
  const expenses = allTxns
    .filter(t => !t.isTransfer && eff(t) < 0)
    .reduce((s, t) => s + eff(t), 0);
  return { takeHome, expenses, freeCashflow: takeHome + expenses };
}

// ── Projected ending balance helper ──────────────────────────────────────────
function computeProjectedEndBals(accounts, startBals, presetsMap, isThreePaycheck) {
  const result = {};
  accounts.forEach(acct => {
    const start = startBals[acct.id] ?? acct.defaultStart;
    const sorted = [...acct.transactions].sort((a, b) => a.day - b.day);
    const filtered = sorted.filter(t => !t.defaultPending || isThreePaycheck);
    let running = start;
    filtered.forEach(t => { running += presetsMap[t.name] ?? t.amount; });
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

function SummaryBar({ takeHome, expenses, freeCashflow }) {
  return (
    <div style={styles.summaryBar}>
      <div style={styles.summaryItem}>
        <span style={styles.summaryLabel}>Take-Home Income</span>
        <span style={{ ...styles.summaryVal, color: "var(--green)" }}>{fmt(takeHome)}</span>
      </div>
      <div style={styles.summaryDivider} />
      <div style={styles.summaryItem}>
        <span style={styles.summaryLabel}>Est. Expenses</span>
        <span style={{ ...styles.summaryVal, color: "var(--red)" }}>{fmt(expenses)}</span>
      </div>
      <div style={styles.summaryDivider} />
      <div style={styles.summaryItem}>
        <span style={styles.summaryLabel}>Free Cashflow</span>
        <span style={{ ...styles.summaryVal, color: freeCashflow >= 0 ? "var(--accent)" : "var(--red)" }}>
          {fmt(freeCashflow, true)}
        </span>
      </div>
    </div>
  );
}

function AccountTable({ account, startingBalance, allowEditStart, presetsMap, monthStates, isThreePaycheckMonth, onTogglePending, onEditNote, onEditAmount, onEditStart, onAddRow, onDeleteRow, txnOrder, onReorder }) {
  const [dragOverId, setDragOverId] = useState(null);
  const [noteEditId, setNoteEditId] = useState(null);
  const [noteEditVal, setNoteEditVal] = useState("");
  const dragItemId = useRef(null);

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
    const ids = filteredRef.current.map(t => t.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) { setDragOverId(null); return; }
    const newOrder = [...ids];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, fromId);
    onReorder(account.id, newOrder);
    setDragOverId(null);
  };
  const effectiveAmt = (t) => presetsMap[t.name] ?? t.amount;

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

  return (
    <div style={styles.accountBlock}>
      <div style={styles.accountHeader}>
        <div>
          <p style={styles.accountName}>{account.name}</p>
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

      <div style={styles.tableWrap}>
        <div style={styles.txnHeader}>
          <span style={{ width: 20 }} />
          <span style={{ width: 30 }}>Day</span>
          <span style={{ flex: 1 }}>Transaction</span>
          <span style={{ width: 80 }}>Freq</span>
          <span style={{ width: 80, textAlign: "right" }}>Amount</span>
          <span style={{ width: 90, textAlign: "right" }}>Running Bal</span>
          <span style={{ width: 50, textAlign: "center" }}>Done</span>
          <span style={{ width: 90, textAlign: "right" }}>Conf. Bal</span>
          <span style={{ width: 28 }} />
        </div>

        {rows.map((t) => (
          <div
            key={t.id}
            draggable
            onDragStart={(e) => handleDragStart(e, t.id)}
            onDragEnter={() => handleDragEnter(t.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, t.id)}
            style={{
              ...styles.txnRow,
              background: dragOverId === t.id ? "rgba(240,180,41,0.1)" : t.isPending ? "rgba(240,180,41,0.04)" : "transparent",
              borderLeft: t.isPending ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <span style={styles.dragHandle} title="Drag to reorder">⠿</span>
            <span style={{ ...styles.txnDay, color: t.displayDay !== t.day ? "var(--accent)" : "var(--muted)" }}
              title={t.displayDay !== t.day ? `Template day: ${t.day}` : undefined}>
              {t.displayDay}
            </span>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingRight: 8, gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name}
                {presetsMap[t.name] !== undefined && (
                  <span style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", marginLeft: 5, opacity: 0.6 }}>preset</span>
                )}
              </span>
              {noteEditId === t.id ? (
                <input
                  autoFocus
                  value={noteEditVal}
                  onChange={e => setNoteEditVal(e.target.value)}
                  onBlur={() => { onEditNote(account.id, t.id, noteEditVal); setNoteEditId(null); }}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") { onEditNote(account.id, t.id, noteEditVal); setNoteEditId(null); } }}
                  style={styles.noteInput}
                  placeholder="Add a note…"
                />
              ) : (
                <span
                  onClick={() => { setNoteEditId(t.id); setNoteEditVal(t.note ?? ""); }}
                  style={t.note ? styles.noteText : styles.noteAdd}
                >
                  {t.note || "+ note"}
                </span>
              )}
            </div>
            <span style={{ width: 80, fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{t.freq}</span>
            <span
              style={{ width: 80, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: t.effectiveAmt >= 0 ? "var(--green)" : "var(--red)", cursor: "pointer" }}
              onClick={() => onEditAmount(account.id, t.id, t.name)}
              title="Click to edit preset"
            >
              {fmt(t.effectiveAmt)}
            </span>
            <span style={{ width: 90, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: t.runningBalance >= 0 ? "var(--text)" : "var(--red)" }}>
              {fmtShort(t.runningBalance)}
            </span>
            <span style={{ width: 50, textAlign: "center" }}>
              <button
                onClick={() => onTogglePending(account.id, t.id)}
                style={{ ...styles.pendingBtn, background: t.isPending ? "var(--accent)" : "var(--border2)", color: t.isPending ? "#fff" : "var(--muted)" }}
              >
                {t.isPending ? "Y" : "N"}
              </button>
            </span>
            <span style={{ width: 90, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: t.isPending ? "var(--accent)" : "var(--muted)", opacity: t.isPending ? 1 : 0.45 }}>
              {fmtShort(t.confirmedBalance)}
            </span>
            <button onClick={() => onDeleteRow(account.id, t.id)} style={styles.deleteBtn} title="Remove">×</button>
          </div>
        ))}

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

// ── Modals ────────────────────────────────────────────────────────────────────
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

function EditPresetModal({ presetName, currentAmount, onSave, onClose }) {
  const [val, setVal] = useState(currentAmount != null ? String(currentAmount) : "");

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Edit: {presetName}</p>
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          Positive = inflow · Negative = outflow · All rows with this name update.
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

// ── Main CashFlow View ────────────────────────────────────────────────────────
const now = new Date();

export default function CashFlow() {
  // monthOffset: 0 = current month is first, 1 = next month is first, etc.
  const [monthOffset, setMonthOffset] = useState(0);

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
  // allMonthStates: { [monthKey]: { [acctId_txnId]: { isPending, plaidTxnId } } }
  const [allMonthStates, setAllMonthStates] = useState({});
  // allRecentTxns: { [monthKey]: txns[] }
  const [allRecentTxns, setAllRecentTxns] = useState({});
  const [txnOrders, setTxnOrders] = useState({});
  const [allMonthNotes, setAllMonthNotes] = useState({});
  const [modal, setModal] = useState(null);
  const autoConfirmedRef = useRef(new Set());

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

  // Carry-forward starting balances: month 0 uses real startingBals,
  // month 1 uses projected end of month 0, month 2 uses projected end of month 1.
  const startBalsPerMonth = useMemo(() => {
    const result = [startingBals];
    let prev = startingBals;
    for (let i = 0; i < 2; i++) {
      const { monthIdx, year } = months[i];
      const endBals = computeProjectedEndBals(accounts, prev, presetsMap, isThreePaycheck(monthIdx, year));
      result.push(endBals);
      prev = endBals;
    }
    return result;
  }, [months, startingBals, accounts, presetsMap, isThreePaycheck]);

  // Summary per month
  const summaries = useMemo(() => {
    return months.map(({ monthIdx, year }, i) => {
      return computeSummary(accounts, presetsMap, isThreePaycheck(monthIdx, year));
    });
  }, [months, accounts, presetsMap, isThreePaycheck]);

  // Load all startup data sequentially so DB-saved balances are never overwritten by Plaid.
  // The race condition with separate effects: Plaid fires immediately with an empty userSetStartIds
  // closure, then its .then() callback arrives after DB presets have loaded and overwrites them.
  // Sequential async loading uses a local variable so Plaid always sees the DB-saved IDs.
  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      // 1. DB presets — amounts, starting balances, pay cycle, row order, notes
      let userSetIds = new Set();
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
            if (db) { newBals[a.id] = db.amount; userSetIds.add(a.id); }
            const orderPref = dbPresets.find(p => p.name === `__order_${a.id}`);
            if (orderPref?.note) { try { newOrders[a.id] = JSON.parse(orderPref.note); } catch {} }
          });
          if (Object.keys(newBals).length > 0) setStartingBals(prev => ({ ...prev, ...newBals }));
          if (userSetIds.size > 0) setUserSetStartIds(userSetIds);
          if (Object.keys(newOrders).length > 0) setTxnOrders(newOrders);

          const newNotes = {};
          dbPresets.forEach(p => {
            if (p.name.startsWith("__note_")) newNotes[p.name.replace("__note_", "")] = p.note ?? "";
          });
          if (Object.keys(newNotes).length > 0) setAllMonthNotes(newNotes);
        }
      } catch {}

      if (cancelled) return;

      // 2. Live Plaid balances — skip any account whose balance came from DB above
      try {
        const data = await fetchAccounts();
        const plaidAccts = data?.accounts ?? [];
        if (!cancelled && plaidAccts.length) {
          setStartingBals(prev => {
            const next = { ...prev };
            DEFAULT_ACCOUNTS.forEach(acct => {
              if (userSetIds.has(acct.id)) return;
              const match = plaidAccts.find(p => matchPlaidToAccount(p.name, p.institutionName, acct.id, acct.name));
              if (match?.balances?.current != null) next[acct.id] = match.balances.current;
            });
            return next;
          });
        }
      } catch {}

      if (cancelled) return;

      // 3. Imported account balances (fallback when Plaid sandbox has no real data)
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

  const editAmount = useCallback((accountId, txnId, txnName) => {
    const amt = presetsMap[txnName];
    if (amt !== undefined) {
      setModal({ type: "editPreset", name: txnName, amount: amt });
    } else {
      const acct = accounts.find(a => a.id === accountId);
      const txn = acct?.transactions.find(t => t.id === txnId);
      if (txn) setModal({ type: "editPreset", name: txn.name, amount: txn.amount });
    }
  }, [presetsMap, accounts]);

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

  const editStartingBalance = useCallback((accountId) => {
    setModal({ type: "editStart", accountId, amount: startingBals[accountId] });
  }, [startingBals]);

  const saveStartingBalance = useCallback((accountId, amount) => {
    setStartingBals(prev => ({ ...prev, [accountId]: amount }));
    setUserSetStartIds(prev => new Set([...prev, accountId]));
    saveCashflowPreset(`__start_${accountId}`, amount, null, null).catch(() => {});
    setModal(null);
  }, []);

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
    <div style={styles.wrap}>
      <div className="fade-up" style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>Cash Flow</h1>
          <p style={styles.sub}>3-month projected balances with carry-forward</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={styles.monthNav}>
            <button onClick={() => setMonthOffset(o => o - 1)} style={styles.navBtn}>‹</button>
            <div style={styles.monthBadge}>
              <span style={styles.monthLabel}>{windowLabel}</span>
            </div>
            <button onClick={() => setMonthOffset(o => o + 1)} style={styles.navBtn}>›</button>
          </div>
        </div>
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

            <div className={i === 0 ? "fade-up" : undefined}>
              <SummaryBar {...summary} />
            </div>

            <div className={i === 0 ? "fade-up-2" : undefined} style={styles.accountsGrid}>
              {accounts.map(acct => (
                <AccountTable
                  key={acct.id}
                  account={acct}
                  startingBalance={startBals[acct.id] ?? acct.defaultStart}
                  allowEditStart={isFirstMonth}
                  presetsMap={presetsMap}
                  monthStates={monthStates}
                  isThreePaycheckMonth={isThree}
                  onTogglePending={(aId, tId) => togglePending(monthKey, aId, tId)}
                  onEditNote={(aId, tId, note) => editNote(monthKey, aId, tId, note)}
                  onEditAmount={editAmount}
                  onEditStart={() => editStartingBalance(acct.id)}
                  onAddRow={addRow}
                  onDeleteRow={deleteRow}
                  txnOrder={txnOrders[acct.id]}
                  onReorder={reorderAccount}
                />
              ))}
            </div>

            <MonthNotes
              note={allMonthNotes[monthKey]}
              onSave={(text) => saveNote(monthKey, text)}
            />
          </div>
        );
      })}

      <div className="fade-up-3" style={{ marginTop: 8 }}>
        <FixedAmountsPanel
          presets={presets}
          year={primaryYear}
          payBaseDate={payBaseDate}
          threePaycheckMonths={primaryThreePaycheckMonths}
          onEditPreset={savePreset}
          onEditPayCycle={() => setModal({ type: "editPayCycle" })}
        />
      </div>

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
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  wrap: { padding: "36px 40px", maxWidth: 1100 },
  topRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text)", marginBottom: 4 },
  sub: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },

  monthNav: { display: "flex", alignItems: "center", gap: 8 },
  monthBadge: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 16px" },
  monthLabel: { fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--text)" },
  navBtn: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 18, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },

  monthSection: { marginTop: 40, paddingTop: 32, borderTop: "1px solid var(--border)" },
  monthHeader: { display: "flex", alignItems: "center", gap: 12, marginBottom: 16 },
  threePaycheckBadge: { fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--accent)", background: "rgba(240,180,41,0.12)", border: "1px solid rgba(240,180,41,0.3)", borderRadius: "var(--radius)", padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.08em" },

  summaryBar: { display: "flex", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "18px 28px", marginBottom: 24, gap: 0 },
  summaryItem: { flex: 1, display: "flex", flexDirection: "column", gap: 4 },
  summaryDivider: { width: 1, background: "var(--border)", margin: "0 28px" },
  summaryLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  summaryVal: { fontSize: 24, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.03em" },

  accountsGrid: { display: "flex", flexDirection: "column", gap: 20, marginBottom: 24 },

  accountBlock: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  accountHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" },
  accountName: { fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 2 },
  accountStartBal: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  accountEndLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 3 },
  accountEndBal: { fontSize: 20, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em" },

  pendingBar: { display: "flex", alignItems: "center", gap: 8, padding: "7px 20px", background: "rgba(240,180,41,0.06)", borderBottom: "1px solid var(--border)" },
  pendingDot: { width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 },

  tableWrap: { padding: "0 0 8px" },
  txnHeader: { display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", background: "var(--surface2)", borderBottom: "1px solid var(--border)" },
  txnRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", borderBottom: "1px solid var(--border)", transition: "background 0.1s" },
  txnDay: { width: 30, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)", textAlign: "center" },

  pendingBtn: { border: "none", borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", padding: "2px 7px", cursor: "pointer", transition: "background 0.15s" },
  dragHandle: { width: 20, textAlign: "center", fontSize: 13, color: "var(--border2)", cursor: "grab", userSelect: "none", flexShrink: 0 },
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
};
