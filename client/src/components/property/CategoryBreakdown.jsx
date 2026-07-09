import React from "react";
import { fmt, groupByCategory } from "./propertyFinanceUtils.js";

export default function CategoryBreakdown({ transactions }) {
  const categories = groupByCategory(transactions);
  const maxTotal = Math.max(1, ...categories.map((c) => c.income + c.expense));

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Category Breakdown</h2>
      {categories.length === 0 ? (
        <p style={styles.empty}>Nothing categorized yet.</p>
      ) : (
        <div style={styles.list}>
          {categories.map((c) => {
            const total = c.income + c.expense;
            const isUncategorized = c.category === "Uncategorized";
            return (
              <div key={c.category} style={styles.row}>
                <div style={styles.rowHead}>
                  <span style={{ fontWeight: 600, color: isUncategorized ? "var(--amber, #f59e0b)" : "var(--text)" }}>{c.category}</span>
                  <span style={styles.count}>{c.count} txn{c.count === 1 ? "" : "s"}</span>
                  <span style={styles.total}>{fmt(total)}</span>
                </div>
                <div style={styles.barTrack}>
                  <div style={{ ...styles.barFill, width: `${(total / maxTotal) * 100}%`, background: isUncategorized ? "var(--amber, #f59e0b)" : "var(--accent)" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 14 },
  empty: { color: "var(--muted)", fontSize: 13 },
  list: { display: "flex", flexDirection: "column", gap: 12 },
  row: { display: "flex", flexDirection: "column", gap: 4 },
  rowHead: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 },
  count: { color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)" },
  total: { marginLeft: "auto", fontFamily: "var(--font-mono)", fontWeight: 700 },
  barTrack: { height: 6, borderRadius: 4, background: "var(--surface2)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
};
