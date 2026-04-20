import React, { useState, useMemo } from "react";
import { saveAssignment, saveMerchantOverride } from "../api.js";

const toNum = (n) => n == null ? null : parseFloat(n);

const fmt = (n) => {
  const v = toNum(n);
  if (v == null || isNaN(v)) return "—";
  return (v < 0 ? "+" : "-") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2 });
};

const fmtRound = (n) => {
  const v = toNum(n);
  if (v == null || isNaN(v)) return "—";
  return "$" + Math.round(Math.abs(v)).toLocaleString("en-US");
};

const fmtDate = (d) => {
  if (!d) return "—";
  const s = typeof d === "string" ? d : d.toISOString();
  return s.slice(5, 10).replace("-", "/");
};

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
  const [minAmount, setMinAmount]   = useState("");
  const [maxAmount, setMaxAmount]   = useState("");
  const [sort, setSort]             = useState({ col: "date", dir: "desc" });
  const [saving, setSaving]         = useState({});
  const [editingMerchant, setEditingMerchant] = useState(null);
  const [merchantDraft, setMerchantDraft]     = useState("");

  const acctMap = useMemo(() => {
    const m = {};
    (accounts || []).forEach((a) => {
      m[a.account_id] = a.name || a.official_name || a.account_id;
    });
    return m;
  }, [accounts]);

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

  const stats = useMemo(() => {
    const spend = transactions.filter((t) => toNum(t.amount) > 0).reduce((s, t) => s + toNum(t.amount), 0);
    const needsReview = transactions.filter((t) => !assignments?.[t.transaction_id]).length;
    return { total: transactions.length, spend, needsReview };
  }, [transactions, assignments]);

  function toggleSort(col) {
    setSort(prev => prev.col === col
      ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { col, dir: col === "amount" ? "desc" : "desc" }
    );
  }

  const sortIcon = (col) => {
    if (sort.col !== col) return <span style={styles.sortNeutral}>⇅</span>;
    return <span style={styles.sortActive}>{sort.dir === "asc" ? "↑" : "↓"}</span>;
  };

  const filtered = useMemo(() => {
    const min = minAmount !== "" ? parseFloat(minAmount) : null;
    const max = maxAmount !== "" ? parseFloat(maxAmount) : null;

    let rows = transactions.filter((t) => {
      const name = getDisplayName(t).toLowerCase();
      const amt = Math.abs(toNum(t.amount) ?? 0);
      if (search && !name.includes(search.toLowerCase())) return false;
      if (catFilter === "unassigned" && assignments?.[t.transaction_id]) return false;
      if (catFilter !== "all" && catFilter !== "unassigned" && assignments?.[t.transaction_id] !== catFilter) return false;
      if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
      if (min !== null && amt < min) return false;
      if (max !== null && amt > max) return false;
      return true;
    });

    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (sort.col === "date") {
        av = a.date || ""; bv = b.date || "";
      } else if (sort.col === "amount") {
        av = Math.abs(toNum(a.amount) ?? 0);
        bv = Math.abs(toNum(b.amount) ?? 0);
      } else if (sort.col === "merchant") {
        av = getDisplayName(a).toLowerCase();
        bv = getDisplayName(b).toLowerCase();
      } else if (sort.col === "account") {
        av = (acctMap[a.account_id] || a.account_id || "").toLowerCase();
        bv = (acctMap[b.account_id] || b.account_id || "").toLowerCase();
      } else {
        av = ""; bv = "";
      }
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }, [transactions, search, catFilter, acctFilter, minAmount, maxAmount, sort, assignments, merchantOverrides, acctMap]);

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

  const hasFilters = search || catFilter !== "all" || acctFilter !== "all" || minAmount || maxAmount;

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
        <input
          type="number"
          placeholder="Min $"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          style={{ ...styles.input, maxWidth: 90 }}
        />
        <input
          type="number"
          placeholder="Max $"
          value={maxAmount}
          onChange={(e) => setMaxAmount(e.target.value)}
          style={{ ...styles.input, maxWidth: 90 }}
        />
        {hasFilters && (
          <button
            style={styles.clearBtn}
            onClick={() => { setSearch(""); setCatFilter("all"); setAcctFilter("all"); setMinAmount(""); setMaxAmount(""); }}
          >
            Clear
          </button>
        )}
        <span style={styles.count}>{filtered.length} of {stats.total}</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {transactions.length === 0
            ? "No transactions yet."
            : "No results match your filters."}
        </p>
      ) : (
        <div className="fade-up-2" style={styles.tableWrap}>
          <div style={styles.tableHeader}>
            <span style={styles.sortable} onClick={() => toggleSort("date")}>
              Date {sortIcon("date")}
            </span>
            <span style={styles.sortable} onClick={() => toggleSort("merchant")}>
              Merchant {sortIcon("merchant")}
            </span>
            <span style={styles.sortable} onClick={() => toggleSort("account")}>
              Account {sortIcon("account")}
            </span>
            <span style={{ ...styles.sortable, textAlign: "right" }} onClick={() => toggleSort("amount")}>
              Amount {sortIcon("amount")}
            </span>
            <span>Category</span>
          </div>
          {filtered.map((t) => {
            const assigned   = assignments?.[t.transaction_id];
            const isCredit   = toNum(t.amount) < 0;
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
                <span style={styles.date}>{fmtDate(t.date)}</span>

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
                    <option value="">
                      {unassigned && t.suggested_category ? `💡 ${t.suggested_category}` : "— None —"}
                    </option>
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

  toolbar: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  input: {
    flex: 1, maxWidth: 220, padding: "8px 12px",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  select: {
    padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },
  clearBtn: {
    padding: "8px 12px", background: "none", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 12,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" },

  tableWrap: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  tableHeader: {
    display: "grid", gridTemplateColumns: "76px minmax(0,1fr) minmax(0,150px) 96px minmax(0,210px)",
    padding: "10px 16px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)",
  },
  sortable: { cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4 },
  sortNeutral: { opacity: 0.3, fontSize: 10 },
  sortActive:  { color: "var(--accent)", fontSize: 10 },
  row: {
    display: "grid", gridTemplateColumns: "76px minmax(0,1fr) minmax(0,150px) 96px minmax(0,210px)",
    padding: "9px 16px", borderBottom: "1px solid var(--border)",
    alignItems: "center",
  },
  date:         { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", whiteSpace: "nowrap" },
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
