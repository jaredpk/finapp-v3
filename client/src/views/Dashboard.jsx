import React, { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import StatCard from "../components/StatCard.jsx";

const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLORS = ["var(--accent)", "var(--accent2)", "var(--blue)", "var(--green)"];

export default function Dashboard({ accounts, transactions, categories, assignments }) {
  const netWorth = useMemo(() => {
    if (!accounts.length) return null;
    return accounts.reduce((sum, a) => {
      const bal = a.balances?.current ?? 0;
      return a.type === "credit" || a.type === "loan" ? sum - bal : sum + bal;
    }, 0);
  }, [accounts]);

  const monthSpend = useMemo(() => {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    return transactions
      .filter((t) => {
        const d = new Date(t.date);
        return d.getMonth() === month && d.getFullYear() === year && t.amount > 0;
      })
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);

  // Build daily spending data for last 30 days
  const spendingData = useMemo(() => {
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split("T")[0]);
    }
    const byDay = {};
    transactions
      .filter((t) => t.amount > 0 && days.includes(t.date))
      .forEach((t) => {
        byDay[t.date] = (byDay[t.date] || 0) + t.amount;
      });
    return days.map((d) => ({
      date: d.slice(5),
      amount: byDay[d] || 0,
    }));
  }, [transactions]);

  // Build category id → name lookup
  const categoryMap = useMemo(() => {
    const m = {};
    (categories || []).forEach((c) => { m[c.id] = c.name; });
    return m;
  }, [categories]);

  // Top spending categories — prefer user-assigned, fall back to Plaid
  const spendByCategory = useMemo(() => {
    const map = {};
    transactions
      .filter((t) => t.amount > 0)
      .forEach((t) => {
        const assignedId = assignments?.[t.transaction_id];
        const label = (assignedId && categoryMap[assignedId])
          ? categoryMap[assignedId]
          : (t.category || "Other").replace(/_/g, " ");
        map[label] = (map[label] || 0) + t.amount;
      });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [transactions, assignments, categoryMap]);

  const totalCat = spendByCategory.reduce((s, [, v]) => s + v, 0);

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Overview</h1>

      {/* Stats */}
      <div style={styles.stats}>
        <StatCard label="Net Worth" value={netWorth != null ? fmt(netWorth) : "—"} sub="across all accounts" accent="var(--accent)" delay={0} />
        <StatCard label="This Month" value={monthSpend ? fmt(-monthSpend) : "—"} sub="total spending" accent="var(--red)" delay={0.06} />
        <StatCard label="Accounts" value={accounts.length || "—"} sub="connected" delay={0.12} />
        <StatCard label="Transactions" value={transactions.length || "—"} sub="last 90 days" delay={0.18} />
      </div>

      {/* Chart */}
      <div className="fade-up-2" style={styles.chartCard}>
        <p style={styles.chartTitle}>Daily Spending — Last 30 Days</p>
        {transactions.length === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={spendingData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)", fontFamily: "var(--font-mono)" }} tickLine={false} axisLine={false} interval={4} />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted)", fontFamily: "var(--font-mono)" }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}
                labelStyle={{ color: "var(--muted)" }}
                formatter={(v) => [fmt(v), "Spent"]}
              />
              <Area type="monotone" dataKey="amount" stroke="var(--accent)" strokeWidth={2} fill="url(#spendGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Categories */}
      <div className="fade-up-3" style={styles.catCard}>
        <p style={styles.chartTitle}>Top Spending Categories</p>
        {spendByCategory.length === 0 ? <Empty /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
            {spendByCategory.map(([cat, amt], i) => (
              <div key={cat}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{cat}</span>
                  <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>{fmt(amt)}</span>
                </div>
                <div style={{ height: 4, background: "var(--border)", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(amt / totalCat) * 100}%`, background: COLORS[i % COLORS.length], borderRadius: 99, transition: "width 0.6s ease" }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "32px 0" }}>Connect a bank account to see data</p>;
}

const styles = {
  wrap: { padding: "36px 40px", maxWidth: 960 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 28, color: "var(--text)" },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14, marginBottom: 24 },
  chartCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px", marginBottom: 16 },
  catCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px" },
  chartTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 16 },
};
