# Brief 05 — Derive-on-read rebuild of benefit usage

Decided after the stored-usage model failed two build/verify rounds. The two
HIGH defects (a confirmed charge dropped from the total; the annual lookback
never reaching the prior period) plus the orphan-rollup, stale-row,
overlapping-rule and legacy-row findings all share one root cause: the model
**persisted derived state and then had to keep it consistent** as rules,
transactions and periods changed.

## The cut

Auto-matched usage is a pure function of (transactions, match rules, period
spec, as-of date). So is credit-to-charge pairing. Neither is persisted.

A persisted pairing would reference Plaid transaction ids that sync can remove
or replace — a fourth flavour of the same drift disease. Pairing is safe to
derive because the algorithm is deterministic over a total order (date, id):
the same inputs always produce the same pairing. New backfill data may re-pair,
but nothing persisted depends on the pairing, so a re-pair is just a better
answer — and `cb_alerts` is keyed per (benefit, period, tier), so it cannot
double-fire.

Note the old design already ran the full sync inside every
`GET /api/benefits/status`. Reads already paid full recomputation **plus**
hundreds of writes, and two concurrent reads raced each other. Deriving on read
is strictly cheaper and makes GET genuinely read-only.

## Persists

- `cb_cards`, `cb_benefits`, `cb_match_rules` — unchanged.
- `cb_alerts` — unchanged. A genuine side-effect record; key format unchanged
  so existing rows stay valid.
- `cb_manual_marks` — NEW, replaces the manual half of `cb_usage`:

```sql
CREATE TABLE IF NOT EXISTS cb_manual_marks (
  id SERIAL PRIMARY KEY,
  benefit_id INTEGER NOT NULL REFERENCES cb_benefits(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (benefit_id, period_key)
);
```

Plain UNIQUE — no txn_id column, so no partial index. Mark-used is
`INSERT … ON CONFLICT (benefit_id, period_key) DO UPDATE`.

## Derives

Matched charges and credits per period, pairing, rollup totals, confirmation
state, status, confidence. **`cb_usage` is dropped entirely** — no rollup rows,
no `confirmed_at`, no `confirmed_txn_id`.

## Migration

In `schema.js`, conditional JS:

```js
const { rows } = await pool.query(`SELECT to_regclass('public.cb_usage') AS t`);
if (rows[0].t) {
  await pool.query(`
    INSERT INTO cb_manual_marks (benefit_id, period_key, amount, note, created_at)
    SELECT benefit_id, period_key, amount, note, created_at FROM cb_usage
    WHERE source = 'manual' AND txn_id IS NULL
    ON CONFLICT (benefit_id, period_key) DO NOTHING`);
  await pool.query(`DROP TABLE cb_usage`);
}
```

Auto rows are dropped with no migration — by definition reproducible from
`transactions` + rules. This also fixes the legacy-row finding for free: the
pre-fix confirmed-credit rows that blocked healing simply cease to exist.

## Lookback shape

Replace "periods reaching into the last 120 days" with: **current period + all
preceding periods whose end falls within 120 days + at minimum one preceding
period regardless of length.** Implement as
`recentPeriods(spec, today, lookbackDays, { minPrevious = 1 })`.

Monthly is unchanged (4–5 periods). Annual and 4-yearly now always have the
previous period in scope, so a December charge is visible when its January
credit is attributed — in month 1 or month 8, on first sync or after a gap,
identically, because no incremental state remains for a gap to corrupt.

`CREDIT_GRACE_DAYS` disappears: scope periods tile contiguously, so "the window
after period P where P's credit posts" IS the next period, already in scope.
Remaining blind spot, documented as the bound: a credit posting more than 120
days AND more than one full period after its charge.

`months_n` benefits do not use `recentPeriods` — their scan window is the
trailing `len` months ending today, anchor derived as max(matched txn date,
manual-mark date in window), then `resolveAnchored` as today.

## SQL shape

Windows computed in JS (dozens of tuples), shipped as arrays. **Two transaction
scans total**, sharing one CTE.

