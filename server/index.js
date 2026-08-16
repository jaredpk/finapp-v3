import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verifyPortalAssertion } from "./auth.js";
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
  clearCursors, listTransactionIds, getTransactionsByIds,
  getTransactions, getVisibleTransactions, getSpendingByCategory, getReportSummary,
  deleteRemovedTransactions, populateSuggestedCategories, applySuggestedCategories,
  findDuplicateTransactions, deduplicateTransactions,
  getSuppressions, recordSuppression, tryAdvisoryLock, releaseAdvisoryLock,
  saveOAuthState, getOAuthState, deleteOAuthState,
  saveOAuthCode, getOAuthCode, deleteOAuthCode,
  seedCategories,
  getCategories, createCategory, updateCategory, deleteCategory,
  getAssignments, upsertAssignment,
  getSplits, createSplit, deleteSplit, deleteSplitsForTransaction, deleteTransaction, unhideTransaction, replaceSplits,
  getHiddenAccounts, addHiddenAccount, removeHiddenAccount,
  getMerchantOverrides, upsertMerchantOverride,
  parseCsvText, upsertCsvTransaction,
  parseXlsxBase64, upsertPlaidTransactions,
  upsertImportedTransaction, deleteImportedTransactions, getImportedTransactionAccounts,
  upsertAccountBalances, getLatestBalances, getBalanceRowCounts, deleteImportedAccountBalances, buildImportedAccountIds,
  upsertInvestmentHoldings, getLatestHoldings,
  getProperties, upsertProperty, deleteProperty, updatePropertyValue, setPropertyBaseline,
  getVehicles, upsertVehicle, deleteVehicle, setVehicleBaseline, applyVehicleDepreciation,
  getManualAccounts, upsertManualAccount, deleteManualAccount,
  getCashflowPresets, upsertCashflowPreset, deleteCashflowPreset, getCashflowStates, upsertCashflowState,
  getCashflowMappings, upsertCashflowMapping,
  parseSimplifiCsv, isJunkSimplifiCategory, getSimplifiMappings, saveSimplifiMappings,
  getSimplifiAccountMappings, saveSimplifiAccountMappings,
  getAccountNicknames, upsertAccountNickname, deleteAccountNickname,
  getLastAuditLog, saveAuditLog, updateAuditInsertedCount, completeAuditLog,
  getTransactionDateAmountSet, parseAuditXlsx,
  reviewTransactions, unreviewTransaction, getGmailRefreshToken,
} from "./db.js";
import pool from "./db.js";
import { gmailConfigured, getGmailAuthUrl, exchangeGmailAuthCode, gmailConnected } from "./gmail.js";
import { receiptScanConfigured, runReceiptScan } from "./receiptScan.js";
import { askAiConfigured, runAskLoop, createGeminiGenerate, impl as askAiImpl } from "./askAi.js";
import { findUnmatchedPaymentLegs } from "./transactionMatching.js";
import { registerPropertyFinanceRoutes } from "./property/routes.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
const APP_URL = process.env.APP_URL || "http://localhost:3001";
const ALLOWED_EMAIL = "jaredpk@gmail.com";

// ── Supabase admin client (for JWT verification) ──────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
);

// Where the browser-facing app is mounted on portal.elevrics.ai. The portal
// forwards this prefix intact (it does NOT strip it, unlike the Flask and
// Express modules) so Vite's `base` can generate matching asset URLs and the
// service worker gets a correct scope. Stripping it here keeps every route
// below registered at root, which is also what machine callers use:
// /api/webhooks/plaid, /mcp and /oauth/* are hit unprefixed on the Fly
// hostname and are unaffected by this.
const URL_PREFIX = (process.env.URL_PREFIX || "/finance").replace(/\/$/, "");

const app = express();

app.use((req, _res, next) => {
  if (URL_PREFIX && (req.url === URL_PREFIX || req.url.startsWith(`${URL_PREFIX}/`))) {
    req.url = req.url.slice(URL_PREFIX.length) || "/";
  }
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    const allowed = !origin || origin.includes("claude.ai") || origin.includes("localhost") || origin.includes("anthropic.com");
    cb(null, allowed ? origin || "*" : false);
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));

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
// Four callers can fire this: the Plaid webhook, machine startup, the daily
// timer and the manual button. Overlapping runs advance the same cursor twice
// and race each other's upserts, so the whole body is serialized behind one
// advisory lock — a second sync is redundant with the one already running.
const SYNC_LOCK_KEY = 4820147;

// The lock-free core. Only call it while holding SYNC_LOCK_KEY. The backfill
// replay calls it directly because clearing cursors and syncing has to be one
// indivisible step — a sync that slipped in between would consume the cleared
// cursors and perform the replay itself, invisibly.
async function syncTransactionsCore() {
  const items = await getUserItems();
  const today = new Date().toISOString().slice(0, 10);
  const allBalances = [];
  for (const { accessToken, itemId, institutionName } of items) {
    let cursor = await getCursor(itemId);
    let hasMore = true;
    let lastAccounts = [];
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

      if (r.data.accounts?.length) lastAccounts = r.data.accounts;
      cursor = r.data.next_cursor;
      hasMore = r.data.has_more;
    }
    await saveCursor(itemId, cursor);
    for (const a of lastAccounts) {
      allBalances.push({
        account: a.name,
        institution: institutionName,
        type: a.subtype || a.type,
        balance: a.balances.current,
        available: a.balances.available ?? null,
      });
    }
  }
  if (allBalances.length) await upsertAccountBalances(today, allBalances);
  return { ran: true, items: items.length };
}

