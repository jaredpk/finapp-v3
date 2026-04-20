import React, { useState } from "react";
import { createCategoryApi, updateCategoryApi, deleteCategoryApi, seedCategoriesApi } from "../api.js";

const PRESET_CATEGORIES = [
  { name: "Auto - Gas & Fuel",       color: "#3b82f6" },
  { name: "Auto - Other",            color: "#3b82f6" },
  { name: "Auto - Payment",          color: "#3b82f6" },
  { name: "Auto - Service & Parts",  color: "#3b82f6" },
  { name: "Auto - Car Insurance",    color: "#3b82f6" },
  { name: "Charity & Donations",     color: "#a855f7" },
  { name: "Dining Out",              color: "#f59e0b" },
  { name: "Entertainment",           color: "#a855f7" },
  { name: "Child Support",           color: "#ec4899" },
  { name: "Condo Rent",              color: "#14b8a6" },
  { name: "Credit Card Payment",     color: "#64748b" },
  { name: "Education",               color: "#6366f1" },
  { name: "Fees & Charges",          color: "#ef4444" },
  { name: "Gifts",                   color: "#ec4899" },
  { name: "Groceries",               color: "#22c55e" },
  { name: "Health",                  color: "#22c55e" },
  { name: "Home - Mortgage",         color: "#14b8a6" },
  { name: "Home - Improvement",      color: "#14b8a6" },
  { name: "Household Items",         color: "#f59e0b" },
  { name: "Insurance",               color: "#f97316" },
  { name: "Insurance - Home",        color: "#f97316" },
  { name: "Insurance - Life",        color: "#f97316" },
  { name: "Jared Savings",           color: "#6366f1" },
  { name: "Shopping",               color: "#3b82f6" },
  { name: "Subscriptions",          color: "#6366f1" },
  { name: "Kids",                    color: "#ec4899" },
  { name: "Kids - Healthcare",       color: "#22c55e" },
  { name: "Personal - Alta",         color: "#6366f1" },
  { name: "Personal - Jared",        color: "#6366f1" },
  { name: "Personal Income",         color: "#22c55e" },
  { name: "Pets",                    color: "#f59e0b" },
  { name: "Rec and Vacation",        color: "#f59e0b" },
  { name: "Reimbursement",           color: "#22c55e" },
  { name: "Taxes",                   color: "#ef4444" },
  { name: "Transfer",                color: "#64748b" },
  { name: "Utilities",               color: "#f97316" },
  { name: "Utilities - Phone",       color: "#f97316" },
];

const PRESET_COLORS = [
  "#6366f1", "#22c55e", "#ef4444", "#f59e0b",
  "#3b82f6", "#ec4899", "#14b8a6", "#f97316",
  "#a855f7", "#64748b",
];