```sql
WITH w AS (
  SELECT * FROM unnest($1::int[], $2::text[], $3::date[], $4::date[])
       AS w(benefit_id, period_key, start_date, end_date)
),
m AS (
  SELECT DISTINCT w.benefit_id, w.period_key, t.id AS txn_id,
         TO_CHAR(t.date,'YYYY-MM-DD') AS date, t.merchant,
         ABS(t.amount)::float AS amount, (t.amount < 0) AS is_credit
  FROM w
  JOIN cb_benefits b    ON b.id = w.benefit_id
  JOIN cb_cards c       ON c.id = b.card_id AND c.account_id IS NOT NULL
  JOIN cb_match_rules r ON r.benefit_id = b.id AND NOT (r.id = ANY($5::int[]))
  JOIN transactions t
    ON t.account = c.account_id
   AND t.date >= w.start_date AND t.date <= w.end_date
   AND t.status != 'pending' AND (t.hidden IS NOT TRUE)
   AND t.account NOT IN (SELECT account_id FROM hidden_accounts)
   AND ((r.direction = 'charge' AND t.amount > 0) OR (r.direction = 'credit' AND t.amount < 0))
   AND (r.merchant_regex IS NULL OR COALESCE(t.merchant,'') ~* r.merchant_regex
        OR COALESCE(t.name,'') ~* r.merchant_regex
        OR COALESCE(t.original_description,'') ~* r.merchant_regex)
   AND (r.amount_min IS NULL OR ABS(t.amount) >= r.amount_min)
   AND (r.amount_max IS NULL OR ABS(t.amount) <= r.amount_max)
   AND (r.category IS NULL OR t.plaid_category = r.category OR t.primary_category = r.category)
)
```

`$5` is the broken-rule exclusion list. **`SELECT DISTINCT … t.id` is the
overlapping-rule fix**: a transaction matched by both `DOORDASH` and `DOOR`
appears once per (benefit, period), structurally. No per-rule accumulation
remains to double-count, and `excludeTxnIds` bookkeeping disappears.

**Q-aggregate** — exact money, unbounded, materialises nothing (same house
pattern as `getSpendingByCategory`):

```sql
SELECT benefit_id, period_key, is_credit,
       SUM(amount)::float AS total, COUNT(*)::int AS count, MAX(date) AS last_date
FROM m GROUP BY 1, 2, 3
```

**Q-rows** — bounded candidates for pairing and display:

```sql
SELECT * FROM (
  SELECT m.*, ROW_NUMBER() OVER (PARTITION BY benefit_id, is_credit
                                 ORDER BY date DESC, txn_id DESC) AS rn
  FROM m
) x WHERE rn <= $6 + 1
```

