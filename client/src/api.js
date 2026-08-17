// Vite's base ("/finance/" in production) so requests carry the portal prefix.
// The server strips it again, keeping every route registered at root.
const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

// Retained as a no-op: authentication is now the Cloudflare Access cookie,
// which the browser attaches automatically. Kept so callers need no changes.
export const setTokenGetter = () => {};

async function authHeaders(extra = {}) {
  return { "Content-Type": "application/json", ...extra };
}

// The row-cap bookkeeping the server puts on every /api/transactions and
// /api/export-xlsx response (server/limits.js TRUNCATION_HEADERS, listed in the
// CORS exposedHeaders or the browser would hide them from fetch()). Merged into
// the parsed body by the two callers that actually display it —
// fetchTransactionsForMonth (CashFlow's per-month partial badge) and
// downloadXlsx (Settings' row-cap notice). Deliberately NOT merged into
// fetchTransactions: App.jsx keeps only `transactions` from it, and the
// Transactions view answers the same question better from
// /api/transactions/stats, which gives it the total the headers cannot. Adding
// the fields there would put three values on the wire that nothing reads and
// imply a consumer that does not exist.
function readTruncation(r) {
  return {
    truncated: r.headers.get("X-Result-Truncated") === "true",
    limit: Number(r.headers.get("X-Result-Limit")) || null,
    count: Number(r.headers.get("X-Result-Count")) || null,
  };
}

export async function createLinkToken() {
  const r = await fetch(`${BASE}/create_link_token`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });
  return r.json();
}

export async function exchangePublicToken(public_token) {
  const r = await fetch(`${BASE}/exchange_public_token`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ public_token }),
  });
  return r.json();
}

export async function fetchLinkedInstitutions() {
  const r = await fetch(`${BASE}/linked-institutions`, { headers: await authHeaders() });
  return r.json();
}

export async function removeLinkedInstitution(itemId) {
  const r = await fetch(`${BASE}/linked-institutions/${itemId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function createUpdateLinkToken(item_id) {
  const r = await fetch(`${BASE}/create_update_link_token`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ item_id }),
  });
  return r.json();
}

export async function fetchAccounts() {
  const r = await fetch(`${BASE}/accounts`, { headers: await authHeaders() });
  return r.json();
}

export async function fetchAccountBalances() {
  const r = await fetch(`${BASE}/account-balances`, { headers: await authHeaders() });
  return r.json();
}

export async function fetchTransactions() {
  const r = await fetch(`${BASE}/transactions`, { headers: await authHeaders() });
  return r.json();
}

// True totals — { total, spend, needsReview, needsApproval } — computed in SQL
// over every transaction, not over the capped page fetchTransactions returns.
// Optional YYYY-MM-DD bounds; omit both for the whole table. A failure comes
// back as { error } like the other plain GETs rather than throwing, because the
// caller degrades to counting its loaded rows instead of blanking the view.
export async function fetchTransactionStats(startDate, endDate) {
  const qs = new URLSearchParams();
  if (startDate) qs.set("start_date", startDate);
  if (endDate) qs.set("end_date", endDate);
  const r = await fetch(`${BASE}/transactions/stats${qs.toString() ? `?${qs}` : ""}`, {
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchBalance() {
  const r = await fetch(`${BASE}/balance`, { headers: await authHeaders() });
  return r.json();
}

export async function getApiKey() {
  const r = await fetch(`${BASE}/user/api-key`, { headers: await authHeaders() });
  return r.json();
}

export async function generateApiKey() {
  const r = await fetch(`${BASE}/user/api-key`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── Categories ────────────────────────────────────────────────────────────────
export async function fetchCategories() {
  const r = await fetch(`${BASE}/categories`, { headers: await authHeaders() });
  return r.json();
}

export async function createCategoryApi(name, color) {
  const r = await fetch(`${BASE}/categories`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ name, color }),
  });
  return r.json();
}

export async function updateCategoryApi(id, name, color) {
  const r = await fetch(`${BASE}/categories/${id}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ name, color }),
  });
  return r.json();
}

