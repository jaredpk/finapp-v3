import React, { useState, useEffect, useRef } from "react";
import { previewHealthEquity, importHealthEquity } from "../api.js";

const DEFAULT_ACCOUNT = "HealthEquity HSA";
const HE_RE = /health\s*equity/i;

const money = (n) =>
  "$" + Math.abs(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// FileReader.readAsDataURL avoids building a giant binary string by hand.
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

export default function HealthEquityImport({ onClose, onImported }) {
  const [account, setAccount] = useState(DEFAULT_ACCOUNT);
  const [file, setFile] = useState(null);
  const [b64, setB64] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); // preview or import in flight
  const busyRef = useRef(false);
  const fileRef = useRef(null);
  const dialogRef = useRef(null);

  const accountOk = HE_RE.test(account);
  const importedRef = useRef(false);

  function close() {
    if (busyRef.current) return;
    onClose(importedRef.current);
  }

  useEffect(() => { fileRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function run(fn) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message || "Something went wrong"); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function runPreview(f, data, acct) {
    setPreview(null);
    setPreview(await previewHealthEquity(data, f.name, acct));
  }

  function onFile(e) {
    const f = e.target.files?.[0];
    setPreview(null);
    setResult(null);
    setError(null);
    if (!f) { setFile(null); setB64(null); return; }
    setFile(f);
    if (!accountOk) { setB64(null); return; }
    run(async () => {
      const data = await readBase64(f);
      setB64(data);
      await runPreview(f, data, account.trim());
    });
  }

  function onPreviewClick() {
    if (!file || !accountOk) return;
    run(async () => {
      const data = b64 ?? await readBase64(file);
      setB64(data);
      await runPreview(file, data, account.trim());
    });
  }

  function onImport() {
    if (!preview || !preview.new_rows || result) return;
    run(async () => {
      const res = await importHealthEquity(b64, file.name, account.trim());
      importedRef.current = true;
      setResult(res);
    });
  }

  const n = preview?.new_rows ?? 0;

  return (
    <div style={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="he-import-title" style={styles.modal}>
        <div style={styles.header}>
          <h2 id="he-import-title" style={styles.title}>Import HealthEquity file</h2>
          <button type="button" aria-label="Close" onClick={close} disabled={busy} style={styles.closeBtn}>×</button>
        </div>

        {result ? (
          <>
            <div style={styles.success} role="status">
              Imported {result.inserted}, {result.already_imported} already there. Contributions and interest were filed
              under Transfer. Card transactions are uncategorized — review them on the Transactions page.
            </div>
            <div style={styles.footer}>
              <button type="button" onClick={close} style={styles.confirmBtn}>Close</button>
            </div>
          </>
        ) : (
          <>
            <label style={styles.field}>
              HealthEquity export file
              <input
                ref={fileRef}
                type="file"
                accept=".xls,.xlsx,.csv,.html"
                onChange={onFile}
                disabled={busy}
                style={styles.input}
              />
            </label>
            <label style={styles.field}>
              Account name
              <input
                type="text"
                value={account}
                onChange={(e) => { setAccount(e.target.value); setPreview(null); }}
                disabled={busy}
                aria-invalid={!accountOk}
                style={styles.input}
              />
            </label>
            {!accountOk && (
              <div style={styles.fieldError}>Account name must contain "HealthEquity" so the month-end check can find it.</div>
            )}
            <div>
              <button type="button" onClick={onPreviewClick} disabled={busy || !file || !accountOk} style={styles.cancelBtn}>
                {busy && !preview ? "Working…" : "Preview"}
              </button>
            </div>

            {error && <div role="alert" style={styles.errorBox}>{error}</div>}

            {preview && (
              <div style={styles.summary}>
                <p style={styles.summaryLine}><b>{preview.filename}</b></p>
                <p style={styles.summaryLine}>
                  {preview.total_rows} rows found · {preview.new_rows} new · {preview.already_imported} already imported
                </p>
                {preview.skipped.length > 0 && (
                  <p style={styles.summaryLine}>
                    Skipped: {preview.skipped.map((s) => `${s.count} × ${s.reason}`).join("; ")}
                  </p>
                )}
                <p style={styles.summaryLine}>
                  Date range: {preview.date_range.from ?? "—"} to {preview.date_range.to ?? "—"}
                </p>
                <p style={styles.summaryLine}>Money out: {money(preview.totals.spend)}</p>
                <p style={styles.summaryLine}>Contributions: {money(preview.totals.contributions)}</p>
                <p style={styles.summaryLine}>Interest: {money(preview.totals.interest)}</p>
                {preview.by_month.length > 0 && (
                  <ul style={styles.months}>
                    {preview.by_month.map((m) => (
                      <li key={m.month} style={styles.summaryLine}>{m.month}: {m.count}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div style={styles.footer}>
              <button type="button" onClick={close} disabled={busy} style={styles.cancelBtn}>Cancel</button>
              {preview && (
                <button type="button" onClick={onImport} disabled={busy || n === 0} style={{ ...styles.confirmBtn, opacity: busy || n === 0 ? 0.6 : 1 }}>
                  {busy ? "Importing…" : n === 0 ? "Nothing new to import" : `Import ${n} new transaction${n === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
  },
  modal: {
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16,
    padding: "28px 28px", width: "90%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto",
    display: "flex", flexDirection: "column", gap: 16,
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)", margin: 0 },
  closeBtn: {
    background: "none", border: "none", color: "var(--muted)", fontSize: 24, lineHeight: 1,
    cursor: "pointer", padding: "0 4px",
  },
  field: { display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  input: {
    padding: "7px 10px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)",
  },
  fieldError: { fontSize: 12, color: "var(--red)", fontFamily: "var(--font-mono)", marginTop: -8 },
  errorBox: {
    padding: "10px 14px", background: "var(--surface)", border: "1px solid var(--red)",
    borderRadius: "var(--radius)", color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)",
  },
  success: {
    padding: "12px 14px", background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13, lineHeight: 1.5,
  },
  summary: { background: "var(--surface2)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 },
  summaryLine: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", margin: 0 },
  months: { listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 2 },
  footer: { display: "flex", justifyContent: "flex-end", gap: 10 },
  cancelBtn: {
    padding: "8px 20px", background: "none", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 13, cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  confirmBtn: {
    padding: "8px 24px", background: "var(--accent)", border: "none",
    borderRadius: "var(--radius)", color: "#fff", fontSize: 13, fontWeight: 600,
    cursor: "pointer", fontFamily: "var(--font-display)",
  },
};
