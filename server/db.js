import pg from "pg";
import { randomBytes } from "crypto";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]$/, '');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export async function initDb() {
  // Migrate old integer-based schema if present
  const { rows } = await pool.query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'user_items' AND column_name = 'user_id'
  `);
  if (rows.length > 0 && rows[0].data_type === "integer") {
    await pool.query(`
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS transaction_cursors CASCADE;
      DROP TABLE IF EXISTS link_sessions CASCADE;
      DROP TABLE IF EXISTS user_items CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS api_keys CASCADE;
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      key TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'Default',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_items (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      item_id TEXT UNIQUE NOT NULL,
      institution_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS link_sessions (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transaction_cursors (
      item_id TEXT PRIMARY KEY,
      cursor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      transaction_id TEXT UNIQUE NOT NULL,
      account_id TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      date DATE NOT NULL,
      name TEXT,
      merchant_name TEXT,
      category TEXT,
      pending BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
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
      clerk_user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS assignments (
      transaction_id TEXT NOT NULL,
      clerk_user_id TEXT NOT NULL,
      category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (transaction_id, clerk_user_id)
    );

    CREATE TABLE IF NOT EXISTS splits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id TEXT NOT NULL,
      clerk_user_id TEXT NOT NULL,
      category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
      amount NUMERIC(12,2) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS merchant_overrides (
      transaction_id TEXT NOT NULL,
      clerk_user_id TEXT NOT NULL,
      merchant_name TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (transaction_id, clerk_user_id)
    );
  `);
}

// ── API Keys ──────────────────────────────────────────────────────────────────
export async function getApiKeyForUser(clerkUserId) {
  const { rows } = await pool.query(
    "SELECT key FROM api_keys WHERE clerk_user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [clerkUserId]
  );
  return rows[0]?.key || null;
}

export async function createApiKey(clerkUserId) {
  const key = randomBytes(32).toString("hex");
  await pool.query(
    `DELETE FROM api_keys WHERE clerk_user_id = $1`,
    [clerkUserId]
  );
  await pool.query(
    `INSERT INTO api_keys (clerk_user_id, key) VALUES ($1, $2)`,
    [clerkUserId, key]
  );
  return key;
}

export async function getClerkUserIdByApiKey(key) {
  const { rows } = await pool.query(
    "SELECT clerk_user_id FROM api_keys WHERE key = $1",
    [key]
  );
  return rows[0]?.clerk_user_id || null;
}

// ── Link sessions ─────────────────────────────────────────────────────────────
export async function createLinkSession(clerkUserId) {
  const id = randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO link_sessions (id, clerk_user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
    [id, clerkUserId]
  );
  return id;
}

export async function getLinkSession(id) {
  const { rows } = await pool.query(
    "SELECT clerk_user_id FROM link_sessions WHERE id = $1 AND expires_at > NOW()",
    [id]
  );
  return rows[0] || null;
}

export async function deleteLinkSession(id) {
  await pool.query("DELETE FROM link_sessions WHERE id = $1", [id]);
}

// ── User items (banks) ────────────────────────────────────────────────────────
export async function getUserItems(clerkUserId) {
  const { rows } = await pool.query(
    `SELECT access_token AS "accessToken", item_id AS "itemId", institution_name AS "institutionName"
     FROM user_items WHERE clerk_user_id = $1`,
    [clerkUserId]
  );
  return rows;
}

export async function upsertUserItem(clerkUserId, accessToken, itemId, institutionName) {
  await pool.query(
    `INSERT INTO user_items (clerk_user_id, access_token, item_id, institution_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE SET institution_name = $4`,
    [clerkUserId, accessToken, itemId, institutionName || null]
  );
}

export async function removeUserItem(clerkUserId, itemId) {
  const { rowCount } = await pool.query(
    "DELETE FROM user_items WHERE clerk_user_id = $1 AND item_id = $2",
    [clerkUserId, itemId]
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

// ── Transactions ──────────────────────────────────────────────────────────────
export async function upsertTransactions(clerkUserId, transactions) {
  for (const t of transactions) {
    await pool.query(
      `INSERT INTO transactions
         (clerk_user_id, transaction_id, account_id, amount, date, name, merchant_name, category, pending)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (transaction_id) DO UPDATE SET amount = $4, pending = $9`,
      [
        clerkUserId,
        t.transaction_id,
        t.account_id,
        t.amount,
        t.date,
        t.name,
        t.merchant_name || null,
        t.personal_finance_category?.primary || t.category?.[0] || null,
        t.pending,
      ]
    );
  }
}

export async function getTransactions(clerkUserId, { limit = 100, startDate, endDate, category } = {}) {
  const conditions = ["clerk_user_id = $1"];
  const params = [clerkUserId];
  let i = 2;
  if (startDate) { conditions.push(`date >= $${i++}`); params.push(startDate); }
  if (endDate)   { conditions.push(`date <= $${i++}`); params.push(endDate); }
  if (category)  { conditions.push(`LOWER(category) = LOWER($${i++})`); params.push(category); }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC LIMIT $${i}`,
    params
  );
  return rows;
}

export async function getSpendingByCategory(clerkUserId, { startDate, endDate } = {}) {
  const conditions = ["clerk_user_id = $1", "pending = false", "amount > 0"];
  const params = [clerkUserId];
  let i = 2;
  if (startDate) { conditions.push(`date >= $${i++}`); params.push(startDate); }
  if (endDate)   { conditions.push(`date <= $${i++}`); params.push(endDate); }
  const { rows } = await pool.query(
    `SELECT category, SUM(amount)::numeric AS total, COUNT(*)::int AS count
     FROM transactions WHERE ${conditions.join(" AND ")}
     GROUP BY category ORDER BY total DESC`,
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

export async function saveOAuthCode(code, clerkUserId, redirectUri, codeChallenge) {
  await pool.query(
    `INSERT INTO oauth_codes (code, clerk_user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')`,
    [code, clerkUserId, redirectUri, codeChallenge || null]
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
export async function upsertImportedTransaction(clerkUserId, t) {
  await pool.query(
    `INSERT INTO transactions
       (clerk_user_id, transaction_id, account_id, amount, date, name, merchant_name, category, pending)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
     ON CONFLICT (transaction_id) DO UPDATE SET amount = $4, category = $8`,
    [clerkUserId, t.transaction_id, t.account_id, t.amount, t.date, t.name, t.merchant_name, t.category || null]
  );
}

export async function deleteImportedTransactions(clerkUserId) {
  const { rowCount } = await pool.query(
    "DELETE FROM transactions WHERE clerk_user_id = $1 AND transaction_id LIKE 'simplifi_%'",
    [clerkUserId]
  );
  return rowCount;
}

// ── Categories ────────────────────────────────────────────────────────────────
export async function seedCategories(clerkUserId, categories) {
  const { rows: existing } = await pool.query(
    "SELECT LOWER(name) AS name FROM categories WHERE clerk_user_id = $1",
    [clerkUserId]
  );
  const existingNames = new Set(existing.map((r) => r.name));
  let created = 0;
  for (const { name, color } of categories) {
    if (!existingNames.has(name.toLowerCase())) {
      await pool.query(
        "INSERT INTO categories (clerk_user_id, name, color) VALUES ($1, $2, $3)",
        [clerkUserId, name, color]
      );
      created++;
    }
  }
  return created;
}

export async function getCategories(clerkUserId) {
  const { rows } = await pool.query(
    "SELECT id, name, color, created_at FROM categories WHERE clerk_user_id = $1 ORDER BY name",
    [clerkUserId]
  );
  return rows;
}

export async function createCategory(clerkUserId, name, color = "#6366f1") {
  const { rows } = await pool.query(
    `INSERT INTO categories (clerk_user_id, name, color) VALUES ($1, $2, $3) RETURNING *`,
    [clerkUserId, name, color]
  );
  return rows[0];
}

export async function updateCategory(clerkUserId, id, name, color) {
  const { rows } = await pool.query(
    `UPDATE categories SET name = $3, color = $4 WHERE id = $1 AND clerk_user_id = $2 RETURNING *`,
    [id, clerkUserId, name, color]
  );
  return rows[0] || null;
}

export async function deleteCategory(clerkUserId, id) {
  const { rowCount } = await pool.query(
    "DELETE FROM categories WHERE id = $1 AND clerk_user_id = $2",
    [id, clerkUserId]
  );
  return rowCount > 0;
}

// ── Assignments ───────────────────────────────────────────────────────────────
export async function getAssignments(clerkUserId) {
  const { rows } = await pool.query(
    "SELECT transaction_id, category_id FROM assignments WHERE clerk_user_id = $1",
    [clerkUserId]
  );
  return rows;
}

export async function upsertAssignment(clerkUserId, transactionId, categoryId) {
  await pool.query(
    `INSERT INTO assignments (transaction_id, clerk_user_id, category_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (transaction_id, clerk_user_id) DO UPDATE SET category_id = $3, updated_at = NOW()`,
    [transactionId, clerkUserId, categoryId || null]
  );
}

// ── Splits ────────────────────────────────────────────────────────────────────
export async function getSplits(clerkUserId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.transaction_id, s.category_id, s.amount, s.note,
            c.name AS category_name, c.color AS category_color
     FROM splits s
     LEFT JOIN categories c ON s.category_id = c.id
     WHERE s.clerk_user_id = $1
     ORDER BY s.transaction_id, s.created_at`,
    [clerkUserId]
  );
  return rows;
}

export async function createSplit(clerkUserId, transactionId, categoryId, amount, note) {
  const { rows } = await pool.query(
    `INSERT INTO splits (transaction_id, clerk_user_id, category_id, amount, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [transactionId, clerkUserId, categoryId || null, amount, note || null]
  );
  return rows[0];
}

export async function deleteSplit(clerkUserId, splitId) {
  const { rowCount } = await pool.query(
    "DELETE FROM splits WHERE id = $1 AND clerk_user_id = $2",
    [splitId, clerkUserId]
  );
  return rowCount > 0;
}

export async function deleteSplitsForTransaction(clerkUserId, transactionId) {
  const { rowCount } = await pool.query(
    "DELETE FROM splits WHERE transaction_id = $1 AND clerk_user_id = $2",
    [transactionId, clerkUserId]
  );
  return rowCount;
}

// ── Merchant Overrides ────────────────────────────────────────────────────────
export async function getMerchantOverrides(clerkUserId) {
  const { rows } = await pool.query(
    "SELECT transaction_id, merchant_name FROM merchant_overrides WHERE clerk_user_id = $1",
    [clerkUserId]
  );
  return rows;
}

export async function upsertMerchantOverride(clerkUserId, transactionId, merchantName) {
  await pool.query(
    `INSERT INTO merchant_overrides (transaction_id, clerk_user_id, merchant_name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (transaction_id, clerk_user_id) DO UPDATE SET merchant_name = $3, updated_at = NOW()`,
    [transactionId, clerkUserId, merchantName]
  );
}

export default pool;
