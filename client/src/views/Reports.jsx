import React, { useState, useEffect, useMemo } from "react";
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { fetchReportSummary } from "../api.js";

const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtSigned = (n) =>
  n == null ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m) => {
  const [y, mo] = (m || "").split("-");
  return mo ? `${MONTHS[Number(mo) - 1]} ${String(y).slice(2)}` : m;
};

const iso = (d) => d.toISOString().slice(0, 10);

// Last n full months — matches the server's default range semantics.
function lastFullMonths(n) {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return [iso(first), iso(last)];
}

const PRESETS = [
  { id: "3M", label: "3M", range: () => lastFullMonths(3) },
  { id: "6M", label: "6M", range: () => lastFullMonths(6) },
  { id: "12M", label: "12M", range: () => lastFullMonths(12) },
  { id: "YTD", label: "YTD", range: () => {
    const now = new Date();
    return [`${now.getUTCFullYear()}-01-01`, iso(now)];
  } },
  // The endpoint caps ranges at 5 years, so "All" asks for the max it allows.
  { id: "ALL", label: "All", range: () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear() - 5, now.getUTCMonth(), now.getUTCDate() + 1));
    return [iso(start), iso(now)];
  } },
];

const OTHER_COLOR = "#64748b";
const TOP_CATEGORIES = 8;

