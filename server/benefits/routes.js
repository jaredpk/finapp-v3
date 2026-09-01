// HTTP surface for card-benefit tracking (Brief 05, phase 2), mounted from
// server/index.js the way registerPropertyFinanceRoutes is. Handlers here only
// translate HTTP to and from repository.js (SQL) and periods.js (math); the
// shapes they return are fixed by docs/feature-briefs/05-api-contract.md.
import {
  getCatalog, createCard, updateCard, getCard, deleteCard,
  createBenefit, updateBenefit, getBenefit, deleteBenefit,
  createRule, deleteRule,
  listManualMarks, upsertManualMark, deleteManualMark,
  getHistoryStartByAccount, fetchUsageAggregates, fetchMatchRows,
  matchTest, assertValidRegex,
  CARD_FIELDS, BENEFIT_FIELDS, RULE_FIELDS,
} from "./repository.js";
import { evaluateBenefits, toDateString, hasCriteria, BENEFIT_UNITS } from "./periods.js";
import { buildWindows, deriveBenefitStats } from "./derive.js";
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
    // Rejected here as well as by the column's CHECK constraint, so a typo'd
    // unit is a 400 naming the choices rather than a 500 carrying a constraint
    // name — and it can never reach a row where it would silently read as usd.
    ["unit", BENEFIT_UNITS],
    ["direction", DIRECTIONS],
  ]) {
    if (values[field] !== undefined && values[field] !== null && !allowed.includes(values[field])) {
      return `${field} must be one of ${allowed.join(" | ")}`;
    }
  }
  return null;
}

// ── Status ────────────────────────────────────────────────────────────────────

// The whole of GET /api/benefits/status, exported because POST /api/alerts/run
// (index.js) needs exactly the same picture before it can decide what is due.
//
// WRITE-FREE. The model this replaced ran a full match-and-record sync inside
// every read — hundreds of writes per GET, two concurrent reads racing each
// other over the same rows — and then evaluated what it had just written.
// Deriving instead is strictly cheaper (7 queries, whatever the catalog holds,
// against the 400-33,000 the old path issued) and leaves nothing behind to go
// stale. See docs/feature-briefs/05-derive-on-read-plan.md.
//
// Order: catalog + history in parallel → compile checks → windows →
// aggregate / rows / manual marks in parallel → derive → evaluate.
export async function getBenefitsStatus(today) {
  const asOf = toDateString(today) || new Date().toISOString().slice(0, 10);
  const [cards, historyByAccount] = await Promise.all([getCatalog(), getHistoryStartByAccount()]);

  const { ruleErrors, excludedRuleIds } = await checkRules(cards);
  const { windows, plans } = buildWindows(cards, asOf, { excludedRuleIds });
  const benefitIds = cards.flatMap((card) => card.benefits.map((b) => b.id));

  const [aggregates, rows, marks] = await Promise.all([
    fetchUsageAggregates(windows, excludedRuleIds),
    fetchMatchRows(windows, excludedRuleIds),
    listManualMarks(benefitIds),
  ]);

  const stats = deriveBenefitStats({ plans, aggregates, rows, marks }, asOf);
  // ruleErrors travels with the evaluation: a rule that could not run means the
  // benefit's usage is unknown, and `rule-error` is how the contract says so
  // instead of letting it fall through to `available`.
  return { as_of: asOf, cards: evaluateBenefits({ cards, stats, historyByAccount, ruleErrors }, asOf) };
}

// One regex compile per DISTINCT saved pattern, before any transaction is
// touched.
//
// Kept as its own cheap round trip rather than folded into the match query for
// one reason: a pattern that no longer parses raises SQLSTATE 2201B, and inside
// the big CTE that error kills the read for every benefit on every card with no
// indication of which rule caused it. Here it names the offending rule, that
// rule alone is excluded from the scan, and the benefit it belongs to reports
// `rule-error` — a hole in the evidence that announces itself instead of
// reading as `available`.
//
// A rule with no criteria at all is excluded too, but is NOT an error: it would
// match the entire statement and mark every benefit used, and it is far more
// likely to be a half-filled row in the editor than a fault.
async function checkRules(cards) {
  const ruleErrors = [];
  const excludedRuleIds = [];
  const compiled = new Map();
  for (const card of cards) {
    for (const benefit of card.benefits || []) {
      for (const rule of benefit.rules || []) {
        if (!hasCriteria(rule)) {
          excludedRuleIds.push(rule.id);
          continue;
        }
        if (!rule.merchant_regex) continue;
        if (!compiled.has(rule.merchant_regex)) {
          try {
            await assertValidRegex(rule.merchant_regex);
            compiled.set(rule.merchant_regex, null);
          } catch (err) {
            // Only a parse failure is the rule's fault. Anything else (the
            // database being unreachable, say) is this read failing, and it has
            // to propagate rather than be mislabelled as a broken regex.
            if (!err.invalidRegex) throw err;
            compiled.set(rule.merchant_regex, err.message);
          }
        }
        const message = compiled.get(rule.merchant_regex);
        if (message) {
          ruleErrors.push({ benefit_id: benefit.id, rule_id: rule.id, message });
          excludedRuleIds.push(rule.id);
        }
      }
    }
  }
  return { ruleErrors, excludedRuleIds };
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
    // `unit` is NOT NULL with a default, so pick()'s ""-means-clear-it rule has
    // to land on the default rather than on a constraint violation.
    if (values.unit === null) values.unit = "usd";
    if (!Number.isInteger(Number(values.card_id))) return res.status(400).json({ error: "card_id required" });
    if (!String(values.name || "").trim()) return res.status(400).json({ error: "name required" });
    const enumError = invalidEnum(values);
    if (enumError) return res.status(400).json({ error: enumError });
    if (!(await getCard(Number(values.card_id)))) return res.status(404).json({ error: "card not found" });
    res.json({ benefit: await createBenefit(values) });
  });

  app.patch("/api/benefits/benefits/:id", requireAuth, async (req, res) => {
    const values = pick(req.body || {}, BENEFIT_FIELDS);
    if (values.unit === null) values.unit = "usd";
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
    // The regex is validated HERE, at the moment it is saved, exactly as
    // match-test validates the one being typed. A pattern that does not parse
    // is a rule that silently stops matching, and a benefit with rules and no
    // usage reads as `available` — a credit reported unused forever because of
    // one unbalanced bracket.
    try {
      await assertValidRegex(values.merchant_regex);
    } catch (err) {
      if (err.invalidRegex) return res.status(400).json({ error: err.message });
      console.error("benefits rule validation failed:", err.message);
      return res.status(500).json({ error: err.message });
    }
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
    // cb_manual_marks is disjoint from anything automatic, so this cannot
    // clobber a matched transaction and a matched transaction cannot clobber
    // it. The mark reports confidence `manual`; a posted statement credit is a
    // different kind of evidence and is never conflated with the owner's word.
    await upsertManualMark({
      benefitId: benefit.id,
      periodKey: String(period_key),
      amount: value,
      note: note || null,
    });
    res.json({ ok: true });
  });

  app.post("/api/benefits/:id/unmark", requireAuth, async (req, res) => {
    const { period_key } = req.body || {};
    if (!String(period_key || "").trim()) return res.status(400).json({ error: "period_key required" });
    await deleteManualMark(Number(req.params.id), String(period_key));
    res.json({ ok: true });
  });
}
