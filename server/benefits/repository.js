// Data access for card-benefit tracking. Kept separate from routes.js (HTTP)
// and periods.js (pure math) so the period/evaluation logic never has to touch
// SQL and the route handlers never have to either — the same split
// server/property/ uses.
import pool from "../db.js";
import { fetchLimit, takeWithTruncation } from "../limits.js";

// ── Catalog ───────────────────────────────────────────────────────────────────

const CARD_SELECT = `id, nickname, issuer, product, account_id,
  TO_CHAR(anniversary_date,'YYYY-MM-DD') AS anniversary_date,
  annual_fee::float AS annual_fee, created_at`;

const BENEFIT_SELECT = `id, card_id, name, amount_limit::float AS amount_limit,
  period_unit, period_count, period_basis, carryover, notes,
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
  "period_basis", "carryover", "notes", "verified_on",
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

// ── Usage ─────────────────────────────────────────────────────────────────────

// Usage rows joined to the transaction that produced them, because the status
// contract's `matches` carry the date and merchant and cb_usage stores neither
// (duplicating them would let them drift from the row they describe). A manual
// mark has no transaction, so it dates from when it was recorded.
export async function listUsage(benefitIds) {
  if (!benefitIds?.length) return [];
  const { rows } = await pool.query(
    `SELECT u.id, u.benefit_id, u.period_key, u.amount::float AS amount, u.txn_id, u.source,
            u.confirmed_at, u.confirmed_txn_id, u.note,
            COALESCE(TO_CHAR(t.date,'YYYY-MM-DD'), TO_CHAR(u.created_at,'YYYY-MM-DD')) AS date,
            t.merchant
     FROM cb_usage u
     LEFT JOIN transactions t ON t.id = u.txn_id
     WHERE u.benefit_id = ANY($1::int[])
     ORDER BY u.benefit_id, date, u.id`,
    [benefitIds]
  );
  return rows;
}

// Idempotent by construction, which is what lets the evaluation re-run on every
// status read and on every cron tick without inflating anything:
//
//   - an automatic row keys on (benefit, period, txn) — the same transaction
//     matched again updates one row instead of adding a second,
//   - a manual row keys on (benefit, period) through the partial unique index
//     (schema.js), since NULL txn_ids do not collide under a plain constraint.
//
// The two key spaces are disjoint, so automatic matching can never overwrite a
// manual mark. confirmed_at is sticky on update: once a posted credit has
// confirmed a period, a later re-match of the charge must not un-confirm it.
export async function upsertUsage({ benefitId, periodKey, amount = 0, txnId = null, source = "auto", confirmedAt = null, note = null }) {
  if (txnId === null || txnId === undefined) {
    const { rows } = await pool.query(
      `INSERT INTO cb_usage (benefit_id, period_key, amount, txn_id, source, confirmed_at, note)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)
       ON CONFLICT (benefit_id, period_key) WHERE txn_id IS NULL
       DO UPDATE SET amount = EXCLUDED.amount, source = EXCLUDED.source,
                     confirmed_at = EXCLUDED.confirmed_at, note = EXCLUDED.note
       RETURNING id`,
      [benefitId, periodKey, amount, source, confirmedAt, note]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO cb_usage (benefit_id, period_key, amount, txn_id, source, confirmed_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (benefit_id, period_key, txn_id)
     DO UPDATE SET amount = EXCLUDED.amount,
                   confirmed_at = COALESCE(cb_usage.confirmed_at, EXCLUDED.confirmed_at)
     RETURNING id`,
    [benefitId, periodKey, amount, txnId, source, confirmedAt, note]
  );
  return rows[0];
}

// Confirms ONE recorded charge with the posted statement credit that settled
// it. This is the other half of the lag the brief describes: the credit posts a
// cycle after the charge, so it belongs to the charge's period, not to its own
// — inserting it as fresh usage where it landed would consume the NEXT period's
// allowance before a cent of it was spent (see benefits/sync.js).
//
// Both columns are sticky (COALESCE), so a re-run cannot re-confirm a row with
// a different credit, and `confirmed_txn_id` is what makes the pairing
// idempotent across runs: the next sync sees that this credit has already been
// spent confirming something and leaves it alone instead of filing it again.
export async function confirmUsage({ usageId, confirmedAt = new Date(), confirmedTxnId = null }) {
  const { rowCount } = await pool.query(
    `UPDATE cb_usage
        SET confirmed_at = COALESCE(confirmed_at, $2),
            confirmed_txn_id = COALESCE(confirmed_txn_id, $3)
      WHERE id = $1`,
    [usageId, confirmedAt, confirmedTxnId]
  );
  return rowCount > 0;
}

