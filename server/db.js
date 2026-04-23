import pg from "pg";
import { randomBytes, createHash } from "crypto";

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

  // Trigger to silently block duplicate transaction inserts from any source.
  // csv_ rows are deduplicated by occurrence-index hash before insert, so skip the check for them.
  await pool.query(`
    CREATE OR REPLACE FUNCTION prevent_duplicate_transactions()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.id LIKE 'csv_%' THEN
        RETURN NEW;
      END IF;
      IF EXISTS (
        SELECT 1 FROM transactions
        WHERE date = NEW.date
          AND ROUND(ABS(amount)::numeric, 2) = ROUND(ABS(NEW.amount)::numeric, 2)
          AND account = NEW.account
          AND id != NEW.id
          AND id NOT LIKE 'csv_%'
      ) THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'check_duplicate_transactions'
      ) THEN
        CREATE TRIGGER check_duplicate_transactions
        BEFORE INSERT ON transactions
        FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_transactions();
      END IF;
    END $$;
  `);

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
       date,
       authorized_date,
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
       created_at
     FROM transactions ${where} ORDER BY date DESC LIMIT $${i}`,
    params
  );
  return rows;
}

export async function getSpendingByCategory({ startDate, endDate } = {}) {
  const conditions = ["status != 'pending'", "amount > 0"];
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
  { keywords: ["TRANSFER IN", "TRANSFER OUT"],                   category: "Transfer" },
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
// Parses the CSV text exported by Perplexity and returns rows with stable hash IDs.
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

export async function upsertCsvTransaction(t) {
  await pool.query(
    `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
     VALUES ($1, $2, $3, $4, $5, $6, 'reviewed', 'USD')
     ON CONFLICT (id) DO UPDATE SET merchant = $3, amount = $4, plaid_category = $6`,
    [t.id, t.date, t.merchant, t.amount, t.account, t.category]
  );
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

export async function findDuplicateTransactions() {
  // Same-date duplicates: group by (date, amount)
  const { rows: sameDateRows } = await pool.query(`
    SELECT
      date,
      ROUND(ABS(amount)::numeric, 2) AS abs_amount,
      COUNT(*) AS cnt,
      array_agg(id ORDER BY
        CASE WHEN id LIKE 'simplifi_%' THEN 1 ELSE 0 END ASC,
        created_at ASC
      ) AS ids,
      array_agg(merchant ORDER BY
        CASE WHEN id LIKE 'simplifi_%' THEN 1 ELSE 0 END ASC,
        created_at ASC
      ) AS merchants
    FROM transactions
    GROUP BY date, ROUND(ABS(amount)::numeric, 2)
    HAVING COUNT(*) > 1
    ORDER BY date DESC
  `);

  // Cross-date duplicates: simplifi vs non-simplifi, same merchant+amount, dates 1 day apart.
  // Targets the specific case where Simplifi recorded the pending date and Plaid recorded the posted date.
  const { rows: crossDateRows } = await pool.query(`
    SELECT
      t2.id AS keep_id,
      t1.id AS remove_id,
      t2.date AS date,
      ROUND(ABS(t1.amount)::numeric, 2) AS abs_amount,
      t2.merchant AS keep_merchant,
      t1.merchant AS remove_merchant
    FROM transactions t1
    JOIN transactions t2
      ON (t1.id LIKE 'simplifi_%' OR t1.id LIKE 'csv_%')
      AND t2.id NOT LIKE 'simplifi_%'
      AND t2.id NOT LIKE 'csv_%'
      AND ROUND(ABS(t1.amount)::numeric, 2) = ROUND(ABS(t2.amount)::numeric, 2)
      AND LOWER(TRIM(t1.merchant)) = LOWER(TRIM(t2.merchant))
      AND ABS(t1.date - t2.date) = 1
    ORDER BY t2.date DESC
  `);

  const sameDateIds = new Set(sameDateRows.flatMap(r => r.ids));
  const sameDateResults = sameDateRows.map(r => ({
    date: r.date,
    amount: parseFloat(r.abs_amount),
    count: parseInt(r.cnt),
    keep: r.ids[0],
    remove: r.ids.slice(1),
    merchants: r.merchants,
  }));

  // Exclude any IDs already covered by the same-date pass to avoid double-counting
  const crossDateResults = crossDateRows
    .filter(r => !sameDateIds.has(r.keep_id) && !sameDateIds.has(r.remove_id))
    .map(r => ({
      date: r.date,
      amount: parseFloat(r.abs_amount),
      count: 2,
      keep: r.keep_id,
      remove: [r.remove_id],
      merchants: [r.keep_merchant, r.remove_merchant],
    }));

  return [...sameDateResults, ...crossDateResults];
}

// selectedGroups: optional array of { keep, remove[] } — if omitted, removes all found duplicates
export async function deduplicateTransactions(selectedGroups) {
  const dupes = selectedGroups ?? await findDuplicateTransactions();
  if (dupes.length === 0) return 0;

  const toRemove = dupes.flatMap(d => d.remove);

  // Migrate assignments from duplicate rows to the keeper before deleting
  for (const dupe of dupes) {
    for (const removeId of dupe.remove) {
      await pool.query(`
        INSERT INTO assignments (transaction_id, category_id)
        SELECT $2, category_id FROM assignments WHERE transaction_id = $1
        ON CONFLICT (transaction_id) DO NOTHING
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
  return rowCount;
}

export async function deleteImportedTransactions() {
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

export async function deleteCategory(id) {
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

export default pool;
