import React, { useState, useEffect, useMemo } from "react";
import { fetchMonthEnd, downloadMonthEndXlsx } from "../api.js";
import HealthEquityImport from "../components/HealthEquityImport.jsx";

const fmtSigned = (n) =>
  n == null ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Previous full month as YYYY-MM — matches the server default.
function previousMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

// Match the server defaults (exact per-line bill charge incl. surcharges, taxes, fees).
const DEFAULT_VERIZON_LINES = 2;
const DEFAULT_VERIZON_LINE_AMOUNT = 37.49;
const DEFAULT_VERIZON_ACCOUNT_CREDIT = 20.0;
const DEFAULT_VERIZON_ACCOUNT_LINES = 9;

const COLS = "90px minmax(0,1fr) 140px 140px 100px";

function TxnTable({ rows }) {
  if (!rows.length) return <p style={styles.empty}>None</p>;
  return (
    <div>
      <div style={{ ...styles.tableHeader, gridTemplateColumns: COLS }}>
        <span>Date</span>
        <span>Merchant</span>
        <span>Category</span>
        <span>Account</span>
        <span style={styles.right}>Amount</span>
      </div>
      {rows.map((r, i) => (
        <div key={`${r.transaction_id}-${i}`} style={{ ...styles.row, gridTemplateColumns: COLS }}>
          <span style={styles.monoMuted}>{r.date}</span>
          <span style={styles.cell}>{r.merchant}</span>
          <span style={styles.cell}>{r.category || "Uncategorized"}</span>
          <span style={styles.cell}>{r.account}</span>
          <span style={{ ...styles.mono, ...styles.right }}>{fmtSigned(r.amount)}</span>
        </div>
      ))}
    </div>
  );
}

