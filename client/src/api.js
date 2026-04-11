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
