import React, { useState, useMemo } from "react";

const DEFAULT_BUDGETS = {
  FOOD_AND_DRINK: 500,
  TRANSPORTATION: 200,
  SHOPPING: 300,
  ENTERTAINMENT: 150,
  GENERAL_MERCHANDISE: 250,
  TRAVEL: 400,
  PERSONAL_CARE: 100,
  UTILITIES: 200,
};

const fmt = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function pct(spent, budget) {
  return Math.min((spent / budget) * 100, 100);
}

export default function Budget({ transactions }) {
  const [budgets, setBudgets] = useState(DEFAULT_BUDGETS);
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState("");

  const now = new Date();

  const spending = useMemo(() => {
    const map = {};
    transactions
      .filter((t) => {
        const d = new Date(t.date);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.amount > 0;
      })
      .forEach((t) => {
        const cat = t.personal_finance_category?.primary || t.category?.[0] || "OTHER";
        map[cat] = (map[cat] || 0) + t.amount;
      });
    return map;
  }, [transactions]);

  // Merge budgeted + any unbudgeted categories that have spending
  const allCats = useMemo(() => {
    const cats = new Set([...Object.keys(budgets), ...Object.keys(spending)]);
    return Array.from(cats);
  }, [budgets, spending]);

  const totalBudget = Object.values(budgets).reduce((s, v) => s + v, 0);
  const totalSpent = allCats.reduce((s, c) => s + (spending[c] || 0), 0);

  function startEdit(cat) {
    setEditing(cat);
    setEditVal(budgets[cat] || "");
  }

  function saveEdit(cat) {
    const val = parseFloat(editVal);
    if (!isNaN(val) && val >= 0) {
      setBudgets((b) => ({ ...b, [cat]: val }));
    }
    setEditing(null);
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Budget</h1>
      <p className="fade-up" style={styles.sub}>
        {now.toLocaleString("default", { month: "long", year: "numeric" })}
      </p>

      {/* Summary */}
      <div className="fade-up" style={styles.summaryRow}>
        <div style={styles.summaryCard}>
          <p style={styles.sumLabel}>Total Budget</p>
          <p style={styles.sumVal}>{fmt(totalBudget)}</p>
        </div>
        <div style={styles.summaryCard}>
          <p style={styles.sumLabel}>Total Spent</p>
          <p style={{ ...styles.sumVal, color: totalSpent > totalBudget ? "var(--red)" : "var(--green)" }}>{fmt(totalSpent)}</p>
        </div>
        <div style={styles.summaryCard}>
          <p style={styles.sumLabel}>Remaining</p>
          <p style={{ ...styles.sumVal, color: totalBudget - totalSpent < 0 ? "var(--red)" : "var(--text)" }}>
            {fmt(Math.max(0, totalBudget - totalSpent))}
          </p>
        </div>
      </div>

      {/* Category rows */}
      <div className="fade-up-2" style={styles.list}>
        {allCats.map((cat) => {
          const spent = spending[cat] || 0;
          const budget = budgets[cat] || 0;
          const over = budget > 0 && spent > budget;
          const p = budget > 0 ? pct(spent, budget) : 0;
          const color = over ? "var(--red)" : p > 75 ? "var(--accent)" : "var(--green)";

          return (
            <div key={cat} style={styles.catRow}>
              <div style={styles.catInfo}>
                <span style={styles.catName}>{cat.replace(/_/g, " ")}</span>
                <span style={styles.catAmts}>
                  <span style={{ color }}>{fmt(spent)}</span>
                  <span style={{ color: "var(--muted)" }}> / </span>
                  {editing === cat ? (
                    <input
                      type="number"
                      value={editVal}
                      onChange={(e) => setEditVal(e.target.value)}
                      onBlur={() => saveEdit(cat)}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(cat)}
                      style={styles.editInput}
                      autoFocus
                    />
                  ) : (
                    <span
                      onClick={() => startEdit(cat)}
                      style={{ color: "var(--muted)", cursor: "pointer", textDecoration: "underline dotted" }}
                      title="Click to edit"
                    >
                      {budget > 0 ? fmt(budget) : "set budget"}
                    </span>
                  )}
                </span>
              </div>
              <div style={styles.barTrack}>
                <div style={{ ...styles.barFill, width: `${p}%`, background: color }} />
              </div>
              {over && <span style={styles.overBadge}>over by {fmt(spent - budget)}</span>}
            </div>
          );
        })}
      </div>
      <p style={styles.hint}>Click any budget amount to edit it.</p>
    </div>
  );
}

const styles = {
  wrap: { padding: "36px 40px", maxWidth: 760 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text)", marginBottom: 4 },
  sub: { fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 28 },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 28 },
  summaryCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "18px 20px" },
  sumLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 6 },
  sumVal: { fontSize: 26, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.03em", color: "var(--text)" },
  list: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  catRow: { padding: "16px 22px", borderBottom: "1px solid var(--border)" },
  catInfo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  catName: { fontSize: 13, fontWeight: 500, color: "var(--text)" },
  catAmts: { fontSize: 13, fontFamily: "var(--font-mono)" },
  barTrack: { height: 5, background: "var(--border)", borderRadius: 99, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 99, transition: "width 0.5s cubic-bezier(0.22,1,0.36,1)" },
  overBadge: { marginTop: 5, display: "inline-block", fontSize: 10, color: "var(--red)", fontFamily: "var(--font-mono)" },
  editInput: {
    background: "none",
    border: "none",
    borderBottom: "1px solid var(--accent)",
    color: "var(--accent)",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    width: 80,
    outline: "none",
    padding: "0 2px",
  },
  hint: { marginTop: 12, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", textAlign: "right" },
};
