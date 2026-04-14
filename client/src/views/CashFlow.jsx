import React, { useState, useMemo } from "react";

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

// ── Default data seeded from the spreadsheet ──────────────────────────────────
const DEFAULT_ACCOUNTS = [
  {
    id: "amex",
    name: "Amex Checking",
    startingBalance: 1712,
    transactions: [
      { id: 1, day: 1,  name: "Personal Jared",                  freq: "Monthly",    amount: -2637,  pending: false },
      { id: 2, day: 5,  name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009,   pending: false },
      { id: 3, day: 7,  name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,  pending: false },
      { id: 4, day: 10, name: "UESP",                            freq: "Monthly",    amount: -100,   pending: false },
      { id: 5, day: 19, name: "Transfer Reserve Account",        freq: "Monthly",    amount: -500,   pending: false },
      { id: 6, day: 20, name: "Paycheck",                        freq: "Bi-Monthly", amount: 4009,   pending: false },
      { id: 7, day: 24, name: "Jared Transfer to Personal Macu", freq: "Monthly",    amount: -629.84,pending: false },
      { id: 8, day: 27, name: "Transfer to Long-Term Purchases", freq: "Monthly",    amount: -250,   pending: false },
      { id: 9, day: 27, name: "Transfer to Emergency Fund",      freq: "Monthly",    amount: -250,   pending: false },
      { id: 10,day: 27, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,  pending: false },
      { id: 11,day: 28, name: "Transfer to Joint Savings",       freq: "Monthly",    amount: -385,   pending: false },
      { id: 12,day: 30, name: "Transfer for PTO Reserve",        freq: "Monthly",    amount: -320,   pending: false },
      { id: 13,day: 30, name: "Personal IRA Transfer",           freq: "Monthly",    amount: -500,   pending: false },
      { id: 14,day: 30, name: "Jared Transfer to Shared",        freq: "Monthly",    amount: -1900,  pending: false },
      { id: 15,day: 30, name: "Paycheck (Month End)",            freq: "Monthly",    amount: 4009,   pending: false },
    ],
  },
  {
    id: "macu",
    name: "MACU Checking",
    startingBalance: 1201,
    transactions: [
      { id: 1, day: 5,  name: "Child Support Out",               freq: "Bi-Monthly", amount: -314.93, pending: false },
      { id: 2, day: 19, name: "Child Support Out",               freq: "Bi-Monthly", amount: -314.93, pending: false },
      { id: 3, day: 23, name: "Jared Transfer to Personal Macu", freq: "Monthly",    amount: 629.84,  pending: false },
    ],
  },
  {
    id: "shared",
    name: "Shared Checking",
    startingBalance: 3610,
    transactions: [
      { id: 1, day: 1,  name: "Other Misc. Shared",              freq: "Bi-Monthly", amount: -500,   pending: false },
      { id: 2, day: 1,  name: "House Payment",                   freq: "Bi-Monthly", amount: -2017,  pending: false },
      { id: 3, day: 2,  name: "Personal Jared",                  freq: "Monthly",    amount: 2637,   pending: false },
      { id: 4, day: 7,  name: "Jared Transfer In",               freq: "Monthly",    amount: 1900,   pending: false },
      { id: 5, day: 12, name: "Alta Transfer",                   freq: "Bi-Weekly",  amount: 1500,   pending: false },
      { id: 6, day: 15, name: "Car Payment",                     freq: "Monthly",    amount: -289,   pending: false },
      { id: 7, day: 24, name: "Alta Transfer",                   freq: "Bi-Weekly",  amount: 1500,   pending: false },
      { id: 8, day: 24, name: "Transfer for Credit Card",        freq: "Monthly",    amount: -6000,  pending: false },
      { id: 9, day: 28, name: "Jared Transfer In",               freq: "Monthly",    amount: 1900,   pending: false },
      { id: 10,day: 28, name: "Misc. Utilities",                 freq: "Monthly",    amount: -500,   pending: false },
      { id: 11,day: 30, name: "Jared Transfer In",               freq: "Monthly",    amount: 1900,   pending: false },
    ],
  },
];

