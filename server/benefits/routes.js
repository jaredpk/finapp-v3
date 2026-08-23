// HTTP surface for card-benefit tracking (Brief 05, phase 2), mounted from
// server/index.js the way registerPropertyFinanceRoutes is. Handlers here only
// translate HTTP to and from repository.js (SQL) and periods.js (math); the
// shapes they return are fixed by docs/feature-briefs/05-api-contract.md.
import {
  getCatalog, createCard, updateCard, getCard, deleteCard,
  createBenefit, updateBenefit, getBenefit, deleteBenefit,
  createRule, deleteRule,
  listUsage, upsertUsage, deleteManualUsage,
  getHistoryStartByAccount, findMatches, matchTest,
  CARD_FIELDS, BENEFIT_FIELDS, RULE_FIELDS,
} from "./repository.js";
import { resolvePeriod, evaluateBenefits, toDateString } from "./periods.js";
import { DATE_PARAM_RE, validateDateRange } from "../limits.js";

const PERIOD_UNITS = ["month", "quarter", "half", "year", "months_n"];
const PERIOD_BASES = ["calendar", "anniversary"];
const DIRECTIONS = ["charge", "credit"];

// Only the fields the contract names, and an empty string means "clear it" —
// a DATE or NUMERIC column cannot take "" and would fail the whole request.
function pick(body, fields) {
  const out = {};
  for (const field of fields) {
    if (body[field] === undefined) continue;
    out[field] = body[field] === "" ? null : body[field];
  }
  return out;
}

function invalidEnum(values) {
  for (const [field, allowed] of [
    ["period_unit", PERIOD_UNITS],
    ["period_basis", PERIOD_BASES],
    ["direction", DIRECTIONS],
  ]) {
    if (values[field] !== undefined && values[field] !== null && !allowed.includes(values[field])) {
      return `${field} must be one of ${allowed.join(" | ")}`;
    }
  }
  return null;
}

// ── Matching ──────────────────────────────────────────────────────────────────

// Runs every benefit's match rules over its CURRENT period and records what
// they hit in cb_usage. Safe to call on every status read: upsertUsage keys on
// (benefit, period, transaction), so re-running re-writes the same rows rather
// than accumulating usage.
//
// Returns the number of rows written, so the caller only re-reads usage when
// something actually changed.
async function syncUsage(cards, usageRows, today) {
  // An anchored cycle (months_n) is measured from the last recorded use, so the
  // anchor has to come out of the existing usage rows before its period can be
  // resolved at all.
  const lastUseByBenefit = new Map();
  for (const row of usageRows) {
    const date = toDateString(row.date);
    if (!date) continue;
    const current = lastUseByBenefit.get(row.benefit_id);
    if (!current || date > current) lastUseByBenefit.set(row.benefit_id, date);
  }

  let written = 0;
  for (const card of cards) {
    // No linked Plaid account means no transactions to match against. The
    // benefit still evaluates — as insufficient-history, since we can see
    // nothing — it just cannot match automatically.
    if (!card.account_id) continue;
    for (const benefit of card.benefits) {
      if (!benefit.rules?.length) continue;
      let period;
      try {
        period = resolvePeriod({
          unit: benefit.period_unit,
          count: benefit.period_count,
          basis: benefit.period_basis,
          anniversaryDate: card.anniversary_date,
          anchorDate: benefit.period_unit === "months_n" ? lastUseByBenefit.get(benefit.id) || null : null,
        }, today);
      } catch (err) {
        console.error(`benefits: benefit ${benefit.id} period unresolved:`, err.message);
        continue;
      }
      for (const rule of benefit.rules) {
        // A rule with no criteria at all matches the entire statement, which
        // would silently mark every benefit used. Skipped rather than obeyed.
        if (!rule.merchant_regex && rule.amount_min == null && rule.amount_max == null && !rule.category) continue;
        let matches;
        try {
          matches = await findMatches({
            accountId: card.account_id,
            startDate: period.start,
            // An anchored cycle that is available again has no end; everything
            // up to today is in scope.
            endDate: period.end || today,
            merchantRegex: rule.merchant_regex,
            amountMin: rule.amount_min,
            amountMax: rule.amount_max,
            category: rule.category,
            direction: rule.direction || "charge",
          });
        } catch (err) {
          // A stored regex that no longer parses must not take down the status
          // read for every other benefit on the card.
          console.error(`benefits: rule ${rule.id} skipped:`, err.message);
          continue;
        }
        for (const txn of matches) {
          await upsertUsage({
            benefitId: benefit.id,
            periodKey: period.key,
            amount: Math.abs(Number(txn.amount) || 0),
            txnId: txn.id,
            source: "auto",
            // A credit-direction match IS the posted statement credit, the
            // authoritative half of the pair, so it stamps the confirmation.
            confirmedAt: rule.direction === "credit" ? new Date() : null,
          });
          written++;
        }
      }
    }
  }
  return written;
}

