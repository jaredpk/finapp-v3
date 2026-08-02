#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: reconcile Plaid against Postgres for a date range.
 *
 * Answers the fork-in-the-road question: did Plaid ever deliver a transaction,
 * and is it in our `transactions` table?
 *
 * This script NEVER writes. It does not INSERT/UPDATE/DELETE, it does not
 * advance or save a sync cursor, and it does not call any mutating Plaid
 * endpoint. It uses /transactions/get, which is a read of the item's current
 * state and is safe to re-run.
 *
 * Usage:
 *   node scripts/diagnose-missing-transactions.mjs 2026-07-01 2026-07-31
 *
 * Requires DATABASE_URL, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV in env
 * (the same values the server uses).
 */
import pg from "pg";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const [START = "2026-07-01", END = "2026-07-31"] = process.argv.slice(2);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  })
);

const money = (n) => (n == null ? "     -" : n.toFixed(2).padStart(10));
const key = (t) => `${t.date}|${Math.abs(t.amount).toFixed(2)}|${t.account}`;

async function fetchAllPlaid(accessToken) {
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await plaid.transactionsGet({
      access_token: accessToken,
      start_date: START,
      end_date: END,
      options: { count: 500, offset, include_personal_finance_category: true },
    });
    out.push(...r.data.transactions);
    offset += r.data.transactions.length;
    if (offset >= r.data.total_transactions) break;
  }
  return out;
}

async function main() {
  console.log(`\nRead-only reconciliation  ${START} .. ${END}\n${"=".repeat(78)}`);

  const { rows: items } = await pool.query(
    `SELECT access_token AS "accessToken", item_id AS "itemId",
            institution_name AS "institutionName"
     FROM user_items ORDER BY institution_name`
  );

  const { rows: dbRows } = await pool.query(
    `SELECT id, TO_CHAR(date,'YYYY-MM-DD') AS date, merchant, amount::float AS amount,
            account, status, pending_transaction_id, hidden,
            TO_CHAR(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
     FROM transactions WHERE date >= $1::date AND date <= $2::date`,
    [START, END]
  );
  const dbById = new Map(dbRows.map((r) => [r.id, r]));
  console.log(`Postgres rows in range: ${dbRows.length}`);

  // ── Per-item status ────────────────────────────────────────────────────────
  console.log(`\n── Item health ${"─".repeat(63)}`);
  for (const it of items) {
    let status = "?";
    let error = null;
    let productList = [];
    try {
      const r = await plaid.itemGet({ access_token: it.accessToken });
      error = r.data.item.error;
      productList = r.data.item.products || [];
      status = error ? `ERROR ${error.error_code}` : "ok";
    } catch (e) {
      status = `itemGet failed: ${e.response?.data?.error_code || e.message}`;
    }
    const { rows: cur } = await pool.query(
      `SELECT cursor IS NOT NULL AS has_cursor, updated_at
       FROM transaction_cursors WHERE item_id = $1`,
      [it.itemId]
    );
    console.log(
      `  ${(it.institutionName || it.itemId).padEnd(28)} ${status.padEnd(26)} ` +
        `products=[${productList.join(",")}] cursor=${cur[0]?.has_cursor ? "yes" : "NONE"} ` +
        `last=${cur[0]?.updated_at?.toISOString?.().slice(0, 16) ?? "never"}`
    );
    if (error) console.log(`      -> ${error.error_message}`);
  }

  // ── Plaid vs Postgres ──────────────────────────────────────────────────────
  const plaidTxns = [];
  for (const it of items) {
    try {
      for (const t of await fetchAllPlaid(it.accessToken)) {
        plaidTxns.push({
          id: t.transaction_id,
          date: t.date,
          merchant: t.merchant_name || t.name,
          amount: t.amount,
          account: t.account_id,
          pending: t.pending,
          pending_transaction_id: t.pending_transaction_id,
          institution: it.institutionName,
        });
      }
    } catch (e) {
      console.log(`  !! ${it.institutionName}: ${e.response?.data?.error_code || e.message}`);
    }
  }
  console.log(`\nPlaid transactions in range: ${plaidTxns.length}`);

  const missing = plaidTxns.filter((t) => !dbById.has(t.id));
  console.log(`\n── Delivered by Plaid but ABSENT from Postgres: ${missing.length} ${"─".repeat(20)}`);
  for (const t of missing.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(
      `  ${t.date} ${money(t.amount)}  ${(t.merchant || "").slice(0, 34).padEnd(34)} ` +
        `${t.account.slice(0, 10)} ${t.pending ? "PENDING" : ""}`
    );
    // Why was it dropped? Show the row occupying its collision key.
    const blockers = dbRows.filter(
      (r) => r.date === t.date && Math.abs(r.amount).toFixed(2) === Math.abs(t.amount).toFixed(2)
    );
    for (const b of blockers) {
      const sameAcct = b.account === t.account;
      console.log(
        `        collides with: ${money(b.amount)} ${(b.merchant || "").slice(0, 30).padEnd(30)} ` +
          `${b.account.slice(0, 10)} created=${b.created_at} ` +
          `[${sameAcct ? "INSERT TRIGGER blocks" : "startup dedup sweep deletes"}]`
      );
    }
    if (!blockers.length) console.log(`        (no same-date/|amount| collision — different cause)`);
  }

  const orphans = dbRows.filter(
    (r) => !/^(csv_|simplifi_)/.test(r.id) && !plaidTxns.some((t) => t.id === r.id)
  );
  console.log(`\n── In Postgres but not in Plaid's current response: ${orphans.length} ${"─".repeat(16)}`);
  for (const r of orphans.slice(0, 40)) {
    console.log(`  ${r.date} ${money(r.amount)}  ${(r.merchant || "").slice(0, 34)}`);
  }

  // ── What the collision keys would collapse ────────────────────────────────
  console.log(`\n── Collision analysis over Plaid's own data ${"─".repeat(31)}`);
  const groups = new Map();
  for (const t of plaidTxns) {
    const k = `${t.date}|${Math.abs(t.amount).toFixed(2)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const collisions = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(`  (date, |amount|) groups with >1 member  [startup dedup key]: ${collisions.length}`);
  let sameAcctGroups = 0;
  for (const [k, v] of collisions) {
    const byAcct = new Map();
    for (const t of v) byAcct.set(t.account, (byAcct.get(t.account) || 0) + 1);
    if ([...byAcct.values()].some((c) => c > 1)) sameAcctGroups++;
    console.log(`   ${k}  x${v.length}`);
    for (const t of v) {
      console.log(
        `        ${money(t.amount)} ${(t.merchant || "").slice(0, 30).padEnd(30)} ` +
          `${t.account.slice(0, 10)} ${dbById.has(t.id) ? "in db" : "MISSING"}`
      );
    }
  }
  console.log(
    `  of those, groups with 2+ rows on the SAME account [insert trigger key]: ${sameAcctGroups}`
  );
  console.log(
    `\n  Every extra member of each group above is a row the current code will\n` +
      `  silently drop or delete. Expected surviving rows: ${plaidTxns.length - collisions.reduce((n, [, v]) => n + v.length - 1, 0)}\n`
  );

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