const DEFAULT_FIXED = [
  { name: "Paycheck",                              amount: 4009,    freq: "Bi-Monthly", note: "Estimated w/ 15% into 401k" },
  { name: "Ashton & Brooklyn",                     amount: -314.93, freq: "Bi-Monthly", note: "" },
  { name: "UESP",                                  amount: -100,    freq: "Monthly",    note: "" },
  { name: "Transfer for PTO Reserve",              amount: -320,    freq: "Monthly",    note: "" },
  { name: "Alta Transfer to Shared",               amount: 1500,    freq: "Bi-Monthly", note: "" },
  { name: "Jared Transfer to Shared",              amount: -1900,   freq: "Bi-Monthly", note: "" },
  { name: "Jared Transfer → Personal Macu",        amount: -629.84, freq: "Monthly",    note: "Ashton/Brooklyn" },
  { name: "House Payment",                         amount: -2017,   freq: "Monthly",    note: "" },
  { name: "Transfer to Joint Savings",             amount: -385,    freq: "Monthly",    note: "" },
  { name: "Misc Utilities",                        amount: -500,    freq: "Monthly",    note: "" },
  { name: "Transfer → Long-Term Purchases",        amount: -250,    freq: "Monthly",    note: "" },
  { name: "Transfer → Emergency Fund",             amount: -250,    freq: "Monthly",    note: "" },
  { name: "Transfer → Reserve Account",            amount: -500,    freq: "Monthly",    note: "" },
  { name: "e-Trade: IRA Contributions",            amount: -500,    freq: "Monthly",    note: "" },
  { name: "Car Payment",                           amount: -289,    freq: "Monthly",    note: "" },
];

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

