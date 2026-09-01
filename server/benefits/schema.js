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
      -- This benefit's OWN reset date, overriding cb_cards.anniversary_date for
      -- an anniversary-basis period. Real catalogs need it: a Venture X credit
      -- renews December 17 whatever day the account was opened, and Platinum
      -- Sky Club visits run February through January. NULL means "follow the
      -- card", which is what every benefit did before this column existed.
      cycle_anchor DATE,
      -- What amount_limit and amount_used are DENOMINATED in, which also
      -- decides how usage is measured (benefits/derive.js): usd sums matched
      -- amounts, visits/count count matched transactions, and points cannot be
      -- derived from transactions at all (dollars are not points) so it lives
      -- on manual marks. CHECKed rather than free text for the same reason the
      -- two period enums are: an unrecognised value would silently read as usd
      -- and quietly turn a 10-visit allowance back into $10.
      unit TEXT NOT NULL DEFAULT 'usd'
        CHECK (unit IN ('usd','points','visits','count')),
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

    -- The ONE piece of usage this app persists (Brief 05, derive-on-read).
    -- Everything automatic — matched charges, matched credits, their pairing,
    -- the period totals and the confirmation state — is derived on every read
    -- from the transactions table + cb_match_rules and thrown away again
    -- (benefits/derive.js). The predecessor table, cb_usage, stored all of it
    -- and then had to keep it consistent as rules, transactions and periods
    -- changed; it could not, and every defect that model shipped was a flavour
    -- of that drift. A manual mark is the one fact nothing can derive: the
    -- owner saying "I used this".
    CREATE TABLE IF NOT EXISTS cb_manual_marks (
      id SERIAL PRIMARY KEY,
      benefit_id INTEGER NOT NULL REFERENCES cb_benefits(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,      -- from periods.js resolvePeriod().key
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      -- A plain UNIQUE, not the partial index cb_usage needed: with no txn_id
      -- column there are no NULLs to defeat it, so a double click updates one
      -- row instead of counting the benefit twice, and it is the ON CONFLICT
      -- target upsertManualMark names explicitly.
      UNIQUE (benefit_id, period_key)
    );
    CREATE INDEX IF NOT EXISTS cb_manual_marks_benefit_idx ON cb_manual_marks (benefit_id);

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

  // ── Added columns ───────────────────────────────────────────────────────────
  // CREATE TABLE IF NOT EXISTS says nothing about a table that already exists,
  // so anything added after the first release is an idempotent ALTER as well as
  // a line in the definition above (the audit_log pattern in db.js).
  //
  // The CHECK is dropped and re-added rather than guarded, because
  // ADD CONSTRAINT has no IF NOT EXISTS: dropping first makes the pair a no-op
  // on the second run and a repair on a database that somehow lost it.
  await pool.query(`
    ALTER TABLE cb_benefits ADD COLUMN IF NOT EXISTS cycle_anchor DATE;
    ALTER TABLE cb_benefits ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'usd';
    ALTER TABLE cb_benefits DROP CONSTRAINT IF EXISTS cb_benefits_unit_check;
    ALTER TABLE cb_benefits ADD CONSTRAINT cb_benefits_unit_check
      CHECK (unit IN ('usd','points','visits','count'));
  `);

  // ── Migration off cb_usage ──────────────────────────────────────────────────
  // Conditional, because CREATE TABLE IF NOT EXISTS above says nothing about a
  // table that has to GO. Manual marks are carried across; automatic rows are
  // dropped with no migration, by definition — they are reproducible from
  // `transactions` + the match rules, which is the entire point of the rebuild.
  //
  // Dropping them also fixes the legacy-row problem for free: the pre-fix
  // confirmed-credit rows that blocked a period from healing itself simply
  // cease to exist.
  //
  // to_regclass returns NULL rather than raising for a table that is not there,
  // so this is safe on a fresh database and a no-op on the second run.
  const { rows } = await pool.query(`SELECT to_regclass('public.cb_usage') AS t`);
  if (rows[0]?.t) {
    await pool.query(`
      INSERT INTO cb_manual_marks (benefit_id, period_key, amount, note, created_at)
      SELECT benefit_id, period_key, amount, note, created_at FROM cb_usage
      WHERE source = 'manual' AND txn_id IS NULL
      ON CONFLICT (benefit_id, period_key) DO NOTHING`);
    await pool.query(`DROP TABLE cb_usage`);
  }
}
