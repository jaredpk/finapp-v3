import React from "react";
import { fmt, fmtSigned, groupByMonth, monthLabel } from "./propertyFinanceUtils.js";

export default function MonthlyPnL({ transactions }) {
  const months = groupByMonth(transactions);

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Monthly P&amp;L</h2>
      {months.length === 0 ? (
        <p style={styles.empty}>No transactions for this year yet.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Month</th>
              <th style={styles.thRight}>Income</th>
              <th style={styles.thRight}>Expenses</th>
              <th style={styles.thRight}>Net</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const net = m.income - m.expense;
              return (
                <tr key={m.month} style={styles.row}>
                  <td style={styles.td}>{monthLabel(m.month)}</td>
                  <td style={styles.tdRight}>{fmt(m.income)}</td>
                  <td style={styles.tdRight}>{fmt(m.expense)}</td>
                  <td style={{ ...styles.tdRight, color: net >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)", fontWeight: 700 }}>
                    {fmtSigned(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 14 },
  empty: { color: "var(--muted)", fontSize: 13 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 8px", borderBottom: "1px solid var(--border)" },
  thRight: { textAlign: "right", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 8px", borderBottom: "1px solid var(--border)" },
  row: { borderBottom: "1px solid var(--border)" },
  td: { padding: "8px 8px" },
  tdRight: { padding: "8px 8px", textAlign: "right", fontFamily: "var(--font-mono)" },
};
