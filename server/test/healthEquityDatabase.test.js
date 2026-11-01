import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { parseHealthEquityFile } from "../healthEquityImport.js";

// DB-backed half of the HealthEquity importer: idempotent insert, Transfer
// assignment for contribution/interest only, and a user's later re-categorizing
// surviving a re-import. Same guards as benefitsDatabase.test.js: skipped
// without DATABASE_URL, and refused unless that server is loopback; runs in a
// scratch database that is dropped afterwards.

const ADMIN_URL = process.env.DATABASE_URL || "";
const SCRATCH_DB = `finapp_he_test_${process.pid}`;
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

const SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, date DATE, merchant TEXT, amount NUMERIC(12,2), account TEXT,
    status TEXT, currency TEXT, reviewed_at TIMESTAMPTZ, original_description TEXT
  );
  CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1', created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE assignments (
    transaction_id TEXT NOT NULL PRIMARY KEY,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT NOW()
  );
`;

const td = (v) => `<td>${v}</td>`;
const tr = (c) => `<tr>${c.map(td).join("")}</tr>`;
const FILE = `<table><tr><td>Completed Transactions</td></tr><tr><td>Date</td><td>Transaction</td><td>Amount</td><td>HSA Cash Balance</td><td>Attachments</td></tr>${[
  tr(["1/9/2026", "Employer Contribution (Tax year: 2026)", "$100.00", "$100.00", ""]),
  tr(["7/31/2026", "Interest for Jul-26", "$0.03", "$100.03", ""]),
  tr(["8/2/2026", "Fake Clinic, UT (Card Transaction ID: a1)", "($40.00)", "$60.03", ""]),
  tr(["1/1/2026", "Balance Forward", "$0.00", "$0.00", ""]),
].join("")}</table>`;

let pool;
if (runnable) {
  const admin = async (fn) => {
    const p = new pg.Pool({ connectionString: ADMIN_URL, ssl: false });
    try { return await fn(p); } finally { await p.end(); }
  };
  await admin(async (a) => {
    await a.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await a.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  pool = db.default;
  await pool.query(SCHEMA);
  test.after(async () => {
    await pool.end();
    await admin((a) => a.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`));
  });
}

test("import is idempotent, files Transfer for contributions/interest only, and keeps user edits", { skip }, async () => {
  const { rows } = parseHealthEquityFile(FILE);
  assert.equal(rows.length, 3);
  await pool.query(`INSERT INTO categories (name) VALUES ('transfer'), ('Medical')`);
  const [{ id: transferId }] = (await pool.query(`SELECT id FROM categories WHERE name='transfer'`)).rows;
  const [{ id: medicalId }] = (await pool.query(`SELECT id FROM categories WHERE name='Medical'`)).rows;

  assert.equal((await db.getExistingTransactionIds(rows.map((r) => r.id))).size, 0);
  const first = await db.importHealthEquityRows(rows, "HealthEquity HSA");
  assert.deepEqual(first, { inserted: 3, already_imported: 0, categorized_transfer: 2 });

  const t = (await pool.query(`SELECT * FROM transactions ORDER BY date`)).rows;
  assert.equal(t.length, 3);
  assert.ok(t.every((r) => r.status === "reviewed" && r.reviewed_at && r.account === "HealthEquity HSA"));
  const card = t.find((r) => r.merchant === "Fake Clinic");
  assert.equal(Number(card.amount), 40);
  assert.equal(card.original_description, "Fake Clinic, UT (Card Transaction ID: a1)");
  assert.equal(card.date.toISOString().slice(0, 10) === "2026-08-02" || String(card.date).includes("Aug 02 2026"), true);

  const assigned = (await pool.query(`SELECT transaction_id, category_id FROM assignments`)).rows;
  assert.equal(assigned.length, 2);
  assert.ok(assigned.every((a) => a.category_id === transferId));
  assert.ok(!assigned.some((a) => a.transaction_id === card.id));

  // The user re-files the interest row and categorizes the card row, then the
  // same file is imported again: nothing inserted, nothing altered.
  const interest = rows.find((r) => r.kind === "interest");
  await pool.query(`UPDATE assignments SET category_id=$2 WHERE transaction_id=$1`, [interest.id, medicalId]);
  await pool.query(`INSERT INTO assignments (transaction_id, category_id) VALUES ($1,$2)`, [card.id, medicalId]);
  assert.equal((await db.getExistingTransactionIds(rows.map((r) => r.id))).size, 3);
  const again = await db.importHealthEquityRows(rows, "HealthEquity HSA");
  assert.deepEqual(again, { inserted: 0, already_imported: 3, categorized_transfer: 0 });
  const after = Object.fromEntries((await pool.query(`SELECT transaction_id, category_id FROM assignments`)).rows.map((a) => [a.transaction_id, a.category_id]));
  assert.equal(after[interest.id], medicalId);
  assert.equal(after[card.id], medicalId);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM transactions`)).rows[0].n, 3);
});

test("a missing Transfer category is created on demand", { skip }, async () => {
  await pool.query(`TRUNCATE assignments, transactions; DELETE FROM categories`);
  const { rows } = parseHealthEquityFile(FILE);
  const r = await db.importHealthEquityRows(rows, "HealthEquity HSA");
  assert.equal(r.categorized_transfer, 2);
  const cats = (await pool.query(`SELECT name FROM categories`)).rows;
  assert.deepEqual(cats.map((c) => c.name), ["Transfer"]);
});