export async function deleteCategoryApi(id, replacementId) {
  const r = await fetch(`${BASE}/categories/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
    body: JSON.stringify({ replacementId: replacementId || null }),
  });
  return r.json();
}

export async function seedCategoriesApi(categories) {
  const r = await fetch(`${BASE}/categories/seed`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ categories }),
  });
  return r.json();
}

// ── Assignments ───────────────────────────────────────────────────────────────
export async function fetchAssignments() {
  const r = await fetch(`${BASE}/assignments`, { headers: await authHeaders() });
  return r.json();
}

export async function saveAssignment(transaction_id, category_id) {
  const r = await fetch(`${BASE}/assignments`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ transaction_id, category_id }),
  });
  return r.json();
}

// ── Reports ───────────────────────────────────────────────────────────────────
export async function fetchReportSummary(startDate, endDate) {
  const qs = new URLSearchParams();
  if (startDate) qs.set("start_date", startDate);
  if (endDate) qs.set("end_date", endDate);
  const r = await fetch(`${BASE}/reports/summary${qs.toString() ? `?${qs}` : ""}`, {
    headers: await authHeaders(),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `Report request failed: ${r.status}`);
  }
  return r.json();
}

// ── Ask AI ────────────────────────────────────────────────────────────────────
// history: last ≤10 turns as [{ role: "user"|"model", text }]. Throws with
// err.status set so the view can distinguish 503 (not configured) and 429
// (rate limited) from other failures.
export async function askAi(question, history) {
  const r = await fetch(`${BASE}/ask`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ question, history }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body.error || `Ask AI request failed: ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Month-to-date estimated Gemini spend and how close it is to the monthly
// budget, for the settings card. Read-only, so a failure comes back as
// { error } like the other plain GETs rather than throwing.
export async function fetchGeminiUsage() {
  const r = await fetch(`${BASE}/gemini-usage`, { headers: await authHeaders() });
  return r.json();
}

// ── Merchant overrides ────────────────────────────────────────────────────────
export async function fetchMerchantOverrides() {
  const r = await fetch(`${BASE}/merchant-overrides`, { headers: await authHeaders() });
  return r.json();
}

export async function saveMerchantOverride(transaction_id, merchant_name) {
  const r = await fetch(`${BASE}/merchant-overrides`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ transaction_id, merchant_name }),
  });
  return r.json();
}

// ── Account nicknames ─────────────────────────────────────────────────────────
export async function saveAccountNickname(account_id, nickname) {
  const r = await fetch(`${BASE}/account-nicknames`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ account_id, nickname }),
  });
  return r.json();
}