// Removes one automatic row by its key. Used for rollup rows only (see
// findMatches): a rollup that has dropped to zero has to GO, because a
// zero-amount usage row would make an untouched period look partially used
// instead of available.
export async function deleteUsage(benefitId, periodKey, txnId) {
  const { rowCount } = await pool.query(
    `DELETE FROM cb_usage WHERE benefit_id = $1 AND period_key = $2 AND txn_id = $3`,
    [benefitId, periodKey, txnId]
  );
  return rowCount > 0;
}

// "Unmark" removes only the owner's own row. An automatic match is evidence
// from the transaction feed and is not the owner's to delete here — it comes
// back on the next evaluation anyway.
export async function deleteManualUsage(benefitId, periodKey) {
  const { rowCount } = await pool.query(
    `DELETE FROM cb_usage WHERE benefit_id = $1 AND period_key = $2 AND txn_id IS NULL`,
    [benefitId, periodKey]
  );
  return rowCount > 0;
}

// ── History coverage ──────────────────────────────────────────────────────────

// Earliest transaction date per account: the line before which this app knows
// nothing and must not claim a benefit went unused. Same exclusions as the
// matching query below, so "covered" means "covered by rows matching could
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

// ── Matching ──────────────────────────────────────────────────────────────────

// Rows a tester or a match run may consider. The three exclusions are lifted
// verbatim from getSpendingByCategory (db.js) so "which transactions count"
// means one thing across the app: nothing pending (a pending row's amount and
// merchant both still move), nothing hidden, nothing on a hidden account.
//
// The regex is applied in Postgres with ~* over the three description columns —
// merchant is often null on imported rows and `name` /
// `original_description` carry the raw descriptor the match rules are actually
// written against. COALESCE because `NULL ~* x` is NULL, which would quietly
// drop every row with an empty column instead of failing the one comparison.
function matchConditions({ accountId, startDate, endDate, merchantRegex, amountMin, amountMax, category, direction, excludeTxnIds }) {
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
  // Transactions already recorded as their own cb_usage row, excluded so
  // sumMatches returns only what is NOT accounted for row by row.
  if (excludeTxnIds?.length) {
    conditions.push(`id <> ALL($${i++}::text[])`);
    params.push(excludeTxnIds);
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

// The rows one match rule selects inside one window, oldest first. Same
// conditions as the tester plus the rule's direction, so what the tester
// previews is what the evaluation records.
//
// This is the RECORDING path, and it is bounded like every other query here —
// but the bound is on the ROWS, never on the money. What comes back is a
// sample: `truncated` says whether the rule hit more transactions than the
// sample holds, and the caller settles the difference with sumMatches below.
// A cap that silently swallowed the rest would under-count `amount_used` and
// report a spent credit as partially-used, or as available, which is the exact
// failure this whole feature exists to prevent.
export async function findMatches(params) {
  let result;
  const { where, params: values } = matchConditions(params);
  try {
    result = await pool.query(
      `SELECT ${MATCH_SELECT} FROM transactions WHERE ${where}
       ORDER BY date, id LIMIT $${values.length + 1}`,
      [...values, fetchLimit(MATCH_SAMPLE_LIMIT)]
    );
  } catch (err) {
    throw rethrowRegexError(err);
  }
  const { rows, truncated } = takeWithTruncation(result.rows, MATCH_SAMPLE_LIMIT);
  return { rows, truncated };
}

// COUNT and SUM over the matching set, computed in Postgres and bounded by
// nothing. `excludeTxnIds` drops the transactions the caller has already
// recorded as individual cb_usage rows, so what comes back is exactly the money
// no row accounts for — the amount a rollup row has to carry for the period's
// total to be right.
//
// A pure aggregate on purpose: it scans as many rows as the rule matches but
// materialises none of them, so the exact figure costs the 256 MB VM (see the
// reasoning at the top of limits.js) two numbers rather than an unbounded array.
export async function sumMatches(params) {
  const { where, params: values } = matchConditions(params);
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(ABS(amount)), 0)::float AS total
       FROM transactions WHERE ${where}`,
      values
    );
    return { count: rows[0]?.count ?? 0, total: rows[0]?.total ?? 0 };
  } catch (err) {
    throw rethrowRegexError(err);
  }
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