`PAIRING_ROW_LIMIT = 2000` per (benefit, direction). If either partition
overflows, report that benefit as `rule-error` ("rule matches more than N
transactions in the evaluation window; narrow the rule"). An overflow makes
standalone-vs-paired classification unreliable, and unreliable classification
can inflate `amount_used` and suppress an alert — so it announces itself rather
than degrading (limits.js doctrine).

**`amount_used` never depends on Q-rows** — always Q-aggregate. The rollup
concept survives as arithmetic (`total − sampled`) with no stored row to orphan.

Per status read: 3 (catalog) + 1 (history) + 1 (Q-aggregate) + 1 (Q-rows) +
1 (manual marks) = **7 queries**, plus one cheap regex compile check per
distinct saved pattern. Versus ~400–33,000 before. Compile checks stay separate
so a 2201B names the offending rule instead of killing the whole read.

Optional: `CREATE INDEX IF NOT EXISTS transactions_account_date_idx ON
transactions (account, date)` — every scan here is account+date bounded.

## Pairing algorithm (pure, in `derive.js`)

Inputs per benefit: matched charge rows and credit rows in scope, each
`{txn_id, date, amount, period_key}`, sorted by (date, id).

1. **Exact pass** — for each credit ascending: pick the latest charge with
   date ≤ credit date, `|charge.amount − credit.amount| ≤ 0.02`, not yet
   confirmed. `charge.confirmed += credit.amount`; credit consumed.
2. **Partial/aggregate pass** — for each remaining credit ascending: walk
   charges newest-first (date ≤ credit date), consuming each charge's remaining
   unconfirmed amount until the credit is exhausted. Handles $50-of-$100 and
   one-$15-credit-for-$4+$11.
3. **Residue** — any credit amount left over is **standalone usage of the
   credit's landing period**, confirmed by nature. The only path by which a
   credit itself counts as money.

Partial pairing is required, not optional: with exact-only pairing a
mismatched credit becomes standalone usage in its landing period, which is the
annual bug reintroduced through the side door.

Deterministic by construction — total order, no clock, no randomness. Add a
defensive dedupe by (benefit_id, txn_id) at derive entry so the invariant is
unit-testable rather than only SQL-enforced.

## Evaluation

Per benefit, current period only:

- Manual mark for the period → `amount_used = mark.amount`,
  `confidence = "manual"`; auto matches still listed as evidence. The disjoint
  table makes clobbering structurally impossible.
- Else `amount_used = round2(charge_total + standalone_credit_total)`. Charges
  and paired credits are **never summed** — a paired credit contributes only to
  `confirmed_total`. This is what makes the confirmed-charge regression
  impossible: there is no per-row confirmed-vs-charging bucket for a stamped
  charge to fall out of, and a charge always carries its amount.
- No usage and no mark: `ruleCount === 0` → `manual-only`; else
  `!historyStart || period.start < historyStart` → `insufficient-history`
  (**the honesty gate, kept verbatim**); else `available`.
- With usage: `fullyUsed = oneShot || amount_used + 0.005 >= limit`.
  `confidence = confirmed` iff `confirmed_total + 0.005 >= amount_used`.
  `status = fullyUsed ? ((manual || all-confirmed) ? "used" : "used-unconfirmed")
  : "partially-used"`.
- `rule-error` on compile failure or row-cap overflow. `alertTiers` unchanged.

## Two intentional semantic changes

Response shape and enums are unchanged, but two behaviours move and
`05-api-contract.md` must be updated:

1. `confidence: "confirmed"` now means **every counted dollar** has a posted
   credit behind it, not merely that some credit exists in the period.
2. An amount-mismatched credit **partially confirms its charge** instead of
   being filed as fresh usage of its own landing period. This overturns the old
   "credit only pairs with same amount" test, whose behaviour consumed the next
   period's allowance — the feature's own named failure mode.

`GET /api/benefits/status` is now write-free; note that in the contract too.

## Module layout

- `periods.js` — **keep all date math verbatim** (`parts`, `iso`, `addMonths`,
  `resolveCalendar`, `resolveAnniversary`, `resolveAnchored`, `calendarKey`,
  `periodMonths`, `toDateString`, `addDaysIso`, `alertTiers`). It is verified
  correct across 9 timezones with no Feb 29 drift. Two changes only:
  `recentPeriods` gains the floor, and `evaluateBenefits` counting is rewritten
  to consume derived stats. **Delete** `isConfirming`, `isRollupRow`,
  `ROLLUP_TXN_PREFIX`, and the `counted = manual : charged : confirming`
  cascade.
- `derive.js` — NEW, pure, no pg/express: window construction, pairing,
  per-benefit stat assembly.
- `repository.js` — keep catalog CRUD, `matchConditions`, `matchTest`,
  `assertValidRegex`, `getHistoryStartByAccount`, alert bookkeeping. Delete
  `listUsage`, `upsertUsage`, `confirmUsage`, `deleteUsage`, `findMatches`,
  `sumMatches`. Add `fetchUsageAggregates`, `fetchMatchRows`,
  `listManualMarks`, `upsertManualMark`, `deleteManualMark`.
- `sync.js` — **deleted**, along with `test/benefitSync.test.js`.
- `routes.js` — re-plumb `getBenefitsStatus`: catalog + history in parallel →
  compile checks → windows → Q-aggregate / Q-rows / manual in parallel →
  derive → evaluate. Manual endpoints target `cb_manual_marks`.
- `server/index.js` alert run needs no change — same output, same `alertTiers`,
  same `cb_alerts`.
- Client — no change; response shape preserved.

## Tradeoffs

Reads get 50–4000× cheaper in query count, because the old design already
recomputed everything per read and wrote it back. Real costs: the two semantic
changes above; rare status flap when backfill re-pairs a credit (bounded,
alert-idempotent, better-informed); and periods older than the current one are
no longer queryable — nothing consumes them today, and a future "benefit
history" view would be a new derived query, not a resurrected `cb_usage`.
