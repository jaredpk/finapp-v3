const BASE = "/api";

let _getToken = async () => null;
export const setTokenGetter = (fn) => { _getToken = fn; };

async function authHeaders(extra = {}) {
  const token = await _getToken();
  const h = { "Content-Type": "application/json", ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
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

export async function fetchAccounts() {
  const r = await fetch(`${BASE}/accounts`, { headers: await authHeaders() });
  return r.json();
}

export async function fetchTransactions() {
  const r = await fetch(`${BASE}/transactions`, { headers: await authHeaders() });
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

// ── XLSX Import ───────────────────────────────────────────────────────────────
export async function importXlsx(base64) {
  const r = await fetch(`${BASE}/import-xlsx`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ xlsx: base64 }),
  });
  return r.json();
}

// ── CSV Import ────────────────────────────────────────────────────────────────
export async function importCsvTransactions(csvText) {
  const r = await fetch(`${BASE}/import-csv`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ csv: csvText }),
  });
  return r.json();
}

export async function importTransactions(transactions) {
  const r = await fetch(`${BASE}/import`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ transactions }),
  });
  return r.json();
}

export async function clearImportedTransactions() {
  const r = await fetch(`${BASE}/import`, {
    method: "DELETE",
    headers: await authHeaders(),
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

export async function fetchCashflowStates(monthKey) {
  const r = await fetch(`${BASE}/cashflow/states/${monthKey}`, { headers: await authHeaders() });
  return r.json();
}

export async function saveCashflowState(accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay) {
  const r = await fetch(`${BASE}/cashflow/states`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ accountId, txnId, monthKey, isPending, actualAmount, plaidTxnId, actualDay }),
  });
  return r.json();
}

export async function importMacuCsv(csvText, accountName) {
  const r = await fetch(`${BASE}/import-macu-csv`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ csv: csvText, accountName }),
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

export async function fetchTransactionsForMonth(monthKey) {
  const [year, month] = monthKey.split("-");
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  const r = await fetch(`${BASE}/transactions?start_date=${startDate}&end_date=${endDate}&limit=200`, {
    headers: await authHeaders(),
  });
  return r.json();
}
