import React, { useState, useEffect, useRef } from "react";
import { getApiKey, generateApiKey, importXlsx, previewDuplicates, runDeduplication, debugDuplicates, fetchProperties, saveProperty, deletePropertyApi, syncPropertiesApi } from "../api.js";

export default function Settings({ reloadData, user }) {
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Excel (xlsx) import state
  const xlsxFileRef = useRef(null);
  const [xlsxFileName, setXlsxFileName] = useState(null);
  const [xlsxBase64, setXlsxBase64] = useState(null);
  const [xlsxImporting, setXlsxImporting] = useState(false);
  const [xlsxImportResult, setXlsxImportResult] = useState(null);

  // Properties state
  const [properties, setProperties]     = useState([]);
  const [propsLoading, setPropsLoading] = useState(true);
  const [newAddr, setNewAddr]           = useState("");
  const [newNick, setNewNick]           = useState("");
  const [addingProp, setAddingProp]     = useState(false);
  const [syncingProps, setSyncingProps] = useState(false);
  const [propResult, setPropResult]     = useState(null);

  // Dedup state
  const [deduping, setDeduping]         = useState(false);
  const [dupePreview, setDupePreview]   = useState(null);
  const [dupeResult, setDupeResult]     = useState(null);
  const [previewing, setPreviewing]     = useState(false);
  const [checkedDupes, setCheckedDupes] = useState(new Set());
  const [debugData, setDebugData]       = useState(null);
  const [debugging, setDebugging]       = useState(false);

  useEffect(() => {
    getApiKey().then((data) => { setApiKey(data.key || null); setLoading(false); });
    fetchProperties().then((data) => { setProperties(data.properties || []); setPropsLoading(false); });
  }, []);

  // ── API key ──────────────────────────────────────────────────────────────────
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

  // ── XLSX import ───────────────────────────────────────────────────────────────
  function handleXlsxFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setXlsxFileName(file.name);
    setXlsxImportResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const bytes = new Uint8Array(ev.target.result);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      setXlsxBase64(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleXlsxImport() {
    if (!xlsxBase64) return;
    setXlsxImporting(true);
    try {
      const res = await importXlsx(xlsxBase64);
      if (res.error) {
        setXlsxImportResult(`Error: ${res.error}`);
      } else {
        const parts = [`Imported ${res.imported} transaction${res.imported !== 1 ? "s" : ""}`];
        if (res.skipped)  parts.push(`${res.skipped} skipped (already in Plaid)`);
        if (res.balances) parts.push(`${res.balances} account balances`);
        if (res.holdings) parts.push(`${res.holdings} investment holdings`);
        setXlsxImportResult(parts.join(" · ") + ".");
        setXlsxFileName(null);
        setXlsxBase64(null);
        if (xlsxFileRef.current) xlsxFileRef.current.value = "";
        if (reloadData) reloadData();
      }
    } catch (err) {
      setXlsxImportResult(`Error: ${err.message}`);
    } finally {
      setXlsxImporting(false);
    }
  }

  // ── Properties ────────────────────────────────────────────────────────────────
  async function handleAddProperty() {
    if (!newAddr.trim()) return;
    setAddingProp(true);
    setPropResult(null);
    try {
      const res = await saveProperty(null, newAddr.trim(), newNick.trim());
      if (res.error) { setPropResult(`Error: ${res.error}`); return; }
      setProperties((prev) => [...prev, res.property]);
      setNewAddr("");
      setNewNick("");
      if (reloadData) reloadData();
    } finally {
      setAddingProp(false);
    }
  }

  async function handleDeleteProperty(id) {
    await deletePropertyApi(id);
    setProperties((prev) => prev.filter((p) => p.id !== id));
    if (reloadData) reloadData();
  }

  async function handleSyncProperties() {
    setSyncingProps(true);
    setPropResult(null);
    try {
      const res = await syncPropertiesApi();
      if (res.error) { setPropResult(`Error: ${res.error}`); return; }
      const updated = await fetchProperties();
      setProperties(updated.properties || []);
      const failures = (res.results || []).filter((r) => !r.ok);
      if (failures.length) {
        setPropResult(`Synced ${res.synced}. Errors: ${failures.map((f) => `${f.address}: ${f.error}`).join(" | ")}`);
      } else {
        setPropResult(`Synced ${res.synced} property value${res.synced !== 1 ? "s" : ""}.`);
      }
      if (reloadData) reloadData();
    } finally {
      setSyncingProps(false);
    }
  }

  // ── Dedup ─────────────────────────────────────────────────────────────────────
  async function handleDedupePreview() {
    setPreviewing(true);
    setDupeResult(null);
    try {
      const res = await previewDuplicates();
      setDupePreview(res);
      setCheckedDupes(new Set((res.preview || []).map((_, i) => i)));
    } finally {
      setPreviewing(false);
    }
  }

  function toggleDupe(i) {
    setCheckedDupes((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  async function handleDedupe() {
    setDeduping(true);
    try {
      const selected = (dupePreview.preview || []).filter((_, i) => checkedDupes.has(i));
      const res = await runDeduplication(selected);
      setDupeResult(`Removed ${res.deleted} duplicate transaction${res.deleted !== 1 ? "s" : ""}.`);
      setDupePreview(null);
      if (reloadData) reloadData();
    } finally {
      setDeduping(false);
    }
  }

  async function handleDebug() {
    setDebugging(true);
    try { setDebugData(await debugDuplicates()); }
    finally { setDebugging(false); }
  }

  const sseUrl = apiKey ? `${window.location.origin}/sse?key=${apiKey}` : null;
  const mcpConfig = apiKey ? JSON.stringify({
    mcpServers: { finapp: { command: "npx", args: ["-y", "mcp-remote", `${window.location.origin}/mcp`, "--header", `x-api-key:${apiKey}`] } },
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

      {/* Properties */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Properties</h2>
        <p style={styles.description}>
          Add your properties to include their Rentcast estimates in net worth. Values refresh automatically every 30 days.
        </p>
        {propsLoading ? (
          <p style={styles.muted}>Loading…</p>
        ) : (
          <>
            {properties.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {properties.map((p) => (
                  <div key={p.id} style={styles.propRow}>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                        {p.nickname || p.address}
                      </p>
                      {p.nickname && <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>{p.address}</p>}
                      <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                        {p.last_value != null
                          ? `$${parseFloat(p.last_value).toLocaleString("en-US", { maximumFractionDigits: 0 })} · synced ${p.last_synced_at ? new Date(p.last_synced_at).toLocaleDateString() : "never"}`
                          : "Not yet synced"}
                      </p>
                    </div>
                    <button style={styles.deleteBtn} onClick={() => handleDeleteProperty(p.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
            <div style={styles.propForm}>
              <input style={styles.propInput} placeholder="Full address (e.g. 123 Main St, Salt Lake City, UT 84101)" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} />
              <input style={{ ...styles.propInput, marginTop: 8 }} placeholder="Nickname (optional, e.g. Primary Home)" value={newNick} onChange={(e) => setNewNick(e.target.value)} />
              <button style={{ ...styles.generateBtn, marginTop: 10 }} onClick={handleAddProperty} disabled={addingProp || !newAddr.trim()}>
                {addingProp ? "Adding…" : "Add Property"}
              </button>
            </div>
            {properties.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                <button style={styles.regenerateBtn} onClick={handleSyncProperties} disabled={syncingProps}>
                  {syncingProps ? "Syncing…" : "Sync Values Now"}
                </button>
              </div>
            )}
            {propResult && (
              <p style={propResult.startsWith("Error") ? styles.importError : styles.importSuccess}>{propResult}</p>
            )}
          </>
        )}
      </section>

      {/* Excel Import */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Import from Excel</h2>
        <p style={styles.description}>
          Upload your <strong>.xlsx</strong> export with three tabs: <em>Account Balances</em>, <em>Investment Holdings</em>, and <em>Transactions</em>. Re-uploading is safe — transactions already in Plaid are skipped, and balance snapshots are replaced by date.
        </p>
        <input ref={xlsxFileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={handleXlsxFileChange} />
        <button style={styles.generateBtn} onClick={() => xlsxFileRef.current?.click()}>Select Excel File</button>
        {xlsxFileName && (
          <div style={styles.importPreview}>
            <p style={styles.previewText}>Ready to import: <strong>{xlsxFileName}</strong></p>
            <button style={styles.generateBtn} onClick={handleXlsxImport} disabled={xlsxImporting}>
              {xlsxImporting ? "Importing…" : "Import Now"}
            </button>
          </div>
        )}
        {xlsxImportResult && (
          <p style={xlsxImportResult.startsWith("Error") ? styles.importError : styles.importSuccess}>
            {xlsxImportResult}
          </p>
        )}
      </section>

      {/* API Key */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Claude Desktop API Key</h2>
        <p style={styles.description}>Use this key to connect Claude Desktop to your financial data via MCP.</p>
        {loading ? (
          <p style={styles.muted}>Loading…</p>
        ) : apiKey ? (
          <>
            <div style={styles.keyBox}>
              <code style={styles.keyText}>{apiKey}</code>
              <button style={styles.copyBtn} onClick={() => handleCopy(apiKey)}>{copied ? "Copied!" : "Copy"}</button>
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
            <button style={styles.copyBtn} onClick={() => handleCopy(sseUrl)}>{copied ? "Copied!" : "Copy"}</button>
          </div>
        </section>
      )}

      {/* Claude Desktop config */}
      {mcpConfig && (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Claude Desktop Config</h2>
          <p style={styles.description}>
            Add this to your <code style={styles.inlineCode}>~/Library/Application Support/Claude/claude_desktop_config.json</code> and restart Claude Desktop.
          </p>
          <div style={styles.configBox}>
            <pre style={styles.configText}>{mcpConfig}</pre>
            <button style={styles.copyBtn} onClick={() => handleCopy(mcpConfig)}>{copied ? "Copied!" : "Copy"}</button>
          </div>
        </section>
      )}

      {/* Deduplication */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Deduplicate Transactions</h2>
        <p style={styles.description}>
          Finds transactions with the same date and amount that appear more than once. Keeps the best copy and removes the rest.
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
                  Found <strong>{dupePreview.toRemove}</strong> duplicate row{dupePreview.toRemove !== 1 ? "s" : ""} across <strong>{dupePreview.groups}</strong> group{dupePreview.groups !== 1 ? "s" : ""}.
                </p>
                <div style={styles.dupeTable}>
                  <div style={{ ...styles.dupeHeader, gridTemplateColumns: "28px 90px 90px 1fr 1fr" }}>
                    <span></span><span>Date</span><span>Amount</span><span>Keep</span><span>Remove</span>
                  </div>
                  {(dupePreview.preview || []).map((d, i) => (
                    <div key={i} style={{ ...styles.dupeRow, gridTemplateColumns: "28px 90px 90px 1fr 1fr", opacity: checkedDupes.has(i) ? 1 : 0.4 }}>
                      <input type="checkbox" checked={checkedDupes.has(i)} onChange={() => toggleDupe(i)} style={{ cursor: "pointer" }} />
                      <span style={styles.dupeCell}>{d.date}</span>
                      <span style={styles.dupeCell}>${d.amount.toFixed(2)}</span>
                      <span style={{ ...styles.dupeCell, color: "var(--green, #22c55e)", fontSize: 11 }}>{d.keep}</span>
                      <span style={{ ...styles.dupeCell, color: "var(--red, #ef4444)", fontSize: 11 }}>{d.remove.join(", ")}</span>
                    </div>
                  ))}
                </div>
                <button style={{ ...styles.generateBtn, marginTop: 14 }} onClick={handleDedupe} disabled={deduping || checkedDupes.size === 0}>
                  {deduping ? "Removing…" : `Remove ${checkedDupes.size} of ${dupePreview.groups} Duplicate${checkedDupes.size !== 1 ? "s" : ""}`}
                </button>
              </>
            )}
          </div>
        )}
        {dupeResult && <p style={styles.importSuccess}>{dupeResult}</p>}
      </section>

      {/* Debug */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Duplicate Diagnostics</h2>
        <p style={styles.description}>Shows raw transaction ID formats and same-date/same-amount groups to help diagnose duplicates.</p>
        <button style={styles.regenerateBtn} onClick={handleDebug} disabled={debugging}>
          {debugging ? "Loading…" : "Run Diagnostic"}
        </button>
        {debugData && (
          <div style={{ marginTop: 16 }}>
            <p style={styles.muted}>
              Total: <strong>{debugData.idStats?.total}</strong> &nbsp;|&nbsp;
              Plaid IDs: <strong>{debugData.idStats?.plaid}</strong> &nbsp;|&nbsp;
              UUIDs: <strong>{debugData.idStats?.uuid}</strong> &nbsp;|&nbsp;
              Simplifi: <strong>{debugData.idStats?.simplifi}</strong>
            </p>
            <p style={{ ...styles.muted, marginTop: 8 }}>
              Same date+amount groups: <strong>{debugData.dupeRows?.length ?? 0}</strong>
            </p>
            {debugData.dupeRows?.length > 0 && (
              <div style={{ ...styles.dupeBox, marginTop: 8 }}>
                {debugData.dupeRows.map((r, i) => (
                  <div key={i} style={{ marginBottom: 10, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                    <strong>{r.date}</strong> ${parseFloat(r.abs_amount).toFixed(2)} ({r.cnt} rows)<br />
                    {r.ids.map((id, j) => (
                      <div key={j} style={{ paddingLeft: 12, color: id.startsWith("simplifi") ? "var(--red,#ef4444)" : "var(--green,#22c55e)" }}>
                        {id} — {r.merchants[j]} — acct: {r.accounts[j]} — amt: {r.amounts[j]}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <p style={{ ...styles.muted, marginTop: 12 }}>Recent transactions (newest first):</p>
            <div style={{ ...styles.dupeBox, marginTop: 4 }}>
              {debugData.sample?.map((t, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: "var(--muted)" }}>{t.date}</span> &nbsp;
                  <span style={{ color: t.id?.startsWith("simplifi") ? "var(--red,#ef4444)" : t.id?.match(/^[0-9a-f-]{36}$/) ? "var(--accent)" : "var(--green,#22c55e)" }}>
                    {t.id?.slice(0, 40)}
                  </span> &nbsp;
                  <span>{t.merchant}</span> &nbsp;
                  <span style={{ color: "var(--muted)" }}>${Math.abs(t.amount).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const styles = {
  container: { padding: "40px 48px", maxWidth: 720 },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 32, color: "var(--text)" },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 24, marginBottom: 20 },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 },
  row: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" },
  label: { color: "var(--muted)", fontSize: 14 },
  value: { color: "var(--text)", fontSize: 14, fontWeight: 500 },
  description: { color: "var(--muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.6 },
  muted: { color: "var(--muted)", fontSize: 13 },
  keyBox: { display: "flex", alignItems: "center", gap: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", marginBottom: 12 },
  keyText: { flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", wordBreak: "break-all" },
  generateBtn: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "var(--font-display)" },
  regenerateBtn: { background: "none", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 16px", fontWeight: 500, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-display)" },
  copyBtn: { background: "var(--surface2)", color: "var(--text)", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", flexShrink: 0, fontFamily: "var(--font-display)" },
  configBox: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 16, position: "relative" },
  configText: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  inlineCode: { fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--surface2)", padding: "1px 4px", borderRadius: 4 },
  importPreview: { marginTop: 16, padding: 16, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 },
  previewText: { fontSize: 13, color: "var(--text)", marginBottom: 10 },
  importSuccess: { marginTop: 12, fontSize: 13, color: "var(--green, #22c55e)", fontFamily: "var(--font-mono)" },
  importError:   { marginTop: 12, fontSize: 13, color: "var(--red, #ef4444)",   fontFamily: "var(--font-mono)" },
  dupeBox: { marginTop: 16, padding: 16, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 },
  dupeTable: { borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" },
  dupeHeader: { display: "grid", padding: "6px 10px", background: "var(--surface2)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  dupeRow: { display: "grid", padding: "6px 10px", borderTop: "1px solid var(--border)", alignItems: "center" },
  dupeCell: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 },
  propRow: { display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--border)" },
  propForm: { marginTop: 8 },
  propInput: { width: "100%", padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 13, fontFamily: "var(--font-display)", boxSizing: "border-box" },
  deleteBtn: { background: "none", color: "var(--red, #ef4444)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 },
};
