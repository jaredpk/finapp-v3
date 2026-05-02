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
import xlsxLib from "xlsx";
import {
  initDb,
  getApiKeyForUser, createApiKey, getClerkUserIdByApiKey,
  createLinkSession, getLinkSession, deleteLinkSession,
  getUserItems, upsertUserItem, removeUserItem,
  getCursor, saveCursor, upsertTransactions,
  getTransactions, getSpendingByCategory,
  deleteRemovedTransactions, populateSuggestedCategories, applySuggestedCategories,
  findDuplicateTransactions, deduplicateTransactions,
  saveOAuthState, getOAuthState, deleteOAuthState,
  saveOAuthCode, getOAuthCode, deleteOAuthCode,
  seedCategories,
  getCategories, createCategory, updateCategory, deleteCategory,
  getAssignments, upsertAssignment,
  getSplits, createSplit, deleteSplit, deleteSplitsForTransaction,
  getMerchantOverrides, upsertMerchantOverride,
  parseCsvText, upsertCsvTransaction,
  parseXlsxBase64,
  upsertImportedTransaction, deleteImportedTransactions,
  upsertAccountBalances, getLatestBalances,
  upsertInvestmentHoldings, getLatestHoldings,
  getProperties, upsertProperty, deleteProperty, updatePropertyValue, setPropertyBaseline,
  getManualAccounts, upsertManualAccount, deleteManualAccount,
  getCashflowPresets, upsertCashflowPreset, getCashflowStates, upsertCashflowState,
  getCashflowMappings, upsertCashflowMapping, parseMacuCsvText,
  getAccountNicknames, upsertAccountNickname, deleteAccountNickname,
} from "./db.js";
import pool from "./db.js";

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

      // 1. Delete transactions Plaid says are removed
      const removedIds = (r.data.removed || []).map((t) => t.transaction_id).filter(Boolean);
      if (removedIds.length > 0) await deleteRemovedTransactions(removedIds);

      // 2. Delete stale pending rows that have now posted (avoid duplicates)
      const stalePendingIds = [...(r.data.added || []), ...(r.data.modified || [])]
        .map((t) => t.pending_transaction_id)
        .filter(Boolean);
      if (stalePendingIds.length > 0) await deleteRemovedTransactions(stalePendingIds);

      // 3. Upsert added and modified
      await upsertTransactions(r.data.added || []);
      await upsertTransactions(r.data.modified || []);

      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }
    await saveCursor(itemId, cursor);
  }
}

// ── FHFA property value drift ─────────────────────────────────────────────────
const FHFA_CSV_URL = "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_metro.csv";
let fhfaCache = null;
let fhfaCacheTime = 0;
const FHFA_CACHE_TTL = 24 * 60 * 60 * 1000;

