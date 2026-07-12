import React, { useMemo, useState } from "react";
import { fmtSigned, signedAmount } from "./propertyFinanceUtils.js";

const SOURCE_LABELS = { plaid: "Plaid", import: "Import", manual: "Manual" };

export default function TransactionLedger({ transactions, categories, onCategoryChange, onAllocationChange, onReconcileToggle, onExclude }) {
  const [filters, setFilters] = useState({ category: "", sourceType: "", reconciled: "", allocation: "" });
  const [expandedId, setExpandedId] = useState(null);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (filters.category && t.normalized_category !== filters.category) return false;
      if (filters.sourceType && t.source_type !== filters.sourceType) return false;
      if (filters.reconciled === "yes" && !t.is_reconciled) return false;
      if (filters.reconciled === "no" && t.is_reconciled) return false;
      if (filters.allocation === "rental" && Number(t.rental_use_percent) < 100) return false;
      if (filters.allocation === "personal" && Number(t.personal_use_percent) <= 0) return false;
      if (filters.allocation === "mixed" && (Number(t.rental_use_percent) >= 100 || Number(t.rental_use_percent) <= 0)) return false;
      return true;
    });
  }, [transactions, filters]);

  const total = filtered.reduce((sum, t) => sum + (t.excluded ? 0 : signedAmount(t)), 0);

  return (
    <section style={styles.section}>
      <div style={styles.headRow}>
        <h2 style={styles.heading}>Transaction Ledger</h2>
        <span style={styles.totalNote}>{filtered.length} shown · net {fmtSigned(total)}</span>
      </div>

      <div style={styles.filters}>
        <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} style={styles.select}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filters.sourceType} onChange={(e) => setFilters((f) => ({ ...f, sourceType: e.target.value }))} style={styles.select}>
          <option value="">All sources</option>
          <option value="plaid">Plaid</option>
          <option value="import">Import</option>
          <option value="manual">Manual</option>
        </select>
        <select value={filters.reconciled} onChange={(e) => setFilters((f) => ({ ...f, reconciled: e.target.value }))} style={styles.select}>
          <option value="">Reconciled: any</option>
          <option value="yes">Reconciled</option>
          <option value="no">Unreconciled</option>
        </select>
        <select value={filters.allocation} onChange={(e) => setFilters((f) => ({ ...f, allocation: e.target.value }))} style={styles.select}>
          <option value="">Allocation: any</option>
          <option value="rental">Fully rental</option>
          <option value="personal">Has personal use</option>
          <option value="mixed">Mixed</option>
        </select>
      </div>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Merchant / Memo</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Source</th>
              <th style={styles.thRight}>Amount</th>
              <th style={styles.th}>Allocation</th>
              <th style={styles.th}>Reconciled</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const uncertain = t.needs_review || (t.match_confidence != null && Number(t.match_confidence) < 0.5);
              return (
                <React.Fragment key={t.id}>
                  <tr style={{ ...styles.row, opacity: t.excluded ? 0.45 : 1, background: uncertain ? "rgba(245, 158, 11, 0.08)" : "transparent" }}>
                    <td style={styles.td}>{t.transaction_date ? t.transaction_date.slice(0, 10) : "—"}</td>
                    <td style={styles.td} onClick={() => setExpandedId(expandedId === t.id ? null : t.id)} title="Click for notes / match explanation">
                      <span style={{ cursor: "pointer" }}>{t.merchant || t.memo || "—"}</span>
                      {uncertain && <span style={styles.uncertainBadge} title={t.match_explanation}>uncertain</span>}
                    </td>
                    <td style={styles.td}>
                      <select
                        value={t.normalized_category}
                        onChange={(e) => onCategoryChange(t.id, e.target.value)}
                        style={{ ...styles.select, ...(t.normalized_category === "Uncategorized" ? { borderColor: "var(--amber, #f59e0b)" } : {}) }}
                      >
                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={styles.td}>{SOURCE_LABELS[t.source_type] || t.source_type}</td>
                    <td style={{ ...styles.tdRight, color: t.direction === "income" ? "var(--green, #22c55e)" : "var(--text)" }}>
                      {fmtSigned(signedAmount(t))}
                    </td>
                    <td style={styles.td}>
                      <AllocationBadge t={t} onChange={(rental) => onAllocationChange(t.id, rental)} />
                    </td>
                    <td style={styles.td}>
                      <button
                        onClick={() => onReconcileToggle(t.id, !t.is_reconciled)}
                        style={{ ...styles.reconcileBtn, ...(t.is_reconciled ? styles.reconciledOn : {}) }}
                      >
                        {t.is_reconciled ? "✓ Reconciled" : "Mark reconciled"}
                      </button>
                      {!t.excluded && (
                        <button onClick={() => onExclude(t.id, true)} style={styles.excludeBtn} title="Exclude from totals">✕</button>
                      )}
                    </td>
                  </tr>
                  {expandedId === t.id && (
                    <tr>
                      <td colSpan={7} style={styles.detailRow}>
                        <div><strong>Memo:</strong> {t.memo || "—"}</div>
                        <div><strong>Source category:</strong> {t.source_category || "—"}</div>
                        {t.match_explanation && <div><strong>Match explanation:</strong> {t.match_explanation} (confidence {Math.round((t.match_confidence || 0) * 100)}%)</div>}
                        {t.reconciled_via_reserve_account && <div>Reconciled via reserve account.</div>}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={styles.empty}>No transactions match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AllocationBadge({ t, onChange }) {
  const rental = Number(t.rental_use_percent);
  const label = rental >= 100 ? "100% rental" : rental <= 0 ? "0% rental" : `${rental}% rental`;
  return (
    <select
      value={rental}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...miniSelect, color: rental >= 100 ? "var(--green, #22c55e)" : rental <= 0 ? "var(--red, #ef4444)" : "var(--amber, #f59e0b)" }}
    >
      <option value={100}>100% rental</option>
      <option value={75}>75% rental</option>
      <option value={50}>50/50 split</option>
      <option value={25}>25% rental</option>
      <option value={0}>0% rental (personal)</option>
    </select>
  );
}

const miniSelect = { fontSize: 12, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", fontFamily: "var(--font-mono)" };

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  headRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 },
  heading: { fontSize: 15, fontWeight: 700 },
  totalNote: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  filters: { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  select: { fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--text)" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 780 },
  th: { textAlign: "left", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 8px", borderBottom: "1px solid var(--border)" },
  thRight: { textAlign: "right", color: "var(--muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 8px", borderBottom: "1px solid var(--border)" },
  row: { borderBottom: "1px solid var(--border)" },
  td: { padding: "8px 8px", verticalAlign: "middle" },
  tdRight: { padding: "8px 8px", textAlign: "right", fontFamily: "var(--font-mono)" },
  empty: { padding: 16, textAlign: "center", color: "var(--muted)" },
  uncertainBadge: { marginLeft: 8, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--amber, #f59e0b)", color: "#1a1a1a", fontWeight: 700, textTransform: "uppercase" },
  reconcileBtn: { fontSize: 11, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--muted)", cursor: "pointer", marginRight: 6 },
  reconciledOn: { background: "rgba(34,197,94,0.15)", color: "var(--green, #22c55e)", borderColor: "var(--green, #22c55e)" },
  excludeBtn: { fontSize: 11, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: "var(--red, #ef4444)", cursor: "pointer" },
  detailRow: { padding: "10px 16px", fontSize: 12, color: "var(--muted)", background: "var(--surface2)", display: "flex", flexDirection: "column", gap: 4 },
};
