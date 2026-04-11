import React, { useState, useMemo } from "react";

const fmt = (n) =>
  n == null ? "—" : (n < 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function Transactions({ transactions }) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");

  const categories = useMemo(() => {
    const cats = new Set(
      transactions.map((t) => t.personal_finance_category?.primary || t.category?.[0] || "Other")
    );
    return ["All", ...Array.from(cats).sort()];
  }, [transactions]);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      const name = (t.merchant_name || t.name || "").toLowerCase();
      const cat = t.personal_finance_category?.primary || t.category?.[0] || "Other";
      const matchSearch = !search || name.includes(search.toLowerCase());
      const matchCat = catFilter === "All" || cat === catFilter;
      return matchSearch && matchCat;
    });
  }, [transactions, search, catFilter]);

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Transactions</h1>

      {/* Toolbar */}
      <div className="fade-up" style={styles.toolbar}>
        <input
          type="text"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.input}
        />
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          style={styles.select}
        >
          {categories.map((c) => (
            <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
          ))}
        </select>
        <span style={styles.count}>{filtered.length} txns</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" }}>
          {transactions.length === 0 ? "Connect a bank account to see transactions." : "No results."}
        </p>
      ) : (
        <div className="fade-up-2" style={styles.table}>
          <div style={styles.tableHeader}>
            <span>Date</span>
            <span>Merchant</span>
            <span>Category</span>
            <span style={{ textAlign: "right" }}>Amount</span>
          </div>
          {filtered.map((t) => {
            const cat = t.personal_finance_category?.primary || t.category?.[0] || "Other";
            const isCredit = t.amount < 0;
            return (
              <div key={t.transaction_id} style={styles.row}>
                <span style={styles.date}>{t.date}</span>
                <span style={styles.merchant}>{t.merchant_name || t.name}</span>
                <span style={styles.cat}>{cat.replace(/_/g, " ")}</span>
                <span style={{ ...styles.amount, color: isCredit ? "var(--green)" : "var(--text)" }}>
                  {fmt(t.amount)}
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
  wrap: { padding: "36px 40px", maxWidth: 960 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },
  toolbar: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  input: {
    flex: 1,
    maxWidth: 300,
    padding: "9px 14px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    outline: "none",
  },
  select: {
    padding: "9px 14px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    outline: "none",
    cursor: "pointer",
    maxWidth: 200,
  },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  table: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  tableHeader: {
    display: "grid",
    gridTemplateColumns: "100px 1fr 160px 110px",
    padding: "10px 20px",
    background: "var(--surface2)",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--muted)",
    fontFamily: "var(--font-mono)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "100px 1fr 160px 110px",
    padding: "13px 20px",
    borderTop: "1px solid var(--border)",
    alignItems: "center",
    transition: "background 0.1s",
  },
  date: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  merchant: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  cat: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  amount: { fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", fontWeight: 500 },
};
