import React, { useState } from "react";
import StatCard from "../StatCard.jsx";
import { fmt, fmtSigned, summarizeYear } from "./propertyFinanceUtils.js";

export default function PropertyHeader({ property, years, selectedYear, onSelectYear, onStartYear, transactions }) {
  const summary = summarizeYear(transactions);
  const isLiveYear = years.find((y) => y.year === selectedYear)?.is_live;
  const [confirmingNewYear, setConfirmingNewYear] = useState(false);
  const nextYear = years.length ? Math.max(...years.map((y) => y.year)) + 1 : new Date().getFullYear();

  return (
    <div style={styles.wrap}>
      <div style={styles.titleRow}>
        <div>
          <h1 style={styles.heading}>{property.name}</h1>
          <p style={styles.sub}>{property.address}</p>
        </div>
        <div style={styles.yearSelector}>
          {years.map((y) => (
            <button
              key={y.year}
              onClick={() => onSelectYear(y.year)}
              style={{ ...styles.yearBtn, ...(y.year === selectedYear ? styles.yearBtnActive : {}) }}
            >
              {y.year}
              {y.is_live && <span style={styles.liveDot} title="Live year" />}
            </button>
          ))}
          {onStartYear && (
            <button
              style={{ ...styles.yearBtn, ...(confirmingNewYear ? styles.yearBtnConfirm : {}) }}
              onClick={() => {
                if (confirmingNewYear) { onStartYear(nextYear); setConfirmingNewYear(false); }
                else setConfirmingNewYear(true);
              }}
              onBlur={() => setConfirmingNewYear(false)}
              title={`Start tracking ${nextYear} as the new live year`}
            >
              {confirmingNewYear ? `Start ${nextYear}?` : `+ ${nextYear}`}
            </button>
          )}
        </div>
      </div>

      {isLiveYear && (
        <p style={styles.liveNote}>Live reporting year — transactions arrive from the connected bank feed and need review before they're reconciled.</p>
      )}

      <div style={styles.statsRow}>
        <StatCard label="Income" value={fmt(summary.income)} accent="var(--green, #22c55e)" />
        <StatCard label="Expenses" value={fmt(summary.expense)} accent="var(--red, #ef4444)" />
        <StatCard label="Net" value={fmtSigned(summary.net)} accent={summary.net >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)"} mono />
        <StatCard label="Unreconciled" value={summary.unreconciled} sub={`of ${summary.count} transactions`} />
        <StatCard label="Needs Review" value={summary.needsReview} accent={summary.needsReview > 0 ? "var(--amber, #f59e0b)" : undefined} />
      </div>
    </div>
  );
}

const styles = {
  wrap: { marginBottom: 24 },
  titleRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 16 },
  heading: { fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", margin: 0 },
  sub: { color: "var(--muted)", fontSize: 13, marginTop: 4 },
  yearSelector: { display: "flex", gap: 6, flexWrap: "wrap" },
  yearBtn: {
    padding: "8px 14px", borderRadius: "var(--radius)", border: "1px solid var(--border)",
    background: "var(--surface)", color: "var(--muted)", fontSize: 13, fontWeight: 600,
    cursor: "pointer", position: "relative", fontFamily: "var(--font-mono)",
  },
  yearBtnActive: { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" },
  yearBtnConfirm: { borderColor: "var(--accent)", color: "var(--accent)" },
  liveDot: { display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#22c55e", marginLeft: 6 },
  liveNote: { fontSize: 12, color: "var(--muted)", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 12px", marginBottom: 16 },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 },
};
