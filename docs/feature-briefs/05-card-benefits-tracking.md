# Brief 05 — Credit Card Benefits Tracking

**Question asked:** can FinApp automatically track usage of the benefits on a
high-annual-fee card (Amex Platinum, Capital One Venture X), surface which
credits have reset (annual / quarterly / monthly), and alert when an unused
credit is about to expire?

**Verdict: viable, and a good fit for this codebase — with one honest caveat.**
The tracking and the UI are straightforward. The *alerting* needs new plumbing,
because this app currently has no scheduler and no outbound message channel.
Roughly **M, ~2–3 days**, comparable to Brief 02 (Reports).

The part that is not automatable is the benefit catalog itself. See
"What cannot be automated" below — plan for it rather than discovering it.

---

## What the codebase already gives us

| Need | Already there |
|---|---|
| Per-card transaction attribution | `transactions.account` holds the Plaid `account_id` for live rows (`server/index.js:1799`); `syncTransactionsCore` (`server/index.js:141`) writes it on every sync |
| Merchant text to match against | `merchant`, `name`, `original_description`, `website`, `plaid_category`, `primary_category` columns on `transactions` (`server/db.js:277–291`) |
| Card identity | `GET /api/accounts` returns `institutionName`, `mask`, `type: "credit"`, plus `account_nicknames` |
| A self-contained module pattern | `server/property/` — own schema file, own routes file, own prefix, mounted from `initDb()` |
| An I/O-free, unit-testable core | `limits.js` / `geminiUsage.js` split their arithmetic out of pg/express precisely so it can be tested without a database (`server/test/limits.test.js`) |
| A "pending until I approve" UX | the receipt-scan amber-row workflow (Brief 01) — reuse the pattern for low-confidence benefit matches |
| An API-key surface for machine callers | `requireApiKeyOrAuth` (used by `/api/transactions`, `/api/reports/summary`) |
| Ask AI extensibility | add one tool declaration in `server/askAi.js:108+` and "how much of my Platinum credits have I used?" answers itself |

Nothing here needs a new external dependency, which matters: production is a
256 MB Fly VM already sitting at ~173 MB RSS (see the note in `server/gmail.js`
about the googleapis monolith that OOMed it).

---

## The two real design problems

### 1. Period math is where the bugs live

Benefit periods are not one shape. At minimum the model needs:

- **Monthly** — resets on calendar month boundaries.
- **Quarterly / semiannual** — some are calendar quarters, some are fixed
  half-year windows (Jan–Jun / Jul–Dec).
- **Annual, calendar basis** — resets Jan 1.
- **Annual, cardmember-year basis** — resets on the account anniversary.
  **This is the single biggest correctness trap.** The Venture X travel credit
  is anniversary-based; several Amex credits are calendar-based. Getting the
  basis wrong silently reports a credit as available when it is spent, or vice
  versa.
- **Multi-year** — Global Entry / TSA PreCheck credits run on a ~4-year cycle
  anchored to *last use*, not to a calendar boundary.

So: `period_unit` (month | quarter | half | year | months_n), `period_basis`
(`calendar` | `anniversary`), `period_count`, plus `card.anniversary_date`.
Build this as a pure function — `evaluateBenefits(catalog, transactions, today)`
in a module with no `pg` and no `express` import — and unit-test the boundary
cases (Dec 31 → Jan 1, Feb 29, anniversary-year rollover, a 48-month cycle whose
anchor predates the transaction history). That mirrors how `limits.js` and
`geminiUsage.js` are already structured.

Also model:
- **Accumulating vs. one-shot.** A monthly ride credit is consumed in pieces
  ($4.12 + $10.88 = used). A hotel credit is effectively one-shot. Track
  `amount_used` against `amount_limit`, not a boolean.
- **Statement-credit lag.** The qualifying charge and the posted credit are two
  different transactions, often a cycle apart. Matching on the *charge* is
  timely but optimistic; matching on the *posted credit* is authoritative but
  lags. Recommendation: match on the charge, mark the benefit
  `used (unconfirmed)`, and promote it to `confirmed` when a matching credit
  posts. Never alert "expiring unused" on a benefit in `used (unconfirmed)`.

### 2. History depth bounds what you may claim

An annual benefit needs ≥12 months of transaction history on that card before
the app can honestly say "you haven't used this yet." The Plaid sync is
cursor-based so history accumulates, but a card linked three months ago has no
basis for an annual claim.

**Rule:** store the earliest synced transaction date per account and refuse to
render "unused" (or fire an alert) for any period that starts before coverage
begins — show `insufficient history` instead. Getting this wrong produces
confidently wrong alerts, which is worse than no feature.

---

## Matching rules

Deterministic rules first; Gemini only as a fallback, and only behind the
existing monthly budget guard (`server/geminiUsage.js`).