export default function MonthEnd() {
  const defaultMonth = useMemo(previousMonth, []);
  const [month, setMonth] = useState(defaultMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [linesInput, setLinesInput] = useState(String(DEFAULT_VERIZON_LINES));
  const [amountInput, setAmountInput] = useState(DEFAULT_VERIZON_LINE_AMOUNT.toFixed(2));
  const [creditInput, setCreditInput] = useState(DEFAULT_VERIZON_ACCOUNT_CREDIT.toFixed(2));
  const [accountLinesInput, setAccountLinesInput] = useState(String(DEFAULT_VERIZON_ACCOUNT_LINES));

  // Empty/invalid input falls back to the defaults so bad values are never sent.
  const verizonLines = /^\d{1,3}$/.test(linesInput.trim()) ? Number(linesInput.trim()) : DEFAULT_VERIZON_LINES;
  const verizonLineAmount = /^\d{1,7}(\.\d{1,2})?$/.test(amountInput.trim())
    ? Number(amountInput.trim())
    : DEFAULT_VERIZON_LINE_AMOUNT;
  const verizonAccountCredit = /^\d{1,7}(\.\d{1,2})?$/.test(creditInput.trim())
    ? Number(creditInput.trim())
    : DEFAULT_VERIZON_ACCOUNT_CREDIT;
  const verizonAccountLines =
    /^\d{1,3}$/.test(accountLinesInput.trim()) && Number(accountLinesInput.trim()) >= 1
      ? Number(accountLinesInput.trim())
      : DEFAULT_VERIZON_ACCOUNT_LINES;

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMonthEnd(month, { verizonLines, verizonLineAmount, verizonAccountCredit, verizonAccountLines })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) { setError(e.message); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, verizonLines, verizonLineAmount, verizonAccountCredit, verizonAccountLines, reloadKey]);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      await downloadMonthEndXlsx(month, { verizonLines, verizonLineAmount, verizonAccountCredit, verizonAccountLines });
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={styles.card}>
      <p style={styles.title}>Month-End Reconciliation</p>
      <div style={styles.toolbar}>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={styles.dateInput}
        />
        <label style={styles.fieldLabel}>
          Verizon per-line amount ($)
          <input
            type="number"
            min="0"
            step="0.01"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            style={{ ...styles.dateInput, width: 90 }}
          />
        </label>
        <label style={styles.fieldLabel}>
          Lines
          <input
            type="number"
            min="0"
            step="1"
            value={linesInput}
            onChange={(e) => setLinesInput(e.target.value)}
            style={{ ...styles.dateInput, width: 60 }}
          />
        </label>
        <label style={styles.fieldLabel}>
          Account credit ($)
          <input
            type="number"
            min="0"
            step="0.01"
            value={creditInput}
            onChange={(e) => setCreditInput(e.target.value)}
            style={{ ...styles.dateInput, width: 90 }}
          />
        </label>
        <label style={styles.fieldLabel}>
          Account lines
          <input
            type="number"
            min="1"
            step="1"
            value={accountLinesInput}
            onChange={(e) => setAccountLinesInput(e.target.value)}
            style={{ ...styles.dateInput, width: 60 }}
          />
        </label>
        <button onClick={handleDownload} disabled={downloading || !data} style={styles.chip}>
          {downloading ? "Downloading…" : "Download Excel"}
        </button>
        <button onClick={() => setImportOpen(true)} style={styles.chip}>Import HealthEquity</button>
        {loading && <span style={styles.count}>Loading…</span>}
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {data?.health_equity?.banner && !loading && !error && (
        <div role="alert" style={styles.warnBanner}>
          {data.health_equity.banner}
          <button onClick={() => setImportOpen(true)} style={styles.bannerBtn}>Import HealthEquity file</button>
        </div>
      )}

      {data && (
        <>
          <div style={styles.stats}>
            <div style={styles.stat}>
              <p style={styles.statLabel}>Kids subtotal</p>
              <p style={styles.statVal}>{fmtSigned(data.kids.subtotal)}</p>
            </div>
            <div style={styles.stat}>
              <p style={styles.statLabel}>Kids 50% share</p>
              <p style={styles.statVal}>{fmtSigned(data.kids.share)}</p>
            </div>
            <div style={styles.stat}>
              <p style={styles.statLabel}>Verizon 50% share</p>
              <p style={styles.statVal}>{fmtSigned(data.verizon.share)}</p>
            </div>
            <div style={styles.stat}>
              <p style={styles.statLabel}>Total due</p>
              <p style={{ ...styles.statVal, color: "var(--accent)" }}>{fmtSigned(data.total_due)}</p>
            </div>
          </div>
          <p style={styles.note}>{data.verizon.label}</p>
          <p style={styles.note}>{data.verizon.credit_label}</p>
          <p style={styles.note}>Net Verizon: {fmtSigned(data.verizon.net_total)}</p>

          <p style={styles.subTitle}>Kids ({data.kids.rows.length})</p>
          <TxnTable rows={data.kids.rows} />

          {data.personal_jared && (
            <>
              <p style={styles.subTitle}>
                Personal - Jared ({data.personal_jared.rows.length}) — listed only, not in total due — Subtotal {fmtSigned(data.personal_jared.subtotal)}
              </p>
              <TxnTable rows={data.personal_jared.rows} />
            </>
          )}

          <p style={styles.subTitle}>Review: Uncategorized ({data.review.uncategorized.length}) — not in totals</p>
          <TxnTable rows={data.review.uncategorized} />

          <p style={styles.subTitle}>Review: Health ({data.review.health.length}) — not in totals</p>
          <TxnTable rows={data.review.health} />
        </>
      )}
      {importOpen && (
        <HealthEquityImport
          onClose={(imported) => {
            setImportOpen(false);
            if (imported) setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

const styles = {
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px 16px", marginBottom: 16 },
  title: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 16 },
  subTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "20px 0 8px" },
  toolbar: { display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  chip: {
    padding: "7px 14px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 99, color: "var(--text)", fontSize: 12, fontWeight: 600,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  dateInput: {
    padding: "7px 10px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  fieldLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  errorBox: {
    padding: "10px 14px", marginBottom: 16, background: "var(--surface)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
    color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)",
  },
  warnBanner: {
    width: "100%", boxSizing: "border-box", padding: "12px 16px", marginBottom: 16,
    background: "#fbbf24", border: "1px solid #b45309",
    borderRadius: "var(--radius)", color: "#1f1300", fontSize: 14, fontWeight: 700,
    fontFamily: "var(--font-mono)",
  },
  bannerBtn: {
    marginLeft: 12, padding: "6px 14px", background: "#1f1300", border: "1px solid #1f1300",
    borderRadius: 99, color: "#fff", fontSize: 12, fontWeight: 700,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 },
  stat: { background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "14px 18px" },
  statLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 6 },
  statVal: { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" },
  note: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  tableHeader: {
    display: "grid", padding: "8px 4px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)", borderRadius: "var(--radius) var(--radius) 0 0",
  },
  row: { display: "grid", padding: "9px 4px", borderBottom: "1px solid var(--border)", alignItems: "center" },
  cell: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  mono: { fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 500 },
  monoMuted: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  right: { textAlign: "right" },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "16px 0" },
};
