import React, { useState, useMemo } from "react";
import { saveAssignment, saveMerchantOverride } from "../api.js";

const fmt = (n) =>
  n == null ? "—" : (n < 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function Transactions({
  transactions,
  categories,
  assignments,
  merchantOverrides,
  setAssignments,
  setMerchantOverrides,
}) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [panelCategory, setPanelCategory] = useState("");
  const [panelMerchant, setPanelMerchant] = useState("");
  const [saving, setSaving] = useState(false);

  const categoryMap = useMemo(() => {
    const m = {};
    (categories || []).forEach((c) => { m[c.id] = c; });
    return m;
  }, [categories]);

  const getDisplayName = (t) =>
    merchantOverrides?.[t.transaction_id] || t.merchant_name || t.name || "Unknown";

  const getUserCategory = (t) => {
    const id = assignments?.[t.transaction_id];
    return id && categoryMap[id] ? categoryMap[id] : null;
  };

  const plaidLabel = (t) => (t.category || "Other").replace(/_/g, " ");

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      const name = getDisplayName(t).toLowerCase();
      const matchSearch = !search || name.includes(search.toLowerCase());
      let matchCat = true;
      if (catFilter === "unassigned") {
        matchCat = !assignments?.[t.transaction_id];
      } else if (catFilter !== "all") {
        matchCat = assignments?.[t.transaction_id] === catFilter;
      }
      return matchSearch && matchCat;
    });
  }, [transactions, search, catFilter, assignments, merchantOverrides]);

  function openPanel(t) {
    setSelected(t);
    setPanelCategory(assignments?.[t.transaction_id] || "");
    setPanelMerchant(merchantOverrides?.[t.transaction_id] || "");
  }

  function closePanel() {
    setSelected(null);
  }

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    try {
      const currentCat = assignments?.[selected.transaction_id] || "";
      if (panelCategory !== currentCat) {
        await saveAssignment(selected.transaction_id, panelCategory || null);
        setAssignments((prev) => ({ ...prev, [selected.transaction_id]: panelCategory || null }));
      }
      const currentOverride = merchantOverrides?.[selected.transaction_id] || "";
      if (panelMerchant && panelMerchant !== currentOverride) {
        await saveMerchantOverride(selected.transaction_id, panelMerchant);
        setMerchantOverrides((prev) => ({ ...prev, [selected.transaction_id]: panelMerchant }));
      }
      closePanel();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Transactions</h1>

      {/* Toolbar */}
      <div className="fade-up" style={styles.toolbar}>
        <input
          type="text"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.input}
        />
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          style={styles.select}
        >
          <option value="all">All categories</option>
          <option value="unassigned">Unassigned</option>
          {(categories || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <span style={styles.count}>{filtered.length} txns</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {transactions.length === 0 ? "Connect a bank account to see transactions." : "No results."}
        </p>
      ) : (
        <div className="fade-up-2" style={styles.table}>
          <div style={styles.tableHeader}>
            <span>Date</span>
            <span>Merchant</span>
            <span>Category</span>
            <span style={{ textAlign: "right" }}>Amount</span>
          </div>
          {filtered.map((t) => {
            const userCat = getUserCategory(t);
            const isCredit = t.amount < 0;
            const isSelected = selected?.transaction_id === t.transaction_id;
            return (
              <div
                key={t.transaction_id}
                style={{
                  ...styles.row,
                  background: isSelected ? "var(--surface2)" : "transparent",
                  cursor: "pointer",
                }}
                onClick={() => openPanel(t)}
              >
                <span style={styles.date}>{t.date}</span>
                <span style={styles.merchant}>{getDisplayName(t)}</span>
                <span style={styles.cat}>
                  {userCat ? (
                    <span style={styles.catChip}>
                      <span style={{ ...styles.dot, background: userCat.color }} />
                      {userCat.name}
                    </span>
                  ) : (
                    <span style={styles.plaidCat}>{plaidLabel(t)}</span>
                  )}
                </span>
                <span style={{ ...styles.amount, color: isCredit ? "var(--green)" : "var(--text)" }}>
                  {fmt(t.amount)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Panel */}
      {selected && (
        <>
          <div style={styles.overlay} onClick={closePanel} />
          <div style={styles.panel}>
            <div style={styles.panelHeader}>
              <span style={styles.panelTitle}>Edit Transaction</span>
              <button style={styles.closeBtn} onClick={closePanel}>✕</button>
            </div>

            <div style={styles.panelInfo}>
              <p style={styles.panelName}>{selected.merchant_name || selected.name}</p>
              <p style={styles.panelMeta}>{selected.date} · {fmt(selected.amount)}</p>
              <p style={styles.panelPlaid}>Plaid: {plaidLabel(selected)}</p>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Category</label>
              {(categories || []).length === 0 ? (
                <p style={styles.hint}>No categories yet — create some in the Categories view.</p>
              ) : (
                <select
                  value={panelCategory}
                  onChange={(e) => setPanelCategory(e.target.value)}
                  style={styles.panelSelect}
                >
                  <option value="">— None (use Plaid category) —</option>
                  {(categories || []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Merchant Name Override</label>
              <input
                type="text"
                value={panelMerchant}
                onChange={(e) => setPanelMerchant(e.target.value)}
                placeholder={selected.merchant_name || selected.name}
                style={styles.panelInput}
              />
              <p style={styles.hint}>Leave blank to keep the original name</p>
            </div>

            <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { padding: "36px 40px", maxWidth: 960 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },
  toolbar: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  input: {
    flex: 1, maxWidth: 300, padding: "9px 14px",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "var(--font-mono)", outline: "none",
  },
  select: {
    padding: "9px 14px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none", cursor: "pointer", maxWidth: 220,
  },
  count: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" },
  table: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  tableHeader: {
    display: "grid", gridTemplateColumns: "100px 1fr 180px 110px",
    padding: "10px 20px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
  },
  row: {
    display: "grid", gridTemplateColumns: "100px 1fr 180px 110px",
    padding: "13px 20px", borderTop: "1px solid var(--border)",
    alignItems: "center", transition: "background 0.1s",
  },
  date: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  merchant: { fontSize: 13, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 },
  cat: { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  catChip: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text)" },
  dot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0 },
  plaidCat: { color: "var(--muted)", fontFamily: "var(--font-mono)" },
  amount: { fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "right", fontWeight: 500 },
  // Panel
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100 },
  panel: {
    position: "fixed", top: 0, right: 0, bottom: 0, width: 360,
    background: "var(--surface)", borderLeft: "1px solid var(--border)",
    zIndex: 101, display: "flex", flexDirection: "column", padding: "24px",
    overflowY: "auto",
  },
  panelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  panelTitle: { fontSize: 14, fontWeight: 700, color: "var(--text)" },
  closeBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 18, cursor: "pointer", padding: "2px 6px" },
  panelInfo: { background: "var(--surface2)", borderRadius: "var(--radius)", padding: "14px 16px", marginBottom: 20 },
  panelName: { fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 4 },
  panelMeta: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 },
  panelPlaid: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  field: { marginBottom: 20 },
  label: { display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 8 },
  panelSelect: {
    width: "100%", padding: "9px 12px", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: "var(--radius)",
    color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none",
  },
  panelInput: {
    width: "100%", padding: "9px 12px", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: "var(--radius)",
    color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none",
    boxSizing: "border-box",
  },
  hint: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 6 },
  saveBtn: {
    width: "100%", padding: "12px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: "var(--radius)", fontFamily: "var(--font-display)",
    fontWeight: 700, fontSize: 13, cursor: "pointer", marginTop: "auto",
  },
};
