// Pure transaction-matching logic — no DB access, no side effects, so every
// rule here can be unit-tested (server/test/transactionMatching.test.js).
//
// This module exists because the previous duplicate detection keyed on
// (date, ABS(amount)) alone. Stripping the sign collapsed a charge with its
// refund, and dropping the account collapsed a card payment's funding leg with
// the card-side credit — real July 2026 transactions were deleted that way.
// Every key built here keeps the sign AND the account.

// Plaid's transaction_id is the primary key and every sync path upserts with
// ON CONFLICT (id), so Plaid-native rows are already idempotent. The only rows
// that can legitimately be redundant are ones we imported ourselves.
export function isImportedId(id) {
  const s = String(id ?? "");
  return s.startsWith("csv_") || s.startsWith("simplifi_");
}

// DATE columns come back from pg as Date objects but arrive as strings from
// parsers and tests; normalize both to YYYY-MM-DD so keys stay comparable.
function normalizeDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

// NUMERIC columns come back as strings from pg. Round to cents but keep the
// sign: +9.99 and -9.99 are opposite-direction transactions, never duplicates.
function normalizeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  const rounded = Number(n.toFixed(2));
  return rounded === 0 ? 0 : rounded;
}

function normalizeMerchant(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Stable identity for a transaction: date + account + SIGNED amount + merchant.
// Omitting any one of these is what destroyed data before.
export function duplicateKey(row) {
  return [
    normalizeDate(row.date),
    String(row.account ?? ""),
    normalizeAmount(row.amount).toFixed(2),
    normalizeMerchant(row.merchant),
  ].join("|");
}

function createdAtMs(row) {
  const t = new Date(row.created_at ?? NaN).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function earliest(rows) {
  return rows.reduce((best, r) => (createdAtMs(r) < createdAtMs(best) ? r : best));
}

// Groups rows that share a duplicateKey and proposes which ids to remove.
//
// SAFETY RULE: only csv_/simplifi_ rows may ever land in `remove`. A
// Plaid-native row is authoritative — if two of them share a key that is a
// Plaid data question, not something a sweep should silently resolve by
// deleting one. Such groups are dropped entirely.
export function groupDuplicates(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = duplicateKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const imported = members.filter((m) => isImportedId(m.id));
    const native = members.filter((m) => !isImportedId(m.id));
    if (imported.length === 0) continue;

    // Prefer the Plaid-native row as the keeper; an all-imported group keeps
    // whichever copy landed first.
    const keep = native.length > 0 ? earliest(native) : earliest(imported);
    const remove = imported.filter((m) => m !== keep);
    // Fewer than 2 members survive the safety rule — nothing to reconcile.
    if (remove.length === 0) continue;

    groups.push({
      key,
      keep: keep.id,
      remove: remove.map((m) => m.id),
      merchants: [keep, ...remove].map((m) => m.merchant ?? null),
      date: normalizeDate(keep.date),
      amount: normalizeAmount(keep.amount),
      account: keep.account ?? null,
    });
  }
  return groups;
}

// ── Card-payment reconciliation ───────────────────────────────────────────────
// A card payment always has two legs: money leaving a depository account
// (positive amount, Plaid convention) and the matching credit landing on the
// card (negative amount, different account). When only the funding leg exists,
// a credit went missing — which is exactly the symptom the ABS()-keyed dedup
// produced. Extend this list as new payment descriptors show up.
export const CARD_PAYMENT_PATTERNS = [
  "capital one",
  "amex epayment",
  "american express",
  "chase card",
  "discover",
  "card payment",
  "online payment",
  "cardmember",
  "bill pay",
];

function isCardPaymentDescriptor(row) {
  const text = normalizeMerchant(row.merchant ?? row.name);
  if (!text) return false;
  return CARD_PAYMENT_PATTERNS.some((p) => text.includes(p));
}

function dayDiff(a, b) {
  const ta = Date.parse(`${normalizeDate(a)}T00:00:00Z`);
  const tb = Date.parse(`${normalizeDate(b)}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(ta - tb) / 86400000;
}

// Returns one entry per funding leg with no card-side credit to pair with.
// Each card leg can only settle one funding leg, so two identical payments in
// the same window still need two credits.
export function findUnmatchedPaymentLegs(rows, { depositoryAccounts = new Set(), windowDays = 3 } = {}) {
  const fundingLegs = rows.filter(
    (r) => normalizeAmount(r.amount) > 0 && depositoryAccounts.has(r.account) && isCardPaymentDescriptor(r)
  );
  const cardLegs = rows.filter((r) => normalizeAmount(r.amount) < 0);
  const claimed = new Set();

  const unmatched = [];
  for (const fundingLeg of fundingLegs) {
    const amount = Math.abs(normalizeAmount(fundingLeg.amount));
    const match = cardLegs.find(
      (c) =>
        !claimed.has(c) &&
        c.account !== fundingLeg.account &&
        Math.abs(normalizeAmount(c.amount)) === amount &&
        dayDiff(c.date, fundingLeg.date) <= windowDays
    );
    if (match) claimed.add(match);
    else unmatched.push({ fundingLeg, reason: "no matching card-side credit" });
  }
  return unmatched;
}
