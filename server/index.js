import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

const app = express();
app.use(cors({ origin: isProd ? false : "http://localhost:5173" }));
app.use(express.json());

// Serve built React app in production
if (isProd) {
  const clientDist = path.join(__dirname, "../client/dist");
  app.use(express.static(clientDist));
}

// ── Plaid client setup ────────────────────────────────────────────────────────
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

// In-memory store (replace with a real DB in production)
const userItems = {}; // userId -> [{ accessToken, itemId }]

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

    if (!userItems[userId]) userItems[userId] = [];
    if (!userItems[userId].find((i) => i.itemId === item_id)) {
      userItems[userId].push({ accessToken: access_token, itemId: item_id });
    }

    res.json({ success: true, item_id });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  const userId = req.query.userId || "demo-user";
  const items = userItems[userId] || [];

  try {
    const allAccounts = await Promise.all(
      items.map(async ({ accessToken, itemId }) => {
        const r = await plaidClient.accountsGet({ access_token: accessToken });
        return r.data.accounts.map((a) => ({
          ...a,
          institution: r.data.item.institution_id,
          itemId,
        }));
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
  const items = userItems[userId] || [];

  try {
    const allTxns = await Promise.all(
      items.map(async ({ accessToken }) => {
        let transactions = [];
        let hasMore = true;
        let cursor = undefined;

        while (hasMore) {
          const r = await plaidClient.transactionsSync({
            access_token: accessToken,
            cursor,
          });
          transactions = transactions.concat(r.data.added);
          hasMore = r.data.has_more;
          cursor = r.data.next_cursor;
        }
        return transactions;
      })
    );

    const flat = allTxns
      .flat()
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions: flat });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// ── Balance ───────────────────────────────────────────────────────────────────
app.get("/api/balance", async (req, res) => {
  const userId = req.query.userId || "demo-user";
  const items = userItems[userId] || [];

  try {
    const allBalances = await Promise.all(
      items.map(async ({ accessToken }) => {
        const r = await plaidClient.accountsBalanceGet({
          access_token: accessToken,
        });
        return r.data.accounts;
      })
    );
    res.json({ accounts: allBalances.flat() });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ── SPA fallback — must be last ───────────────────────────────────────────────
if (isProd) {
  app.get("*", (_, res) => {
    res.sendFile(path.join(__dirname, "../client/dist/index.html"));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FinApp server running on :${PORT}`));
