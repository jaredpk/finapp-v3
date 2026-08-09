# Brief 01 — Gmail Receipt Scanner (Gemini) + Review Workflow

**Goal:** Scan the user's Gmail for e-receipts using **Google Gemini**, match receipts
to transactions, and suggest a category from what the receipt contains. A matched
transaction renders as an **amber row until the user approves** — approving applies
the suggested category and clears the amber state.

This supersedes the earlier Claude-agnostic review brief; the review foundation
(Part A) is unchanged, the receipt scanner (Part B) is new.

## Owner setup required before implementation can be verified

The implementer cannot do these; the owner (jaredpk@gmail.com) must:

1. Create a Google Cloud project; enable the **Gmail API**; configure an OAuth
   consent screen (internal/testing is fine for single-user); create OAuth 2.0
   **Desktop** credentials → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. Get a **Gemini API key** from Google AI Studio → `GEMINI_API_KEY`, minted in a
   Google Cloud project **with billing enabled**.
   - **DECIDED (owner, 2026-08-09): paid tier is required** — receipt emails are
     financial data and must not be used for training; only paid-tier usage carries
     the no-training data terms. Cost is cents/month at this volume, coverable by
     the AI Pro subscriber Cloud credits. A key from an unbilled project silently
     falls under free-tier terms — use the same billed project as Brief 03.
   - Rate limits still apply (paid tier 1 raises them well above the free tier's
     ~10 RPM; the scanner's throttle stays as specified as a safety margin).
3. Run the one-time OAuth authorization flow (Part B, step 1) to mint a refresh
   token.

## Part A — Review state (`reviewed_at`) — foundation

### Design decisions (do not revisit)

1. **New column `reviewed_at TIMESTAMPTZ NULL`** on `transactions`. NULL = unreviewed.
   Do **NOT** reuse the existing `status` column — it mirrors Plaid's pending/posted
   state (`server/db.js:620`) and is overwritten on every sync upsert.
2. **Backfill once:** rows existing at migration time get `reviewed_at = NOW()`.
3. In this Gemini-scanner design, **only transactions the scanner matched to a
   receipt go amber** (arrive with `reviewed_at` backfilled/set for everything else).
   Concretely: normal sync/import inserts set `reviewed_at = NOW()` at insert; the
   scanner *clears* it (sets NULL) on transactions it matched, flagging them for
   review. This keeps the amber state meaning exactly "a receipt-based suggestion is
   waiting for you."

### Migration (in `initDb()`, `server/db.js` — follow the `hidden` pattern at line 196)

`initDb()` runs on every startup, so guard the backfill:

```js
const revCol = await pool.query(
  `SELECT 1 FROM information_schema.columns
   WHERE table_name = 'transactions' AND column_name = 'reviewed_at'`);
if (revCol.rowCount === 0) {
  await pool.query(`ALTER TABLE transactions ADD COLUMN reviewed_at TIMESTAMPTZ`);
  await pool.query(`UPDATE transactions SET reviewed_at = NOW()`);
}
```

Also create the receipt tables (idempotent `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS gmail_tokens (
  id TEXT PRIMARY KEY DEFAULT 'default',
  refresh_token TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS receipt_matches (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  merchant TEXT, receipt_date DATE, total NUMERIC(12,2),
  items JSONB,                    -- [{description, amount}]
  suggested_category_id UUID,     -- FK to categories, nullable
  extracted JSONB,                -- full Gemini output for debugging
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS scanned_gmail_messages (
  gmail_message_id TEXT PRIMARY KEY,
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  matched BOOLEAN DEFAULT FALSE
);
```

### Insert paths

Set `reviewed_at = NOW()` on INSERT in all four writers — `upsertTransactions`
(`db.js:615`), `upsertPlaidTransactions` (`db.js:688`), `upsertCsvTransaction`
(`db.js:1284`), `upsertImportedTransaction` (`db.js:1454`). The
`ON CONFLICT … DO UPDATE` clauses must **not** touch `reviewed_at` (a re-sync or
pending→posted update must not clobber the scanner's flag or an approval).

### Read path & endpoints

- `getTransactions` (`db.js:631`): add `reviewed_at` to the SELECT; LEFT JOIN
  `receipt_matches` and include its fields (merchant, total, items,
  `suggested_category_id`) when present.
- `POST /api/transactions/review` — body `{ ids: string[] }` (cap 1000). For each id:
  set `reviewed_at = NOW()`, and if a `receipt_matches.suggested_category_id` exists
  and the transaction has no assignment yet, upsert the assignment
  (`upsertAssignment`, `db.js:1721`). Returns `{ reviewed, categorized }` counts.
- `POST /api/transactions/:id/unreview` — sets `reviewed_at = NULL` (API only).
- Behind `requireAuth`, like sibling routes.

## Part B — Gmail scan + Gemini extraction

### Dependencies

```
cd server && npm install googleapis @google/genai
```

### 1. One-time Gmail OAuth (new small module `server/gmail.js`)

- `GET /api/gmail/auth-url` (requireAuth) → returns the Google OAuth consent URL
  (scope: `https://www.googleapis.com/auth/gmail.readonly`, `access_type: offline`,
  `prompt: consent`, redirect `urn:ietf:wg:oauth:2.0:oob`-style manual copy or a
  localhost redirect — manual code paste is fine for single-user v1).
- `POST /api/gmail/auth-code` (requireAuth) — body `{ code }`, exchanges for tokens,
  stores `refresh_token` in `gmail_tokens`.
- `GET /api/gmail/status` → `{ connected: boolean }`.
- Settings view gets a "Connect Gmail" card using these three (follow the existing
  Settings.jsx card patterns).

### 2. Scanner (`server/receiptScan.js`), triggered by `POST /api/receipts/scan`

Also add an opt-in daily run next to the existing 8 AM safety-net sync in
`server/index.js` — but **only if** `gmail_tokens` has a row.

Pipeline per run:

1. Gmail search (`users.messages.list`), query:
   `("receipt" OR "order confirmation" OR "invoice" OR "your purchase") newer_than:35d -category:promotions`
   — page through, skip ids already in `scanned_gmail_messages`. Cap 40 new
   messages/run (free-tier RPD headroom).
2. Fetch each message (`format: full`), extract text: prefer `text/plain` part, else
   strip HTML from `text/html` (a ~30-line tag-strip util is fine; no new dependency).
   Truncate to ~15k chars.
3. **Gemini extraction** — one call per email, `gemini-2.5-flash` (env
   `RECEIPT_MODEL` to override), structured output:

```js
import { GoogleGenAI, Type } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const res = await ai.models.generateContent({
  model: process.env.RECEIPT_MODEL || "gemini-2.5-flash",
  contents:
    `Categories: ${categoryNames.join(", ")}\n` +
    `If this email is a purchase receipt, extract it. If not, return is_receipt=false.\n\n` +
    emailText,
  config: {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        is_receipt: { type: Type.BOOLEAN },
        merchant:   { type: Type.STRING },
        date:       { type: Type.STRING, description: "YYYY-MM-DD" },
        total:      { type: Type.NUMBER },
        items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
          description: { type: Type.STRING }, amount: { type: Type.NUMBER } } } },
        suggested_category: { type: Type.STRING,
          description: "Exactly one of the provided category names, or empty" },
      },
      required: ["is_receipt"],
    },
  },
});
const receipt = JSON.parse(res.text);
```

   Throttle to ≤8 requests/min (free tier is ~10 RPM). On 429, stop the run and
   record progress — the next run resumes.
4. **Match to a transaction:** candidates where `ABS(t.amount - total) < 0.01`
   (fall back to within 1%) AND `t.date BETWEEN receipt.date - 1 AND receipt.date + 4`
   AND `status != 'pending'` AND no existing `receipt_matches` row. If exactly one
   candidate: insert `receipt_matches` (resolve `suggested_category` name →
   `categories.id`; unknown name → NULL), set that transaction's
   `reviewed_at = NULL` (amber), and mark the message `matched = TRUE`. Zero or
   multiple candidates: record the message as scanned, unmatched — do not guess.
5. Record every processed message in `scanned_gmail_messages`. Return
   `{ scanned, receipts_found, matched }` from the endpoint.

**Never** let the scanner modify amounts, dates, merchants, or delete anything —
its only writes are `receipt_matches`, `scanned_gmail_messages`, and
`reviewed_at = NULL`.

## Client changes

- `api.js`: `reviewTransactions(ids)`, `scanReceipts()`, `gmailStatus()`,
  `gmailAuthUrl()`, `gmailAuthCode(code)`.
- `views/Transactions.jsx`:
  - Amber row when `reviewed_at` is null: `background: "rgba(251,191,36,0.08)"` +
    2px amber left border; keep existing conditional styling working.
  - "Needs review (N)" filter chip.
  - On an amber row, the existing detail expansion additionally shows the receipt:
    merchant, date, total, line items, and "Suggested: <category>" with an
    **Approve** button (calls `reviewTransactions([id])`) — approval both clears
    amber and applies the suggested category (server does this atomically).
  - "Approve all shown (N)" when the filter is active.
- `views/Settings.jsx`: "Connect Gmail" card (status → auth URL → paste code) and a
  "Scan now" button showing the last run's `{scanned, receipts_found, matched}`.

## Out of scope

- Attachment/PDF receipt parsing (text bodies only in v1).
- Multi-candidate disambiguation UI; auto-categorization without approval.
- Any Gmail write scope.

## Acceptance criteria

1. Migration is idempotent across restarts; backfill runs exactly once.
2. With Gmail connected, "Scan now" finds a known receipt email, matches it to the
   right transaction (verify amount/date), and the row goes amber with the receipt
   visible in the expanded view.
3. Approve applies the suggested category (visible in the category column) and
   clears amber; re-running `POST /api/sync` and re-scanning does not re-flag it.
4. Scanner never processes the same Gmail message twice; a 429 from Gemini aborts
   gracefully and a later run resumes.
5. `cd server && npm test` passes; the matching function (amount/date window,
   single-candidate rule) is a pure function with unit tests.