function parseCsvRow(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { cols.push(cur.trim()); cur = ""; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

async function fetchFHFAData() {
  if (fhfaCache && Date.now() - fhfaCacheTime < FHFA_CACHE_TTL) return fhfaCache;
  const r = await fetch(FHFA_CSV_URL);
  if (!r.ok) throw new Error(`FHFA fetch failed: HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.split("\n");
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvRow(line);
    if (cols.length < 5) continue;
    const msaCode = parseInt(cols[1]);
    const year = parseInt(cols[2]);
    const quarter = parseInt(cols[3]);
    const indexVal = parseFloat(cols[4]);
    if (!msaCode || isNaN(year) || isNaN(quarter) || isNaN(indexVal)) continue;
    if (!data[msaCode]) data[msaCode] = [];
    data[msaCode].push({ year, quarter, index: indexVal });
  }
  fhfaCache = data;
  fhfaCacheTime = Date.now();
  return data;
}

async function getLatestFHFAIndex(msaCode) {
  const data = await fetchFHFAData();
  const entries = data[msaCode];
  if (!entries || entries.length === 0) throw new Error(`MSA ${msaCode} not found in FHFA data`);
  return entries.sort((a, b) => a.year !== b.year ? b.year - a.year : b.quarter - a.quarter)[0];
}

async function applyFHFADrift() {
  const props = await getProperties();
  const toUpdate = props.filter((p) => p.fhfa_msa && p.baseline_value != null && p.baseline_fhfa_index != null);
  if (toUpdate.length === 0) return { updated: 0, results: [] };
  let updated = 0;
  const results = [];
  for (const p of toUpdate) {
    try {
      const latest = await getLatestFHFAIndex(p.fhfa_msa);
      const driftedValue = Math.round(p.baseline_value * (latest.index / p.baseline_fhfa_index));
      await updatePropertyValue(p.id, driftedValue);
      updated++;
      results.push({ id: p.id, address: p.address, ok: true, value: driftedValue, year: latest.year, quarter: latest.quarter });
    } catch (err) {
      console.error(`FHFA drift error [${p.address}]:`, err.message);
      results.push({ id: p.id, address: p.address, ok: false, error: err.message });
    }
  }
  return { updated, results };
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
const ACCOUNT_TYPE_MAP = {
  checking:     "depository",
  savings:      "depository",
  brokerage:    "investment",
  investment:   "investment",
  ira:          "investment",
  "401k":       "investment",
  "401(k)":     "investment",
  roth:         "investment",
  "credit card":"credit",
  credit:       "credit",
  mortgage:     "loan",
  auto:         "loan",
  loan:         "loan",
  heloc:        "loan",
};

function normalizePlaidType(rawType) {
  const lower = (rawType || "").toLowerCase();
  const match = Object.keys(ACCOUNT_TYPE_MAP).find((k) => lower.includes(k));
  return match ? ACCOUNT_TYPE_MAP[match] : "other";
}

app.get("/api/accounts", requireAuth, async (req, res) => {
  const items = await getUserItems();
  const nicknames = await getAccountNicknames();
  const applyNicknames = (accts) =>
    accts.map((a) => nicknames[a.account_id] ? { ...a, name: nicknames[a.account_id], official_name: a.official_name || a.name } : a);

  if (items.length > 0) {
    try {
      const allAccounts = await Promise.all(
        items.map(async ({ accessToken, itemId, institutionName }) => {
          const r = await plaidClient.accountsBalanceGet({ access_token: accessToken });
          return r.data.accounts.map((a) => ({ ...a, institutionName, itemId }));
        })
      );
      return res.json({ accounts: applyNicknames(allAccounts.flat()) });
    } catch (err) {
      console.error("Plaid accounts error, falling back to balance snapshot:", err.message);
    }
  }

  // Fall back to latest imported balance snapshot
  const [balRows, holdingRows] = await Promise.all([getLatestBalances(), getLatestHoldings()]);
  if (!balRows.length && !holdingRows.length) return res.json({ accounts: [] });

  const accounts = balRows.map((r) => {
    const type = normalizePlaidType(r.type);
    const isLiability = type === "credit" || type === "loan";
    // Imported balances store liabilities as negative; normalize to Plaid convention
    // (positive = amount owed) so the Dashboard net worth formula works consistently.
    const current = isLiability ? Math.abs(parseFloat(r.balance)) : parseFloat(r.balance);
    const available = r.available != null ? Math.abs(parseFloat(r.available)) : null;
    return {
      account_id: `balance_${r.institution}_${r.account}`,
      name: r.account,
      official_name: r.account,
      type,
      subtype: r.type || type,
      balances: { current, available },
      institutionName: r.institution,
      mask: null,
    };
  });

  // Roll up investment holdings into synthetic investment accounts for any
  // institution not already covered by account_balances (e.g. eTrade).
  // Group by account name first (distinguishes multiple accounts at same institution),
  // falling back to institution name.  Skip rows with neither.
  // Strip non-alphanumeric chars (e.g. "E*TRADE" → "etrade") so name variants match.
  const normInst = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isSummaryTicker = (t) => /total|count|change|\btoday\b|portfolio|holding/i.test(t || "");
  const coveredInstitutions = new Set(balRows.map((r) => normInst(r.institution)));
  const holdingsByAcct = {};
  for (const h of holdingRows) {
    if (isSummaryTicker(h.ticker)) continue;
    const key = h.account || h.institution;
    if (!key) continue;
    if (!holdingsByAcct[key]) {
      holdingsByAcct[key] = {
        displayName: h.account || h.institution,
        institution: h.institution || h.account,
        value: 0,
      };
    }
    holdingsByAcct[key].value += parseFloat(h.value) || 0;
  }
  const holdingAccounts = Object.values(holdingsByAcct)
    .filter((g) => !coveredInstitutions.has(normInst(g.institution)))
    .map((g) => ({
      account_id: `holdings_${g.displayName}`,
      name: g.displayName,
      official_name: g.displayName,
      type: "investment",
      subtype: "brokerage",
      balances: { current: g.value, available: null },
      institutionName: g.institution,
      mask: null,
    }));

  // Add properties with known values as real-estate assets
  const propRows = await getProperties();
  const propertyAccounts = propRows
    .filter((p) => p.last_value != null)
    .map((p) => ({
      account_id: `property_${p.id}`,
      name: p.nickname || p.address,
      official_name: p.address,
      type: "other",
      subtype: "real estate",
      balances: { current: parseFloat(p.last_value), available: null },
      institutionName: "FHFA Estimate",
      mask: null,
    }));

  // Add manually-entered accounts (e.g. Paychex Flex retirement)
  const manualRows = await getManualAccounts();
  const manualAccounts = manualRows.map((m) => ({
    account_id: `manual_${m.id}`,
    name: m.name,
    official_name: m.name,
    type: "investment",
    subtype: m.subtype || "retirement",
    balances: { current: parseFloat(m.balance), available: null },
    institutionName: m.institution || "Manual",
    mask: null,
  }));

  res.json({
    accounts: applyNicknames([...accounts, ...holdingAccounts, ...propertyAccounts, ...manualAccounts]),
    snapshotDate: balRows[0]?.snapshot_date || holdingRows[0]?.snapshot_date,
  });
});

// ── Account nicknames ─────────────────────────────────────────────────────────
app.post("/api/account-nicknames", requireAuth, async (req, res) => {
  const { account_id, nickname } = req.body;
  if (!account_id || !nickname?.trim()) return res.status(400).json({ error: "account_id and nickname required" });
  await upsertAccountNickname(account_id, nickname.trim());
  res.json({ ok: true });
});

app.delete("/api/account-nicknames/:accountId", requireAuth, async (req, res) => {
  await deleteAccountNickname(decodeURIComponent(req.params.accountId));
  res.json({ ok: true });
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

// ── Apply suggested categories (called after Perplexity sync) ─────────────────
app.post("/api/apply-suggested-categories", requireApiKeyOrAuth, async (req, res) => {
  try {
    const populated = await populateSuggestedCategories();
    const assigned  = await applySuggestedCategories();
    res.json({ populated, assigned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to apply suggested categories" });
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
  const { replacementId } = req.body || {};
  const ok = await deleteCategory(req.params.id, replacementId || null);
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

// ── CSV Import (Perplexity 90-day export) ─────────────────────────────────────
app.post("/api/import-csv", requireApiKeyOrAuth, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") return res.status(400).json({ error: "csv string required" });
    const rows = parseCsvText(csv);
    let imported = 0;
    for (const row of rows) {
      if (await upsertCsvTransaction(row)) imported++;
    }
    res.json({ imported, skipped: rows.length - imported });
  } catch (err) {
    console.error("CSV import error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── MACU CSV Import (Mountain America exportedtransactions.csv) ───────────────
app.post("/api/import-macu-csv", requireAuth, async (req, res) => {
  try {
    const { csv, accountName } = req.body;
    if (!csv || typeof csv !== "string") return res.status(400).json({ error: "csv string required" });
    const rows = parseMacuCsvText(csv, accountName || "MACU Shared Checking");
    let imported = 0;
    for (const row of rows) {
      if (await upsertCsvTransaction(row)) imported++;
    }
    res.json({ imported, skipped: rows.length - imported });
  } catch (err) {
    console.error("MACU CSV import error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/import-xlsx", requireApiKeyOrAuth, async (req, res) => {
  try {
    const { xlsx, snapshot_date } = req.body;
    if (!xlsx || typeof xlsx !== "string") return res.status(400).json({ error: "xlsx base64 string required" });
    const { transactions, balances, holdings, snapshotDate } = parseXlsxBase64(xlsx, snapshot_date);
    let imported = 0;
    for (const row of transactions) {
      if (await upsertCsvTransaction(row)) imported++;
    }
    if (balances.length) await upsertAccountBalances(snapshotDate, balances);
    if (holdings.length) await upsertInvestmentHoldings(snapshotDate, holdings);
    res.json({ imported, skipped: transactions.length - imported, balances: balances.length, holdings: holdings.length, snapshot_date: snapshotDate });
  } catch (err) {
    console.error("XLSX import error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/account-balances", requireAuth, async (req, res) => {
  const rows = await getLatestBalances();
  res.json(rows);
});

app.get("/api/investment-holdings", requireAuth, async (req, res) => {
  const rows = await getLatestHoldings();
  res.json(rows);
});

// ── Export XLSX (same format as import) ──────────────────────────────────────
app.get("/api/export-xlsx", requireAuth, async (req, res) => {
  try {
    const { utils, write } = xlsxLib;
    const [balRows, holdingRows, txnRows] = await Promise.all([
      getLatestBalances(),
      getLatestHoldings(),
      getTransactions({ limit: 1000 }),
    ]);

    const wb = utils.book_new();

    // Account Balances sheet
    const balData = [
      ["Account", "Institution", "Type", "Balance (USD)", "Available (USD)"],
      ...balRows.map((r) => [
        r.account,
        r.institution ?? "",
        r.type ?? "",
        parseFloat(r.balance),
        r.available != null ? parseFloat(r.available) : "",
      ]),
    ];
    utils.book_append_sheet(wb, utils.aoa_to_sheet(balData), "Account Balances");

    // Investment Holdings sheet
    const holdData = [
      ["Ticker", "Institution", "Account", "Value (USD)", "Day Chg %", "Gain/Loss (USD)", "Gain/Loss %"],
      ...holdingRows.map((r) => [
        r.ticker,
        r.institution ?? "",
        r.account ?? "",
        parseFloat(r.value),
        r.day_change ?? "",
        r.gain_loss != null ? parseFloat(r.gain_loss) : "",
        r.gain_loss_pct ?? "",
      ]),
    ];
    utils.book_append_sheet(wb, utils.aoa_to_sheet(holdData), "Investment Holdings");

    // Transactions sheet
    const txnData = [
      ["Date", "Merchant", "Category", "Amount (USD)", "Account"],
      ...txnRows.map((t) => [
        t.date,
        t.merchant_name ?? "",
        t.category ?? "",
        t.amount,
        t.account_id ?? "",
      ]),
    ];
    utils.book_append_sheet(wb, utils.aoa_to_sheet(txnData), "Transactions");

    const snapshotDate = balRows[0]?.snapshot_date ?? new Date().toISOString().slice(0, 10);
    const buf = write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="finapp-${snapshotDate}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Properties (FHFA) ────────────────────────────────────────────────────────
app.get("/api/properties", requireAuth, async (req, res) => {
  const props = await getProperties();
  res.json({ properties: props });
});

app.post("/api/properties", requireAuth, async (req, res) => {
  const { id, address, nickname } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  const prop = await upsertProperty(id || null, address, nickname);
  res.json({ property: prop });
});

app.delete("/api/properties/:id", requireAuth, async (req, res) => {
  const ok = await deleteProperty(req.params.id);
  res.json({ ok });
});

app.post("/api/properties/sync", requireAuth, async (req, res) => {
  try {
    const { updated, results } = await applyFHFADrift();
    res.json({ synced: updated, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/properties/:id/baseline", requireAuth, async (req, res) => {
  const { value, msa } = req.body;
  if (!value || isNaN(parseFloat(value))) return res.status(400).json({ error: "value required" });
  const props = await getProperties();
  const prop = props.find((p) => p.id === parseInt(req.params.id));
  if (!prop) return res.status(404).json({ error: "Property not found" });
  const msaCode = msa ? parseInt(msa) : prop.fhfa_msa;
  if (!msaCode) return res.status(400).json({ error: "msa required for first baseline" });
  try {
    const latest = await getLatestFHFAIndex(msaCode);
    await setPropertyBaseline(prop.id, parseFloat(value), msaCode, latest.index);
    const updated = await getProperties();
    res.json({ property: updated.find((p) => p.id === prop.id), fhfa: { year: latest.year, quarter: latest.quarter, index: latest.index } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Manual accounts ───────────────────────────────────────────────────────────
app.get("/api/manual-accounts", requireAuth, async (req, res) => {
  const rows = await getManualAccounts();
  res.json({ accounts: rows });
});

app.post("/api/manual-accounts", requireAuth, async (req, res) => {
  const { id, name, institution, subtype, balance } = req.body;
  if (!name || balance == null) return res.status(400).json({ error: "name and balance are required" });
  const account = await upsertManualAccount(id || null, name, institution, subtype, balance);
  res.json({ account });
});

app.delete("/api/manual-accounts/:id", requireAuth, async (req, res) => {
  await deleteManualAccount(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Deduplication ─────────────────────────────────────────────────────────────
app.get("/api/deduplicate/debug", requireAuth, async (req, res) => {
  const [sample, idStats, dupeRows] = await Promise.all([
    pool.query(`SELECT id, date, amount::float, merchant, account, created_at FROM transactions ORDER BY date DESC, created_at DESC LIMIT 20`),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE id LIKE 'simplifi_%') AS simplifi,
        COUNT(*) FILTER (WHERE id ~ '^[0-9a-f-]{36}$') AS uuid,
        COUNT(*) FILTER (WHERE id NOT LIKE 'simplifi_%' AND id !~ '^[0-9a-f-]{36}$') AS plaid,
        COUNT(*) AS total
      FROM transactions`),
    pool.query(`
      SELECT date, ROUND(ABS(amount)::numeric,2) AS abs_amount, COUNT(*) AS cnt,
             array_agg(id ORDER BY created_at) AS ids,
             array_agg(merchant ORDER BY created_at) AS merchants,
             array_agg(account ORDER BY created_at) AS accounts,
             array_agg(amount::float ORDER BY created_at) AS amounts
      FROM transactions
      GROUP BY date, ROUND(ABS(amount)::numeric,2)
      HAVING COUNT(*) > 1
      ORDER BY date DESC LIMIT 20`),
  ]);
  res.json({ sample: sample.rows, idStats: idStats.rows[0], dupeRows: dupeRows.rows });
});

