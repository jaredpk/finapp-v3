# Brief 05 — Benefits API contract (phase 2)

Fixed up front so the server and client can be built against the same shape.
Anything not written here is an implementation detail; anything written here is
a promise. All routes sit under `requireAuth` except `GET /api/benefits/status`
and `POST /api/alerts/run`, which use `requireApiKeyOrAuth`.

## Status

`GET /api/benefits/status?as_of=YYYY-MM-DD` (`as_of` optional, defaults today)

This route is READ-ONLY: it writes nothing, to any table. Everything automatic —
matched charges, matched credits, which credit settles which charge, the period
totals — is derived from `transactions` + the match rules on each read and
thrown away again (`server/benefits/derive.js`). The only usage this app stores
is the owner's own manual mark. An earlier design ran a full match-and-record
sync inside every GET; two concurrent reads raced each other over the rows they
were both rewriting, and the stored state drifted from the truth as rules,
transactions and periods changed. Callers may issue this request as often as
they like, concurrently, in any order.

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
      "unit": "usd",
      "period": { "unit": "month", "count": 1, "basis": "calendar" },
      "cycle_anchor": null,
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
`unit` ∈ `usd | points | visits | count`
`status` ∈ `available | partially-used | used-unconfirmed | used | insufficient-history | rule-error | manual-only | no-anchor`
`confidence` ∈ `confirmed | unconfirmed | manual | none`

## Units

`unit` is what `amount_limit`, `amount_used` and `amount_remaining` are
DENOMINATED in. It is not a display flag: it decides how usage is measured.

- `usd` — the default and the original behaviour. `amount_used` is the SUM of
  the matched transaction amounts (charges plus the residue of any credit no
  charge accounts for).
- `visits`, `count` — `amount_used` is the COUNT of matching transactions, one
  unit each, NOT the sum of their amounts: three matching charges against a
  10-visit allowance are `3` of `10`, not `$3`. Only charges are counted; a
  posted credit is the same event as the charge it settles, so counting it too
  would record one visit twice, exactly as summing both would double-count one
  dollar. `confidence: "confirmed"` means every counted unit's charge has a
  posted credit behind it.
- `points` — usage CANNOT be derived. A transaction amount is denominated in
  dollars, and folding dollars into a points allowance is a category error, not
  an approximation: $250 of spend is not 250 points, and this app holds no rate
  to convert it with. A points benefit's `amount_used` comes from the owner's
  manual mark alone. Matched transactions are still listed in `matches` as
  evidence, but they contribute nothing to `amount_used`, and with no manual
  mark the benefit reports `manual-only` however many match rules it carries.

An unrecognised unit is read as `usd`, so a row written before this field
existed behaves exactly as it always did.

## Cycle anchor

`cycle_anchor` is the benefit's OWN reset date, and it is what an
`anniversary`-basis period counts from: the base is
`benefit.cycle_anchor ?? card.anniversary_date`. Real catalogs need it — a
Venture X credit that renews December 17 whatever day the account was opened, a
Platinum Sky Club allowance running February through January — and the card's
anniversary is only the fallback for the benefits that genuinely follow it.
`null` means "follow the card".

The period key embeds the window START (`anniv:year:1:2025-12-17`), so two
anchors are two key spaces — correctly, because they are two different windows.
The consequence worth knowing: changing an anchor abandons the current period's
`cb_alerts` and `cb_manual_marks` rows under the old key. They are still there
and still valid for a window that will not be evaluated again, which is harmless
— it is the same property that stops a re-shaped period from inheriting the old
period's marks — but an alert already sent for the old window can fire once more
under the new one.

`no-anchor` is returned when the basis is `anniversary` and there is no base at
all: no `cycle_anchor` on the benefit and no `anniversary_date` on the card.
There is no line to count cardmember years from, so the resolved
`period_start` / `period_end` / `period_key` are a CALENDAR fallback — a window
this app invented so there is still a key to mark against — and every figure was
measured inside it. It is therefore never `available`: claiming a credit is
unused over a window the owner never defined is the same confidently-wrong
answer `insufficient-history` exists to prevent. The client renders it as its
own state naming the missing field, and it is never chased with an expiry nudge.

`insufficient-history` is returned whenever `period_start` precedes the card's
`history_start`. `rule-error` is returned whenever the benefit could not be
evaluated, for either of two reasons, and carries `rule_error`, a
human-readable explanation (`null` otherwise):

- one of the benefit's match rules failed to compile — an owner-entered regex
  that no longer parses, typically — in which case `rule_error` is
  `rule <id>: <parse error>`, naming the rule to go fix;
