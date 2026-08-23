import React, { useState } from "react";
import {
  fmt, fmtDay, todayIso, periodLabel, verification, apiErrorMessage,
  PERIOD_UNITS, PERIOD_BASES, BASIS_HELP,
} from "./benefitsUtils.js";

// CRUD over the owner-maintained catalog: cards, their benefits, and the match
// rules the tester writes. The contract pins the request bodies but only says
// GET /api/benefits/catalog returns "the raw catalog with match rules", so the
// response is read defensively — a card without `benefits`, or a benefit whose
// rules arrive under `match_rules`, renders empty rather than throwing.

const emptyCard = () => ({
  nickname: "", issuer: "", product: "", account_id: "", anniversary_date: "", annual_fee: "",
});

const emptyBenefit = (card_id) => ({
  card_id, name: "", amount_limit: "", period_unit: "month", period_count: "1",
  period_basis: "calendar", carryover: false, notes: "", verified_on: todayIso(),
});

const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
const strOrNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);

export default function CatalogEditor({
  catalog, loading, error, accounts = [], isMobile,
  onSaveCard, onDeleteCard, onSaveBenefit, onDeleteBenefit, onDeleteRule, onRetry,
}) {
  const [cardForm, setCardForm] = useState(null);       // null | { id?, ...fields }
  const [benefitForm, setBenefitForm] = useState(null); // null | { id?, card_id, ...fields }
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const cards = catalog?.cards || [];

  async function run(fn, onDone) {
    setBusy(true);
    setFormError(null);
    setActionError(null);
    try {
      await fn();
      onDone?.();
    } catch (e) {
      const message = apiErrorMessage(e, "Saving to the catalog");
      if (cardForm || benefitForm) setFormError(message);
      else setActionError(message);
    } finally {
      setBusy(false);
    }
  }

  function submitCard() {
    const payload = {
      ...(cardForm.id ? { id: cardForm.id } : {}),
      nickname: strOrNull(cardForm.nickname),
      issuer: strOrNull(cardForm.issuer),
      product: strOrNull(cardForm.product),
      account_id: strOrNull(cardForm.account_id),
      anniversary_date: strOrNull(cardForm.anniversary_date),
      annual_fee: numOrNull(cardForm.annual_fee),
    };
    run(() => onSaveCard(payload), () => setCardForm(null));
  }

  function submitBenefit() {
    const payload = {
      ...(benefitForm.id ? { id: benefitForm.id } : {}),
      card_id: benefitForm.card_id,
      name: strOrNull(benefitForm.name),
      amount_limit: numOrNull(benefitForm.amount_limit),
      period_unit: benefitForm.period_unit,
      period_count: numOrNull(benefitForm.period_count) ?? 1,
      period_basis: benefitForm.period_basis,
      carryover: !!benefitForm.carryover,
      notes: strOrNull(benefitForm.notes),
      verified_on: strOrNull(benefitForm.verified_on),
    };
    run(() => onSaveBenefit(payload), () => setBenefitForm(null));
  }

  if (loading && !catalog) return <p style={styles.muted}>Loading catalog…</p>;

  if (error) {
    return (
      <div>
        <div style={styles.errorBox}>{error}</div>
        <button style={styles.secondaryBtn} onClick={onRetry} disabled={loading}>
          {loading ? "Retrying…" : "Try again"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p style={styles.intro}>
        The catalog is owner-maintained: amounts, reset basis and match patterns come from your card's own
        benefits guide, not from a lineup someone remembered. Stamp <b>Verified on</b> whenever you re-check a
        row — anything older than a year is flagged as stale in the Status tab.
      </p>

      {actionError && <div style={styles.errorBox}>{actionError}</div>}

      {cards.length === 0 && <p style={styles.muted}>No cards yet.</p>}

      {cards.map((card) => {
        const benefits = card.benefits || [];
        return (
          <section key={card.id} style={styles.card}>
            <div style={styles.cardHead}>
              <div style={{ minWidth: 0 }}>
                <h2 style={styles.cardTitle}>{card.nickname || card.product || "Card"}</h2>
                <p style={styles.cardSub}>
                  {[card.issuer, card.product].filter(Boolean).join(" · ") || "—"} · fee {fmt(card.annual_fee)} ·
                  anniversary {fmtDay(card.anniversary_date)}
                </p>
                <p style={styles.cardSub}>
                  {card.account_id
                    ? `Account ${accounts.find((a) => a.account_id === card.account_id)?.name || card.account_id}`
                    : "No Plaid account linked"}
                </p>
              </div>
              <div style={styles.headActions}>
                <button style={styles.secondaryBtn} disabled={busy} onClick={() => { setBenefitForm(null); setCardForm({ id: card.id, nickname: card.nickname || "", issuer: card.issuer || "", product: card.product || "", account_id: card.account_id || "", anniversary_date: card.anniversary_date || "", annual_fee: card.annual_fee ?? "" }); }}>
                  Edit card
                </button>
                <button
                  style={styles.deleteBtn}
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Delete ${card.nickname || "this card"}? Its benefits and match rules go with it.`)) return;
                    run(() => onDeleteCard(card.id));
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            {cardForm?.id === card.id && (
              <CardForm
                value={cardForm}
                onChange={setCardForm}
                accounts={accounts}
                busy={busy}
                error={formError}
                isMobile={isMobile}
                onSubmit={submitCard}
                onCancel={() => { setCardForm(null); setFormError(null); }}
              />
            )}

            {benefits.length === 0 && <p style={styles.muted}>No benefits on this card yet.</p>}

            {benefits.map((b) => {
              const rules = b.rules || b.match_rules || [];
              const ver = verification(b.verified_on);
              return (
                <div key={b.id} style={styles.benefit}>
                  <div style={styles.benefitHead}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={styles.benefitName}>{b.name}</p>
                      <p style={styles.benefitSub}>
                        {fmt(b.amount_limit)} · {periodLabel({ unit: b.period_unit, count: b.period_count })} ·{" "}
                        <span title={BASIS_HELP[b.period_basis] || ""} style={styles.basisTag}>{b.period_basis}</span>
                        {b.carryover ? " · carryover" : ""}
                      </p>
                      <p style={{ ...styles.verified, color: ver.stale ? "var(--amber, #f59e0b)" : "var(--muted)" }}>
                        {ver.stale ? "⚠ " : ""}{ver.label}{ver.stale && ver.days != null ? ` · ${ver.days} days ago` : ""}
                      </p>
                      {b.notes && <p style={styles.notes}>{b.notes}</p>}
                    </div>
                    <div style={styles.headActions}>
                      <button
                        style={styles.secondaryBtn}
                        disabled={busy}
                        onClick={() => {
                          setCardForm(null);
                          setBenefitForm({
                            id: b.id, card_id: card.id, name: b.name || "", amount_limit: b.amount_limit ?? "",
                            period_unit: b.period_unit || "month", period_count: String(b.period_count ?? 1),
                            period_basis: b.period_basis || "calendar", carryover: !!b.carryover,
                            notes: b.notes || "", verified_on: b.verified_on || "",
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        style={styles.deleteBtn}
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete the "${b.name}" benefit?`)) return;
                          run(() => onDeleteBenefit(b.id));
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {rules.length > 0 && (
                    <div style={styles.rules}>
                      {rules.map((rule) => (
                        <div key={rule.id} style={styles.ruleRow}>
                          <span style={styles.mono}>
                            /{rule.merchant_regex}/
                            {rule.amount_min != null || rule.amount_max != null
                              ? ` · ${rule.amount_min ?? "…"}–${rule.amount_max ?? "…"}`
                              : ""}
                            {rule.category ? ` · ${rule.category}` : ""}
                            {rule.direction ? ` · ${rule.direction}` : ""}
                          </span>
                          <button
                            style={styles.deleteBtn}
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm("Delete this match rule?")) return;
                              run(() => onDeleteRule(rule.id));
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {benefitForm?.id === b.id && (
                    <BenefitForm
                      value={benefitForm}
                      onChange={setBenefitForm}
                      busy={busy}
                      error={formError}
                      isMobile={isMobile}
                      onSubmit={submitBenefit}
                      onCancel={() => { setBenefitForm(null); setFormError(null); }}
                    />
                  )}
                </div>
              );
            })}

            {benefitForm && !benefitForm.id && benefitForm.card_id === card.id ? (
              <BenefitForm
                value={benefitForm}
                onChange={setBenefitForm}
                busy={busy}
                error={formError}
                isMobile={isMobile}
                onSubmit={submitBenefit}
                onCancel={() => { setBenefitForm(null); setFormError(null); }}
              />
            ) : (
              <button
                style={styles.secondaryBtn}
                disabled={busy}
                onClick={() => { setCardForm(null); setBenefitForm(emptyBenefit(card.id)); }}
              >
                + Add benefit
              </button>
            )}
          </section>
        );
      })}

      {cardForm && !cardForm.id ? (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>New card</h2>
          <CardForm
            value={cardForm}
            onChange={setCardForm}
            accounts={accounts}
            busy={busy}
            error={formError}
            isMobile={isMobile}
            onSubmit={submitCard}
            onCancel={() => { setCardForm(null); setFormError(null); }}
          />
        </section>
      ) : (
        <button style={styles.primaryBtn} disabled={busy} onClick={() => { setBenefitForm(null); setCardForm(emptyCard()); }}>
          + Add card
        </button>
      )}
    </div>
  );
}

