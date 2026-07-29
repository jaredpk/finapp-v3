import React, { useState } from "react";
import {
  addHiddenAccountApi, removeHiddenAccountApi,
  deleteManualAccountApi, removeLinkedInstitution, deleteImportedAccountApi,
} from "../api.js";

const TYPE_COLORS = {
  depository: "var(--green)",
  credit:     "var(--red)",
  investment: "var(--accent)",
  loan:       "var(--accent2)",
  other:      "var(--blue)",
};

const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

// How a delete is handled for each account source
function deleteKind(a) {
  if (a.source === "manual") return "manual";
  if (a.source === "plaid") return "plaid";
  if (a.source === "imported" && a.account_id?.startsWith("balance_")) return "imported";
  if (a.source === "property") return "property";
  if (a.source === "vehicle") return "vehicle";
  return "holdings"; // investment-holdings-derived (source "imported", holdings_* id)
}

export default function Accounts({ accounts, itemErrors, hiddenAccounts, setHiddenAccounts, openUpdate, updating, reloadData }) {
  const [showHidden, setShowHidden] = useState(false);
  const [toggling, setToggling] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const visibleAccounts = accounts.filter(a => !hiddenAccounts?.has(a.account_id));
  const hiddenAccountsList = accounts.filter(a => hiddenAccounts?.has(a.account_id));
  const displayAccounts = showHidden ? accounts : visibleAccounts;

  async function toggleHide(account) {
    const id = account.account_id;
    setToggling(p => ({ ...p, [id]: true }));
    try {
      if (hiddenAccounts?.has(id)) {
        await removeHiddenAccountApi(id);
        setHiddenAccounts(prev => { const next = new Set(prev); next.delete(id); return next; });
      } else {
        await addHiddenAccountApi(id);
        setHiddenAccounts(prev => new Set([...prev, id]));
      }
    } catch (err) {
      console.error("Toggle hide failed:", err);
    } finally {
      setToggling(p => ({ ...p, [id]: false }));
    }
  }

  async function confirmDelete() {
    const a = deleteTarget;
    if (!a) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      let removedIds = [a.account_id];
      let res;
      const kind = deleteKind(a);
      if (kind === "manual") {
        res = await deleteManualAccountApi(a.account_id.replace(/^manual_/, ""));
      } else if (kind === "plaid") {
        removedIds = accounts.filter((x) => x.source === "plaid" && x.itemId === a.itemId).map((x) => x.account_id);
        res = await removeLinkedInstitution(a.itemId);
      } else {
        res = await deleteImportedAccountApi(a.account_id);
      }
      if (res?.error) throw new Error(res.error);
      // Clean up hidden-account entries for accounts that no longer exist
      for (const id of removedIds) {
        if (hiddenAccounts?.has(id)) await removeHiddenAccountApi(id).catch(() => {});
      }
      setHiddenAccounts?.((prev) => {
        const next = new Set(prev);
        removedIds.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteTarget(null);
      reloadData?.();
    } catch (err) {
      setDeleteError(err.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  const byType = displayAccounts.reduce((acc, a) => {
    const t = a.type || "other";
    if (!acc[t]) acc[t] = [];
    acc[t].push(a);
    return acc;
  }, {});

  if (!accounts.length) {
    return (
      <div style={styles.wrap}>
        <h1 style={styles.heading}>Accounts</h1>
        <p style={styles.empty}>No accounts connected yet.</p>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      {itemErrors?.length > 0 && (
        <div style={styles.errorBanner}>
          <span style={{ fontWeight: 600 }}>Reconnect required</span>
          {itemErrors.map((e) => (
            <div key={e.itemId} style={styles.errorRow}>
              <span>{e.institutionName || e.itemId} — login credentials changed</span>
              <button
                style={styles.reconnectBtn}
                disabled={updating}
                onClick={() => openUpdate?.(e.itemId)}
              >
                {updating ? "Opening…" : "Reconnect"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={styles.headingRow}>
        <h1 className="fade-up" style={styles.heading}>Accounts</h1>
        {hiddenAccountsList.length > 0 && (
          <button
            onClick={() => setShowHidden(p => !p)}
            style={styles.showHiddenBtn}
          >
            {showHidden ? `Hide hidden (${hiddenAccountsList.length})` : `Show hidden (${hiddenAccountsList.length})`}
          </button>
        )}
      </div>

      {Object.entries(byType).map(([type, accts], gi) => (
        <div key={type} className="fade-up" style={{ animationDelay: `${gi * 0.08}s`, marginBottom: 32 }}>
          <p style={styles.groupLabel}>{type}</p>
          <div style={styles.grid}>
            {accts.map((a) => {
              const isHidden = hiddenAccounts?.has(a.account_id);
              return (
                <div
                  key={a.account_id}
                  style={{ ...styles.card, opacity: isHidden ? 0.45 : 1, position: "relative" }}
                >
                  <div style={styles.cardTop}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={styles.bankName}>{a.name}</p>
                      <p style={styles.subtype}>{a.subtype || a.type}</p>
                    </div>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <span style={{ ...styles.badge, background: TYPE_COLORS[a.type] || "var(--blue)" + "22", color: TYPE_COLORS[a.type] || "var(--blue)" }}>
                        {a.type}
                      </span>
                      {a.source && (
                        <span style={{ ...styles.sourceBadge, ...(a.source === "plaid" ? styles.sourceBadgePlaid : {}) }}>{a.source}</span>
                      )}
                      <button
                        onClick={() => toggleHide(a)}
                        disabled={toggling[a.account_id]}
                        title={isHidden ? "Show account" : "Hide account"}
                        style={styles.hideBtn}
                      >
                        {isHidden ? "👁" : "🚫"}
                      </button>
                      <button
                        onClick={() => { setDeleteError(null); setDeleteTarget(a); }}
                        title="Delete account"
                        style={styles.deleteBtn}
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {isHidden && (
                    <div style={styles.hiddenBadge}>Hidden</div>
                  )}

                  <div style={styles.divider} />

                  <div style={styles.balRow}>
                    <div>
                      <p style={styles.balLabel}>Current</p>
                      <p style={{ ...styles.balAmt, color: a.type === "credit" || a.type === "loan" ? "var(--red)" : "var(--green)" }}>
                        {fmt(a.balances?.current)}
                      </p>
                    </div>
                    {a.balances?.available != null && (
                      <div style={{ textAlign: "right" }}>
                        <p style={styles.balLabel}>Available</p>
                        <p style={styles.balAmt}>{fmt(a.balances.available)}</p>
                      </div>
                    )}
                    {a.balances?.limit != null && (
                      <div style={{ textAlign: "right" }}>
                        <p style={styles.balLabel}>Limit</p>
                        <p style={styles.balAmt}>{fmt(a.balances.limit)}</p>
                      </div>
                    )}
                  </div>

                  {a.mask && <p style={styles.mask}>···· {a.mask}</p>}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {deleteTarget && (
        <DeleteAccountModal
          account={deleteTarget}
          kind={deleteKind(deleteTarget)}
          siblings={
            deleteTarget.source === "plaid"
              ? accounts.filter((x) => x.source === "plaid" && x.itemId === deleteTarget.itemId).map((x) => x.name)
              : []
          }
          isHidden={hiddenAccounts?.has(deleteTarget.account_id)}
          deleting={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onHideInstead={() => { toggleHide(deleteTarget); setDeleteTarget(null); }}
          onClose={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
        />
      )}
    </div>
  );
}

function DeleteAccountModal({ account, kind, siblings, isHidden, deleting, error, onConfirm, onHideInstead, onClose }) {
  const destructive = kind === "manual" || kind === "plaid" || kind === "imported";

  let title = "Delete Account";
  let body;
  if (kind === "manual") {
    body = <>Delete manual account <b>{account.name}</b>? This removes it permanently.</>;
  } else if (kind === "plaid") {
    title = "Unlink Institution";
    body = (
      <>
        This is a linked <b>{account.institutionName || "institution"}</b> account. Deleting it will unlink
        the entire institution and remove <b>ALL</b> of its accounts{siblings.length > 1 ? ":" : "."}
        {siblings.length > 1 && (
          <ul style={styles.modalList}>
            {siblings.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        {" "}Transactions already synced are kept.
      </>
    );
  } else if (kind === "imported") {
    body = (
      <>
        Delete imported account <b>{account.name}</b>? This permanently deletes its{" "}
        {account.snapshot_count != null ? account.snapshot_count : "stored"} balance snapshot rows.
      </>
    );
  } else {
    title = "Managed Account";
    const managedBy =
      kind === "property" ? "your Properties data — remove the property there to remove this account" :
      kind === "vehicle" ? "your Vehicles data — remove the vehicle there to remove this account" :
      "your imported investment holdings data";
    body = (
      <>
        <b>{account.name}</b> is managed by {managedBy}. It can't be deleted from this screen, but you can
        hide it so it doesn't appear in your totals.
      </>
    );
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <p style={styles.modalTitle}>{title}</p>
        <p style={styles.modalBody}>{body}</p>
        {error && <p style={styles.modalError}>{error}</p>}
        <div style={styles.modalActions}>
          <button onClick={onClose} disabled={deleting} style={styles.cancelBtn}>Cancel</button>
          {destructive ? (
            <button onClick={onConfirm} disabled={deleting} style={{ ...styles.dangerBtn, opacity: deleting ? 0.6 : 1 }}>
              {deleting ? "Deleting…" : kind === "plaid" ? "Unlink institution" : "Delete"}
            </button>
          ) : (
            !isHidden && <button onClick={onHideInstead} style={styles.hideInsteadBtn}>Hide instead</button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 960 },
  headingRow: { display: "flex", alignItems: "center", gap: 16, marginBottom: 32 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text)", margin: 0 },
  showHiddenBtn: {
    background: "none", border: "1px solid var(--border)", color: "var(--muted)",
    borderRadius: "var(--radius)", padding: "6px 12px", fontSize: 12,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  errorBanner: {
    background: "rgba(248, 113, 113, 0.1)", border: "1px solid var(--red)", borderRadius: "var(--radius2)",
    padding: "14px 18px", marginBottom: 24, color: "var(--text)", fontSize: 13,
  },
  errorRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginTop: 8, fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)",
  },
  reconnectBtn: {
    background: "var(--red)", color: "#fff", border: "none", borderRadius: "var(--radius)",
    padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", marginTop: 48, textAlign: "center" },
  groupLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 22px" },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  bankName: { fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 3 },
  subtype: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  badge: { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 99, background: "rgba(240,180,41,0.12)", color: "var(--accent)" },
  sourceBadge: {
    fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
    padding: "3px 6px", borderRadius: 99, background: "var(--surface2)", color: "var(--muted)",
    fontFamily: "var(--font-mono)",
  },
  sourceBadgePlaid: {
    background: "rgba(99,102,241,0.12)", color: "var(--accent)",
  },
  hideBtn: {
    background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: "0 2px",
    opacity: 0.5, lineHeight: 1, flexShrink: 0,
  },
  deleteBtn: {
    background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: "0 2px",
    opacity: 0.35, lineHeight: 1, flexShrink: 0,
  },
  hiddenBadge: {
    display: "inline-block", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)",
    marginBottom: 8,
  },
  divider: { height: 1, background: "var(--border)", marginBottom: 16 },
  balRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
  balLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 },
  balAmt: { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em", color: "var(--text)" },
  mask: { marginTop: 14, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modal: { background: "var(--surface2)", border: "1px solid var(--border2)", borderRadius: "var(--radius2)", padding: 28, width: 380, display: "flex", flexDirection: "column", gap: 14 },
  modalTitle: { fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 4 },
  modalBody: { fontSize: 13, color: "var(--text)", lineHeight: 1.5 },
  modalList: { margin: "8px 0", paddingLeft: 20, fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  modalError: { fontSize: 12, color: "var(--red)", fontFamily: "var(--font-mono)" },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 },
  cancelBtn: { padding: "8px 18px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-display)", cursor: "pointer" },
  dangerBtn: { padding: "8px 18px", background: "var(--red)", border: "none", borderRadius: "var(--radius)", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-display)", cursor: "pointer" },
  hideInsteadBtn: { padding: "8px 18px", background: "var(--accent)", border: "none", borderRadius: "var(--radius)", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-display)", cursor: "pointer" },
};
