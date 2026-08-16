# Brief 04 — Gemini Spend Guard

**Goal:** Know what Gemini costs and stop it running away. Two features spend the same
`GEMINI_API_KEY` — **Ask AI** (Brief 03, interactive) and the **receipt scanner**
(Brief 01, unattended, 8:10 AM daily) — and only one of them has anybody watching
while it spends. Every completed call is priced and logged; both features check the
month-to-date total before starting.

## Design decisions (already made — do not revisit)

1. **Estimate, not truth.** Cost is token counts × a rate table hard-coded in
   `server/geminiUsage.js`, verified against Google's published pricing on
   2026-08-16. Google moves those numbers and nothing here notices.
   **Cloud Billing is authoritative**; where the two disagree, Cloud Billing is
   right. This exists to catch a runaway bill, not to be an invoice — the card
   says so in as many words.
2. **Every ambiguity rounds UP.** An unknown model is priced at the highest rate the
   table knows; an unpublished cached-input rate bills at the full input rate; a
   junk env number falls back to the default rather than to `NaN` (every comparison
   against `NaN` is false, which would switch the guard off silently).
   Under-reporting is the one direction a budget guard must not be wrong in.
3. **The guard FAILS OPEN.** If the `gemini_usage` read throws, callers get a
   permissive status flagged `unknown` and a warning line, and the call proceeds.
   Ask AI and the nightly scan both worked before this module existed and must keep
   working when its storage doesn't: "unprotected but working" beats "protected but
   broken", and the Cloud Billing budget alert is the backstop that still holds
   while we're blind.
4. **The two callers are cut off differently.** The scanner stops dead at 100%
   because nobody is watching it; Ask AI runs on to `GEMINI_ASK_CEILING_PCT`
   because someone typed the question and is waiting on the answer. When money
   runs short, the request a human is waiting on wins.
5. **UTC months**, matching the reports (`TO_CHAR(date, 'YYYY-MM')`). The budget
   resets on the UTC first, whatever the machine or the browser thinks the date is.

## Data model

`gemini_usage` (`server/db.js`, created in `initDb`) — append-only, one row per
completed call:

```
id, created_at, feature ('ask_ai' | 'receipt_scan'), model,
prompt_tokens, output_tokens, cached_tokens, total_tokens,
estimated_cost_usd NUMERIC(12,6),   -- frozen at insert time
priced ('exact' | 'fallback')       -- was the model in the rate table?
```

The dollar figure is **frozen into the row**, not recomputed later: the rate table
moves, and a month already billed must not re-price itself. `priced` is what lets a
month say how much of itself it actually knows. `gemini_usage_created_at_idx` is not
optional — the month-to-date `SUM` runs before every gated call and this is the one
table here that grows without bound.

## Thresholds and env vars

| Var | Default | What it does |
| --- | --- | --- |
| `GEMINI_MONTHLY_BUDGET_USD` | `10` | The monthly ceiling, in dollars. |
| `GEMINI_ASK_CEILING_PCT` | `150` | How far **Ask AI** may run past it, as a percent of the budget (not dollars). |

Warn at **80%** (`WARN_PCT`, card turns amber, gated callers log a line), scanner
**stops at 100%** (throws; the route turns it into the message the UI shows), Ask AI
**503s at the ceiling** (the check is `pct >= ASK_HARD_CEILING_PCT`, so 150.00% itself
refuses). Both vars are read **once at import** into module-level
constants, so changing either takes a process restart — see `server/.env.example`;
`fly secrets set` restarts anyway, local edits don't.

## Surfaces

- `server/geminiUsage.js` — pricing, thresholds, `getBudgetStatus` (silent, for the
  card), `checkGeminiBudget` (logs, fails open, for callers about to spend) and
  `recordGeminiCall` (swallows its own failures: a bookkeeping row must never fail
  the answer the user is waiting on). The pure half takes `now` and `getSpend`
  injected, so the math is tested without a clock or a database.
- `GET /api/gemini-usage` — the card's data: the same snapshot the guard gates on,
  plus a per-feature breakdown. Read-only, so it calls `getBudgetStatus`; refreshing
  a card must not write a warning line.
- **Settings → AI Usage card** — spend vs. budget, percent used, per-feature split,
  total calls, and the two states worth reading: unpriced calls, and the guard
  itself failing open.
- Ask AI records **once per question** (the loop's round-trips are summed, including
  the ones a mid-loop throw ends — the error carries the running total up to the
  route); the receipt scanner records **per call**, inside `extractReceipt`.

## Known limitations

- **`top_merchants` is unfiltered.** `get_report_summary`'s `category` filter
  narrows the monthly and total figures but not the merchant list — a split
  transaction belongs to several categories at once, so there is no honest
  per-category merchant total. The tool description says so out loud.
- **Unknown models are guessed high.** Anything not in `PRICING` — a newer release,
  a typo in `ASK_AI_MODEL`/`RECEIPT_MODEL` — is billed at the highest known rate and
  marked `fallback`, so the total over-states and the card says how many calls that
  covers. Zero would be the intuitive default and the dangerous one.
- **The prices are point-in-time.** `gemini-3.7-flash` ships at introductory rates
  that rise on **2027-01-01 UTC**: input and output exactly double (0.75 → 1.50,
  3.75 → 7.50), but **cached input goes 0.075 → 1.50, a 20× jump**, because the
  standard tier publishes no cached rate and `withCachedRate` falls back to the
  full input rate. Don't summarise the switch as "doubles". It is a function of the call's
  timestamp, not a note to edit the file in January. Everything else in the table
  goes stale silently; re-verify against Google's pricing page when a number matters.

## Acceptance criteria

1. A question and a scan each write rows; the card's total matches
   `SUM(estimated_cost_usd)` for the UTC month and the guard's own number.
2. Past 100% the scanner refuses with a message naming the var; Ask AI keeps
   answering until `GEMINI_ASK_CEILING_PCT`, then 503s.
3. With `gemini_usage` unreadable, both features still work and the card says the
   guard is off.
4. `cd server && node --test "test/**/*.test.js"` passes.
