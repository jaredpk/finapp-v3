import React, { useState, useMemo, useEffect, useCallback } from "react";
import {
  fetchCashflowPresets, saveCashflowPreset,
  fetchCashflowStates, saveCashflowState,
  fetchCashflowMappings, saveCashflowMapping,
  fetchTransactionsForMonth,
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
      { id: 1,  day: 1,  name: "Personal Jared",                  freq: "Monthly",    amount: -2637   },
      { id: 2,  day: 5,  name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009    },
      { id: 3,  day: 7,  name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900   },
      { id: 4,  day: 10, name: "UESP",                            freq: "Monthly",    amount: -100    },
      { id: 5,  day: 19, name: "Transfer Reserve Account",        freq: "Monthly",    amount: -500    },
      { id: 6,  day: 20, name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009    },
      { id: 7,  day: 24, name: "Jared Transfer to Personal Macu", freq: "Monthly",    amount: -629.84 },
      { id: 8,  day: 27, name: "Transfer to Long-Term Purchases", freq: "Monthly",    amount: -250    },
      { id: 9,  day: 27, name: "Transfer to Emergency Fund",      freq: "Monthly",    amount: -250    },
      { id: 10, day: 27, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900   },
      { id: 11, day: 28, name: "Transfer to Joint Savings",       freq: "Monthly",    amount: -385    },
      { id: 12, day: 30, name: "Transfer for PTO Reserve",        freq: "Monthly",    amount: -320    },
      { id: 13, day: 30, name: "Personal IRA Transfer",           freq: "Monthly",    amount: -500    },
      { id: 14, day: 30, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900   },
      { id: 15, day: 30, name: "Paycheck (Month End)",            freq: "Monthly",    amount: 4009    },
    ],
  },
  {
    id: "macu",
    name: "MACU Checking",
    defaultStart: 1201,
    transactions: [
      { id: 1, day: 5,  name: "Child Support Out",               freq: "Bi-Monthly", amount: -314.93 },
      { id: 2, day: 19, name: "Child Support Out",               freq: "Bi-Monthly", amount: -314.93 },
      { id: 3, day: 23, name: "Jared Transfer to Personal Macu", freq: "Monthly",    amount: 629.84  },
    ],
  },
  {
    id: "shared",
    name: "Shared Checking",
    defaultStart: 3610,
    transactions: [
      { id: 1,  day: 1,  name: "Other Misc. Shared",              freq: "Bi-Monthly", amount: -500   },
      { id: 2,  day: 1,  name: "House Payment",                   freq: "Bi-Monthly", amount: -2017  },
      { id: 3,  day: 2,  name: "Personal Jared",                  freq: "Monthly",    amount: 2637   },
      { id: 4,  day: 7,  name: "Jared Transfer In",               freq: "Monthly",    amount: 1900   },
      { id: 5,  day: 12, name: "Alta Transfer",                   freq: "Bi-Weekly",  amount: 1500   },
      { id: 6,  day: 15, name: "Car Payment",                     freq: "Monthly",    amount: -289   },
      { id: 7,  day: 24, name: "Alta Transfer",                   freq: "Bi-Weekly",  amount: 1500   },
      { id: 8,  day: 24, name: "Transfer for Credit Card",        freq: "Monthly",    amount: -6000  },
      { id: 9,  day: 28, name: "Jared Transfer In",               freq: "Monthly",    amount: 1900   },
      { id: 10, day: 28, name: "Misc. Utilities",                 freq: "Monthly",    amount: -500   },
      { id: 11, day: 30, name: "Jared Transfer In",               freq: "Monthly",    amount: 1900   },
    ],
  },
];

// Flat list of all cashflow rows for matching / dropdowns
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
  { name: "Paycheck",                           amount: 4009,    freq: "Bi-Monthly", note: "Estimated w/ 15% into 401k" },
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
  { name: "Car Payment",                        amount: -289,    freq: "Monthly",    note: "" },
];

