import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import {
  initDb,
  getApiKeyForUser, createApiKey, getClerkUserIdByApiKey,
  createLinkSession, getLinkSession, deleteLinkSession,
  getUserItems, upsertUserItem, removeUserItem,
  getCursor, saveCursor, upsertTransactions,
  getTransactions, getSpendingByCategory,
  saveOAuthState, getOAuthState, deleteOAuthState,
  saveOAuthCode, getOAuthCode, deleteOAuthCode,
  seedCategories,
  getCategories, createCategory, updateCategory, deleteCategory,
  getAssignments, upsertAssignment,
  getSplits, createSplit, deleteSplit, deleteSplitsForTransaction,
  getMerchantOverrides, upsertMerchantOverride,
  upsertImportedTransaction, deleteImportedTransactions,
} from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
const APP_URL = process.env.APP_URL || "http://localhost:3001";
const ALLOWED_EMAIL = "jaredpk@gmail.com";

// ── Supabase admin client (for JWT verification) ──────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    const allowed = !origin || origin.includes("claude.ai") || origin.includes("localhost") || origin.includes("anthropic.com");
    cb(null, allowed ? origin || "*" : false);
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
  credentials: true,
}));
app.use(express.json());

if (isProd) {
  app.use(express.static(path.join(__dirname, "../client/dist")));
}