// The whole of GET /api/benefits/status, exported because POST /api/alerts/run
// (index.js) needs exactly the same picture before it can decide what is due.
export async function getBenefitsStatus(today) {
  const asOf = toDateString(today) || new Date().toISOString().slice(0, 10);
  const cards = await getCatalog();
  const benefitIds = cards.flatMap((card) => card.benefits.map((b) => b.id));
  let usageRows = await listUsage(benefitIds);
  if (await syncUsage(cards, usageRows, asOf)) usageRows = await listUsage(benefitIds);
  const historyByAccount = await getHistoryStartByAccount();
  return { as_of: asOf, cards: evaluateBenefits({ cards, usageRows, historyByAccount }, asOf) };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerBenefitsRoutes(app, requireAuth, requireApiKeyOrAuth) {
  // Status and the alert job are the two machine-callable surfaces (the daily
  // GitHub Action carries an API key); everything that edits the catalog is
  // browser-only.
  app.get("/api/benefits/status", requireApiKeyOrAuth, async (req, res) => {
    const asOf = req.query.as_of;
    if (asOf && !DATE_PARAM_RE.test(String(asOf)))
      return res.status(400).json({ error: "as_of must be YYYY-MM-DD" });
    try {
      res.json(await getBenefitsStatus(asOf));
    } catch (err) {
      console.error("benefits status failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // The raw catalog (cards → benefits → rules) for the editor, without any
  // period math applied.
  app.get("/api/benefits/catalog", requireAuth, async (_req, res) => {
    res.json({ cards: await getCatalog() });
  });

  // ── Cards ───────────────────────────────────────────────────────────────────
  app.post("/api/benefits/cards", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, CARD_FIELDS);
    if (!String(values.nickname || "").trim()) return res.status(400).json({ error: "nickname required" });
    res.json({ card: await createCard(values) });
  });

  app.patch("/api/benefits/cards/:id", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, CARD_FIELDS);
    if (values.nickname !== undefined && !String(values.nickname || "").trim())
      return res.status(400).json({ error: "nickname cannot be empty" });
    const card = await updateCard(Number(req.params.id), values);
    if (!card) return res.status(404).json({ error: "not found" });
    res.json({ card });
  });

  app.delete("/api/benefits/cards/:id", requireAuth, async (req, res) => {
    const ok = await deleteCard(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ── Benefits ────────────────────────────────────────────────────────────────
  app.post("/api/benefits/benefits", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, BENEFIT_FIELDS);
    if (!Number.isInteger(Number(values.card_id))) return res.status(400).json({ error: "card_id required" });
    if (!String(values.name || "").trim()) return res.status(400).json({ error: "name required" });
    const enumError = invalidEnum(values);
    if (enumError) return res.status(400).json({ error: enumError });
    if (!(await getCard(Number(values.card_id)))) return res.status(404).json({ error: "card not found" });
    res.json({ benefit: await createBenefit(values) });
  });

  app.patch("/api/benefits/benefits/:id", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, BENEFIT_FIELDS);
    if (values.name !== undefined && !String(values.name || "").trim())
      return res.status(400).json({ error: "name cannot be empty" });
    const enumError = invalidEnum(values);
    if (enumError) return res.status(400).json({ error: enumError });
    const benefit = await updateBenefit(Number(req.params.id), values);
    if (!benefit) return res.status(404).json({ error: "not found" });
    res.json({ benefit });
  });

  app.delete("/api/benefits/benefits/:id", requireAuth, async (req, res) => {
    const ok = await deleteBenefit(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ── Match rules ─────────────────────────────────────────────────────────────
  app.post("/api/benefits/rules", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, RULE_FIELDS);
    if (!Number.isInteger(Number(values.benefit_id))) return res.status(400).json({ error: "benefit_id required" });
    const enumError = invalidEnum(values);
    if (enumError) return res.status(400).json({ error: enumError });
    if (!(await getBenefit(Number(values.benefit_id)))) return res.status(404).json({ error: "benefit not found" });
    res.json({ rule: await createRule(values) });
  });

  app.delete("/api/benefits/rules/:id", requireAuth, async (req, res) => {
    const ok = await deleteRule(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ── Match-rule tester ───────────────────────────────────────────────────────
  app.post("/api/benefits/match-test", requireAuth, async (req, res) => {
    const { account_id, merchant_regex, amount_min, amount_max, category, start_date, end_date } = req.body || {};
    const rangeError = validateDateRange({ startDate: start_date, endDate: end_date });
    if (rangeError) return res.status(400).json(rangeError);
    try {
      res.json(await matchTest({
        accountId: account_id || null,
        merchantRegex: merchant_regex || null,
        amountMin: amount_min,
        amountMax: amount_max,
        category: category || null,
        startDate: start_date || null,
        endDate: end_date || null,
      }));
    } catch (err) {
      // An unparseable regex is a bad request carrying Postgres' own parse
      // error, never a 500 — the owner is typing the pattern and needs to know
      // what is wrong with it.
      if (err.invalidRegex) return res.status(400).json({ error: err.message });
      console.error("benefits match-test failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Manual usage ────────────────────────────────────────────────────────────
  // The whole path for benefits with no transaction footprint (lounge access,
  // elite status, anniversary miles), and the override for anything matching
  // got wrong.
  app.post("/api/benefits/:id/mark-used", requireAuth, async (req, res) => {
    const benefit = await getBenefit(Number(req.params.id));
    if (!benefit) return res.status(404).json({ error: "not found" });
    const { period_key, amount, note } = req.body || {};
    if (!String(period_key || "").trim()) return res.status(400).json({ error: "period_key required" });
    // Marking a benefit used without naming an amount means all of it.
    const raw = amount === undefined || amount === null || amount === "" ? benefit.amount_limit ?? 0 : amount;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: "amount must be a non-negative number" });
    await upsertUsage({
      benefitId: benefit.id,
      periodKey: String(period_key),
      amount: value,
      txnId: null,
      source: "manual",
      // Deliberately not confirmed: confirmed_at means "a posted statement
      // credit said so". A manual mark reports confidence `manual` instead.
      confirmedAt: null,
      note: note || null,
    });
    res.json({ ok: true });
  });

  app.post("/api/benefits/:id/unmark", requireAuth, async (req, res) => {
    const { period_key } = req.body || {};
    if (!String(period_key || "").trim()) return res.status(400).json({ error: "period_key required" });
    await deleteManualUsage(Number(req.params.id), String(period_key));
    res.json({ ok: true });
  });
}
