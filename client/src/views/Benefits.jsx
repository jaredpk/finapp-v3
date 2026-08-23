import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchBenefitStatus, fetchBenefitCatalog,
  saveBenefitCard, deleteBenefitCard, saveBenefit, deleteBenefit,
  saveMatchRule, deleteMatchRule, markBenefitUsed, unmarkBenefitUsed,
} from "../api.js";
import useIsMobile from "../hooks/useIsMobile.js";
import CatalogEditor from "../components/benefits/CatalogEditor.jsx";
import MatchRuleTester from "../components/benefits/MatchRuleTester.jsx";
import {
  fmt, fmtDay, todayIso, statusMeta, periodLabel, verification, apiErrorMessage, BASIS_HELP,
} from "../components/benefits/benefitsUtils.js";

const TABS = [
  { id: "status", label: "Status" },
  { id: "catalog", label: "Catalog" },
  { id: "tester", label: "Rule tester" },
];

// `accounts` is the same payload the rest of the app already has from
// fetchAccounts (App.jsx loads it once and passes it to every view, as Settings
// does), so the card editor's account picker costs no extra request.
export default function Benefits({ accounts = [] }) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("status");
  const [asOf, setAsOf] = useState(todayIso());

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(null);

  const [catalog, setCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(null);

  // Per-benefit busy/error for mark-used and undo, so one failing row reports
  // itself instead of blanking the panel.
  const [rowBusy, setRowBusy] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  const creditAccounts = useMemo(() => accounts.filter((a) => a.type === "credit"), [accounts]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await fetchBenefitStatus(asOf));
    } catch (e) {
      setStatusError(apiErrorMessage(e, "Benefit status"));
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, [asOf]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await fetchBenefitCatalog());
    } catch (e) {
      setCatalogError(apiErrorMessage(e, "The benefit catalog"));
      setCatalog(null);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  async function handleMarkUsed(benefit, body) {
    setRowBusy(benefit.id);
    setRowErrors((prev) => ({ ...prev, [benefit.id]: null }));
    try {
      await markBenefitUsed(benefit.id, { period_key: benefit.period_key, ...body });
      await loadStatus();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [benefit.id]: apiErrorMessage(e, "Marking this benefit used") }));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleUnmark(benefit) {
    setRowBusy(benefit.id);
    setRowErrors((prev) => ({ ...prev, [benefit.id]: null }));
    try {
      await unmarkBenefitUsed(benefit.id, { period_key: benefit.period_key });
      await loadStatus();
    } catch (e) {
      setRowErrors((prev) => ({ ...prev, [benefit.id]: apiErrorMessage(e, "Undoing the manual entry") }));
    } finally {
      setRowBusy(null);
    }
  }

  // Catalog mutations are owned here, the way PropertyFinance owns its writes;
  // the editor keeps the form state and surfaces whatever these throw.
  async function handleSaveCard(card) {
    await saveBenefitCard(card);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  async function handleDeleteCard(id) {
    await deleteBenefitCard(id);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  async function handleSaveBenefit(benefit) {
    await saveBenefit(benefit);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  async function handleDeleteBenefit(id) {
    await deleteBenefit(id);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  async function handleSaveRule(rule) {
    await saveMatchRule(rule);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  async function handleDeleteRule(id) {
    await deleteMatchRule(id);
    await Promise.all([loadCatalog(), loadStatus()]);
  }

  // The tester saves onto a benefit, so it needs the flat list. The catalog is
  // the better source; the status payload stands in when the catalog call is
  // the one that failed.
  const benefitOptions = useMemo(() => {
    const cards = catalog?.cards || status?.cards || [];
    return cards.flatMap((c) =>
      (c.benefits || []).map((b) => ({ id: b.id, label: `${c.nickname || c.product || "Card"} — ${b.name}` }))
    );
  }, [catalog, status]);

  const cards = status?.cards || [];
  const staleCount = cards.reduce(
    (n, c) => n + (c.benefits || []).filter((b) => verification(b.verified_on).stale).length,
    0
  );

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Benefits</h1>

      <div style={styles.toolbar}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ ...styles.chip, ...(tab === t.id ? styles.chipActive : {}) }}
          >
            {t.label}
          </button>
        ))}
        {tab === "status" && (
          <>
            <span style={styles.asOfLabel}>As of</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              style={styles.dateInput}
            />
            <button onClick={loadStatus} style={styles.chip} disabled={statusLoading}>
              {statusLoading ? "Loading…" : "Refresh"}
            </button>
          </>
        )}
      </div>

      {tab === "status" && (
        <>
          {statusError && <div style={styles.errorBox}>{statusError}</div>}

          {staleCount > 0 && !statusError && (
            <div style={styles.warnBox}>
              {staleCount} benefit{staleCount === 1 ? "" : "s"} {staleCount === 1 ? "has" : "have"} not been
              verified against the issuer's benefits guide in over a year. Issuers rework these lineups —
              re-check them in the Catalog tab before trusting the numbers below.
            </div>
          )}

          {statusLoading && !status && <p style={styles.muted}>Loading benefit status…</p>}

          {!statusLoading && !statusError && cards.length === 0 && (
            <p style={styles.muted}>
              No cards in the benefit catalog yet. Add one in the Catalog tab, then its credits show up here.
            </p>
          )}

          {cards.map((card) => (
            <CardPanel
              key={card.id}
              card={card}
              accounts={accounts}
              isMobile={isMobile}
              rowBusy={rowBusy}
              rowErrors={rowErrors}
              onMarkUsed={handleMarkUsed}
              onUnmark={handleUnmark}
            />
          ))}
        </>
      )}

      {tab === "catalog" && (
        <CatalogEditor
          catalog={catalog}
          loading={catalogLoading}
          error={catalogError}
          accounts={creditAccounts}
          isMobile={isMobile}
          onSaveCard={handleSaveCard}
          onDeleteCard={handleDeleteCard}
          onSaveBenefit={handleSaveBenefit}
          onDeleteBenefit={handleDeleteBenefit}
          onDeleteRule={handleDeleteRule}
          onRetry={loadCatalog}
        />
      )}

      {tab === "tester" && (
        <MatchRuleTester
          benefits={benefitOptions}
          benefitsError={catalogError}
          accounts={accounts}
          isMobile={isMobile}
          onSaveRule={handleSaveRule}
        />
      )}
    </div>
  );
}

