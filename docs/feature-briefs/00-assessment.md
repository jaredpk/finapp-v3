# FinApp Improvements — Viability Assessment

Date: 2026-08-09 (revised same day: features 1 and 3 pivoted to Google Gemini per
owner request). Assessed against the codebase at
`claude/finapp-improvements-assess-gvin4d` (Express + Postgres server in `server/`,
React/Vite client in `client/`, single-user, portal-assertion auth, fly.io).

Three suggestions were assessed. All three are viable. Each has an implementation
brief in this directory written so a lower-tier model (Opus/Sonnet) can implement it
without re-deriving the design.

| # | Suggestion | Viability | Size | Brief |
|---|-----------|-----------|------|-------|
| 1 | Gemini scans Gmail for e-receipts, categorizes from receipt contents; amber row until approved | **Viable** — needs one-time Gmail OAuth setup by owner | M–L (~2–3 days) | `01-transaction-review.md` |
| 2 | Reports module | **High** — Recharts installed, data all in Postgres | M (~1–2 days) | `02-reports-module.md` |
| 3 | Ask AI via Google Gemini | **High** — free API tier suffices for single-user | M (~1 day) | `03-ask-ai.md` |

## The Gemini API / subscription question

The owner asked whether their Google AI Pro subscription includes an API path.
Findings (verified 2026-08-09):

- **Google AI Pro does not bundle Gemini API usage** — the consumer subscription
  covers the Gemini app/Workspace features; the developer API bills separately.
- **The Gemini API's free tier covers this app regardless**: an AI Studio key (no
  card) gets ~10 requests/min and ~250 requests/day on `gemini-2.5-flash` (post
  Dec-2025 quota cuts — re-check before relying on exact numbers). Both features
  together stay well inside that for one user.
- Google grants **Cloud credits to AI Pro/Ultra subscribers** that can be applied to
  Gemini API usage on a billed project.
- **Privacy decision (owner, 2026-08-09): paid tier required for both features.**
  Free-tier requests may be used by Google to improve products, and these requests
  carry email receipt text (feature 1) and transaction data (feature 3). As a matter
  of principle the owner's finances must not be used for training, so the
  `GEMINI_API_KEY` must come from a Google Cloud project **with billing enabled**
  (paid tier ≈ $0.30/M input, $2.50/M output on `gemini-2.5-flash` — cents/month,
  coverable by the AI Pro subscriber Cloud credits).

## Recommended order

**2 → 1 → 3.** Reports (2) has no external dependencies and its aggregation endpoint
becomes a reusable tool for Ask AI. Feature 1 is the largest and needs owner-side
setup (Google Cloud project, Gmail OAuth consent, API key) before it can be
verified end-to-end. Feature 3 rides on the same `GEMINI_API_KEY` and the shared
data-access refactor.

## Feature 1 — Gmail receipt scanner + review workflow

Interpretation of the request (*"use Google Gemini to scan my gmail for electric
receipts and categorize them based on what it finds. An amber row until I approve"*):
a scanner reads e-receipt emails via the Gmail API (read-only scope), Gemini extracts
merchant/date/total/line-items and suggests a category from the app's category list
(structured JSON output), the receipt is matched to an existing transaction by
amount + date window, and that transaction turns **amber until approved** — approval
applies the suggested category.

Viable, and the codebase helps: the `transactions` table already carries app-state
columns and an idempotent migration pattern; `assignments`/`categories` already model
categorization; Settings.jsx already hosts connect/import cards. The risks are
operational, not architectural: one-time Google Cloud/OAuth setup, free-tier rate
limits (the brief throttles and caps batch size), and the match-ambiguity rule (the
brief only auto-matches when exactly one candidate transaction fits — never guesses).
The scanner's write surface is deliberately tiny: receipt-match rows and flipping
`reviewed_at` — it can never alter amounts or delete data.

## Feature 2 — Reports module (unchanged from first assessment)

High viability. All data (transactions, categories, assignments, splits, overrides,
hidden flags) is in Postgres; Recharts ^2.12.7 is already a client dependency; the
Sidebar pattern makes a new view mechanical. The work is correctness of aggregates —
splits override assignments, hidden rows/accounts excluded, merchant overrides
applied — and the brief pins those rules to the existing code's conventions.
`Budget.jsx`/`CashFlow.jsx` are half-built scaffolds and are deliberately not
touched.

## Feature 3 — Ask AI (Gemini)

High viability. A `POST /api/ask` endpoint using `@google/genai` function calling
over **read-only** data functions (shared with the existing MCP tool handlers), plus
a small chat view. Free tier is sufficient; a 429 under bursts is handled as a
"try again in a minute" in the UI. The model can only call query functions — a wrong
answer cannot mutate data.

Also worth knowing: the server's existing MCP endpoints (`/mcp`, `/sse`) already
provide an "ask AI about my finances" path through Claude clients today, with zero
new code.

## What was NOT done

No application code was changed. This branch contains only these briefs.
Verification steps live inside each brief; the project's builder → verifier loop
applies at implementation time. Owner-side prerequisites (Google Cloud project,
Gmail OAuth consent, `GEMINI_API_KEY`, free-vs-paid tier decision) are listed at the
top of brief 01.
