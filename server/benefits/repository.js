// Data access for card-benefit tracking. Kept separate from routes.js (HTTP)
// and periods.js (pure math) so the period/evaluation logic never has to touch
// SQL and the route handlers never have to either — the same split
// server/property/ uses.
import pool from "../db.js";
import { fetchLimit, takeWithTruncation } from "../limits.js";
import { PAIRING_ROW_LIMIT } from "./derive.js";

// ── Catalog ───────────────────────────────────────────────────────────────────

const CARD_SELECT = `id, nickname, issuer, product, account_id,
  TO_CHAR(anniversary_date,'YYYY-MM-DD') AS anniversary_date,
  annual_fee::float AS annual_fee, created_at`;

const BENEFIT_SELECT = `id, card_id, name, amount_limit::float AS amount_limit,
  period_unit, period_count, period_basis,
  TO_CHAR(cycle_anchor,'YYYY-MM-DD') AS cycle_anchor,
  unit, carryover, notes,
  TO_CHAR(verified_on,'YYYY-MM-DD') AS verified_on, created_at`;

const RULE_SELECT = `id, benefit_id, merchant_regex, amount_min::float AS amount_min,
  amount_max::float AS amount_max, category, direction, created_at`;

// The whole catalog, nested: cards → benefits → rules. One query per level
// rather than one per card; this is owner-maintained data measured in dozens of
// rows, not a feed.
export async function getCatalog() {
  const [cards, benefits, rules] = await Promise.all([
    pool.query(`SELECT ${CARD_SELECT} FROM cb_cards ORDER BY id`),
    pool.query(`SELECT ${BENEFIT_SELECT} FROM cb_benefits ORDER BY card_id, id`),
    pool.query(`SELECT ${RULE_SELECT} FROM cb_match_rules ORDER BY benefit_id, id`),
  ]);
  const rulesByBenefit = new Map();
  for (const rule of rules.rows) {
    if (!rulesByBenefit.has(rule.benefit_id)) rulesByBenefit.set(rule.benefit_id, []);
    rulesByBenefit.get(rule.benefit_id).push(rule);
  }
  const benefitsByCard = new Map();
  for (const benefit of benefits.rows) {
    if (!benefitsByCard.has(benefit.card_id)) benefitsByCard.set(benefit.card_id, []);
    benefitsByCard.get(benefit.card_id).push({ ...benefit, rules: rulesByBenefit.get(benefit.id) || [] });
  }
  return cards.rows.map((card) => ({ ...card, benefits: benefitsByCard.get(card.id) || [] }));
}

// Column whitelists. PATCH builds its SET clause from these names, so nothing a
// caller sends can become SQL — only the VALUES are parameterised, the column
// list has to be closed.
export const CARD_FIELDS = ["nickname", "issuer", "product", "account_id", "anniversary_date", "annual_fee"];
export const BENEFIT_FIELDS = [
  "card_id", "name", "amount_limit", "period_unit", "period_count",
  "period_basis", "cycle_anchor", "unit", "carryover", "notes", "verified_on",
];
export const RULE_FIELDS = ["benefit_id", "merchant_regex", "amount_min", "amount_max", "category", "direction"];

