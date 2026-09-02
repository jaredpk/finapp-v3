import React, { useState, useMemo, useEffect } from "react";
import { saveAssignment, saveMerchantOverride, deleteTransaction, unhideTransactionApi, replaceSplitsApi, reviewTransactions, fetchTransactionStats } from "../api.js";
import { buildCsv, transactionCsvRows, csvFilename, downloadCsv, CSV_HEADERS } from "../csvExport.js";

const toNum = (n) => n == null ? null : parseFloat(n);

const fmt = (n) => {
  const v = toNum(n);
  if (v == null || isNaN(v)) return "—";
  return (v < 0 ? "+" : "-") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2 });
};

const fmtAbs = (n) => {
  const v = toNum(n);
  if (v == null || isNaN(v)) return "";
  return Math.abs(v).toFixed(2);
};

const fmtRound = (n) => {
  const v = toNum(n);
  if (v == null || isNaN(v)) return "—";
  return "$" + Math.round(Math.abs(v)).toLocaleString("en-US");
};

const fmtCount = (n) => (n ?? 0).toLocaleString("en-US");

const fmtDate = (d) => {
  if (!d) return "—";
  const s = typeof d === "string" ? d : d.toISOString();
  return s.slice(5, 10).replace("-", "/");
};

export default function Transactions({
  accounts,
  transactions,
  categories,
  assignments,
  merchantOverrides,
  splits,
  setSplits,
  hiddenAccounts,
  setAssignments,
  setMerchantOverrides,
  reloadData,
}) {
  const [search, setSearch]         = useState("");
  const [catFilter, setCatFilter]   = useState("all");
  const [acctFilter, setAcctFilter] = useState("all");
  const [minAmount, setMinAmount]   = useState("");
  const [maxAmount, setMaxAmount]   = useState("");
  const [sort, setSort]             = useState({ col: "date", dir: "desc" });
  const [datePreset, setDatePreset] = useState("all");
  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [reviewFilter, setReviewFilter] = useState(false);
  const [approving, setApproving]   = useState(false);
  const [saving, setSaving]         = useState({});
  const [editingMerchant, setEditingMerchant] = useState(null);
  const [merchantDraft, setMerchantDraft]     = useState("");
  const [confirmDelete, setConfirmDelete]     = useState(null);
  const [deleting, setDeleting]               = useState({});

  // Split editor state
  const [splitExpanded, setSplitExpanded] = useState(null);
  const [splitDraft, setSplitDraft]       = useState([]);
  const [splitSaving, setSplitSaving]     = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(null);

  const acctMap = useMemo(() => {
    const m = {};
    (accounts || []).forEach((a) => {
      m[a.account_id] = a.name || a.official_name || a.account_id;
    });
    return m;
  }, [accounts]);

  const acctIds = useMemo(() => {
    return [...new Set(transactions.map((t) => t.account_id).filter(Boolean))].sort();
  }, [transactions]);

  // id -> name, for the CSV export's Category column. The table itself never
  // needs this — its <select> renders the category list directly — but a CSV
  // has to carry the name, since a uuid is not a category to anyone reading
  // the file later.
  const categoryNames = useMemo(() => {
    const m = {};
    (categories || []).forEach((c) => { m[c.id] = c.name; });
    return m;
  }, [categories]);

  const getDisplayName = (t) =>
    merchantOverrides?.[t.transaction_id] || t.merchant_name || t.name || t.suggested_category || "Unknown";

  // What the loaded rows say. `transactions` is one capped page of the table
  // (/api/transactions returns the 2000 most recent by default), so this answers
  // "what am I holding", not "what exists". Still computed on every render: it
  // is the denominator for "showing X of Y" and the fallback when the totals
  // request fails.
  const loadedStats = useMemo(() => {
    const visible = transactions.filter(t => !t.hidden && !hiddenAccounts?.has(t.account_id));
    const spend = visible.filter((t) => toNum(t.amount) > 0).reduce((s, t) => s + toNum(t.amount), 0);
    const needsReview = visible.filter((t) => !assignments?.[t.transaction_id] && !splits?.[t.transaction_id]?.length).length;
    const needsApproval = visible.filter((t) => t.reviewed_at == null).length;
    return { total: visible.length, spend, needsReview, needsApproval };
  }, [transactions, assignments, splits, hiddenAccounts]);

  // What the table says. Same four figures, counted in SQL over every
  // transaction (and with the same hidden-row / hidden-account exclusions), so
  // the tiles stop presenting a page total as a total. Refetched whenever an
  // edit moves one of them: approving reloads `transactions`, categorising and
  // splitting change what counts as needing review.
  const [serverStats, setServerStats] = useState(null);
  const [statsFailed, setStatsFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTransactionStats()
      .then((res) => {
        if (cancelled) return;
        if (res?.error || res?.total == null) { setServerStats(null); setStatsFailed(true); }
        else { setServerStats(res); setStatsFailed(false); }
      })
      // A totals outage is a footnote, not a failure: the tiles drop back to the
      // loaded rows and say so, rather than emptying the page.
      .catch(() => { if (!cancelled) { setServerStats(null); setStatsFailed(true); } });
    return () => { cancelled = true; };
  }, [transactions, assignments, splits]);

  // Server figures when we have them, loaded-row figures until then and if the
  // request fails — in which case every tile carries a "(loaded)" label so no
  // capped number is ever shown as a total.
  const stats = serverStats ?? loadedStats;
  const statsArePartial = serverStats == null;
  const statLabel = (base) => (statsArePartial ? `${base} (loaded)` : base);

  const loadedCount = loadedStats.total;
  const notAllLoaded = serverStats != null && serverStats.total > loadedCount;

  // The approval chip and the "Approve all shown" button beside it answer two
  // different questions, and side by side they read as one. The chip carried
  // the server-wide needsApproval (91 with the whole table counted) while the
  // button acted on loaded rows (4), with nothing on screen or in the tooltip
  // marking the difference — and since the chip is also the list filter, it
  // showed a list of 4 under a control saying 91, then dropped to 87 after
  // approving with no account of where the other 87 went.
  //
  // So the chip shows both, subset first: "4 of 91" against "Approve all shown
  // (4)" makes the two 4s the same 4 and the 91 visibly something else. It is
  // also renamed off "Needs review", which the tile above already uses for a
  // different figure — the tile counts needsReview (no category, no splits),
  // the chip counts needsApproval (reviewed_at IS NULL). Same two words, two
  // numbers, one screen. The chip's name now matches the field behind it.
  const loadedNeedsApproval = loadedStats.needsApproval;
  const approvalChipLabel = serverStats
    ? `${fmtCount(loadedNeedsApproval)} of ${fmtCount(serverStats.needsApproval)}`
    : fmtCount(loadedNeedsApproval);
  const approvalChipTitle = serverStats
    ? `Filters the loaded rows down to transactions waiting for approval. ${fmtCount(loadedNeedsApproval)} of the ${fmtCount(serverStats.needsApproval)} awaiting approval across all transactions are among the ${fmtCount(loadedCount)} rows loaded here — this filter and "Approve all shown" reach only those. The rest are in older rows this page has not fetched and cannot be approved from this screen.`
    : `Filters the loaded rows down to transactions waiting for approval. Counted over the ${fmtCount(loadedCount)} rows loaded here, not over every transaction on record.`;

  function toggleSort(col) {
    setSort(prev => prev.col === col
      ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { col, dir: "desc" }
    );
  }

  const sortIcon = (col) => {
    if (sort.col !== col) return <span style={styles.sortNeutral}>⇅</span>;
    return <span style={styles.sortActive}>{sort.dir === "asc" ? "↑" : "↓"}</span>;
  };

  const effectiveDateRange = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    if (datePreset === "this_month") {
      const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const nextMonth = new Date(y, m + 1, 1);
      const to = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
      return { from, to };
    }
    if (datePreset === "last_month") {
      const lastMonth = new Date(y, m - 1, 1);
      const from = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}-01`;
      const to = `${y}-${String(m + 1).padStart(2, "0")}-01`;
      return { from, to };
    }
    if (datePreset === "this_year") return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
    if (datePreset === "last_year") return { from: `${y - 1}-01-01`, to: `${y}-01-01` };
    if (datePreset === "custom") return { from: dateFrom || null, to: dateTo || null };
    return { from: null, to: null };
  }, [datePreset, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const min = minAmount !== "" ? parseFloat(minAmount) : null;
    const max = maxAmount !== "" ? parseFloat(maxAmount) : null;
    const { from: dFrom, to: dTo } = effectiveDateRange;

    let rows = transactions.filter((t) => {
      if (!showHidden && t.hidden) return false;
      if (hiddenAccounts?.has(t.account_id)) return false;
      if (reviewFilter && t.reviewed_at != null) return false;
      const name = getDisplayName(t).toLowerCase();
      const amt = Math.abs(toNum(t.amount) ?? 0);
      if (search && !name.includes(search.toLowerCase())) return false;
      if (catFilter === "unassigned" && (assignments?.[t.transaction_id] || splits?.[t.transaction_id]?.length)) return false;
      if (catFilter !== "all" && catFilter !== "unassigned") {
        const directMatch = assignments?.[t.transaction_id] === catFilter;
        const splitMatch  = splits?.[t.transaction_id]?.some(s => s.category_id === catFilter);
        if (!directMatch && !splitMatch) return false;
      }
      if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
      if (min !== null && amt < min) return false;
      if (max !== null && amt > max) return false;
      if (dFrom && t.date < dFrom) return false;
      if (dTo && t.date >= dTo) return false;
      return true;
    });

    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (sort.col === "date") { av = a.date || ""; bv = b.date || ""; }
      else if (sort.col === "amount") { av = Math.abs(toNum(a.amount) ?? 0); bv = Math.abs(toNum(b.amount) ?? 0); }
      else if (sort.col === "merchant") { av = getDisplayName(a).toLowerCase(); bv = getDisplayName(b).toLowerCase(); }
      else if (sort.col === "account") {
        av = (acctMap[a.account_id] || a.account_id || "").toLowerCase();
        bv = (acctMap[b.account_id] || b.account_id || "").toLowerCase();
      } else { av = ""; bv = ""; }
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }, [transactions, search, catFilter, acctFilter, minAmount, maxAmount, sort, assignments, splits, merchantOverrides, acctMap, effectiveDateRange, showHidden, hiddenAccounts, reviewFilter]);

  async function handleApprove(ids) {
    if (!ids.length || approving) return;
    setApproving(true);
    try {
      const res = await reviewTransactions(ids);
      if (res.error) throw new Error(res.error);
      if (reloadData) reloadData();
    } catch (err) {
      console.error("Approve failed:", err);
    } finally {
      setApproving(false);
    }
  }

  async function handleCategoryChange(txnId, categoryId) {
    setSaving((prev) => ({ ...prev, [txnId]: true }));
    try {
      await saveAssignment(txnId, categoryId || null);
      setAssignments((prev) => ({ ...prev, [txnId]: categoryId || null }));
    } finally {
      setSaving((prev) => ({ ...prev, [txnId]: false }));
    }
  }

  async function commitMerchantRename(t) {
    const draft = merchantDraft.trim();
    if (draft && draft !== getDisplayName(t)) {
      await saveMerchantOverride(t.transaction_id, draft);
      setMerchantOverrides((prev) => ({ ...prev, [t.transaction_id]: draft }));
    }
    setEditingMerchant(null);
  }

  async function handleDelete(txnId) {
    setDeleting((p) => ({ ...p, [txnId]: true }));
    try {
      const result = await deleteTransaction(txnId);
      if (result.error) throw new Error(result.error);
      setConfirmDelete(null);
      if (reloadData) reloadData();
    } catch (err) {
      console.error("Hide failed:", err);
    } finally {
      setDeleting((p) => ({ ...p, [txnId]: false }));
    }
  }

  async function handleUnhide(txnId) {
    try {
      await unhideTransactionApi(txnId);
      if (reloadData) reloadData();
    } catch (err) {
      console.error("Unhide failed:", err);
    }
  }

  // ── Split editor ─────────────────────────────────────────────────────────────
  function openSplitEditor(t) {
    setDetailExpanded(null);
    const existing = splits?.[t.transaction_id] || [];
    if (existing.length > 0) {
      setSplitDraft(existing.map(s => ({
        category_id: s.category_id || "",
        amount: fmtAbs(s.amount),
        note: s.note || "",
      })));
    } else {
      const total = fmtAbs(t.amount);
      setSplitDraft([
        { category_id: assignments?.[t.transaction_id] || "", amount: total, note: "" },
        { category_id: "", amount: "", note: "" },
      ]);
    }
    setSplitExpanded(t.transaction_id);
  }

  function closeSplitEditor() {
    setSplitExpanded(null);
    setSplitDraft([]);
  }

  function toggleDetail(txnId) {
    setSplitExpanded(null);
    setSplitDraft([]);
    setDetailExpanded(prev => prev === txnId ? null : txnId);
  }

  // Recalculate line 0 to be total - sum(lines 1+) so splits stay balanced.
  function recalcLine0(draft) {
    const t = transactions.find(tx => tx.transaction_id === splitExpanded);
    if (!t || draft.length < 2) return draft;
    const total = Math.abs(parseFloat(t.amount) || 0);
    const otherSum = draft.slice(1).reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
    const remainder = Math.max(0, parseFloat((total - otherSum).toFixed(2)));
    return draft.map((row, i) => i === 0 ? { ...row, amount: remainder.toFixed(2) } : row);
  }

  function updateSplitLine(idx, field, value) {
    setSplitDraft(prev => {
      const draft = prev.map((row, i) => i === idx ? { ...row, [field]: value } : row);
      return (field === "amount" && idx > 0) ? recalcLine0(draft) : draft;
    });
  }

  function addSplitLine() {
    setSplitDraft(prev => recalcLine0([...prev, { category_id: "", amount: "", note: "" }]));
  }

  function removeSplitLine(idx) {
    setSplitDraft(prev => recalcLine0(prev.filter((_, i) => i !== idx)));
  }

  async function saveSplits(t) {
    const validSplits = splitDraft.filter(s => s.amount && parseFloat(s.amount) > 0);
    setSplitSaving(true);
    try {
      const result = await replaceSplitsApi(t.transaction_id, validSplits.map(s => ({
        category_id: s.category_id || null,
        amount: parseFloat(s.amount),
        note: s.note || null,
      })));
      const newSplits = result.splits || [];
      setSplits(prev => {
        const next = { ...prev };
        if (newSplits.length === 0) delete next[t.transaction_id];
        else next[t.transaction_id] = newSplits;
        return next;
      });
      closeSplitEditor();
    } catch (err) {
      console.error("Save splits failed:", err);
      alert(`Could not save splits: ${err.message}`);
    } finally {
      setSplitSaving(false);
    }
  }

  async function clearSplits(t) {
    setSplitSaving(true);
    try {
      await replaceSplitsApi(t.transaction_id, []);
      setSplits(prev => { const next = { ...prev }; delete next[t.transaction_id]; return next; });
      closeSplitEditor();
    } finally {
      setSplitSaving(false);
    }
  }

  // ── CSV export ───────────────────────────────────────────────────────────────
  // Exports `filtered` — the exact rows listed below, in the order they are
  // listed — so every filter in the toolbar is respected by construction rather
  // than by being re-implemented here. The date range and the category filter
  // are the two the export is asked for most, and they are already in `filtered`
  // via effectiveDateRange and catFilter; nothing needs to reach around them.
  //
  // The caveat is the loaded-rows cap, and it is the same one the filters
  // themselves carry: `filtered` is drawn from the page of transactions this
  // view holds, so on an account with more than that, an export cannot include
  // rows the view never fetched. `notAllLoaded` is exactly that condition, and
  // it is carried into the filename as `-partial` and spelled out in the button
  // tooltip. See the note at the top of csvExport.js.
  function handleExportCsv() {
    if (!filtered.length) return;
    const { from, to } = effectiveDateRange;
    const categoryLabel =
      catFilter === "all" ? null
      : catFilter === "unassigned" ? "unassigned"
      : categoryNames[catFilter] || null;
    const csv = buildCsv(CSV_HEADERS, transactionCsvRows({
      transactions: filtered,
      accountNames: acctMap,
      categoryNames,
      assignments,
      splits,
      merchantOverrides,
    }));
    downloadCsv(csvFilename({
      from,
      to,
      categoryLabel,
      partial: notAllLoaded,
      generatedOn: new Date().toISOString().slice(0, 10),
    }), csv);
  }

  const hasFilters = search || catFilter !== "all" || acctFilter !== "all" || minAmount || maxAmount || datePreset !== "all" || reviewFilter;
  const hiddenCount = transactions.filter(t => t.hidden && !hiddenAccounts?.has(t.account_id)).length;

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Transactions</h1>

      {/* Stats */}
      <div className="fade-up" style={styles.stats}>
        <div style={styles.stat}>
          <p style={styles.statLabel}>{statLabel("Transactions")}</p>
          <p style={styles.statVal}>{stats.total ? fmtCount(stats.total) : "—"}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>{statLabel("Total Spend")}</p>
          <p style={styles.statVal}>{stats.spend ? fmtRound(stats.spend) : "—"}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.statLabel}>{statLabel("Needs Review")}</p>
          <p style={{ ...styles.statVal, color: stats.needsReview > 0 ? "var(--red)" : "var(--text)" }}>
            {fmtCount(stats.needsReview)}
          </p>
        </div>
        {/* Not a row count — the category list arrives whole, so it needs no
            "(loaded)" caveat. */}
        <div style={styles.stat}>
          <p style={styles.statLabel}>Categories</p>
          <p style={styles.statVal}>{(categories || []).length || "—"}</p>
        </div>
      </div>

      {notAllLoaded && (
        <p className="fade-up" style={styles.partialNote}>
          Showing {fmtCount(loadedCount)} of {fmtCount(serverStats.total)} transactions — the most recent
          are loaded. The tiles above count all {fmtCount(serverStats.total)}; the search, filters and
          table below only see the {fmtCount(loadedCount)} loaded rows.
        </p>
      )}
      {statsFailed && (
        <p className="fade-up" style={styles.statsErrorNote}>
          Totals unavailable — the tiles above count the {fmtCount(loadedCount)} loaded rows only, which
          may be fewer than every transaction on record.
        </p>
      )}

      {/* Toolbar */}
      <div className="fade-up" style={styles.toolbar}>
        <input
          type="text"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.input}
        />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={styles.select}>
          <option value="all">All categories</option>
          <option value="unassigned">Unassigned</option>
          {(categories || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={acctFilter} onChange={(e) => setAcctFilter(e.target.value)} style={styles.select}>
          <option value="all">All accounts</option>
          {acctIds.filter(id => !hiddenAccounts?.has(id)).map((id) => (
            <option key={id} value={id}>{acctMap[id] || id}</option>
          ))}
        </select>
        <select value={datePreset} onChange={(e) => setDatePreset(e.target.value)} style={styles.select}>
          <option value="all">All dates</option>
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
          <option value="this_year">This year</option>
          <option value="last_year">Last year</option>
          <option value="custom">Custom range…</option>
        </select>
        {datePreset === "custom" && (
          <>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...styles.input, maxWidth: 140 }} />
            <span style={{ color: "var(--muted)", fontSize: 12 }}>–</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...styles.input, maxWidth: 140 }} />
          </>
        )}
        <input type="number" placeholder="Min $" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} style={{ ...styles.input, maxWidth: 90 }} />
        <input type="number" placeholder="Max $" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} style={{ ...styles.input, maxWidth: 90 }} />
        {/* Rendered off stats.needsApproval (whole-table when we have it) so the
            control does not vanish while unapproved rows exist further back,
            but LABELLED with the loaded subset, which is all it can act on. */}
        {stats.needsApproval > 0 && (
          <button
            style={{ ...styles.reviewChip, ...(reviewFilter ? styles.reviewChipActive : {}) }}
            onClick={() => setReviewFilter((v) => !v)}
            title={approvalChipTitle}
          >
            Awaiting approval ({approvalChipLabel})
          </button>
        )}
        {reviewFilter && filtered.length > 0 && (
          <button
            style={{ ...styles.approveAllBtn, opacity: approving ? 0.6 : 1 }}
            onClick={() => handleApprove(filtered.map((t) => t.transaction_id))}
            disabled={approving}
            title={`Approves the ${fmtCount(filtered.length)} rows currently listed below and nothing else — not every transaction awaiting approval.`}
          >
            {approving ? "Approving…" : `Approve all shown (${fmtCount(filtered.length)})`}
          </button>
        )}
        {hiddenCount > 0 && (
          <label style={styles.showHiddenLabel}>
            <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} style={{ marginRight: 4 }} />
            {hiddenCount} hidden
          </label>
        )}
        {/* Exports the rows listed below, not the whole table — the label says
            "shown" for the same reason "Approve all shown" does. Split rows
            expand to one CSV row each, so the count on the button is a count of
            transactions and the file may be longer. */}
        <button
          style={{ ...styles.exportBtn, opacity: filtered.length ? 1 : 0.45, cursor: filtered.length ? "pointer" : "default" }}
          onClick={handleExportCsv}
          disabled={!filtered.length}
          title={
            filtered.length
              ? `Downloads the ${fmtCount(filtered.length)} transactions listed below as a CSV, with the filters and sort order you have set${notAllLoaded ? `. These come from the ${fmtCount(loadedCount)} rows loaded here, not from all ${fmtCount(serverStats.total)} transactions on record — older rows this page has not fetched cannot be exported from this screen, and the file is named "-partial" to say so` : ""}. Split transactions export as one row per split line.`
              : "Nothing to export — no rows match the current filters."
          }
        >
          ↓ Export CSV{filtered.length ? ` (${fmtCount(filtered.length)})` : ""}
        </button>
        {hasFilters && (
          <button
            style={styles.clearBtn}
            onClick={() => { setSearch(""); setCatFilter("all"); setAcctFilter("all"); setMinAmount(""); setMaxAmount(""); setDatePreset("all"); setDateFrom(""); setDateTo(""); setReviewFilter(false); }}
          >
            Clear
          </button>
        )}
        {/* Counted against the loaded rows, not stats.total: filtering never
            reaches rows that were never fetched, and "12 of 3,847" would say it
            did. */}
        <span style={styles.count}>
          {fmtCount(filtered.length)} of {fmtCount(loadedCount)}{notAllLoaded ? " loaded" : ""}
        </span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {transactions.length === 0
            ? "No transactions yet."
            : notAllLoaded
              ? `No results match your filters in the ${fmtCount(loadedCount)} loaded rows — older transactions were not searched.`
              : "No results match your filters."}
        </p>
      ) : (
        <div className="fade-up-2" style={styles.tableWrap}>
          <div style={styles.tableHeader}>
            <span style={styles.sortable} onClick={() => toggleSort("date")}>Date {sortIcon("date")}</span>
            <span style={styles.sortable} onClick={() => toggleSort("merchant")}>Merchant {sortIcon("merchant")}</span>
            <span style={styles.sortable} onClick={() => toggleSort("account")}>Account {sortIcon("account")}</span>
            <span style={{ ...styles.sortable, textAlign: "right" }} onClick={() => toggleSort("amount")}>Amount {sortIcon("amount")}</span>
            <span>Category</span>
            <span />
          </div>

          {filtered.map((t) => {
            const assigned   = assignments?.[t.transaction_id];
            const txnSplits  = splits?.[t.transaction_id] || [];
            const hasSplits  = txnSplits.length > 0;
            const isCredit   = toNum(t.amount) < 0;
            const unassigned = !assigned && !hasSplits;
            const isSaving   = saving[t.transaction_id];
            const isHidden   = t.hidden;
            const needsApproval = !isHidden && t.reviewed_at == null;
            const isSplitOpen  = splitExpanded === t.transaction_id;
            const isDetailOpen = detailExpanded === t.transaction_id;

            return (
              <React.Fragment key={t.transaction_id}>
                <div
                  style={{
                    ...styles.row,
                    background: isHidden ? "rgba(100,100,100,0.06)" : needsApproval ? "rgba(251,191,36,0.08)" : unassigned ? "rgba(185,28,28,0.04)" : "transparent",
                    borderLeft: needsApproval ? "2px solid #fbbf24" : "2px solid transparent",
                    opacity: isHidden ? 0.55 : 1,
                  }}
                >
                  <span style={styles.date}>{fmtDate(t.date)}</span>

                  <span style={styles.merchantCell}>
                    {editingMerchant === t.transaction_id ? (
                      <input
                        autoFocus
                        value={merchantDraft}
                        onChange={(e) => setMerchantDraft(e.target.value)}
                        onBlur={() => commitMerchantRename(t)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitMerchantRename(t);
                          if (e.key === "Escape") setEditingMerchant(null);
                        }}
                        style={styles.merchantInput}
                      />
                    ) : (
                      <span
                        title="Click to rename"
                        onClick={() => { setEditingMerchant(t.transaction_id); setMerchantDraft(getDisplayName(t)); }}
                        style={{ cursor: "text" }}
                      >
                        {getDisplayName(t)}
                      </span>
                    )}
                  </span>

                  <span style={styles.acct}>{acctMap[t.account_id] || t.account_id || "—"}</span>

                  <span style={{ ...styles.amount, color: isCredit ? "var(--green)" : "var(--text)" }}>
                    {fmt(t.amount)}
                  </span>

                  {/* Category cell */}
                  <span style={styles.catCell}>
                    {hasSplits ? (
                      <div style={styles.splitSummary}>
                        {txnSplits.map((s) => (
                          <div key={s.id} style={styles.splitSummaryLine}>
                            <span style={styles.splitSummaryCat}>{s.category_name || "—"}</span>
                            <span style={styles.splitSummaryAmt}>${Math.abs(parseFloat(s.amount)).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <select
                        value={assigned || ""}
                        disabled={isSaving}
                        onChange={(e) => handleCategoryChange(t.transaction_id, e.target.value)}
                        style={{
                          ...styles.catSelect,
                          borderColor: unassigned ? "var(--red)" : "var(--border)",
                          opacity: isSaving ? 0.5 : 1,
                        }}
                      >
                        <option value="">
                          {unassigned && t.suggested_category ? `💡 ${t.suggested_category}` : "— None —"}
                        </option>
                        {(categories || []).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    )}
                  </span>

                  {/* Action cell */}
                  <span style={styles.actionCell}>
                    {isHidden ? (
                      <button style={styles.unhideBtn} onClick={() => handleUnhide(t.transaction_id)} title="Unhide transaction">
                        Unhide
                      </button>
                    ) : (
                      <>
                        <button
                          style={{ ...styles.splitBtn, color: isDetailOpen ? "var(--accent)" : undefined }}
                          onClick={() => toggleDetail(t.transaction_id)}
                          title="Transaction details"
                        >
                          ⋯
                        </button>
                        <button
                          style={{ ...styles.splitBtn, color: isSplitOpen ? "var(--accent)" : undefined }}
                          onClick={() => isSplitOpen ? closeSplitEditor() : openSplitEditor(t)}
                          title={hasSplits ? "Edit splits" : "Split transaction"}
                        >
                          {hasSplits ? "⇄" : "⊕"}
                        </button>
                        {confirmDelete === t.transaction_id ? (
                          <>
                            <button style={styles.confirmDeleteBtn} onClick={() => handleDelete(t.transaction_id)} disabled={deleting[t.transaction_id]}>
                              {deleting[t.transaction_id] ? "…" : "Hide"}
                            </button>
                            <button style={styles.cancelDeleteBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                          </>
                        ) : (
                          <button style={styles.deleteBtn} onClick={() => setConfirmDelete(t.transaction_id)} title="Hide transaction">×</button>
                        )}
                      </>
                    )}
                  </span>
                </div>

                {/* Split editor panel */}
                {isSplitOpen && (
                  <SplitEditor
                    t={t}
                    splitDraft={splitDraft}
                    categories={categories}
                    hasSplits={hasSplits}
                    splitSaving={splitSaving}
                    onUpdateLine={updateSplitLine}
                    onAddLine={addSplitLine}
                    onRemoveLine={removeSplitLine}
                    onSave={() => saveSplits(t)}
                    onClear={() => clearSplits(t)}
                    onCancel={closeSplitEditor}
                  />
                )}

                {/* Detail panel */}
                {isDetailOpen && (
                  <DetailPanel
                    t={t}
                    categories={categories}
                    approving={approving}
                    onApprove={() => handleApprove([t.transaction_id])}
                    onClose={() => setDetailExpanded(null)}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SplitEditor({ t, splitDraft, categories, hasSplits, splitSaving, onUpdateLine, onAddLine, onRemoveLine, onSave, onClear, onCancel }) {
  const total = Math.abs(toNum(t.amount) ?? 0);
  const allocated = splitDraft.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
  const remaining = total - allocated;
  const isBalanced = Math.abs(remaining) < 0.01;

  return (
    <div style={styles.splitPanel}>
      <div style={styles.splitPanelHeader}>
        <span style={styles.splitPanelTitle}>Split: <strong>{t.merchant_name || t.name || "Transaction"}</strong></span>
        <span style={styles.splitPanelTotal}>Total: <strong>${total.toFixed(2)}</strong></span>
      </div>

      <div style={styles.splitLines}>
        <div style={styles.splitLineHeader}>
          <span style={{ flex: "0 0 200px" }}>Category</span>
          <span style={{ flex: "0 0 100px" }}>Amount</span>
          <span style={{ flex: 1 }}>Note (optional)</span>
          <span style={{ flex: "0 0 28px" }} />
        </div>
        {splitDraft.map((line, idx) => (
          <div key={idx} style={styles.splitLine}>
            <select
              value={line.category_id}
              onChange={(e) => onUpdateLine(idx, "category_id", e.target.value)}
              style={styles.splitCatSelect}
            >
              <option value="">— None —</option>
              {(categories || []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <input
              type="number"
              placeholder="0.00"
              value={line.amount}
              onChange={(e) => onUpdateLine(idx, "amount", e.target.value)}
              style={styles.splitAmtInput}
              min="0"
              step="0.01"
            />
            <input
              type="text"
              placeholder="Note…"
              value={line.note}
              onChange={(e) => onUpdateLine(idx, "note", e.target.value)}
              style={styles.splitNoteInput}
            />
            <button onClick={() => onRemoveLine(idx)} style={styles.splitRemoveBtn} title="Remove line">×</button>
          </div>
        ))}
      </div>

      <div style={styles.splitFooter}>
        <button onClick={onAddLine} style={styles.addLineBtn}>+ Add line</button>
        <span style={{ ...styles.remainingLabel, color: isBalanced ? "var(--green)" : remaining < 0 ? "var(--red)" : "var(--muted)" }}>
          {isBalanced ? "✓ Balanced" : remaining > 0 ? `$${remaining.toFixed(2)} remaining` : `$${Math.abs(remaining).toFixed(2)} over`}
        </span>
        <div style={styles.splitActions}>
          {hasSplits && (
            <button onClick={onClear} disabled={splitSaving} style={styles.clearSplitsBtn}>Clear splits</button>
          )}
          <button onClick={onCancel} style={styles.cancelDeleteBtn}>Cancel</button>
          <button onClick={onSave} disabled={splitSaving || !isBalanced} style={styles.saveSplitsBtn}>
            {splitSaving ? "Saving…" : "Save splits"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ t, categories, approving, onApprove, onClose }) {
  const needsApproval = !t.hidden && t.reviewed_at == null;
  const hasReceipt = t.receipt_merchant != null || t.receipt_total != null || (t.receipt_items || []).length > 0;
  const suggestedName = t.suggested_category_id
    ? (categories || []).find((c) => c.id === t.suggested_category_id)?.name || null
    : null;
  const fields = [
    ["Raw description",  t.original_description || t.name || "—"],
    ["Plaid name",       t.name && t.name !== t.merchant_name ? t.name : null],
    ["Authorized date",  t.authorized_date && t.authorized_date !== t.date ? t.authorized_date : null],
    ["Payment channel",  t.payment_channel || null],
    ["City / State",     [t.city, t.state].filter(Boolean).join(", ") || null],
    ["Website",          t.website || null],
    ["Plaid category",   t.primary_category || null],
    ["Confidence",       t.category_confidence || null],
    ["Transaction ID",   t.transaction_id],
  ].filter(([, v]) => v != null);

  return (
    <div style={styles.detailPanel}>
      <div style={styles.detailHeader}>
        <span style={styles.detailTitle}>Details</span>
        <button style={styles.detailClose} onClick={onClose}>×</button>
      </div>
      <div style={styles.detailGrid}>
        {fields.map(([label, value]) => (
          <React.Fragment key={label}>
            <span style={styles.detailLabel}>{label}</span>
            <span style={styles.detailValue}>
              {label === "Website"
                ? <a href={`https://${value}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{value}</a>
                : value}
            </span>
          </React.Fragment>
        ))}
      </div>

      {/* Receipt (Gmail scanner match) — shown while the row is amber */}
      {needsApproval && hasReceipt && (
        <div style={styles.receiptBox}>
          <p style={styles.receiptTitle}>Receipt found in Gmail</p>
          <div style={styles.detailGrid}>
            {t.receipt_merchant && (
              <>
                <span style={styles.detailLabel}>Merchant</span>
                <span style={styles.detailValue}>{t.receipt_merchant}</span>
              </>
            )}
            {t.receipt_date && (
              <>
                <span style={styles.detailLabel}>Receipt date</span>
                <span style={styles.detailValue}>{t.receipt_date}</span>
              </>
            )}
            {t.receipt_total != null && (
              <>
                <span style={styles.detailLabel}>Total</span>
                <span style={styles.detailValue}>${Math.abs(toNum(t.receipt_total) ?? 0).toFixed(2)}</span>
              </>
            )}
          </div>
          {(t.receipt_items || []).length > 0 && (
            <div style={styles.receiptItems}>
              {(t.receipt_items || []).map((item, i) => (
                <div key={i} style={styles.receiptItemLine}>
                  <span style={styles.receiptItemDesc}>{item.description || "—"}</span>
                  <span style={styles.receiptItemAmt}>
                    {item.amount != null ? `$${Math.abs(toNum(item.amount) ?? 0).toFixed(2)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={styles.receiptFooter}>
            <span style={styles.receiptSuggested}>
              {suggestedName ? <>Suggested: <strong>{suggestedName}</strong></> : "No category suggestion"}
            </span>
            <button style={{ ...styles.approveBtn, opacity: approving ? 0.6 : 1 }} onClick={onApprove} disabled={approving}>
              {approving ? "Approving…" : "Approve"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap:    { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 1100 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },

  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 20 },
  stat:  { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "14px 18px" },
  statLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 6 },
  statVal:   { fontSize: 22, fontWeight: 700, color: "var(--text)" },

  toolbar: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  input: {
    flex: 1, maxWidth: 220, padding: "8px 12px",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  select: {
    padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },
  showHiddenLabel: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", cursor: "pointer", userSelect: "none" },
  reviewChip: {
    padding: "8px 12px", background: "rgba(251,191,36,0.08)", border: "1px solid #fbbf24",
    borderRadius: "var(--radius)", color: "#fbbf24", fontSize: 12, fontWeight: 600,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  reviewChipActive: { background: "#fbbf24", color: "#1c1917" },
  approveAllBtn: {
    padding: "8px 12px", background: "var(--accent)", border: "none",
    borderRadius: "var(--radius)", color: "#fff", fontSize: 12, fontWeight: 700,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  exportBtn: {
    padding: "8px 12px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, fontWeight: 600,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  clearBtn: {
    padding: "8px 12px", background: "none", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 12,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  // Same amber/red emphasis the rest of the app uses for "this number is
  // partial" and "this read failed" — see the AI Usage card in Settings.jsx.
  partialNote:    { fontSize: 12, color: "var(--amber, #f59e0b)", fontFamily: "var(--font-mono)", lineHeight: 1.5, marginBottom: 14 },
  statsErrorNote: { fontSize: 12, color: "var(--red, #ef4444)",   fontFamily: "var(--font-mono)", lineHeight: 1.5, marginBottom: 14 },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" },

  tableWrap: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflowX: "auto" },
  tableHeader: {
    display: "grid", gridTemplateColumns: "76px minmax(0,1fr) minmax(0,150px) 96px minmax(0,210px) 110px", minWidth: 800,
    padding: "10px 16px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)",
  },
  sortable: { cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4 },
  sortNeutral: { opacity: 0.3, fontSize: 10 },
  sortActive:  { color: "var(--accent)", fontSize: 10 },
  row: {
    display: "grid", gridTemplateColumns: "76px minmax(0,1fr) minmax(0,150px) 96px minmax(0,210px) 110px", minWidth: 800,
    padding: "9px 16px", borderBottom: "1px solid var(--border)",
    alignItems: "center",
  },
  date:         { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", whiteSpace: "nowrap" },
  merchantCell: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  merchantInput: {
    width: "100%", padding: "3px 7px",
    background: "var(--bg)", border: "1px solid var(--accent)",
    borderRadius: 4, color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  acct:   { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  amount: { fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", fontWeight: 500, paddingRight: 16 },
  catCell: { minWidth: 0 },
  catSelect: {
    width: "100%", padding: "5px 8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },

  // Split summary in category cell
  splitSummary: { display: "flex", flexDirection: "column", gap: 1 },
  splitSummaryLine: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  splitSummaryCat: { fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  splitSummaryAmt: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },

  // Action cell
  actionCell: { display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end" },
  splitBtn: {
    background: "none", border: "none", color: "var(--muted)", cursor: "pointer",
    fontSize: 15, lineHeight: 1, padding: "2px 5px", borderRadius: 4, opacity: 0.85,
    fontFamily: "var(--font-display)",
  },
  deleteBtn: {
    background: "none", border: "none", color: "var(--muted)", cursor: "pointer",
    fontSize: 16, lineHeight: 1, padding: "2px 5px", borderRadius: 4, opacity: 0.65,
    fontFamily: "var(--font-display)",
  },
  unhideBtn: {
    background: "none", border: "1px solid var(--border)", color: "var(--muted)",
    borderRadius: 5, padding: "3px 7px", fontSize: 10, fontWeight: 600, cursor: "pointer",
    fontFamily: "var(--font-mono)", letterSpacing: "0.04em",
  },
  confirmDeleteBtn: {
    background: "var(--red, #ef4444)", color: "#fff", border: "none",
    borderRadius: 5, padding: "4px 8px", fontSize: 11, fontWeight: 700,
    cursor: "pointer", fontFamily: "var(--font-display)",
  },
  cancelDeleteBtn: {
    background: "none", color: "var(--muted)", border: "1px solid var(--border)",
    borderRadius: 5, padding: "4px 7px", fontSize: 11, cursor: "pointer",
    fontFamily: "var(--font-display)",
  },

  // Split editor panel
  splitPanel: {
    padding: "16px 20px",
    background: "var(--surface2)",
    borderBottom: "1px solid var(--border)",
    borderTop: "1px solid var(--accent)",
  },
  splitPanelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  splitPanelTitle: { fontSize: 13, color: "var(--text)", fontFamily: "var(--font-mono)" },
  splitPanelTotal: { fontSize: 13, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  splitLines: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  splitLineHeader: {
    display: "flex", gap: 8, alignItems: "center",
    fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
    color: "var(--muted)", fontFamily: "var(--font-mono)", paddingBottom: 4,
    borderBottom: "1px solid var(--border)",
  },
  splitLine: { display: "flex", gap: 8, alignItems: "center" },
  splitCatSelect: {
    flex: "0 0 200px", padding: "6px 8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer",
  },
  splitAmtInput: {
    flex: "0 0 100px", padding: "6px 8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  splitNoteInput: {
    flex: 1, padding: "6px 8px",
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 6, color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  splitRemoveBtn: {
    flex: "0 0 28px", background: "none", border: "none", color: "var(--muted)",
    cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px",
    borderRadius: 4, opacity: 0.5,
  },
  splitFooter: { display: "flex", alignItems: "center", gap: 10 },
  addLineBtn: {
    background: "none", border: "1px dashed var(--border)", color: "var(--muted)",
    borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer",
    fontFamily: "var(--font-mono)",
  },
  remainingLabel: { fontSize: 12, fontFamily: "var(--font-mono)", marginRight: "auto" },
  splitActions: { display: "flex", gap: 6 },
  clearSplitsBtn: {
    background: "none", border: "1px solid var(--border)", color: "var(--muted)",
    borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer",
    fontFamily: "var(--font-mono)",
  },
  saveSplitsBtn: {
    background: "var(--accent)", color: "#fff", border: "none",
    borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
    fontFamily: "var(--font-mono)", opacity: 1,
  },

  // Detail panel
  detailPanel: {
    padding: "14px 20px",
    background: "var(--surface2)",
    borderBottom: "1px solid var(--border)",
    borderTop: "1px solid var(--border)",
  },
  detailHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  detailTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)" },
  detailClose: {
    background: "none", border: "none", color: "var(--muted)", cursor: "pointer",
    fontSize: 16, lineHeight: 1, padding: "2px 4px", borderRadius: 4, opacity: 0.5,
  },
  detailGrid: {
    display: "grid", gridTemplateColumns: "140px 1fr",
    gap: "5px 16px", alignItems: "start",
  },
  detailLabel: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", fontWeight: 600, paddingTop: 1 },
  detailValue: { fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", wordBreak: "break-all" },

  // Receipt block inside the detail panel (amber rows)
  receiptBox: {
    marginTop: 12, padding: "12px 14px",
    background: "rgba(251,191,36,0.08)",
    border: "1px solid rgba(251,191,36,0.35)",
    borderLeft: "2px solid #fbbf24",
    borderRadius: 8,
  },
  receiptTitle: {
    fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
    color: "#fbbf24", fontFamily: "var(--font-mono)", marginBottom: 8,
  },
  receiptItems: { marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 6, display: "flex", flexDirection: "column", gap: 3 },
  receiptItemLine: { display: "flex", justifyContent: "space-between", gap: 12 },
  receiptItemDesc: { fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  receiptItemAmt: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },
  receiptFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12 },
  receiptSuggested: { fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)" },
  approveBtn: {
    background: "#fbbf24", color: "#1c1917", border: "none",
    borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 700,
    cursor: "pointer", fontFamily: "var(--font-mono)",
  },
};
