import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// The half of card-benefit tracking the pure tests cannot reach: the columns
// themselves, the CHECK constraint, the idempotent migration, and the SQL that
// turns transactions into per-period aggregates. benefitPeriods.test.js and
// benefitDerive.test.js prove the arithmetic; this file proves that the
// arithmetic is being fed by the database the app actually runs on.
//
// It is the only test in this suite that needs a server, so it is guarded
// twice:
//
//   1. no DATABASE_URL → skipped, because CI and a fresh checkout have none;
//   2. a DATABASE_URL that is not LOOPBACK → skipped, because this file creates
//      and drops a database, and doing that against the production pooler
//      because someone had the wrong shell open is not a risk worth taking.
//      The predicate is db.js's own isLocalConnectionString, which is what
//      decides whether that DSN may drop TLS, and it is checked before any
//      query is issued.
//
// Everything runs in a SCRATCH database created for this file and dropped
// again, so it cannot disturb whatever is in the developer's own.

const ADMIN_URL = process.env.DATABASE_URL || "";
const SCRATCH_DB = `finapp_benefits_test_${process.pid}`;

// The scratch DSN has to be in place BEFORE db.js is imported: it builds its
// Pool from process.env at module scope, and ES modules are cached, so there is
// no second chance to point it somewhere else.
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
// Same host as the admin DSN — only the database name differs — so checking the
// original is checking where this lands.
const runnable = Boolean(db && scratchUrl && db.isLocalConnectionString(ADMIN_URL));
const skip = runnable
  ? false
  : ADMIN_URL
    ? "DATABASE_URL is not a loopback server; refusing to create a scratch database on it"
    : "no DATABASE_URL";

// The tables the benefits queries JOIN against, with the columns and types they
// read. Deliberately a fixture rather than initDb(): initDb ALTERs `transactions`
// before anything creates it, so it cannot build an empty database, and the
// benefits SQL only ever touches these two.
const FIXTURE_SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    date DATE,
    merchant TEXT,
    amount NUMERIC(12,2),
    account TEXT,
    plaid_category TEXT,
    primary_category TEXT,
    status TEXT,
    hidden BOOLEAN DEFAULT FALSE,
    name TEXT,
    original_description TEXT
  );
  CREATE TABLE hidden_accounts (
    account_id TEXT PRIMARY KEY,
    hidden_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

const ACCOUNT = "acct-scratch-1";

async function withAdmin(fn) {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, ssl: false });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// One scratch database for the whole file, torn down at the end whatever
// happened in between.
let repository;
let routes;
let pool;

if (runnable) {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  pool = db.default;
  await pool.query(FIXTURE_SCHEMA);
  const schema = await import("../benefits/schema.js");
  // TWICE, on purpose. Every migration in this file has to be a no-op on the
  // second run — that is what "idempotent" means here, and a DROP CONSTRAINT /
  // ADD CONSTRAINT pair that only works once is a deploy that fails on restart.
  await schema.initBenefitsSchema(pool);
  await schema.initBenefitsSchema(pool);
  repository = await import("../benefits/repository.js");
  routes = await import("../benefits/routes.js");

  test.after(async () => {
    await pool.end();
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    });
  });
}

// Fresh catalog per test; the transactions table is refilled by each test that
// needs rows.
async function reset() {
  await pool.query(`TRUNCATE cb_cards, cb_benefits, cb_match_rules, cb_manual_marks, cb_alerts RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE transactions`);
}

async function insertTxns(rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO transactions (id, date, merchant, amount, account, status, hidden)
       VALUES ($1, $2, $3, $4, $5, 'posted', FALSE)`,
      [r.id, r.date, r.merchant, r.amount, r.account ?? ACCOUNT]
    );
  }
}

const findBenefit = (status, name) =>
  status.cards.flatMap((c) => c.benefits).find((b) => b.name === name);

test("the new columns exist, default sanely and reject an unknown unit", { skip }, async () => {
  await reset();
  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'cb_benefits' AND column_name IN ('cycle_anchor','unit')
     ORDER BY column_name`
  );
  assert.deepEqual(rows.map((r) => r.column_name), ["cycle_anchor", "unit"]);
  assert.equal(rows[0].data_type, "date");
  assert.equal(rows[0].is_nullable, "YES");     // null means "follow the card"
  assert.equal(rows[1].is_nullable, "NO");
  assert.match(rows[1].column_default, /usd/);

  const card = await repository.createCard({ nickname: "Venture X", account_id: ACCOUNT, anniversary_date: "2019-09-14" });
  // The default lands on an INSERT that never mentions the column, which is the
  // shape every existing row was written with.
  const plain = await repository.createBenefit({ card_id: card.id, name: "Plain" });
  assert.equal(plain.unit, "usd");
  assert.equal(plain.cycle_anchor, null);

  // And a value outside the enum cannot be stored, whatever route reaches the
  // column.
  await assert.rejects(
    () => repository.createBenefit({ card_id: card.id, name: "Bad", unit: "miles" }),
    (err) => err.code === "23514" && /cb_benefits_unit_check/.test(err.constraint || err.message)
  );
});