A rule is: `account_id` scope + merchant/description regex + optional amount
bounds + optional Plaid-category constraint. Examples of the shape (not the
catalog):

- Venture X travel credit only counts for purchases through the issuer's own
  travel portal — the merchant string is distinctive, and a general airline
  charge must **not** match.
- Amex airline-fee credits only count for the *one* airline selected for that
  year — so the rule needs an owner-set parameter, not just a regex.

Everything ambiguous goes to a review queue (amber, same as receipt matches)
rather than silently counting or silently not counting. Add a manual
**"mark as used"** control, because some benefits never appear as a transaction
at all (lounge access, elite status, insurance coverage, anniversary miles).

---

## Alerting — the part that needs new plumbing

Two gaps, both surmountable:

**No scheduler.** `fly.toml` sets `auto_stop_machines = 'stop'` and
`min_machines_running = 0`, so the VM sleeps. An in-process `setInterval` will
not fire reliably. Options, cheapest first:

1. **GitHub Actions scheduled workflow** hitting a new
   `POST /api/benefits/evaluate` behind `requireApiKeyOrAuth`. `auto_start_machines`
   wakes the VM on the request. `.github/workflows/deploy.yml` already
   demonstrates the secrets pattern. **Recommended.**
2. Keep a machine warm (`min_machines_running = 1`) — costs money, and this VM
   is memory-tight. Not worth it for a daily job.
3. **Compute on page load only** — zero infra, no push. Honestly covers most of
   the value for a single-user app; the "about to expire" nudge is the only
   thing it can't do.

**No outbound message channel.** The Gmail integration is
`gmail.readonly` (`server/gmail.js:15`) — it can read, not send. To email
yourself you either add the `gmail.send` scope and re-consent (small, but a
re-auth), or have the GitHub Action itself send the notification and leave the
server read-only. In-app is free: a Dashboard card plus a sidebar badge.

Suggested tiers: monthly credits nudge ~7 days before month end; quarterly/
semiannual ~21 days; annual ~45 and ~14 days; and a "new period just opened"
note on reset.

---

## What cannot be automated (plan for it)

**The benefit catalog is owner-maintained data, not code.** Issuers change these
lineups — the Platinum's credit set was reworked in 2025 — and the exact
amounts, merchants, and period bases must be entered from your card's current
benefits guide. Do **not** let the catalog be seeded from an LLM's memory of
what these cards offer; that is precisely the kind of confidently-stale data
that makes the alerts untrustworthy. Ship it as a seed file you fill in once,
editable in Settings, with a `verified_on` date per benefit shown in the UI.

Also inherently manual: benefits with no transaction footprint, and any credit
whose eligibility depends on *how* you booked rather than *where* you charged.

---

## Sketch of the work

**Server** — `server/benefits/` (mirroring `server/property/`):
- `schema.js`: `cb_cards` (account_id, issuer, product, anniversary_date,
  annual_fee), `cb_benefits` (card_id, name, amount_limit, period_unit,
  period_basis, period_count, carryover, verified_on, notes),
  `cb_match_rules` (benefit_id, merchant_regex, amount_min/max, category),
  `cb_usage` (benefit_id, period_key, amount_used, status, txn_id, source:
  auto|manual, confirmed_at), `cb_alerts` (benefit_id, period_key, tier,
  sent_at) — `sent_at` makes alerting idempotent so a re-run can't double-fire.
- `periods.js`: the pure period/evaluation math. No pg, no express. Tested.
- `routes.js`: `GET /api/benefits/status`, `POST /api/benefits/:id/mark-used`,
  `POST /api/benefits/evaluate` (`requireApiKeyOrAuth`), catalog CRUD.
- One tool added to `server/askAi.js`.

**Client**:
- `views/Benefits.jsx` + a `{ id: "benefits", label: "Benefits", icon: "◆" }`
  entry in `Sidebar.jsx:4-13` and the switch in `App.jsx`.
- Per-card panel: progress bar per benefit, days left in period, status chip
  (available / partially used / used-unconfirmed / used / insufficient history),
  a "mark used" button, and the amber review queue for ambiguous matches.
- A compact "expiring soon" card on the Dashboard.
- A Settings card for the catalog with the `verified_on` reminder.

**Infra**: `.github/workflows/benefits-check.yml` on a daily cron, calling the
evaluate endpoint with an API key from repo secrets.

**Rough split:** period math + tests ~1 day; schema/routes/matching ~1 day; view
+ Dashboard card ~0.5–1 day; alert delivery ~0.5 day.

---

## Verify before building

1. That both cards are linked through Plaid and syncing (Amex and Capital One
   both go through OAuth; confirm live rows exist for each `account_id`).
2. How far back `transactions` actually goes for each card — this bounds what
   the annual periods can honestly report.
3. Whether posted statement credits appear as their own rows on those two cards,
   and what their descriptions look like. That single observation decides how
   much of the "confirmed" half of the matching design is worth building.
