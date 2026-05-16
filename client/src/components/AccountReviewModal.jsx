import React, { useState } from "react";

const fmt = (n) => n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function AccountReviewModal({ newAccounts, existingAccounts, onConfirm, onClose }) {
  const [choices, setChoices] = useState(() =>
    Object.fromEntries(newAccounts.map((a) => [a.account_id, "new"]))
  );
  const [saving, setSaving] = useState(false);

  const chosenIds = new Set(Object.values(choices).filter((v) => v !== "new"));

  async function handleConfirm() {
    setSaving(true);
    const replacements = {};
    for (const [plaidId, choice] of Object.entries(choices)) {
      if (choice !== "new") replacements[plaidId] = choice;
    }
    await onConfirm(replacements);
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h2 style={styles.title}>Review New Accounts</h2>
        <p style={styles.subtitle}>
          For each newly linked account, choose whether it's new or replaces an existing one.
          Replaced accounts will be hidden.
        </p>

        <div style={styles.list}>
          {newAccounts.map((a) => (
            <div key={a.account_id} style={styles.row}>
              <div style={styles.accountInfo}>
                <p style={styles.accountName}>{a.name}</p>
                <p style={styles.accountMeta}>
                  {a.institutionName} · {a.subtype} · {fmt(a.balances?.current)}
                </p>
              </div>
              <select
                value={choices[a.account_id]}
                onChange={(e) => setChoices((prev) => ({ ...prev, [a.account_id]: e.target.value }))}
                style={styles.select}
              >
                <option value="new">+ Add as New</option>
                {existingAccounts
                  .filter((e) => choices[a.account_id] === e.account_id || !chosenIds.has(e.account_id))
                  .map((e) => (
                    <option key={e.account_id} value={e.account_id}>
                      Replace: {e.name}{e.institutionName ? ` (${e.institutionName})` : ""}
                    </option>
                  ))}
              </select>
            </div>
          ))}
        </div>

        <div style={styles.footer}>
          <button onClick={onClose} disabled={saving} style={styles.cancelBtn}>Cancel</button>
          <button onClick={handleConfirm} disabled={saving} style={styles.confirmBtn}>
            {saving ? "Saving…" : "Confirm"}
          </button>
        </div>
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
    padding: "32px 28px", width: "90%", maxWidth: 520, maxHeight: "80vh",
    display: "flex", flexDirection: "column", gap: 20,
  },
  title: { fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)", margin: 0 },
  subtitle: { fontSize: 13, color: "var(--muted)", margin: 0, lineHeight: 1.5 },
  list: { display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" },
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    padding: "12px 14px", background: "var(--surface2)", borderRadius: "var(--radius)",
  },
  accountInfo: { flex: 1, minWidth: 0 },
  accountName: { fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  accountMeta: { fontSize: 12, color: "var(--muted)", margin: "2px 0 0", fontFamily: "var(--font-mono)" },
  select: {
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8,
    color: "var(--text)", fontSize: 12, padding: "6px 8px", flexShrink: 0, maxWidth: 200,
    fontFamily: "var(--font-display)",
  },
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
