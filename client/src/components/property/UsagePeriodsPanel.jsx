import React, { useState } from "react";

// Rental / personal occupancy periods for the selected tax year, mirroring the
// old sheet's side blocks: label, stay dates, and night counts. % Rental is
// rental nights over total occupied nights — the tax allocation figure.

const fmtDay = (d) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;

function nightsBetween(start, end) {
  if (!start || !end) return "";
  const n = Math.round((new Date(end) - new Date(start)) / 86400000);
  return Number.isFinite(n) && n > 0 ? n : "";
}

function UsageSection({ title, usageType, periods, onAdd, onDelete }) {
  const [label, setLabel] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);

  const effDays = days !== "" ? Number(days) : nightsBetween(start, end);
  const total = periods.reduce((s, p) => s + (p.days || 0), 0);

  async function submit() {
    if (!Number.isFinite(effDays) || effDays <= 0) return;
    setBusy(true);
    try {
      await onAdd({ usageType, sourceNote: label.trim() || null, startDate: start || null, endDate: end || null, days: effDays });
      setLabel(""); setStart(""); setEnd(""); setDays("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.col}>
      <p style={styles.colTitle}>{title}</p>
      {periods.length === 0 && <p style={styles.empty}>No periods logged.</p>}
      {periods.map((p) => (
        <div key={p.id} style={styles.periodRow}>
          <span style={styles.periodLabel}>{p.source_note || "—"}</span>
          <span style={styles.periodDates}>
            {p.start_date ? `${fmtDay(p.start_date)} – ${fmtDay(p.end_date) || "?"}` : ""}
          </span>
          <span style={styles.periodDays}>{p.days}d</span>
          <button style={styles.deleteBtn} title="Remove" onClick={() => onDelete(p.id)}>×</button>
        </div>
      ))}
      <div style={styles.totalRow}>
        <span style={styles.periodLabel}>Total</span>
        <span style={{ ...styles.periodDays, fontWeight: 700 }}>{total}d</span>
      </div>
      <div style={styles.addForm}>
        <input style={{ ...styles.input, flex: 1 }} placeholder="Label (e.g. June-July)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input style={styles.input} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <input style={styles.input} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <input style={{ ...styles.input, width: 52 }} type="number" placeholder={effDays !== "" ? String(effDays) : "days"} value={days} onChange={(e) => setDays(e.target.value)} />
        <button style={styles.addBtn} onClick={submit} disabled={busy || !Number.isFinite(effDays) || effDays <= 0}>Add</button>
      </div>
    </div>
  );
}

export default function UsagePeriodsPanel({ year, usagePeriods, onAdd, onDelete }) {
  const rental = usagePeriods.filter((p) => p.usage_type === "rental");
  const personal = usagePeriods.filter((p) => p.usage_type === "personal");
  const rentalDays = rental.reduce((s, p) => s + (p.days || 0), 0);
  const personalDays = personal.reduce((s, p) => s + (p.days || 0), 0);
  const pctRental = rentalDays + personalDays > 0 ? Math.round((rentalDays / (rentalDays + personalDays)) * 100) : null;

  return (
    <section style={styles.section}>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Usage — {year}</h2>
        {pctRental != null && (
          <span style={styles.pct}>{pctRental}% rental · {rentalDays} rental / {personalDays} personal nights</span>
        )}
      </div>
      <div style={styles.cols}>
        <UsageSection title="Rental Usage" usageType="rental" periods={rental} onAdd={onAdd} onDelete={onDelete} />
        <UsageSection title="Personal Usage" usageType="personal" periods={personal} onAdd={onAdd} onDelete={onDelete} />
      </div>
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  heading: { fontSize: 15, fontWeight: 700, margin: 0 },
  pct: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 600 },
  cols: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20 },
  col: {},
  colTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 8 },
  empty: { fontSize: 12, color: "var(--muted)", marginBottom: 8 },
  periodRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" },
  periodLabel: { flex: 1, fontSize: 13, color: "var(--text)" },
  periodDates: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  periodDays: { width: 42, textAlign: "right", fontSize: 13, fontFamily: "var(--font-mono)" },
  deleteBtn: { background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 15, padding: "0 2px", lineHeight: 1 },
  totalRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 22px 6px 0", fontWeight: 700 },
  addForm: { display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" },
  input: { background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, padding: "6px 8px", fontFamily: "var(--font-mono)" },
  addBtn: { padding: "6px 12px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: 12, fontWeight: 600, cursor: "pointer" },
};
