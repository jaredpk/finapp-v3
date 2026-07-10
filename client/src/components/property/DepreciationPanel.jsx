import React, { useState } from "react";
import { fmt } from "./propertyFinanceUtils.js";

// Annual depreciation taken per tax year (property-level, not year-scoped).
// "Accumulated through <selected year>" is the running total the Schedule E /
// sale-basis math needs.
export default function DepreciationPanel({ depreciation, selectedYear, onSave, onDelete }) {
  const [editingYear, setEditingYear] = useState(null);
  const [editAmount, setEditAmount] = useState("");
  const [newYear, setNewYear] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const accumulated = depreciation.filter((d) => d.year <= selectedYear).reduce((s, d) => s + d.amount, 0);
  const lastAmount = depreciation.length ? depreciation[depreciation.length - 1].amount : null;
  const suggestedYear = depreciation.length ? depreciation[depreciation.length - 1].year + 1 : selectedYear;

  async function saveEdit(year) {
    const a = Number(editAmount);
    if (!Number.isFinite(a) || a < 0) return;
    setBusy(true);
    try {
      await onSave(year, a);
      setEditingYear(null);
    } finally {
      setBusy(false);
    }
  }

  async function addYear() {
    const y = Number(newYear || suggestedYear);
    const a = Number(newAmount);
    if (!Number.isInteger(y) || !Number.isFinite(a) || a < 0) return;
    setBusy(true);
    try {
      await onSave(y, a);
      setNewYear("");
      setNewAmount("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section}>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Depreciation</h2>
        <span style={styles.accumulated}>Accumulated through {selectedYear}: {fmt(accumulated)}</span>
      </div>
      <div style={styles.table}>
        {depreciation.map((d) => (
          <div key={d.year} style={{ ...styles.row, ...(d.year === selectedYear ? styles.rowActive : {}) }}>
            <span style={styles.year}>{d.year}</span>
            {editingYear === d.year ? (
              <>
                <input
                  style={styles.input}
                  type="number"
                  value={editAmount}
                  autoFocus
                  onChange={(e) => setEditAmount(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit(d.year)}
                />
                <button style={styles.smallBtn} onClick={() => saveEdit(d.year)} disabled={busy}>Save</button>
                <button style={styles.smallBtn} onClick={() => setEditingYear(null)}>Cancel</button>
              </>
            ) : (
              <>
                <span style={styles.amount}>{fmt(d.amount)}</span>
                <button style={styles.smallBtn} onClick={() => { setEditingYear(d.year); setEditAmount(String(d.amount)); }}>Edit</button>
                <button style={styles.deleteBtn} title="Remove" onClick={() => onDelete(d.year)}>×</button>
              </>
            )}
          </div>
        ))}
        {depreciation.length === 0 && <p style={styles.empty}>No depreciation recorded yet.</p>}
      </div>
      <div style={styles.addForm}>
        <input style={{ ...styles.input, width: 70 }} type="number" placeholder={String(suggestedYear)} value={newYear} onChange={(e) => setNewYear(e.target.value)} />
        <input style={{ ...styles.input, width: 110 }} type="number" placeholder={lastAmount != null ? String(lastAmount) : "amount"} value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
        <button style={styles.addBtn} onClick={addYear} disabled={busy || newAmount === ""}>Add year</button>
      </div>
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: 700, margin: 0 },
  accumulated: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 600 },
  table: { maxWidth: 420 },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderBottom: "1px solid var(--border)", borderRadius: 4 },
  rowActive: { background: "var(--surface2)" },
  year: { width: 50, fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)" },
  amount: { flex: 1, fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right" },
  input: { background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, padding: "6px 8px", fontFamily: "var(--font-mono)", flex: 1 },
  smallBtn: { background: "none", border: "1px solid var(--border)", color: "var(--muted)", borderRadius: "var(--radius)", padding: "3px 8px", fontSize: 11, cursor: "pointer" },
  deleteBtn: { background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15, padding: "0 2px", lineHeight: 1 },
  empty: { fontSize: 12, color: "var(--muted)" },
  addForm: { display: "flex", gap: 6, marginTop: 10 },
  addBtn: { padding: "6px 12px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: 12, fontWeight: 600, cursor: "pointer" },
};
