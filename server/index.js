import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { clerkMiddleware, getAuth } from "@clerk/express";
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

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests from Claude.ai, localhost in dev, and no-origin (curl/server-to-server)
    const allowed = !origin || origin.includes("claude.ai") || origin.includes("localhost") || origin.includes("anthropic.com");
    cb(null, allowed ? origin || "*" : false);
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
  credentials: true,
}));
app.use(express.json());
app.use(clerkMiddleware());

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
async function syncTransactions(clerkUserId) {
  const items = await getUserItems(clerkUserId);
  for (const { accessToken, itemId } of items) {
    let cursor = await getCursor(itemId);
    let hasMore = true;
    while (hasMore) {
      const r = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
      await upsertTransactions(clerkUserId, r.data.added);
      await upsertTransactions(clerkUserId, r.data.modified);
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }
    await saveCursor(itemId, cursor);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireClerkAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── User API key management ───────────────────────────────────────────────────
app.get("/api/user/api-key", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const key = await getApiKeyForUser(userId);
  res.json({ key });
});

app.post("/api/user/api-key", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const key = await createApiKey(userId);
  res.json({ key });
});

// ── Plaid Link page (opened from MCP bank link URL) ───────────────────────────
app.get("/link", async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).send("Missing session");

  const linkSession = await getLinkSession(session);
  if (!linkSession) return res.status(400).send("Invalid or expired session. Please generate a new link URL from Claude.");

  let linkToken;
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: linkSession.clerk_user_id },
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

// ── Create link token (from web app, uses Clerk auth) ─────────────────────────
app.post("/api/create_link_token", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
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

  let clerkUserId;
  if (session) {
    const linkSession = await getLinkSession(session);
    if (!linkSession) return res.status(400).json({ error: "Invalid or expired session" });
    clerkUserId = linkSession.clerk_user_id;
    await deleteLinkSession(session);
  } else {
    const auth = getAuth(req);
    if (!auth.userId) return res.status(401).json({ error: "Unauthorized" });
    clerkUserId = auth.userId;
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

    await upsertUserItem(clerkUserId, access_token, item_id, institutionName);
    await syncTransactions(clerkUserId);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get("/api/accounts", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const items = await getUserItems(userId);
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
app.get("/api/transactions", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const transactions = await getTransactions(userId, { limit: 200 });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post("/api/sync", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  try {
    await syncTransactions(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── Categories ────────────────────────────────────────────────────────────────
app.post("/api/categories/seed", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { categories } = req.body;
  if (!Array.isArray(categories)) return res.status(400).json({ error: "categories array required" });
  const created = await seedCategories(userId, categories);
  const all = await getCategories(userId);
  res.json({ created, categories: all });
});

app.get("/api/categories", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const cats = await getCategories(userId);
  res.json({ categories: cats });
});

app.post("/api/categories", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const cat = await createCategory(userId, name, color);
  res.json({ category: cat });
});

app.put("/api/categories/:id", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { name, color } = req.body;
  const cat = await updateCategory(userId, req.params.id, name, color);
  if (!cat) return res.status(404).json({ error: "not found" });
  res.json({ category: cat });
});

app.delete("/api/categories/:id", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const ok = await deleteCategory(userId, req.params.id);
  res.json({ ok });
});

// ── Assignments ───────────────────────────────────────────────────────────────
app.get("/api/assignments", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const rows = await getAssignments(userId);
  res.json({ assignments: rows });
});

app.post("/api/assignments", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { transaction_id, category_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: "transaction_id required" });
  await upsertAssignment(userId, transaction_id, category_id);
  res.json({ ok: true });
});

// ── Splits ────────────────────────────────────────────────────────────────────
app.get("/api/splits", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const rows = await getSplits(userId);
  res.json({ splits: rows });
});

app.post("/api/splits", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { transaction_id, category_id, amount, note } = req.body;
  if (!transaction_id || amount == null) return res.status(400).json({ error: "transaction_id and amount required" });
  const split = await createSplit(userId, transaction_id, category_id, amount, note);
  res.json({ split });
});

app.delete("/api/splits/:id", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const ok = await deleteSplit(userId, req.params.id);
  res.json({ ok });
});

// ── CSV Import ────────────────────────────────────────────────────────────────
app.post("/api/import", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { transactions: rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "transactions array required" });
  for (const t of rows) {
    await upsertImportedTransaction(userId, t);
  }
  res.json({ imported: rows.length });
});

app.delete("/api/import", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const deleted = await deleteImportedTransactions(userId);
  res.json({ deleted });
});

// ── Merchant overrides ────────────────────────────────────────────────────────
app.get("/api/merchant-overrides", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const rows = await getMerchantOverrides(userId);
  res.json({ overrides: rows });
});

app.post("/api/merchant-overrides", requireClerkAuth, async (req, res) => {
  const { userId } = getAuth(req);
  const { transaction_id, merchant_name } = req.body;
  if (!transaction_id || !merchant_name) return res.status(400).json({ error: "transaction_id and merchant_name required" });
  await upsertMerchantOverride(userId, transaction_id, merchant_name);
  res.json({ ok: true });
});

