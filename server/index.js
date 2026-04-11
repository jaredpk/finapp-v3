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
  initDb, getUserItems, upsertUserItem,
  getCursor, saveCursor, upsertTransactions,
  getTransactions, getSpendingByCategory,
} from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

const app = express();
app.use(cors({ origin: isProd ? false : "http://localhost:5173" }));
app.use(express.json());

if (isProd) {
  const clientDist = path.join(__dirname, "../client/dist");
  app.use(express.static(clientDist));
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

// ── Sync transactions for a user (called after link + on demand) ──────────────
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

// ── Link token ────────────────────────────────────────────────────────────────
app.post("/api/create_link_token", async (req, res) => {
  const { userId = "demo-user" } = req.body;
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
  const { public_token, userId = "demo-user" } = req.body;
  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const { access_token, item_id } = response.data;
    await upsertUserItem(userId, access_token, item_id);
    await syncTransactions(userId);
    res.json({ success: true, item_id });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  const userId = req.query.userId || "demo-user";
  const items = await getUserItems(userId);
  try {
    const allAccounts = await Promise.all(
      items.map(async ({ accessToken, itemId }) => {
        const r = await plaidClient.accountsGet({ access_token: accessToken });
        return r.data.accounts.map((a) => ({ ...a, institution: r.data.item.institution_id, itemId }));
      })
    );
    res.json({ accounts: allAccounts.flat() });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// ── Transactions ──────────────────────────────────────────────────────────────
app.get("/api/transactions", async (req, res) => {
  const userId = req.query.userId || "demo-user";
  try {
    const transactions = await getTransactions(userId, { limit: 200 });
    res.json({ transactions });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── Balance ───────────────────────────────────────────────────────────────────
app.get("/api/balance", async (req, res) => {
  const userId = req.query.userId || "demo-user";
  const items = await getUserItems(userId);
  try {
    const allBalances = await Promise.all(
      items.map(async ({ accessToken }) => {
        const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
        return r.data.accounts;
      })
    );
    res.json({ accounts: allBalances.flat() });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

// ── Manual sync ───────────────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  const { userId = "demo-user" } = req.body;
  try {
    await syncTransactions(userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Sync failed" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── MCP Server ────────────────────────────────────────────────────────────────
const MCP_SECRET = process.env.MCP_SECRET;

function mcpAuth(req, res, next) {
  if (MCP_SECRET && req.headers["x-mcp-secret"] !== MCP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.post("/mcp", mcpAuth, async (req, res) => {
  const userId = req.headers["x-user-id"] || "demo-user";

  const server = new McpServer({ name: "finapp", version: "1.0.0" });

  server.tool("get_accounts", "Get all linked bank accounts and their current balances", {}, async () => {
    const items = await getUserItems(userId);
    const allAccounts = await Promise.all(
      items.map(async ({ accessToken, itemId }) => {
        const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
        return r.data.accounts.map((a) => ({
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          balance: a.balances.current,
          available: a.balances.available,
          institution: r.data.item.institution_id,
        }));
      })
    );
    return { content: [{ type: "text", text: JSON.stringify(allAccounts.flat(), null, 2) }] };
  });

  server.tool(
    "get_transactions",
    "Get transactions from the database. Optionally filter by date range or category.",
    {
      limit: z.number().optional().describe("Max number of transactions to return (default 50)"),
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      end_date: z.string().optional().describe("End date in YYYY-MM-DD format"),
      category: z.string().optional().describe("Filter by category (e.g. 'FOOD_AND_DRINK')"),
    },
    async ({ limit = 50, start_date, end_date, category }) => {
      const txns = await getTransactions(userId, { limit, startDate: start_date, endDate: end_date, category });
      return { content: [{ type: "text", text: JSON.stringify(txns, null, 2) }] };
    }
  );

  server.tool(
    "get_spending_by_category",
    "Get a summary of spending grouped by category",
    {
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format"),
      end_date: z.string().optional().describe("End date in YYYY-MM-DD format"),
    },
    async ({ start_date, end_date }) => {
      const summary = await getSpendingByCategory(userId, { startDate: start_date, endDate: end_date });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool("sync_transactions", "Pull the latest transactions from Plaid and store them", {}, async () => {
    await syncTransactions(userId);
    return { content: [{ type: "text", text: "Sync complete." }] };
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
if (isProd) {
  app.get("*", (_, res) => {
    res.sendFile(path.join(__dirname, "../client/dist/index.html"));
  });
}

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => console.log(`FinApp server running on :${PORT}`));
});