test("cycle_anchor and unit round-trip through create, patch and the catalog", { skip }, async () => {
  await reset();
  const card = await repository.createCard({ nickname: "Venture X", account_id: ACCOUNT, anniversary_date: "2019-09-14" });
  const created = await repository.createBenefit({
    card_id: card.id, name: "Travel credit", amount_limit: 300,
    period_unit: "year", period_count: 1, period_basis: "anniversary",
    cycle_anchor: "2023-12-17", unit: "usd",
  });
  // DATE columns come back TO_CHAR'd, never as a Date whose day depends on the
  // reader's timezone.
  assert.equal(created.cycle_anchor, "2023-12-17");

  const patched = await repository.updateBenefit(created.id, { unit: "visits", cycle_anchor: "2024-02-01" });
  assert.equal(patched.unit, "visits");
  assert.equal(patched.cycle_anchor, "2024-02-01");

  const [catalogCard] = await repository.getCatalog();
  assert.equal(catalogCard.benefits[0].unit, "visits");
  assert.equal(catalogCard.benefits[0].cycle_anchor, "2024-02-01");

  // Clearing it puts the benefit back on the card's anniversary.
  const cleared = await repository.updateBenefit(created.id, { cycle_anchor: null });
  assert.equal(cleared.cycle_anchor, null);
});

test("a December 17 anchor moves the scanned window off the card's anniversary", { skip }, async () => {
  await reset();
  const card = await repository.createCard({
    nickname: "Venture X", account_id: ACCOUNT, anniversary_date: "2019-09-14",
  });
  const anchored = await repository.createBenefit({
    card_id: card.id, name: "Anchored credit", amount_limit: 300,
    period_unit: "year", period_basis: "anniversary", cycle_anchor: "2023-12-17",
  });
  const cardBased = await repository.createBenefit({
    card_id: card.id, name: "Card-anniversary credit", amount_limit: 300,
    period_unit: "year", period_basis: "anniversary",
  });
  for (const id of [anchored.id, cardBased.id]) {
    await repository.createRule({ benefit_id: id, merchant_regex: "TRAVEL", direction: "charge" });
  }
  await insertTxns([
    // Inside the December-anchored year, but BEFORE the September one.
    { id: "t-mar", date: "2026-03-02", merchant: "TRAVEL PORTAL", amount: 300 },
  ]);

  const status = await routes.getBenefitsStatus("2026-08-23");
  const a = findBenefit(status, "Anchored credit");
  const b = findBenefit(status, "Card-anniversary credit");

  assert.equal(a.period_key, "anniv:year:1:2025-12-17");
  assert.equal(a.period_start, "2025-12-17");
  assert.equal(a.period_end, "2026-12-16");
  assert.equal(a.cycle_anchor, "2023-12-17");
  assert.equal(a.amount_used, 300);

  // The same transaction, the same card, a different window: March falls in the
  // year that opened last September too, so both see it here — what differs is
  // the window, and that is what the keys record.
  assert.equal(b.period_key, "anniv:year:1:2025-09-14");
  assert.equal(b.cycle_anchor, null);

  // A charge dated between the two anchors separates them: it is inside the
  // September year and outside the December one.
  await insertTxns([{ id: "t-oct", date: "2025-10-06", merchant: "TRAVEL PORTAL", amount: 120 }]);
  const second = await routes.getBenefitsStatus("2026-08-23");
  assert.equal(findBenefit(second, "Anchored credit").amount_used, 300);
  assert.equal(findBenefit(second, "Card-anniversary credit").amount_used, 420);
});

test("a February-through-January cycle is scanned as one window in SQL", { skip }, async () => {
  await reset();
  const card = await repository.createCard({
    nickname: "Amex Platinum", account_id: ACCOUNT, anniversary_date: "2019-09-14",
  });
  const benefit = await repository.createBenefit({
    card_id: card.id, name: "Sky Club visits", amount_limit: 10,
    period_unit: "year", period_basis: "anniversary", cycle_anchor: "2024-02-01",
    unit: "visits",
  });
  await repository.createRule({ benefit_id: benefit.id, merchant_regex: "SKY CLUB", direction: "charge" });
  await insertTxns([
    { id: "t-feb", date: "2025-02-14", merchant: "DELTA SKY CLUB", amount: 59 },
    { id: "t-dec", date: "2025-12-02", merchant: "DELTA SKY CLUB", amount: 59 },
    { id: "t-jan", date: "2026-01-08", merchant: "DELTA SKY CLUB", amount: 79 },
  ]);

  // Read from inside January: all three belong to the year that opened LAST
  // February, and the January visit is not the new year's first.
  const status = await routes.getBenefitsStatus("2026-01-20");
  const b = findBenefit(status, "Sky Club visits");
  assert.equal(b.period_start, "2025-02-01");
  assert.equal(b.period_end, "2026-01-31");
  assert.equal(b.amount_used, 3);

  // One day into the new cycle the count resets, from the same rows.
  const after = findBenefit(await routes.getBenefitsStatus("2026-02-01"), "Sky Club visits");
  assert.equal(after.period_start, "2026-02-01");
  assert.equal(after.amount_used, 0);
  assert.equal(after.status, "available");
});

