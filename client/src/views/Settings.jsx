import React, { useState, useEffect, useRef } from "react";
import { getApiKey, generateApiKey, analyzeSimplifi, importSimplifi, previewDuplicates, runDeduplication, debugDuplicates, fetchProperties, saveProperty, deletePropertyApi, syncPropertiesApi, setPropertyBaselineApi, fetchManualAccounts, saveManualAccount, deleteManualAccountApi, downloadXlsx, saveAccountNickname, deleteAccountNicknameApi, getLastAudit, uploadAuditSheet, insertAuditTransactions, completeAudit, fetchImportedAccounts, clearImportedTransactions, fetchVehicles, saveVehicle, deleteVehicleApi, setVehicleBaselineApi, syncVehiclesApi, fetchLinkedInstitutions, removeLinkedInstitution } from "../api.js";

export default function Settings({ reloadData, user, accounts = [] }) {
  // Connected banks state
  const [institutions, setInstitutions] = useState([]);
  const [removingInstitution, setRemovingInstitution] = useState(null);
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Simplifi import state
  const simplifiFileRef = useRef(null);
  const [simplifiFileName, setSimplifiFileName] = useState(null);
  const [simplifiCsvText, setSimplifiCsvText] = useState(null);
  const [simplifiAnalyzing, setSimplifiAnalyzing] = useState(false);
  const [simplifiAnalysis, setSimplifiAnalysis] = useState(null);
  const [simplifiMappings, setSimplifiMappings] = useState({});
  const [simplifiAccountMappings, setSimplifiAccountMappings] = useState({});
  const [simplifiImporting, setSimplifiImporting] = useState(false);
  const [simplifiResult, setSimplifiResult] = useState(null);

  // Properties state
  const [properties, setProperties]         = useState([]);
  const [propsLoading, setPropsLoading]     = useState(true);
  const [newAddr, setNewAddr]               = useState("");
  const [newNick, setNewNick]               = useState("");
  const [addingProp, setAddingProp]         = useState(false);
  const [syncingProps, setSyncingProps]     = useState(false);
  const [propResult, setPropResult]         = useState(null);
  const [editingProperty, setEditingProperty] = useState(null); // { id, value, msa }
  const [savingBaseline, setSavingBaseline] = useState(false);

  // Manual accounts state
  const [manualAccounts, setManualAccounts]   = useState([]);
  const [manualLoading, setManualLoading]     = useState(true);
  const [newAcctName, setNewAcctName]         = useState("");
  const [newAcctInst, setNewAcctInst]         = useState("");
  const [newAcctBal, setNewAcctBal]           = useState("");
  const [addingAcct, setAddingAcct]           = useState(false);
  const [acctResult, setAcctResult]           = useState(null);
  const [editingAcct, setEditingAcct]         = useState(null); // { id, balance }

  // Vehicles state
  const [vehicles, setVehicles]           = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [newVehYear, setNewVehYear]       = useState("");
  const [newVehMake, setNewVehMake]       = useState("");
  const [newVehModel, setNewVehModel]     = useState("");
  const [newVehTrim, setNewVehTrim]       = useState("");
  const [newVehNick, setNewVehNick]       = useState("");
  const [addingVeh, setAddingVeh]         = useState(false);
  const [vehResult, setVehResult]         = useState(null);
  const [syncingVeh, setSyncingVeh]       = useState(false);
  const [editingVehicle, setEditingVehicle] = useState(null); // { id, value, rate }

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Account nickname state — keyed by account_id
  const [nicknames, setNicknames] = useState({});
  const [savingNick, setSavingNick] = useState({});

  // Audit state
  const auditFileRef = useRef(null);
  const [auditFileName, setAuditFileName] = useState(null);
  const [auditBase64, setAuditBase64]     = useState(null);
  const [auditUploading, setAuditUploading] = useState(false);
  const [auditResult, setAuditResult]     = useState(null);
  const [checkedAuditIds, setCheckedAuditIds] = useState(new Set());
  const [auditInserting, setAuditInserting]   = useState(false);
  const [auditInsertResult, setAuditInsertResult] = useState(null);
  const [auditCompleting, setAuditCompleting] = useState(false);
  const [lastAudit, setLastAudit]         = useState(null);

  // Clear imported transactions state
  const [clearing, setClearing]             = useState(false);
  const [clearResult, setClearResult]       = useState(null);
  const [clearOpen, setClearOpen]           = useState(false);
  const [clearAccounts, setClearAccounts]   = useState(null); // null = not loaded yet
  const [clearSelected, setClearSelected]   = useState(new Set());
  const [clearTyped, setClearTyped]         = useState("");

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
    fetchManualAccounts().then((data) => { setManualAccounts(data.accounts || []); setManualLoading(false); });
    fetchVehicles().then((data) => { setVehicles(data.vehicles || []); setVehiclesLoading(false); });
    getLastAudit().then(({ log }) => setLastAudit(log || null)).catch(() => {});
    fetchLinkedInstitutions().then((data) => setInstitutions(data.institutions || [])).catch(() => {});
  }, []);

  async function removeInstitution(itemId, institutionName) {
    if (!window.confirm(`Remove ${institutionName}? You can reconnect at any time.`)) return;
    setRemovingInstitution(itemId);
    try {
      await removeLinkedInstitution(itemId);
      setInstitutions((prev) => prev.filter((i) => i.itemId !== itemId));
      reloadData?.();
    } finally {
      setRemovingInstitution(null);
    }
  }

  // Seed nickname inputs from current account names whenever accounts load
  useEffect(() => {
    if (!accounts.length) return;
    setNicknames((prev) => {
      const next = { ...prev };
      for (const a of accounts) {
        if (!(a.account_id in next)) next[a.account_id] = a.name;
      }
      return next;
    });
  }, [accounts]);

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

  // ── Simplifi import ───────────────────────────────────────────────────────────
  function handleSimplifiFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setSimplifiFileName(file.name);
    setSimplifiAnalysis(null);
    setSimplifiResult(null);
    setSimplifiMappings({});
    setSimplifiAccountMappings({});
    file.text().then(setSimplifiCsvText);
  }

  async function handleSimplifiAnalyze() {
    if (!simplifiCsvText) return;
    setSimplifiAnalyzing(true);
    setSimplifiAnalysis(null);
    try {
      const res = await analyzeSimplifi(simplifiCsvText, accounts);
      if (res.error) { setSimplifiResult(`Error: ${res.error}`); return; }
      const catDraft = {};
      for (const c of res.unmappedCategories) catDraft[c.name] = c.suggestedId || "__DEFER__";
      const acctDraft = {};
      for (const a of res.unmappedAccounts) acctDraft[a.name] = a.suggestedId || "__DEFER__";
      setSimplifiMappings(catDraft);
      setSimplifiAccountMappings(acctDraft);
      setSimplifiAnalysis(res);
    } catch (err) {
      setSimplifiResult(`Error: ${err.message}`);
    } finally {
      setSimplifiAnalyzing(false);
    }
  }

  async function handleSimplifiImport() {
    if (!simplifiCsvText) return;
    setSimplifiImporting(true);
    setSimplifiResult(null);
    try {
      const newMappings = {};
      for (const [cat, id] of Object.entries(simplifiMappings)) {
        if (id !== "__DEFER__") newMappings[cat] = id || null;
      }
      const newAccountMappings = {};
      for (const [acct, id] of Object.entries(simplifiAccountMappings)) {
        if (id !== "__DEFER__") newAccountMappings[acct] = id || null;
      }
      const res = await importSimplifi(simplifiCsvText, newMappings, newAccountMappings);
      if (res.error) { setSimplifiResult(`Error: ${res.error}`); return; }
      const parts = [];
      if (res.inserted) parts.push(`${res.inserted} new transaction${res.inserted !== 1 ? "s" : ""} imported`);
      if (res.categorized) parts.push(`${res.categorized} transaction${res.categorized !== 1 ? "s" : ""} categorized`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      setSimplifiResult((parts.length ? parts.join(" · ") : "Nothing new to process") + ".");
      setSimplifiFileName(null);
      setSimplifiCsvText(null);
      setSimplifiAnalysis(null);
      if (simplifiFileRef.current) simplifiFileRef.current.value = "";
      if (reloadData) reloadData();
    } catch (err) {
      setSimplifiResult(`Error: ${err.message}`);
    } finally {
      setSimplifiImporting(false);
    }
  }

  // ── Manual accounts ──────────────────────────────────────────────────────────
  async function handleAddManualAccount() {
    if (!newAcctName.trim() || !newAcctBal.trim()) return;
    setAddingAcct(true);
    setAcctResult(null);
    try {
      const res = await saveManualAccount(null, newAcctName.trim(), newAcctInst.trim(), "retirement", parseFloat(newAcctBal));
      if (res.error) { setAcctResult(`Error: ${res.error}`); return; }
      setManualAccounts((prev) => [...prev, res.account]);
      setNewAcctName(""); setNewAcctInst(""); setNewAcctBal("");
      if (reloadData) reloadData();
    } finally { setAddingAcct(false); }
  }

  async function handleUpdateBalance(id) {
    const bal = parseFloat(editingAcct.balance);
    if (isNaN(bal)) return;
    const existing = manualAccounts.find((a) => a.id === id);
    const res = await saveManualAccount(id, existing.name, existing.institution, existing.subtype, bal);
    if (res.error) { setAcctResult(`Error: ${res.error}`); return; }
    setManualAccounts((prev) => prev.map((a) => (a.id === id ? res.account : a)));
    setEditingAcct(null);
    if (reloadData) reloadData();
  }

  async function handleDeleteManualAccount(id) {
    await deleteManualAccountApi(id);
    setManualAccounts((prev) => prev.filter((a) => a.id !== id));
    if (reloadData) reloadData();
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

  async function handleSetBaseline(id) {
    if (!editingProperty || editingProperty.id !== id) return;
    const { value, msa } = editingProperty;
    if (!value) return;
    setSavingBaseline(true);
    setPropResult(null);
    try {
      const res = await setPropertyBaselineApi(id, parseFloat(value), msa ? parseInt(msa) : undefined);
      if (res.error) { setPropResult(`Error: ${res.error}`); return; }
      setProperties((prev) => prev.map((p) => (p.id === id ? res.property : p)));
      setEditingProperty(null);
      if (reloadData) reloadData();
    } finally {
      setSavingBaseline(false);
    }
  }

  // ── Vehicles ──────────────────────────────────────────────────────────────────
  async function handleAddVehicle() {
    if (!newVehMake.trim() || !newVehModel.trim()) return;
    setAddingVeh(true);
    setVehResult(null);
    try {
      const res = await saveVehicle(null, newVehYear ? parseInt(newVehYear) : null, newVehMake.trim(), newVehModel.trim(), newVehTrim.trim(), newVehNick.trim());
      if (res.error) { setVehResult(`Error: ${res.error}`); return; }
      setVehicles((prev) => [...prev, res.vehicle]);
      setNewVehYear(""); setNewVehMake(""); setNewVehModel(""); setNewVehTrim(""); setNewVehNick("");
      if (reloadData) reloadData();
    } finally { setAddingVeh(false); }
  }

  async function handleDeleteVehicle(id) {
    await deleteVehicleApi(id);
    setVehicles((prev) => prev.filter((v) => v.id !== id));
    if (reloadData) reloadData();
  }

  async function handleSetVehicleBaseline(id) {
    if (!editingVehicle || editingVehicle.id !== id) return;
    const { value, rate } = editingVehicle;
    if (!value) return;
    setSyncingVeh(true);
    setVehResult(null);
    try {
      const depRate = rate ? parseFloat(rate) / 100 : 0.15;
      const res = await setVehicleBaselineApi(id, parseFloat(value), depRate);
      if (res.error) { setVehResult(`Error: ${res.error}`); return; }
      setVehicles((prev) => prev.map((v) => (v.id === id ? res.vehicle : v)));
      setEditingVehicle(null);
      if (reloadData) reloadData();
    } catch (err) {
      setVehResult(`Error: ${err.message}`);
    } finally { setSyncingVeh(false); }
  }

  async function handleSyncVehicles() {
    setSyncingVeh(true);
    setVehResult(null);
    try {
      const res = await syncVehiclesApi();
      const updated = await fetchVehicles();
      setVehicles(updated.vehicles || []);
      setVehResult(`Refreshed ${res.synced} vehicle value${res.synced !== 1 ? "s" : ""}.`);
      if (reloadData) reloadData();
    } finally { setSyncingVeh(false); }
  }

  // ── Clear imported transactions ───────────────────────────────────────────────
  async function handleOpenClear() {
    setClearOpen(true);
    setClearResult(null);
    setClearTyped("");
    setClearAccounts(null);
    const res = await fetchImportedAccounts();
    const accts = res.accounts || [];
    setClearAccounts(accts);
    setClearSelected(new Set(accts.map(a => a.account)));
  }

  function handleClearToggle(account) {
    setClearSelected(prev => {
      const next = new Set(prev);
      next.has(account) ? next.delete(account) : next.add(account);
      return next;
    });
  }

  async function handleClearImported() {
    if (clearTyped !== "CLEAR") return;
    setClearing(true);
    setClearResult(null);
    try {
      const selected = [...clearSelected];
      const res = await clearImportedTransactions(selected.length < clearAccounts.length ? selected : null);
      setClearResult(`Deleted ${res.deleted} imported transaction${res.deleted !== 1 ? "s" : ""}. Plaid data untouched.`);
      setClearOpen(false);
      setClearAccounts(null);
      setClearSelected(new Set());
      setClearTyped("");
      if (reloadData) reloadData();
    } catch (err) {
      setClearResult(`Error: ${err.message}`);
    } finally {
      setClearing(false);
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

  async function handleSaveNickname(account_id, originalName) {
    const nickname = (nicknames[account_id] ?? "").trim();
    setSavingNick((p) => ({ ...p, [account_id]: true }));
    try {
      if (!nickname || nickname === originalName) {
        await deleteAccountNicknameApi(account_id);
      } else {
        await saveAccountNickname(account_id, nickname);
      }
      await reloadData();
    } finally {
      setSavingNick((p) => ({ ...p, [account_id]: false }));
    }
  }

  // ── Audit ────────────────────────────────────────────────────────────────────
  function handleAuditFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setAuditFileName(file.name);
    setAuditResult(null);
    setAuditInsertResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const bytes = new Uint8Array(ev.target.result);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      setAuditBase64(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleRunAudit() {
    if (!auditBase64) return;
    setAuditUploading(true);
    setAuditInsertResult(null);
    try {
      const res = await uploadAuditSheet(auditBase64, auditFileName);
      if (res.error) {
        setAuditResult({ error: `Error: ${res.error}` });
      } else {
        setAuditResult(res);
        setCheckedAuditIds(new Set((res.missing || []).map(t => t.transaction_id)));
      }
    } catch (err) {
      setAuditResult({ error: `Error: ${err.message}` });
    } finally {
      setAuditUploading(false);
    }
  }

  function toggleAuditTxn(id) {
    setCheckedAuditIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAllAudit(e) {
    if (e.target.checked) {
      setCheckedAuditIds(new Set((auditResult?.missing || []).map(t => t.transaction_id)));
    } else {
      setCheckedAuditIds(new Set());
    }
  }

  async function handleAuditInsert() {
    if (!auditResult || checkedAuditIds.size === 0) return;
    setAuditInserting(true);
    try {
      const toInsert = auditResult.missing.filter(t => checkedAuditIds.has(t.transaction_id));
      const res = await insertAuditTransactions(auditResult.auditId, toInsert);
      if (res.error) {
        setAuditInsertResult(`Error: ${res.error}`);
      } else {
        setAuditInsertResult(`Inserted ${res.inserted} transaction${res.inserted !== 1 ? "s" : ""} successfully.`);
        const remaining = auditResult.missing.filter(t => !checkedAuditIds.has(t.transaction_id));
        setAuditResult(prev => ({ ...prev, missing: remaining, missingCount: remaining.length }));
        setCheckedAuditIds(new Set());
        setLastAudit(prev => prev ? { ...prev, inserted_count: (prev.inserted_count || 0) + res.inserted } : prev);
        if (reloadData) reloadData();
      }
    } catch (err) {
      setAuditInsertResult(`Error: ${err.message}`);
    } finally {
      setAuditInserting(false);
    }
  }

  async function handleAuditComplete() {
    if (!auditResult?.auditId) return;
    setAuditCompleting(true);
    try {
      await completeAudit(auditResult.auditId, auditResult.dateRange.end);
      const { log } = await getLastAudit();
      setLastAudit(log || null);
      setAuditResult(null);
      setAuditFileName(null);
      setAuditBase64(null);
      setAuditInsertResult(null);
      if (auditFileRef.current) auditFileRef.current.value = "";
    } finally {
      setAuditCompleting(false);
    }
  }

  async function handleExportXlsx() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadXlsx();
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  }

  const auditOverdue = !lastAudit || ((Date.now() - new Date(lastAudit.audit_date).getTime()) / 86400000 > 14);

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

      {/* Connected Banks */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Connected Banks</h2>
        <p style={styles.description}>
          Remove a linked institution to disconnect it and start fresh. Transactions already synced are not deleted.
        </p>
        {institutions.length === 0 ? (
          <p style={styles.muted}>No institutions linked yet.</p>
        ) : (
          <div>
            {institutions.map((inst) => (
              <div style={styles.propRow} key={inst.itemId}>
                <p style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                  {inst.institutionName || inst.itemId}
                </p>
                <button
                  style={styles.deleteBtn}
                  disabled={removingInstitution === inst.itemId}
                  onClick={() => removeInstitution(inst.itemId, inst.institutionName)}
                >
                  {removingInstitution === inst.itemId ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Audit */}
      <section style={styles.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <h2 style={{ ...styles.cardTitle, marginBottom: 0 }}>Audit Transactions</h2>
          {auditOverdue && <span style={styles.auditBadge}>{lastAudit ? "Audit needed" : "Never audited"}</span>}
        </div>
        {lastAudit ? (
          <p style={styles.description}>
            Last audit: <strong>{new Date(lastAudit.audit_date).toLocaleDateString()}</strong>
            {lastAudit.range_start && lastAudit.range_end && (
              <span style={{ color: "var(--muted)" }}> ({lastAudit.range_start} – {lastAudit.range_end})</span>
            )}
            {" "}· {lastAudit.total_in_sheet?.toLocaleString()} in sheet
            · {lastAudit.missing_count} missing
            · {lastAudit.inserted_count || 0} inserted
            {lastAudit.completed_at
              ? <span style={{ color: "var(--green, #22c55e)" }}> · ✓ completed</span>
              : <span style={{ color: "var(--red, #ef4444)" }}> · not completed</span>}
          </p>
        ) : (
          <p style={styles.description}>No audit has been run yet.</p>
        )}
        <p style={styles.description}>
          Upload your <strong>Personal Finances.xlsx</strong> from Quadratic to compare its Plaid transactions
          against what's in the app. Missing transactions are shown for review — select any to insert them.
        </p>
        <input ref={auditFileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={handleAuditFileChange} />
        <button style={styles.generateBtn} onClick={() => { auditFileRef.current?.click(); }}>Select Audit Sheet</button>
        {auditFileName && !auditResult && (
          <div style={styles.importPreview}>
            <p style={styles.previewText}>Ready: <strong>{auditFileName}</strong></p>
            <button style={styles.generateBtn} onClick={handleRunAudit} disabled={auditUploading}>
              {auditUploading ? "Analyzing…" : "Run Audit"}
            </button>
          </div>
        )}
        {auditResult && (
          <div style={styles.dupeBox}>
            {auditResult.error ? (
              <p style={styles.importError}>{auditResult.error}</p>
            ) : auditResult.missingCount === 0 ? (
              <p style={styles.importSuccess}>
                All {auditResult.totalInSheet?.toLocaleString()} transactions accounted for — no gaps found.
              </p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "var(--text)", marginBottom: 10 }}>
                  <strong>{auditResult.missingCount}</strong> missing out of{" "}
                  <strong>{auditResult.totalInSheet?.toLocaleString()}</strong> in sheet
                  {auditResult.dateRange?.start && (
                    <span style={{ color: "var(--muted)" }}>
                      {" "}({auditResult.dateRange.start} – {auditResult.dateRange.end})
                    </span>
                  )}.
                </p>
                <div style={styles.dupeTable}>
                  <div style={{ ...styles.dupeHeader, gridTemplateColumns: "28px 95px 90px 1fr 80px" }}>
                    <span>
                      <input
                        type="checkbox"
                        checked={checkedAuditIds.size === auditResult.missing.length && auditResult.missing.length > 0}
                        onChange={toggleAllAudit}
                      />
                    </span>
                    <span>Date</span>
                    <span>Source</span>
                    <span>Merchant</span>
                    <span style={{ textAlign: "right" }}>Amount</span>
                  </div>
                  {auditResult.missing.map((t) => (
                    <div
                      key={t.transaction_id}
                      style={{ ...styles.dupeRow, gridTemplateColumns: "28px 95px 90px 1fr 80px", opacity: checkedAuditIds.has(t.transaction_id) ? 1 : 0.45 }}
                    >
                      <input
                        type="checkbox"
                        checked={checkedAuditIds.has(t.transaction_id)}
                        onChange={() => toggleAuditTxn(t.transaction_id)}
                        style={{ cursor: "pointer" }}
                      />
                      <span style={styles.dupeCell}>{t.date}</span>
                      <span style={{ ...styles.dupeCell, fontSize: 10, color: "var(--muted)" }}>{t.source}</span>
                      <span style={styles.dupeCell}>{t.merchant_name || t.name || "—"}</span>
                      <span style={{ ...styles.dupeCell, textAlign: "right", color: t.amount > 0 ? "var(--red, #ef4444)" : "var(--green, #22c55e)" }}>
                        {t.amount > 0 ? `$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  style={{ ...styles.generateBtn, marginTop: 14, opacity: checkedAuditIds.size === 0 ? 0.45 : 1 }}
                  onClick={handleAuditInsert}
                  disabled={auditInserting || checkedAuditIds.size === 0}
                >
                  {auditInserting
                    ? "Inserting…"
                    : `Insert ${checkedAuditIds.size} Selected Transaction${checkedAuditIds.size !== 1 ? "s" : ""}`}
                </button>
              </>
            )}
            {auditResult.debug && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", cursor: "pointer" }}>Debug info</summary>
                <pre style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--muted)", marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {JSON.stringify(auditResult.debug, null, 2)}
                </pre>
              </details>
            )}
            {auditInsertResult && (
              <p style={auditInsertResult.startsWith("Error") ? styles.importError : styles.importSuccess}>
                {auditInsertResult}
              </p>
            )}
            {!auditResult?.error && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
                <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
                  When you're done reviewing, mark this audit complete. Future audits will start from{" "}
                  <strong>{auditResult?.dateRange?.end}</strong> onward and all transactions through that date will be tagged as audited.
                </p>
                <button
                  style={styles.generateBtn}
                  onClick={handleAuditComplete}
                  disabled={auditCompleting}
                >
                  {auditCompleting ? "Completing…" : "Mark Audit Complete"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Manual Accounts */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Manual Accounts</h2>
        <p style={styles.description}>
          Add accounts that can't connect via Plaid (e.g. Paychex Flex retirement). Enter the <strong>vested balance only</strong> — unvested funds aren't yours yet. Update the balance manually whenever you check the account.
        </p>
        {manualLoading ? (
          <p style={styles.muted}>Loading…</p>
        ) : (
          <>
            {manualAccounts.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {manualAccounts.map((a) => (
                  <div key={a.id} style={styles.propRow}>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>{a.name}</p>
                      <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                        {a.institution ? `${a.institution} · ` : ""}{a.subtype} · ${parseFloat(a.balance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (vested)
                      </p>
                      <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                        Updated {new Date(a.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {editingAcct?.id === a.id ? (
                        <>
                          <input
                            style={{ ...styles.propInput, width: 130, marginTop: 0 }}
                            type="number"
                            step="0.01"
                            value={editingAcct.balance}
                            onChange={(e) => setEditingAcct({ id: a.id, balance: e.target.value })}
                          />
                          <button style={styles.generateBtn} onClick={() => handleUpdateBalance(a.id)}>Save</button>
                          <button style={styles.regenerateBtn} onClick={() => setEditingAcct(null)}>Cancel</button>
                        </>
                      ) : (
                        <button style={styles.regenerateBtn} onClick={() => setEditingAcct({ id: a.id, balance: a.balance })}>Update Balance</button>
                      )}
                      <button style={styles.deleteBtn} onClick={() => handleDeleteManualAccount(a.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={styles.propForm}>
              <input style={styles.propInput} placeholder="Account name (e.g. Paychex 401k)" value={newAcctName} onChange={(e) => setNewAcctName(e.target.value)} />
              <input style={{ ...styles.propInput, marginTop: 8 }} placeholder="Institution (e.g. Paychex Flex)" value={newAcctInst} onChange={(e) => setNewAcctInst(e.target.value)} />
              <input style={{ ...styles.propInput, marginTop: 8 }} placeholder="Vested balance (e.g. 42500.00)" type="number" step="0.01" value={newAcctBal} onChange={(e) => setNewAcctBal(e.target.value)} />
              <button style={{ ...styles.generateBtn, marginTop: 10 }} onClick={handleAddManualAccount} disabled={addingAcct || !newAcctName.trim() || !newAcctBal.trim()}>
                {addingAcct ? "Adding…" : "Add Account"}
              </button>
            </div>
            {acctResult && (
              <p style={acctResult.startsWith("Error") ? styles.importError : styles.importSuccess}>{acctResult}</p>
            )}
          </>
        )}
      </section>

      {/* Properties */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Properties</h2>
        <p style={styles.description}>
          Enter a verified Zillow estimate once a year. Between updates, values drift automatically using the{" "}
          <a href="https://www.fhfa.gov/data/hpi" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>FHFA House Price Index</a>{" "}
          for your metro area.
        </p>
        {propsLoading ? (
          <p style={styles.muted}>Loading…</p>
        ) : (
          <>
            {properties.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {properties.map((p) => (
                  <div key={p.id} style={{ ...styles.propRow, flexDirection: "column", alignItems: "flex-start" }}>
                    <div style={{ display: "flex", width: "100%", alignItems: "flex-start", gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                          {p.nickname || p.address}
                        </p>
                        {p.nickname && (
                          <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>{p.address}</p>
                        )}
                        <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                          {p.last_value != null
                            ? `$${parseFloat(p.last_value).toLocaleString("en-US", { maximumFractionDigits: 0 })} · updated ${p.last_synced_at ? new Date(p.last_synced_at).toLocaleDateString() : "never"}`
                            : "No value set — click Update Value to add a Zillow estimate"}
                        </p>
                        {p.baseline_value != null && (
                          <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                            {`Zillow baseline: $${parseFloat(p.baseline_value).toLocaleString("en-US", { maximumFractionDigits: 0 })} · ${p.baseline_date ? new Date(p.baseline_date).toLocaleDateString() : ""} · MSA ${p.fhfa_msa}`}
                          </p>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                        {editingProperty?.id !== p.id && (
                          <button style={styles.regenerateBtn} onClick={() => setEditingProperty({ id: p.id, value: "", msa: p.fhfa_msa ? String(p.fhfa_msa) : "" })}>
                            Update Value
                          </button>
                        )}
                        <button style={styles.deleteBtn} onClick={() => handleDeleteProperty(p.id)}>Remove</button>
                      </div>
                    </div>
                    {editingProperty?.id === p.id && (
                      <div style={{ marginTop: 10, width: "100%" }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <input
                            style={{ ...styles.propInput, width: 180 }}
                            type="number"
                            placeholder="Zillow estimate (e.g. 669000)"
                            value={editingProperty.value}
                            onChange={(e) => setEditingProperty((prev) => ({ ...prev, value: e.target.value }))}
                          />
                          <input
                            style={{ ...styles.propInput, width: 130 }}
                            placeholder="MSA code (e.g. 41620)"
                            value={editingProperty.msa}
                            onChange={(e) => setEditingProperty((prev) => ({ ...prev, msa: e.target.value }))}
                          />
                        </div>
                        {!p.fhfa_msa && (
                          <p style={{ fontSize: 11, color: "var(--muted)", margin: "6px 0 0" }}>
                            Find your MSA code at{" "}
                            <a href="https://www.fhfa.gov/data/hpi" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>fhfa.gov/data/hpi</a>
                            {" "}→ All-Transactions MSA spreadsheet.
                          </p>
                        )}
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button
                            style={styles.generateBtn}
                            onClick={() => handleSetBaseline(p.id)}
                            disabled={savingBaseline || !editingProperty.value || (!p.fhfa_msa && !editingProperty.msa)}
                          >
                            {savingBaseline ? "Saving…" : "Save"}
                          </button>
                          <button style={styles.regenerateBtn} onClick={() => setEditingProperty(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
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
                  {syncingProps ? "Refreshing…" : "Refresh FHFA Drift"}
                </button>
              </div>
            )}
            {propResult && (
              <p style={propResult.startsWith("Error") ? styles.importError : styles.importSuccess}>{propResult}</p>
            )}
          </>
        )}
      </section>

      {/* Vehicles */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Vehicles</h2>
        <p style={styles.description}>
          Enter a KBB Private Party estimate to seed the value. Between updates, the value drifts automatically using a standard depreciation rate (default 15%/yr).
        </p>
        {vehiclesLoading ? (
          <p style={styles.muted}>Loading…</p>
        ) : (
          <>
            {vehicles.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {vehicles.map((v) => {
                  const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
                  return (
                    <div key={v.id} style={{ ...styles.propRow, flexDirection: "column", alignItems: "flex-start" }}>
                      <div style={{ display: "flex", width: "100%", alignItems: "flex-start", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                            {v.nickname || label}
                          </p>
                          {v.nickname && <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>{label}</p>}
                          <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                            {v.last_value != null
                              ? `$${parseFloat(v.last_value).toLocaleString("en-US", { maximumFractionDigits: 0 })} · updated ${v.last_synced_at ? new Date(v.last_synced_at).toLocaleDateString() : "never"}`
                              : "No value — click Update KBB Value"}
                          </p>
                          {v.baseline_value != null && (
                            <p style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", margin: "2px 0 0" }}>
                              {`KBB baseline: $${parseFloat(v.baseline_value).toLocaleString("en-US", { maximumFractionDigits: 0 })} · ${v.baseline_date ? new Date(v.baseline_date).toLocaleDateString() : ""} · ${Math.round((v.depreciation_rate ?? 0.15) * 100)}%/yr`}
                            </p>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                          {editingVehicle?.id !== v.id && (
                            <button style={styles.regenerateBtn} onClick={() => setEditingVehicle({ id: v.id, value: "", rate: String(Math.round((v.depreciation_rate ?? 0.15) * 100)) })}>
                              Update KBB Value
                            </button>
                          )}
                          <button style={styles.deleteBtn} onClick={() => handleDeleteVehicle(v.id)}>Remove</button>
                        </div>
                      </div>
                      {editingVehicle?.id === v.id && (
                        <div style={{ marginTop: 10, width: "100%" }}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input
                              style={{ ...styles.propInput, width: 190 }}
                              type="number"
                              placeholder="KBB Private Party value"
                              value={editingVehicle.value}
                              onChange={(e) => setEditingVehicle((p) => ({ ...p, value: e.target.value }))}
                            />
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                style={{ ...styles.propInput, width: 70 }}
                                type="number"
                                placeholder="15"
                                min="0"
                                max="50"
                                step="1"
                                value={editingVehicle.rate}
                                onChange={(e) => setEditingVehicle((p) => ({ ...p, rate: e.target.value }))}
                              />
                              <span style={{ fontSize: 12, color: "var(--muted)" }}>%/yr depreciation</span>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                            <button
                              style={styles.generateBtn}
                              onClick={() => handleSetVehicleBaseline(v.id)}
                              disabled={syncingVeh || !editingVehicle.value}
                            >
                              {syncingVeh ? "Saving…" : "Save"}
                            </button>
                            <button style={styles.regenerateBtn} onClick={() => setEditingVehicle(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={styles.propForm}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ ...styles.propInput, width: 70 }} placeholder="Year" type="number" value={newVehYear} onChange={(e) => setNewVehYear(e.target.value)} />
                <input style={{ ...styles.propInput, flex: 1, minWidth: 100 }} placeholder="Make (e.g. Toyota)" value={newVehMake} onChange={(e) => setNewVehMake(e.target.value)} />
                <input style={{ ...styles.propInput, flex: 1, minWidth: 100 }} placeholder="Model (e.g. Camry)" value={newVehModel} onChange={(e) => setNewVehModel(e.target.value)} />
              </div>
              <input style={{ ...styles.propInput, marginTop: 8 }} placeholder="Trim (optional, e.g. XSE V6)" value={newVehTrim} onChange={(e) => setNewVehTrim(e.target.value)} />
              <input style={{ ...styles.propInput, marginTop: 8 }} placeholder="Nickname (optional, e.g. Jared's Car)" value={newVehNick} onChange={(e) => setNewVehNick(e.target.value)} />
              <button style={{ ...styles.generateBtn, marginTop: 10 }} onClick={handleAddVehicle} disabled={addingVeh || !newVehMake.trim() || !newVehModel.trim()}>
                {addingVeh ? "Adding…" : "Add Vehicle"}
              </button>
            </div>
            {vehicles.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                <button style={styles.regenerateBtn} onClick={handleSyncVehicles} disabled={syncingVeh}>
                  {syncingVeh ? "Refreshing…" : "Refresh Depreciation"}
                </button>
              </div>
            )}
            {vehResult && (
              <p style={vehResult.startsWith("Error") ? styles.importError : styles.importSuccess}>{vehResult}</p>
            )}
          </>
        )}
      </section>

      {/* Account Nicknames */}
      {accounts.length > 0 && (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Account Names</h2>
          <p style={styles.description}>Give any account a friendly display name. Leave blank or match the original to revert.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            {accounts.map((a) => {
              const original = a.official_name || a.name;
              const isDirty = (nicknames[a.account_id] ?? a.name) !== a.name;
              return (
                <div key={a.account_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: "0 0 160px", fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={original}>
                    {original}
                  </div>
                  <input
                    style={{ ...styles.nickInput, flex: 1 }}
                    value={nicknames[a.account_id] ?? a.name}
                    onChange={(e) => setNicknames((p) => ({ ...p, [a.account_id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveNickname(a.account_id, original)}
                    placeholder={original}
                  />
                  <button
                    style={{ ...styles.generateBtn, padding: "6px 14px", fontSize: 12, opacity: isDirty ? 1 : 0.4 }}
                    onClick={() => handleSaveNickname(a.account_id, original)}
                    disabled={savingNick[a.account_id]}
                  >
                    {savingNick[a.account_id] ? "…" : "Save"}
                  </button>
                  {a.balances?.current != null && (
                    <div style={{ flex: "0 0 90px", fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", textAlign: "right", whiteSpace: "nowrap" }}>
                      ${a.balances.current.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Excel Export */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Export to Excel</h2>
        <p style={styles.description}>
          Download your current account balances, investment holdings, and transactions as an <strong>.xlsx</strong> file — in the same format used for import. Use this to prompt Perplexity to regenerate an updated spreadsheet.
        </p>
        <button style={styles.generateBtn} onClick={handleExportXlsx} disabled={exporting}>
          {exporting ? "Exporting…" : "Download Excel File"}
        </button>
        {exportError && (
          <p style={styles.importError}>Error: {exportError}</p>
        )}
      </section>

      {/* Simplifi Import */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Import from Simplifi</h2>
        <p style={styles.description}>
          Upload a <strong>Quicken Simplifi CSV</strong> export. Transactions for accounts not yet on Plaid (like MACU Shared Checking) are inserted as new. All others are matched by date and amount to apply categories to existing uncategorized transactions. Category mappings are saved — you'll only be asked once per new category.
        </p>
        <input ref={simplifiFileRef} type="file" accept=".csv,.CSV" style={{ display: "none" }} onChange={handleSimplifiFileChange} />
        <button style={styles.generateBtn} onClick={() => simplifiFileRef.current?.click()}>Select Simplifi CSV</button>
        {simplifiFileName && !simplifiAnalysis && (
          <div style={styles.importPreview}>
            <p style={styles.previewText}>Ready: <strong>{simplifiFileName}</strong></p>
            <button style={styles.generateBtn} onClick={handleSimplifiAnalyze} disabled={simplifiAnalyzing}>
              {simplifiAnalyzing ? "Analyzing…" : "Analyze"}
            </button>
          </div>
        )}
        {simplifiAnalysis && (
          <div style={styles.dupeBox}>
            <p style={{ fontSize: 13, color: "var(--text)", marginBottom: 14 }}>
              <strong>{simplifiAnalysis.totalRows}</strong> rows to process.
            </p>

            {simplifiAnalysis.unmappedCategories.length > 0 && (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                  New categories ({simplifiAnalysis.unmappedCategories.length})
                </p>
                <p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
                  <em>Defer</em> = ask again next upload &nbsp;·&nbsp; <em>Skip</em> = never categorize, don't ask again
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
                  {simplifiAnalysis.unmappedCategories.map(c => (
                    <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ flex: "0 0 190px", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>→</span>
                      <select
                        style={{ flex: 1, ...styles.propInput, padding: "6px 10px" }}
                        value={simplifiMappings[c.name] ?? "__DEFER__"}
                        onChange={e => setSimplifiMappings(p => ({ ...p, [c.name]: e.target.value }))}
                      >
                        <option value="__DEFER__">Defer (ask next upload)</option>
                        <option value="">Skip permanently (don't categorize)</option>
                        <option disabled>──────────────</option>
                        {simplifiAnalysis.finappCategories.map(fc => (
                          <option key={fc.id} value={fc.id}>{fc.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </>
            )}

            {simplifiAnalysis.unmappedAccounts.length > 0 && (
              <>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                  New accounts ({simplifiAnalysis.unmappedAccounts.length})
                </p>
                <p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
                  <em>Defer</em> = ask again next upload &nbsp;·&nbsp; <em>Skip</em> = keep Simplifi name, don't ask again
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
                  {simplifiAnalysis.unmappedAccounts.map(a => (
                    <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ flex: "0 0 190px", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>→</span>
                      <select
                        style={{ flex: 1, ...styles.propInput, padding: "6px 10px" }}
                        value={simplifiAccountMappings[a.name] ?? "__DEFER__"}
                        onChange={e => setSimplifiAccountMappings(p => ({ ...p, [a.name]: e.target.value }))}
                      >
                        <option value="__DEFER__">Defer (ask next upload)</option>
                        <option value="">Skip (keep Simplifi name, don't ask again)</option>
                        <option disabled>──────────────</option>
                        {simplifiAnalysis.finappAccounts.filter(fa => fa.source === 'plaid').length > 0 && (
                          <option disabled>— Plaid accounts —</option>
                        )}
                        {simplifiAnalysis.finappAccounts.filter(fa => fa.source === 'plaid').map(fa => (
                          <option key={fa.account_id} value={fa.account_id}>
                            {fa.name}{fa.official_name && fa.official_name !== fa.name ? ` [${fa.official_name}]` : ''}{fa.mask ? ` ····${fa.mask}` : ''} · {fa.subtype || fa.type}{fa.institutionName ? ` · ${fa.institutionName}` : ''}
                          </option>
                        ))}
                        {simplifiAnalysis.finappAccounts.filter(fa => fa.source === 'manual').length > 0 && (
                          <option disabled>— Manual accounts —</option>
                        )}
                        {simplifiAnalysis.finappAccounts.filter(fa => fa.source === 'manual').map(fa => (
                          <option key={fa.account_id} value={fa.account_id}>{fa.name} ({fa.type})</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </>
            )}

            {simplifiAnalysis.unmappedCategories.length === 0 && simplifiAnalysis.unmappedAccounts.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>All categories and accounts already mapped — ready to import.</p>
            )}

            <button style={styles.generateBtn} onClick={handleSimplifiImport} disabled={simplifiImporting}>
              {simplifiImporting ? "Importing…" : "Confirm Import"}
            </button>
          </div>
        )}
        {simplifiResult && (
          <p style={simplifiResult.startsWith("Error") ? styles.importError : styles.importSuccess}>
            {simplifiResult}
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

      {/* Clear imported transactions */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Clear Imported Transactions</h2>
        <p style={styles.description}>
          Removes Simplifi-imported transactions by account. Plaid-synced transactions, house values, account balances, and investment holdings are <strong>not</strong> affected.
        </p>
        {!clearOpen ? (
          <button style={{ ...styles.generateBtn, background: "var(--red, #ef4444)" }} onClick={handleOpenClear}>
            Clear Imported Transactions…
          </button>
        ) : (
          <div style={styles.dupeBox}>
            {clearAccounts === null ? (
              <p style={styles.muted}>Loading accounts…</p>
            ) : clearAccounts.length === 0 ? (
              <p style={styles.muted}>No imported transactions found.</p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "var(--text)", marginBottom: 12 }}>
                  Select which accounts to clear:
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
                  {clearAccounts.map(a => (
                    <label key={a.account} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={clearSelected.has(a.account)}
                        onChange={() => handleClearToggle(a.account)}
                      />
                      <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{a.account}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                        {parseInt(a.count).toLocaleString()} txns · {a.earliest?.slice(0, 10)} – {a.latest?.slice(0, 10)}
                      </span>
                    </label>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                  Type <strong style={{ fontFamily: "var(--font-mono)", color: "var(--red, #ef4444)" }}>CLEAR</strong> to confirm deletion of{" "}
                  <strong>{clearAccounts.filter(a => clearSelected.has(a.account)).reduce((s, a) => s + parseInt(a.count), 0).toLocaleString()}</strong> transactions:
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    style={{ ...styles.propInput, width: 120, fontFamily: "var(--font-mono)", letterSpacing: "0.1em" }}
                    placeholder="CLEAR"
                    value={clearTyped}
                    onChange={e => setClearTyped(e.target.value.toUpperCase())}
                  />
                  <button
                    style={{ ...styles.generateBtn, background: clearTyped === "CLEAR" && clearSelected.size > 0 ? "var(--red, #ef4444)" : undefined, opacity: clearTyped === "CLEAR" && clearSelected.size > 0 ? 1 : 0.4 }}
                    onClick={handleClearImported}
                    disabled={clearing || clearTyped !== "CLEAR" || clearSelected.size === 0}
                  >
                    {clearing ? "Deleting…" : "Delete Selected"}
                  </button>
                  <button style={styles.regenerateBtn} onClick={() => setClearOpen(false)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
        {clearResult && (
          <p style={clearResult.startsWith("Error") ? styles.importError : styles.importSuccess}>{clearResult}</p>
        )}
      </section>

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
  nickInput: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 12px", fontSize: 13, color: "var(--text)", fontFamily: "var(--font-display)", outline: "none" },
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
  auditBadge: { fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", color: "#fff", background: "var(--red, #ef4444)", borderRadius: "var(--radius)", padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 },
};