function buildInsert(table, fields, values, returning) {
  const cols = fields.filter((f) => values[f] !== undefined);
  const params = cols.map((f) => values[f]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  return {
    text: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${returning}`,
    params,
  };
}

function buildUpdate(table, fields, values, id, returning) {
  const cols = fields.filter((f) => values[f] !== undefined);
  if (cols.length === 0) return null;
  const params = cols.map((f) => values[f]);
  const sets = cols.map((f, i) => `${f} = $${i + 1}`);
  params.push(id);
  return {
    text: `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${returning}`,
    params,
  };
}

export async function createCard(values) {
  const { text, params } = buildInsert("cb_cards", CARD_FIELDS, values, CARD_SELECT);
  const { rows } = await pool.query(text, params);
  return rows[0];
}

export async function updateCard(id, values) {
  const q = buildUpdate("cb_cards", CARD_FIELDS, values, id, CARD_SELECT);
  if (!q) return getCard(id);
  const { rows } = await pool.query(q.text, q.params);
  return rows[0] || null;
}

export async function getCard(id) {
  const { rows } = await pool.query(`SELECT ${CARD_SELECT} FROM cb_cards WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function deleteCard(id) {
  const { rowCount } = await pool.query(`DELETE FROM cb_cards WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function createBenefit(values) {
  const { text, params } = buildInsert("cb_benefits", BENEFIT_FIELDS, values, BENEFIT_SELECT);
  const { rows } = await pool.query(text, params);
  return rows[0];
}

export async function updateBenefit(id, values) {
  const q = buildUpdate("cb_benefits", BENEFIT_FIELDS, values, id, BENEFIT_SELECT);
  if (!q) return getBenefit(id);
  const { rows } = await pool.query(q.text, q.params);
  return rows[0] || null;
}

export async function getBenefit(id) {
  const { rows } = await pool.query(`SELECT ${BENEFIT_SELECT} FROM cb_benefits WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function deleteBenefit(id) {
  const { rowCount } = await pool.query(`DELETE FROM cb_benefits WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function createRule(values) {
  const { text, params } = buildInsert("cb_match_rules", RULE_FIELDS, values, RULE_SELECT);
  const { rows } = await pool.query(text, params);
  return rows[0];
}

export async function deleteRule(id) {
  const { rowCount } = await pool.query(`DELETE FROM cb_match_rules WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ── History coverage ──────────────────────────────────────────────────────────

// Earliest transaction date per account: the line before which this app knows
// nothing and must not claim a benefit went unused. Same three exclusions as
// the match queries below, so "covered" means "covered by rows matching could
// actually have seen".
export async function getHistoryStartByAccount() {
  const { rows } = await pool.query(
    `SELECT account, TO_CHAR(MIN(date),'YYYY-MM-DD') AS history_start
     FROM transactions
     WHERE status != 'pending'
       AND (hidden IS NOT TRUE)
       AND (account NOT IN (SELECT account_id FROM hidden_accounts))
     GROUP BY account`
  );
  return Object.fromEntries(rows.map((r) => [r.account, r.history_start]));
}

// ── Match-rule tester ─────────────────────────────────────────────────────────

// Rows the tester may consider. The three exclusions are lifted
// verbatim from getSpendingByCategory (db.js) so "which transactions count"
// means one thing across the app: nothing pending (a pending row's amount and
// merchant both still move), nothing hidden, nothing on a hidden account.
//
// The regex is applied in Postgres with ~* over the three description columns —
// merchant is often null on imported rows and `name` /
// `original_description` carry the raw descriptor the match rules are actually
// written against. COALESCE because `NULL ~* x` is NULL, which would quietly
// drop every row with an empty column instead of failing the one comparison.
function matchConditions({ accountId, startDate, endDate, merchantRegex, amountMin, amountMax, category, direction }) {
  const conditions = [
    "status != 'pending'",
    "(hidden IS NOT TRUE)",
    "(account NOT IN (SELECT account_id FROM hidden_accounts))",
  ];
  const params = [];
  let i = 1;
  if (accountId) { conditions.push(`account = $${i++}`); params.push(accountId); }
  if (startDate) { conditions.push(`date >= $${i++}`); params.push(startDate); }
  if (endDate) { conditions.push(`date <= $${i++}`); params.push(endDate); }
  // A qualifying charge is a positive amount in this schema; a posted statement
  // credit is a negative one.
  if (direction === "charge") conditions.push("amount > 0");
  if (direction === "credit") conditions.push("amount < 0");
  if (merchantRegex) {
    conditions.push(
      `(COALESCE(merchant,'') ~* $${i} OR COALESCE(name,'') ~* $${i} OR COALESCE(original_description,'') ~* $${i})`
    );
    params.push(merchantRegex);
    i++;
  }
  if (amountMin !== null && amountMin !== undefined && amountMin !== "") {
    conditions.push(`ABS(amount) >= $${i++}`); params.push(amountMin);
  }
  if (amountMax !== null && amountMax !== undefined && amountMax !== "") {
    conditions.push(`ABS(amount) <= $${i++}`); params.push(amountMax);
  }
  if (category) {
    conditions.push(`(plaid_category = $${i} OR primary_category = $${i})`);
    params.push(category); i++;
  }
  return { where: conditions.join(" AND "), params };
}

// Postgres' "invalid regular expression" SQLSTATE. The regex is owner-entered
// text arriving from the rule editor and the tester, so a bad one is a bad
// REQUEST, not a server fault: it is re-thrown tagged, and routes.js turns it
// into a 400 carrying the parse error Postgres produced. A 500 here would tell
// the owner nothing about which bracket is unbalanced.
const INVALID_REGEX_SQLSTATE = "2201B";

function rethrowRegexError(err) {
  if (err?.code === INVALID_REGEX_SQLSTATE) {
    const tagged = new Error(err.message);
    tagged.invalidRegex = true;
    return tagged;
  }
  return err;
}

// Cheapest possible parse check for an owner-entered pattern: Postgres compiles
// the regex and throws 2201B if it cannot, without touching a table. Called
// when a match rule is SAVED, so a typo'd bracket is a 400 at the moment it is
// typed rather than a rule that silently stops matching months later — the
// failure that leaves a benefit with rules, no usage, and a confident
// "available".
export async function assertValidRegex(regex) {
  if (!regex) return;
  try {
    await pool.query(`SELECT $1::text ~* $2::text`, ["", regex]);
  } catch (err) {
    throw rethrowRegexError(err);
  }
}

// Bounded for the same reason every other list query in this app is (limits.js):
// a 256 MB VM cannot afford an unbounded SELECT, and a capped result that does
// not say so is worse than a short one.
export const MATCH_SAMPLE_LIMIT = 200;

const MATCH_SELECT = `id, TO_CHAR(date,'YYYY-MM-DD') AS date, merchant, amount::float AS amount, account`;

// The match-rule tester. `count` is the number of rows actually returned, not a
// COUNT(*) — limits.js deliberately answers "is there more?" with one extra row
// instead of making the database count rows nobody asked for — so `truncated`
// is the field that tells you whether `count` is the whole story.
export async function matchTest({ accountId, merchantRegex, amountMin, amountMax, category, startDate, endDate } = {}) {
  const { where, params } = matchConditions({
    accountId, merchantRegex, amountMin, amountMax, category, startDate, endDate,
  });
  let result;
  try {
    result = await pool.query(
      `SELECT ${MATCH_SELECT} FROM transactions WHERE ${where}
       ORDER BY date DESC, id DESC LIMIT $${params.length + 1}`,
      [...params, fetchLimit(MATCH_SAMPLE_LIMIT)]
    );
  } catch (err) {
    throw rethrowRegexError(err);
  }
  const { rows, truncated } = takeWithTruncation(result.rows, MATCH_SAMPLE_LIMIT);
  return { count: rows.length, truncated, sample: rows };
}

// ── Deriving usage (Brief 05, derive-on-read) ─────────────────────────────────

// The two transaction queries behind GET /api/benefits/status, and the CTE they
// share.
//
// Nothing here writes. Matched charges, matched credits, their pairing and the
// totals that come out of it are all recomputed per read (benefits/derive.js);
// the only usage this app persists is the owner's own manual mark. That is what
// removed the whole class of drift bugs the stored model kept producing.
//
// The windows are computed in JS — dozens of (benefit, period, start, end)
// tuples — and shipped as four parallel arrays for `unnest` to turn back into
// rows. Two scans of `transactions` total, whatever the size of the catalog.
//
// The three exclusions are lifted verbatim from getSpendingByCategory (db.js)
// so "which transactions count" means one thing across the app: nothing
// pending (a pending row's amount and merchant both still move), nothing
// hidden, nothing on a hidden account. Same set getHistoryStartByAccount uses,
// so "covered" means "covered by rows this query could actually have seen".
//
// SELECT DISTINCT on t.id is load-bearing: it is what makes a transaction
// matched by two overlapping rules of the same benefit (`DOORDASH` and `DOOR`)
// count ONCE per period, structurally, rather than relying on per-rule
// bookkeeping to subtract it again.
const MATCH_CTE = `
  WITH w AS (
    SELECT * FROM unnest($1::int[], $2::text[], $3::date[], $4::date[])
         AS w(benefit_id, period_key, start_date, end_date)
  ),
  m AS (
    SELECT DISTINCT w.benefit_id, w.period_key, t.id AS txn_id,
           TO_CHAR(t.date,'YYYY-MM-DD') AS date, t.merchant,
           ABS(t.amount)::float AS amount, (t.amount < 0) AS is_credit
    FROM w
    JOIN cb_benefits b    ON b.id = w.benefit_id
    JOIN cb_cards c       ON c.id = b.card_id AND c.account_id IS NOT NULL
    JOIN cb_match_rules r ON r.benefit_id = b.id AND NOT (r.id = ANY($5::int[]))
    JOIN transactions t
      ON t.account = c.account_id
     AND t.date >= w.start_date AND t.date <= w.end_date
     AND t.status != 'pending' AND (t.hidden IS NOT TRUE)
     AND t.account NOT IN (SELECT account_id FROM hidden_accounts)
     AND ((r.direction = 'charge' AND t.amount > 0) OR (r.direction = 'credit' AND t.amount < 0))
     AND (r.merchant_regex IS NULL OR COALESCE(t.merchant,'') ~* r.merchant_regex
          OR COALESCE(t.name,'') ~* r.merchant_regex
          OR COALESCE(t.original_description,'') ~* r.merchant_regex)
     AND (r.amount_min IS NULL OR ABS(t.amount) >= r.amount_min)
     AND (r.amount_max IS NULL OR ABS(t.amount) <= r.amount_max)
     AND (r.category IS NULL OR t.plaid_category = r.category OR t.primary_category = r.category)
  )`;

// The four parallel arrays + the broken-rule exclusion list, in $1..$5 order.
// `unnest` with several arguments stops at the longest, so they have to be
// exactly the same length; they are built from one loop over one list.
function windowParams(windows, excludedRuleIds = []) {
  return [
    windows.map((w) => w.benefit_id),
    windows.map((w) => w.period_key),
    windows.map((w) => w.start_date),
    windows.map((w) => w.end_date),
    (excludedRuleIds || []).map((id) => Number(id)).filter(Number.isInteger),
  ];
}

// Q-aggregate: exact money per (benefit, period, direction). Unbounded on
// purpose and materialising nothing — the same house pattern as
// getSpendingByCategory — because `amount_used` must be the total for the
// period, never "whatever fitted in a sample". This is what the rollup row used
// to persist, now computed and thrown away.
export async function fetchUsageAggregates(windows = [], excludedRuleIds = []) {
  if (!windows.length) return [];
  const { rows } = await pool.query(
    `${MATCH_CTE}
     SELECT benefit_id, period_key, is_credit,
            SUM(amount)::float AS total, COUNT(*)::int AS count, MAX(date) AS last_date
     FROM m GROUP BY 1, 2, 3`,
    windowParams(windows, excludedRuleIds)
  );
  return rows;
}

// Q-rows: the individual transactions, for pairing and for `matches`.
//
// Bounded per (benefit, direction) rather than overall, so one chatty benefit
// cannot starve the pairing of another, and fetched with limit + 1 — limits.js'
// idiom — so "did we hit the cap?" has an exact answer instead of the ambiguous
// rows.length === limit. derive.js turns an overflow into `rule-error`: pairing
// over a subset of the candidates would misclassify standalone-vs-paired
// credits, which inflates amount_used and suppresses an expiry alert.
export async function fetchMatchRows(windows = [], excludedRuleIds = [], limit = PAIRING_ROW_LIMIT) {
  if (!windows.length) return [];
  const { rows } = await pool.query(
    `${MATCH_CTE}
     SELECT txn_id, benefit_id, period_key, date, merchant, amount, is_credit FROM (
       SELECT m.*, ROW_NUMBER() OVER (PARTITION BY benefit_id, is_credit
                                      ORDER BY date DESC, txn_id DESC) AS rn
       FROM m
     ) x WHERE rn <= $6`,
    [...windowParams(windows, excludedRuleIds), fetchLimit(limit)]
  );
  return rows;
}

// ── Manual marks ──────────────────────────────────────────────────────────────

// The one piece of usage this app stores, because it is the one piece nothing
// can derive: the owner saying "I used this". Disjoint from everything
// automatic, so automatic matching cannot clobber a mark and a mark cannot be
// mistaken for a matched transaction.
//
// `created_at` is a TIMESTAMPTZ and is rendered in UTC EXPLICITLY. TO_CHAR on a
// TIMESTAMPTZ formats it in the session's TimeZone, node-postgres never issues
// a SET TimeZone, so without the AT TIME ZONE the day this returns is whatever
// the database server's timezone GUC happens to be. That is not cosmetic here:
// a months_n benefit takes its anchor from the latest mark date that is `<=
// asOf`, so on a UTC+14 server a mark created at 15:30Z reads as tomorrow,
// drops out of that filter, and the anchored cycle loses its anchor — which
// changes `period_key`, and `period_key` is the idempotency key for both
// cb_manual_marks and cb_alerts. Every other date this module renders is a
// DATE column, which has no timezone to be read in.
export async function listManualMarks(benefitIds) {
  if (!benefitIds?.length) return [];
  const { rows } = await pool.query(
    `SELECT benefit_id, period_key, amount::float AS amount, note,
            TO_CHAR(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS created_at
     FROM cb_manual_marks
     WHERE benefit_id = ANY($1::int[])
     ORDER BY benefit_id, period_key`,
    [benefitIds]
  );
  return rows;
}

// One mark per (benefit, period): a plain UNIQUE constraint, so a double click
// updates the row it already wrote instead of counting the benefit twice.
export async function upsertManualMark({ benefitId, periodKey, amount = 0, note = null }) {
  const { rows } = await pool.query(
    `INSERT INTO cb_manual_marks (benefit_id, period_key, amount, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (benefit_id, period_key)
     DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note
     RETURNING id`,
    [benefitId, periodKey, amount, note]
  );
  return rows[0];
}

// "Unmark" removes only the owner's own row. An automatic match is evidence
// from the transaction feed and is not the owner's to delete — and there is no
// longer any row for it to delete anyway.
export async function deleteManualMark(benefitId, periodKey) {
  const { rowCount } = await pool.query(
    `DELETE FROM cb_manual_marks WHERE benefit_id = $1 AND period_key = $2`,
    [benefitId, periodKey]
  );
  return rowCount > 0;
}


// ── Alert bookkeeping ─────────────────────────────────────────────────────────

// One tier, one period, one send. Read before composing the digest, written
// only after Gmail has accepted it (index.js) — the opposite order would turn a
// transient send failure into an alert that never fires.
export async function wasBenefitAlertSent(benefitId, periodKey, tier) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM cb_alerts WHERE benefit_id = $1 AND period_key = $2 AND tier = $3`,
    [benefitId, periodKey, tier]
  );
  return rowCount > 0;
}

export async function recordBenefitAlert(benefitId, periodKey, tier) {
  await pool.query(
    `INSERT INTO cb_alerts (benefit_id, period_key, tier) VALUES ($1, $2, $3)
     ON CONFLICT (benefit_id, period_key, tier) DO NOTHING`,
    [benefitId, periodKey, tier]
  );
}