function CardPanel({ card, accounts, isMobile, rowBusy, rowErrors, onMarkUsed, onUnmark }) {
  const linked = accounts.find((a) => a.account_id === card.account_id);
  const benefits = card.benefits || [];

  return (
    <section style={styles.card}>
      <div style={styles.cardHead}>
        <div style={{ minWidth: 0 }}>
          <h2 style={styles.cardTitle}>{card.nickname || card.product || "Card"}</h2>
          <p style={styles.cardSub}>
            {[card.issuer, card.product].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <div style={styles.cardMeta}>
          <span style={styles.metaItem}>Annual fee {fmt(card.annual_fee)}</span>
          <span style={styles.metaItem}>Anniversary {fmtDay(card.anniversary_date)}</span>
          <span style={styles.metaItem}>History from {fmtDay(card.history_start)}</span>
        </div>
      </div>

      {card.account_id ? (
        <p style={styles.accountLine}>
          Matching against {linked ? `${linked.name}${linked.mask ? ` ···· ${linked.mask}` : ""}` : card.account_id}
        </p>
      ) : (
        <p style={{ ...styles.accountLine, color: "var(--amber, #f59e0b)" }}>
          No Plaid account linked — nothing can match automatically on this card.
        </p>
      )}

      {benefits.length === 0 && <p style={styles.muted}>No benefits on this card yet.</p>}

      {benefits.map((b) => (
        <BenefitRow
          key={b.id}
          benefit={b}
          card={card}
          isMobile={isMobile}
          busy={rowBusy === b.id}
          error={rowErrors[b.id]}
          onMarkUsed={onMarkUsed}
          onUnmark={onUnmark}
        />
      ))}
    </section>
  );
}

function BenefitRow({ benefit, card, isMobile, busy, error, onMarkUsed, onUnmark }) {
  const [showMatches, setShowMatches] = useState(false); // matched transactions are collapsed by default
  const [marking, setMarking] = useState(false);

  const meta = statusMeta(benefit.status);
  const matches = benefit.matches || [];
  const hasManual = matches.some((m) => m.source === "manual");
  const limit = Number(benefit.amount_limit) || 0;
  const used = Number(benefit.amount_used) || 0;
  const pct = limit > 0 ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : 0;
  const ver = verification(benefit.verified_on);
  const basis = benefit.period?.basis;

  return (
    <div style={{ ...styles.benefit, ...(meta.dashed ? styles.benefitDashed : {}) }}>
      <div style={{ ...styles.benefitHead, flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-start" : "center" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={styles.benefitName}>{benefit.name}</p>
          <p style={styles.benefitSub}>
            {periodLabel(benefit.period)}
            {basis && (
              <span title={BASIS_HELP[basis] || ""} style={styles.basisTag}>{basis}</span>
            )}
            {benefit.carryover && (
              <span style={styles.basisTag} title="Captured for a later phase — carryover is not applied to any figure here.">
                carryover (not applied)
              </span>
            )}
          </p>
        </div>
        <span
          style={{
            ...styles.statusChip,
            color: meta.color,
            border: `1px ${meta.dashed ? "dashed" : "solid"} ${meta.color}`,
          }}
          title={meta.note}
        >
          {meta.glyph} {meta.label}
        </span>
      </div>

      {/* Progress. A window we cannot see (insufficient-history) or could not
          evaluate (rule-error) is hatched rather than filled, so neither can be
          mistaken for an untouched (green) credit. */}
      <div style={styles.barTrack}>
        <div
          style={{
            ...styles.barFill,
            width: `${meta.hatched ? 100 : pct}%`,
            background: meta.hatched
              ? "repeating-linear-gradient(45deg, var(--border2) 0 5px, transparent 5px 10px)"
              : meta.color,
            opacity: meta.hatched ? 1 : 0.85,
          }}
        />
      </div>

      <div style={styles.amountRow}>
        <span style={styles.amountMain}>
          {meta.amountCaption ? (
            <>{fmt(used)} seen of {fmt(limit)} — {meta.amountCaption}</>
          ) : (
            <>{fmt(used)} of {fmt(limit)} used{limit > 0 ? ` · ${fmt(benefit.amount_remaining)} left` : ""}</>
          )}
        </span>
        <span style={styles.amountSub}>
          {benefit.days_left != null ? `${benefit.days_left} day${benefit.days_left === 1 ? "" : "s"} left` : "—"}
          {" · period ends "}{fmtDay(benefit.period_end)}
          {benefit.period_key ? ` (${benefit.period_key})` : ""}
        </span>
      </div>

      {(meta.alwaysShowNote || false) && (
        <p style={{ ...styles.note, color: meta.color }}>
          {meta.note}
          {benefit.status === "insufficient-history" && card.history_start
            ? ` History on this card starts ${fmtDay(card.history_start)}; this period starts ${fmtDay(benefit.period_start)}.`
            : ""}
          {/* Which rule broke, verbatim from Postgres, so the owner fixes that
              one instead of hunting through the catalog. */}
          {benefit.rule_error ? ` ${benefit.rule_error}` : ""}
        </p>
      )}

      <div style={styles.metaLine}>
        <span
          style={{ ...styles.verified, color: ver.stale ? "var(--amber, #f59e0b)" : "var(--muted)" }}
          title={ver.stale ? "Issuers rework benefit lineups — re-check this row against the card's benefits guide." : ""}
        >
          {ver.stale ? "⚠ " : ""}{ver.label}{ver.stale && ver.days != null ? ` · ${ver.days} days ago` : ""}
        </span>
        {benefit.confidence && <span style={styles.confidence}>confidence: {benefit.confidence}</span>}
      </div>

      {benefit.notes && <p style={styles.notes}>{benefit.notes}</p>}

      <div style={styles.actions}>
        <button style={styles.linkBtn} onClick={() => setShowMatches((v) => !v)}>
          {/* A sample says so: the server lists a bounded number of matches and
              rolls the rest into the amount (see matches_truncated). */}
          {showMatches ? "▾" : "▸"} {matches.length}{benefit.matches_truncated ? "+" : ""} matched
          {" "}transaction{matches.length === 1 && !benefit.matches_truncated ? "" : "s"}
        </button>
        {!marking && (
          <button style={styles.smallBtn} onClick={() => setMarking(true)} disabled={busy}>
            Mark as used
          </button>
        )}
        {hasManual && (
          <button style={styles.undoBtn} onClick={() => onUnmark(benefit)} disabled={busy}>
            {busy ? "Working…" : "Undo manual entry"}
          </button>
        )}
      </div>

      {marking && (
        <MarkUsedForm
          benefit={benefit}
          busy={busy}
          onCancel={() => setMarking(false)}
          onSubmit={async (body) => { await onMarkUsed(benefit, body); setMarking(false); }}
        />
      )}

      {error && <p style={styles.rowError}>{error}</p>}

      {showMatches && (
        matches.length === 0 ? (
          <p style={styles.muted}>No transactions matched this period.</p>
        ) : (
          <div style={styles.matchTable}>
            {/* Narrow screens fold the date and the auto/manual source into the
                merchant cell instead of pushing four columns off the viewport. */}
            {matches.map((m, i) => (
              <div key={m.txn_id || i} style={{ ...styles.matchRow, gridTemplateColumns: isMobile ? "minmax(0,1fr) 90px" : "96px minmax(0,1fr) 90px 70px" }}>
                {!isMobile && <span style={styles.mono}>{m.date}</span>}
                <span style={styles.matchMerchant}>
                  {m.merchant}
                  {isMobile && <span style={styles.subLine}>{m.date} · {m.source}</span>}
                </span>
                <span style={{ ...styles.mono, textAlign: "right" }}>{fmt(m.amount)}</span>
                {!isMobile && <span style={{ ...styles.source, textAlign: "center" }}>{m.source}</span>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function MarkUsedForm({ benefit, busy, onCancel, onSubmit }) {
  const [amount, setAmount] = useState(
    benefit.amount_remaining != null ? String(benefit.amount_remaining) : String(benefit.amount_limit ?? "")
  );
  const [note, setNote] = useState("");

  return (
    <div style={styles.markForm}>
      <label style={styles.fieldLabel}>Amount</label>
      <input
        style={{ ...styles.input, width: 100 }}
        type="number"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        style={{ ...styles.input, flex: 1, minWidth: 140 }}
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        style={styles.smallPrimary}
        disabled={busy || amount === ""}
        onClick={() => onSubmit({ amount: Number(amount), note: note.trim() || null })}
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button style={styles.smallBtn} onClick={onCancel} disabled={busy}>Cancel</button>
      <span style={styles.formHint}>Manual entries are never overwritten by automatic matching.</span>
    </div>
  );
}

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 1100 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },

  toolbar: { display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" },
  chip: {
    padding: "7px 14px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 99, color: "var(--muted)", fontSize: 12, fontWeight: 600,
    fontFamily: "var(--font-mono)", cursor: "pointer",
  },
  chipActive: { background: "var(--surface2)", border: "1px solid var(--accent)", color: "var(--text)" },
  asOfLabel: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginLeft: 4 },
  dateInput: {
    padding: "7px 10px", background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12,
    fontFamily: "var(--font-mono)", outline: "none",
  },

  errorBox: {
    padding: "10px 14px", marginBottom: 16, background: "var(--surface)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
    color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.6,
  },
  warnBox: {
    padding: "10px 14px", marginBottom: 16, background: "var(--surface)",
    border: "1px solid var(--amber, #f59e0b)", borderRadius: "var(--radius)",
    color: "var(--amber, #f59e0b)", fontSize: 12, fontFamily: "var(--font-mono)", lineHeight: 1.6,
  },
  muted: { color: "var(--muted)", fontSize: 13, marginBottom: 8 },

  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 22px", marginBottom: 20 },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" },
  cardTitle: { fontSize: 17, fontWeight: 700, color: "var(--text)", margin: 0 },
  cardSub: { fontSize: 12, color: "var(--muted)", marginTop: 2 },
  cardMeta: { display: "flex", gap: 10, flexWrap: "wrap" },
  metaItem: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  accountLine: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)", margin: "8px 0 14px" },

  benefit: { border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 14px", marginBottom: 10 },
  benefitDashed: { borderStyle: "dashed", background: "var(--surface2)" },
  benefitHead: { display: "flex", gap: 8, marginBottom: 8 },
  benefitName: { fontSize: 14, fontWeight: 600, color: "var(--text)" },
  benefitSub: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  basisTag: { border: "1px solid var(--border2)", borderRadius: 4, padding: "1px 5px", cursor: "help" },
  statusChip: {
    fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", borderRadius: 99,
    padding: "3px 10px", background: "var(--surface)", whiteSpace: "nowrap", cursor: "help",
  },

  barTrack: { height: 8, borderRadius: 99, background: "var(--surface2)", overflow: "hidden", border: "1px solid var(--border)" },
  barFill: { height: "100%", borderRadius: 99 },

  amountRow: { display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 6 },
  amountMain: { fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" },
  amountSub: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  note: { fontSize: 11, lineHeight: 1.6, marginTop: 6 },

  metaLine: { display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 },
  verified: { fontSize: 11, fontFamily: "var(--font-mono)" },
  confidence: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)" },
  notes: { fontSize: 12, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 },

  actions: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 10 },
  linkBtn: { background: "none", border: "none", color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)", padding: 0, cursor: "pointer" },
  smallBtn: { background: "none", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  smallPrimary: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  undoBtn: { background: "none", color: "var(--accent)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  rowError: { marginTop: 8, fontSize: 11, color: "var(--red)", fontFamily: "var(--font-mono)", lineHeight: 1.6 },

  markForm: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 },
  fieldLabel: { fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  input: { background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: 12, padding: "6px 8px", fontFamily: "var(--font-mono)" },
  formHint: { fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" },

  matchTable: { marginTop: 10, borderTop: "1px solid var(--border)" },
  matchRow: { display: "grid", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", alignItems: "center" },
  mono: { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)" },
  matchMerchant: { fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  subLine: { display: "block", fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" },
  source: { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--muted)", textTransform: "uppercase" },
};
