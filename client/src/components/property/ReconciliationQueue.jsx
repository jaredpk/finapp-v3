import React from "react";
import { fmt } from "./propertyFinanceUtils.js";

export default function ReconciliationQueue({ isLiveYear, plaidPreview, onApply, reviewQueue, onResolveReview }) {
  if (!isLiveYear && reviewQueue.length === 0) return null;

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Reconciliation Queue</h2>

      {isLiveYear && (
        <>
          <p style={styles.subhead}>Unmatched / low-confidence bank activity</p>
          {plaidPreview.length === 0 ? (
            <p style={styles.empty}>Nothing pending from the live feed.</p>
          ) : (
            <div style={styles.list}>
              {plaidPreview.map(({ plaidTransaction: p, match }) => (
                <div key={p.transaction_id} style={styles.card}>
                  <div style={styles.cardTop}>
                    <span style={styles.merchant}>{p.merchant_name || p.name}</span>
                    <span style={styles.amount}>{fmt(p.amount)}</span>
                  </div>
                  <div style={styles.meta}>
                    {p.date} · suggested <strong>{match.normalizedCategory}</strong> ·{" "}
                    <span style={{ color: match.confidence >= 0.7 ? "var(--green, #22c55e)" : match.confidence >= 0.4 ? "var(--amber, #f59e0b)" : "var(--red, #ef4444)" }}>
                      {Math.round(match.confidence * 100)}% confidence
                    </span>
                    {p.pending && <span style={styles.pendingBadge}>pending</span>}
                  </div>
                  <p style={styles.explanation}>{match.explanation}</p>
                  <button style={styles.applyBtn} onClick={() => onApply(p.transaction_id)}>Apply to ledger</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {reviewQueue.length > 0 && (
        <>
          <p style={styles.subhead}>Unparseable import rows</p>
          <div style={styles.list}>
            {reviewQueue.map((r) => (
              <div key={r.id} style={styles.card}>
                <div style={styles.meta}>{r.year} · {r.reason}</div>
                <pre style={styles.rawRow}>{JSON.stringify(r.raw_row)}</pre>
                <button style={styles.applyBtn} onClick={() => onResolveReview(r.id)}>Mark resolved</button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 6 },
  subhead: { fontSize: 12, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 14, marginBottom: 10 },
  empty: { color: "var(--muted)", fontSize: 13 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  card: { border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 12px", background: "var(--surface2)" },
  cardTop: { display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 },
  amount: { fontFamily: "var(--font-mono)" },
  meta: { fontSize: 12, color: "var(--muted)", marginTop: 4 },
  explanation: { fontSize: 12, color: "var(--muted)", marginTop: 6 },
  pendingBadge: { marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--surface)", border: "1px solid var(--border)" },
  rawRow: { fontSize: 11, color: "var(--muted)", overflowX: "auto", margin: "6px 0", background: "var(--surface)", padding: 6, borderRadius: 6 },
  applyBtn: { fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", marginTop: 4 },
};