test("a visits benefit counts the aggregate's rows, and a usd benefit sums their amounts", { skip }, async () => {
  // Both benefits, on the same card, over the same three transactions. The only
  // difference is the unit, so this is the counting branch and nothing else.
  await reset();
  const card = await repository.createCard({
    nickname: "Amex Platinum", account_id: ACCOUNT, anniversary_date: "2019-09-14",
  });
  const visits = await repository.createBenefit({
    card_id: card.id, name: "Lounge visits", amount_limit: 10, unit: "visits",
  });
  const dollars = await repository.createBenefit({
    card_id: card.id, name: "Lounge dollars", amount_limit: 500, unit: "usd",
  });
  for (const id of [visits.id, dollars.id]) {
    await repository.createRule({ benefit_id: id, merchant_regex: "SKY CLUB", direction: "charge" });
  }
  await insertTxns([
    { id: "v1", date: "2026-08-03", merchant: "DELTA SKY CLUB", amount: 59 },
    { id: "v2", date: "2026-08-11", merchant: "DELTA SKY CLUB", amount: 59 },
    { id: "v3", date: "2026-08-19", merchant: "DELTA SKY CLUB", amount: 79 },
  ]);

  const status = await routes.getBenefitsStatus("2026-08-23");
  const counted = findBenefit(status, "Lounge visits");
  const summed = findBenefit(status, "Lounge dollars");

  assert.equal(counted.unit, "visits");
  assert.equal(counted.amount_used, 3);        // three visits …
  assert.equal(counted.amount_remaining, 7);
  assert.equal(counted.status, "partially-used");
  assert.equal(summed.amount_used, 197);       // … the same rows, $197
  assert.equal(summed.unit, "usd");
});

test("a points benefit lists its matches as evidence and counts none of them", { skip }, async () => {
  await reset();
  const card = await repository.createCard({
    nickname: "Amex Platinum", account_id: ACCOUNT, anniversary_date: "2019-09-14",
  });
  const benefit = await repository.createBenefit({
    card_id: card.id, name: "Transfer bonus", amount_limit: 25000, unit: "points",
  });
  await repository.createRule({ benefit_id: benefit.id, merchant_regex: "AIRLINE", direction: "charge" });
  await insertTxns([
    { id: "p1", date: "2026-08-04", merchant: "AIRLINE TICKETS", amount: 250 },
    { id: "p2", date: "2026-08-14", merchant: "AIRLINE TICKETS", amount: 125 },
  ]);

  const before = findBenefit(await routes.getBenefitsStatus("2026-08-23"), "Transfer bonus");
  assert.equal(before.amount_used, 0);         // $375 of spend is not 375 points
  assert.equal(before.amount_remaining, 25000);
  assert.equal(before.status, "manual-only");
  assert.deepEqual(before.matches.map((m) => m.txn_id), ["p1", "p2"]);

  // The mark is the only thing that can move it, and it is in points.
  await repository.upsertManualMark({
    benefitId: benefit.id, periodKey: before.period_key, amount: 10000, note: "transferred",
  });
  const after = findBenefit(await routes.getBenefitsStatus("2026-08-23"), "Transfer bonus");
  assert.equal(after.amount_used, 10000);
  assert.equal(after.amount_remaining, 15000);
  assert.equal(after.confidence, "manual");
  assert.equal(after.status, "partially-used");
});

test("an anniversary benefit with no anchor anywhere reads no-anchor, never available", { skip }, async () => {
  await reset();
  const card = await repository.createCard({
    nickname: "Unfinished card", account_id: ACCOUNT, anniversary_date: null,
  });
  const benefit = await repository.createBenefit({
    card_id: card.id, name: "Orphan credit", amount_limit: 300,
    period_unit: "year", period_basis: "anniversary",
  });
  await repository.createRule({ benefit_id: benefit.id, merchant_regex: "TRAVEL", direction: "charge" });
  await insertTxns([{ id: "h1", date: "2020-01-02", merchant: "OPENING BALANCE", amount: 5 }]);

  const orphan = findBenefit(await routes.getBenefitsStatus("2026-08-23"), "Orphan credit");
  assert.equal(orphan.status, "no-anchor");
  assert.notEqual(orphan.status, "available");

  // Setting the benefit's own anchor is enough to resolve it.
  await repository.updateBenefit(benefit.id, { cycle_anchor: "2023-12-17" });
  const fixed = findBenefit(await routes.getBenefitsStatus("2026-08-23"), "Orphan credit");
  assert.equal(fixed.status, "available");
  assert.equal(fixed.period_key, "anniv:year:1:2025-12-17");
});
