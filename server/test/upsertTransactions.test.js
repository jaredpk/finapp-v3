import test from "node:test";
import assert from "node:assert/strict";
import pool, { upsertTransactions } from "../db.js";

// No database: pool.query is swapped for a recorder, same approach as the
// pool.connect fake in bulkUpdate.test.js.
async function capture(transactions) {
  const calls = [];
  const original = pool.query;
  pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  try {
    await upsertTransactions(transactions);
  } finally {
    pool.query = original;
  }
  return calls;
}

const plaidTxn = {
  transaction_id: "tx_1",
  account_id: "acct_1",
  date: "2026-09-01",
  authorized_date: "2026-08-31",
  amount: 12.5,
  name: "Whole Foods #123",
  merchant_name: "Whole Foods",
  original_description: "WHOLEFDS MKT #123 AUSTIN TX",
  pending: false,
  pending_transaction_id: "tx_pending",
  payment_channel: "in store",
  website: "wholefoodsmarket.com",
  logo_url: "https://logo.example/wf.png",
  location: { city: "Austin", region: "TX" },
  personal_finance_category: { primary: "FOOD_AND_DRINK", confidence_level: "VERY_HIGH" },
};

test("upsertTransactions persists Context fields from a Plaid-shaped object", async () => {
  const [{ params }] = await capture([plaidTxn]);
  assert.deepEqual(params, [
    "tx_1", "2026-09-01", "Whole Foods", 12.5, "acct_1", "FOOD_AND_DRINK", "reviewed", "tx_pending",
    "Whole Foods #123", "WHOLEFDS MKT #123 AUSTIN TX", "Austin", "TX",
    "wholefoodsmarket.com", "https://logo.example/wf.png", "FOOD_AND_DRINK", "VERY_HIGH",
    "2026-08-31", "in store",
  ]);
});

test("upsertTransactions maps missing Plaid fields to null", async () => {
  const [{ params }] = await capture([{ transaction_id: "tx_2", account_id: "a", date: "2026-09-02", amount: 1, pending: true }]);
  assert.deepEqual(params.slice(8), [null, null, null, null, null, null, null, null, null, null]);
  assert.equal(params[6], "pending");
});

test("upsertTransactions conflict clause never overwrites with null and leaves merchant alone", async () => {
  const [{ sql }] = await capture([plaidTxn]);
  const conflict = sql.slice(sql.indexOf("ON CONFLICT"));
  for (const col of [
    "name", "original_description", "city", "state", "website", "logo_url",
    "primary_category", "category_confidence", "authorized_date", "payment_channel",
  ]) {
    assert.match(conflict, new RegExp(`${col}\\s*=\\s*COALESCE\\(EXCLUDED\\.${col}, transactions\\.${col}\\)`));
  }
  assert.doesNotMatch(conflict, /merchant\s*=/);
  assert.doesNotMatch(conflict, /plaid_category\s*=/);
});

test("upsertTransactions keeps existing merchant, category and legacy-shape behavior", async () => {
  const [{ params }] = await capture([
    { id: "legacy_1", date: "2026-09-03", merchant: "SQ *COFFEE", amount: 4.5, account: "acct", plaid_category: "Dining" },
  ]);
  assert.equal(params[0], "legacy_1");
  assert.equal(params[2], "SQ *COFFEE");
  assert.equal(params[4], "acct");
  assert.equal(params[5], "Dining");
  assert.equal(params[6], "reviewed");
  assert.equal(params[7], null);
});
