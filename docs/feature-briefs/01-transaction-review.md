# Brief 01 — Transaction Review Workflow

**Goal:** Newly arrived transactions (Plaid sync or CSV/XLSX import) are "unreviewed"
until the user approves them. Unreviewed rows render with a distinct background color
in the Transactions view, with per-row and bulk approve actions.

**Interpretation note:** the original request was "…so I can review. Possibly another
color of row until approved." If the user meant something narrower (e.g. only imported
rows need review), the design below still works — the scoping happens at insert time.

## Design decisions (already made — do not revisit)

1. **New column `reviewed_at TIMESTAMPTZ NULL`** on `transactions`. NULL = unreviewed.
   Do **NOT** reuse the existing `status` column — it mirrors Plaid's pending/posted
   state (`'pending' | 'reviewed'`, see `server/db.js:620`) and is overwritten on
   every sync upsert.
2. **Backfill once:** all rows existing at migration time get `reviewed_at = NOW()`,
   so only transactions arriving *after* this feature ships need review.
3. Approving is idempotent and reversible (an unreview endpoint exists but no UI for
   it is required in v1).

## Server changes (`server/db.js`, `server/index.js`)

### Migration (in `initDb()`, `server/db.js`)

Follow the existing idempotent pattern (see `hidden` at `server/db.js:196`), but the
backfill must run **only when the column is first created** — `initDb()` runs on every
startup. Guard it:

```js
const revCol = await pool.query(
  `SELECT 1 FROM information_schema.columns
   WHERE table_name = 'transactions' AND column_name = 'reviewed_at'`);
if (revCol.rowCount === 0) {
  await pool.query(`ALTER TABLE transactions ADD COLUMN reviewed_at TIMESTAMPTZ`);
  await pool.query(`UPDATE transactions SET reviewed_at = NOW()`); // backfill existing rows
}
```

### Insert paths — new rows arrive unreviewed

Leave `reviewed_at` untouched (NULL) on INSERT in all four writers:

- `upsertTransactions` (`server/db.js:615`)
- `upsertPlaidTransactions` (`server/db.js:688`)
- `upsertCsvTransaction` (`server/db.js:1284`)
- `upsertImportedTransaction` (`server/db.js:1454`)

**Critical:** the `ON CONFLICT (id) DO UPDATE SET …` clauses (e.g. `db.js:625`,
`db.js:720`) must **not** set `reviewed_at` — a Plaid pending→posted update or re-sync
must not reset a user's approval. No change needed there (omitting the column is
enough); just don't add it.

One nuance: when a pending transaction posts, Plaid issues a *new* transaction id and
the old pending row is deleted (`pending_transaction_id` reconciliation). If the user
already reviewed the pending row, carry the approval over: in the sync path where
added transactions are upserted, if `t.pending_transaction_id` is set, copy
`reviewed_at` from the old pending row before it is deleted. If this is hard to wire
in, skip it and note the limitation — it only causes an occasional re-review prompt.

### Read path

`getTransactions` (`server/db.js:631`) — add `reviewed_at` (and a computed
`reviewed_at IS NOT NULL AS reviewed` if convenient) to the SELECT list so the client
receives it.

### Endpoints (`server/index.js`, behind `requireAuth` like the other transaction routes)

- `POST /api/transactions/review` — body `{ ids: string[] }`, sets
  `reviewed_at = NOW() WHERE id = ANY($1) AND reviewed_at IS NULL`. Returns
  `{ reviewed: <count> }`. Cap ids at ~1000 per call.
- `POST /api/transactions/:id/unreview` — sets `reviewed_at = NULL`. (API only, no UI.)

## Client changes (`client/src`)

- `api.js`: add `reviewTransactions(ids)` calling the bulk endpoint.
- `views/Transactions.jsx`:
  - Row styling: when `!t.reviewed_at`, give the `<tr>` a tinted background —
    use an amber/accent tint consistent with the dark theme's CSS variables, e.g.
    `background: "rgba(251, 191, 36, 0.08)"` plus a 2px left border in the same hue.
    Keep existing conditional styling (pending badge, category colors) working.
  - Add an **"Unreviewed (N)"** filter chip next to the existing filters that narrows
    the memoized row list to `!reviewed_at`; N is the count within current filters.
  - Per-row: a small ✓ "Approve" button (only on unreviewed rows) → calls
    `reviewTransactions([id])`, optimistically sets `reviewed_at` locally.
  - Bulk: when the Unreviewed filter is active, show an "Approve all shown (N)"
    button → sends all visible unreviewed ids in one call.
- Optional (nice-to-have, skip if time-constrained): unreviewed count dot on the
  Transactions item in `components/Sidebar.jsx`, mirroring the existing audit-overdue
  indicator pattern.

## Out of scope

- No approval workflow states beyond reviewed/unreviewed (no reject).
- Do not touch the Plaid `status` column, dedup logic, or `transactionMatching.js`.

## Acceptance criteria

1. After migration, `SELECT COUNT(*) FROM transactions WHERE reviewed_at IS NULL` = 0
   on an existing database; server restarts do not re-run the backfill (verify: set
   one row to NULL, restart, it stays NULL).
2. A newly synced or imported transaction appears with the tinted row and is counted
   in the Unreviewed chip.
3. Approving (single and bulk) clears the tint without a full page reload; re-running
   `POST /api/sync` does not un-approve anything.
4. `node --test "test/**/*.test.js"` in `server/` still passes; add a small test if a
   pure function is factored out, otherwise verify via the running app.
