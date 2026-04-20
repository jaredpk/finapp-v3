import React, { useState, useEffect, useRef } from "react";
import { getApiKey, generateApiKey, importTransactions, clearImportedTransactions, previewDuplicates, runDeduplication } from "../api.js";

// ── Simplifi CSV parser ───────────────────────────────────────────────────────
const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function parseCsvLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseSimplifiCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);

    const dateStr = cols[idx("Date")]?.trim();
    const account = cols[idx("Account")]?.trim() || "Unknown";
    const payee   = cols[idx("Payee")]?.trim() || "Unknown";
    const category = cols[idx("Category")]?.trim() || "";
    const excluded = cols[idx("Exclusion")]?.trim().toLowerCase() === "yes";
    const amountStr = cols[idx("Amount")]?.trim();

    if (!dateStr || !amountStr) continue;

    // Parse "11-Apr-26" → "2026-04-11"
    const [day, mon, yr] = dateStr.split("-");
    const month = MONTHS[mon];
    if (!month) continue;
    const year = 2000 + parseInt(yr, 10);
    const date = `${year}-${String(month).padStart(2,"0")}-${String(parseInt(day,10)).padStart(2,"0")}`;

    // Simplifi: negative = expense. Our DB: positive = expense. Negate.
    const amount = -1 * parseFloat(amountStr);

    const txnId = `simplifi_${i}_${date}_${payee.replace(/\W/g,"").slice(0,20)}_${Math.abs(amount).toFixed(0)}`;

    rows.push({ transaction_id: txnId, account_id: account, amount, date, name: payee, merchant_name: payee, category, excluded });
  }
  return rows;
}