// ── Plaid client ──────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Sync transactions for a user ──────────────────────────────────────────────
async function syncTransactions() {
  const items = await getUserItems();
  for (const { accessToken, itemId } of items) {
    let cursor = await getCursor(itemId);
    let hasMore = true;
    while (hasMore) {
      const r = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
      await upsertTransactions(r.data.added);
      await upsertTransactions(r.data.modified);
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }
    await saveCursor(itemId, cursor);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Unauthorized" });
  if (user.email !== ALLOWED_EMAIL) return res.status(403).json({ error: "Access denied" });

  req._user = user;
  next();
}

async function requireApiKeyOrAuth(req, res, next) {
  // Try API key first
  const directKey = req.headers["x-api-key"] || req.query.key;
  if (directKey) {
    const ref = await getClerkUserIdByApiKey(directKey);
    if (ref) { req._user = { id: ref, email: ALLOWED_EMAIL }; return next(); }
  }
  const authHeader = req.headers["authorization"];
  const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearerKey) {
    // Try as API key first
    const ref = await getClerkUserIdByApiKey(bearerKey);
    if (ref) { req._user = { id: ref, email: ALLOWED_EMAIL }; return next(); }
    // Try as Supabase JWT
    const { data: { user }, error } = await supabase.auth.getUser(bearerKey);
    if (!error && user && user.email === ALLOWED_EMAIL) {
      req._user = user;
      return next();
    }
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ── User API key management ───────────────────────────────────────────────────
app.get("/api/user/api-key", requireAuth, async (req, res) => {
  const key = await getApiKeyForUser();
  res.json({ key });
});

app.post("/api/user/api-key", requireAuth, async (req, res) => {
  const key = await createApiKey();
  res.json({ key });
});

// ── Public config ─────────────────────────────────────────────────────────────
app.get("/api/config", (_, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
}));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── Plaid Link page ───────────────────────────────────────────────────────────
app.get("/link", async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).send("Missing session");
  const linkSession = await getLinkSession(session);
  if (!linkSession) return res.status(400).send("Invalid or expired session.");

  let linkToken;
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'jared' },
      client_name: "FinApp",
      products: [Products.Transactions, Products.Auth],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    linkToken = r.data.link_token;
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).send("Failed to create link token");
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Your Bank – FinApp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 16px; padding: 48px 40px; max-width: 440px; width: 90%; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.4); }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; }
    p { color: #94a3b8; margin-bottom: 32px; line-height: 1.6; }
    button { background: #6366f1; color: white; border: none; border-radius: 10px; padding: 14px 32px; font-size: 1rem; font-weight: 600; cursor: pointer; width: 100%; }
    button:disabled { background: #334155; cursor: not-allowed; }
    .status { margin-top: 20px; padding: 12px; border-radius: 8px; font-size: 0.9rem; display: none; }
    .status.success { background: #064e3b; color: #6ee7b7; display: block; }
    .status.error { background: #450a0a; color: #fca5a5; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🏦 Connect Your Bank</h1>
    <p>Securely link your bank account to FinApp using Plaid.</p>
    <button id="btn">Connect Bank Account</button>
    <div id="status" class="status"></div>
  </div>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById("btn");
    const status = document.getElementById("status");
    const handler = Plaid.create({
      token: ${JSON.stringify(linkToken)},
      onSuccess: async (public_token) => {
        btn.disabled = true;
        btn.textContent = "Connecting...";
        try {
          const res = await fetch("/api/exchange_public_token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ public_token, session: ${JSON.stringify(session)} }),
          });
          const data = await res.json();
          if (data.success) {
            status.className = "status success";
            status.textContent = "✓ Bank connected! You can close this tab and return to Claude.";
            btn.style.display = "none";
          } else { throw new Error(data.error); }
        } catch (err) {
          status.className = "status error";
          status.textContent = "Failed: " + err.message;
          btn.disabled = false;
          btn.textContent = "Try Again";
        }
      },
      onExit: (err) => {
        if (err) { status.className = "status error"; status.textContent = "Connection cancelled."; }
      },
    });
    btn.addEventListener("click", () => handler.open());
  </script>
</body>
</html>`);
});

// ── Create link token (from web app) ─────────────────────────────────────────
app.post("/api/create_link_token", requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'jared' },
      client_name: "FinApp",
      products: [Products.Transactions, Products.Auth],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// ── Exchange public token ─────────────────────────────────────────────────────
app.post("/api/exchange_public_token", async (req, res) => {
  const { public_token, session } = req.body;
  if (session) {
    const linkSession = await getLinkSession(session);
    if (!linkSession) return res.status(400).json({ error: "Invalid or expired session" });
    await deleteLinkSession(session);
  }
  try {
    const r = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;
    let institutionName = null;
    try {
      const itemResp = await plaidClient.itemGet({ access_token });
      const instId = itemResp.data.item.institution_id;
      if (instId) {
        const instResp = await plaidClient.institutionsGetById({ institution_id: instId, country_codes: [CountryCode.Us] });
        institutionName = instResp.data.institution.name;
      }
    } catch (_) {}
    await upsertUserItem(access_token, item_id, institutionName);
    await syncTransactions();
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get("/api/accounts", requireAuth, async (req, res) => {
  const items = await getUserItems();
  try {
    const allAccounts = await Promise.all(
      items.map(async ({ accessToken, itemId, institutionName }) => {
        const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
        return r.data.accounts.map((a) => ({ ...a, institutionName, itemId }));
      })
    );
    res.json({ accounts: allAccounts.flat() });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// ── Transactions ──────────────────────────────────────────────────────────────
app.get("/api/transactions", requireApiKeyOrAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const transactions = await getTransactions({
      limit,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      category: req.query.category,
    });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post("/api/sync", requireAuth, async (req, res) => {
  try {
    await syncTransactions();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

// ── Categories ────────────────────────────────────────────────────────────────
app.post("/api/categories/seed", requireAuth, async (req, res) => {
  const { categories } = req.body;
  if (!Array.isArray(categories)) return res.status(400).json({ error: "categories array required" });
  const created = await seedCategories(categories);
  const all = await getCategories();
  res.json({ created, categories: all });
});

app.get("/api/categories", requireApiKeyOrAuth, async (req, res) => {
  const cats = await getCategories();
  res.json({ categories: cats });
});

app.post("/api/categories", requireAuth, async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const cat = await createCategory(name, color);
  res.json({ category: cat });
});

app.put("/api/categories/:id", requireAuth, async (req, res) => {
  const { name, color } = req.body;
  const cat = await updateCategory(req.params.id, name, color);
  if (!cat) return res.status(404).json({ error: "not found" });
  res.json({ category: cat });
});

app.delete("/api/categories/:id", requireAuth, async (req, res) => {
  const ok = await deleteCategory(req.params.id);
  res.json({ ok });
});

// ── Assignments ───────────────────────────────────────────────────────────────
app.get("/api/assignments", requireApiKeyOrAuth, async (req, res) => {
  const rows = await getAssignments();
  res.json({ assignments: rows });
});

app.post("/api/assignments", requireApiKeyOrAuth, async (req, res) => {
  const { transaction_id, category_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: "transaction_id required" });
  await upsertAssignment(transaction_id, category_id);
  res.json({ ok: true });
});

// ── Splits ────────────────────────────────────────────────────────────────────
app.get("/api/splits", requireAuth, async (req, res) => {
  const rows = await getSplits();
  res.json({ splits: rows });
});

app.post("/api/splits", requireAuth, async (req, res) => {
  const { transaction_id, category_id, amount, note } = req.body;
  if (!transaction_id || amount == null) return res.status(400).json({ error: "transaction_id and amount required" });
  const split = await createSplit(transaction_id, category_id, amount, note);
  res.json({ split });
});

app.delete("/api/splits/:id", requireAuth, async (req, res) => {
  const ok = await deleteSplit(req.params.id);
  res.json({ ok });
});

// ── CSV Import ────────────────────────────────────────────────────────────────
app.post("/api/import", requireAuth, async (req, res) => {
  const { transactions: rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "transactions array required" });
  for (const t of rows) {
    await upsertImportedTransaction(t);
  }
  res.json({ imported: rows.length });
});

app.delete("/api/import", requireAuth, async (req, res) => {
  const deleted = await deleteImportedTransactions();
  res.json({ deleted });
});

// ── Merchant overrides ────────────────────────────────────────────────────────
app.get("/api/merchant-overrides", requireAuth, async (req, res) => {
  const rows = await getMerchantOverrides();
  res.json({ overrides: rows });
});

app.post("/api/merchant-overrides", requireAuth, async (req, res) => {
  const { transaction_id, merchant_name } = req.body;
  if (!transaction_id || !merchant_name) return res.status(400).json({ error: "transaction_id and merchant_name required" });
  await upsertMerchantOverride(transaction_id, merchant_name);
  res.json({ ok: true });
});

// ── OAuth metadata ────────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (_, res) => {
  res.json({
    issuer: APP_URL,
    authorization_endpoint: `${APP_URL}/oauth/authorize`,
    token_endpoint: `${APP_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.get("/.well-known/oauth-protected-resource", (_, res) => {
  res.json({
    resource: `${APP_URL}/mcp`,
    authorization_servers: [APP_URL],
  });
});

// ── OAuth authorize ───────────────────────────────────────────────────────────
app.get("/oauth/authorize", async (req, res) => {
  const { state, redirect_uri, code_challenge, code_challenge_method } = req.query;
  if (!state || !redirect_uri) return res.status(400).send("Missing state or redirect_uri");

  await saveOAuthState(state, redirect_uri, code_challenge, code_challenge_method);

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to FinApp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; gap: 24px; }
    .wordmark { font-size: 2rem; font-weight: 800; letter-spacing: -0.04em; }
    .wordmark span { color: #6366f1; }
    .subtitle { color: #94a3b8; font-size: 0.9rem; }
    .btn { background: #6366f1; color: white; border: none; border-radius: 10px; padding: 14px 32px; font-size: 1rem; font-weight: 600; cursor: pointer; min-width: 280px; }
    .btn:disabled { background: #334155; cursor: not-allowed; }
    .status { color: #94a3b8; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="wordmark">fin<span>app</span></div>
  <p class="subtitle">Sign in to connect with Claude</p>
  <button id="btn" class="btn">Send Magic Link</button>
  <p id="status" class="status"></p>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

    const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};
    const STATE = ${JSON.stringify(state)};

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    async function completeFlow(session) {
      document.getElementById("status").textContent = "Completing sign in…";
      try {
        const resp = await fetch("/oauth/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.access_token, state: STATE }),
        });
        const data = await resp.json();
        if (data.redirect_to) {
          window.location.href = data.redirect_to;
        } else {
          document.getElementById("status").textContent = "Error: " + (data.error || "Unknown error");
        }
      } catch (err) {
        document.getElementById("status").textContent = "Error: " + err.message;
      }
    }

    // Check if returning from magic link redirect
    supabase.auth.onAuthStateChange(async (event, session) => {
      if (session) await completeFlow(session);
    });

    document.getElementById("btn").addEventListener("click", async () => {
      document.getElementById("btn").disabled = true;
      document.getElementById("status").textContent = "Check your email for a magic link…";
      const { error } = await supabase.auth.signInWithOtp({
        email: "jaredpk@gmail.com",
        options: { emailRedirectTo: window.location.href },
      });
      if (error) {
        document.getElementById("status").textContent = "Error: " + error.message;
        document.getElementById("btn").disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

// ── OAuth complete ────────────────────────────────────────────────────────────
app.post("/oauth/complete", async (req, res) => {
  const { token, state } = req.body;
  if (!token || !state) return res.status(400).json({ error: "Missing token or state" });

  const oauthState = await getOAuthState(state);
  if (!oauthState) return res.status(400).json({ error: "Invalid or expired state" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid token" });
  if (user.email !== ALLOWED_EMAIL) return res.status(403).json({ error: "Access denied" });

  const code = randomBytes(32).toString("hex");
  await saveOAuthCode(code, oauthState.redirect_uri, oauthState.code_challenge);
  await deleteOAuthState(state);

  const redirectUrl = new URL(oauthState.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  res.json({ redirect_to: redirectUrl.toString() });
});

// ── OAuth token ───────────────────────────────────────────────────────────────
app.post("/oauth/token", express.urlencoded({ extended: true }), async (req, res) => {
  const { code, code_verifier, grant_type } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const oauthCode = await getOAuthCode(code);
  if (!oauthCode) return res.status(400).json({ error: "invalid_grant" });

  if (oauthCode.code_challenge && code_verifier) {
    const hash = createHash("sha256").update(code_verifier).digest("base64url");
    if (hash !== oauthCode.code_challenge) {
      return res.status(400).json({ error: "invalid_grant" });
    }
  }

  let apiKey = await getApiKeyForUser();
  if (!apiKey) apiKey = await createApiKey();

  await deleteOAuthCode(code);

  res.json({
    access_token: apiKey,
    token_type: "bearer",
    expires_in: 31536000,
  });
});

// ── MCP server factory ────────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "finapp", version: "3.0.0" });

  server.tool("get_bank_link_url", "Generate a URL to connect a bank account via Plaid", {}, async () => {
    const sessionId = await createLinkSession();
    return { content: [{ type: "text", text: `Open this URL in your browser to connect a bank:\n\n${APP_URL}/link?session=${sessionId}\n\nExpires in 30 minutes.` }] };
  });

  server.tool("list_linked_banks", "List all linked bank accounts", {}, async () => {
    const items = await getUserItems();
    if (!items.length) return { content: [{ type: "text", text: "No banks linked yet." }] };
    return { content: [{ type: "text", text: JSON.stringify(items.map(i => ({ itemId: i.itemId, institution: i.institutionName })), null, 2) }] };
  });

  server.tool("remove_bank", "Remove a linked bank account", { item_id: z.string() }, async ({ item_id }) => {
    const removed = await removeUserItem(item_id);
    return { content: [{ type: "text", text: removed ? `Bank ${item_id} removed.` : "Bank not found." }] };
  });

  server.tool("sync_transactions", "Pull latest transactions from Plaid", {}, async () => {
    await syncTransactions();
    return { content: [{ type: "text", text: "Sync complete." }] };
  });

  server.tool("get_balances", "Get current balances for all linked accounts", {}, async () => {
    const items = await getUserItems();
    if (!items.length) return { content: [{ type: "text", text: "No banks linked yet." }] };
    const accounts = (await Promise.all(items.map(async ({ accessToken, institutionName }) => {
      const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
      return r.data.accounts.map(a => ({ institution: institutionName, name: a.name, type: a.subtype, balance: a.balances.current, available: a.balances.available }));
    }))).flat();
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  });

  server.tool("get_transactions", "Get transactions with optional filters", {
    limit: z.number().optional().describe("Max to return (default 50)"),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    category: z.string().optional(),
  }, async ({ limit = 50, start_date, end_date, category }) => {
    const txns = await getTransactions({ limit, startDate: start_date, endDate: end_date, category });
    return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }] };
  });

  server.tool("get_spending_by_category", "Spending summary grouped by category", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date, end_date }) => {
    const summary = await getSpendingByCategory({ startDate: start_date, endDate: end_date });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  });

  server.tool("categorize_transactions", "Assign a user category to one or more transactions", {
    assignments: z.array(z.object({
      transaction_id: z.string(),
      category_id: z.string().describe("UUID of the category from list_categories"),
    })),
  }, async ({ assignments }) => {
    for (const { transaction_id, category_id } of assignments) {
      await upsertAssignment(transaction_id, category_id);
    }
    return { content: [{ type: "text", text: `Assigned categories to ${assignments.length} transaction(s).` }] };
  });

  server.tool("list_categories", "List all user-defined categories", {}, async () => {
    const cats = await getCategories();
    if (!cats.length) return { content: [{ type: "text", text: "No categories defined yet." }] };
    return { content: [{ type: "text", text: JSON.stringify(cats, null, 2) }] };
  });

  server.tool("update_merchant_override", "Fix the display name for a transaction's merchant", {
    transaction_id: z.string(),
    merchant_name: z.string(),
  }, async ({ transaction_id, merchant_name }) => {
    await upsertMerchantOverride(transaction_id, merchant_name);
    return { content: [{ type: "text", text: `Merchant name updated to "${merchant_name}".` }] };
  });

  server.tool("split_transaction", "Split a transaction across multiple categories", {
    transaction_id: z.string(),
    splits: z.array(z.object({
      category_id: z.string().optional(),
      amount: z.number(),
      note: z.string().optional(),
    })),
  }, async ({ transaction_id, splits: splitRows }) => {
    await deleteSplitsForTransaction(transaction_id);
    for (const { category_id, amount, note } of splitRows) {
      await createSplit(transaction_id, category_id, amount, note);
    }
    return { content: [{ type: "text", text: `Created ${splitRows.length} splits.` }] };
  });

  return server;
}

// ── MCP auth helper ───────────────────────────────────────────────────────────
async function resolveMcpUser(req) {
  const authHeader = req.headers["authorization"];
  const apiKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.headers["x-api-key"] || req.query.key;
  if (!apiKey) return null;
  return getClerkUserIdByApiKey(apiKey);
}

function unauthorizedMcp(res) {
  return res.status(401)
    .set("WWW-Authenticate", `Bearer realm="${APP_URL}", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`)
    .json({ error: "Unauthorized" });
}

// ── SSE sessions ──────────────────────────────────────────────────────────────
const sseSessions = new Map();

app.get("/sse", async (req, res) => {
  const ref = await resolveMcpUser(req);
  if (!ref) return unauthorizedMcp(res);
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  transport.onclose = () => sseSessions.delete(transport.sessionId);
  const server = buildMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const session = sseSessions.get(req.query.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  await session.handlePostMessage(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const ref = await resolveMcpUser(req);
  if (!ref) return unauthorizedMcp(res);
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  transport.onclose = () => sseSessions.delete(transport.sessionId);
  const server = buildMcpServer();
  await server.connect(transport);
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (sessionId && sseSessions.has(sessionId)) {
    return sseSessions.get(sessionId).handlePostMessage(req, res, req.body);
  }
  const ref = await resolveMcpUser(req);
  if (!ref) return unauthorizedMcp(res);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
if (isProd) {
  app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../client/dist/index.html")));
}

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => console.log(`FinApp server running on :${PORT}`));
});