// ── Matching algorithm ────────────────────────────────────────────────────────
// Plaid: positive amount = expense (money out), negative = income (money in)
function scoreMatch(plaidTxn, row, presetsMap) {
  const plaidCashflowAmt = -plaidTxn.amount; // convert to cashflow sign convention
  const expectedAmt = presetsMap[row.txnName] ?? row.defaultAmount;
  const plaidDay = new Date(plaidTxn.date + "T12:00:00").getDate();
  const merchant = (plaidTxn.merchant_name || plaidTxn.name || "").toLowerCase();

  let score = 0;

  // Wrong direction is a dealbreaker
  if ((plaidCashflowAmt > 0) !== (expectedAmt > 0)) return -99;

  // Amount match
  if (Math.abs(expectedAmt) > 0) {
    const ratio = Math.abs(plaidCashflowAmt) / Math.abs(expectedAmt);
    if (ratio >= 0.97 && ratio <= 1.03) score += 5;
    else if (ratio >= 0.9 && ratio <= 1.1) score += 2;
  }

  // Day proximity
  const dayDiff = Math.abs(plaidDay - row.txnDay);
  if (dayDiff === 0) score += 3;
  else if (dayDiff <= 2) score += 2;
  else if (dayDiff <= 5) score += 1;

  // Name/keyword overlap (skip short words)
  const txnWords = row.txnName.toLowerCase().split(/[\s_\-&.,]+/).filter(w => w.length > 3);
  const overlap = txnWords.filter(w => merchant.includes(w)).length;
  score += Math.min(overlap * 2, 4);

  return score;
}

