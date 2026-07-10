import React, { useRef, useState } from "react";
import { uploadPropertyWorkbook } from "../../api.js";

const fmt = (n) => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

// Upload a historical-ledger workbook (one tab per year), preview what each
// year tab parses to, pick years, and commit. Live years are unchecked by
// default so a Plaid-fed current year isn't overwritten with sheet rows.
export default function ImportSpreadsheetPanel({ propertyId, onImported }) {
  const fileRef = useRef(null);
  const [fileBase64, setFileBase64] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [preview, setPreview] = useState(null);
  const [checkedYears, setCheckedYears] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setPreview(null);
    setBusy(true);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setFileBase64(b64);
      setFileName(file.name);
      const res = await uploadPropertyWorkbook(propertyId, { fileBase64: b64, mode: "preview" });
      if (res.error) { setError(res.error); return; }
      setPreview(res.preview);
      const checks = {};
      res.preview.forEach((p) => { checks[p.year] = !p.isLive; });
      setCheckedYears(checks);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleCommit() {
    const years = Object.entries(checkedYears).filter(([, on]) => on).map(([y]) => Number(y));
    if (years.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadPropertyWorkbook(propertyId, { fileBase64, mode: "commit", years });
      if (res.error) { setError(res.error); return; }
      setResult(res.batches);
      setPreview(null);
      setFileBase64(null);
      onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Import Spreadsheet</h2>
      <p style={styles.description}>
        Upload the yearly ledger workbook (one tab per year, e.g. "Condo Rents 2024"). You'll see a preview per year before anything is saved. Re-importing a year updates rows in place rather than duplicating them.
      </p>

      <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ display: "none" }} />
      <button style={styles.uploadBtn} onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy && !preview ? "Reading…" : "Choose workbook (.xlsx)"}
      </button>
      {fileName && !result && <span style={styles.fileName}>{fileName}</span>}

      {preview && (
        <>
          <div style={styles.table}>
            <div style={{ ...styles.row, ...styles.headerRow }}>
              <span style={styles.cellCheck} />
              <span style={styles.cellYear}>Year</span>
              <span style={styles.cellNum}>Txns</span>
              <span style={styles.cellNum}>Income</span>
              <span style={styles.cellNum}>Expenses</span>
              <span style={styles.cellNum}>Review</span>
              <span style={styles.cellNote} />
            </div>
            {preview.map((p) => (
              <label key={p.year} style={styles.row}>
                <span style={styles.cellCheck}>
                  <input
                    type="checkbox"
                    checked={!!checkedYears[p.year]}
                    onChange={(e) => setCheckedYears((prev) => ({ ...prev, [p.year]: e.target.checked }))}
                  />
                </span>
                <span style={{ ...styles.cellYear, fontWeight: 700 }}>{p.year}</span>
                <span style={styles.cellNum}>{p.transactionCount}</span>
                <span style={{ ...styles.cellNum, color: "var(--green, #22c55e)" }}>{fmt(p.income)}</span>
                <span style={{ ...styles.cellNum, color: "var(--red, #ef4444)" }}>{fmt(p.expenses)}</span>
                <span style={styles.cellNum}>{p.reviewCount || "—"}</span>
                <span style={styles.cellNote}>
                  {p.isLive ? "live year — skipped by default" : p.alreadyExists ? "exists — re-import updates" : ""}
                </span>
              </label>
            ))}
          </div>
          <button style={styles.commitBtn} onClick={handleCommit} disabled={busy || Object.values(checkedYears).every((v) => !v)}>
            {busy ? "Importing…" : `Import ${Object.values(checkedYears).filter(Boolean).length} year(s)`}
          </button>
        </>
      )}

      {result && (
        <p style={styles.success}>
          Imported {result.reduce((s, b) => s + b.imported, 0)} transactions across {result.length} year(s)
          {result.some((b) => b.reviewCount > 0) && ` — ${result.reduce((s, b) => s + b.reviewCount, 0)} row(s) need review below`}.
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 8 },
  description: { fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 },
  uploadBtn: { padding: "8px 14px", background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  fileName: { marginLeft: 10, fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  table: { marginTop: 14, border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border)", cursor: "pointer" },
  headerRow: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", cursor: "default" },
  cellCheck: { width: 24, flexShrink: 0 },
  cellYear: { width: 50, fontFamily: "var(--font-mono)", fontSize: 13 },
  cellNum: { width: 90, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12 },
  cellNote: { flex: 1, fontSize: 11, color: "var(--muted)", textAlign: "right" },
  commitBtn: { marginTop: 12, padding: "9px 16px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  success: { marginTop: 12, fontSize: 13, color: "var(--green, #22c55e)" },
  error: { marginTop: 12, fontSize: 13, color: "var(--red, #ef4444)" },
};