- a rule matches more transactions in the evaluation window than the
  credit-to-charge pairing pass will hold (`PAIRING_ROW_LIMIT` in
  `server/benefits/derive.js`), in which case `rule_error` says so and asks for
  the rule to be narrowed. Pairing over a subset of the candidates would
  misclassify standalone-vs-paired credits, which inflates `amount_used` and
  suppresses an expiry alert, so the cap announces itself rather than degrading.

The client must render these statuses as their own state, never as "available":
claiming a benefit is unused over a window we cannot see, or one we never
managed to evaluate, is the failure mode this whole field exists to prevent.
Neither is ever chased with an expiry nudge; `rule-error` gets one alert of its
own per period saying a rule is broken.

`confidence: "confirmed"` means EVERY dollar counted in `amount_used` has a
posted statement credit behind it — not merely that some credit exists in the
period. Three $100 charges settled by a single $100 credit are `amount_used`
300 with `confidence: "unconfirmed"`, because $200 of that is still only a
charge waiting on a statement.

`period_key` encodes the period's SHAPE as well as its window
(`cal:month:1:2026-08`, `anniv:year:1:2025-09-14`, `anchor:months_n:48:none`).
`year × 1`, `half × 2`, `quarter × 4` and `month × 12` all resolve to the same
calendar year, and the key is the idempotency key for `cb_manual_marks` and
`cb_alerts` — without the shape in it, changing a benefit's period through
`PATCH /api/benefits/benefits/:id` would silently hand the old marks to the new
window.

`matches` is a bounded sample of the transactions behind `amount_used`, not
necessarily all of them: `matches_truncated` is `true` when a match rule hit
more transactions than the server lists individually. `amount_used` is always
the exact total for the period regardless — it is summed in SQL, never from the
rows that happen to be listed. `matches` may also include a posted statement
credit whose money belongs to an EARLIER period (see the last section): it is
listed as evidence for the period it landed in, but contributes nothing to that
period's `amount_used`.

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
- `POST /api/benefits/benefits` — `{ card_id, name, amount_limit, unit, period_unit, period_count, period_basis, cycle_anchor, carryover, notes, verified_on }`
  `unit` ∈ `usd | points | visits | count`, defaulting to `usd`; an unrecognised
  value is a 400 naming the choices rather than a row that silently reads as
  dollars. `cycle_anchor` is a date or null.
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

`amount` is in the benefit's own `unit` — visits for a lounge allowance, points
for a transfer bonus — not in dollars.

Manual entries carry `source: "manual"`, are never overwritten by automatic
matching, and outrank it: for a period with a manual entry, `amount_used` counts
the manual entry alone. Benefits with no transaction footprint (lounge access,
elite status, anniversary miles) live entirely on this path and report
`manual-only`, and so does every `points` benefit, whose usage cannot be derived
at all (see Units).

So does a benefit whose match rules are all unusable. A rule with no regex, no
amount bounds and no category is skipped rather than obeyed — it would match the
entire statement and mark every benefit used — so it does not count as a rule
when deciding whether a benefit can be evaluated automatically, and a benefit
holding nothing else reports `manual-only` rather than `available`. Reporting
`available` would claim nothing has matched this period yet about a benefit
where nothing ever could, which is what the `insufficient-history` /
`manual-only` distinction exists to prevent. It is NOT `rule-error`: a
half-filled row in the editor is not a broken rule, and `rule_error` stays
`null`. A benefit with one usable rule and one criteria-less one is evaluated
normally on the usable rule.

A posted statement credit is attached to the period of the CHARGE it confirms,
not to the period it landed in — it confirms that charge rather than becoming
usage of the following period. This holds whether or not the two amounts match:
a $50 credit against a $100 charge confirms half of that charge and adds nothing
to the period it posted in. (An earlier design paired only on an equal amount,
so a mismatched credit was filed as fresh usage of its own landing period,
consuming the next period's allowance — the feature's own named failure mode.)

A credit ordinarily follows its charge, but it may also settle a charge dated up
to a few days AFTER it (`PAIR_DATE_SKEW_DAYS` in `server/benefits/derive.js`):
the two dates come from different clocks — a statement date against a post date
— so a one- or two-day inversion is an artefact, not a second use, and refusing
to pair across it double-counts the charge and the credit both. The window is
deliberately only days wide, because a longer reach forward would let a credit
confirm a genuinely later, unrelated charge.

Only the part of a credit that no charge accounts for is recorded as usage of
the period the credit landed in, and it is confirmed by nature: the statement
credit itself is the evidence. That is the one path by which a credit counts as
money, and it is what lets a benefit matched solely on its posted credit still
report an amount.

The charge a credit may settle is looked for across the current period and every
preceding period in scope: everything reaching back into the last 120 days, and
at minimum one whole preceding period however long the period is. Since those
windows tile contiguously, "the window in which period P's credit posts" is
simply the period after P, and is always in scope. The remaining blind spot,
stated as the bound: a credit posting more than 120 days AND more than one full
period after its charge.
