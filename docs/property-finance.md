# Property Finance

A first-class page for tracking a Florida condo rental property's finances: live
2026 reporting plus historical 2021-2025 data backfilled from an old spreadsheet.

## Architecture

The app is a plain Express + raw-`pg` server (`server/index.js`, `server/db.js`) and
a plain React/Vite client with no router (view switching via a `VIEWS` map in
`client/src/App.jsx`). Property Finance follows those same conventions rather than
introducing an ORM, TypeScript, or a client-side router.

```
server/property/
  schema.js          – CREATE TABLE migrations (pf_* tables), called from db.js#initDb()
  categories.js       – canonical category list + keyword-based category suggestion
  repository.js       – all SQL for property-finance (business logic never touches SQL directly)
  matching.js          – Plaid transaction attribution/matching + recurring-charge detection
  seed.js              – demo data: backfills 2021-2025 via the real import pipeline,
                          then runs the mock 2026 Plaid feed through the real matcher
  routes.js            – Express routes, registered from index.js via registerPropertyFinanceRoutes()
  importParsers/
    rowShape.js         – documented intermediate row shape + low-level cell parsing
    columnDetectors.js  – detects which of the sheet's column-variant "shapes" a tab uses
    parseYearSheet.js    – turns one year-tab's rows into transactions/usage/review-queue
    index.js              – parseWorkbook(): multi-sheet import with id assignment
  fixtures/
    sampleSheets.js        – mock spreadsheet tabs for 2021-2025 (no literal file exists)
    samplePlaidTransactions.js – mock live Plaid-shaped transactions for 2026

client/src/views/PropertyFinance.jsx   – page: loads property, year, and renders sections
client/src/components/property/         – one component per page section (see below)
client/src/api.js                        – "Property Finance" section appended to the
                                            existing single api.js file, matching its
                                            established per-domain-section convention
```

### Why `pf_` table prefixes

The app already has a `properties` table used for FHFA-index-based home-value
tracking on the net-worth dashboard. Property Finance's `properties` entity (a
rental property with years/transactions/allocations) is a different concept, so
its tables are prefixed `pf_` to avoid colliding with that existing table and its
`/api/properties` routes.

## Schema

`pf_properties` → `pf_property_years` → `pf_transactions`, plus:

- `pf_transaction_sources` — where a transaction stream comes from (Plaid account,
  an import batch, manual entry).
- `pf_category_mappings` — merchant/memo → normalized-category, reinforced every
  time a transaction's category is edited (this is what makes matching improve
  over time; see `bumpCategoryMapping` in `repository.js`).
- `pf_allocation_rules` — reusable rental/personal split templates (not yet
  surfaced in the UI beyond per-transaction editing — see "Where to extend").
- `pf_usage_periods` — days-rented/days-personal-use rows extracted from the
  spreadsheet's occupancy columns. Kept separate from `pf_transactions` because
  they carry no dollar amount and aren't ledger entries.
- `pf_reconciliation_events` / `pf_audit_log` — append-only history of matches,
  manual edits, reconciliations, and exclusions.
- `pf_import_batches` / `pf_review_queue` — one row per import run, with any rows
  that couldn't be parsed routed to the review queue instead of silently dropped
  or silently miscategorized.

`pf_transactions.amount` is always positive; sign is carried by `direction`
(`income`/`expense`), matching the sign convention already used by the app's
existing `transactions` table (see `getSpendingByCategory` in `server/db.js`,
which also treats `amount > 0` as spend).

Categories are fixed to: Rents, Utilities, Management Fees, Maintenance, Repairs,
Insurance, Taxes, Advertising, Travel, Improvement, Commissions, Uncategorized
(`server/property/categories.js`).

## Import flow

The old spreadsheet has one tab per year, with **inconsistent columns** — no
literal file exists, so the parser is built and tested against a documented
intermediate row shape (`server/property/importParsers/rowShape.js`) plus
realistic mock fixtures (`server/property/fixtures/sampleSheets.js`) covering
three observed column variants:

1. **direct_expense** — `Monthly Rents` / `Direct Expense` / `Notes` / `Reconciled out of Reserve Account`
2. **gross_type** — `Gross` / `Type` / `Category` / `Notes`
3. **deposits_implied** — `Deposits Received` / `Implied Expense` / `Expense` / `Notes`

`columnDetectors.js` inspects a tab's header row and picks the matching shape;
`parseYearSheet.js` then parses each row purely off that shape's column map. This
keeps the parser composable — adding a fourth column variant means adding
aliases + a `case` branch, not rewriting the whole parser.

Per row, the parser:
- Skips blank rows and summary/total/depreciation rows (`isSummaryRow` — matches
  on the row's first non-empty cell, tolerant of the summary block being shifted
  a column over, which happens in real spreadsheets).
- Extracts a days-rented/days-personal-use row into `pf_usage_periods` instead of
  `pf_transactions` when the row carries occupancy data but no dollar amount.
