import React from "react";
import { fmtSigned, summarizeYear } from "./propertyFinanceUtils.js";

export default function YearComparisonCards({ years, transactionsByYear, selectedYear, onSelectYear }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Year Comparison</h2>
      <div style={styles.grid}>
        {years.map((y) => {
          const summary = summarizeYear(transactionsByYear[y.year] || []);
          const active = y.year === selectedYear;
          return (
            <button key={y.year} onClick={() => onSelectYear(y.year)} style={{ ...styles.card, ...(active ? styles.cardActive : {}) }}>
              <span style={styles.year}>{y.year}{y.is_live && <span style={styles.liveTag}>LIVE</span>}</span>
              <span style={{ ...styles.net, color: summary.net >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)" }}>{fmtSigned(summary.net)}</span>
              <span style={styles.detail}>{summary.count} txns · {summary.unreconciled} unreconciled</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 },
  card: { display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--surface2)", cursor: "pointer", textAlign: "left" },
  cardActive: { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent) inset" },
  year: { fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)" },
  liveTag: { marginLeft: 6, fontSize: 9, background: "#22c55e", color: "#fff", padding: "1px 5px", borderRadius: 4 },
  net: { fontSize: 17, fontWeight: 700, fontFamily: "var(--font-mono)" },
  detail: { fontSize: 11, color: "var(--muted)" },
};
