import React from "react";

export default function AuditDetail({ entries }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Notes &amp; Audit Trail</h2>
      {entries.length === 0 ? (
        <p style={styles.empty}>No edits recorded yet.</p>
      ) : (
        <div style={styles.list}>
          {entries.slice(0, 25).map((e) => (
            <div key={e.id} style={styles.row}>
              <span style={styles.action}>{e.action}</span>
              <span style={styles.time}>{new Date(e.created_at).toLocaleString()}</span>
              {e.transaction_id && <span style={styles.txn}>#{e.transaction_id}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 14 },
  empty: { color: "var(--muted)", fontSize: 13 },
  list: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" },
  row: { display: "flex", gap: 10, fontSize: 12, alignItems: "baseline", borderBottom: "1px solid var(--border)", paddingBottom: 6 },
  action: { fontWeight: 600, textTransform: "capitalize" },
  time: { color: "var(--muted)", fontFamily: "var(--font-mono)" },
  txn: { color: "var(--muted)" },
};
