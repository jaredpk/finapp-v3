import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { NEEDS_REVIEW_CONDITIONS, parseNeedsReview } from "../needsReview.js";

// ── Pure ──────────────────────────────────────────────────────────────────────

test("parseNeedsReview: only the exact string '1' enables the filter", () => {
  assert.equal(parseNeedsReview("1"), true);
  for (const v of [undefined, null, "", "0", "01", "true", "yes", " 1", "1 ", 1, true, ["1"], ["1", "1"]]) {
    assert.equal(parseNeedsReview(v), false, `value ${JSON.stringify(v)}`);
  }
});

test("NEEDS_REVIEW_CONDITIONS: visible + no category assignment + no splits, against alias t", () => {
  const sql = NEEDS_REVIEW_CONDITIONS.join(" AND ");
  assert.match(sql, /t\.hidden IS NOT TRUE/);
  assert.match(sql, /t\.account NOT IN \(SELECT account_id FROM hidden_accounts\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM assignments a WHERE a\.transaction_id = t\.id AND a\.category_id IS NOT NULL\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM splits s WHERE s\.transaction_id = t\.id\)/);
  // Pending rows count in the tile, so status must not be filtered.
  assert.doesNotMatch(sql, /status/);
});

// ── DB (loopback-guarded, same pattern as benefitsDatabase.test.js) ───────────
// Proves getTransactions({ needsReview: true }) returns exactly the rows
// getTransactionStats counts as needsReview, in (date DESC, id DESC) order.

const ADMIN_URL = process.env.DATABASE_URL || "";
const SCRATCH_DB = `finapp_needsreview_test_${process.pid}`;

const scratchUrl = (() => {
  try {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  } catch {
    return "";
  }
})();
if (scratchUrl) process.env.DATABASE_URL = scratchUrl;

const db = ADMIN_URL ? await import("../db.js") : null;
const runnable = Boolean(db && scratchUrl && db.isLocalConnectionString(ADMIN_URL));
const skip = runnable
  ? false
  : ADMIN_URL
    ? "DATABASE_URL is not a loopback server; refusing to create a scratch database on it"
    : "no DATABASE_URL";

const FIXTURE_SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    date DATE,
    authorized_date DATE,
    merchant TEXT,
    name TEXT,
    amount NUMERIC(12,2),
    currency TEXT,
    account TEXT,
    payment_channel TEXT,
    plaid_category TEXT,
    primary_category TEXT,
    category_confidence TEXT,
    pending_transaction_id TEXT,
    city TEXT,
    state TEXT,
    website TEXT,
    logo_url TEXT,
    original_description TEXT,
    suggested_category TEXT,
    status TEXT,
    hidden BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
  );
  CREATE TABLE hidden_accounts (account_id TEXT PRIMARY KEY, hidden_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE assignments (transaction_id TEXT PRIMARY KEY, category_id UUID, updated_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE splits (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id TEXT NOT NULL, category_id UUID, amount NUMERIC(12,2) NOT NULL);
  CREATE TABLE receipt_matches (
    transaction_id TEXT PRIMARY KEY, merchant TEXT, receipt_date DATE, total NUMERIC(12,2),
    items JSONB, suggested_category_id UUID
  );
`;

async function withAdmin(fn) {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, ssl: false });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

let pool;
if (runnable) {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  pool = db.default;
  await pool.query(FIXTURE_SCHEMA);
  test.after(async () => {
    await pool.end();
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    });
  });
}

const CAT = "11111111-1111-1111-1111-111111111111";

async function seed() {
  await pool.query(`TRUNCATE transactions, hidden_accounts, assignments, splits, receipt_matches`);
  const rows = [
    // id, date, account, status, hidden
    ["a-plain-new",   "2025-03-05", "acct1", "posted",  false], // needs review
    ["a-plain-old",   "2024-01-01", "acct1", "posted",  false], // needs review (old: outside any 2000 window)
    ["b-same-day",    "2025-03-05", "acct1", "posted",  false], // needs review, ties on date -> id DESC puts it first
    ["c-pending",     "2025-03-04", "acct1", "pending", false], // needs review: pending counts
    ["d-assigned",    "2025-03-03", "acct1", "posted",  false], // has category
    ["e-null-assign", "2025-03-02", "acct1", "posted",  false], // assignment row with NULL category -> still needs review
    ["f-split",       "2025-03-01", "acct1", "posted",  false], // has splits
    ["g-hidden",      "2025-02-28", "acct1", "posted",  true ], // hidden -> excluded
    ["h-hidden-acct", "2025-02-27", "acct2", "posted",  false], // hidden account -> excluded
  ];
  for (const [id, date, account, status, hidden] of rows) {
    await pool.query(
      `INSERT INTO transactions (id, date, amount, account, status, hidden) VALUES ($1,$2,10,$3,$4,$5)`,
      [id, date, account, status, hidden]
    );
  }
  await pool.query(`INSERT INTO hidden_accounts (account_id) VALUES ('acct2')`);
  await pool.query(`INSERT INTO assignments (transaction_id, category_id) VALUES ('d-assigned', $1), ('e-null-assign', NULL)`, [CAT]);
  await pool.query(`INSERT INTO splits (transaction_id, category_id, amount) VALUES ('f-split', $1, 10)`, [CAT]);
}

const EXPECTED = ["b-same-day", "a-plain-new", "c-pending", "e-null-assign", "a-plain-old"];

test("getTransactions({ needsReview: true }) returns exactly the tile's rows, ordered date DESC, id DESC", { skip }, async () => {
  await seed();
  const rows = await db.getTransactions({ limit: 100, needsReview: true });
  assert.deepEqual(rows.map((r) => r.transaction_id), EXPECTED);
  const stats = await db.getTransactionStats();
  assert.equal(stats.needsReview, rows.length);
});

test("needsReview honours limit, date bounds and leaves the default path untouched", { skip }, async () => {
  await seed();
  assert.deepEqual(
    (await db.getTransactions({ limit: 2, needsReview: true })).map((r) => r.transaction_id),
    EXPECTED.slice(0, 2)
  );
  assert.deepEqual(
    (await db.getTransactions({ limit: 100, needsReview: true, startDate: "2025-03-02", endDate: "2025-03-04" })).map((r) => r.transaction_id),
    ["c-pending", "e-null-assign"]
  );
  // Default: every row, including hidden / assigned ones.
  assert.equal((await db.getTransactions({ limit: 100 })).length, 9);
  assert.equal((await db.getTransactions({ limit: 100, needsReview: false })).length, 9);
});