app.get("/api/deduplicate", requireAuth, async (req, res) => {
  const dupes = await findDuplicateTransactions();
  const toRemove = dupes.reduce((n, d) => n + d.remove.length, 0);
  res.json({ groups: dupes.length, toRemove, preview: dupes });
});

app.post("/api/deduplicate", requireAuth, async (req, res) => {
  const { groups } = req.body || {};
  const deleted = await deduplicateTransactions(groups ?? undefined);
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

  server.tool("get_balances", "Get current account balances. Uses the latest CSV-imported snapshot when available (real data); falls back to Plaid sandbox balances otherwise.", {}, async () => {
    const dbRows = await getLatestBalances();
    if (dbRows.length) {
      const { snapshot_date } = dbRows[0];
      const accounts = dbRows.map(r => ({
        account: r.account,
        institution: r.institution,
        type: r.type,
        balance: parseFloat(r.balance),
        available: r.available != null ? parseFloat(r.available) : null,
      }));
      return { content: [{ type: "text", text: `Balances as of ${snapshot_date}:\n${JSON.stringify(accounts, null, 2)}` }] };
    }
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

  server.tool("import_csv", "Import transactions from a Perplexity CSV export. Safe to re-run — identical rows produce the same hash ID and are upserted without duplication. Rows already covered by a Plaid-synced transaction (same date + amount) are silently skipped, so no manual dedup is needed afterward.", {
    csv: z.string().describe("Full text of the Perplexity CSV export (including the # Date Range header line)"),
  }, async ({ csv }) => {
    const rows = parseCsvText(csv);
    let imported = 0;
    for (const row of rows) {
      if (await upsertCsvTransaction(row)) imported++;
    }
    const skipped = rows.length - imported;
    const msg = skipped > 0
      ? `Imported ${imported} transactions (skipped ${skipped} already covered by Plaid). Re-running with the same CSV is safe.`
      : `Imported ${imported} transactions. Re-running with the same CSV is safe.`;
    return { content: [{ type: "text", text: msg }] };
  });

  server.tool("import_xlsx", "Import transactions and account balances from a dual-tab Excel export. Pass the file content as a base64 string. Safe to re-run — transactions already in Plaid are skipped, and the balance snapshot for the given date is replaced.", {
    xlsx: z.string().describe("Base64-encoded .xlsx file with an 'Account Balances' sheet and a 'Transactions' sheet"),
    snapshot_date: z.string().optional().describe("YYYY-MM-DD date to tag the balance snapshot (defaults to today)"),
  }, async ({ xlsx, snapshot_date }) => {
    const { transactions, balances, holdings, snapshotDate } = parseXlsxBase64(xlsx, snapshot_date);
    let imported = 0;
    for (const row of transactions) {
      if (await upsertCsvTransaction(row)) imported++;
    }
    if (balances.length) await upsertAccountBalances(snapshotDate, balances);
    if (holdings.length) await upsertInvestmentHoldings(snapshotDate, holdings);
    const skipped = transactions.length - imported;
    const parts = [`Imported ${imported} transaction${imported !== 1 ? 's' : ''}`];
    if (skipped) parts.push(`skipped ${skipped} already covered by Plaid`);
    if (balances.length) parts.push(`saved ${balances.length} account balances as of ${snapshotDate}`);
    if (holdings.length) parts.push(`saved ${holdings.length} investment holdings as of ${snapshotDate}`);
    return { content: [{ type: "text", text: parts.join(' · ') + '. Re-running is safe.' }] };
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

// ── Cashflow presets + states ─────────────────────────────────────────────────
app.get("/api/cashflow/presets", requireAuth, async (req, res) => {
  try {
    res.json(await getCashflowPresets());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/cashflow/presets", requireAuth, async (req, res) => {
  try {
    const { name, amount, freq, note } = req.body;
    await upsertCashflowPreset(name, parseFloat(amount), freq, note);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/cashflow/states/:monthKey", requireAuth, async (req, res) => {
  try {
    res.json(await getCashflowStates(req.params.monthKey));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cashflow/states", requireAuth, async (req, res) => {
  try {
    const { accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay } = req.body;
    await upsertCashflowState(accountId, txnId, monthKey, isPending, actualAmount ?? null, plaidTxnId ?? null, actualDay ?? null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/cashflow/mappings", requireAuth, async (req, res) => {
  try {
    res.json(await getCashflowMappings());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cashflow/mappings", requireAuth, async (req, res) => {
  try {
    const { merchantPattern, accountId, txnName } = req.body;
    await upsertCashflowMapping(merchantPattern, accountId, txnName);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
if (isProd) {
  app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../client/dist/index.html")));
}

const PORT = process.env.PORT || 3001;
initDb().then(async () => {
  try {
    const removed = await deduplicateTransactions();
    if (removed > 0) console.log(`Startup dedup: removed ${removed} duplicate transactions`);
  } catch (e) {
    console.error("Startup dedup failed (non-fatal):", e.message);
  }
  // Apply FHFA drift to properties with baselines (non-blocking)
  applyFHFADrift().then(({ updated, results }) => {
    if (updated > 0) console.log(`Startup: applied FHFA drift to ${updated} property value(s)`);
    results.filter((r) => !r.ok).forEach((r) => console.error(`Startup FHFA drift failed [${r.address}]: ${r.error}`));
  }).catch((e) => console.error("Startup FHFA drift failed (non-fatal):", e.message));
  app.listen(PORT, () => console.log(`FinApp server running on :${PORT}`));
});
