# Brief 03 — Ask AI (Google Gemini)

**Goal:** An in-app "Ask AI" view where the user asks natural-language questions about
their finances and **Google Gemini** answers using **read-only** function calls
against the app's data.

## The subscription question (answered)

The owner has a Google AI Pro subscription and asked whether it includes API access.

- **Google AI Pro ($19.99/mo) does not bundle Gemini *API* usage** — it covers the
  consumer Gemini app, Gmail/Docs integration, NotebookLM, etc. The developer API is
  billed separately.
- **However, the Gemini API has a free tier** (key from Google AI Studio, no card):
  as of early 2026 roughly **10 requests/min and ~250 requests/day on
  `gemini-2.5-flash`** (quotas were cut in Dec 2025 — re-check current numbers at
  ai.google.dev/gemini-api/docs/rate-limits). For a single user asking a handful of
  questions a day — each question = 1–5 API calls through the function-calling
  loop — the free tier is ample.
- Google also grants **Google Cloud credits to AI Pro/Ultra subscribers** usable
  toward Gemini API on a billed project.
- **DECIDED (owner, 2026-08-09): paid tier is required.** As a matter of principle,
  financial data must not be used for training. Free-tier ("unpaid services")
  requests may be used by Google to improve products; paid-tier data is not. Cost is
  cents/month at this volume (`gemini-2.5-flash` ≈ $0.30/M input, $2.50/M output
  tokens), coverable by the AI Pro subscriber Cloud credits.

**Required setup (owner):** create/select a Google Cloud project, **enable billing**
on it (attach the subscriber Cloud credits), and mint the `GEMINI_API_KEY` in
AI Studio **tied to that billed project** — that places all API usage under the
paid-tier data terms. A key from an unbilled project silently falls under free-tier
terms, so the implementer must add a startup log line reminding which project the
key should come from, and the Settings/README note must state the billed-project
requirement. (Full OAuth/service-account auth via Vertex AI would also satisfy the
data terms but is heavier than needed for a single-user server; the billed-project
API key is the chosen mechanism.)

Net: **use Gemini on the paid tier at cents/month.** Same `GEMINI_API_KEY` as
Brief 01 — one billed project covers both features.

## Constraints (already decided — do not revisit)

