import pg from "pg";
import { randomBytes } from "crypto";

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

  // Migrate old clerk_user_id tables if they exist
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='categories' AND column_name='clerk_user_id') THEN
        ALTER TABLE categories DROP COLUMN IF EXISTS clerk_user_id;
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='assignments' AND column_name='clerk_user_id') THEN
        ALTER TABLE assignments DROP COLUMN IF EXISTS clerk_user_id;
        -- rebuild primary key without clerk_user_id if needed
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='splits' AND column_name='clerk_user_id') THEN
        ALTER TABLE splits DROP COLUMN IF EXISTS clerk_user_id;
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='merchant_overrides' AND column_name='clerk_user_id') THEN
        ALTER TABLE merchant_overrides DROP COLUMN IF EXISTS clerk_user_id;
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
    const status = t.pending ? 'pending' : 'posted';
    await pool.query(
      `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD')
       ON CONFLICT (id) DO UPDATE SET amount = $4, status = $7`,
      [txnId, t.date, merchant, t.amount, t.account_id || t.account || 'unknown', category, status]
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
       merchant AS name,
       merchant AS merchant_name,
       amount,
       account AS account_id,
       plaid_category AS category,
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

// ── CSV Import ────────────────────────────────────────────────────────────────
export async function upsertImportedTransaction(t) {
  await pool.query(
    `DELETE FROM transactions WHERE id = $1`,
    [t.transaction_id]
  );
  await pool.query(
    `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
     VALUES ($1, $2, $3, $4, $5, $6, 'posted', 'USD')`,
    [t.transaction_id, t.date, t.merchant_name || t.name, t.amount, t.account_id || 'imported', t.category || null]
  );
}

export async function deleteImportedTransactions() {
  const { rowCount } = await pool.query(
    "DELETE FROM transactions WHERE id LIKE 'simplifi_%'"
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
