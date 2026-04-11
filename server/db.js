import pg from "pg";
import { randomBytes } from "crypto";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      item_id TEXT UNIQUE NOT NULL,
      institution_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS link_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
      user_id INTEGER NOT NULL,
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

// ── Users ─────────────────────────────────────────────────────────────────────
export async function createUser(username) {
  const apiKey = randomBytes(32).toString("hex");
  const { rows } = await pool.query(
    `INSERT INTO users (username, api_key) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING id, username, api_key`,
    [username, apiKey]
  );
  return rows[0];
}

export async function getUserByApiKey(apiKey) {
  const { rows } = await pool.query(
    "SELECT id, username FROM users WHERE api_key = $1",
    [apiKey]
  );
  return rows[0] || null;
}

export async function listUsers() {
  const { rows } = await pool.query("SELECT id, username, created_at FROM users ORDER BY created_at");
  return rows;
}

// ── Link sessions ─────────────────────────────────────────────────────────────
export async function createLinkSession(userId) {
  const id = randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO link_sessions (id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
    [id, userId]
  );
  return id;
}

export async function getLinkSession(id) {
  const { rows } = await pool.query(
    "SELECT user_id FROM link_sessions WHERE id = $1 AND expires_at > NOW()",
    [id]
  );
  return rows[0] || null;
}

export async function deleteLinkSession(id) {
  await pool.query("DELETE FROM link_sessions WHERE id = $1", [id]);
}

// ── User items (banks) ────────────────────────────────────────────────────────
export async function getUserItems(userId) {
  const { rows } = await pool.query(
    `SELECT access_token AS "accessToken", item_id AS "itemId", institution_name AS "institutionName"
     FROM user_items WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

export async function upsertUserItem(userId, accessToken, itemId, institutionName) {
  await pool.query(
    `INSERT INTO user_items (user_id, access_token, item_id, institution_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE SET institution_name = $4`,
    [userId, accessToken, itemId, institutionName || null]
  );
}

export async function removeUserItem(userId, itemId) {
  const { rowCount } = await pool.query(
    "DELETE FROM user_items WHERE user_id = $1 AND item_id = $2",
    [userId, itemId]
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
export async function upsertTransactions(userId, transactions) {
  for (const t of transactions) {
    await pool.query(
      `INSERT INTO transactions
         (user_id, transaction_id, account_id, amount, date, name, merchant_name, category, pending)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (transaction_id) DO UPDATE SET amount = $4, pending = $9`,
      [
        userId,
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

export async function getTransactions(userId, { limit = 100, startDate, endDate, category } = {}) {
  const conditions = ["user_id = $1"];
  const params = [userId];
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

export async function getSpendingByCategory(userId, { startDate, endDate } = {}) {
  const conditions = ["user_id = $1", "pending = false", "amount > 0"];
  const params = [userId];
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