export default function Categories({ categories, setCategories }) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name, color }
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState("");

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await createCategoryApi(newName.trim(), newColor);
      if (res.category) {
        setCategories((prev) => [...prev, res.category].sort((a, b) => a.name.localeCompare(b.name)));
        setNewName("");
        setNewColor("#6366f1");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate() {
    if (!editing || !editing.name.trim()) return;
    setSaving(true);
    try {
      const res = await updateCategoryApi(editing.id, editing.name.trim(), editing.color);
      if (res.category) {
        setCategories((prev) =>
          prev.map((c) => (c.id === editing.id ? res.category : c))
        );
        setEditing(null);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSeed() {
    setSeeding(true);
    setSeedMsg("");
    try {
      const res = await seedCategoriesApi(PRESET_CATEGORIES);
      setCategories(res.categories || []);
      setSeedMsg(res.created > 0 ? `Added ${res.created} categories.` : "All preset categories already exist.");
    } finally {
      setSeeding(false);
    }
  }

  async function handleDelete(id) {
    await deleteCategoryApi(id);
    setCategories((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Categories</h1>

      {/* Preset seed */}
      <div className="fade-up" style={styles.seedRow}>
        <div>
          <p style={styles.seedLabel}>Load your preset categories</p>
          <p style={styles.seedHint}>Adds all 33 categories at once. Skips any that already exist.</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button style={styles.seedBtn} onClick={handleSeed} disabled={seeding}>
            {seeding ? "Loading…" : "Load Presets"}
          </button>
          {seedMsg && <p style={styles.seedMsg}>{seedMsg}</p>}
        </div>
      </div>

      {/* Create form */}
      <div className="fade-up" style={styles.card}>
        <p style={styles.sectionLabel}>New Category</p>
        <div style={styles.addRow}>
          <input
            type="text"
            placeholder="Category name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            style={styles.input}
          />
          <div style={{ ...styles.colorPreview, background: newColor }} />
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            style={styles.addBtn}
          >
            {creating ? "Adding…" : "Add"}
          </button>
        </div>
        <div style={styles.colorRow}>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setNewColor(c)}
              title={c}
              style={{
                ...styles.colorChip,
                background: c,
                outline: newColor === c ? "2px solid white" : "none",
                outlineOffset: 2,
              }}
            />
          ))}
        </div>
      </div>

      {/* Category list */}
      {(categories || []).length === 0 ? (
        <p style={styles.empty}>No categories yet. Create your first one above.</p>
      ) : (
        <div className="fade-up-2" style={styles.list}>
          {(categories || []).map((cat) =>
            editing?.id === cat.id ? (
              <div key={cat.id} style={styles.editRow}>
                <div style={{ ...styles.dot, background: editing.color }} />
                <input
                  value={editing.name}
                  onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))}
                  style={{ ...styles.input, flex: 1 }}
                  autoFocus
                />
                <div style={styles.miniColors}>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setEditing((p) => ({ ...p, color: c }))}
                      style={{
                        ...styles.colorChip,
                        width: 16,
                        height: 16,
                        background: c,
                        outline: editing.color === c ? "2px solid white" : "none",
                        outlineOffset: 2,
                      }}
                    />
                  ))}
                </div>
                <button style={styles.saveCatBtn} onClick={handleUpdate} disabled={saving}>
                  {saving ? "…" : "Save"}
                </button>
                <button style={styles.cancelBtn} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <div key={cat.id} style={styles.catRow}>
                <div style={{ ...styles.dot, background: cat.color }} />
                <span style={styles.catName}>{cat.name}</span>
                <div style={styles.actions}>
                  <button
                    style={styles.editBtn}
                    onClick={() => setEditing({ id: cat.id, name: cat.name, color: cat.color })}
                  >
                    Edit
                  </button>
                  <button style={styles.deleteBtn} onClick={() => handleDelete(cat.id)}>
                    Delete
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { padding: "36px 40px", maxWidth: 720 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "22px 24px", marginBottom: 24 },
  sectionLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 14 },
  addRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  input: {
    flex: 1, padding: "9px 14px", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: "var(--radius)",
    color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none",
  },
  colorPreview: { width: 28, height: 28, borderRadius: 6, flexShrink: 0, border: "1px solid var(--border)" },
  addBtn: {
    padding: "9px 20px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: "var(--radius)", fontFamily: "var(--font-display)",
    fontWeight: 700, fontSize: 13, cursor: "pointer", flexShrink: 0,
  },
  colorRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  colorChip: { width: 22, height: 22, borderRadius: 5, border: "none", cursor: "pointer", padding: 0 },
  empty: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", textAlign: "center", padding: "48px 0" },
  list: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", overflow: "hidden" },
  catRow: {
    display: "flex", alignItems: "center", gap: 12, padding: "14px 20px",
    borderBottom: "1px solid var(--border)",
  },
  editRow: {
    display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
    borderBottom: "1px solid var(--border)", flexWrap: "wrap",
  },
  dot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  catName: { fontSize: 14, color: "var(--text)", fontWeight: 500, flex: 1 },
  actions: { display: "flex", gap: 8, marginLeft: "auto" },
  editBtn: {
    padding: "5px 14px", background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  deleteBtn: {
    padding: "5px 14px", background: "none", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--red, #ef4444)", fontSize: 12,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  miniColors: { display: "flex", gap: 4, flexWrap: "wrap" },
  saveCatBtn: {
    padding: "6px 14px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: "var(--radius)", fontFamily: "var(--font-display)",
    fontWeight: 700, fontSize: 12, cursor: "pointer",
  },
  cancelBtn: {
    padding: "6px 10px", background: "none", border: "none",
    color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  seedRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius2)", padding: "18px 24px", marginBottom: 16,
  },
  seedLabel: { fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 },
  seedHint: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  seedBtn: {
    padding: "9px 20px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: "var(--radius)", fontFamily: "var(--font-display)",
    fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
  },
  seedMsg: { fontSize: 12, color: "var(--green, #22c55e)", fontFamily: "var(--font-mono)" },
};