// Returns { ran: false } when another sync holds the lock, so callers that need
// to know the work actually happened can tell that apart from "it ran and found
// nothing".
async function syncTransactions() {
  if (!(await tryAdvisoryLock(SYNC_LOCK_KEY))) {
    console.log("sync already in progress, skipping");
    return { ran: false };
  }
  try {
    return await syncTransactionsCore();
  } finally {
    await releaseAdvisoryLock(SYNC_LOCK_KEY);
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
// Browser-facing routes authenticate on the portal's assertion. The app carries
// no user model — ALLOWED_EMAIL is hardcoded and req._user is never read
// downstream — so the portal sign-in replaces the old Supabase login outright
// rather than sitting in front of it. One sign-in covers every module.
async function requireAuth(req, res, next) {
  const identity = await verifyPortalAssertion(req);

  if (!identity) {
    // Local development has no portal in front of it, so nothing mints an
    // assertion and every request would 401. Production always verifies, and
    // there is no environment variable that can switch that off on a deployed
    // instance — this gates real financial data, and the previous version could
    // be left unconfigured, which is the failure worth designing out rather
    // than documenting.
    if (!isProd) {
      req._user = { email: ALLOWED_EMAIL };
      return next();
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (identity.email !== ALLOWED_EMAIL) return res.status(403).json({ error: "Access denied" });

  req._user = identity;
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
    // Then as a Supabase JWT — still issued by the /oauth/* flow that external
    // MCP clients use, so this path stays.
    const { data: { user }, error } = await supabase.auth.getUser(bearerKey);
    if (!error && user && user.email === ALLOWED_EMAIL) {
      req._user = user;
      return next();
    }
  }
  // Finally, a browser arriving through the portal.
  const identity = await verifyPortalAssertion(req);
  if (identity && identity.email === ALLOWED_EMAIL) {
    req._user = identity;
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

registerPropertyFinanceRoutes(app, requireAuth);

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

// ── Who am I ──────────────────────────────────────────────────────────────────
// Replaces the Supabase session the UI used to read its identity from.
app.get("/api/me", requireAuth, (req, res) => res.json({ email: req._user.email }));

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
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      webhook: `${APP_URL}/api/webhooks/plaid`,
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
    const linkTokenRequest = {
      user: { client_user_id: 'jared' },
      client_name: "FinApp",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      webhook: `${APP_URL}/api/webhooks/plaid`,
    };
    if (process.env.PLAID_REDIRECT_URI) {
      linkTokenRequest.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// ── List linked institutions ──────────────────────────────────────────────────
app.get("/api/linked-institutions", requireAuth, async (req, res) => {
  const items = await getUserItems();
  res.json({ institutions: items.map(i => ({ itemId: i.itemId, institutionName: i.institutionName })) });
});

// ── Remove a linked institution ───────────────────────────────────────────────
app.delete("/api/linked-institutions/:itemId", requireAuth, async (req, res) => {
  const { itemId } = req.params;
  const items = await getUserItems();
  const item = items.find(i => i.itemId === itemId);
  if (!item) return res.status(404).json({ error: "Institution not found" });
  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
  } catch (_) {}
  await removeUserItem(itemId);
  await pool.query("DELETE FROM transaction_cursors WHERE item_id = $1", [itemId]);
  res.json({ ok: true });
});

// ── Create update link token (re-auth an existing item) ──────────────────────
app.post("/api/create_update_link_token", requireAuth, async (req, res) => {
  const { item_id } = req.body;
  if (!item_id) return res.status(400).json({ error: "item_id required" });
  const items = await getUserItems();
  const item = items.find((i) => i.itemId === item_id);
  if (!item) return res.status(404).json({ error: "item not found" });
  try {
    const linkTokenRequest = {
      user: { client_user_id: 'jared' },
      client_name: "FinApp",
      country_codes: [CountryCode.Us],
      language: "en",
      webhook: `${APP_URL}/api/webhooks/plaid`,
      access_token: item.accessToken,
    };
    if (process.env.PLAID_REDIRECT_URI) linkTokenRequest.redirect_uri = process.env.PLAID_REDIRECT_URI;
    const response = await plaidClient.linkTokenCreate(linkTokenRequest);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create update link token" });
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
    // Remove any existing item for the same institution with a different item_id
    // (happens when "Connect Bank" is used to re-link an already-connected institution)
    if (institutionName) {
      const existing = await getUserItems();
      for (const old of existing.filter(i => i.institutionName === institutionName && i.itemId !== item_id)) {
        await removeUserItem(old.itemId);
        await pool.query("DELETE FROM transaction_cursors WHERE item_id = $1", [old.itemId]);
        console.log(`Replaced duplicate item for ${institutionName} (old: ${old.itemId})`);
      }
    }
    await upsertUserItem(access_token, item_id, institutionName);
    syncTransactions().catch((e) => console.error("Post-link sync failed:", e.message));
    const acctResp = await plaidClient.accountsGet({ access_token });
    const newAccounts = acctResp.data.accounts.map((a) => ({ ...a, institutionName, itemId: item_id, source: "plaid" }));
    res.json({ success: true, newAccounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────
const ACCOUNT_TYPE_MAP = {
  checking:     "depository",
  savings:      "depository",
  "money market":"depository",
  hsa:          "depository",
  brokerage:    "investment",
  investment:   "investment",
  ira:          "investment",
  "401k":       "investment",
  "401(k)":     "investment",
  roth:         "investment",
  // After the investment keys on purpose: imported account types are free text,
  // and "Roth IRA CD" / "Vanguard Brokerage CD" are investment accounts first.
  cd:           "depository",
  "credit card":"credit",
  credit:       "credit",
  mortgage:     "loan",
  auto:         "loan",
  loan:         "loan",
  heloc:        "loan",
};

// Keys short enough to hide inside unrelated words are matched as whole words
// only: as a bare substring, "cd" turned "ABCD Fund" into a depository account.
const WHOLE_WORD_TYPE_KEYS = new Set(["cd"]);

function normalizePlaidType(rawType) {
  const lower = (rawType || "").toLowerCase();
  const match = Object.keys(ACCOUNT_TYPE_MAP).find((k) =>
    WHOLE_WORD_TYPE_KEYS.has(k) ? new RegExp(`\\b${k}\\b`).test(lower) : lower.includes(k)
  );
  return match ? ACCOUNT_TYPE_MAP[match] : "other";
}

app.get("/api/accounts", requireAuth, async (req, res) => {
  const [items, nicknames, balRows, holdingRows, propRows, manualRows, vehicleRows, balCountRows] = await Promise.all([
    getUserItems(), getAccountNicknames(), getLatestBalances(), getLatestHoldings(),
    getProperties(), getManualAccounts(), getVehicles(), getBalanceRowCounts(),
  ]);
  const applyNicknames = (accts) =>
    accts.map((a) => nicknames[a.account_id] ? { ...a, name: nicknames[a.account_id], official_name: a.official_name || a.name } : a);

  // Plaid live accounts — use allSettled so one bad item doesn't wipe the rest
  let plaidAccounts = [];
  let itemErrors = [];
  if (items.length > 0) {
    const results = await Promise.allSettled(
      items.map(async ({ accessToken, itemId, institutionName }) => {
        const r = await plaidClient.accountsGet({ access_token: accessToken });
        return r.data.accounts.map((a) => ({ ...a, institutionName, itemId, source: "plaid" }));
      })
    );
    plaidAccounts = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
    itemErrors = items
      .map(({ itemId, institutionName }, i) =>
        results[i].status === "rejected"
          ? { itemId, institutionName, error: results[i].reason?.response?.data?.error_code || results[i].reason?.message }
          : null
      )
      .filter(Boolean);
    for (const e of itemErrors) console.error(`Plaid accountsGet error [${e.institutionName}]:`, e.error);
  }

  // Imported balance snapshot accounts
  const balCounts = {};
  for (const c of balCountRows) balCounts[`${c.institution || ""}|${c.account}|${c.type || ""}`] = c.count;
  const importedAccountIds = buildImportedAccountIds(balRows);
  const importedAccounts = balRows.map((r, i) => {
    const type = normalizePlaidType(r.type);
    const isLiability = type === "credit" || type === "loan";
    const current = isLiability ? Math.abs(parseFloat(r.balance)) : parseFloat(r.balance);
    const available = r.available != null ? Math.abs(parseFloat(r.available)) : null;
    const account_id = importedAccountIds[i];
    return { account_id, name: r.account, official_name: r.account, type, subtype: r.type || type, balances: { current, available }, institutionName: r.institution, mask: null, source: "imported", snapshot_count: balCounts[`${r.institution || ""}|${r.account}|${r.type || ""}`] ?? null };
  });

  // Deduplicate imported accounts against live Plaid accounts (same institution + last-4 mask)
  const normInst = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const plaidMaskKeys = new Set(
    plaidAccounts
      .filter((pa) => pa.mask && pa.institutionName)
      .map((pa) => `${normInst(pa.institutionName)}|${pa.mask}`)
  );
  const maskSuffix = (name) => { const m = (name || "").match(/(\d{4})$/); return m ? m[1] : null; };
  const filteredImportedAccounts = importedAccounts.filter((ia) => {
    const mask = maskSuffix(ia.name);
    if (!mask || !ia.institutionName) return true;
    return !plaidMaskKeys.has(`${normInst(ia.institutionName)}|${mask}`);
  });

  // Investment holdings (skip institutions already in balance rows)
  const isSummaryTicker = (t) => /total|count|change|\btoday\b|portfolio|holding/i.test(t || "");
  const balInstitutions = new Set(balRows.map((r) => normInst(r.institution)));
  const isCoveredInst = (inst) => { const n = normInst(inst); return Array.from(balInstitutions).some((c) => n.startsWith(c) || c.startsWith(n)); };
  const holdingsByAcct = {};
  for (const h of holdingRows) {
    if (isSummaryTicker(h.ticker)) continue;
    const key = h.account || h.institution;
    if (!key) continue;
    if (!holdingsByAcct[key]) holdingsByAcct[key] = { displayName: h.account || h.institution, institution: h.institution || h.account, value: 0 };
    holdingsByAcct[key].value += parseFloat(h.value) || 0;
  }
  const holdingAccounts = Object.values(holdingsByAcct)
    .filter((g) => !isCoveredInst(g.institution))
    .map((g) => ({ account_id: `holdings_${g.displayName}`, name: g.displayName, official_name: g.displayName, type: "investment", subtype: "brokerage", balances: { current: g.value, available: null }, institutionName: g.institution, mask: null, source: "imported" }));

  // Properties
  const propertyAccounts = propRows
    .filter((p) => p.last_value != null)
    .map((p) => ({ account_id: `property_${p.id}`, name: p.nickname || p.address, official_name: p.address, type: "other", subtype: "real estate", balances: { current: parseFloat(p.last_value), available: null }, institutionName: "FHFA Estimate", mask: null, source: "property" }));

  // Manual accounts
  const manualAccounts = manualRows.map((m) => ({ account_id: `manual_${m.id}`, name: m.name, official_name: m.name, type: "investment", subtype: m.subtype || "retirement", balances: { current: parseFloat(m.balance), available: null }, institutionName: m.institution || "Manual", mask: null, source: "manual" }));

  // Vehicles (KBB-seeded, depreciation-drifted)
  const vehicleAccounts = vehicleRows
    .filter((v) => v.last_value != null)
    .map((v) => {
      const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
      return { account_id: `vehicle_${v.id}`, name: v.nickname || label, official_name: label, type: "other", subtype: "vehicle", balances: { current: parseFloat(v.last_value), available: null }, institutionName: "KBB Estimate", mask: null, source: "vehicle" };
    });

  const snapshotDate = balRows[0]?.snapshot_date || holdingRows[0]?.snapshot_date;
  res.json({
    accounts: applyNicknames([...plaidAccounts, ...filteredImportedAccounts, ...holdingAccounts, ...propertyAccounts, ...manualAccounts, ...vehicleAccounts]),
    ...(snapshotDate ? { snapshotDate } : {}),
    ...(itemErrors.length > 0 ? { itemErrors } : {}),
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
    const limit = Math.min(parseInt(req.query.limit) || 2000, 10000);
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

app.delete("/api/transactions/:id", requireAuth, async (req, res) => {
  try {
    const rowCount = await deleteTransaction(req.params.id);
    if (rowCount === 0) return res.status(404).json({ error: "Transaction not found" });
    res.json({ hidden: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/transactions/:id/unhide", requireAuth, async (req, res) => {
  try {
    await unhideTransaction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Review workflow (Brief 01) ────────────────────────────────────────────────
app.post("/api/transactions/review", requireAuth, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: "ids array required" });
    if (ids.length > 1000)
      return res.status(400).json({ error: "At most 1000 ids per request" });
    const result = await reviewTransactions(ids);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/transactions/:id/unreview", requireAuth, async (req, res) => {
  try {
    const ok = await unreviewTransaction(req.params.id);
    if (!ok) return res.status(404).json({ error: "Transaction not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gmail receipt scanner (Brief 01) ──────────────────────────────────────────
app.get("/api/gmail/auth-url", requireAuth, async (req, res) => {
  if (!gmailConfigured())
    return res.status(503).json({ error: "Gmail OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" });
  try {
    res.json({ url: getGmailAuthUrl() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/gmail/auth-code", requireAuth, async (req, res) => {
  if (!gmailConfigured())
    return res.status(503).json({ error: "Gmail OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" });
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "code required" });
    await exchangeGmailAuthCode(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/gmail/status", requireAuth, async (req, res) => {
  try {
    res.json({ connected: await gmailConnected() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/receipts/scan", requireAuth, async (req, res) => {
  if (!receiptScanConfigured())
    return res.status(503).json({ error: "Receipt scanning not configured — set GEMINI_API_KEY" });
  if (!(await gmailConnected()))
    return res.status(503).json({ error: "Gmail is not connected — connect it in Settings first" });
  try {
    const result = await runReceiptScan();
    res.json(result);
  } catch (err) {
    console.error("Receipt scan failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Ask AI ────────────────────────────────────────────────────────────────────
// Natural-language questions answered by Gemini over a read-only tool surface.
// Non-streaming v1; the loop itself lives in askAi.js so it's unit-testable.
app.post("/api/ask", requireAuth, async (req, res) => {
  if (!askAiConfigured())
    return res.status(503).json({ error: "Ask AI not configured" });
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "question is required" });
  if (question.length > 2000)
    return res.status(400).json({ error: "question must be 2000 characters or fewer" });
  // Elapsed ms on both paths: it's the one number that separates "rejected
  // instantly" (bad request, bad config, missing key) from "ran to the wall
  // clock" (a timeout upstream) without having to reproduce anything. Counts,
  // tool names and timing only — never the question or any row that came back,
  // this is financial data.
  const startedAt = Date.now();
  try {
    const { answer, toolCalls } = await runAskLoop({
      question,
      history: req.body.history, // clamped to the last 10 turns in runAskLoop
      generate: createGeminiGenerate(),
      impl: askAiImpl,
    });
    console.log(`ask-ai: ${toolCalls.length} tool call(s)${toolCalls.length ? ` [${toolCalls.join(", ")}]` : ""} in ${Date.now() - startedAt}ms`);
    res.json({ answer });
  } catch (err) {
    // Free-tier 429s are expected under bursts; surface them so the client can
    // say "wait a minute" instead of "broken".
    console.error("ask-ai:", err.status || "", err.message, `after ${Date.now() - startedAt}ms`);
    res.status(err.status === 429 ? 429 : 502).json({ error: "AI request failed" });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────
const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get("/api/reports/summary", requireApiKeyOrAuth, async (req, res) => {
  try {
    let { start_date: startDate, end_date: endDate } = req.query;
    if (!startDate && !endDate) {
      // Default: the last 6 full months.
      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      startDate = first.toISOString().slice(0, 10);
      endDate = last.toISOString().slice(0, 10);
    }
    if (!REPORT_DATE_RE.test(startDate || "") || !REPORT_DATE_RE.test(endDate || "")) {
      return res.status(400).json({ error: "start_date and end_date must be YYYY-MM-DD" });
    }
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "start_date and end_date must be valid dates" });
    }
    if (start > end) {
      return res.status(400).json({ error: "start_date must be on or before end_date" });
    }
    if (end - start > 5 * 366 * 86400000) {
      return res.status(400).json({ error: "Range cannot exceed 5 years" });
    }
    const summary = await getReportSummary({ startDate, endDate });
    res.json(summary);
  } catch (err) {
    console.error("Report summary failed:", err.message);
    res.status(500).json({ error: "Failed to build report summary" });
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

// ── Plaid webhooks ────────────────────────────────────────────────────────────
app.post("/api/webhooks/plaid", async (req, res) => {
  res.sendStatus(200);
  const { webhook_type, webhook_code } = req.body || {};
  if (webhook_type === "TRANSACTIONS" && webhook_code === "SYNC_UPDATES_AVAILABLE") {
    syncTransactions().catch((e) => console.error("Webhook sync failed:", e.message));
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

app.put("/api/splits/:transactionId", requireAuth, async (req, res) => {
  const { splits } = req.body;
  if (!Array.isArray(splits)) return res.status(400).json({ error: "splits array required" });
  const result = await replaceSplits(req.params.transactionId, splits);
  res.json({ splits: result });
});

// ── Hidden accounts ───────────────────────────────────────────────────────────
app.get("/api/hidden-accounts", requireAuth, async (req, res) => {
  const accounts = await getHiddenAccounts();
  res.json({ accounts });
});

app.post("/api/hidden-accounts", requireAuth, async (req, res) => {
  const { account_id } = req.body;
  if (!account_id) return res.status(400).json({ error: "account_id required" });
  await addHiddenAccount(account_id);
  res.json({ ok: true });
});

app.delete("/api/hidden-accounts/:accountId", requireAuth, async (req, res) => {
  await removeHiddenAccount(decodeURIComponent(req.params.accountId));
  res.json({ ok: true });
});

// ── Imported accounts (balance snapshots) ─────────────────────────────────────
app.delete("/api/imported-accounts/:account", requireAuth, async (req, res) => {
  const accountId = req.params.account; // already percent-decoded by Express

  if (!accountId?.trim()) return res.status(400).json({ error: "account required" });
  const deleted = await deleteImportedAccountBalances(accountId);
  if (deleted === 0) return res.status(404).json({ error: "Imported account not found" });
  await removeHiddenAccount(accountId);
  await deleteAccountNickname(accountId);
  res.json({ ok: true, deleted });
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

app.get("/api/import/accounts", requireAuth, async (req, res) => {
  const accounts = await getImportedTransactionAccounts();
  res.json({ accounts });
});

app.delete("/api/import", requireAuth, async (req, res) => {
  const { accounts } = req.body || {};
  const deleted = await deleteImportedTransactions(accounts?.length ? accounts : null);
  res.json({ deleted });
});

// ── Simplifi CSV import ───────────────────────────────────────────────────────
app.post("/api/simplifi/analyze", requireAuth, async (req, res) => {
  try {
    const { csv, accounts: clientAccounts = [] } = req.body;
    if (!csv || typeof csv !== "string") return res.status(400).json({ error: "csv required" });
    const rows = parseSimplifiCsv(csv);

    // ── Category suggestions ──────────────────────────────────────────────────
    const [existingCatMappings, existingAcctMappings, categories, manualAccounts] = await Promise.all([
      getSimplifiMappings(),
      getSimplifiAccountMappings(),
      getCategories(),
      getManualAccounts(),
    ]);

    const uniqueCats = [...new Set(rows.map(r => r.category))];
    const unmappedCategories = uniqueCats
      .filter(c => !isJunkSimplifiCategory(c) && !(c in existingCatMappings))
      .map(name => {
        const lower = name.toLowerCase().replace(/[^a-z]/g, '');
        let bestId = null, bestScore = 0;
        for (const cat of categories) {
          const cl = cat.name.toLowerCase().replace(/[^a-z]/g, '');
          let score = lower === cl ? 1 : (lower.includes(cl) || cl.includes(lower)) ? 0.7 : 0;
          if (!score) {
            const w1 = name.toLowerCase().split(/[\s:&/-]+/);
            const w2 = cat.name.toLowerCase().split(/[\s:&/-]+/);
            const common = w1.filter(w => w.length > 2 && w2.includes(w)).length;
            score = common > 0 ? 0.3 + common * 0.1 : 0;
          }
          if (score > bestScore) { bestScore = score; bestId = cat.id; }
        }
        return { name, suggestedId: bestScore >= 0.3 ? bestId : null };
      });

    // ── Account suggestions ───────────────────────────────────────────────────
    const finappAccounts = [
      ...clientAccounts.map(a => ({
        account_id: a.account_id,
        name: a.name,
        official_name: a.official_name || null,
        mask: a.mask || null,
        type: a.type,
        subtype: a.subtype || null,
        institutionName: a.institutionName || null,
        source: 'plaid',
      })),
      ...manualAccounts.map(a => ({
        account_id: String(a.id),
        name: a.name,
        official_name: null,
        mask: null,
        type: a.subtype || 'manual',
        source: 'manual',
      })),
    ];

    const uniqueAccts = [...new Set(rows.map(r => r.account))];
    const unmappedAccounts = uniqueAccts
      .filter(a => !(a in existingAcctMappings))
      .map(name => {
        const lower = name.toLowerCase().replace(/[^a-z]/g, '');
        let bestId = null, bestScore = 0;
        for (const fa of finappAccounts) {
          const fl = fa.name.toLowerCase().replace(/[^a-z]/g, '');
          let score = lower === fl ? 1 : (lower.includes(fl) || fl.includes(lower)) ? 0.7 : 0;
          if (!score) {
            const w1 = name.toLowerCase().split(/[\s_&-]+/);
            const w2 = fa.name.toLowerCase().split(/[\s_&-]+/);
            const common = w1.filter(w => w.length > 2 && w2.includes(w)).length;
            score = common > 0 ? 0.3 + common * 0.1 : 0;
          }
          if (score > bestScore) { bestScore = score; bestId = fa.account_id; }
        }
        return { name, suggestedId: bestScore >= 0.3 ? bestId : null };
      });

    res.json({ unmappedCategories, unmappedAccounts, finappCategories: categories, finappAccounts, totalRows: rows.length });
  } catch (err) {
    console.error("Simplifi analyze error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/simplifi/import", requireAuth, async (req, res) => {
  try {
    const { csv, newMappings = {}, newAccountMappings = {} } = req.body;
    if (!csv || typeof csv !== "string") return res.status(400).json({ error: "csv required" });
    const filteredMappings = Object.fromEntries(Object.entries(newMappings).filter(([, v]) => v !== '__DEFER__'));
    const filteredAccountMappings = Object.fromEntries(Object.entries(newAccountMappings).filter(([, v]) => v !== '__DEFER__'));
    if (Object.keys(filteredMappings).length) await saveSimplifiMappings(filteredMappings);
    if (Object.keys(filteredAccountMappings).length) await saveSimplifiAccountMappings(filteredAccountMappings);
    const [allMappings, allAccountMappings] = await Promise.all([
      getSimplifiMappings(),
      getSimplifiAccountMappings(),
    ]);
    const rows = parseSimplifiCsv(csv);
    let inserted = 0, categorized = 0, skipped = 0;
    for (const row of rows) {
      const resolvedAccount = allAccountMappings[row.account] ?? row.account;
      // Same account, SIGNED amount, and the payee where Simplifi gave us one.
      // On (date, ABS(amount)) alone this matched any row on any account that
      // moved the same magnitude that day in either direction, and then stamped
      // the Simplifi category onto up to five of them.
      const { rows: matches } = await pool.query(
        `SELECT id FROM transactions
         WHERE date = $1::date
           AND ROUND(amount::numeric, 2) = ROUND($2::numeric, 2)
           AND account = $3
           AND id NOT LIKE 'simplifi_%'
           AND ($4::text IS NULL OR LOWER(TRIM(merchant)) = LOWER(TRIM($4::text)))`,
        [row.date, row.dbAmount, resolvedAccount, row.payee || null]
      );
      const catId = isJunkSimplifiCategory(row.category) ? null : (allMappings[row.category] || null);
      // Logging a suppression must never abort the import it is logging — an
      // unparseable date on one row would otherwise leave the rest unimported
      // with earlier rows already written.
      const suppress = async (reason) => {
        try {
          await recordSuppression({
            source: 'simplifiImport',
            date: row.date,
            merchant: row.payee,
            amount: row.dbAmount,
            account: resolvedAccount,
            reason,
          });
        } catch (e) {
          console.error("Failed to record suppression:", e.message);
        }
      };
      if (matches.length > 1) {
        // More than one candidate means we cannot tell which row this Simplifi
        // line describes. Categorizing all of them is how unrelated rows got
        // someone else's category — categorize none and leave a record instead.
        skipped++;
        await suppress('ambiguous simplifi match');
      } else if (matches.length === 1) {
        if (catId) {
          const { rowCount } = await pool.query(
            `INSERT INTO assignments (transaction_id, category_id)
             VALUES ($1, $2) ON CONFLICT (transaction_id) DO NOTHING`,
            [matches[0].id, catId]
          );
          if (rowCount > 0) categorized++;
        } else {
          skipped++;
          await suppress('an existing row already covers this date/account/amount');
        }
      } else {
        const id = 'simplifi_' + createHash('sha256')
          .update(`${row.date}|${row.payee}|${row.dbAmount}|${row.account}`)
          .digest('hex').slice(0, 16);
        const { rowCount } = await pool.query(
          `INSERT INTO transactions (id, date, merchant, amount, account, plaid_category, status, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'reviewed', 'USD')
           ON CONFLICT (id) DO NOTHING`,
          [id, row.date, row.payee, row.dbAmount, resolvedAccount, row.category]
        );
        if (rowCount > 0) {
          if (catId) await pool.query(
            `INSERT INTO assignments (transaction_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, catId]
          );
          inserted++;
        } else {
          skipped++;
          await suppress('a simplifi row with this id was already imported');
        }
      }
    }
    res.json({ inserted, categorized, skipped });
  } catch (err) {
    console.error("Simplifi import error:", err);
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

// ── Vehicles ──────────────────────────────────────────────────────────────────
app.get("/api/vehicles", requireAuth, async (req, res) => {
  const rows = await getVehicles();
  res.json({ vehicles: rows });
});

app.post("/api/vehicles", requireAuth, async (req, res) => {
  const { id, year, make, model, trim, nickname } = req.body;
  if (!make || !model) return res.status(400).json({ error: "make and model required" });
  const vehicle = await upsertVehicle(id || null, year ? parseInt(year) : null, make, model, trim, nickname);
  res.json({ vehicle });
});

app.delete("/api/vehicles/:id", requireAuth, async (req, res) => {
  await deleteVehicle(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post("/api/vehicles/sync", requireAuth, async (req, res) => {
  try {
    const { updated, results } = await applyVehicleDepreciation();
    res.json({ synced: updated, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vehicles/:id/baseline", requireAuth, async (req, res) => {
  const { value, rate } = req.body;
  if (!value || isNaN(parseFloat(value))) return res.status(400).json({ error: "value required" });
  const depRate = rate != null ? parseFloat(rate) : 0.15;
  try {
    await setVehicleBaseline(parseInt(req.params.id), parseFloat(value), depRate);
    const vehicles = await getVehicles();
    res.json({ vehicle: vehicles.find((v) => v.id === parseInt(req.params.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backfill ──────────────────────────────────────────────────────────────────
// Recovers transactions the old (date, ABS(amount)) dedup destroyed. Clearing
// the cursors makes Plaid replay every item's full history; rows that survived
// upsert onto themselves via ON CONFLICT (id), and rows that were deleted come
// back. Idempotent — running it twice recovers the same set and changes nothing
// the second time.
//
// This only became safe once the insert trigger and the startup sweep were both
// gone. Against the old code a replay would have re-deleted the same rows, so
// the guard below refuses to run if the trigger is somehow still attached
// (a database whose role could not drop it — see initDb).
// A full replay re-pulls every item's history and inserts row by row, which can
// run well past the proxy's request timeout. Returning the result inline meant a
// recovery that actually succeeded would surface to the user as a parse error on
// a gateway HTML page. So the work runs detached and the client polls.
//
// Job state is in-memory: a machine restart mid-replay loses it. That is honest
// rather than harmful — the replay is idempotent, so the status endpoint reports
// the loss and the user can simply run it again.
let backfillJob = null;

async function runBackfillJob({ start, end }) {
  // Hold the sync lock across the whole job. Clearing cursors and syncing has to
  // be indivisible: a concurrent sync that started between the two would consume
  // the cleared cursors and do the replay itself, invisibly.
  if (!(await tryAdvisoryLock(SYNC_LOCK_KEY))) {
    backfillJob = {
      ...backfillJob,
      status: "error",
      finishedAt: new Date().toISOString(),
      error:
        "A transaction sync was already running, so nothing was changed. " +
        "Wait a few seconds and run it again.",
    };
    return;
  }
  try {
    const scope = { startDate: start, endDate: end, plaidNativeOnly: true };
    const before = new Set(await listTransactionIds(scope));
    const cursorsCleared = await clearCursors();
    const sync = await syncTransactionsCore();
    const after = await listTransactionIds(scope);
    const addedIds = after.filter((id) => !before.has(id));
    backfillJob = {
      ...backfillJob,
      status: "done",
      finishedAt: new Date().toISOString(),
      cursorsCleared,
      itemsSynced: sync.items,
      countBefore: before.size,
      countAfter: after.length,
      addedCount: addedIds.length,
      added: await getTransactionsByIds(addedIds),
    };
  } catch (e) {
    console.error("Backfill replay failed:", e);
    backfillJob = {
      ...backfillJob,
      status: "error",
      finishedAt: new Date().toISOString(),
      error: e.message,
    };
  } finally {
    await releaseAdvisoryLock(SYNC_LOCK_KEY);
  }
}

app.post("/api/backfill/replay", requireAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.start ?? req.body?.start);
    const end = parseDateParam(req.query.end ?? req.body?.end);
    if (start === null || end === null) {
      return res.status(400).json({ error: "start and end must be single YYYY-MM-DD dates" });
    }
    if (backfillJob?.status === "running") {
      return res.status(409).json({ error: "A recovery is already running.", status: "running" });
    }

    // Checked before anything mutates, so a refusal leaves the database untouched.
    const { rows: guard } = await pool.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
       WHERE t.tgname = 'check_duplicate_transactions' AND c.relname = 'transactions'`
    );
    if (guard.length > 0) {
      return res.status(409).json({
        error:
          "Refusing to run: the old duplicate trigger is still attached, so a replay " +
          "would feed these rows straight back into the logic that deleted them. " +
          "Drop it as the table owner first: " +
          "DROP TRIGGER IF EXISTS check_duplicate_transactions ON transactions; " +
          "DROP FUNCTION IF EXISTS prevent_duplicate_transactions();",
      });
    }

    backfillJob = { status: "running", startedAt: new Date().toISOString(), range: { start: start ?? null, end: end ?? null } };
    // Detached on purpose, but never unhandled: an escaping rejection would be
    // fatal on Node 22, and the one call outside the job's own try/catch is the
    // lock acquisition.
    runBackfillJob({ start, end }).catch((e) => {
      console.error("Backfill job crashed:", e);
      backfillJob = {
        ...backfillJob,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: e.message,
      };
    });
    res.status(202).json({ status: "running", startedAt: backfillJob.startedAt });
  } catch (e) {
    console.error("Backfill replay failed to start:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/backfill/status", requireAuth, async (_req, res) => {
  // No job means either nothing has run or the machine restarted mid-run. Both
  // are reported as idle; the client explains the second case.
  res.json(backfillJob ?? { status: "idle" });
});

// ── Deduplication ─────────────────────────────────────────────────────────────
// start/end reach SQL as ::date parameters. Express hands back an array when a
// query key repeats (?start=a&start=b) and Postgres rejects anything that is not
// a date, so both have to be caught before the value gets near a query.
// Returns undefined when absent/blank, the trimmed date when valid, null when not.
function parseDateParam(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

app.get("/api/deduplicate/debug", requireAuth, async (req, res) => {
  try {
    const [sample, idStats, dupeRows, legacyKeyRows] = await Promise.all([
      pool.query(`SELECT id, date, amount::float, merchant, account, created_at FROM transactions ORDER BY date DESC, created_at DESC LIMIT 20`),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE id LIKE 'simplifi_%') AS simplifi,
          COUNT(*) FILTER (WHERE id ~ '^[0-9a-f-]{36}$') AS uuid,
          COUNT(*) FILTER (WHERE id NOT LIKE 'simplifi_%' AND id !~ '^[0-9a-f-]{36}$') AS plaid,
          COUNT(*) AS total
        FROM transactions`),
      // Grouped on the real dedup key (date + account + SIGNED amount), so this
      // view agrees with what /api/deduplicate would actually propose. The
      // per-row accounts/amounts arrays are what the Settings panel renders
      // beside each id, so they ship with every group.
      pool.query(`
        SELECT date, account, ROUND(amount::numeric,2) AS amount, COUNT(*) AS cnt,
               array_agg(id ORDER BY created_at) AS ids,
               array_agg(merchant ORDER BY created_at) AS merchants,
               array_agg(account ORDER BY created_at) AS accounts,
               array_agg(amount::float ORDER BY created_at) AS amounts
        FROM transactions
        GROUP BY date, account, ROUND(amount::numeric,2)
        HAVING COUNT(*) > 1
        ORDER BY date DESC LIMIT 20`),
      // Deliberately still keyed on (date, ABS(amount)) with no account: this is
      // the key the old dedup used, so it lists the pairs that logic would have
      // collapsed — a card payment against its funding leg, a charge against its
      // refund. Useful for finding historical damage; never a delete candidate.
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
    res.json({
      sample: sample.rows,
      idStats: idStats.rows[0],
      dupeRows: dupeRows.rows,
      atRiskUnderOldKey: legacyKeyRows.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// start/end bound the scan; it defaults to the last 24 months rather than
// reading every transaction ever into memory.
app.get("/api/deduplicate", requireAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.start);
    const end = parseDateParam(req.query.end);
    if (start === null || end === null) return res.status(400).json({ error: "start and end must be single YYYY-MM-DD dates" });
    const dupes = await findDuplicateTransactions({ startDate: start, endDate: end });
    const toRemove = dupes.reduce((n, d) => n + d.remove.length, 0);
    res.json({ groups: dupes.length, toRemove, preview: dupes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/deduplicate", requireAuth, async (req, res) => {
  try {
    const { groups } = req.body || {};
    if (groups !== undefined && !Array.isArray(groups)) return res.status(400).json({ error: "groups must be an array" });
    // rejected: ids the caller asked us to delete that deduplicateTransactions
    // refused — Plaid-native rows, or rows in a group whose keeper is invalid.
    const { deleted, rejected } = await deduplicateTransactions(groups ?? undefined);
    res.json({ deleted, rejected });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Every row some code path declined to store, newest first. If a transaction
// you expected is missing, this is the first place to look.
app.get("/api/suppressed", requireAuth, async (req, res) => {
  try {
    const suppressed = await getSuppressions();
    res.json({ suppressed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reconciliation ────────────────────────────────────────────────────────────
// A card payment leaves a depository account and lands on the card. A funding
// leg with no card-side credit means a credit went missing — the exact symptom
// the old ABS()-keyed dedup produced. This is the regression check for it.
app.get("/api/reconcile/payment-pairs", requireAuth, async (req, res) => {
  try {
    const { start, end, windowDays } = req.query;
    // Number("") is 0, not NaN, so a blank ?windowDays= used to narrow the search
    // to same-day only instead of falling back to the default. A zero-day window
    // flags every payment whose credit posted the next day, so require >= 1.
    const raw = typeof windowDays === "string" ? windowDays.trim() : windowDays;
    const days = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
    const searchWindow = Number.isFinite(days) && days >= 1 ? days : 3;
    const [txns, balRows, items] = await Promise.all([
      getTransactions({ limit: 10000, startDate: start, endDate: end }),
      getLatestBalances(),
      getUserItems(),
    ]);

    // transactions.account holds a Plaid account_id for live rows and an account
    // name for imported ones, so both sets have to carry both forms. Membership
    // is by allowlist on both sides: the balances side used to blocklist
    // credit/loan, which quietly counted `investment` and `other` as depository.
    const depositoryAccounts = new Set(
      balRows.filter((r) => normalizePlaidType(r.type) === "depository").map((r) => r.account)
    );
    const creditAccounts = new Set(
      balRows.filter((r) => normalizePlaidType(r.type) === "credit").map((r) => r.account)
    );
    const results = await Promise.allSettled(
      items.map(({ accessToken }) => plaidClient.accountsGet({ access_token: accessToken }))
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const a of r.value.data.accounts) {
        const type = normalizePlaidType(a.subtype || a.type);
        if (type === "depository") depositoryAccounts.add(a.account_id);
        if (type === "credit") creditAccounts.add(a.account_id);
      }
    }

    const rows = txns.map((t) => ({
      id: t.transaction_id,
      date: t.date,
      merchant: t.merchant_name,
      name: t.name,
      amount: t.amount,
      account: t.account_id,
    }));
    const unmatched = findUnmatchedPaymentLegs(rows, { depositoryAccounts, creditAccounts, windowDays: searchWindow });
    res.json({ unmatched, count: unmatched.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      const r = await plaidClient.accountsGet({ access_token: accessToken });
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
    const visible = await getVisibleTransactions({ limit, startDate: start_date, endDate: end_date, category });
    return { content: [{ type: "text", text: JSON.stringify(visible, null, 2) }] };
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

  server.tool("import_xlsx", "Import transactions and account balances from an Excel export. Accepts both the legacy dual-tab format and Quadratic's multi-sheet Plaid export. Pass the file content as a base64 string. Safe to re-run.", {
    xlsx: z.string().describe("Base64-encoded .xlsx file — either Quadratic's multi-sheet Plaid export or the legacy format with 'Account Balances' and 'Transactions' sheets"),
    snapshot_date: z.string().optional().describe("YYYY-MM-DD date to tag the balance snapshot (defaults to today; ignored for Quadratic imports)"),
  }, async ({ xlsx, snapshot_date }) => {
    const { transactions, balances, holdings, snapshotDate, isPlaidNative } = parseXlsxBase64(xlsx, snapshot_date);
    let imported = 0;
    if (isPlaidNative) {
      // Count what actually landed — rows with no id or amount are dropped (and
      // recorded in /api/suppressed), so the input length overstated it.
      imported = await upsertPlaidTransactions(transactions);
    } else {
      for (const row of transactions) {
        if (await upsertCsvTransaction(row)) imported++;
      }
    }
    if (balances.length) await upsertAccountBalances(snapshotDate, balances);
    if (holdings.length) await upsertInvestmentHoldings(snapshotDate, holdings);
    const skipped = transactions.length - imported;
    const parts = [`Imported ${imported} transaction${imported !== 1 ? 's' : ''}`];
    if (skipped) parts.push(isPlaidNative
      ? `skipped ${skipped} missing an id or amount (see /api/suppressed)`
      : `skipped ${skipped} already covered by Plaid`);
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

app.delete("/api/cashflow/presets/:name", requireAuth, async (req, res) => {
  try {
    await deleteCashflowPreset(req.params.name);
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
    const { accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay, note } = req.body;
    await upsertCashflowState(accountId, txnId, monthKey, isPending, actualAmount ?? null, plaidTxnId ?? null, actualDay ?? null, note ?? null);
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

// ── Audit ──────────────────────────────────────────────────────────────────────
app.get("/api/audit/last", requireAuth, async (req, res) => {
  try {
    res.json({ log: await getLastAuditLog() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/audit/upload", requireAuth, async (req, res) => {
  try {
    const { xlsx, filename } = req.body;
    if (!xlsx) return res.status(400).json({ error: "xlsx required" });
    const { transactions: sheetTxns, dateRange, sheetStats } = parseAuditXlsx(xlsx);
    if (!sheetTxns.length || !dateRange.start) {
      return res.json({ auditId: null, missing: [], totalInSheet: 0, missingCount: 0, dateRange, debug: { sheetStats, dbKeyCount: 0, sampleXlsxKeys: [], sampleDbKeys: [] } });
    }

    // Start from the day after the last completed audit's range_end, or the floor date
    const FLOOR_DATE = "2026-04-01";
    const lastLog = await getLastAuditLog();
    let auditStart = FLOOR_DATE;
    if (lastLog?.range_end && lastLog?.completed_at) {
      const dayAfter = new Date(lastLog.range_end + "T12:00:00Z");
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const candidate = dayAfter.toISOString().slice(0, 10);
      if (candidate > FLOOR_DATE) auditStart = candidate;
    }

    // Expand DB window ±1 day to catch posting date drift
    const dbStart = new Date(auditStart + "T12:00:00Z"); dbStart.setUTCDate(dbStart.getUTCDate() - 1);
    const dbEnd   = new Date(dateRange.end + "T12:00:00Z"); dbEnd.setUTCDate(dbEnd.getUTCDate() + 1);
    const dbKeys = await getTransactionDateAmountSet(dbStart.toISOString().slice(0, 10), dbEnd.toISOString().slice(0, 10));

    function dateShift(dateStr, days) {
      const d = new Date(dateStr + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }
    // date + account + SIGNED amount, matching getTransactionDateAmountSet. The
    // old key was ABS(amount) with no account, so a missing card credit read as
    // present whenever a funding leg of the same magnitude posted that day on
    // some other account — this detector would have hidden the whole incident.
    // Sheet rows with no account_id fall back to date + signed amount: the
    // account column is not always populated, but the sign never comes off.
    const signedAmount = (amount) => {
      const s = Number(amount).toFixed(2);
      return s === "-0.00" ? "0.00" : s;
    };
    const toKey = (date, t) => t.account_id
      ? `${date}|${t.account_id}|${signedAmount(t.amount)}`
      : `${date}|${signedAmount(t.amount)}`;
    const auditTxns = sheetTxns.filter(t => t.date >= auditStart);
    const missing = auditTxns.filter(t =>
      !dbKeys.has(toKey(t.date, t)) &&
      !dbKeys.has(toKey(dateShift(t.date, -1), t)) &&
      !dbKeys.has(toKey(dateShift(t.date, 1), t))
    );
    const auditEnd = dateRange.end;
    const { id: auditId } = await saveAuditLog(
      filename || "Personal Finances.xlsx", auditTxns.length, missing.length, auditStart, auditEnd
    );
    const sampleXlsxKeys = auditTxns.slice(0, 3).map(t => toKey(t.date, t));
    const sampleDbKeys = [...dbKeys].slice(0, 3);
    const debug = { sheetStats, dbKeyCount: dbKeys.size, sampleXlsxKeys, sampleDbKeys, auditStart };
    res.json({ auditId, missing, totalInSheet: auditTxns.length, missingCount: missing.length, dateRange: { start: auditStart, end: auditEnd }, debug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/audit/complete", requireAuth, async (req, res) => {
  try {
    const { auditId, rangeEnd } = req.body;
    if (!auditId || !rangeEnd) return res.status(400).json({ error: "auditId and rangeEnd required" });
    await completeAuditLog(auditId, rangeEnd);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/audit/insert", requireAuth, async (req, res) => {
  try {
    const { auditId, transactions } = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0)
      return res.status(400).json({ error: "transactions array required" });
    await upsertTransactions(transactions);
    if (auditId) await updateAuditInsertedCount(auditId, transactions.length);
    res.json({ inserted: transactions.length });
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
  // No dedup sweep on startup. fly.toml auto-stops the machine, so this ran on
  // every wake — many times a day — hard-DELETEing rows with no review step.
  // Deduplication is manual and preview-first now: GET /api/deduplicate.
  // Sync transactions on startup so data is fresh whenever the machine wakes up
  syncTransactions()
    .then(() => console.log("Startup: transaction sync complete"))
    .catch((e) => console.error("Startup: transaction sync failed (non-fatal):", e.message));
  // Apply FHFA drift to properties with baselines (non-blocking)
  applyFHFADrift().then(({ updated, results }) => {
    if (updated > 0) console.log(`Startup: applied FHFA drift to ${updated} property value(s)`);
    results.filter((r) => !r.ok).forEach((r) => console.error(`Startup FHFA drift failed [${r.address}]: ${r.error}`));
  }).catch((e) => console.error("Startup FHFA drift failed (non-fatal):", e.message));
  // Apply depreciation to vehicles with baselines (non-blocking)
  applyVehicleDepreciation().then(({ updated }) => {
    if (updated > 0) console.log(`Startup: applied depreciation to ${updated} vehicle(s)`);
  }).catch((e) => console.error("Startup vehicle depreciation failed (non-fatal):", e.message));
  // Register webhook URL for all existing Items (non-blocking)
  getUserItems().then(async (items) => {
    const webhookUrl = `${APP_URL}/api/webhooks/plaid`;
    for (const { accessToken } of items) {
      try {
        await plaidClient.itemWebhookUpdate({ access_token: accessToken, webhook: webhookUrl });
      } catch (e) {
        console.error("Webhook registration failed (non-fatal):", e.message);
      }
    }
    if (items.length) console.log(`Registered webhook for ${items.length} item(s)`);
  }).catch((e) => console.error("Startup webhook registration failed:", e.message));

  app.listen(PORT, () => {
    console.log(`FinApp server running on :${PORT}`);
    console.log(
      "Receipt scanner & Ask AI: GEMINI_API_KEY must be minted in a BILLED " +
        "Google Cloud project — only paid-tier usage carries the no-training " +
        "data terms for financial data."
    );

    // Daily 8 AM ET safety-net sync (only fires when machine is running)
    (function scheduleDailySync() {
      const now = new Date();
      const next = new Date();
      next.setUTCHours(13, 0, 0, 0); // ~8 AM EST
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      setTimeout(async () => {
        console.log("Running daily scheduled sync");
        try { await syncTransactions(); } catch (e) { console.error("Scheduled sync failed:", e.message); }
        scheduleDailySync();
      }, next - now);
    })();

    // Opt-in daily receipt scan, shortly after the safety-net sync. Only runs
    // when Gmail has been connected (gmail_tokens has a row) and a Gemini key
    // is present — otherwise it reschedules and stays silent.
    (function scheduleDailyReceiptScan() {
      const now = new Date();
      const next = new Date();
      next.setUTCHours(13, 10, 0, 0); // ~8:10 AM EST, after the daily sync
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      setTimeout(async () => {
        try {
          if (receiptScanConfigured() && (await getGmailRefreshToken())) {
            console.log("Running daily receipt scan");
            const result = await runReceiptScan();
            console.log(`Daily receipt scan: scanned ${result.scanned}, receipts ${result.receipts_found}, matched ${result.matched}`);
          }
        } catch (e) {
          console.error("Daily receipt scan failed:", e.message);
        }
        scheduleDailyReceiptScan();
      }, next - now);
    })();
  });
}).catch((e) => {
  // Without this the failure is an unhandled rejection and app.listen never
  // runs, so the machine sits there answering nothing. initDb now drops the old
  // duplicate trigger, which needs table ownership — a DB role that lacks it
  // fails here, and that has to be loud enough for the health check to catch.
  console.error("FATAL: database initialization failed, server not starting:", e);
  process.exit(1);
});
