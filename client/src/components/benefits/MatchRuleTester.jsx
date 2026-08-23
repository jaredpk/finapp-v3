import React, { useState } from "react";
import { testMatchRule } from "../../api.js";
import { fmt, apiErrorMessage, RULE_DIRECTIONS } from "./benefitsUtils.js";

// Dry-runs a match rule against real transactions before it is written onto a
// benefit. The test itself is transient UI state so it calls the API directly;
// saving the rule changes shared catalog data, so that goes back through the
// parent like every other write in this view.
//
// Two things this has to be honest about:
//   * `sample` is capped server-side, so a `truncated: true` result says so in
//     words. A capped list that reads as complete is the bug the cap exists to
//     prevent.
//   * an invalid regex comes back as a 400 with the Postgres parse error; it
//     belongs against the field as a validation message, not as a dead panel.

const emptyForm = {
  account_id: "", merchant_regex: "", amount_min: "", amount_max: "",
  category: "", start_date: "", end_date: "",
};

export default function MatchRuleTester({ benefits = [], benefitsError, accounts = [], isMobile, onSaveRule }) {
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [regexError, setRegexError] = useState(null);

  const [benefitId, setBenefitId] = useState("");
  const [direction, setDirection] = useState("charge");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(null);

  // Any edit invalidates the last run, so a rule can only be saved from a
  // result that actually describes it.
  function set(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
    setResult(null);
    setRegexError(null);
    setSaved(null);
  }

  async function runTest() {
    setLoading(true);
    setError(null);
    setRegexError(null);
    setSaved(null);
    try {
      const body = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === "" || v == null) continue;
        body[k] = k === "amount_min" || k === "amount_max" ? Number(v) : v;
      }
      setResult(await testMatchRule(body));
    } catch (e) {
      setResult(null);
      if (e?.status === 400) setRegexError(e.message);
      else setError(apiErrorMessage(e, "The match-rule tester"));
    } finally {
      setLoading(false);
    }
  }

  async function saveRule() {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      await onSaveRule({
        benefit_id: Number(benefitId),
        merchant_regex: form.merchant_regex,
        amount_min: form.amount_min === "" ? null : Number(form.amount_min),
        amount_max: form.amount_max === "" ? null : Number(form.amount_max),
        category: form.category || null,
        direction,
      });
      setSaved("Rule saved onto the benefit.");
    } catch (e) {
      setSaveError(apiErrorMessage(e, "Saving the rule"));
    } finally {
      setSaving(false);
    }
  }

  const sample = result?.sample || [];
  const canSave = !!result && !!benefitId && form.merchant_regex.trim() !== "";

  return (
    <div>
      <p style={styles.intro}>
        Try a match rule against real transactions before committing it. The pattern is applied server-side
        against merchant, name and original description.
      </p>

      <section style={styles.card}>
        <div style={{ ...styles.grid, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <div style={{ gridColumn: isMobile ? "auto" : "1 / -1" }}>
            <p style={styles.fieldLabel}>Merchant regex</p>
            <input
              style={{ ...styles.input, ...(regexError ? styles.inputInvalid : {}) }}
              value={form.merchant_regex}
              onChange={(e) => set({ merchant_regex: e.target.value })}
              placeholder="UBER( |\*)"
            />
            {regexError && <p style={styles.fieldError}>{regexError}</p>}
          </div>

          <div>
            <p style={styles.fieldLabel}>Account</p>
            <select style={styles.input} value={form.account_id} onChange={(e) => set({ account_id: e.target.value })}>
              <option value="">Any account</option>
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.name}{a.mask ? ` ···· ${a.mask}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p style={styles.fieldLabel}>Category</p>
            <input
              style={styles.input}
              value={form.category}
              onChange={(e) => set({ category: e.target.value })}
              placeholder="Optional Plaid category"
            />
          </div>

          <div>
            <p style={styles.fieldLabel}>Amount min</p>
            <input style={styles.input} type="number" step="0.01" value={form.amount_min} onChange={(e) => set({ amount_min: e.target.value })} />
          </div>

          <div>
            <p style={styles.fieldLabel}>Amount max</p>
            <input style={styles.input} type="number" step="0.01" value={form.amount_max} onChange={(e) => set({ amount_max: e.target.value })} />
          </div>

          <div>
            <p style={styles.fieldLabel}>Start date</p>
            <input style={styles.input} type="date" value={form.start_date} onChange={(e) => set({ start_date: e.target.value })} />
          </div>

          <div>
            <p style={styles.fieldLabel}>End date</p>
            <input style={styles.input} type="date" value={form.end_date} onChange={(e) => set({ end_date: e.target.value })} />
          </div>
        </div>

        <div style={styles.actions}>
          <button style={styles.primaryBtn} onClick={runTest} disabled={loading || form.merchant_regex.trim() === ""}>
            {loading ? "Testing…" : "Test rule"}
          </button>
          <button style={styles.secondaryBtn} onClick={() => { setForm(emptyForm); setResult(null); setError(null); setRegexError(null); setSaved(null); }} disabled={loading}>
            Reset
          </button>
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}
      </section>

      {result && (
        <section style={styles.card}>
          <p style={styles.resultCount}>
            {result.count} matching transaction{result.count === 1 ? "" : "s"}
          </p>
          {result.truncated ? (
            <p style={styles.truncated}>
              ⚠ Capped result — showing {sample.length} of at least {result.count}. There are more matches than
              this list can show, so treat the count as a floor, not a total.
            </p>
          ) : (
            <p style={styles.resultSub}>Showing {sample.length} of {result.count} — the full set.</p>
          )}

          {sample.length === 0 ? (
            <p style={styles.muted}>Nothing matched.</p>
          ) : (
            <div style={styles.table}>
              {/* Narrow screens fold date and account into the merchant cell
                  rather than pushing a four-column grid off the viewport. */}
              <div style={{ ...styles.tableHeader, gridTemplateColumns: isMobile ? "minmax(0,1fr) 90px" : "96px minmax(0,1fr) 100px 140px" }}>
                {!isMobile && <span>Date</span>}
                <span>{isMobile ? "Transaction" : "Merchant"}</span>
                <span style={styles.right}>Amount</span>
                {!isMobile && <span>Account</span>}
              </div>
              {sample.map((row, i) => (
                <div key={row.id || i} style={{ ...styles.row, gridTemplateColumns: isMobile ? "minmax(0,1fr) 90px" : "96px minmax(0,1fr) 100px 140px" }}>
                  {!isMobile && <span style={styles.mono}>{row.date}</span>}
                  <span style={styles.merchant}>
                    {row.merchant}
                    {isMobile && <span style={styles.subLine}>{row.date} · {row.account}</span>}
                  </span>
                  <span style={{ ...styles.mono, ...styles.right }}>{fmt(row.amount)}</span>
                  {!isMobile && <span style={styles.monoMuted}>{row.account}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section style={styles.card}>
        <p style={styles.cardTitle}>Save this rule onto a benefit</p>
        {benefitsError && <div style={styles.errorBox}>{benefitsError}</div>}
        {!benefitsError && benefits.length === 0 && (
          <p style={styles.muted}>No benefits in the catalog yet — add one in the Catalog tab first.</p>
        )}
        <div style={{ ...styles.grid, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <div>
            <p style={styles.fieldLabel}>Benefit</p>
            <select style={styles.input} value={benefitId} onChange={(e) => { setBenefitId(e.target.value); setSaved(null); }} disabled={benefits.length === 0}>
              <option value="">Choose a benefit</option>
              {benefits.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </div>
          <div>
            <p style={styles.fieldLabel}>Direction</p>
            <select style={styles.input} value={direction} onChange={(e) => { setDirection(e.target.value); setSaved(null); }}>
              {RULE_DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        </div>
        <p style={styles.hint}>
          A saved rule keeps the pattern, amount bounds, category and direction. The account and date range above
          are test filters only and are not part of the rule.
        </p>
        <div style={styles.actions}>
          <button style={styles.primaryBtn} onClick={saveRule} disabled={!canSave || saving}>
            {saving ? "Saving…" : "Save rule"}
          </button>
          {!result && <span style={styles.hint}>Run the test first — a rule saves from the result that describes it.</span>}
        </div>
        {saveError && <div style={styles.errorBox}>{saveError}</div>}
        {saved && <p style={styles.saved}>{saved}</p>}
      </section>
    </div>
  );
}

const styles = {
  intro: { fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 16 },
  muted: { color: "var(--muted)", fontSize: 13, marginBottom: 8 },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 22px", marginBottom: 20 },
  cardTitle: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 14 },

  grid: { display: "grid", gap: 12 },
  fieldLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 },
  input: { width: "100%", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, padding: "7px 9px", fontFamily: "var(--font-mono)", boxSizing: "border-box" },
  inputInvalid: { borderColor: "var(--red)" },
  fieldError: { marginTop: 5, fontSize: 11, color: "var(--red)", fontFamily: "var(--font-mono)", lineHeight: 1.5 },
  hint: { fontSize: 11, color: "var(--muted)", lineHeight: 1.6, marginTop: 10 },

  actions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 14 },
  primaryBtn: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  secondaryBtn: { background: "none", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },

  errorBox: {
    padding: "10px 14px", marginTop: 14, background: "var(--surface)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
    color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.6,
  },
  saved: { marginTop: 12, fontSize: 12, color: "var(--green)", fontFamily: "var(--font-mono)" },

  resultCount: { fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" },
  resultSub: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 4, marginBottom: 12 },
  truncated: {
    fontSize: 11, color: "var(--amber, #f59e0b)", fontFamily: "var(--font-mono)", lineHeight: 1.6,
    marginTop: 6, marginBottom: 12, padding: "8px 10px",
    border: "1px solid var(--amber, #f59e0b)", borderRadius: "var(--radius)",
  },

  table: { borderTop: "1px solid var(--border)" },
  tableHeader: {
    display: "grid", gap: 8, padding: "8px 4px", background: "var(--surface2)",
    fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase",
    color: "var(--muted)", fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)",
  },
  row: { display: "grid", gap: 8, padding: "8px 4px", borderBottom: "1px solid var(--border)", alignItems: "center" },
  mono: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)" },
  monoMuted: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  merchant: { fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  subLine: { display: "block", fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" },
  right: { textAlign: "right" },
};
