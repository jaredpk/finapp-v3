// Card-benefit tracking schema (Brief 05, phase 2). Tables are prefixed `cb_`
// (Card Benefits) so they sit alongside the `pf_` property-finance tables
// without either module having to know the other exists.
//
// Called once from server/db.js#initDb() next to initPropertyFinanceSchema.
export async function initBenefitsSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cb_cards (
      id SERIAL PRIMARY KEY,
      nickname TEXT NOT NULL,
      issuer TEXT,
      product TEXT,
      account_id TEXT,               -- Plaid account_id; NULL until the card is linked
      anniversary_date DATE,         -- account open date: the basis for cardmember-year periods
      annual_fee NUMERIC(12,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cb_benefits (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cb_cards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount_limit NUMERIC(12,2),    -- NULL/0 means a one-shot benefit with no dollar value
      -- The two enums are CHECKed rather than left as free text: periods.js
      -- silently falls back to a one-month calendar window for anything it does
      -- not recognise, and a typo'd basis would move a whole cardmember year to
      -- Jan 1 without anything looking wrong.
      period_unit TEXT NOT NULL DEFAULT 'month'
        CHECK (period_unit IN ('month','quarter','half','year','months_n')),
      period_count INTEGER NOT NULL DEFAULT 1,
      period_basis TEXT NOT NULL DEFAULT 'calendar'
        CHECK (period_basis IN ('calendar','anniversary')),
      -- CAPTURED FOR A LATER PHASE, NOT APPLIED. Nothing reads this to move an
      -- unused amount into the next period: periods.js hands every period the
      -- full amount_limit regardless, and the catalog editor labels the control
      -- as not yet applied so the checkbox cannot imply arithmetic that does
      -- not happen.
      carryover BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT,
      verified_on DATE,              -- when the owner last checked this against the benefits guide
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS cb_benefits_card_idx ON cb_benefits (card_id);

    CREATE TABLE IF NOT EXISTS cb_match_rules (
      id SERIAL PRIMARY KEY,
      benefit_id INTEGER NOT NULL REFERENCES cb_benefits(id) ON DELETE CASCADE,
      merchant_regex TEXT,
      amount_min NUMERIC(12,2),
      amount_max NUMERIC(12,2),
      category TEXT,
      -- charge  = the qualifying purchase (timely, optimistic)
      -- credit  = the posted statement credit (authoritative, lags a cycle)
      direction TEXT NOT NULL DEFAULT 'charge' CHECK (direction IN ('charge','credit')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS cb_match_rules_benefit_idx ON cb_match_rules (benefit_id);

    CREATE TABLE IF NOT EXISTS cb_usage (
      id SERIAL PRIMARY KEY,
      benefit_id INTEGER NOT NULL REFERENCES cb_benefits(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,      -- from periods.js resolvePeriod().key
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      -- NULL for a manual "mark as used"; a transaction id for a matched row;
      -- and 'rollup:rule:<id>' for the one synthetic row per rule per period
      -- that carries whatever a rule matched BEYOND the bounded sample of
      -- transactions recorded individually (benefits/sync.js). The rollup keeps
      -- amount_used exact without recording an unbounded number of rows.
      txn_id TEXT,
      source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
      confirmed_at TIMESTAMPTZ,      -- set when a POSTED CREDIT settled this charge
      -- The transaction id of that posted credit. A statement credit arrives a
      -- cycle after the charge it confirms, so it is spent confirming THIS row
      -- rather than filed as usage of its own (later) period; recording which
      -- credit did it is what stops the next sync from finding the same credit
      -- and counting it a second time.
      confirmed_txn_id TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      -- Re-evaluation is idempotent: matching the same transaction into the
      -- same period twice updates one row instead of accumulating usage.
      UNIQUE (benefit_id, period_key, txn_id)
    );
    -- ...except that the UNIQUE constraint above does NOT cover the manual case.
    -- In SQL two NULLs are never equal, so every manual mark (txn_id IS NULL)
    -- would satisfy the constraint and a double click would count the benefit
    -- twice. A partial unique index is the one thing that constrains it, and it
    -- is also the ON CONFLICT target upsertUsage infers for manual rows.
    CREATE UNIQUE INDEX IF NOT EXISTS cb_usage_manual_uniq
      ON cb_usage (benefit_id, period_key) WHERE txn_id IS NULL;
    CREATE INDEX IF NOT EXISTS cb_usage_benefit_idx ON cb_usage (benefit_id);
    -- CREATE TABLE IF NOT EXISTS skips a table that already exists, columns and
    -- all, so a database created before this column existed needs it added the
    -- same way db.js adds columns to its own tables.
    ALTER TABLE cb_usage ADD COLUMN IF NOT EXISTS confirmed_txn_id TEXT;

    CREATE TABLE IF NOT EXISTS cb_alerts (
      id SERIAL PRIMARY KEY,
      benefit_id INTEGER NOT NULL REFERENCES cb_benefits(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      tier TEXT NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      -- One row per tier per period, so the daily cron can re-run (or run twice)
      -- without re-nagging. Written only after the digest has actually gone out.
      UNIQUE (benefit_id, period_key, tier)
    );
  `);
}
