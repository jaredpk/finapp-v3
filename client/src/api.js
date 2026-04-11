const BASE = "/api";
const USER_ID = "demo-user";

export async function createLinkToken() {
  const r = await fetch(`${BASE}/create_link_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER_ID }),
  });
  return r.json();
}

export async function exchangePublicToken(public_token) {
  const r = await fetch(`${BASE}/exchange_public_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_token, userId: USER_ID }),
  });
  return r.json();
}

export async function fetchAccounts() {
  const r = await fetch(`${BASE}/accounts?userId=${USER_ID}`);
  return r.json();
}

export async function fetchTransactions() {
  const r = await fetch(`${BASE}/transactions?userId=${USER_ID}`);
  return r.json();
}

export async function fetchBalance() {
  const r = await fetch(`${BASE}/balance?userId=${USER_ID}`);
  return r.json();
}