1. **Read-only tool surface** — query functions only; no delete/import/sync/write.
2. **Model: the current-generation flash model**, overridable via env
   `ASK_AI_MODEL` (`gemini-2.5-pro` for smarter answers if the owner enables
   billing — Pro's free quota is much smaller). The brief was written against
   `gemini-2.5-flash`; the shipped default is **`gemini-3.7-flash`** as of
   commit 1c5d62a. It is a moving target by design — it tracks whatever
   current-generation flash model Google ships — so read `resolveAskModel()` in
   `server/askAi.js` for today's value rather than this line. `ASK_AI_MODEL`
   always wins over the default, and is the rollback path when a new one
   misbehaves.
3. Endpoint behind `requireAuth`. Non-streaming v1.
4. App must boot without `GEMINI_API_KEY` (endpoint returns 503, client shows a
   friendly notice).

## Server changes

### Dependency

`cd server && npm install @google/genai` (shared with Brief 01; the deprecated
`@google/generative-ai` package is NOT the right one).

### Refactor first (small)

The MCP tool handlers in `server/index.js` (~line 1675: `get_transactions`,
`get_balances`, `get_spending_by_category`, `list_categories`, …) mostly wrap
functions already in `server/db.js`. Extract any handler logic not already in
`db.js` so MCP and Ask AI share the same functions. Do not change MCP behavior.

### Endpoint

`POST /api/ask` — body `{ question: string, history?: {role, text}[] }` (client
sends the last ≤10 turns; clamp server-side). Returns `{ answer: string }`. Reject
empty or >2000-char questions.

Gemini function calling with a manual loop (the JS SDK returns `functionCalls` you
answer with `functionResponse` parts):

```js
import { GoogleGenAI, Type } from "@google/genai";
import * as db from "./db.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const functionDeclarations = [
  {
    name: "get_transactions",
    description:
      "List transactions. Use for questions about specific purchases, merchants, dates, amounts. Positive amount = money out (spend); negative = money in.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_date: { type: Type.STRING, description: "YYYY-MM-DD" },
        end_date:   { type: Type.STRING, description: "YYYY-MM-DD" },
        category:   { type: Type.STRING },
        limit:      { type: Type.INTEGER, description: "default 100, max 500" },
      },
    },
  },
  // Same shape for the other tools that TAKE arguments:
  // get_spending_by_category, get_report_summary (Brief 02, if merged).
  //
  // Zero-argument tools (list_categories, get_latest_balances) must OMIT
  // `parameters` entirely — do NOT give them an OBJECT schema with empty
  // `properties`. The API rejects that at request validation with 400
  // INVALID_ARGUMENT ("parameters.properties: should be non-empty for OBJECT
  // type"), and because every declaration is sent on every generateContent
  // call, one such entry breaks every Ask AI request. The SDK marks
  // `parameters` optional for exactly this case.
];

const impl = {
  get_transactions: (a) => db.getTransactions(a),
  get_spending_by_category: (a) => db.getSpendingByCategory(a),
  list_categories: () => db.getCategories(),
  get_latest_balances: () => db.getLatestBalances(),
};

app.post("/api/ask", requireAuth, async (req, res) => {
  if (!process.env.GEMINI_API_KEY)
    return res.status(503).json({ error: "Ask AI not configured" });
  try {
    const contents = [
      ...clampedHistory(req.body.history), // -> [{role:"user"|"model", parts:[{text}]}]
      { role: "user", parts: [{ text: req.body.question }] },
    ];
    for (let i = 0; i < 8; i++) {
      const r = await ai.models.generateContent({
        model: process.env.ASK_AI_MODEL || "gemini-3.7-flash", // default moves; env wins
        contents,
        config: { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations }] },
      });
      const calls = r.functionCalls;             // undefined/empty when done
      if (!calls || calls.length === 0)
        return res.json({ answer: r.text || "(no answer)" });
      contents.push({ role: "model", parts: r.candidates[0].content.parts });
      for (const call of calls) {
        let result;
        try { result = await impl[call.name](call.args || {}); }
        catch (e) { result = { error: String(e.message) }; }
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: call.name,
            response: { result: truncateJson(result) } } }],
        });
      }
    }
    res.json({ answer: "I couldn't finish answering that — try a narrower question." });
  } catch (err) {
    console.error("ask-ai:", err.status || "", err.message);
    res.status(err.status === 429 ? 429 : 502).json({ error: "AI request failed" });
  }
});
```

Notes for the implementer:

- `truncateJson(x, n)`: `JSON.stringify`, and REFUSE outright above n chars —
  one broad query must not blow the context. Do NOT implement this as "cut at n
  and append `(truncated)`", which is what shipped first and what had to be
  fixed: the results are ordered oldest-first, so the cut silently dropped the
  most RECENT months, and the model reported the missing tail as $0.00 rather
  than as absent. It also left invalid JSON. Return a structured
  `{ error: "RESULT_TOO_LARGE", message }` carrying no data at all, and have the
  system prompt tell the model to retry with a narrower range or a category
  filter and never read an absent period as zero. Partial aggregate data is
  worse than none, because it looks complete.
- System prompt (<~30 lines): today's date (the model doesn't know it), the amount
  sign convention, single-user context, "answer only from tool data; if the data
  doesn't cover it, say so," and "amounts in USD."
- Free-tier 429s are expected under bursts (~10 RPM): surface as HTTP 429 and let
  the client show "rate limited — try again in a minute."
- Verify the exact `@google/genai` response accessors (`r.text`, `r.functionCalls`,
  `r.candidates[0].content.parts`) against the installed SDK version's README —
  this SDK's surface has churned; fix names per the package docs, keep the loop
  shape.

## Client changes

- `api.js`: `askAi(question, history)`.
- `views/AskAI.jsx` (new) + Sidebar entry ("Ask AI"):
  - Chat column: scrollable list (user right / model left, existing `--surface` /
    `--border` variables), textarea + send, Enter to send.
  - Thread in component state; send last ≤10 turns as `history`
    (`{role: "user"|"model", text}`).
  - Loading indicator on pending answer; render plain text with newlines preserved.
  - 503 → "Ask AI isn't configured — add GEMINI_API_KEY to server/.env."
    429 → "Rate limited — wait a minute."

## Out of scope (v1)

- Streaming, markdown rendering, charts in answers, server-side chat persistence,
  write actions via chat.

## Acceptance criteria

1. With a key in `server/.env`, "total spend last month" and "biggest 5 purchases in
   June" answer correctly vs. the Transactions view; per-request logs show which
   functions were called.
2. Without a key, the app boots and the view shows the not-configured notice.
3. The tool surface is verifiably read-only (every `impl` entry calls only query
   functions).
4. MCP endpoints unchanged; `cd server && npm test` passes.
