# Brief 03 — Ask AI

**Goal:** An in-app "Ask AI" view where the user asks natural-language questions about
their finances ("what did I spend on groceries last month?", "any unusual charges?")
and a Claude model answers using **read-only** tool calls against the app's data.

## Before building: the zero-code alternative

The server already exposes an MCP server (`GET/POST /mcp`, `GET /sse` in
`server/index.js`, ~line 1675) with 13 finance tools and an OAuth flow. Connecting
claude.ai (custom connector) or Claude Desktop to it already answers these questions.
The in-app feature below is still worth building for one-click access inside the app,
but don't duplicate effort: **reuse the same data-access functions the MCP tools call.**

## Constraints (already decided — do not revisit)

1. **Read-only tool surface.** The model gets query tools only — no delete, import,
   categorize-write, or sync triggers. A wrong answer must not be able to mutate data.
2. **Model: `claude-opus-5`** (current Opus, $5/M input, $25/M output). Estimated
   ~$0.05–0.15 per question. If the owner prefers cheaper, `claude-haiku-4-5`
   ($1/$5) is the swap — one string constant; make it an env var
   `ASK_AI_MODEL` defaulting to `claude-opus-5`.
3. **`ANTHROPIC_API_KEY` via env.** Locally: `server/.env`. **Do not run
   `fly secrets set` or deploy this feature** — that is a production config change
   that enables metered spend and requires the owner's explicit approval first
   (per CLAUDE.md boundaries). Build and verify locally only.
4. Endpoint behind `requireAuth` (single user; same guard as other routes).
5. Non-streaming v1. Answers are short; `max_tokens: 4000` is fine without streaming.
   (Streaming via SSE is a listed future enhancement, not v1.)

## Server changes

### Dependency

`cd server && npm install @anthropic-ai/sdk`

### Refactor first (small)

The MCP tool handlers in `server/index.js` (tools like `get_transactions`,
`get_balances`, `get_spending_by_category`, `list_categories`) wrap functions that
mostly already exist in `server/db.js`. Extract any handler logic not already in
`db.js` so both MCP and Ask AI call the same functions. Do not change MCP behavior.

### Endpoint

`POST /api/ask` — body `{ question: string, history?: {role, content}[] }` (history
lets the client keep a short multi-turn thread; cap at last 10 turns server-side).
Returns `{ answer: string }`. Reject empty questions and questions > 2000 chars.

Use the SDK's **beta tool runner** so you don't hand-write the tool loop. Pattern
(raw JSON-schema tools via `betaTool` — no zod dependency needed):

```js
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import * as db from "./db.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const tools = [
  betaTool({
    name: "get_transactions",
    description:
      "List transactions. Call this when the question concerns specific purchases, merchants, dates, or amounts. Amounts: positive = money out (spend), negative = money in (income/refund).",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date:   { type: "string", description: "YYYY-MM-DD" },
        category:   { type: "string", description: "Optional category name filter" },
        limit:      { type: "integer", description: "Max rows, default 100, cap 500" },
      },
      required: [],
    },
    run: async (input) => JSON.stringify(await db.getTransactions(input)),
  }),
  // Same shape for: get_spending_by_category, list_categories, get_report_summary
  // (from Brief 02, if merged), get_balances / accounts summary.
];

app.post("/api/ask", requireAuth, async (req, res) => {
  try {
    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: process.env.ASK_AI_MODEL || "claude-opus-5",
      max_tokens: 4000,
      max_iterations: 8,
      system: SYSTEM_PROMPT,
      tools,
      messages: [...clampedHistory(req.body.history), { role: "user", content: req.body.question }],
    });
    const answer = finalMessage.content
      .filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.json({ answer });
  } catch (err) {
    console.error("ask-ai:", err.status || "", err.message);
    res.status(502).json({ error: "AI request failed" });
  }
});
```

Notes for the implementer:

- On `claude-opus-5`, thinking is on by default — do **not** pass a `thinking`
  parameter or `temperature`/`top_p` (they 400 on this model).
- Tool results must be strings — `JSON.stringify` the db results; truncate any tool
  result over ~50KB and append `"(truncated)"` so one broad query can't blow the
  context.
- System prompt: state today's date (the model can't know it), the amount sign
  convention, the single-user context, and "answer from tool data only; if the data
  doesn't cover the question, say so." Keep it under ~30 lines.
- If `ANTHROPIC_API_KEY` is unset, return 503 with
  `{ error: "Ask AI not configured" }` and have the client show a friendly notice —
  the app must still boot without the key.
- Error handling: catch the SDK's typed errors if convenient
  (`Anthropic.RateLimitError` etc.), but a single 502 with a logged message is
  acceptable for v1.

## Client changes

- `api.js`: `askAi(question, history)`.
- `views/AskAI.jsx` (new) + Sidebar entry ("Ask AI", sparkle icon):
  - Simple chat column: scrollable message list (user right / assistant left,
    existing surface + border variables), textarea + send button, Enter to send.
  - Keep the thread in component state; send the last ≤10 turns as `history`.
  - Loading state on the pending message (typing indicator); render the answer as
    plain text with newlines preserved (no markdown library in v1).
  - If the endpoint returns 503, show "Ask AI isn't configured — add
    ANTHROPIC_API_KEY to server/.env."

## Out of scope (v1)

- Streaming responses, markdown rendering, charts in answers.
- Write actions (categorizing, splitting) via chat.
- Persisting chat history server-side.

## Acceptance criteria

1. With a valid key locally, questions like "total spend last month" and "biggest 5
   purchases in June" return correct answers verifiable against the Transactions
   view; the model calls tools (log tool names per request to confirm).
2. Without a key, the app boots normally and the view shows the not-configured
   notice.
3. No write endpoint is reachable from the tool surface (code review: every tool
   `run` calls only read functions).
4. Existing MCP endpoints behave exactly as before (`/mcp` tool list unchanged).
5. Existing tests still pass (`cd server && npm test`).