export default function Reports() {
  const [defaultStart, defaultEnd] = useMemo(() => lastFullMonths(6), []);
  const [preset, setPreset] = useState("6M");
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!startDate || !endDate) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReportSummary(startDate, endDate)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) { setError(e.message); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  function applyPreset(p) {
    const [s, e] = p.range();
    setPreset(p.id);
    setStartDate(s);
    setEndDate(e);
  }

  const monthly = data?.monthly || [];
  const totals = data?.totals || { income: 0, spend: 0, net: 0, by_category: [] };
  const topMerchants = data?.top_merchants || [];
  const hasData = monthly.some((m) => m.income !== 0 || m.spend !== 0 || m.by_category.length > 0);

  // Income vs. spend, one point per month.
  const incomeSpendData = useMemo(
    () => monthly.map((m) => ({ month: monthLabel(m.month), income: m.income, spend: m.spend, net: m.net })),
    [monthly]
  );

  // Stacked by-category series: top 8 categories by range total, rest grouped
  // into "Other".
  const { stackedData, series } = useMemo(() => {
    const top = (totals.by_category || []).slice(0, TOP_CATEGORIES);
    const topNames = new Set(top.map((c) => c.name));
    const seriesList = top.map((c) => ({ name: c.name, color: c.color || OTHER_COLOR }));
    let hasOther = false;
    const rows = monthly.map((m) => {
      const point = { month: monthLabel(m.month) };
      for (const s of seriesList) point[s.name] = 0;
      let other = 0;
      for (const c of m.by_category) {
        if (topNames.has(c.name)) point[c.name] = (point[c.name] || 0) + c.amount;
        else other += c.amount;
      }
      if (other > 0) { hasOther = true; point.Other = Math.round(other * 100) / 100; }
      else point.Other = 0;
      return point;
    });
    if (hasOther) seriesList.push({ name: "Other", color: OTHER_COLOR });
    return { stackedData: rows, series: seriesList };
  }, [monthly, totals]);

  const tooltipStyle = {
    contentStyle: { background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 12 },
    labelStyle: { color: "var(--muted)" },
  };
  const axisTick = { fontSize: 10, fill: "var(--muted)", fontFamily: "var(--font-mono)" };

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Reports</h1>

      {/* Range picker */}
      <div style={styles.toolbar}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p)}
            style={{ ...styles.chip, ...(preset === p.id ? styles.chipActive : {}) }}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          value={startDate}
          onChange={(e) => { setPreset(null); setStartDate(e.target.value); }}
          style={styles.dateInput}
        />
        <span style={styles.dateSep}>→</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => { setPreset(null); setEndDate(e.target.value); }}
          style={styles.dateInput}
        />
        {loading && <span style={styles.count}>Loading…</span>}
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {/* Totals */}
      <div style={styles.stats}>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Income</p>
          <p style={{ ...styles.statVal, color: "var(--green)" }}>{fmt(totals.income)}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Spend</p>
          <p style={{ ...styles.statVal, color: "var(--red)" }}>{fmt(totals.spend)}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>Net</p>
          <p style={{ ...styles.statVal, color: totals.net < 0 ? "var(--red)" : "var(--green)" }}>{fmtSigned(totals.net)}</p>
        </div>
      </div>

      {/* Income vs. Spend */}
      <div style={styles.chartCard}>
        <p style={styles.chartTitle}>Income vs. Spend</p>
        {!hasData ? <Empty /> : (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={incomeSpendData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v.toLocaleString()}`} />
              <Tooltip {...tooltipStyle} formatter={(v, name) => [fmtSigned(v), name]} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
              <Bar dataKey="income" name="Income" fill="var(--green)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="spend" name="Spend" fill="var(--red)" radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="net" name="Net" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Spending by category over time */}
      <div style={styles.chartCard}>
        <p style={styles.chartTitle}>Spending by Category</p>
        {!hasData ? <Empty /> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={stackedData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="month" tick={axisTick} tickLine={false} axisLine={false} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v.toLocaleString()}`} />
              <Tooltip {...tooltipStyle} formatter={(v, name) => [fmt(v), name]} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
              {series.map((s) => (
                <Bar key={s.name} dataKey={s.name} stackId="spend" fill={s.color} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Category totals */}
      <div style={styles.tableCard}>
        <p style={styles.chartTitle}>Category Totals</p>
        {totals.by_category.length === 0 ? <Empty /> : (
          <div>
            <div style={{ ...styles.tableHeader, gridTemplateColumns: "minmax(0,1fr) 120px 80px" }}>
              <span>Category</span>
              <span style={styles.right}>Total</span>
              <span style={styles.right}>% Spend</span>
            </div>
            {totals.by_category.map((c) => (
              <div key={c.category_id ?? "uncategorized"} style={{ ...styles.row, gridTemplateColumns: "minmax(0,1fr) 120px 80px" }}>
                <span style={styles.catName}>
                  <span style={{ ...styles.swatch, background: c.color }} />
                  {c.name}
                </span>
                <span style={{ ...styles.mono, ...styles.right }}>{fmt(c.amount)}</span>
                <span style={{ ...styles.monoMuted, ...styles.right }}>
                  {totals.spend > 0 ? `${((c.amount / totals.spend) * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top merchants */}
      <div style={styles.tableCard}>
        <p style={styles.chartTitle}>Top Merchants</p>
        {topMerchants.length === 0 ? <Empty /> : (
          <div>
            <div style={{ ...styles.tableHeader, gridTemplateColumns: "minmax(0,1fr) 80px 120px" }}>
              <span>Merchant</span>
              <span style={styles.right}>Count</span>
              <span style={styles.right}>Total</span>
            </div>
            {topMerchants.map((m) => (
              <div key={m.merchant} style={{ ...styles.row, gridTemplateColumns: "minmax(0,1fr) 80px 120px" }}>
                <span style={styles.merchantCell}>{m.merchant}</span>
                <span style={{ ...styles.monoMuted, ...styles.right }}>{m.count}</span>
                <span style={{ ...styles.mono, ...styles.right }}>{fmt(m.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return <p style={styles.empty}>No data in this range</p>;
}

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 1100 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },

  toolbar: { display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" },
  chip: {
    padding: "7px 14px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 99, color: "var(--muted)", fontSize: 12, fontWeight: 600,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  chipActive: { background: "var(--surface2)", border: "1px solid var(--accent)", color: "var(--text)" },
  dateInput: {
    padding: "7px 10px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  dateSep: { color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },

  errorBox: {
    padding: "10px 14px", marginBottom: 16, background: "var(--surface)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
    color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)",
  },

  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 20 },
  stat: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "14px 18px" },
  statLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 6 },
  statVal: { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)" },

  chartCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px", marginBottom: 16 },
  tableCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px 8px", marginBottom: 16 },
  chartTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 16 },

  tableHeader: {
    display: "grid", padding: "8px 4px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)", borderRadius: "var(--radius) var(--radius) 0 0",
  },
  row: { display: "grid", padding: "9px 4px", borderBottom: "1px solid var(--border)", alignItems: "center" },
  catName: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  swatch: { width: 10, height: 10, borderRadius: 3, flexShrink: 0, display: "inline-block" },
  merchantCell: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  mono: { fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 500 },
  monoMuted: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  right: { textAlign: "right" },

  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "32px 0" },
};
