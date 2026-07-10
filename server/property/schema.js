// Canonical property-accounting schema. Tables are prefixed `pf_` (Property Finance)
// to avoid colliding with the existing `properties` table (FHFA-valuation tracking
// for net-worth accounts) already defined in server/db.js.
//
// Called once from server/db.js#initDb() alongside the rest of the app's migrations.
export async function initPropertyFinanceSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pf_properties (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      state TEXT DEFAULT 'FL',
      property_type TEXT DEFAULT 'condo',
      acquired_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_property_years (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      is_live BOOLEAN NOT NULL DEFAULT FALSE,
      data_source TEXT NOT NULL DEFAULT 'backfill', -- backfill | live
      opening_note TEXT,
      closed_at TIMESTAMPTZ,
      UNIQUE (property_id, year)
    );

    CREATE TABLE IF NOT EXISTS pf_transaction_sources (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL, -- plaid | import | manual
      label TEXT NOT NULL,
      plaid_account_id TEXT,
      import_batch_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_import_batches (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      year INTEGER,
      sheet_label TEXT,
      row_count INTEGER DEFAULT 0,
      imported_count INTEGER DEFAULT 0,
      review_count INTEGER DEFAULT 0,
      usage_period_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_category_mappings (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      match_key TEXT NOT NULL, -- normalized merchant/memo fragment
      normalized_category TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      last_used_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (property_id, match_key)
    );

    CREATE TABLE IF NOT EXISTS pf_allocation_rules (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      normalized_category TEXT,
      rental_use_percent NUMERIC(5,2) NOT NULL DEFAULT 100,
      personal_use_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      allocation_method TEXT NOT NULL DEFAULT 'full_rental', -- full_rental | days_ratio | manual | fixed_percent
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_usage_periods (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      start_date DATE,
      end_date DATE,
      usage_type TEXT NOT NULL DEFAULT 'rental', -- rental | personal | vacant
      days INTEGER,
      source_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_transactions (
      id TEXT PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      transaction_date DATE NOT NULL,
      posting_month TEXT NOT NULL, -- 'YYYY-MM'
      amount NUMERIC(12,2) NOT NULL, -- always positive; sign carried by direction column
      direction TEXT NOT NULL CHECK (direction IN ('income','expense')),
      normalized_category TEXT NOT NULL DEFAULT 'Uncategorized',
      source_category TEXT,
      merchant TEXT,
      memo TEXT,
      source_type TEXT NOT NULL DEFAULT 'import', -- plaid | import | manual
      source_reference_id TEXT,
      year INTEGER NOT NULL,
      is_reconciled BOOLEAN NOT NULL DEFAULT FALSE,
      reconciled_via_reserve_account BOOLEAN NOT NULL DEFAULT FALSE,
      allocation_method TEXT NOT NULL DEFAULT 'full_rental',
      rental_use_percent NUMERIC(5,2) NOT NULL DEFAULT 100,
      personal_use_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_year INTEGER,
      match_confidence NUMERIC(4,3),
      match_explanation TEXT,
      needs_review BOOLEAN NOT NULL DEFAULT FALSE,
      excluded BOOLEAN NOT NULL DEFAULT FALSE,
      raw_source_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pf_transactions_property_year_idx ON pf_transactions (property_id, year);
    CREATE INDEX IF NOT EXISTS pf_transactions_category_idx ON pf_transactions (normalized_category);

    CREATE TABLE IF NOT EXISTS pf_reconciliation_events (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      transaction_id TEXT REFERENCES pf_transactions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, -- matched | manual_match | reserve_account | excluded | reopened
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_review_queue (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      import_batch_id INTEGER REFERENCES pf_import_batches(id) ON DELETE CASCADE,
      year INTEGER,
      raw_row JSONB NOT NULL,
      reason TEXT NOT NULL,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pf_depreciation (
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (property_id, year)
    );

    CREATE TABLE IF NOT EXISTS pf_audit_log (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES pf_properties(id) ON DELETE CASCADE,
      transaction_id TEXT,
      action TEXT NOT NULL, -- category_edit | allocation_edit | reconcile | exclude | manual_add | import
      before_value JSONB,
      after_value JSONB,
      actor TEXT DEFAULT 'jared',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pf_audit_log_property_idx ON pf_audit_log (property_id, created_at DESC);
  `);
}