function CardForm({ value, onChange, accounts, busy, error, isMobile, onSubmit, onCancel }) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div style={styles.form}>
      <div style={{ ...styles.formGrid, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label="Nickname">
          <input style={styles.input} value={value.nickname} onChange={(e) => set({ nickname: e.target.value })} placeholder="Amex Platinum" />
        </Field>
        <Field label="Issuer">
          <input style={styles.input} value={value.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="American Express" />
        </Field>
        <Field label="Product">
          <input style={styles.input} value={value.product} onChange={(e) => set({ product: e.target.value })} placeholder="Platinum" />
        </Field>
        <Field label="Plaid account" hint="Only credit accounts can carry card benefits. Without one, nothing matches automatically.">
          <select style={styles.input} value={value.account_id || ""} onChange={(e) => set({ account_id: e.target.value })}>
            <option value="">Not linked</option>
            {accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.name}{a.mask ? ` ···· ${a.mask}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Anniversary date" hint="Anchors every anniversary-basis credit on this card.">
          <input style={styles.input} type="date" value={value.anniversary_date || ""} onChange={(e) => set({ anniversary_date: e.target.value })} />
        </Field>
        <Field label="Annual fee">
          <input style={styles.input} type="number" step="0.01" value={value.annual_fee} onChange={(e) => set({ annual_fee: e.target.value })} placeholder="895" />
        </Field>
      </div>
      {error && <p style={styles.formError}>{error}</p>}
      <div style={styles.formActions}>
        <button style={styles.primaryBtn} disabled={busy} onClick={onSubmit}>{busy ? "Saving…" : "Save card"}</button>
        <button style={styles.secondaryBtn} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function BenefitForm({ value, onChange, busy, error, isMobile, onSubmit, onCancel }) {
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div style={styles.form}>
      <div style={{ ...styles.formGrid, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Field label="Name">
          <input style={styles.input} value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="Uber Cash" />
        </Field>
        <Field label="Amount limit">
          <input style={styles.input} type="number" step="0.01" value={value.amount_limit} onChange={(e) => set({ amount_limit: e.target.value })} placeholder="15" />
        </Field>
        <Field label="Period unit">
          <select style={styles.input} value={value.period_unit} onChange={(e) => set({ period_unit: e.target.value })}>
            {PERIOD_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </Field>
        <Field label="Period count" hint="How many units make one period — 1 quarter, 4 months, and so on.">
          <input style={styles.input} type="number" min="1" step="1" value={value.period_count} onChange={(e) => set({ period_count: e.target.value })} />
        </Field>
        <Field label="Period basis" hint={BASIS_HELP[value.period_basis]}>
          <select style={styles.input} value={value.period_basis} onChange={(e) => set({ period_basis: e.target.value })}>
            {PERIOD_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Field>
        <Field label="Verified on" hint="The date you last checked this row against the card's benefits guide. Older than a year shows as stale.">
          <input style={styles.input} type="date" value={value.verified_on || ""} onChange={(e) => set({ verified_on: e.target.value })} />
        </Field>
        <Field label="Notes">
          <input style={styles.input} value={value.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Enrollment required" />
        </Field>
        <Field label="Carryover" hint="Unused amount rolls into the next period instead of expiring.">
          <label style={styles.checkRow}>
            <input type="checkbox" checked={!!value.carryover} onChange={(e) => set({ carryover: e.target.checked })} />
            <span style={styles.checkLabel}>Unused amount carries over</span>
          </label>
        </Field>
      </div>
      <p style={styles.basisNote}>
        Getting the basis wrong silently corrupts every figure downstream: <b>calendar</b> credits reset on Jan 1
        (or on the calendar month/quarter boundary), <b>anniversary</b> credits reset on the card's account
        anniversary.
      </p>
      {error && <p style={styles.formError}>{error}</p>}
      <div style={styles.formActions}>
        <button style={styles.primaryBtn} disabled={busy} onClick={onSubmit}>{busy ? "Saving…" : "Save benefit"}</button>
        <button style={styles.secondaryBtn} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <p style={styles.fieldLabel}>{label}</p>
      {children}
      {hint && <p style={styles.hint}>{hint}</p>}
    </div>
  );
}

const styles = {
  intro: { fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 },
  muted: { color: "var(--muted)", fontSize: 13, marginBottom: 10 },
  errorBox: {
    padding: "10px 14px", marginBottom: 16, background: "var(--surface)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
    color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.6,
  },

  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 22px", marginBottom: 20 },
  cardHead: { display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 },
  cardSub: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 3 },
  headActions: { display: "flex", gap: 6, alignItems: "flex-start", flexShrink: 0 },

  benefit: { border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px", marginBottom: 10 },
  benefitHead: { display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  benefitName: { fontSize: 14, fontWeight: 600, color: "var(--text)" },
  benefitSub: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 },
  basisTag: { border: "1px solid var(--border2)", borderRadius: 4, padding: "1px 5px", cursor: "help" },
  verified: { fontSize: 11, fontFamily: "var(--font-mono)", marginTop: 3 },
  notes: { fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 },

  rules: { marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 6 },
  ruleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "3px 0" },
  mono: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  form: { border: "1px solid var(--border2)", borderRadius: "var(--radius)", padding: 14, marginBottom: 12, background: "var(--surface2)" },
  formGrid: { display: "grid", gap: 12 },
  fieldLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 },
  hint: { fontSize: 10, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 },
  input: { width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, padding: "7px 9px", fontFamily: "var(--font-mono)", boxSizing: "border-box" },
  checkRow: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0" },
  checkLabel: { fontSize: 12, color: "var(--text)" },
  basisNote: { fontSize: 11, color: "var(--muted)", lineHeight: 1.6, marginTop: 12 },
  formError: { marginTop: 10, fontSize: 11, color: "var(--red)", fontFamily: "var(--font-mono)", lineHeight: 1.6 },
  formActions: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" },

  primaryBtn: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  secondaryBtn: { background: "none", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  deleteBtn: { background: "none", color: "var(--red)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 10px", fontSize: 12, cursor: "pointer" },
};