export async function deleteAccountNicknameApi(account_id) {
  const r = await fetch(`${BASE}/account-nicknames/${encodeURIComponent(account_id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── XLSX Export ───────────────────────────────────────────────────────────────
// Optional YYYY-MM-DD bounds so history older than one cap-sized chunk is
// reachable, plus `offset` to page through a range whose slice is bigger than
// the cap — dates alone cannot do that, because no end_date splits a single
// day. Omitting all three is the original behaviour (everything, newest first);
// a 0 or blank offset is omitted from the query string, so the request is
// byte-identical to what it was before the parameter existed.
// The filename still comes off Content-Disposition, so the server's
// "-TRUNCATED" suffix lands on the saved file with no work here. The truncation
// headers ride back with the filename because Settings.jsx renders the row-cap
// notice — and the next offset to ask for — from them.
export async function downloadXlsx(startDate, endDate, offset) {
  const headers = await authHeaders();
  delete headers["Content-Type"];
  const qs = new URLSearchParams();
  if (startDate) qs.set("start_date", startDate);
  if (endDate) qs.set("end_date", endDate);
  if (offset) qs.set("offset", offset);
  const r = await fetch(`${BASE}/export-xlsx${qs.toString() ? `?${qs}` : ""}`, { headers });
  if (!r.ok) {
    // The route answers a bad date range or offset with a 400 and { error };
    // surfacing it beats "Export failed" when the fix is to swap two inputs.
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || "Export failed");
  }
  const blob = await r.blob();
  const disposition = r.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : "finapp-export.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { filename, ...readTruncation(r) };
}

export async function importTransactions(transactions) {
  const r = await fetch(`${BASE}/import`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ transactions }),
  });
  return r.json();
}

// ── Simplifi import ───────────────────────────────────────────────────────────
export async function analyzeSimplifi(csvText, accounts = []) {
  const r = await fetch(`${BASE}/simplifi/analyze`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ csv: csvText, accounts }),
  });
  return r.json();
}

export async function importSimplifi(csvText, newMappings = {}, newAccountMappings = {}) {
  const r = await fetch(`${BASE}/simplifi/import`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ csv: csvText, newMappings, newAccountMappings }),
  });
  return r.json();
}

export async function fetchImportedAccounts() {
  const r = await fetch(`${BASE}/import/accounts`, { headers: await authHeaders() });
  return r.json();
}

export async function deleteImportedAccountApi(account_id) {
  const r = await fetch(`${BASE}/imported-accounts/${encodeURIComponent(account_id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function clearImportedTransactions(accounts = null) {
  const r = await fetch(`${BASE}/import`, {
    method: "DELETE",
    headers: await authHeaders(),
    body: JSON.stringify({ accounts }),
  });
  return r.json();
}

// ── Properties ────────────────────────────────────────────────────────────────
export async function fetchProperties() {
  const r = await fetch(`${BASE}/properties`, { headers: await authHeaders() });
  return r.json();
}

export async function saveProperty(id, address, nickname) {
  const r = await fetch(`${BASE}/properties`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ id: id || undefined, address, nickname }),
  });
  return r.json();
}

export async function deletePropertyApi(id) {
  const r = await fetch(`${BASE}/properties/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function syncPropertiesApi() {
  const r = await fetch(`${BASE}/properties/sync`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function setPropertyBaselineApi(id, value, msa) {
  const r = await fetch(`${BASE}/properties/${id}/baseline`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ value, msa }),
  });
  return r.json();
}

// ── Manual accounts ───────────────────────────────────────────────────────────
export async function fetchManualAccounts() {
  const r = await fetch(`${BASE}/manual-accounts`, { headers: await authHeaders() });
  return r.json();
}

export async function saveManualAccount(id, name, institution, subtype, balance) {
  const r = await fetch(`${BASE}/manual-accounts`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ id: id || undefined, name, institution, subtype, balance }),
  });
  return r.json();
}

export async function deleteManualAccountApi(id) {
  const r = await fetch(`${BASE}/manual-accounts/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── Deduplication ─────────────────────────────────────────────────────────────
export async function previewDuplicates() {
  const r = await fetch(`${BASE}/deduplicate`, { headers: await authHeaders() });
  return r.json();
}

export async function debugDuplicates() {
  const r = await fetch(`${BASE}/deduplicate/debug`, { headers: await authHeaders() });
  return r.json();
}

export async function runDeduplication(groups) {
  const r = await fetch(`${BASE}/deduplicate`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(groups ? { groups } : {}),
  });
  return r.json();
}

// Asks Plaid to resend every item's full history, recovering transactions the
// old duplicate logic deleted. Safe to run more than once — rows that are
// already present upsert onto themselves.
// Starts the job and returns immediately — a full replay runs far longer than
// the proxy will hold a request open. Poll getBackfillStatus for the result.
export async function replayBackfill(range) {
  const r = await fetch(`${BASE}/backfill/replay`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(range ?? {}),
  });
  return r.json();
}

export async function getBackfillStatus() {
  const r = await fetch(`${BASE}/backfill/status`, { headers: await authHeaders() });
  return r.json();
}

// ── Cashflow ──────────────────────────────────────────────────────────────────
export async function fetchCashflowPresets() {
  const r = await fetch(`${BASE}/cashflow/presets`, { headers: await authHeaders() });
  return r.json();
}

export async function saveCashflowPreset(name, amount, freq, note) {
  const r = await fetch(`${BASE}/cashflow/presets`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ name, amount, freq, note }),
  });
  return r.json();
}

