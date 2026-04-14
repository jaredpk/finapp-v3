import React, { useState, useMemo } from "react";
import { saveAssignment, saveMerchantOverride } from "../api.js";

const fmt = (n) =>
  n == null ? "—" : (n < 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

const fmtRound = (n) =>
  "$" + Math.round(Math.abs(n)).toLocaleString("en-US");

export default function Transactions({
  accounts,
  transactions,
  categories,
  assignments,
  merchantOverrides,
  setAssignments,
  setMerchantOverrides,
}) {
  const [search, setSearch]         = useState("");
  const [catFilter, setCatFilter]   = useState("all");
  const [acctFilter, setAcctFilter] = useState("all");
  const [saving, setSaving]         = useState({}); // { transaction_id: true }
  const [editingMerchant, setEditingMerchant] = useState(null);
  const [merchantDraft, setMerchantDraft]     = useState("");

  // Build account id → name lookup
  const acctMap = useMemo(() => {
    const m = {};
    (accounts || []).forEach((a) => {
      m[a.account_id] = a.name || a.official_name || a.account_id;
    });
    return m;
  }, [accounts]);

  // Unique account ids present in transactions
  const acctIds = useMemo(() => {
    return [...new Set(transactions.map((t) => t.account_id).filter(Boolean))].sort();
  }, [transactions]);

  const categoryMap = useMemo(() => {
    const m = {};
    (categories || []).forEach((c) => { m[c.id] = c; });
    return m;
  }, [categories]);

  const getDisplayName = (t) =>
    merchantOverrides?.[t.transaction_id] || t.merchant_name || t.name || "Unknown";

  // Stats
  const stats = useMemo(() => {
    const spend = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const needsReview = transactions.filter((t) => !assignments?.[t.transaction_id]).length;
    return { total: transactions.length, spend, needsReview };
  }, [transactions, assignments]);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      const name = getDisplayName(t).toLowerCase();
      if (search && !name.includes(search.toLowerCase())) return false;
      if (catFilter === "unassigned" && assignments?.[t.transaction_id]) return false;
      if (catFilter !== "all" && catFilter !== "unassigned" && assignments?.[t.transaction_id] !== catFilter) return false;
      if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
      return true;
    });
  }, [transactions, search, catFilter, acctFilter, assignments, merchantOverrides]);

  async function handleCategoryChange(txnId, categoryId) {
    setSaving((prev) => ({ ...prev, [txnId]: true }));
    try {
      await saveAssignment(txnId, categoryId || null);
      setAssignments((prev) => ({ ...prev, [txnId]: categoryId || null }));
    } finally {
      setSaving((prev) => ({ ...prev, [txnId]: false }));
    }
  }

  async function commitMerchantRename(t) {
    const draft = merchantDraft.trim();
    if (draft && draft !== getDisplayName(t)) {
      await saveMerchantOverride(t.transaction_id, draft);
      setMerchantOverrides((prev) => ({ ...prev, [t.transaction_id]: draft }));
    }
    setEditingMerchant(null);
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Transactions</h1>

      {/* Stats */}
      <div className="fade-up" style={styles.stats}>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Transactions</p>
          <p style={styles.statVal}>{stats.total || "—"}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Total Spend</p>
          <p style={styles.statVal}>{stats.spend ? fmtRound(stats.spend) : "—"}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Needs Review</p>
          <p style={{ ...styles.statVal, color: stats.needsReview > 0 ? "var(--red)" : "var(--text)" }}>
            {stats.needsReview}
          </p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Categories</p>
          <p style={styles.statVal}>{(categories || []).length || "—"}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="fade-up" style={styles.toolbar}>
        <input
          type="text"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.input}
        />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={styles.select}>
          <option value="all">All categories</option>
          <option value="unassigned">Unassigned</option>
          {(categories || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)} style={styles.select}>
          <option value="all">All accounts</option>
          {acctIds.map((id) => (
            <option key={id} value={id}>{acctMap[id] || id}</option>
          ))}
        </select>
        <span style={styles.count}>{filtered.length} of {stats.total}</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {transactions.length === 0
            ? "Connect a bank account to see transactions."
            : "No results match your filters."}
        </p>
      ) : (
        <div className="fade-up-2" style={styles.tableWrap}>
          <div style={styles.tableHeader}>
            <span>Date</span>
            <span>Merchant</span>
            <span>Account</span>
            <span style={{ textAlign: "right" }}>Amount</span>
            <span>Category</span>
          </div>
          {filtered.map((t) => {
            const assigned   = assignments?.[t.transaction_id];
            const isCredit   = t.amount < 0;
            const unassigned = !assigned;
            const isSaving   = saving[t.transaction_id];
            return (
              <div
                key={t.transaction_id}
                style={{
                  ...styles.row,
                  background: unassigned ? "rgba(185,28,28,0.04)" : "transparent",
                }}
              >
                <span style={styles.date}>{t.date?.slice(5).replace("-", "/")}</span>

                <span style={styles.merchantCell}>
                  {editingMerchant === t.transaction_id ? (
                    <input
                      autoFocus
                      value={merchantDraft}
                      onChange={(e) => setMerchantDraft(e.target.value)}
                      onBlur={() => commitMerchantRename(t)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitMerchantRename(t);
                        if (e.key === "Escape") setEditingMerchant(null);
                      }}
                      style={styles.merchantInput}
                    />
                  ) : (
                    <span
                      title="Click to rename"
                      onClick={() => {
                        setEditingMerchant(t.transaction_id);
                        setMerchantDraft(getDisplayName(t));
                      }}
                      style={{ cursor: "text" }}
                    >
                      {getDisplayName(t)}
                    </span>
                  )}
                </span>

                <span style={styles.acct}>{acctMap[t.account_id] || t.account_id || "—"}</span>

                <span style={{ ...styles.amount, color: isCredit ? "var(--green)" : "var(--text)" }}>
                  {fmt(t.amount)}
                </span>

                <span style={styles.catCell}>
                  <select
                    value={assigned || ""}
                    disabled={isSaving}
                    onChange={(e) => handleCategoryChange(t.transaction_id, e.target.value)}
                    style={{
                      ...styles.catSelect,
                      borderColor: unassigned ? "var(--red)" : "var(--border)",
                      opacity: isSaving ? 0.5 : 1,
                    }}
                  >
                    <option value="">— None —</option>
                    {(categories || []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap:    { padding: "36px 40px", maxWidth: 1100 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },

  stats: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10, marginBottom: 20 },
  stat:  { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "14px 18px" },
  statLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 6 },
  statVal:   { fontSize: 22, fontWeight: 700, color: "var(--text)" },

  toolbar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  input: {
    flex: 1, maxWidth: 260, padding: "8px 12px",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  select: {
    padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" },

  tableWrap: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  tableHeader: {
    display: "grid", gridTemplateColumns: "80px 1fr 160px 100px 220px",
    padding: "10px 16px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)",
  },
  row: {
    display: "grid", gridTemplateColumns: "80px 1fr 160px 100px 220px",
    padding: "9px 16px", borderBottom: "1px solid var(--border)",
    alignItems: "center",
  },
  date:         { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  merchantCell: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  merchantInput: {
    width: "100%", padding: "3px 7px",
    background: "var(--bg)", border: "1px solid var(--accent)",
    borderRadius: 4, color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  acct:   { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  amount: { fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", fontWeight: 500, paddingRight: 16 },
  catCell: {},
  catSelect: {
    width: "100%", padding: "5px 8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },
};