export default function Settings({ reloadData, user }) {
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  // CSV import state
  const fileRef = useRef(null);
  const [parsed, setParsed] = useState(null);       // parsed rows
  const [skipExcluded, setSkipExcluded] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // "Imported 47 transactions"
  const [clearing, setClearing] = useState(false);

  // Dedup state
  const [deduping, setDeduping]           = useState(false);
  const [dupePreview, setDupePreview]     = useState(null); // { groups, toRemove, preview }
  const [dupeResult, setDupeResult]       = useState(null);
  const [previewing, setPreviewing]       = useState(false);

  useEffect(() => {
    getApiKey().then((data) => {
      setApiKey(data.key || null);
      setLoading(false);
    });
  }, []);

  async function handleGenerate() {
    setGenerating(true);
    const data = await generateApiKey();
    setApiKey(data.key);
    setGenerating(false);
  }

  function handleCopy(text) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseSimplifiCsv(ev.target.result);
      setParsed(rows);
      setImportResult(null);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!parsed) return;
    setImporting(true);
    try {
      const rows = skipExcluded ? parsed.filter((r) => !r.excluded) : parsed;
      // Strip the 'excluded' flag before sending to server
      const toSend = rows.map(({ excluded, ...rest }) => rest);
      const res = await importTransactions(toSend);
      setImportResult(`Imported ${res.imported} transactions.`);
      setParsed(null);
      if (fileRef.current) fileRef.current.value = "";
      if (reloadData) reloadData();
    } finally {
      setImporting(false);
    }
  }

  async function handleClear() {
    setClearing(true);
    try {
      const res = await clearImportedTransactions();
      setImportResult(`Cleared ${res.deleted} imported transactions.`);
      if (reloadData) reloadData();
    } finally {
      setClearing(false);
    }
  }

  async function handleDedupePreview() {
    setPreviewing(true);
    setDupeResult(null);
    try {
      const res = await previewDuplicates();
      setDupePreview(res);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleDedupe() {
    setDeduping(true);
    try {
      const res = await runDeduplication();
      setDupeResult(`Removed ${res.deleted} duplicate transaction${res.deleted !== 1 ? "s" : ""}.`);
      setDupePreview(null);
      if (reloadData) reloadData();
    } finally {
      setDeduping(false);
    }
  }

  const sseUrl = apiKey ? `${window.location.origin}/sse?key=${apiKey}` : null;

  const mcpConfig = apiKey ? JSON.stringify({
    mcpServers: {
      finapp: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          `${window.location.origin}/mcp`,
          "--header",
          `x-api-key:${apiKey}`,
        ],
      },
    },
  }, null, 2) : null;

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Settings</h1>

      {/* Account info */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Account</h2>
        <div style={styles.row}>
          <span style={styles.label}>Name</span>
          <span style={styles.value}>{user?.user_metadata?.full_name || "—"}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Email</span>
          <span style={styles.value}>{user?.email || "—"}</span>
        </div>
      </section>

      {/* API Key */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Claude Desktop API Key</h2>
        <p style={styles.description}>
          Use this key to connect Claude Desktop to your financial data via MCP.
        </p>

        {loading ? (
          <p style={styles.muted}>Loading…</p>
        ) : apiKey ? (
          <>
            <div style={styles.keyBox}>
              <code style={styles.keyText}>{apiKey}</code>
              <button style={styles.copyBtn} onClick={() => handleCopy(apiKey)}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <button style={styles.regenerateBtn} onClick={handleGenerate} disabled={generating}>
              {generating ? "Regenerating…" : "Regenerate Key"}
            </button>
          </>
        ) : (
          <button style={styles.generateBtn} onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating…" : "Generate API Key"}
          </button>
        )}
      </section>

      {/* Claude.ai URL */}
      {sseUrl && (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Claude.ai MCP URL</h2>
          <p style={styles.description}>
            Go to <strong>claude.ai → Settings → Integrations</strong> and paste this URL to connect FinApp.
          </p>
          <div style={styles.keyBox}>
            <code style={styles.keyText}>{sseUrl}</code>
            <button style={styles.copyBtn} onClick={() => handleCopy(sseUrl)}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </section>
      )}

      {/* Claude Desktop config */}
      {mcpConfig && (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Claude Desktop Config</h2>
          <p style={styles.description}>
            Add this to your <code style={styles.inlineCode}>~/Library/Application Support/Claude/claude_desktop_config.json</code> under the top-level object, then restart Claude Desktop.
          </p>
          <div style={styles.configBox}>
            <pre style={styles.configText}>{mcpConfig}</pre>
            <button style={styles.copyBtn} onClick={() => handleCopy(mcpConfig)}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </section>
      )}
      {/* CSV Import */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Import from Simplifi</h2>
        <p style={styles.description}>
          In Simplifi, go to <strong>Transactions → Export</strong> and download the CSV. Select it below to import your real transactions while Plaid approval is pending.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button style={styles.generateBtn} onClick={() => fileRef.current?.click()}>
          Select CSV File
        </button>

        {parsed && (
          <div style={styles.importPreview}>
            <p style={styles.previewText}>
              Found <strong>{parsed.length}</strong> transactions
              {parsed.filter((r) => r.excluded).length > 0 && (
                <> · <span style={{ color: "var(--muted)" }}>{parsed.filter((r) => r.excluded).length} marked as excluded (transfers/internal)</span></>
              )}
            </p>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={skipExcluded}
                onChange={(e) => setSkipExcluded(e.target.checked)}
                style={{ marginRight: 8 }}
              />
              Skip excluded transactions
            </label>
            <p style={styles.previewCount}>
              Will import: <strong>{skipExcluded ? parsed.filter((r) => !r.excluded).length : parsed.length}</strong> transactions
            </p>
            <button style={styles.generateBtn} onClick={handleImport} disabled={importing}>
              {importing ? "Importing…" : "Import Now"}
            </button>
          </div>
        )}

        {importResult && (
          <p style={styles.importSuccess}>{importResult}</p>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <p style={styles.muted}>Previously imported Simplifi data can be cleared here before re-importing.</p>
          <button style={styles.regenerateBtn} onClick={handleClear} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear Imported Data"}
          </button>
        </div>
      </section>

      {/* Deduplication */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Deduplicate Transactions</h2>
        <p style={styles.description}>
          Finds transactions with the same date and amount that appear more than once — common when Simplifi imports and Plaid syncs overlap. Keeps the best copy (Plaid-native over Simplifi) and removes the rest.
        </p>

        <button style={styles.generateBtn} onClick={handleDedupePreview} disabled={previewing || deduping}>
          {previewing ? "Scanning…" : "Scan for Duplicates"}
        </button>

        {dupePreview && (
          <div style={styles.dupeBox}>
            {dupePreview.toRemove === 0 ? (
              <p style={styles.muted}>No duplicates found.</p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "var(--text)", marginBottom: 10 }}>
                  Found <strong>{dupePreview.toRemove}</strong> duplicate row{dupePreview.toRemove !== 1 ? "s" : ""} across <strong>{dupePreview.groups}</strong> transaction group{dupePreview.groups !== 1 ? "s" : ""}.
                </p>
                <div style={styles.dupeTable}>
                  <div style={styles.dupeHeader}>
                    <span>Date</span><span>Amount</span><span>Keep</span><span>Remove</span>
                  </div>
                  {(dupePreview.preview || []).map((d, i) => (
                    <div key={i} style={styles.dupeRow}>
                      <span style={styles.dupeCell}>{d.date}</span>
                      <span style={styles.dupeCell}>${d.amount.toFixed(2)}</span>
                      <span style={{ ...styles.dupeCell, color: "var(--green, #22c55e)", fontSize: 11 }}>{d.keep}</span>
                      <span style={{ ...styles.dupeCell, color: "var(--red, #ef4444)", fontSize: 11 }}>{d.remove.join(", ")}</span>
                    </div>
                  ))}
                </div>
                {dupePreview.groups > 20 && (
                  <p style={{ ...styles.muted, marginTop: 8 }}>Showing first 20 of {dupePreview.groups} groups.</p>
                )}
                <button style={{ ...styles.generateBtn, marginTop: 14 }} onClick={handleDedupe} disabled={deduping}>
                  {deduping ? "Removing…" : `Remove ${dupePreview.toRemove} Duplicate${dupePreview.toRemove !== 1 ? "s" : ""}`}
                </button>
              </>
            )}
          </div>
        )}

        {dupeResult && <p style={styles.importSuccess}>{dupeResult}</p>}
      </section>
    </div>
  );
}

const styles = {
  container: { padding: "40px 48px", maxWidth: 720 },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 32, color: "var(--text)" },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 24,
    marginBottom: 20,
  },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 },
  row: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" },
  label: { color: "var(--muted)", fontSize: 14 },
  value: { color: "var(--text)", fontSize: 14, fontWeight: 500 },
  description: { color: "var(--muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.6 },
  muted: { color: "var(--muted)", fontSize: 13 },
  keyBox: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 14px",
    marginBottom: 12,
  },
  keyText: { flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", wordBreak: "break-all" },
  generateBtn: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  regenerateBtn: {
    background: "none",
    color: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 16px",
    fontWeight: 500,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  copyBtn: {
    background: "var(--surface2)",
    color: "var(--text)",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    fontFamily: "var(--font-display)",
  },
  configBox: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 16,
    position: "relative",
  },
  configText: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  inlineCode: { fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--surface2)", padding: "1px 4px", borderRadius: 4 },
  importPreview: { marginTop: 16, padding: 16, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 },
  previewText: { fontSize: 13, color: "var(--text)", marginBottom: 10 },
  previewCount: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "8px 0 12px" },
  checkLabel: { display: "flex", alignItems: "center", fontSize: 13, color: "var(--text)", cursor: "pointer" },
  importSuccess: { marginTop: 12, fontSize: 13, color: "var(--green, #22c55e)", fontFamily: "var(--font-mono)" },
  dupeBox: { marginTop: 16, padding: 16, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 },
  dupeTable: { borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" },
  dupeHeader: {
    display: "grid", gridTemplateColumns: "90px 90px 1fr 1fr",
    padding: "6px 10px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
  },
  dupeRow: {
    display: "grid", gridTemplateColumns: "90px 90px 1fr 1fr",
    padding: "6px 10px", borderTop: "1px solid var(--border)",
    alignItems: "center",
  },
  dupeCell: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 },
};
