# Brief 05 — Benefits API contract (phase 2)

Fixed up front so the server and client can be built against the same shape.
Anything not written here is an implementation detail; anything written here is
a promise. All routes sit under `requireAuth` except `GET /api/benefits/status`
and `POST /api/alerts/run`, which use `requireApiKeyOrAuth`.

## Status

`GET /api/benefits/status?as_of=YYYY-MM-DD` (`as_of` optional, defaults today)

```json
{
  "as_of": "2026-08-23",
  "cards": [{
    "id": 1,
    "nickname": "Amex Platinum",
    "issuer": "American Express",
    "product": "Platinum",
    "account_id": "plaid-account-id-or-null",
    "anniversary_date": "2019-09-14",
    "annual_fee": 895,
    "history_start": "2024-01-03",
    "benefits": [{
      "id": 10,
      "name": "Uber Cash",
      "amount_limit": 15,
      "period": { "unit": "month", "count": 1, "basis": "calendar" },
      "carryover": false,
      "verified_on": "2026-08-23",
      "notes": "",
      "period_key": "cal:month:1:2026-08",
      "period_start": "2026-08-01",
      "period_end": "2026-08-31",
      "days_left": 8,
      "amount_used": 4.12,
      "amount_remaining": 10.88,
      "status": "partially-used",
      "confidence": "unconfirmed",
      "rule_error": null,
      "matches_truncated": false,
      "matches": [{
        "txn_id": "abc", "date": "2026-08-04", "merchant": "UBER *TRIP",
        "amount": 4.12, "source": "auto"
      }]
    }]
  }]
}
```

`period.unit` ∈ `month | quarter | half | year | months_n`
`period.basis` ∈ `calendar | anniversary`
`status` ∈ `available | partially-used | used-unconfirmed | used | insufficient-history | rule-error | manual-only`
`confidence` ∈ `confirmed | unconfirmed | manual | none`

`insufficient-history` is returned whenever `period_start` precedes the card's
`history_start`. `rule-error` is returned whenever one of the benefit's match
rules failed to run during the evaluation — an owner-entered regex that no
longer parses, typically — and it carries `rule_error`, a human-readable
`rule <id>: <parse error>` naming the rule to fix (`null` otherwise). The client
must render both as their own state, never as "available": claiming a benefit is
unused over a window we cannot see, or one we never managed to evaluate, is the
failure mode this whole field exists to prevent. Neither is ever chased with an
expiry nudge; `rule-error` gets one alert of its own per period saying a rule is
broken.

`period_key` encodes the period's SHAPE as well as its window
(`cal:month:1:2026-08`, `anniv:year:1:2025-09-14`, `anchor:months_n:48:none`).
`year × 1`, `half × 2`, `quarter × 4` and `month × 12` all resolve to the same
calendar year, and the key is the idempotency key for `cb_usage` and `cb_alerts`
— without the shape in it, changing a benefit's period through
`PATCH /api/benefits/benefits/:id` would silently hand the old usage rows to the
new window.

`matches` is a bounded sample of the transactions behind `amount_used`, not
necessarily all of them: `matches_truncated` is `true` when a match rule hit
more transactions than the server records individually. `amount_used` is always
the exact total for the period regardless — it is summed in SQL, never from the
rows that happen to be listed.

`carryover` is stored, returned and rendered, but NOTHING applies it yet: every
period is evaluated against the full `amount_limit` whatever the previous period
left unspent. It is captured for a later phase, and the catalog editor labels the
control as not yet applied.

A manual mark is authoritative for its period: automatic matches in a period that
also has a manual entry are still recorded and still listed in `matches`, but
they do not add to `amount_used`, and `confidence` stays `manual`.

## Catalog CRUD

- `POST /api/benefits/cards` — `{ nickname, issuer, product, account_id, anniversary_date, annual_fee }`
- `PATCH /api/benefits/cards/:id` — same fields, all optional
- `DELETE /api/benefits/cards/:id` — cascades to its benefits
- `POST /api/benefits/benefits` — `{ card_id, name, amount_limit, period_unit, period_count, period_basis, carryover, notes, verified_on }`
- `PATCH /api/benefits/benefits/:id` — same fields, all optional
- `DELETE /api/benefits/benefits/:id`
- `GET /api/benefits/catalog` — the raw catalog with match rules, for the editor

## Match rules

- `POST /api/benefits/rules` — `{ benefit_id, merchant_regex, amount_min, amount_max, category, direction }`
  `direction` ∈ `charge | credit` — a qualifying charge vs. a posted statement credit
  `merchant_regex` is validated when the rule is SAVED, exactly as the tester
  validates it: an invalid pattern is a 400 carrying the Postgres parse error,
  never a rule that quietly stops matching later.
- `DELETE /api/benefits/rules/:id`

## Match-rule tester

`POST /api/benefits/match-test`
`{ account_id, merchant_regex, amount_min, amount_max, category, start_date, end_date }`

```json
{ "count": 12, "truncated": false, "sample": [
  { "id": "abc", "date": "2026-08-04", "merchant": "UBER *TRIP", "amount": 4.12, "account": "..." }
] }
```

`sample` is capped (see `server/limits.js` — a cap that lies about being
complete is the bug that module exists to prevent, so `truncated` is
mandatory). The regex is applied in Postgres against merchant, name and
original_description; an invalid regex is a 400 with the parse error, never a
500.

## Manual usage

- `POST /api/benefits/:id/mark-used` — `{ period_key, amount, note }`
- `POST /api/benefits/:id/unmark` — `{ period_key }`

Manual entries carry `source: "manual"`, are never overwritten by automatic
matching, and outrank it: for a period with a manual entry, `amount_used` counts
the manual entry alone. Benefits with no transaction footprint (lounge access,
elite status, anniversary miles) live entirely on this path and report
`manual-only`.

A posted statement credit is attached to the period of the CHARGE it confirms,
not to the period it landed in — it sets `confirmed_at` on that charge's usage
row rather than becoming usage of the following period. Only a credit with no
charge to confirm is recorded under its own period.