export async function deleteCashflowPreset(name) {
  const r = await fetch(`${BASE}/cashflow/presets/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchCashflowStates(monthKey) {
  const r = await fetch(`${BASE}/cashflow/states/${monthKey}`, { headers: await authHeaders() });
  return r.json();
}

export async function saveCashflowState(accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay, note) {
  const r = await fetch(`${BASE}/cashflow/states`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay, note }),
  });
  return r.json();
}

export async function fetchCashflowMappings() {
  const r = await fetch(`${BASE}/cashflow/mappings`, { headers: await authHeaders() });
  return r.json();
}

export async function saveCashflowMapping(merchantPattern, accountId, txnName) {
  const r = await fetch(`${BASE}/cashflow/mappings`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ merchantPattern, accountId, txnName }),
  });
  return r.json();
}

// ── Vehicles ─────────────────────────────────────────────────────────────────
export async function fetchVehicles() {
  const r = await fetch(`${BASE}/vehicles`, { headers: await authHeaders() });
  return r.json();
}

export async function saveVehicle(id, year, make, model, trim, nickname) {
  const r = await fetch(`${BASE}/vehicles`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ id: id || undefined, year, make, model, trim, nickname }),
  });
  return r.json();
}

export async function deleteVehicleApi(id) {
  const r = await fetch(`${BASE}/vehicles/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function setVehicleBaselineApi(id, value, rate) {
  const r = await fetch(`${BASE}/vehicles/${id}/baseline`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ value, rate }),
  });
  return r.json();
}

export async function syncVehiclesApi() {
  const r = await fetch(`${BASE}/vehicles/sync`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── Audit ──────────────────────────────────────────────────────────────────────
export async function getLastAudit() {
  const r = await fetch(`${BASE}/audit/last`, { headers: await authHeaders() });
  return r.json();
}

export async function uploadAuditSheet(base64, filename) {
  const r = await fetch(`${BASE}/audit/upload`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ xlsx: base64, filename }),
  });
  return r.json();
}

export async function completeAudit(auditId, rangeEnd) {
  const r = await fetch(`${BASE}/audit/complete`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ auditId, rangeEnd }),
  });
  return r.json();
}

export async function insertAuditTransactions(auditId, transactions) {
  const r = await fetch(`${BASE}/audit/insert`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ auditId, transactions }),
  });
  return r.json();
}

export async function deleteTransaction(id) {
  const r = await fetch(`${BASE}/transactions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function unhideTransactionApi(id) {
  const r = await fetch(`${BASE}/transactions/${encodeURIComponent(id)}/unhide`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── Review workflow & Gmail receipt scanning ──────────────────────────────────
export async function reviewTransactions(ids) {
  const r = await fetch(`${BASE}/transactions/review`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ ids }),
  });
  return r.json();
}

export async function scanReceipts() {
  const r = await fetch(`${BASE}/receipts/scan`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function gmailStatus() {
  const r = await fetch(`${BASE}/gmail/status`, { headers: await authHeaders() });
  return r.json();
}

export async function gmailAuthUrl() {
  const r = await fetch(`${BASE}/gmail/auth-url`, { headers: await authHeaders() });
  return r.json();
}

export async function gmailAuthCode(code) {
  const r = await fetch(`${BASE}/gmail/auth-code`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ code }),
  });
  return r.json();
}

// ── Splits ────────────────────────────────────────────────────────────────────
export async function fetchSplits() {
  const r = await fetch(`${BASE}/splits`, { headers: await authHeaders() });
  return r.json();
}

export async function replaceSplitsApi(transactionId, splits) {
  const r = await fetch(`${BASE}/splits/${encodeURIComponent(transactionId)}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ splits }),
  });
  if (!r.ok) throw new Error(`Save splits failed: ${r.status}`);
  return r.json();
}

// ── Hidden accounts ───────────────────────────────────────────────────────────
export async function fetchHiddenAccounts() {
  const r = await fetch(`${BASE}/hidden-accounts`, { headers: await authHeaders() });
  return r.json();
}

export async function addHiddenAccountApi(account_id) {
  const r = await fetch(`${BASE}/hidden-accounts`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ account_id }),
  });
  return r.json();
}