function AccountTable({ account, onTogglePending, onEditAmount, onAddRow, onDeleteRow }) {
  const sorted = [...account.transactions].sort((a, b) => a.day - b.day);

  // Compute running + pending balances
  let running = account.startingBalance;
  let pendingBal = account.startingBalance;
  const rows = sorted.map((t) => {
    if (t.pending) pendingBal += t.amount;
    running += t.amount;
    return { ...t, runningBalance: running, pendingBalance: t.pending ? pendingBal : 0 };
  });

  const endBal = rows.length ? rows[rows.length - 1].runningBalance : account.startingBalance;
  const minBal = rows.reduce((m, r) => Math.min(m, r.runningBalance), account.startingBalance);
  const pendingRows = rows.filter((r) => r.pending);
  const pendingTotal = pendingRows.reduce((s, r) => s + r.amount, 0);

  return (
    <div style={styles.accountBlock}>
      {/* Account header */}
      <div style={styles.accountHeader}>
        <div>
          <p style={styles.accountName}>{account.name}</p>
          <p style={styles.accountStartBal}>Starting: {fmt(account.startingBalance)}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={styles.accountEndLabel}>Est. Ending</p>
          <p style={{ ...styles.accountEndBal, color: endBal >= 0 ? "var(--green)" : "var(--red)" }}>{fmtShort(endBal)}</p>
          <p style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
            Min: {fmtShort(minBal)}
          </p>
        </div>
      </div>

      {/* Pending summary bar */}
      {pendingRows.length > 0 && (
        <div style={styles.pendingBar}>
          <span style={styles.pendingDot} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {pendingRows.length} pending · {fmt(pendingTotal, true)} ·{" "}
            <span style={{ color: "var(--accent)" }}>pending balance: {fmt(pendingBal)}</span>
          </span>
        </div>
      )}

      {/* Table */}
      <div style={styles.tableWrap}>
        <div style={styles.txnHeader}>
          <span style={{ width: 30 }}>Day</span>
          <span style={{ flex: 1 }}>Transaction</span>
          <span style={{ width: 80 }}>Freq</span>
          <span style={{ width: 80, textAlign: "right" }}>Amount</span>
          <span style={{ width: 90, textAlign: "right" }}>Running Bal</span>
          <span style={{ width: 50, textAlign: "center" }}>Pend</span>
          <span style={{ width: 90, textAlign: "right" }}>Pend Bal</span>
          <span style={{ width: 28 }} />
        </div>

        {rows.map((t) => (
          <div
            key={t.id}
            style={{
              ...styles.txnRow,
              background: t.pending ? "rgba(240,180,41,0.04)" : "transparent",
              borderLeft: t.pending ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <span style={{ ...styles.txnDay }}>{t.day}</span>
            <span style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>
              {t.name}
            </span>
            <span style={{ width: 80, fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{t.freq}</span>
            <span
              style={{ width: 80, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: t.amount >= 0 ? "var(--green)" : "var(--red)", cursor: "pointer" }}
              onClick={() => onEditAmount(account.id, t.id)}
              title="Click to edit"
            >
              {fmt(t.amount)}
            </span>
            <span style={{ width: 90, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: t.runningBalance >= 0 ? "var(--text)" : "var(--red)" }}>
              {fmtShort(t.runningBalance)}
            </span>
            <span style={{ width: 50, textAlign: "center" }}>
              <button
                onClick={() => onTogglePending(account.id, t.id)}
                style={{ ...styles.pendingBtn, background: t.pending ? "var(--accent)" : "var(--border2)", color: t.pending ? "#fff" : "var(--muted)" }}
              >
                {t.pending ? "Y" : "N"}
              </button>
            </span>
            <span style={{ width: 90, textAlign: "right", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
              {t.pending ? fmtShort(t.pendingBalance) : "—"}
            </span>
            <button onClick={() => onDeleteRow(account.id, t.id)} style={styles.deleteBtn} title="Remove">×</button>
          </div>
        ))}

        {/* Add row */}
        <button onClick={() => onAddRow(account.id)} style={styles.addRowBtn}>+ Add Transaction</button>
      </div>
    </div>
  );
}

function FixedAmountsPanel({ items }) {
  const income = items.filter((i) => i.amount > 0);
  const expenses = items.filter((i) => i.amount < 0);
  const totalIn = income.reduce((s, i) => s + i.amount, 0);
  const totalOut = expenses.reduce((s, i) => s + i.amount, 0);

  return (
    <div style={styles.fixedPanel}>
      <p style={styles.fixedTitle}>Fixed Monthly Reference</p>
      <div style={styles.fixedGrid}>
        {items.map((item, i) => (
          <div key={i} style={styles.fixedRow}>
            <span style={{ flex: 1, fontSize: 11, color: "var(--text)" }}>{item.name}</span>
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", marginRight: 12 }}>{item.freq}</span>
            <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: item.amount >= 0 ? "var(--green)" : "var(--red)", minWidth: 72, textAlign: "right" }}>
              {fmt(item.amount)}
            </span>
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

// ── Add Transaction Modal ─────────────────────────────────────────────────────
function AddModal({ accountName, onSave, onClose }) {
  const [form, setForm] = useState({ day: "", name: "", freq: "Monthly", amount: "", pending: false });
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

          <label style={styles.fieldLabel}>
            <input type="checkbox" checked={form.pending} onChange={e => set("pending", e.target.checked)} style={{ marginRight: 6 }} />
            Mark as Pending
          </label>
        </div>
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button
            onClick={() => {
              if (!form.day || !form.name || !form.amount) return;
              onSave({ day: parseInt(form.day), name: form.name, freq: form.freq, amount: parseFloat(form.amount), pending: form.pending });
            }}
            style={styles.saveBtn}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Amount Modal ─────────────────────────────────────────────────────────
function EditModal({ txn, onSave, onClose }) {
  const [val, setVal] = useState(txn.amount);
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <p style={styles.modalTitle}>Edit: {txn.name}</p>
        <label style={styles.fieldLabel}>Amount</label>
        <input type="number" value={val} onChange={e => setVal(parseFloat(e.target.value))} style={styles.fieldInput} autoFocus />
        <div style={styles.modalActions}>
          <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          <button onClick={() => onSave(val)} style={styles.saveBtn}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Main CashFlow View ────────────────────────────────────────────────────────
export default function CashFlow() {
  const now = new Date();
  const [monthIdx, setMonthIdx] = useState(now.getMonth());
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [modal, setModal] = useState(null); // { type: 'add'|'edit', accountId, txn? }

  // Monthly cashflow summary (matching spreadsheet: takeHome, expenses, free cashflow)
  const summary = useMemo(() => {
    const allTxns = accounts.flatMap(a => a.transactions);
    const takeHome = allTxns.filter(t => t.name.toLowerCase().includes("paycheck")).reduce((s, t) => s + t.amount, 0);
    const expenses = allTxns.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
    return { takeHome, expenses, freeCashflow: takeHome + expenses };
  }, [accounts]);

  // Handlers
  const togglePending = (accountId, txnId) => {
    setAccounts(prev => prev.map(a =>
      a.id !== accountId ? a : {
        ...a,
        transactions: a.transactions.map(t => t.id !== txnId ? t : { ...t, pending: !t.pending })
      }
    ));
  };

  const editAmount = (accountId, txnId) => {
    const acct = accounts.find(a => a.id === accountId);
    const txn = acct?.transactions.find(t => t.id === txnId);
    if (txn) setModal({ type: "edit", accountId, txn });
  };

  const saveEdit = (newAmount) => {
    setAccounts(prev => prev.map(a =>
      a.id !== modal.accountId ? a : {
        ...a,
        transactions: a.transactions.map(t => t.id !== modal.txn.id ? t : { ...t, amount: newAmount })
      }
    ));
    setModal(null);
  };

  const addRow = (accountId) => setModal({ type: "add", accountId });

  const saveAdd = (data) => {
    setAccounts(prev => prev.map(a =>
      a.id !== modal.accountId ? a : {
        ...a,
        transactions: [...a.transactions, { ...data, id: Date.now() }]
      }
    ));
    setModal(null);
  };

  const deleteRow = (accountId, txnId) => {
    setAccounts(prev => prev.map(a =>
      a.id !== accountId ? a : {
        ...a,
        transactions: a.transactions.filter(t => t.id !== txnId)
      }
    ));
  };

  return (
    <div style={styles.wrap}>
      {/* Header */}
      <div className="fade-up" style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>Cash Flow</h1>
          <p style={styles.sub}>Projected balances by account with pending tracking</p>
        </div>
        {/* Month nav */}
        <div style={styles.monthNav}>
          <button onClick={() => setMonthIdx(m => (m - 1 + 12) % 12)} style={styles.navBtn}>‹</button>
          <MonthBadge label={`${MONTHS[monthIdx]} ${now.getFullYear()}`} />
          <button onClick={() => setMonthIdx(m => (m + 1) % 12)} style={styles.navBtn}>›</button>
        </div>
      </div>

      {/* Monthly cashflow summary strip */}
      <div className="fade-up">
        <SummaryBar {...summary} />
      </div>

      {/* Account tables */}
      <div className="fade-up-2" style={styles.accountsGrid}>
        {accounts.map(acct => (
          <AccountTable
            key={acct.id}
            account={acct}
            onTogglePending={togglePending}
            onEditAmount={editAmount}
            onAddRow={addRow}
            onDeleteRow={deleteRow}
          />
        ))}
      </div>

      {/* Fixed amounts reference panel */}
      <div className="fade-up-3">
        <FixedAmountsPanel items={DEFAULT_FIXED} />
      </div>

      {/* Modals */}
      {modal?.type === "add" && (
        <AddModal
          accountName={accounts.find(a => a.id === modal.accountId)?.name}
          onSave={saveAdd}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "edit" && (
        <EditModal txn={modal.txn} onSave={saveEdit} onClose={() => setModal(null)} />
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
  deleteBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", width: 28, padding: 0, textAlign: "center", lineHeight: 1, opacity: 0.5, transition: "opacity 0.15s" },
  addRowBtn: { display: "block", width: "calc(100% - 40px)", margin: "8px 20px 4px", padding: "7px 0", background: "none", border: "1px dashed var(--border2)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer", transition: "border-color 0.15s, color 0.15s" },

  fixedPanel: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 24px" },
  fixedTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 14 },
  fixedGrid: { display: "flex", flexDirection: "column", gap: 6 },
  fixedRow: { display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: 6 },
  fixedFooter: { display: "flex", gap: 16, alignItems: "center", marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border2)" },

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