// ── Public config (safe to expose) ───────────────────────────────────────────
app.get("/api/config", (_, res) => res.json({
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
}));

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

// ── OAuth authorize — serves browser login page ───────────────────────────────
app.get("/oauth/authorize", async (req, res) => {
  const { state, redirect_uri, code_challenge, code_challenge_method } = req.query;
  if (!state || !redirect_uri) return res.status(400).send("Missing state or redirect_uri");

  await saveOAuthState(state, redirect_uri, code_challenge, code_challenge_method);

  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || "";

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
    #clerk-signin { width: 100%; max-width: 420px; }
    .status { color: #94a3b8; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="wordmark">fin<span>app</span></div>
  <p class="subtitle">Sign in to connect with Claude</p>
  <div id="clerk-signin"></div>
  <p id="status" class="status"></p>

  <script>
    const PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)};
    const STATE = ${JSON.stringify(state)};

    async function loadClerk() {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
      await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });

      const clerk = new window.Clerk(PUBLISHABLE_KEY);
      await clerk.load();

      if (clerk.user) {
        await completeFlow(clerk);
      } else {
        clerk.mountSignIn(document.getElementById("clerk-signin"), {
          appearance: { variables: { colorBackground: "#1e293b", colorText: "#f8fafc", colorPrimary: "#6366f1" } },
        });
        clerk.addListener(({ user }) => { if (user) completeFlow(clerk); });
      }
    }

    async function completeFlow(clerk) {
      document.getElementById("status").textContent = "Completing sign in…";
      try {
        const token = await clerk.session.getToken();
        const resp = await fetch("/oauth/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, state: STATE }),
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

    loadClerk().catch(console.error);
  </script>
</body>
</html>`);
});

// ── OAuth complete — called by browser after Clerk sign-in ────────────────────
app.post("/oauth/complete", async (req, res) => {
  const { token, state } = req.body;
  if (!token || !state) return res.status(400).json({ error: "Missing token or state" });

  const oauthState = await getOAuthState(state);
  if (!oauthState) return res.status(400).json({ error: "Invalid or expired state" });

  // Verify the Clerk token and get user ID
  let clerkUserId;
  try {
    const { createClerkClient } = await import("@clerk/express");
    const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const { sub } = await clerkClient.verifyToken(token);
    clerkUserId = sub;
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }

  const code = randomBytes(32).toString("hex");
  await saveOAuthCode(code, clerkUserId, oauthState.redirect_uri, oauthState.code_challenge);
  await deleteOAuthState(state);

  const redirectUrl = new URL(oauthState.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", state);

  res.json({ redirect_to: redirectUrl.toString() });
});

// ── OAuth token — exchange code for access token ──────────────────────────────
app.post("/oauth/token", express.urlencoded({ extended: true }), async (req, res) => {
  const { code, redirect_uri, code_verifier, grant_type } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const oauthCode = await getOAuthCode(code);
  if (!oauthCode) return res.status(400).json({ error: "invalid_grant" });

  // Verify PKCE
  if (oauthCode.code_challenge && code_verifier) {
    const hash = createHash("sha256").update(code_verifier).digest("base64url");
    if (hash !== oauthCode.code_challenge) {
      return res.status(400).json({ error: "invalid_grant" });
    }
  }

  // Get or create API key (used as the access token)
  let apiKey = await getApiKeyForUser(oauthCode.clerk_user_id);
  if (!apiKey) apiKey = await createApiKey(oauthCode.clerk_user_id);

  await deleteOAuthCode(code);

  res.json({
    access_token: apiKey,
    token_type: "bearer",
    expires_in: 31536000,
  });
});

// ── MCP server factory ────────────────────────────────────────────────────────
function buildMcpServer(clerkUserId) {
  const server = new McpServer({ name: "finapp", version: "3.0.0" });
  const noAuth = { content: [{ type: "text", text: "Not authenticated. Connect via OAuth to use this tool." }] };

  server.tool("get_bank_link_url", "Generate a URL to connect a bank account via Plaid", {}, async () => {
    if (!clerkUserId) return noAuth;
    const sessionId = await createLinkSession(clerkUserId);
    return { content: [{ type: "text", text: `Open this URL in your browser to connect a bank:\n\n${APP_URL}/link?session=${sessionId}\n\nExpires in 30 minutes. After connecting, ask me to sync your transactions.` }] };
  });

  server.tool("list_linked_banks", "List all linked bank accounts", {}, async () => {
    if (!clerkUserId) return noAuth;
    const items = await getUserItems(clerkUserId);
    if (!items.length) return { content: [{ type: "text", text: "No banks linked yet. Use get_bank_link_url to connect one." }] };
    return { content: [{ type: "text", text: JSON.stringify(items.map(i => ({ itemId: i.itemId, institution: i.institutionName })), null, 2) }] };
  });

  server.tool("remove_bank", "Remove a linked bank account", { item_id: z.string() }, async ({ item_id }) => {
    if (!clerkUserId) return noAuth;
    const removed = await removeUserItem(clerkUserId, item_id);
    return { content: [{ type: "text", text: removed ? `Bank ${item_id} removed.` : "Bank not found." }] };
  });

  server.tool("sync_transactions", "Pull latest transactions from Plaid", {}, async () => {
    if (!clerkUserId) return noAuth;
    await syncTransactions(clerkUserId);
    return { content: [{ type: "text", text: "Sync complete." }] };
  });

  server.tool("get_balances", "Get current balances for all linked accounts", {}, async () => {
    if (!clerkUserId) return noAuth;
    const items = await getUserItems(clerkUserId);
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
    if (!clerkUserId) return noAuth;
    const txns = await getTransactions(clerkUserId, { limit, startDate: start_date, endDate: end_date, category });
    return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }] };
  });

  server.tool("get_spending_by_category", "Spending summary grouped by category", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date, end_date }) => {
    if (!clerkUserId) return noAuth;
    const summary = await getSpendingByCategory(clerkUserId, { startDate: start_date, endDate: end_date });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  });

  server.tool("categorize_transactions", "Assign a user category to one or more transactions", {
    assignments: z.array(z.object({
      transaction_id: z.string(),
      category_id: z.string().describe("UUID of the category from list_categories"),
    })).describe("Array of transaction → category pairs to assign"),
  }, async ({ assignments }) => {
    if (!clerkUserId) return noAuth;
    for (const { transaction_id, category_id } of assignments) {
      await upsertAssignment(clerkUserId, transaction_id, category_id);
    }
    return { content: [{ type: "text", text: `Assigned categories to ${assignments.length} transaction(s).` }] };
  });

  server.tool("list_categories", "List all user-defined categories", {}, async () => {
    if (!clerkUserId) return noAuth;
    const cats = await getCategories(clerkUserId);
    if (!cats.length) return { content: [{ type: "text", text: "No categories defined yet. Create some in the app under the Categories view." }] };
    return { content: [{ type: "text", text: JSON.stringify(cats, null, 2) }] };
  });

  server.tool("update_merchant_override", "Fix the display name for a transaction's merchant", {
    transaction_id: z.string(),
    merchant_name: z.string().describe("The corrected merchant name to display"),
  }, async ({ transaction_id, merchant_name }) => {
    if (!clerkUserId) return noAuth;
    await upsertMerchantOverride(clerkUserId, transaction_id, merchant_name);
    return { content: [{ type: "text", text: `Merchant name updated to "${merchant_name}" for transaction ${transaction_id}.` }] };
  });

  server.tool("split_transaction", "Split a transaction across multiple categories", {
    transaction_id: z.string(),
    splits: z.array(z.object({
      category_id: z.string().optional().describe("UUID of the category (from list_categories)"),
      amount: z.number().describe("Dollar amount for this split"),
      note: z.string().optional().describe("Optional note for this split"),
    })).describe("Split amounts — should sum to the transaction total"),
  }, async ({ transaction_id, splits: splitRows }) => {
    if (!clerkUserId) return noAuth;
    await deleteSplitsForTransaction(clerkUserId, transaction_id);
    for (const { category_id, amount, note } of splitRows) {
      await createSplit(clerkUserId, transaction_id, category_id, amount, note);
    }
    return { content: [{ type: "text", text: `Created ${splitRows.length} splits for transaction ${transaction_id}.` }] };
  });

  return server;
}

// ── Auth helper for MCP ───────────────────────────────────────────────────────
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

// ── SSE sessions store ────────────────────────────────────────────────────────
const sseSessions = new Map();

// ── MCP — SSE transport on /sse (for claude.ai) ───────────────────────────────
app.get("/sse", async (req, res) => {
  const clerkUserId = await resolveMcpUser(req);
  if (!clerkUserId) return unauthorizedMcp(res);

  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  transport.onclose = () => sseSessions.delete(transport.sessionId);

  const server = buildMcpServer(clerkUserId);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sseSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  await session.handlePostMessage(req, res, req.body);
});

// ── MCP — SSE transport on /mcp (GET) ────────────────────────────────────────
app.get("/mcp", async (req, res) => {
  const clerkUserId = await resolveMcpUser(req);
  if (!clerkUserId) return unauthorizedMcp(res);

  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  transport.onclose = () => sseSessions.delete(transport.sessionId);

  const server = buildMcpServer(clerkUserId);
  await server.connect(transport);
});

// ── MCP — Streamable HTTP (POST) ──────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId;

  if (sessionId && sseSessions.has(sessionId)) {
    return sseSessions.get(sessionId).handlePostMessage(req, res, req.body);
  }

  const clerkUserId = await resolveMcpUser(req);
  if (!clerkUserId) return unauthorizedMcp(res);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(clerkUserId);
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
