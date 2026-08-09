# FinApp Improvements — Viability Assessment

Date: 2026-08-09. Assessed against the codebase at `claude/finapp-improvements-assess-gvin4d`
(Express + Postgres server in `server/`, React/Vite client in `client/`, single-user,
portal-assertion auth, deployed on fly.io).

Three suggestions were assessed. All three are viable. Each has its own implementation
brief in this directory, written so a lower-tier model (Opus/Sonnet) can implement it
without re-deriving the design.

| # | Suggestion | Viability | Size | Brief |
|---|-----------|-----------|------|-------|
| 1 | Review/approval state for new transactions (different row color until approved) | **High** — small, additive change | S (~½–1 day) | `01-transaction-review.md` |
| 2 | Reports module | **High** — Recharts already installed, aggregation data all in Postgres | M (~1–2 days) | `02-reports-module.md` |
| 3 | Ask AI | **Viable with caveats** — needs an Anthropic API key (real per-query cost) and a production secret | M (~1 day) | `03-ask-ai.md` |

## Recommended order

1 → 2 → 3. Feature 1 is smallest and touches the sync path, so land and verify it first.
Feature 3 depends on a refactor (extracting data-access functions shared with the MCP
tools) that is easier after 2's aggregation endpoint exists (Ask AI can reuse it).

## Feature 1 — Transaction review workflow

The original suggestion (partially garbled in transmission): *"…so I can review.
Possibly another color of row until approved."* Interpreted as: **newly arrived
transactions (Plaid sync or import) enter an "unreviewed" state, are rendered with a
distinct row color in the Transactions view, and stay that way until explicitly
approved.**

Viability is high. The `transactions` table already carries app-state columns
(`hidden`, `audited_at`) and the migration pattern in `initDb()` is idempotent
`ALTER TABLE ADD COLUMN IF NOT EXISTS`, so adding a `reviewed_at` timestamp is
low-risk. One trap: the existing `status` column ('pending' | 'reviewed') mirrors
Plaid's pending/posted state and **must not** be reused for user review — the brief
uses a new column. A one-time backfill marks all existing rows reviewed so the user
isn't greeted with thousands of unreviewed rows.

## Feature 2 — Reports module

Viability is high. All data needed (transactions, categories, assignments, splits,
merchant overrides, hidden flags) lives in Postgres; Recharts ^2.12.7 is already a
client dependency (used in Dashboard.jsx); the Sidebar navigation pattern makes adding
a view mechanical. The real work is **correctness of the aggregates**: reports must
respect hidden transactions, hidden accounts, merchant overrides, and — most
importantly — splits, which override a transaction's single category assignment. The
brief specifies exact aggregation rules mirroring the existing views' logic.

Note: `Budget.jsx` and `CashFlow.jsx` exist as partial scaffolds. The brief scopes
Reports as a new, separate view rather than extending those, to avoid entangling
half-built code.

## Feature 3 — Ask AI

Two paths exist:

- **Zero-code path (available today):** the server already exposes an MCP server
  (`/mcp` and `/sse` endpoints, 13 finance tools). Connecting Claude (claude.ai
  custom connector or Claude Desktop) via the OAuth flow in Settings already gives
  "ask AI about my finances." Worth knowing before building anything.
- **In-app path (the brief):** a `POST /api/ask` endpoint using the Anthropic SDK with
  tool use over **read-only** data-access functions, plus a small chat view in the
  client.

Caveats that make this "viable with caveats" rather than plain "high":

- **Real money.** Requires an `ANTHROPIC_API_KEY`. At the recommended model
  (`claude-opus-5`, $5/M input, $25/M output tokens), a typical question — a few
  tool round-trips, ~10–20K input tokens cumulative, ~1K output — costs roughly
  **$0.05–0.15 per question**. `claude-haiku-4-5` ($1/$5) cuts that ~5× at lower
  answer quality; that tradeoff is the owner's call, not the implementer's.
- **Production config boundary.** Shipping it live requires
  `fly secrets set ANTHROPIC_API_KEY=…`, which is a production config change **and**
  enables metered spend — per CLAUDE.md this needs explicit owner approval before
  deploy. Local dev with a personal key is fine.
- **Safety scope.** The brief restricts the model to read-only tools (no delete,
  import, or categorize-write) so a misfired answer can't mutate data.

## What was NOT done

No application code was changed. This branch contains only these briefs. Verification
of each feature is specified inside each brief (acceptance criteria + how to exercise
locally); the project's builder → verifier loop applies when implementation happens.