export async function removeHiddenAccountApi(account_id) {
  const r = await fetch(`${BASE}/hidden-accounts/${encodeURIComponent(account_id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

// ── Property Finance ──────────────────────────────────────────────────────────
export async function fetchPropertyFinanceProperties() {
  const r = await fetch(`${BASE}/property-finance/properties`, { headers: await authHeaders() });
  return r.json();
}

export async function seedPropertyFinanceApi() {
  const r = await fetch(`${BASE}/property-finance/seed`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchPropertyFinanceDetail(propertyId) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}`, { headers: await authHeaders() });
  return r.json();
}

export async function startPropertyYear(propertyId, year) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/years`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ year }),
  });
  return r.json();
}

export async function addPropertyUsagePeriod(propertyId, body) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/usage-periods`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function deletePropertyUsagePeriod(id) {
  const r = await fetch(`${BASE}/property-finance/usage-periods/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchPropertyDepreciation(propertyId) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/depreciation`, { headers: await authHeaders() });
  return r.json();
}

export async function savePropertyDepreciation(propertyId, year, amount) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/depreciation/${year}`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ amount }),
  });
  return r.json();
}

export async function deletePropertyDepreciation(propertyId, year) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/depreciation/${year}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchPropertyTransactions(propertyId, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "")).toString();
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/transactions${qs ? `?${qs}` : ""}`, { headers: await authHeaders() });
  return r.json();
}

export async function updatePropertyTransactionCategory(transactionId, normalizedCategory) {
  const r = await fetch(`${BASE}/property-finance/transactions/${encodeURIComponent(transactionId)}/category`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify({ normalizedCategory }),
  });
  return r.json();
}

export async function updatePropertyTransactionAllocation(transactionId, allocation) {
  const r = await fetch(`${BASE}/property-finance/transactions/${encodeURIComponent(transactionId)}/allocation`, {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify(allocation),
  });
  return r.json();
}

export async function reconcilePropertyTransaction(transactionId, isReconciled, viaReserveAccount = false) {
  const r = await fetch(`${BASE}/property-finance/transactions/${encodeURIComponent(transactionId)}/reconcile`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ isReconciled, viaReserveAccount }),
  });
  return r.json();
}

export async function excludePropertyTransaction(transactionId, excluded = true) {
  const r = await fetch(`${BASE}/property-finance/transactions/${encodeURIComponent(transactionId)}/exclude`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ excluded }),
  });
  return r.json();
}

export async function fetchPropertyReviewQueue(propertyId) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/review-queue`, { headers: await authHeaders() });
  return r.json();
}

export async function resolvePropertyReviewRow(id) {
  const r = await fetch(`${BASE}/property-finance/review-queue/${id}/resolve`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}

export async function fetchPropertyUsagePeriods(propertyId, year) {
  const qs = year ? `?year=${year}` : "";
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/usage-periods${qs}`, { headers: await authHeaders() });
  return r.json();
}

export async function fetchPropertyAuditLog(propertyId) {
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/audit-log`, { headers: await authHeaders() });
  return r.json();
}

export async function fetchPropertyPlaidPreview(propertyId, year) {
  const qs = year ? `?year=${year}` : "";
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/plaid-preview${qs}`, { headers: await authHeaders() });
  return r.json();
}

export async function applyPropertyPlaidPreview(propertyId, transactionId, year) {
  const qs = year ? `?year=${year}` : "";
  const r = await fetch(`${BASE}/property-finance/properties/${propertyId}/plaid-preview/apply${qs}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ transactionId }),
  });
  return r.json();
}

// One calendar month of transactions. The old limit=200 sat below what a busy
// month actually produces, so CashFlow silently under-reported one; 2000 is the
// server's own default page size and is far more than a month holds, while
// staying well under the 10,000 hard ceiling that keeps the 256 MB VM alive.
// The truncation flag rides along so a month that still hits the cap can be
// shown as partial rather than short.
const MONTH_TXN_LIMIT = 2000;

export async function fetchTransactionsForMonth(monthKey) {
  const [year, month] = monthKey.split("-");
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  const r = await fetch(`${BASE}/transactions?start_date=${startDate}&end_date=${endDate}&limit=${MONTH_TXN_LIMIT}`, {
    headers: await authHeaders(),
  });
  const body = await r.json();
  return { ...body, ...readTruncation(r) };
}