- Normalizes amount sign/direction per the detected shape, and derives a
  normalized category from the sheet's own category/type text, falling back to
  keyword matching against the memo (`suggestCategoryFromText`).
- Routes anything with no parseable date or no parseable amount to the review
  queue (`pf_review_queue`) with a `reason` (`unparseable_date`,
  `no_amount_found`, `no_date_column_detected`) instead of silently dropping it.

`parseWorkbook()` (`importParsers/index.js`) runs this across every year tab and
assigns deterministic, batch-scoped ids so re-running an import is an upsert, not
a duplicate.

Real import: `POST /api/property-finance/properties/:id/import/preview` (dry run,
nothing written) and `.../import/commit` (persists), both accepting
`{ sheets: [{ year, label, rows }] }` in the documented row shape.

## Matching / attribution flow

`server/property/matching.js#matchPlaidTransaction(plaidTxn, { historicalTransactions, categoryMappings })`
runs, in order:

1. Exact merchant → `pf_category_mappings` hit (confidence 0.95) — this is the
   "learns from your manual edits" path; every category edit in the ledger calls
   `bumpCategoryMapping`.
2. Merchant-history match against prior `pf_transactions` (confidence scales with
   occurrence count and whether the amount is close to history).
3. Keyword pattern match against merchant + description text (confidence 0.55).
4. Otherwise `Uncategorized` with low confidence (0.15) and `needsReview: true`.

Every match carries a human-readable `explanation` string, which the UI shows in
an expandable row and in the reconciliation queue.

`detectRecurringCharges()` groups a transaction list by normalized merchant and
flags groups occurring ≥2 times with a roughly-monthly cadence — this is how
utilities/HOA/insurance/subscription charges get surfaced (`GET
/api/property-finance/properties/:id/plaid-preview` returns both suggestions and
recurring groups).

Since no real Plaid item is linked to the rental property's bank account yet,
`fixtures/samplePlaidTransactions.js` stands in for the live feed. Swapping in the
real feed is described below.

## Page

`client/src/views/PropertyFinance.jsx` composes:

- `PropertyHeader` — name, year selector (buttons per year, live year marked),
  summary stat cards.
- `YearComparisonCards` — net/txn-count/unreconciled-count per year, click to
  switch the active year.
- `MonthlyPnL`, `CategoryBreakdown` — computed client-side from the active
  year's transactions (`propertyFinanceUtils.js`).
- `TransactionLedger` — filterable (category, source, reconciled state,
  allocation) table with inline category editing (select), inline allocation
  editing (rental % select), a reconcile toggle, and an exclude action.
  Uncertain matches (`needs_review` or confidence < 50%) get an amber
  highlight + "uncertain" badge; clicking a row expands memo/match-explanation
  detail.
- `ReconciliationQueue` — live-year Plaid suggestions with an "Apply to ledger"
  action, plus unresolved import review-queue rows.
- `AllocationPanel` — rental/personal/mixed dollar totals plus logged
  rental/personal days from `pf_usage_periods`.
- `AuditDetail` — recent `pf_audit_log` entries.

Switching years re-fetches that year's transactions/usage/audit data; other
years' summaries are fetched once and cached client-side for the comparison
cards, so year switching feels instant after the first load.

## Where to extend

- **A second property**: `pf_properties` and every other table are already
  `property_id`-scoped. Add a property (`POST /api/property-finance/properties`)
  and the same UI works — `PropertyFinance.jsx` currently just picks
  `properties[0]`; add a property switcher alongside the year selector to support
  more than one.
- **Live Plaid wiring**: replace `fixtures/samplePlaidTransactions.js` in
  `routes.js`'s `/plaid-preview` and `/plaid-preview/apply` handlers with a real
  `plaidClient.transactionsSync()` call scoped to the rental property's linked
  account (the app already has a working Plaid client and cursor-based sync
  pattern in `server/index.js`/`server/db.js` for the main dashboard — reuse
  `getCursor`/`saveCursor` per a new `pf_transaction_sources.plaid_account_id`).
- **Category rules**: `pf_category_mappings` already accumulates from manual
  edits. To add static keyword rules, extend `KEYWORD_RULES` in
  `server/property/categories.js`. To add amount/date-based rules (e.g. "always
  $X on the 1st = mortgage"), extend `matching.js#findBestHistoryMatch`.
- **Allocation rules UI**: `pf_allocation_rules` exists in the schema for
  reusable rental/personal split templates (e.g. "furniture purchases are always
  100% rental") but isn't yet surfaced in the UI — currently allocation is set
  per-transaction only.
- **Seed data**: `server/property/seed.js#seedPropertyFinanceData()` is called
  from `POST /api/property-finance/seed` (the empty-state "Seed demo property
  data" button). Re-running it is safe — transactions upsert by deterministic id.