function suggestMatch(plaidTxn, presetsMap) {
  let best = null;
  let bestScore = 3; // minimum threshold
  for (const row of ALL_ROWS) {
    const s = scoreMatch(plaidTxn, row, presetsMap);
    if (s > bestScore) { bestScore = s; best = row; }
  }
  return best;
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
        <span style={styles.summaryLabel}>Monthly Take-Home</span>
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

function AccountTable({ account, startingBalance, presetsMap, monthStates, onTogglePending, onEditAmount, onEditStart, onAddRow, onDeleteRow }) {
  const sorted = [...account.transactions].sort((a, b) => a.day - b.day);
  const effectiveAmt = (t) => presetsMap[t.name] ?? t.amount;

  let running = startingBalance;
  let pendingBal = startingBalance;
  const rows = sorted.map((t) => {
    const state = monthStates[`${account.id}_${t.id}`] || {};
    const isPending = state.isPending ?? false;
    const amt = effectiveAmt(t);
    if (isPending) pendingBal += amt;
    running += amt;
    return { ...t, effectiveAmt: amt, isPending, runningBalance: running, pendingBalance: isPending ? pendingBal : 0 };
  });

  const endBal = rows.length ? rows[rows.length - 1].runningBalance : startingBalance;
  const minBal = rows.reduce((m, r) => Math.min(m, r.runningBalance), startingBalance);
  const pendingRows = rows.filter((r) => r.isPending);
  const pendingTotal = pendingRows.reduce((s, r) => s + r.effectiveAmt, 0);

  return (
    <div style={styles.accountBlock}>
      <div style={styles.accountHeader}>
        <div>
          <p style={styles.accountName}>{account.name}</p>
          <p
            style={{ ...styles.accountStartBal, cursor: "pointer", borderBottom: "1px dashed var(--border2)" }}
            onClick={onEditStart}
            title="Click to edit starting balance"
          >
            Starting: {fmt(startingBalance)}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={styles.accountEndLabel}>Est. Ending</p>
          <p style={{ ...styles.accountEndBal, color: endBal >= 0 ? "var(--green)" : "var(--red)" }}>{fmtShort(endBal)}</p>
          <p style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
            Min: {fmtShort(minBal)}
          </p>
        </div>
      </div>

      {pendingRows.length > 0 && (
        <div style={styles.pendingBar}>
          <span style={styles.pendingDot} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {pendingRows.length} confirmed · {fmt(pendingTotal, true)} ·{" "}
            <span style={{ color: "var(--accent)" }}>confirmed balance: {fmt(pendingBal)}</span>
          </span>
        </div>
      )}

      <div style={styles.tableWrap}>
        <div style={styles.txnHeader}>
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
            style={{
              ...styles.txnRow,
              background: t.isPending ? "rgba(240,180,41,0.04)" : "transparent",
              borderLeft: t.isPending ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <span style={styles.txnDay}>{t.day}</span>
            <span style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
              {t.name}
              {presetsMap[t.name] !== undefined && (
                <span style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", marginLeft: 5, opacity: 0.6 }}>preset</span>
              )}
            </span>
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
            <span style={{ width: 90, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
              {t.isPending ? fmtShort(t.pendingBalance) : "—"}
            </span>
            <button onClick={() => onDeleteRow(account.id, t.id)} style={styles.deleteBtn} title="Remove">×</button>
          </div>
        ))}

        <button onClick={() => onAddRow(account.id)} style={styles.addRowBtn}>+ Add Transaction</button>
      </div>
    </div>
  );
}

// ── Fixed Amounts Panel (editable) ────────────────────────────────────────────
function FixedAmountsPanel({ presets, onEditPreset }) {
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
    </div>
  );
}

// ── Verify Queue ──────────────────────────────────────────────────────────────
function VerifyItem({ plaidTxn, suggested, presetsMap, onConfirm, onSkip }) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerVal, setPickerVal] = useState(
    suggested ? `${suggested.accountId}:${suggested.txnId}` : ""
  );

  const merchant = plaidTxn.merchant_name || plaidTxn.name || "Unknown";
  // Plaid positive = expense; negative = income
  const displayAmt = -plaidTxn.amount;
  const isIncome = displayAmt > 0;

  const confirmSelected = () => {
    if (!pickerVal) return;
    const [accountId, txnIdStr] = pickerVal.split(":");
    const row = ALL_ROWS.find(r => r.accountId === accountId && r.txnId === parseInt(txnIdStr));
    if (row) onConfirm(plaidTxn, row);
  };

  return (
    <div style={styles.verifyItem}>
      <div style={styles.verifyLeft}>
        <span style={styles.verifyDate}>{plaidTxn.date}</span>
        <span style={styles.verifyMerchant}>{merchant}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: isIncome ? "var(--green)" : "var(--red)" }}>
          {fmt(displayAmt, true)}
        </span>
      </div>

      <span style={styles.verifyArrow}>→</span>

      <div style={styles.verifyRight}>
        {showPicker ? (
          <select
            value={pickerVal}
            onChange={(e) => setPickerVal(e.target.value)}
            style={{ ...styles.fieldSelect, flex: 1, fontSize: 11, padding: "4px 8px" }}
          >
            <option value="">— skip —</option>
            {DEFAULT_ACCOUNTS.map(acct => (
              <optgroup key={acct.id} label={acct.name}>
                {acct.transactions.map(t => (
                  <option key={`${acct.id}:${t.id}`} value={`${acct.id}:${t.id}`}>
                    Day {t.day} · {t.name} ({fmt(presetsMap[t.name] ?? t.amount)})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: suggested ? "var(--text)" : "var(--muted)", flex: 1 }}>
            {suggested
              ? <><span style={{ color: "var(--muted)", fontSize: 10 }}>{suggested.accountName} · </span>{suggested.txnName}</>
              : "No suggestion — pick manually"}
          </span>
        )}
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {showPicker ? (
            <>
              <button onClick={confirmSelected} style={styles.confirmBtn} title="Confirm selection">✓</button>
              <button onClick={() => setShowPicker(false)} style={styles.changeBtn}>Cancel</button>
            </>
          ) : (
            <>
              {suggested && <button onClick={() => onConfirm(plaidTxn, suggested)} style={styles.confirmBtn} title="Confirm suggested match">✓ Confirm</button>}
              <button onClick={() => setShowPicker(true)} style={styles.changeBtn} title="Pick a different row">↕</button>
            </>
          )}
          <button onClick={() => onSkip(plaidTxn.transaction_id)} style={styles.skipBtn} title="Skip">✗</button>
        </div>
      </div>
    </div>
  );
}

function VerifyQueue({ queue, presetsMap, onConfirm, onSkip }) {
  if (queue.length === 0) return null;

  return (
    <div style={styles.verifySection}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <p style={styles.verifyTitle}>Verify Transactions <span style={styles.verifyBadge}>{queue.length}</span></p>
        <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          Match bank activity to expected cashflow rows
        </span>
      </div>
      {queue.map(item => (
        <VerifyItem
          key={item.plaidTxn.transaction_id}
          plaidTxn={item.plaidTxn}
          suggested={item.suggested}
          presetsMap={presetsMap}
          onConfirm={onConfirm}
          onSkip={onSkip}
        />
      ))}
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
  const [val, setVal] = useState(String(Math.abs(currentAmount)));
  const sign = currentAmount <= 0 ? -1 : 1;

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Edit: {presetName}</p>
        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          All rows with this name will update.
        </p>
        <label style={styles.fieldLabel}>Amount {sign < 0 ? "(enter positive, treated as outflow)" : ""}</label>
        <input
          type="number" min="0" step="0.01"
          value={val}
          onChange={e => setVal(e.target.value)}
          style={styles.fieldInput}
          autoFocus
        />
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={() => { const raw = parseFloat(val); if (!isNaN(raw)) onSave(sign * raw); }}
            style={styles.saveBtn}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Main CashFlow View ────────────────────────────────────────────────────────
export default function CashFlow() {
  const now = new Date();
  const [monthIdx, setMonthIdx] = useState(now.getMonth());
  const [year] = useState(now.getFullYear());
  const monthKey = toMonthKey(year, monthIdx);

  const [presets, setPresets] = useState(DEFAULT_FIXED);
  const [startingBals, setStartingBals] = useState(() =>
    Object.fromEntries(DEFAULT_ACCOUNTS.map(a => [a.id, a.defaultStart]))
  );
  const [monthStates, setMonthStates] = useState({});
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [mappings, setMappings] = useState([]);
  const [recentTxns, setRecentTxns] = useState([]);
  const [dismissed, setDismissed] = useState(new Set());
  const [modal, setModal] = useState(null);

  const presetsMap = useMemo(() => {
    const m = {};
    presets.forEach(p => { m[p.name] = p.amount; });
    return m;
  }, [presets]);

  // Load presets from DB once
  useEffect(() => {
    fetchCashflowPresets().then((dbPresets) => {
      if (!Array.isArray(dbPresets) || dbPresets.length === 0) return;
      const merged = DEFAULT_FIXED.map(d => {
        const db = dbPresets.find(p => p.name === d.name);
        return db ? { ...d, amount: db.amount, freq: db.freq ?? d.freq, note: db.note ?? d.note } : d;
      });
      dbPresets.forEach(p => {
        if (!merged.find(m => m.name === p.name) && !p.name.startsWith("__start_")) {
          merged.push(p);
        }
      });
      setPresets(merged);

      // Starting balances stored as __start_accountId presets
      const newBals = {};
      DEFAULT_ACCOUNTS.forEach(a => {
        const db = dbPresets.find(p => p.name === `__start_${a.id}`);
        if (db) newBals[a.id] = db.amount;
      });
      if (Object.keys(newBals).length > 0) {
        setStartingBals(prev => ({ ...prev, ...newBals }));
      }
    }).catch(() => {});
  }, []);

  // Load mapping rules once
  useEffect(() => {
    fetchCashflowMappings().then(rows => {
      if (Array.isArray(rows)) setMappings(rows);
    }).catch(() => {});
  }, []);

  // Load per-month states + recent transactions when month changes
  useEffect(() => {
    fetchCashflowStates(monthKey).then((rows) => {
      if (!Array.isArray(rows)) return;
      const map = {};
      rows.forEach(r => {
        map[`${r.account_id}_${r.txn_id}`] = { isPending: r.is_pending, plaidTxnId: r.plaid_txn_id };
      });
      setMonthStates(map);
    }).catch(() => {});

    fetchTransactionsForMonth(monthKey).then(data => {
      const txns = data?.transactions ?? [];
      setRecentTxns(txns);
      setDismissed(new Set());
    }).catch(() => {});
  }, [monthKey]);

  // Compute verify queue
  const verifyQueue = useMemo(() => {
    const confirmedIds = new Set(
      Object.values(monthStates)
        .map(s => s.plaidTxnId)
        .filter(Boolean)
    );
    const mappingMap = {};
    mappings.forEach(m => { mappingMap[m.merchant_pattern] = m; });

    const queue = [];
    for (const txn of recentTxns) {
      if (confirmedIds.has(txn.transaction_id)) continue;
      if (dismissed.has(txn.transaction_id)) continue;

      // Skip tiny amounts (< $5) — likely fees already in cashflow
      if (Math.abs(txn.amount) < 5) continue;

      // Check saved mapping rules
      const merchant = (txn.merchant_name || txn.name || "").toLowerCase();
      const matchedRule = Object.keys(mappingMap).find(pat => merchant.includes(pat));
      if (matchedRule) {
        const rule = mappingMap[matchedRule];
        const row = ALL_ROWS.find(r => r.accountId === rule.account_id && r.txnName === rule.txn_name);
        if (row) {
          // Auto-confirm via saved rule — don't add to queue
          handleConfirm(txn, row, false);
          continue;
        }
      }

      const suggested = suggestMatch(txn, presetsMap);
      queue.push({ plaidTxn: txn, suggested });
    }
    return queue;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentTxns, monthStates, mappings, dismissed, presetsMap]);

  const handleConfirm = useCallback((plaidTxn, row, saveMappingRule = true) => {
    const { accountId, txnId, txnName } = row;
    const key = `${accountId}_${txnId}`;
    setMonthStates(prev => ({ ...prev, [key]: { isPending: true, plaidTxnId: plaidTxn.transaction_id } }));
    saveCashflowState(accountId, txnId, monthKey, true, Math.abs(plaidTxn.amount), plaidTxn.transaction_id).catch(() => {});

    if (saveMappingRule) {
      const pattern = (plaidTxn.merchant_name || plaidTxn.name || "").toLowerCase().trim();
      if (pattern.length > 3) {
        saveCashflowMapping(pattern, accountId, txnName).catch(() => {});
        setMappings(prev => {
          const filtered = prev.filter(m => m.merchant_pattern !== pattern);
          return [...filtered, { merchant_pattern: pattern, account_id: accountId, txn_name: txnName }];
        });
      }
    }
  }, [monthKey]);

  const handleSkip = useCallback((txnId) => {
    setDismissed(prev => new Set([...prev, txnId]));
  }, []);

  const togglePending = useCallback((accountId, txnId) => {
    const key = `${accountId}_${txnId}`;
    const current = monthStates[key]?.isPending ?? false;
    const next = !current;
    setMonthStates(prev => ({ ...prev, [key]: { ...prev[key], isPending: next } }));
    const existing = monthStates[key];
    saveCashflowState(accountId, txnId, monthKey, next, null, existing?.plaidTxnId ?? null).catch(() => {});
  }, [monthStates, monthKey]);

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
    setModal(null);
  }, [presets]);

  const editStartingBalance = useCallback((accountId) => {
    const current = startingBals[accountId];
    setModal({ type: "editStart", accountId, amount: current });
  }, [startingBals]);

  const saveStartingBalance = useCallback((accountId, amount) => {
    setStartingBals(prev => ({ ...prev, [accountId]: amount }));
    saveCashflowPreset(`__start_${accountId}`, amount, null, null).catch(() => {});
    setModal(null);
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

  const summary = useMemo(() => {
    const allTxns = accounts.flatMap(a => a.transactions);
    const eff = t => presetsMap[t.name] ?? t.amount;
    const takeHome = allTxns.filter(t => t.name.toLowerCase().includes("paycheck")).reduce((s, t) => s + eff(t), 0);
    const expenses = allTxns.filter(t => eff(t) < 0).reduce((s, t) => s + eff(t), 0);
    return { takeHome, expenses, freeCashflow: takeHome + expenses };
  }, [accounts, presetsMap]);

  return (
    <div style={styles.wrap}>
      <div className="fade-up" style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>Cash Flow</h1>
          <p style={styles.sub}>Projected balances by account with pending tracking</p>
        </div>
        <div style={styles.monthNav}>
          <button onClick={() => setMonthIdx(m => (m - 1 + 12) % 12)} style={styles.navBtn}>‹</button>
          <MonthBadge label={`${MONTHS[monthIdx]} ${year}`} />
          <button onClick={() => setMonthIdx(m => (m + 1) % 12)} style={styles.navBtn}>›</button>
        </div>
      </div>

      <div className="fade-up">
        <SummaryBar {...summary} />
      </div>

      <div className="fade-up-2" style={styles.accountsGrid}>
        {accounts.map(acct => (
          <AccountTable
            key={acct.id}
            account={acct}
            startingBalance={startingBals[acct.id] ?? acct.defaultStart}
            presetsMap={presetsMap}
            monthStates={monthStates}
            onTogglePending={togglePending}
            onEditAmount={editAmount}
            onEditStart={() => editStartingBalance(acct.id)}
            onAddRow={addRow}
            onDeleteRow={deleteRow}
          />
        ))}
      </div>

      {verifyQueue.length > 0 && (
        <div className="fade-up-3">
          <VerifyQueue
            queue={verifyQueue}
            presetsMap={presetsMap}
            onConfirm={handleConfirm}
            onSkip={handleSkip}
          />
        </div>
      )}

      <div className="fade-up-3">
        <FixedAmountsPanel
          presets={presets}
          onEditPreset={savePreset}
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
  deleteBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", width: 28, padding: 0, textAlign: "center", lineHeight: 1, opacity: 0.5 },
  addRowBtn: { display: "block", width: "calc(100% - 40px)", margin: "8px 20px 4px", padding: "7px 0", background: "none", border: "1px dashed var(--border2)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer" },

  // Verify queue
  verifySection: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 24px", marginBottom: 24 },
  verifyTitle: { fontSize: 13, fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 },
  verifyBadge: { background: "var(--accent)", color: "#fff", borderRadius: 10, fontSize: 11, fontWeight: 700, padding: "1px 7px", fontFamily: "var(--font-mono)" },
  verifyItem: { display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" },
  verifyLeft: { display: "flex", flexDirection: "column", gap: 2, minWidth: 200, flexShrink: 0 },
  verifyDate: { fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  verifyMerchant: { fontSize: 13, color: "var(--text)", fontWeight: 500 },
  verifyArrow: { fontSize: 16, color: "var(--muted)", flexShrink: 0 },
  verifyRight: { display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 },
  confirmBtn: { background: "var(--green)", border: "none", borderRadius: "var(--radius)", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" },
  changeBtn: { background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)", padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap" },
  skipBtn: { background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)", padding: "5px 8px", cursor: "pointer" },

  // Fixed panel
  fixedPanel: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 24px" },
  fixedTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  fixedGrid: { display: "flex", flexDirection: "column", gap: 6 },
  fixedRow: { display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: 6 },
  fixedFooter: { display: "flex", gap: 16, alignItems: "center", marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border2)" },
  presetInput: { width: 80, padding: "2px 6px", background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 4, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none", textAlign: "right" },

  // Modals
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
};
