import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  initDb, createUser, getUserByApiKey, listUsers,
  createLinkSession, getLinkSession, deleteLinkSession,
  getUserItems, upsertUserItem, removeUserItem,
  getCursor, saveCursor, upsertTransactions,
  getTransactions, getSpendingByCategory,
} from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
const APP_URL = process.env.APP_URL || "http://localhost:3001";

const app = express();
app.use(cors({ origin: isProd ? false : "http://localhost:5173" }));
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
async function syncTransactions(userId) {
  const items = await getUserItems(userId);
  for (const { accessToken, itemId } of items) {
    let cursor = await getCursor(itemId);
    let hasMore = true;
    while (hasMore) {
      const r = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
      await upsertTransactions(userId, r.data.added);
      await upsertTransactions(userId, r.data.modified);
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }
    await saveCursor(itemId, cursor);
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function resolveUser(req) {
  const apiKey = req.headers["x-api-key"];
  if (apiKey) return getUserByApiKey(apiKey);
  return null;
}

// ── Plaid Link page ───────────────────────────────────────────────────────────
app.get("/link", async (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).send("Missing session");

  const linkSession = await getLinkSession(session);
  if (!linkSession) return res.status(400).send("Invalid or expired session. Please generate a new link URL from Claude.");

  let linkToken;
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(linkSession.user_id) },
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
    .logo { font-size: 2rem; margin-bottom: 8px; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; }
    p { color: #94a3b8; margin-bottom: 32px; line-height: 1.6; }
    button { background: #6366f1; color: white; border: none; border-radius: 10px; padding: 14px 32px; font-size: 1rem; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.2s; }
    button:hover { background: #4f46e5; }
    button:disabled { background: #334155; cursor: not-allowed; }
    .status { margin-top: 20px; padding: 12px; border-radius: 8px; font-size: 0.9rem; display: none; }
    .status.success { background: #064e3b; color: #6ee7b7; display: block; }
    .status.error   { background: #450a0a; color: #fca5a5; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🏦</div>
    <h1>Connect Your Bank</h1>
    <p>Securely link your bank account to FinApp using Plaid. Your credentials are never stored.</p>
    <button id="btn">Connect Bank Account</button>
    <div id="status" class="status"></div>
  </div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById("btn");
    const status = document.getElementById("status");

    const handler = Plaid.create({
      token: ${JSON.stringify(linkToken)},
      onSuccess: async (public_token, metadata) => {
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
            status.textContent = "✓ Bank connected successfully! You can close this tab and return to Claude.";
            btn.style.display = "none";
          } else {
            throw new Error(data.error || "Unknown error");
          }
        } catch (err) {
          status.className = "status error";
          status.textContent = "Failed to connect: " + err.message;
          btn.disabled = false;
          btn.textContent = "Try Again";
        }
      },
      onExit: (err) => {
        if (err) {
          status.className = "status error";
          status.textContent = "Connection cancelled or failed.";
        }
      },
    });

    btn.addEventListener("click", () => handler.open());
  </script>
</body>
</html>`);
});

// ── Exchange public token (called by link page) ───────────────────────────────
app.post("/api/exchange_public_token", async (req, res) => {
  const { public_token, session } = req.body;
  try {
    const linkSession = await getLinkSession(session);
    if (!linkSession) return res.status(400).json({ error: "Invalid or expired session" });

    const r = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = r.data;

    // Try to get institution name
    let institutionName = null;
    try {
      const itemResp = await plaidClient.itemGet({ access_token });
      const instId = itemResp.data.item.institution_id;
      if (instId) {
        const instResp = await plaidClient.institutionsGetById({ institution_id: instId, country_codes: [CountryCode.Us] });
        institutionName = instResp.data.institution.name;
      }
    } catch (_) {}

    await upsertUserItem(linkSession.user_id, access_token, item_id, institutionName);
    await deleteLinkSession(session);
    await syncTransactions(linkSession.user_id);

    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── REST API (used by the React frontend) ─────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: "Missing x-api-key header" });
  const items = await getUserItems(user.id);
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

app.get("/api/transactions", async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: "Missing x-api-key header" });
  try {
    const transactions = await getTransactions(user.id, { limit: 200 });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.post("/api/sync", async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: "Missing x-api-key header" });
  try {
    await syncTransactions(user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Sync failed" });
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const user = apiKey ? await getUserByApiKey(apiKey) : null;

  const server = new McpServer({ name: "finapp", version: "2.0.0" });

  // ── Account management ────────────────────────────────────────────────────
  server.tool(
    "create_account",
    "Create a new FinApp user account. Returns a personal API key to use in future requests.",
    { username: z.string().describe("A unique username for this account") },
    async ({ username }) => {
      const newUser = await createUser(username);
      return {
        content: [{
          type: "text",
          text: `Account created!\n\nUsername: ${newUser.username}\nAPI Key: ${newUser.api_key}\n\nUpdate your Claude Desktop MCP config to add:\n"x-api-key": "${newUser.api_key}"`,
        }],
      };
    }
  );

  server.tool("list_accounts", "List all FinApp user accounts", {}, async () => {
    const users = await listUsers();
    return { content: [{ type: "text", text: JSON.stringify(users, null, 2) }] };
  });

  // All tools below require a valid user
  const requireUser = (fn) => async (args) => {
    if (!user) return { content: [{ type: "text", text: "No account found. Please add your x-api-key to the MCP config, or create an account first with create_account." }] };
    return fn(args, user);
  };

  server.tool(
    "get_bank_link_url",
    "Generate a URL to open in your browser to connect a bank account via Plaid",
    {},
    requireUser(async (_, u) => {
      const sessionId = await createLinkSession(u.id);
      const url = `${APP_URL}/link?session=${sessionId}`;
      return {
        content: [{
          type: "text",
          text: `Open this URL in your browser to connect a bank account:\n\n${url}\n\nThe link expires in 30 minutes. After connecting, come back and ask me to sync your transactions.`,
        }],
      };
    })
  );

  server.tool(
    "list_linked_banks",
    "List all bank accounts currently linked to your FinApp account",
    {},
    requireUser(async (_, u) => {
      const items = await getUserItems(u.id);
      if (items.length === 0) return { content: [{ type: "text", text: "No banks linked yet. Use get_bank_link_url to connect one." }] };
      return { content: [{ type: "text", text: JSON.stringify(items.map(i => ({ itemId: i.itemId, institution: i.institutionName })), null, 2) }] };
    })
  );

  server.tool(
    "remove_bank",
    "Remove a linked bank account",
    { item_id: z.string().describe("The item_id of the bank to remove (from list_linked_banks)") },
    requireUser(async ({ item_id }, u) => {
      const removed = await removeUserItem(u.id, item_id);
      return { content: [{ type: "text", text: removed ? `Bank ${item_id} removed.` : "Bank not found." }] };
    })
  );

  server.tool(
    "sync_transactions",
    "Pull the latest transactions from Plaid and store them in the database",
    {},
    requireUser(async (_, u) => {
      await syncTransactions(u.id);
      return { content: [{ type: "text", text: "Sync complete. Your transactions are up to date." }] };
    })
  );

  server.tool(
    "get_balances",
    "Get current balances for all linked bank accounts",
    {},
    requireUser(async (_, u) => {
      const items = await getUserItems(u.id);
      if (items.length === 0) return { content: [{ type: "text", text: "No banks linked yet." }] };
      const allAccounts = await Promise.all(
        items.map(async ({ accessToken, institutionName }) => {
          const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
          return r.data.accounts.map((a) => ({
            institution: institutionName,
            name: a.name,
            type: a.subtype,
            balance: a.balances.current,
            available: a.balances.available,
          }));
        })
      );
      return { content: [{ type: "text", text: JSON.stringify(allAccounts.flat(), null, 2) }] };
    })
  );

  server.tool(
    "get_transactions",
    "Get transactions from the database with optional filters",
    {
      limit: z.number().optional().describe("Max transactions to return (default 50)"),
      start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD"),
      category: z.string().optional().describe("Filter by category"),
    },
    requireUser(async ({ limit = 50, start_date, end_date, category }, u) => {
      const txns = await getTransactions(u.id, { limit, startDate: start_date, endDate: end_date, category });
      return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }] };
    })
  );

  server.tool(
    "get_spending_by_category",
    "Get a summary of spending grouped by category",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD"),
    },
    requireUser(async ({ start_date, end_date }, u) => {
      const summary = await getSpendingByCategory(u.id, { startDate: start_date, endDate: end_date });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    })
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
