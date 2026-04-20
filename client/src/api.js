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

export async function deleteCategoryApi(id) {
  const r = await fetch(`${BASE}/categories/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
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

// ── CSV Import ────────────────────────────────────────────────────────────────
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

// ── Deduplication ─────────────────────────────────────────────────────────────
export async function previewDuplicates() {
  const r = await fetch(`${BASE}/deduplicate`, { headers: await authHeaders() });
  return r.json();
}

export async function debugDuplicates() {
  const r = await fetch(`${BASE}/deduplicate/debug`, { headers: await authHeaders() });
  return r.json();
}

export async function runDeduplication() {
  const r = await fetch(`${BASE}/deduplicate`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return r.json();
}
