import pg from "pg";
import { randomBytes } from "crypto";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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

export default pool;
