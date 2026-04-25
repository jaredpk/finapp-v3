import React, { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import StatCard from "../components/StatCard.jsx";

const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtSigned = (n) =>
  n == null ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const COLORS = ["var(--accent)", "var(--accent2)", "var(--blue)", "var(--green)"];

export default function Dashboard({ accounts, transactions, categories, assignments }) {
  const netWorth = useMemo(() => {
    if (!accounts.length) return null;
    return accounts.reduce((sum, a) => {
      const bal = a.balances?.current ?? 0;
      return a.type === "credit" || a.type === "loan" ? sum - bal : sum + bal;
    }, 0);
  }, [accounts]);

  // Build category id → name lookup
  const categoryMap = useMemo(() => {
    const m = {};
    (categories || []).forEach((c) => { m[c.id] = c.name; });
    return m;
  }, [categories]);

  // Resolve a transaction's display category label
  const resolveLabel = (t) => {
    const assignedId = assignments?.[t.transaction_id];
    return (assignedId && categoryMap[assignedId])
      ? categoryMap[assignedId]
      : (t.category || "Other").replace(/_/g, " ");
  };

  // True for any transaction that is a fund transfer (internal money movement)
  const isTransfer = (t) => {
    const label = resolveLabel(t);
    return label.toLowerCase().startsWith("transfer") ||
      (t.category || "").toUpperCase().startsWith("TRANSFER");
  };

  const monthSpend = useMemo(() => {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    return transactions
      .filter((t) => {
        const d = new Date(t.date);
        return d.getMonth() === month && d.getFullYear() === year && t.amount > 0 && !isTransfer(t);
      })
      .reduce((s, t) => s + t.amount, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, assignments, categoryMap]);

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
      .filter((t) => t.amount > 0 && !isTransfer(t) && days.includes((t.date || "").slice(0, 10)))
      .forEach((t) => {
        const day = (t.date || "").slice(0, 10);
        byDay[day] = (byDay[day] || 0) + t.amount;
      });
    return days.map((d) => ({
      date: d.slice(5),
      amount: byDay[d] || 0,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, assignments, categoryMap]);

  // Top spending categories — prefer user-assigned, fall back to Plaid
  const spendByCategory = useMemo(() => {
    const map = {};
    transactions
      .filter((t) => t.amount > 0 && !isTransfer(t))
      .forEach((t) => {
        const label = resolveLabel(t);
        map[label] = (map[label] || 0) + t.amount;
      });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, assignments, categoryMap]);

  const totalCat = spendByCategory.reduce((s, [, v]) => s + v, 0);

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Overview</h1>

      {/* Stats */}
      <div style={styles.stats}>
        <StatCard label="Net Worth" value={netWorth != null ? fmtSigned(netWorth) : "—"} sub="across all accounts" accent="var(--accent)" delay={0} />
        <StatCard label="This Month" value={monthSpend ? fmt(-monthSpend) : "—"} sub="total spending" accent="var(--red)" delay={0.06} />
        <StatCard label="Accounts" value={accounts.length || "—"} sub="connected" delay={0.12} />
        <StatCard label="Transactions" value={transactions.length || "—"} sub="last 90 days" delay={0.18} />
      </div>

      {/* Accounts */}
      {accounts.length > 0 && (
        <div className="fade-up-2" style={styles.accountsCard}>
          <p style={styles.chartTitle}>Accounts</p>
          <div style={styles.accountList}>
            {accounts.map((a) => {
              const isLiability = a.type === "credit" || a.type === "loan";
              const bal = a.balances?.current ?? null;
              const avail = a.balances?.available ?? null;
              const showAvail = avail != null && avail !== bal;
              return (
                <div key={a.account_id} style={styles.accountRow}>
                  <div style={styles.accountLeft}>
                    <span style={styles.accountName}>{a.name || a.official_name}</span>
                    <span style={styles.accountSub}>
                      {a.institutionName && `${a.institutionName} · `}{a.subtype || a.type}
                    </span>
                  </div>
                  <div style={styles.accountRight}>
                    <span style={{ ...styles.accountBal, color: isLiability ? "var(--red, #ef4444)" : "var(--text)" }}>
                      {bal != null ? fmt(bal) : "—"}
                    </span>
                    {showAvail && (
                      <span style={styles.accountAvail}>{fmt(avail)} avail</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="fade-up-3" style={styles.chartCard}>
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
      <div className="fade-up-4" style={styles.catCard}>
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
  accountsCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px", marginBottom: 16 },
  accountList: { display: "flex", flexDirection: "column" },
  accountRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "11px 0", borderBottom: "1px solid var(--border)",
  },
  accountLeft: { display: "flex", flexDirection: "column", gap: 3 },
  accountName: { fontSize: 13, fontWeight: 600, color: "var(--text)" },
  accountSub: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", textTransform: "capitalize" },
  accountRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  accountBal: { fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)" },
  accountAvail: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  chartCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px", marginBottom: 16 },
  catCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px" },
  chartTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 16 },
};
