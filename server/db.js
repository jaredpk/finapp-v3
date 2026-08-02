import pg from "pg";
import { randomBytes, createHash } from "crypto";
import xlsxLib from "xlsx";
import { initPropertyFinanceSchema } from "./property/schema.js";
import { groupDuplicates, isImportedId, sameSignedAmount } from "./transactionMatching.js";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]$/, '');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      user_ref TEXT NOT NULL DEFAULT 'jared',
      key TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'Default',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_items (
      id SERIAL PRIMARY KEY,
      user_ref TEXT NOT NULL DEFAULT 'jared',
      access_token TEXT NOT NULL,
      item_id TEXT UNIQUE NOT NULL,
      institution_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS link_sessions (
      id TEXT PRIMARY KEY,
      user_ref TEXT NOT NULL DEFAULT 'jared',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transaction_cursors (
      item_id TEXT PRIMARY KEY,
      cursor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      user_ref TEXT NOT NULL DEFAULT 'jared',
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS assignments (
      transaction_id TEXT NOT NULL,
      category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (transaction_id)
    );

    CREATE TABLE IF NOT EXISTS splits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id TEXT NOT NULL,
      category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
      amount NUMERIC(12,2) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS merchant_overrides (
      transaction_id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS account_balances (
      id SERIAL PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      account TEXT NOT NULL,
      institution TEXT,
      type TEXT,
      balance NUMERIC(12,2) NOT NULL,
      available NUMERIC(12,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS investment_holdings (
      id SERIAL PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      ticker TEXT NOT NULL,
      institution TEXT,
      value NUMERIC(14,2) NOT NULL,
      day_change TEXT,
      gain_loss NUMERIC(14,2),
      gain_loss_pct TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      nickname TEXT,
      last_value NUMERIC(14,2),
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS manual_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      institution TEXT,
      subtype TEXT DEFAULT 'retirement',
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS account_nicknames (
      account_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add FHFA-based property valuation columns
  await pool.query(`
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS baseline_value NUMERIC(14,2);
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS baseline_date DATE;
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS baseline_fhfa_index NUMERIC(14,6);
    ALTER TABLE properties ADD COLUMN IF NOT EXISTS fhfa_msa INTEGER;
  `);

  // Vehicles (KBB-seeded, depreciation-drifted)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      year INT,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      trim TEXT,
      nickname TEXT,
      baseline_value NUMERIC(14,2),
      baseline_date DATE,
      last_value NUMERIC(14,2),
      last_synced_at TIMESTAMPTZ,
      depreciation_rate NUMERIC(5,4) DEFAULT 0.15,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add account column to investment_holdings to distinguish multiple accounts per institution
  await pool.query(`
    ALTER TABLE investment_holdings ADD COLUMN IF NOT EXISTS account TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      audit_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      filename TEXT,
      total_in_sheet INT DEFAULT 0,
      missing_count INT DEFAULT 0,
      inserted_count INT DEFAULT 0,
      range_start DATE,
      range_end DATE,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS range_start DATE;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS range_end DATE;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hidden_accounts (
      account_id TEXT PRIMARY KEY,
      hidden_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS simplifi_category_mappings (
      simplifi_category TEXT PRIMARY KEY,
      finapp_category_id UUID REFERENCES categories(id) ON DELETE SET NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS simplifi_account_mappings (
      simplifi_account TEXT PRIMARY KEY,
      finapp_account_id TEXT
    );
  `);

  // Add new transaction columns from Perplexity schema
  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS authorized_date        DATE,
      ADD COLUMN IF NOT EXISTS name                   TEXT,
      ADD COLUMN IF NOT EXISTS primary_category       TEXT,
      ADD COLUMN IF NOT EXISTS category_confidence    TEXT,
      ADD COLUMN IF NOT EXISTS pending_transaction_id TEXT,
      ADD COLUMN IF NOT EXISTS city                   TEXT,
      ADD COLUMN IF NOT EXISTS state                  TEXT,
      ADD COLUMN IF NOT EXISTS website                TEXT,
      ADD COLUMN IF NOT EXISTS logo_url               TEXT,
      ADD COLUMN IF NOT EXISTS original_description   TEXT,
      ADD COLUMN IF NOT EXISTS suggested_category     TEXT;
  `);

  // Migrate: rename clerk_user_id → user_ref in tables that still use a user identifier
  const renames = ['api_keys', 'user_items', 'link_sessions', 'oauth_codes'];
  for (const table of renames) {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${table}' AND column_name='clerk_user_id') THEN
          ALTER TABLE ${table} RENAME COLUMN clerk_user_id TO user_ref;
        END IF;
      END $$;
    `);
  }

  // Migrate: drop clerk_user_id from single-user tables
  const drops = ['categories', 'splits', 'merchant_overrides'];
  for (const table of drops) {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${table}' AND column_name='clerk_user_id') THEN
          ALTER TABLE ${table} DROP COLUMN clerk_user_id;
        END IF;
      END $$;
    `);
  }

  // Deduplicate categories (keep oldest per name, remap assignments)
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM (
          SELECT LOWER(name), COUNT(*) FROM categories GROUP BY LOWER(name) HAVING COUNT(*) > 1
        ) dupes
      ) THEN
        -- Remap assignments from duplicate category IDs to the oldest one
        UPDATE assignments a
        SET category_id = keeper.id
        FROM (
          SELECT DISTINCT ON (LOWER(name)) id, LOWER(name) AS name_lower
          FROM categories ORDER BY LOWER(name), created_at ASC
        ) keeper
        JOIN categories dupe ON LOWER(dupe.name) = keeper.name_lower AND dupe.id != keeper.id
        WHERE a.category_id = dupe.id;

        -- Delete duplicate categories (keep oldest)
        DELETE FROM categories WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(name) ORDER BY created_at ASC) AS rn
            FROM categories
          ) ranked WHERE rn > 1
        );
      END IF;
    END $$;
  `);

  // Merge duplicate/redundant categories (idempotent)
  const categoryMerges = [
    // Clear hyphen-based duplicates
    ['Car Insurance',      'Auto - Car Insurance'],
    ['Car Payment',        'Auto - Payment'],
    ['Gas & Fuel',         'Auto - Gas & Fuel'],
    ['Home Improvement',   'Home - Improvement'],
    ['Home Insurance',     'Insurance - Home'],
    ['Kids Healthcare',    'Kids - Healthcare'],
    ['Life Insurance',     'Insurance - Life'],
    ['Mortgage',           'Home - Mortgage'],
    ['Service & Parts',    'Auto - Service & Parts'],
    // Additional drops
    ['Auto & Transport',   'Auto - Other'],
    ['Parking',            'Fees & Charges'],
    ['Registration Fees',  'Fees & Charges'],
  ];
  for (const [from, to] of categoryMerges) {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM categories WHERE name = '${from}')
        AND EXISTS (SELECT 1 FROM categories WHERE name = '${to}') THEN
          UPDATE assignments
            SET category_id = (SELECT id FROM categories WHERE name = '${to}')
            WHERE category_id = (SELECT id FROM categories WHERE name = '${from}');
          UPDATE splits
            SET category_id = (SELECT id FROM categories WHERE name = '${to}')
            WHERE category_id = (SELECT id FROM categories WHERE name = '${from}');
          DELETE FROM categories WHERE name = '${from}';
        END IF;
      END $$;
    `);
  }

  // Add updated_at to tables if missing (created before this column existed)
  await pool.query(`
    ALTER TABLE assignments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    ALTER TABLE merchant_overrides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
  `);

  // Cashflow presets, per-month transaction states, and merchant mapping rules
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashflow_presets (
      name TEXT PRIMARY KEY,
      amount NUMERIC(12,2) NOT NULL,
      freq TEXT,
      note TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cashflow_txn_states (
      account_id TEXT NOT NULL,
      txn_id INTEGER NOT NULL,
      month_key TEXT NOT NULL,
      is_pending BOOLEAN DEFAULT FALSE,
      actual_amount NUMERIC(12,2),
      plaid_txn_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (account_id, txn_id, month_key)
    );

    CREATE TABLE IF NOT EXISTS cashflow_mappings (
      merchant_pattern TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      txn_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS suppressed_transactions (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      txn_id TEXT,
      date DATE,
      merchant TEXT,
      amount NUMERIC(12,2),
      account TEXT,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE cashflow_txn_states ADD COLUMN IF NOT EXISTS plaid_txn_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE cashflow_txn_states ADD COLUMN IF NOT EXISTS actual_day INTEGER;
  `);

  await pool.query(`
    ALTER TABLE cashflow_txn_states ADD COLUMN IF NOT EXISTS note TEXT;
  `);

  // Drop the old BEFORE INSERT duplicate guard. Plaid's transaction_id is the
  // primary key and every sync path upserts with ON CONFLICT (id), so ingestion
  // is already idempotent without a trigger. What the trigger actually did was
  // key on (date, ABS(amount), account): stripping the sign collapsed a charge
  // with its refund and a card payment with its funding leg, and `RETURN NULL`
  // discarded the row with no error and no trace. csv_ rows were exempt, so the
  // only rows it ever destroyed were Plaid-native and imported ones. Idempotent —
  // safe to run on every boot, including databases that never had the trigger.
  //
  // Isolated from the fail-fast init path on purpose. DROP TRIGGER requires
  // ownership of the table, so a role that can read and write transactions can
  // still fail here. That must not take the app down: booting with the old
  // trigger in place is bad — it keeps discarding credits — but it is strictly
  // better than not booting at all, and the error below says exactly what to
  // fix. Every other guard against the ABS() key lives in application code and
  // is unaffected by this statement failing.
  try {
    await pool.query(`
      DROP TRIGGER IF EXISTS check_duplicate_transactions ON transactions;
      DROP FUNCTION IF EXISTS prevent_duplicate_transactions();
    `);
  } catch (e) {
    console.error(
      "MIGRATION FAILED: could not drop check_duplicate_transactions. The old " +
        "duplicate guard is STILL ACTIVE and will keep silently discarding " +
        "credits on insert. Drop it manually as the table owner:\n" +
        "  DROP TRIGGER IF EXISTS check_duplicate_transactions ON transactions;\n" +
        "  DROP FUNCTION IF EXISTS prevent_duplicate_transactions();\n" +
        `Cause: ${e.message}`
    );
  }

  // Migrate assignments: drop clerk_user_id and fix primary key if needed
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assignments' AND column_name='clerk_user_id') THEN
        ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_pkey;
        ALTER TABLE assignments DROP COLUMN clerk_user_id;
        ALTER TABLE assignments ADD PRIMARY KEY (transaction_id);
      END IF;
    END $$;
  `);

  await initPropertyFinanceSchema(pool);
}

// ── Advisory locks ────────────────────────────────────────────────────────────
// Session-level Postgres locks, used to keep concurrent syncs (webhook, startup,
// daily timer, manual) from interleaving upserts and cursor writes for the same
// item. Non-blocking on purpose: a sync that can't get the lock is redundant
// with the one already running, so skipping is the correct outcome.
//
// pg_try_advisory_lock is scoped to the *session*, and pool.query() hands out an
// arbitrary connection each call — so the lock is held on a dedicated client
// that stays checked out until it is released, otherwise the unlock would run on
// a different session and the lock would linger until the pool recycled it.
const advisoryLockClients = new Map();

export async function tryAdvisoryLock(key) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [key]);
    if (rows[0]?.locked !== true) {
      client.release();
      return false;
    }
    advisoryLockClients.set(key, client);
    return true;
  } catch (e) {
    client.release();
    throw e;
  }
}

export async function releaseAdvisoryLock(key) {
  const client = advisoryLockClients.get(key);
  if (!client) return;
  advisoryLockClients.delete(key);
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [key]);
    client.release();
  } catch (e) {
    // The unlock did not complete, so this session may still hold the lock.
    // Returning the connection to the pool would leave it held for as long as
    // the pool keeps the connection alive, and every later sync would log
    // "sync already in progress, skipping" forever with no other symptom.
    // release(true) destroys the connection so Postgres ends the session.
    client.release(true);
    throw e;
  }
}

// ── API Keys ──────────────────────────────────────────────────────────────────
export async function getApiKeyForUser() {
  const { rows } = await pool.query(
    "SELECT key FROM api_keys ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0]?.key || null;
}

export async function createApiKey() {
  const key = randomBytes(32).toString("hex");
  await pool.query("DELETE FROM api_keys");
  await pool.query("INSERT INTO api_keys (user_ref, key) VALUES ('jared', $1)", [key]);
  return key;
}

export async function getClerkUserIdByApiKey(key) {
  const { rows } = await pool.query("SELECT user_ref FROM api_keys WHERE key = $1", [key]);
  return rows[0]?.user_ref || null;
}

// ── Link sessions ─────────────────────────────────────────────────────────────
export async function createLinkSession() {
  const id = randomBytes(16).toString("hex");
  await pool.query(
    "INSERT INTO link_sessions (id, user_ref, expires_at) VALUES ($1, 'jared', NOW() + INTERVAL '30 minutes')",
    [id]
  );
  return id;
}

export async function getLinkSession(id) {
  const { rows } = await pool.query(
    "SELECT user_ref FROM link_sessions WHERE id = $1 AND expires_at > NOW()",
    [id]
  );
  return rows[0] || null;
}

export async function deleteLinkSession(id) {
  await pool.query("DELETE FROM link_sessions WHERE id = $1", [id]);
}

// ── User items (banks) ────────────────────────────────────────────────────────
export async function getUserItems() {
  const { rows } = await pool.query(
    `SELECT access_token AS "accessToken", item_id AS "itemId", institution_name AS "institutionName"
     FROM user_items`
  );
  return rows;
}

export async function upsertUserItem(accessToken, itemId, institutionName) {
  await pool.query(
    `INSERT INTO user_items (user_ref, access_token, item_id, institution_name)
     VALUES ('jared', $1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE SET institution_name = $3`,
    [accessToken, itemId, institutionName || null]
  );
}

export async function removeUserItem(itemId) {
  const { rowCount } = await pool.query(
    "DELETE FROM user_items WHERE item_id = $1",
    [itemId]
  );
  return rowCount > 0;
}

// ── Cursors ───────────────────────────────────────────────────────────────────
export async function getCursor(itemId) {
  const { rows } = await pool.query(
    "SELECT cursor FROM transaction_cursors WHERE item_id = $1",
    [itemId]
  );
  return rows[0]?.cursor || undefined;
}

export async function saveCursor(itemId, cursor) {
  await pool.query(
    `INSERT INTO transaction_cursors (item_id, cursor, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (item_id) DO UPDATE SET cursor = $2, updated_at = NOW()`,
    [itemId, cursor]
  );
}

// Clearing an item's cursor makes the next /transactions/sync replay that
// item's full history as `added` instead of resuming where it left off. That is
// the recovery path for rows the old ABS()-keyed dedup destroyed: Plaid resends
// them, and ON CONFLICT (id) turns every row that survived into a no-op.
//
// Safe only because the two mechanisms that dropped rows on the way in are both
// gone. Replaying while either was live would just delete the same rows again.
// Cursors are trivially reproducible — the next sync writes a fresh one.
// Passing an explicit empty array clears nothing. Only omitting the argument
// entirely means "every item" — an empty list is a caller with nothing to do,
// not a caller asking to wipe them all.
export async function clearCursors(itemIds) {
  if (Array.isArray(itemIds)) {
    if (itemIds.length === 0) return 0;
    const { rowCount } = await pool.query(
      "DELETE FROM transaction_cursors WHERE item_id = ANY($1)",
      [itemIds]
    );
    return rowCount;
  }
  const { rowCount } = await pool.query("DELETE FROM transaction_cursors");
  return rowCount;
}

// Id snapshot for the replay diff, so the caller can report exactly which rows
// came back rather than just a count.
// plaidNativeOnly excludes csv_/simplifi_ rows. A replay only ever affects rows
// Plaid manages, so counting imported rows alongside them would report a total
// that has nothing to do with what the replay did.
export async function listTransactionIds({ startDate, endDate, plaidNativeOnly = false } = {}) {
  const conditions = [];
  const params = [];
  let i = 1;
  if (startDate) { conditions.push(`date >= $${i++}::date`); params.push(startDate); }
  if (endDate) { conditions.push(`date <= $${i++}::date`); params.push(endDate); }
  if (plaidNativeOnly) conditions.push(`id NOT LIKE 'csv_%' AND id NOT LIKE 'simplifi_%'`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT id FROM transactions ${where}`, params);
  return rows.map((r) => r.id);
}

export async function getTransactionsByIds(ids) {
  if (!ids?.length) return [];
  const { rows } = await pool.query(
    `SELECT id, TO_CHAR(date,'YYYY-MM-DD') AS date, merchant, amount::float AS amount,
            account, plaid_category, status
     FROM transactions WHERE id = ANY($1) ORDER BY date, amount`,
    [ids]
  );
  return rows;
}

// ── Transactions (Perplexity schema) ──────────────────────────────────────────
// Perplexity columns: id, date, merchant, amount, currency, account, payment_channel, plaid_category, status, created_at

export async function upsertTransactions(transactions) {
  for (const t of transactions) {
    const txnId = t.transaction_id || t.id;
    const merchant = t.merchant_name || t.name || t.merchant || null;
    const category = t.personal_finance_category?.primary || t.category?.[0] || t.plaid_category || null;
    const status = t.pending ? 'pending' : 'reviewed';  // constraint: pending | reviewed
    const pendingTxnId = t.pending_transaction_id || null;
    await pool.query(
      `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency, pending_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8)
       ON CONFLICT (id) DO UPDATE SET amount = $4, status = $7, pending_transaction_id = $8`,
      [txnId, t.date, merchant, t.amount, t.account_id || t.account || 'unknown', category, status, pendingTxnId]
    );
  }
}

export async function getTransactions({ limit = 100, startDate, endDate, category } = {}) {
  const conditions = [];
  const params = [];
  let i = 1;
  if (startDate) { conditions.push(`date >= $${i++}`); params.push(startDate); }
  if (endDate)   { conditions.push(`date <= $${i++}`); params.push(endDate); }
  if (category)  { conditions.push(`LOWER(plaid_category) = LOWER($${i++})`); params.push(category); }
  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT
       id AS transaction_id,
       TO_CHAR(date, 'YYYY-MM-DD') AS date,
       TO_CHAR(authorized_date, 'YYYY-MM-DD') AS authorized_date,
       merchant AS merchant_name,
       name,
       amount::float,
       currency,
       account AS account_id,
       payment_channel,
       plaid_category AS category,
       primary_category,
       category_confidence,
       pending_transaction_id,
       city,
       state,
       website,
       logo_url,
       original_description,
       suggested_category,
       (status = 'pending') AS pending,
       hidden,
       created_at
     FROM transactions ${where} ORDER BY date DESC LIMIT $${i}`,
    params
  );
  return rows;
}

export async function getSpendingByCategory({ startDate, endDate } = {}) {
  const conditions = ["status != 'pending'", "amount > 0", "(hidden IS NOT TRUE)", "(account NOT IN (SELECT account_id FROM hidden_accounts))"];
  const params = [];
  let i = 1;
  if (startDate) { conditions.push(`date >= $${i++}`); params.push(startDate); }
  if (endDate)   { conditions.push(`date <= $${i++}`); params.push(endDate); }
  const { rows } = await pool.query(
    `SELECT plaid_category AS category, SUM(amount)::numeric AS total, COUNT(*)::int AS count
     FROM transactions WHERE ${conditions.join(" AND ")}
     GROUP BY plaid_category ORDER BY total DESC`,
    params
  );
  return rows;
}

// Full-fidelity upsert for Quadratic imports — uses real Plaid transaction_ids and all extended columns.
// Returns the number of rows actually written, so callers report what landed
// rather than what they handed us.
export async function upsertPlaidTransactions(transactions) {
  let written = 0;
  for (const t of transactions) {
    if (!t.id || t.amount == null) {
      // A Plaid row we were given and did not store. Record it — dropping rows
      // with no trace is what let real credits disappear. A row with no id can
      // also carry an unparseable date, and t.date goes into a DATE column: if
      // that insert throws it must not abort the rest of the import, which is
      // already half-written by this point.
      try {
        await recordSuppression({
          source: 'upsertPlaidTransactions',
          txnId: t.id,
          date: t.date,
          merchant: t.merchant,
          amount: t.amount,
          account: t.account,
          reason: 'missing id or amount',
        });
      } catch (e) {
        console.error("Failed to record suppression:", e.message);
      }
      continue;
    }
    const { rowCount } = await pool.query(
      `INSERT INTO transactions
         (id, date, merchant, amount, account, plaid_category, status, currency,
          pending_transaction_id, authorized_date, name, primary_category,
          category_confidence, city, state, website, logo_url, original_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         amount                = EXCLUDED.amount,
         status                = EXCLUDED.status,
         pending_transaction_id = EXCLUDED.pending_transaction_id,
         merchant              = EXCLUDED.merchant,
         plaid_category        = EXCLUDED.plaid_category,
         primary_category      = EXCLUDED.primary_category,
         category_confidence   = EXCLUDED.category_confidence,
         city                  = EXCLUDED.city,
         state                 = EXCLUDED.state,
         website               = EXCLUDED.website,
         logo_url              = EXCLUDED.logo_url,
         original_description  = EXCLUDED.original_description`,
      [
        t.id, t.date, t.merchant, t.amount, t.account, t.plaid_category,
        t.status, t.currency, t.pending_transaction_id, t.authorized_date,
        t.name, t.primary_category, t.category_confidence,
        t.city, t.state, t.website, t.logo_url, t.original_description,
      ]
    );
    if (rowCount > 0) written++;
  }
  return written;
}

export async function deleteRemovedTransactions(ids) {
  if (!ids?.length) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM transactions WHERE id = ANY($1)`,
    [ids]
  );
  return rowCount;
}

// ── Category suggestion logic ─────────────────────────────────────────────────

const PLAID_CATEGORY_MAP = {
  TRANSFER_IN:                              "Transfer",
  TRANSFER_OUT:                             "Transfer",
  TRANSFER_DEBIT:                           "Transfer",
  TRANSFER_CREDIT:                          "Transfer",
  LOAN_PAYMENTS:                            "Credit Card Payment",
  CREDIT_CARD_PAYMENT:                      "Credit Card Payment",
  BANK_FEES:                                "Fees & Charges",
  INCOME_WAGES:                             "Personal Income",
  INCOME_OTHER_INCOME:                      "Personal Income",
  FOOD_AND_DRINK_GROCERIES:                 "Groceries",
  FOOD_AND_DRINK_RESTAURANTS:               "Dining Out",
  FOOD_AND_DRINK_FAST_FOOD:                 "Dining Out",
  TRANSPORTATION_GAS_STATION:               "Auto - Gas & Fuel",
  TRANSPORTATION_PARKING:                   "Fees & Charges",
  TRANSPORTATION_PUBLIC_TRANSIT:            "Auto - Other",
  TRANSPORTATION_TAXIS:                     "Auto - Other",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY:   "Utilities",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE:    "Utilities",
  RENT_AND_UTILITIES_TELEPHONE:             "Utilities - Phone",
  RENT_AND_UTILITIES_RENT:                  "Home - Mortgage",
  MEDICAL:                                  "Health",
  PERSONAL_CARE:                            "Health",
  ENTERTAINMENT:                            "Entertainment",
  TRAVEL:                                   "Rec and Vacation",
  GENERAL_MERCHANDISE:                      "Shopping",
  SUBSCRIPTION:                             "Subscriptions",
};

const KEYWORD_RULES = [
  { keywords: ["TRANSFER IN", "TRANSFER OUT", "TRANSFER FROM", "TRANSFER TO", "ONLINE TRANSFER", "ACH TRANSFER", "WIRE TRANSFER", "XFER FROM", "XFER TO", "XFER"], category: "Transfer" },
  { keywords: ["AUTOPAY", "AUTO PAY"],                           category: "Credit Card Payment" },
  { keywords: ["PAYROLL", "DIRECT DEP", "DIRECT DEPOSIT", "SALARY", "PAYCHECK"], category: "Personal Income" },
  { keywords: ["MORTGAGE"],                                      category: "Home - Mortgage" },
  { keywords: ["NETFLIX", "HULU", "SPOTIFY", "DISNEY", "HBO", "APPLE.COM/BILL", "YOUTUBE PREMIUM", "PEACOCK", "PARAMOUNT"], category: "Subscriptions" },
  { keywords: ["AMAZON"],                                        category: "Shopping" },
  { keywords: ["COSTCO", "WALMART", "TARGET", "SMITH'S", "SMITHS", "KROGER", "WHOLE FOODS", "TRADER JOE", "WINCO", "HARMONS", "ALBERTSONS"], category: "Groceries" },
  { keywords: ["DOORDASH", "GRUBHUB", "UBER EATS"],             category: "Dining Out" },
  { keywords: ["UBER", "LYFT"],                                  category: "Auto - Other" },
  { keywords: ["CHEVRON", "SHELL", "EXXON", "MAVERICK", "LOVES", "SINCLAIR", "PHILLIPS 66"], category: "Auto - Gas & Fuel" },
  { keywords: ["DELTA", "UNITED AIRLINES", "SOUTHWEST", "AMERICAN AIR", "AIRBNB", "MARRIOTT", "HILTON", "HYATT"], category: "Rec and Vacation" },
];

function suggestCategoryForTx(tx) {
  const searchStr = [tx.merchant, tx.name, tx.original_description]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  // 1. Keyword rules first
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((k) => searchStr.includes(k))) return rule.category;
  }

  // 2. Plaid primary_category
  if (tx.primary_category) {
    const key = tx.primary_category.toUpperCase().replace(/\./g, "_");
    if (PLAID_CATEGORY_MAP[key]) return PLAID_CATEGORY_MAP[key];
    const prefix = Object.keys(PLAID_CATEGORY_MAP).find((k) => key.startsWith(k));
    if (prefix) return PLAID_CATEGORY_MAP[prefix];
  }

  // 3. plaid_category fallback
  if (tx.plaid_category) {
    const detailed = tx.plaid_category.toUpperCase().replace(/\./g, "_");
    const match = Object.keys(PLAID_CATEGORY_MAP).find((k) => detailed.includes(k));
    if (match) return PLAID_CATEGORY_MAP[match];
  }

  return null;
}

// Populate suggested_category on transactions that don't have one yet
export async function populateSuggestedCategories() {
  const { rows: txns } = await pool.query(`
    SELECT id, merchant, name, original_description, primary_category, plaid_category
    FROM transactions
    WHERE suggested_category IS NULL
  `);

  let updated = 0;
  for (const tx of txns) {
    const suggestion = suggestCategoryForTx(tx);
    if (suggestion) {
      await pool.query(
        `UPDATE transactions SET suggested_category = $1 WHERE id = $2`,
        [suggestion, tx.id]
      );
      updated++;
    }
  }
  return updated;
}

// Auto-assign suggested_category to unassigned transactions using live categories table
export async function applySuggestedCategories() {
  const { rows: cats } = await pool.query(
    `SELECT id, LOWER(name) AS name_lower FROM categories`
  );
  const catMap = {};
  cats.forEach(c => { catMap[c.name_lower] = c.id; });

  const { rows: txns } = await pool.query(`
    SELECT t.id, t.suggested_category
    FROM transactions t
    LEFT JOIN assignments a ON a.transaction_id = t.id
    WHERE t.suggested_category IS NOT NULL AND a.transaction_id IS NULL
  `);

  let assigned = 0;
  for (const t of txns) {
    const catId = catMap[t.suggested_category.toLowerCase()];
    if (catId) {
      await pool.query(
        `INSERT INTO assignments (transaction_id, category_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (transaction_id) DO NOTHING`,
        [t.id, catId]
      );
      assigned++;
    }
  }
  return assigned;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
export async function saveOAuthState(state, redirectUri, codeChallenge, codeChallengeMethod) {
  await pool.query(
    `INSERT INTO oauth_states (state, redirect_uri, code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (state) DO NOTHING`,
    [state, redirectUri, codeChallenge || null, codeChallengeMethod || null]
  );
}

export async function getOAuthState(state) {
  const { rows } = await pool.query(
    "SELECT * FROM oauth_states WHERE state = $1 AND expires_at > NOW()",
    [state]
  );
  return rows[0] || null;
}

export async function deleteOAuthState(state) {
  await pool.query("DELETE FROM oauth_states WHERE state = $1", [state]);
}

export async function saveOAuthCode(code, redirectUri, codeChallenge) {
  await pool.query(
    `INSERT INTO oauth_codes (code, user_ref, redirect_uri, code_challenge, expires_at)
     VALUES ($1, 'jared', $2, $3, NOW() + INTERVAL '5 minutes')`,
    [code, redirectUri, codeChallenge || null]
  );
}

export async function getOAuthCode(code) {
  const { rows } = await pool.query(
    "SELECT * FROM oauth_codes WHERE code = $1 AND expires_at > NOW()",
    [code]
  );
  return rows[0] || null;
}

export async function deleteOAuthCode(code) {
  await pool.query("DELETE FROM oauth_codes WHERE code = $1", [code]);
}

// ── CSV Import (Perplexity export format) ─────────────────────────────────────
// Parses a Perplexity transactions-only CSV export and returns rows with stable hash IDs.
// Identical rows on the same day get an occurrence index so two $1.50 hotdogs
// on the same day produce two distinct hashes rather than collapsing into one.
export function parseCsvText(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const dataLines = lines.slice(1); // skip header row

  const counts = new Map();
  const rows = [];

  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const [dateRaw, merchantRaw, categoryRaw, amountRaw, ...accountParts] = parts;
    const date = dateRaw.trim();
    const merchant = merchantRaw.trim() || null;
    const category = categoryRaw.trim() || null;
    const amount = parseFloat(amountRaw.trim());
    const account = accountParts.join(',').trim();
    if (!date || isNaN(amount)) continue;

    const key = `${date}|${merchant}|${category}|${amount}|${account}`;
    const idx = counts.get(key) ?? 0;
    counts.set(key, idx + 1);

    const id = 'csv_' + createHash('sha256').update(`${key}|${idx}`).digest('hex').slice(0, 16);
    rows.push({ id, date, merchant, category, amount, account });
  }

  return rows;
}

// Splits a single CSV line respecting double-quoted fields.
function splitCsvLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

// Parses a Mountain America CU exportedtransactions.csv.
//
// Actual MACU format (quoted fields, signed Amount column):
//   "Transaction ID","Posting Date","Effective Date","Transaction Type",
//   "Amount","Check Number","Reference Number","Description",
//   "Transaction Category","Type","Balance","Memo","Extended Description"
//
// Also handles simpler "Number,Date,Description,Debit,Credit,Balance"
// and "Date,Description,Amount,Balance" variants.
//
// MACU sign convention: positive = credit (income), negative = debit (expense).
// Our DB / Plaid convention: positive = expense, negative = income.
// → negate the amount before storing.
export function parseMacuCsvText(csvText, accountName = "MACU Shared Checking") {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);

  // Find the header row: must contain "date" somewhere in the line
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (low.includes('date')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];

  // Strip quotes and non-alpha chars for easy matching
  const header = splitCsvLine(lines[headerIdx]).map(h => h.toLowerCase().trim().replace(/[^a-z]/g, ''));

  // Partial-match lookup so "postingdate" matches when we search for "date"
  const findCol = (name) => {
    const exact = header.indexOf(name);
    if (exact >= 0) return exact;
    return header.findIndex(h => h.includes(name));
  };

  // Prefer "posting date" over "effective date" — findIndex returns first match
  const dateIdx   = findCol('postingdate') >= 0 ? findCol('postingdate') : findCol('date');
  // Prefer plain "description" over "extended description"
  const descIdx   = (() => {
    const plain = header.indexOf('description');
    return plain >= 0 ? plain : findCol('description');
  })();
  const debitIdx  = findCol('debit');
  const creditIdx = findCol('credit');
  const amountIdx = findCol('amount');

  if (dateIdx === -1) return [];

  const counts = new Map();
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    if (parts.length <= dateIdx) continue;
    const dateRaw = parts[dateIdx]?.trim();
    if (!dateRaw) continue;

    // Normalise date: M/D/YYYY or MM/DD/YYYY → YYYY-MM-DD
    let date;
    const mdy = dateRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
      date = `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    } else {
      date = dateRaw;
    }

    const merchant = descIdx >= 0 ? (parts[descIdx]?.trim() || null) : null;

    let amount;
    if (debitIdx >= 0 && creditIdx >= 0) {
      // Separate Debit / Credit columns — both are positive values
      const debit  = parseFloat(parts[debitIdx]?.trim()  || '0') || 0;
      const credit = parseFloat(parts[creditIdx]?.trim() || '0') || 0;
      // Our convention: debit (expense) = positive, credit (income) = negative
      amount = debit > 0 ? debit : -credit;
    } else if (amountIdx >= 0) {
      // Signed Amount column: MACU positive = income, negative = expense.
      // Flip sign to match Plaid / our DB convention.
      amount = -(parseFloat(parts[amountIdx]?.trim() || '0') || 0);
    } else {
      continue;
    }

    if (!date || isNaN(amount)) continue;

    const key = `${date}|${merchant}|${amount}|${accountName}`;
    const idx = counts.get(key) ?? 0;
    counts.set(key, idx + 1);

    const id = 'csv_' + createHash('sha256').update(`${key}|${idx}`).digest('hex').slice(0, 16);
    rows.push({ id, date, merchant, category: null, amount, account: accountName });
  }

  return rows;
}

// Parses a Quadratic multi-sheet xlsx export.
// Sheets ending in " Transactions" → transactions (real Plaid IDs).
// Sheets ending in " Balances" → latest balance per account.
export function parseQuadraticXlsx(wb) {
  const { utils } = xlsxLib;
  const today = new Date().toISOString().slice(0, 10);

  const normalizeDate = (v) => {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = v.toString().trim();
    return s.includes('T') ? s.slice(0, 10) : s || null;
  };

  const transactions = [];
  for (const sheetName of wb.SheetNames.filter(n => n.endsWith(' Transactions'))) {
    const rows = utils.sheet_to_json(wb.Sheets[sheetName], { raw: false, cellDates: true, range: 1, defval: null });
    for (const r of rows) {
      if (!r['transaction_id']) continue;
      transactions.push({
        id:                     r['transaction_id'],
        date:                   normalizeDate(r['date']),
        merchant:               r['merchant_name'] || r['name'] || null,
        amount:                 r['amount'] != null ? parseFloat(r['amount']) : null,
        account:                r['account_id'] || 'unknown',
        plaid_category:         r['personal_finance_category_primary'] || null,
        status:                 String(r['pending']).toLowerCase() === 'true' ? 'pending' : 'reviewed',
        currency:               r['iso_currency_code'] || 'USD',
        pending_transaction_id: r['pending_transaction_id'] || null,
        authorized_date:        normalizeDate(r['authorized_date']),
        name:                   r['name'] || null,
        primary_category:       r['personal_finance_category_primary'] || null,
        category_confidence:    r['personal_finance_category_confidence_level'] || null,
        city:                   r['location_city'] || null,
        state:                  r['location_region'] || null,
        website:                r['website'] || null,
        logo_url:               r['logo_url'] || null,
        original_description:   r['original_description'] || null,
      });
    }
  }

  // Take the latest balance row per account_id across all balance sheets
  const latestByAccount = new Map();
  for (const sheetName of wb.SheetNames.filter(n => n.endsWith(' Balances'))) {
    const institution = sheetName.replace(/ Balances$/, '');
    const rows = utils.sheet_to_json(wb.Sheets[sheetName], { raw: false, cellDates: true, range: 1, defval: null });
    for (const r of rows) {
      if (!r['account_id']) continue;
      const dateStr = normalizeDate(r['date']);
      const existing = latestByAccount.get(r['account_id']);
      if (!existing || dateStr > existing.date) {
        latestByAccount.set(r['account_id'], { r, date: dateStr, institution });
      }
    }
  }

  const balances = Array.from(latestByAccount.values()).map(({ r, institution }) => {
    const balance = parseFloat(r['balances_current']);
    if (isNaN(balance)) return null;
    const available = r['balances_available'] != null ? parseFloat(r['balances_available']) : null;
    return {
      account:     r['name'] || r['mask'] || 'Unknown',
      institution,
      type:        r['type'] || null,
      balance,
      available:   isNaN(available) ? null : available,
    };
  }).filter(Boolean);

  return { transactions, balances, holdings: [], snapshotDate: today, isPlaidNative: true };
}

// Parses a dual-tab xlsx export (base64-encoded) and returns { transactions, balances, snapshotDate }.
// Auto-detects Quadratic format (sheets ending in " Transactions"/" Balances") vs legacy format.
// "Account Balances" sheet → balances; "Transactions" sheet → transactions with stable hash IDs.
export function parseXlsxBase64(base64, snapshotDate) {
  const { read, utils } = xlsxLib;
  const wb = read(Buffer.from(base64, 'base64'), { type: 'buffer', cellDates: true });

  // Detect Quadratic format
  if (wb.SheetNames.some(n => / Transactions$| Balances$/.test(n))) {
    return parseQuadraticXlsx(wb);
  }

  const balancesWs = wb.Sheets['Account Balances'];
  const balances = balancesWs
    ? utils.sheet_to_json(balancesWs, { raw: true }).map(r => {
        const bal = parseFloat(r['Balance (USD)'] ?? r['Balance']);
        if (!r['Account'] || isNaN(bal)) return null;
        const availRaw = r['Available (USD)'] ?? r['Available'];
        return {
          account: r['Account'].toString().trim(),
          institution: r['Institution']?.toString().trim() || null,
          type: r['Type']?.toString().trim() || null,
          balance: bal,
          available: availRaw != null ? parseFloat(availRaw) : null,
        };
      }).filter(Boolean)
    : [];

  const holdingsWs = wb.Sheets['Investment Holdings'];
  const isSummaryTicker = (t) => /total|count|change|\btoday\b|portfolio|holding/i.test(t);
  const holdings = holdingsWs
    ? utils.sheet_to_json(holdingsWs, { raw: true }).map(r => {
        const value = parseFloat(r['Value (USD)'] ?? r['Value']);
        if (!r['Ticker'] || isNaN(value) || isSummaryTicker(r['Ticker'])) return null;
        const glRaw = r['Gain/Loss (USD)'] ?? r['Gain/Loss'];
        return {
          ticker: r['Ticker'].toString().trim(),
          institution: r['Institution']?.toString().trim() || null,
          account: r['Account']?.toString().trim() || null,
          value,
          day_change: r['Day Chg %']?.toString().trim() || r['Day Change']?.toString().trim() || null,
          gain_loss: glRaw != null ? parseFloat(glRaw) : null,
          gain_loss_pct: r['Gain/Loss %']?.toString().trim() || null,
        };
      }).filter(Boolean)
    : [];

  const txnWs = wb.Sheets['Transactions'];
  const counts = new Map();
  const transactions = txnWs
    ? utils.sheet_to_json(txnWs, { raw: true, cellDates: true }).map(r => {
        const date = r['Date'] instanceof Date
          ? r['Date'].toISOString().slice(0, 10)
          : r['Date']?.toString().trim();
        const merchant = r['Merchant']?.toString().trim() || null;
        const category = r['Category']?.toString().trim() || null;
        const amount = parseFloat(r['Amount (USD)'] ?? r['Amount']);
        const account = r['Account']?.toString().trim() || null;
        if (!date || isNaN(amount)) return null;

        const key = `${date}|${merchant}|${category}|${amount}|${account}`;
        const idx = counts.get(key) ?? 0;
        counts.set(key, idx + 1);
        const id = 'csv_' + createHash('sha256').update(`${key}|${idx}`).digest('hex').slice(0, 16);
        return { id, date, merchant, category, amount, account };
      }).filter(Boolean)
    : [];

  return { transactions, balances, holdings, snapshotDate: snapshotDate ?? new Date().toISOString().slice(0, 10) };
}

// ── Simplifi CSV import ───────────────────────────────────────────────────────

// Categories in Simplifi that carry no meaningful categorization signal.
// Transactions with these will still be imported but never used to apply categories.
const SIMPLIFI_JUNK_CATEGORIES = new Set([
  '', '-', 'n/a', 'na', 'none', 'uncategorized', 'other', 'unknown',
  'balance adjustment', 'transfer',
]);

export function isJunkSimplifiCategory(cat) {
  return !cat || SIMPLIFI_JUNK_CATEGORIES.has(cat.toLowerCase().trim());
}

// Parses Quicken Simplifi "Transactions" CSV export.
// Format: Date,Account,Payee,Category,Exclusion,Amount
// Simplifi sign: negative=expense, positive=income → negate to match Plaid convention.
export function parseSimplifiCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 6) continue;
    const dateStr  = cols[0].replace(/^"|"$/g, '').trim();
    const account  = cols[1].replace(/^"|"$/g, '').trim();
    const payee    = cols[2].replace(/^"|"$/g, '').trim();
    const category = cols[3].replace(/^"|"$/g, '').trim();
    const exclusion = cols[4].replace(/^"|"$/g, '').trim().toLowerCase();
    const amountStr = cols[5].replace(/^"|"$/g, '').trim();
    if (exclusion === 'yes') continue;
    if (category === 'Balance Adjustment') continue;
    const raw = parseFloat(amountStr);
    if (isNaN(raw)) continue;
    const dateObj = new Date(dateStr);
    if (isNaN(dateObj.getTime())) continue;
    const date = dateObj.toISOString().slice(0, 10);
    const dbAmount = parseFloat((-raw).toFixed(2));
    rows.push({ date, account, payee, category, dbAmount });
  }
  return rows;
}

export async function getSimplifiMappings() {
  const { rows } = await pool.query('SELECT simplifi_category, finapp_category_id FROM simplifi_category_mappings');
  const map = {};
  for (const r of rows) map[r.simplifi_category] = r.finapp_category_id;
  return map;
}

export async function saveSimplifiMappings(mappings) {
  for (const [simplifi_category, finapp_category_id] of Object.entries(mappings)) {
    await pool.query(
      `INSERT INTO simplifi_category_mappings (simplifi_category, finapp_category_id)
       VALUES ($1, $2)
       ON CONFLICT (simplifi_category) DO UPDATE SET finapp_category_id = EXCLUDED.finapp_category_id`,
      [simplifi_category, finapp_category_id || null]
    );
  }
}

export async function getSimplifiAccountMappings() {
  const { rows } = await pool.query('SELECT simplifi_account, finapp_account_id FROM simplifi_account_mappings');
  const map = {};
  for (const r of rows) map[r.simplifi_account] = r.finapp_account_id;
  return map;
}

export async function saveSimplifiAccountMappings(mappings) {
  for (const [simplifi_account, finapp_account_id] of Object.entries(mappings)) {
    await pool.query(
      `INSERT INTO simplifi_account_mappings (simplifi_account, finapp_account_id)
       VALUES ($1, $2)
       ON CONFLICT (simplifi_account) DO UPDATE SET finapp_account_id = EXCLUDED.finapp_account_id`,
      [simplifi_account, finapp_account_id || null]
    );
  }
}

export async function upsertCsvTransaction(t) {
  // Skip if a Plaid-native row already covers this exact date+account+signed
  // amount; avoids needing manual dedup after import. The guard is deliberately
  // narrow: matching on ABS(amount) with no account clause used to drop an
  // import because some unrelated account happened to move the same sum that
  // day, and an inflow was treated as covered by an outflow of equal size.
  const { rowCount } = await pool.query(
    `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
     SELECT $1, $2, $3, $4, $5, $6, 'reviewed', 'USD'
     WHERE NOT EXISTS (
       SELECT 1 FROM transactions
       WHERE date = $2::date
         AND ROUND(amount::numeric, 2) = ROUND($4::numeric, 2)
         AND account = $5
         AND id NOT LIKE 'csv_%'
         AND id NOT LIKE 'simplifi_%'
     )
     ON CONFLICT (id) DO UPDATE SET merchant = $3, amount = $4, plaid_category = $6`,
    [t.id, t.date, t.merchant, t.amount, t.account, t.category]
  );
  // A skip is a row the user handed us that never landed. Record it so the
  // suppression is visible in /api/suppressed instead of vanishing silently.
  if (rowCount === 0) {
    // Never let a failed suppression insert abort the import it is logging.
    try {
      await recordSuppression({
        source: 'upsertCsvTransaction',
        txnId: t.id,
        date: t.date,
        merchant: t.merchant,
        amount: t.amount,
        account: t.account,
        reason: 'a Plaid-native row already covers this date/account/amount',
      });
    } catch (e) {
      console.error("Failed to record suppression:", e.message);
    }
  }
  return rowCount > 0;
}

// ── Suppressions ──────────────────────────────────────────────────────────────
// Every code path that declines to store a transaction writes here first. Silent
// discards are what let three real July credits disappear without a trace.
export async function recordSuppression({ source, txnId, date, merchant, amount, account, reason }) {
  await pool.query(
    `INSERT INTO suppressed_transactions (source, txn_id, date, merchant, amount, account, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [source, txnId ?? null, date ?? null, merchant ?? null, amount ?? null, account ?? null, reason]
  );
}

export async function getSuppressions(limit = 200) {
  const { rows } = await pool.query(
    `SELECT id, source, txn_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, merchant, amount::float, account, reason, created_at
     FROM suppressed_transactions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// Replaces the entire balance snapshot for a given date (delete + insert in one transaction).
// Using the same snapshotDate twice is idempotent.
export async function upsertAccountBalances(snapshotDate, balances) {
  if (!balances.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM account_balances WHERE snapshot_date = $1', [snapshotDate]);
    for (const b of balances) {
      await client.query(
        `INSERT INTO account_balances (snapshot_date, account, institution, type, balance, available)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [snapshotDate, b.account, b.institution, b.type, b.balance, b.available ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getLatestBalances() {
  const { rows } = await pool.query(`
    SELECT account, institution, type, balance, available, snapshot_date
    FROM account_balances
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM account_balances)
    ORDER BY type, account
  `);
  return rows;
}

// Total snapshot rows per imported account, keyed by (account, institution, type)
export async function getBalanceRowCounts() {
  const { rows } = await pool.query(`
    SELECT account, institution, type, COUNT(*)::int AS count
    FROM account_balances
    GROUP BY account, institution, type
  `);
  return rows;
}

// Builds the synthetic account_id for each balance row, in row order:
// balance_<institution>_<account>_<type>, suffixed _N for duplicate keys.
// GET /api/accounts and deleteImportedAccountBalances both use this over the
// getLatestBalances() rows so their ids stay identical-by-construction.
export function buildImportedAccountIds(balRows) {
  const balKeySeen = {};
  return balRows.map((r) => {
    const baseKey = `balance_${r.institution || ""}_${r.account}_${r.type || ""}`;
    const count = (balKeySeen[baseKey] = (balKeySeen[baseKey] || 0) + 1);
    return count === 1 ? baseKey : `${baseKey}_${count}`;
  });
}

// Delete all balance snapshot rows for one imported account. The accountId is the
// synthetic key built by GET /api/accounts (see buildImportedAccountIds). Resolution
// replays the exact id-construction loop over the same rows, in the same order, as
// the GET handler and requires a strict id match — no prefix or pattern matching.
// Returns the number of deleted rows (0 if no id matched).
export async function deleteImportedAccountBalances(accountId) {
  const rows = await getLatestBalances();
  const idx = buildImportedAccountIds(rows).indexOf(accountId);
  if (idx === -1) return 0;
  const match = rows[idx];
  const { rowCount } = await pool.query(
    `DELETE FROM account_balances
     WHERE account = $1 AND institution IS NOT DISTINCT FROM $2 AND type IS NOT DISTINCT FROM $3`,
    [match.account, match.institution, match.type]
  );
  return rowCount;
}

export async function upsertInvestmentHoldings(snapshotDate, holdings) {
  if (!holdings.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM investment_holdings WHERE snapshot_date = $1', [snapshotDate]);
    for (const h of holdings) {
      await client.query(
        `INSERT INTO investment_holdings (snapshot_date, ticker, institution, account, value, day_change, gain_loss, gain_loss_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [snapshotDate, h.ticker, h.institution, h.account ?? null, h.value, h.day_change ?? null, h.gain_loss ?? null, h.gain_loss_pct ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getLatestHoldings() {
  const { rows } = await pool.query(`
    SELECT ticker, institution, account, value, day_change, gain_loss, gain_loss_pct, snapshot_date
    FROM investment_holdings
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM investment_holdings)
    ORDER BY value DESC
  `);
  return rows;
}

export async function upsertImportedTransaction(t) {
  await pool.query(
    `DELETE FROM transactions WHERE id = $1`,
    [t.transaction_id]
  );
  await pool.query(
    `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
     VALUES ($1, $2, $3, $4, $5, $6, 'reviewed', 'USD')`,
    [t.transaction_id, t.date, t.merchant_name || t.name, t.amount, t.account_id || 'imported', t.category || null]
  );
}

// startDate/endDate bound how far back the scan reaches; the default window is
// the last 24 months, which is well past anything worth reconciling. The bound
// is needed because the same-date pass now selects every row in the window and
// groups it in JS (grouping rules live in transactionMatching.js so they can be
// unit-tested) rather than grouping in SQL with HAVING COUNT(*) > 1 and
// returning only the groups. Node holds the whole window, so the window is capped.
export async function findDuplicateTransactions({ startDate, endDate } = {}) {
  const windowParams = [startDate ?? null, endDate ?? null];
  const windowClause = (col) =>
    `${col} >= COALESCE($1::date, CURRENT_DATE - INTERVAL '24 months')
       AND ($2::date IS NULL OR ${col} <= $2::date)`;

  // Same-date duplicates: the grouping rules live in transactionMatching.js as
  // pure functions so they can be unit-tested. SQL only supplies the rows.
  const { rows } = await pool.query(
    `SELECT id, date, merchant, amount, account, created_at FROM transactions
     WHERE ${windowClause('date')}
     ORDER BY date DESC, created_at ASC`,
    windowParams
  );
  const sameDateGroups = groupDuplicates(rows);

  // Cross-date duplicates: simplifi/csv vs Plaid-native, same merchant+amount+account, dates 1 day apart.
  // Targets the specific case where Simplifi recorded the pending date and Plaid recorded the posted date.
  // t1 (the removal candidate) is constrained to imported ids and t2 to Plaid-native ones, so this pass
  // can never propose deleting a Plaid row; the account equality keeps it from merging across accounts.
  // Amounts are compared WITH their sign: on ABS() an imported $500 credit and a
  // Plaid $500 charge a day apart on the same account and merchant matched, and
  // a charge with its next-day refund is exactly that shape.
  const { rows: crossDateRows } = await pool.query(`
    SELECT
      t2.id AS keep_id,
      t1.id AS remove_id,
      TO_CHAR(t2.date, 'YYYY-MM-DD') AS date,
      ROUND(t2.amount::numeric, 2) AS keep_amount,
      ROUND(t1.amount::numeric, 2) AS remove_amount,
      t2.account AS account,
      t2.merchant AS keep_merchant,
      t1.merchant AS remove_merchant
    FROM transactions t1
    JOIN transactions t2
      ON (t1.id LIKE 'simplifi_%' OR t1.id LIKE 'csv_%')
      AND t2.id NOT LIKE 'simplifi_%'
      AND t2.id NOT LIKE 'csv_%'
      AND ROUND(t1.amount::numeric, 2) = ROUND(t2.amount::numeric, 2)
      AND LOWER(TRIM(t1.merchant)) = LOWER(TRIM(t2.merchant))
      AND t1.account = t2.account
      AND ABS(t1.date - t2.date) = 1
    WHERE ${windowClause('t1.date')}
    ORDER BY t2.date DESC
  `, windowParams);

  const sameDateIds = new Set(sameDateGroups.flatMap(g => [g.keep, ...g.remove]));
  const sameDateResults = sameDateGroups.map(g => ({
    date: g.date,
    amount: g.amount,
    count: 1 + g.remove.length,
    keep: g.keep,
    remove: g.remove,
    merchants: g.merchants,
    account: g.account,
  }));

  // Exclude any IDs already covered by the same-date pass to avoid double-counting.
  // sameSignedAmount re-checks the SQL predicate in JS, where it is unit-testable.
  const crossDateResults = crossDateRows
    .filter(r => !sameDateIds.has(r.keep_id) && !sameDateIds.has(r.remove_id))
    .filter(r => sameSignedAmount(r.remove_amount, r.keep_amount))
    .map(r => ({
      date: r.date,
      amount: parseFloat(r.keep_amount),
      count: 2,
      keep: r.keep_id,
      remove: [r.remove_id],
      merchants: [r.keep_merchant, r.remove_merchant],
      account: r.account ?? null,
    }));

  return [...sameDateResults, ...crossDateResults];
}

// selectedGroups: optional array of { keep, remove[] } — if omitted, removes all found duplicates
// Returns { deleted, rejected }: rejected holds ids the safety rule refused —
// Plaid-native rows, plus every row in a group whose `keep` did not validate.
export async function deduplicateTransactions(selectedGroups) {
  const dupes = selectedGroups ?? await findDuplicateTransactions();
  if (dupes.length === 0) return { deleted: 0, rejected: [] };

  // "Never delete a Plaid-native row" has to be enforced here, at the DELETE,
  // not only in the preview: selectedGroups comes straight off the request body,
  // so a caller could otherwise name any id it liked.
  const toRemove = [];
  const rejected = [];
  const invalidKeeper = [];
  const validGroups = [];
  for (const dupe of dupes) {
    const removeIds = dupe.remove ?? [];
    // `keep` arrives on the same untrusted request body as `remove` and is the
    // INSERT target for the assignment/merchant_override migration below: a null
    // keeper hits a NOT NULL violation, an arbitrary one overwrites some
    // unrelated transaction's category (a Plaid-native row included) or writes
    // orphan rows, and a keeper listed in its own remove list migrates onto a row
    // we are about to delete. Skip the whole group in every case.
    if (typeof dupe.keep !== 'string' || dupe.keep.trim() === '' || removeIds.includes(dupe.keep)) {
      invalidKeeper.push(...removeIds);
      continue;
    }
    validGroups.push(dupe);
    for (const removeId of removeIds) {
      if (isImportedId(removeId)) toRemove.push(removeId);
      else rejected.push(removeId);
    }
  }
  // A suppression that fails to log must not abort the dedup run it is logging.
  for (const id of rejected) {
    try {
      await recordSuppression({
        source: 'deduplicateTransactions',
        txnId: id,
        reason: 'refused to delete plaid-native row',
      });
    } catch (e) {
      console.error("Failed to record suppression:", e.message);
    }
  }
  for (const id of invalidKeeper) {
    try {
      await recordSuppression({
        source: 'deduplicateTransactions',
        txnId: id,
        reason: 'invalid dedup keeper',
      });
    } catch (e) {
      console.error("Failed to record suppression:", e.message);
    }
  }
  rejected.push(...invalidKeeper);
  if (toRemove.length === 0) return { deleted: 0, rejected };
  const accepted = new Set(toRemove);

  // Migrate assignments from duplicate rows to the keeper before deleting
  for (const dupe of validGroups) {
    for (const removeId of (dupe.remove ?? []).filter(id => accepted.has(id))) {
      await pool.query(`
        INSERT INTO assignments (transaction_id, category_id, updated_at)
        SELECT $2, category_id, NOW() FROM assignments WHERE transaction_id = $1
        ON CONFLICT (transaction_id) DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = NOW()
      `, [removeId, dupe.keep]);
      await pool.query(`
        INSERT INTO merchant_overrides (transaction_id, merchant_name)
        SELECT $2, merchant_name FROM merchant_overrides WHERE transaction_id = $1
        ON CONFLICT (transaction_id) DO NOTHING
      `, [removeId, dupe.keep]);
    }
  }

  const { rowCount } = await pool.query(
    `DELETE FROM transactions WHERE id = ANY($1)`,
    [toRemove]
  );
  return { deleted: rowCount, rejected };
}

export async function getImportedTransactionAccounts() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(account, '(unknown)') AS account,
      COUNT(*) AS count,
      MIN(date) AS earliest,
      MAX(date) AS latest
    FROM transactions
    WHERE id LIKE 'simplifi_%' OR id LIKE 'csv_%'
    GROUP BY account
    ORDER BY count DESC
  `);
  return rows;
}

export async function deleteImportedTransactions(accounts = null) {
  if (accounts && accounts.length > 0) {
    const { rowCount } = await pool.query(
      `DELETE FROM transactions
       WHERE (id LIKE 'simplifi_%' OR id LIKE 'csv_%')
         AND COALESCE(account, '(unknown)') = ANY($1)`,
      [accounts]
    );
    return rowCount;
  }
  const { rowCount } = await pool.query(
    "DELETE FROM transactions WHERE id LIKE 'simplifi_%' OR id LIKE 'csv_%'"
  );
  return rowCount;
}

// ── Categories ────────────────────────────────────────────────────────────────
export async function seedCategories(categories) {
  const { rows: existing } = await pool.query(
    "SELECT LOWER(name) AS name FROM categories"
  );
  const existingNames = new Set(existing.map((r) => r.name));
  let created = 0;
  for (const { name, color } of categories) {
    if (!existingNames.has(name.toLowerCase())) {
      await pool.query(
        "INSERT INTO categories (name, color) VALUES ($1, $2)",
        [name, color]
      );
      created++;
    }
  }
  return created;
}

export async function getCategories() {
  const { rows } = await pool.query(
    "SELECT id, name, color, created_at FROM categories ORDER BY name"
  );
  return rows;
}

export async function createCategory(name, color = "#6366f1") {
  const { rows } = await pool.query(
    "INSERT INTO categories (name, color) VALUES ($1, $2) RETURNING *",
    [name, color]
  );
  return rows[0];
}

export async function updateCategory(id, name, color) {
  const { rows } = await pool.query(
    "UPDATE categories SET name = $2, color = $3 WHERE id = $1 RETURNING *",
    [id, name, color]
  );
  return rows[0] || null;
}

export async function deleteCategory(id, replacementId) {
  if (replacementId) {
    await pool.query(
      `UPDATE assignments SET category_id = $1, updated_at = NOW() WHERE category_id = $2`,
      [replacementId, id]
    );
  }
  const { rowCount } = await pool.query("DELETE FROM categories WHERE id = $1", [id]);
  return rowCount > 0;
}

// ── Assignments ───────────────────────────────────────────────────────────────
export async function getAssignments() {
  const { rows } = await pool.query(
    "SELECT transaction_id, category_id FROM assignments"
  );
  return rows;
}

export async function upsertAssignment(transactionId, categoryId) {
  await pool.query(
    `INSERT INTO assignments (transaction_id, category_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (transaction_id) DO UPDATE SET category_id = $2, updated_at = NOW()`,
    [transactionId, categoryId || null]
  );
}

// ── Splits ────────────────────────────────────────────────────────────────────
export async function getSplits() {
  const { rows } = await pool.query(
    `SELECT s.id, s.transaction_id, s.category_id, s.amount, s.note,
            c.name AS category_name, c.color AS category_color
     FROM splits s
     LEFT JOIN categories c ON s.category_id = c.id
     ORDER BY s.transaction_id, s.created_at`
  );
  return rows;
}

export async function createSplit(transactionId, categoryId, amount, note) {
  const { rows } = await pool.query(
    "INSERT INTO splits (transaction_id, category_id, amount, note) VALUES ($1, $2, $3, $4) RETURNING *",
    [transactionId, categoryId || null, amount, note || null]
  );
  return rows[0];
}

export async function deleteSplit(splitId) {
  const { rowCount } = await pool.query("DELETE FROM splits WHERE id = $1", [splitId]);
  return rowCount > 0;
}

export async function deleteSplitsForTransaction(transactionId) {
  const { rowCount } = await pool.query(
    "DELETE FROM splits WHERE transaction_id = $1", [transactionId]
  );
  return rowCount;
}

export async function deleteTransaction(id) {
  const { rowCount } = await pool.query(
    "UPDATE transactions SET hidden = TRUE WHERE id = $1", [id]
  );
  return rowCount;
}

export async function unhideTransaction(id) {
  const { rowCount } = await pool.query(
    "UPDATE transactions SET hidden = FALSE WHERE id = $1", [id]
  );
  return rowCount;
}

// ── Hidden accounts ────────────────────────────────────────────────────────────
export async function getHiddenAccounts() {
  const { rows } = await pool.query("SELECT account_id FROM hidden_accounts ORDER BY hidden_at DESC");
  return rows.map(r => r.account_id);
}

export async function addHiddenAccount(accountId) {
  await pool.query(
    "INSERT INTO hidden_accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [accountId]
  );
}

export async function removeHiddenAccount(accountId) {
  await pool.query("DELETE FROM hidden_accounts WHERE account_id = $1", [accountId]);
}

// ── Replace splits atomically ──────────────────────────────────────────────────
export async function replaceSplits(transactionId, splits) {
  await pool.query("DELETE FROM splits WHERE transaction_id = $1", [transactionId]);
  if (!splits.length) return [];
  for (const { category_id, amount, note } of splits) {
    await pool.query(
      "INSERT INTO splits (transaction_id, category_id, amount, note) VALUES ($1, $2, $3, $4)",
      [transactionId, category_id || null, amount, note || null]
    );
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.transaction_id, s.category_id, s.amount::float, s.note,
            c.name AS category_name, c.color AS category_color
     FROM splits s LEFT JOIN categories c ON s.category_id = c.id
     WHERE s.transaction_id = $1 ORDER BY s.created_at`,
    [transactionId]
  );
  return rows;
}

// ── Merchant Overrides ────────────────────────────────────────────────────────
export async function getMerchantOverrides() {
  const { rows } = await pool.query(
    "SELECT transaction_id, merchant_name FROM merchant_overrides"
  );
  return rows;
}

export async function upsertMerchantOverride(transactionId, merchantName) {
  await pool.query(
    `INSERT INTO merchant_overrides (transaction_id, merchant_name, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (transaction_id) DO UPDATE SET merchant_name = $2, updated_at = NOW()`,
    [transactionId, merchantName]
  );
}

// ── Properties ────────────────────────────────────────────────────────────────
export async function getProperties() {
  const { rows } = await pool.query(
    `SELECT id, address, nickname, last_value::float, last_synced_at, created_at,
            baseline_value::float, baseline_date, baseline_fhfa_index::float, fhfa_msa
     FROM properties ORDER BY created_at`
  );
  return rows;
}

export async function upsertProperty(id, address, nickname) {
  if (id) {
    const { rows } = await pool.query(
      `UPDATE properties SET address = $1, nickname = $2 WHERE id = $3 RETURNING *`,
      [address, nickname || null, id]
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO properties (address, nickname) VALUES ($1, $2) RETURNING *`,
    [address, nickname || null]
  );
  return rows[0];
}

export async function deleteProperty(id) {
  const { rowCount } = await pool.query(`DELETE FROM properties WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function updatePropertyValue(id, value) {
  await pool.query(
    `UPDATE properties SET last_value = $1, last_synced_at = NOW() WHERE id = $2`,
    [value, id]
  );
}

export async function setPropertyBaseline(id, value, msaCode, fhfaIndex) {
  await pool.query(
    `UPDATE properties
     SET baseline_value = $1, baseline_date = NOW(), baseline_fhfa_index = $2, fhfa_msa = $3,
         last_value = $1, last_synced_at = NOW()
     WHERE id = $4`,
    [value, fhfaIndex, msaCode, id]
  );
}

// ── Manual accounts ───────────────────────────────────────────────────────────
export async function getManualAccounts() {
  const { rows } = await pool.query(
    `SELECT id, name, institution, subtype, balance::float, updated_at FROM manual_accounts ORDER BY id`
  );
  return rows;
}

export async function upsertManualAccount(id, name, institution, subtype, balance) {
  if (id) {
    const { rows } = await pool.query(
      `UPDATE manual_accounts SET name=$1, institution=$2, subtype=$3, balance=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, institution || null, subtype || 'retirement', parseFloat(balance), id]
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO manual_accounts (name, institution, subtype, balance)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, institution || null, subtype || 'retirement', parseFloat(balance)]
  );
  return rows[0];
}

export async function deleteManualAccount(id) {
  const { rowCount } = await pool.query(`DELETE FROM manual_accounts WHERE id=$1`, [id]);
  return rowCount > 0;
}

// ── Cashflow presets ──────────────────────────────────────────────────────────
export async function getCashflowPresets() {
  const { rows } = await pool.query(
    `SELECT name, amount::float, freq, note FROM cashflow_presets ORDER BY name`
  );
  return rows;
}

export async function upsertCashflowPreset(name, amount, freq, note) {
  await pool.query(
    `INSERT INTO cashflow_presets (name, amount, freq, note, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (name) DO UPDATE SET amount = $2, freq = $3, note = $4, updated_at = NOW()`,
    [name, amount, freq || null, note || null]
  );
}

export async function deleteCashflowPreset(name) {
  await pool.query(`DELETE FROM cashflow_presets WHERE name = $1`, [name]);
}

export async function getCashflowStates(monthKey) {
  const { rows } = await pool.query(
    `SELECT account_id, txn_id, is_pending, actual_amount::float, plaid_txn_id, actual_day, note
     FROM cashflow_txn_states WHERE month_key = $1`,
    [monthKey]
  );
  return rows;
}

export async function upsertCashflowState(accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay, note) {
  await pool.query(
    `INSERT INTO cashflow_txn_states (account_id, txn_id, month_key, is_pending, actual_amount, plaid_txn_id, actual_day, note, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (account_id, txn_id, month_key) DO UPDATE
       SET is_pending = $4, actual_amount = $5, plaid_txn_id = $6, actual_day = $7, note = $8, updated_at = NOW()`,
    [accountId, txnId, monthKey, isPending, actualAmount ?? null, plaidTxnId ?? null, actualDay ?? null, note ?? null]
  );
}

export async function getCashflowMappings() {
  const { rows } = await pool.query(
    `SELECT merchant_pattern, account_id, txn_name FROM cashflow_mappings ORDER BY merchant_pattern`
  );
  return rows;
}

export async function upsertCashflowMapping(merchantPattern, accountId, txnName) {
  await pool.query(
    `INSERT INTO cashflow_mappings (merchant_pattern, account_id, txn_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (merchant_pattern) DO UPDATE SET account_id = $2, txn_name = $3`,
    [merchantPattern, accountId, txnName]
  );
}

// ── Account nicknames ─────────────────────────────────────────────────────────
export async function getAccountNicknames() {
  const { rows } = await pool.query(`SELECT account_id, nickname FROM account_nicknames`);
  return Object.fromEntries(rows.map((r) => [r.account_id, r.nickname]));
}

export async function upsertAccountNickname(accountId, nickname) {
  await pool.query(
    `INSERT INTO account_nicknames (account_id, nickname)
     VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET nickname = $2`,
    [accountId, nickname]
  );
}

export async function deleteAccountNickname(accountId) {
  await pool.query(`DELETE FROM account_nicknames WHERE account_id = $1`, [accountId]);
}

// ── Audit ──────────────────────────────────────────────────────────────────────
export async function getLastAuditLog() {
  const { rows } = await pool.query(
    `SELECT id, audit_date, filename, total_in_sheet, missing_count, inserted_count,
            range_start, range_end, completed_at
     FROM audit_log ORDER BY audit_date DESC LIMIT 1`
  );
  return rows[0] || null;
}

export async function saveAuditLog(filename, totalInSheet, missingCount, rangeStart, rangeEnd) {
  const { rows } = await pool.query(
    `INSERT INTO audit_log (filename, total_in_sheet, missing_count, range_start, range_end)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, audit_date`,
    [filename, totalInSheet, missingCount, rangeStart, rangeEnd]
  );
  return rows[0];
}

export async function completeAuditLog(id, rangeEnd) {
  await pool.query(
    `UPDATE audit_log SET completed_at = NOW() WHERE id = $1`,
    [id]
  );
  await pool.query(
    `UPDATE transactions SET audited_at = NOW()
     WHERE date <= $1::date AND audited_at IS NULL`,
    [rangeEnd]
  );
}

export async function updateAuditInsertedCount(id, insertedCount) {
  await pool.query(`UPDATE audit_log SET inserted_count = $2 WHERE id = $1`, [id, insertedCount]);
}

// Keys for the audit's "missing transactions" comparison: date + account +
// SIGNED amount. The old key was ABS(amount) with no account, so a missing
// $6,054.25 card credit read as "present" because the funding leg of the same
// magnitude posted that day on another account — the audit would have hidden
// the very incident it exists to find.
//
// Each row also gets an account-blind key, because the audit sheet's account_id
// column is not always populated. Callers use the account-qualified key whenever
// the sheet row has an account and fall back to date + signed amount otherwise;
// the sign is the part that is never dropped.
export async function getTransactionDateAmountSet(startDate, endDate) {
  const { rows } = await pool.query(
    `SELECT date::text, COALESCE(account, '') AS account,
            amount::numeric(12,2)::text AS amount
     FROM transactions WHERE date >= $1::date AND date <= $2::date`,
    [startDate, endDate]
  );
  const keys = new Set();
  for (const r of rows) {
    keys.add(`${r.date}|${r.account}|${r.amount}`);
    keys.add(`${r.date}|${r.amount}`);
  }
  return keys;
}

export function parseAuditXlsx(base64) {
  const { read, utils } = xlsxLib;
  const wb = read(Buffer.from(base64, 'base64'), { type: 'buffer', cellDates: true });

  const SKIP = new Set(['MACU Shared Transactions', 'American Express Transactions']);
  const txnSheets = wb.SheetNames.filter(n => n.endsWith('Transactions') && !SKIP.has(n));

  const transactions = [];
  const sheetStats = [];
  let minDate = null, maxDate = null;

  for (const sheetName of txnSheets) {
    const ws = wb.Sheets[sheetName];
    // Use raw:true so booleans stay boolean and we control date formatting
    const rows = utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const stat = { sheet: sheetName, totalRows: rows.length, headerRow: null, parsed: 0, skippedPending: 0, skippedNoId: 0, skippedNoDate: 0, sampleIds: [] };

    // Find header row — look for the row containing 'transaction_id' (not always row 1)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      if (Array.isArray(rows[i]) && rows[i].includes('transaction_id')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) { stat.headerRow = 'not found'; sheetStats.push(stat); continue; }
    stat.headerRow = headerIdx;

    const headers = rows[headerIdx];
    const col = (name) => headers.indexOf(name);
    const txnIdIdx  = col('transaction_id');
    const dateIdx   = col('date');
    const amountIdx = col('amount');
    const nameIdx   = col('name');
    const merchantIdx = col('merchant_name');
    const accountIdx  = col('account_id');
    const pendingIdx  = col('pending');

    const source = sheetName.replace(' Transactions', '');

    for (const row of rows.slice(headerIdx + 1)) {
      const txnId = row[txnIdIdx];
      if (!txnId) { stat.skippedNoId++; continue; }

      const pendingVal = row[pendingIdx];
      if (pendingVal === true || pendingVal === 'TRUE' || pendingVal === 'true') {
        stat.skippedPending++; continue;
      }

      const rawDate = row[dateIdx];
      if (!rawDate) { stat.skippedNoDate++; continue; }

      // Normalize date to YYYY-MM-DD regardless of how xlsx stored it
      let date;
      if (rawDate instanceof Date) {
        date = rawDate.toISOString().slice(0, 10);
      } else {
        const s = rawDate.toString().trim();
        // Already ISO: 2026-01-25 or 2026-01-25T...
        const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
        if (iso) { date = iso[1]; }
        else { stat.skippedNoDate++; continue; }
      }

      const amount = parseFloat(row[amountIdx]);
      if (isNaN(amount)) continue;

      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      const id = typeof txnId === 'string' ? txnId.trim() : String(txnId);
      transactions.push({
        transaction_id: id,
        date,
        amount,
        name:          row[nameIdx]     || null,
        merchant_name: row[merchantIdx] || null,
        account_id:    row[accountIdx]  || null,
        source,
      });
      stat.parsed++;
      if (stat.sampleIds.length < 3) stat.sampleIds.push(id);
    }

    sheetStats.push(stat);
  }

  return { transactions, dateRange: { start: minDate, end: maxDate }, sheetStats };
}

// ── Vehicles ──────────────────────────────────────────────────────────────────
export async function getVehicles() {
  const { rows } = await pool.query(
    `SELECT id, year, make, model, trim, nickname,
            baseline_value::float, baseline_date, last_value::float,
            last_synced_at, depreciation_rate::float, created_at
     FROM vehicles ORDER BY created_at`
  );
  return rows;
}

export async function upsertVehicle(id, year, make, model, trim, nickname) {
  if (id) {
    const { rows } = await pool.query(
      `UPDATE vehicles SET year=$1, make=$2, model=$3, trim=$4, nickname=$5
       WHERE id=$6 RETURNING *`,
      [year || null, make, model, trim || null, nickname || null, id]
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO vehicles (year, make, model, trim, nickname)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [year || null, make, model, trim || null, nickname || null]
  );
  return rows[0];
}

export async function deleteVehicle(id) {
  const { rowCount } = await pool.query(`DELETE FROM vehicles WHERE id=$1`, [id]);
  return rowCount > 0;
}

export async function setVehicleBaseline(id, value, rate) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `UPDATE vehicles
     SET baseline_value=$1, baseline_date=$2, depreciation_rate=$3,
         last_value=$1, last_synced_at=NOW()
     WHERE id=$4`,
    [value, today, rate, id]
  );
}

export async function updateVehicleValue(id, value) {
  await pool.query(
    `UPDATE vehicles SET last_value=$1, last_synced_at=NOW() WHERE id=$2`,
    [value, id]
  );
}

export async function applyVehicleDepreciation() {
  const vehicles = await getVehicles();
  const toUpdate = vehicles.filter(
    (v) => v.baseline_value != null && v.baseline_date != null
  );
  let updated = 0;
  const results = [];
  const msPerYear = 365.25 * 24 * 3600 * 1000;
  for (const v of toUpdate) {
    const yearsElapsed = (Date.now() - new Date(v.baseline_date).getTime()) / msPerYear;
    const rate = v.depreciation_rate ?? 0.15;
    const newValue = Math.max(0, Math.round(v.baseline_value * Math.pow(1 - rate, yearsElapsed)));
    await updateVehicleValue(v.id, newValue);
    updated++;
    results.push({ id: v.id, name: `${v.year || ''} ${v.make} ${v.model}`.trim(), value: newValue });
  }
  return { updated, results };
}

export default pool;
