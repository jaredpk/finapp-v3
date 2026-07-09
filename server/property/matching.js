import { suggestCategoryFromText, NORMALIZED_CATEGORIES } from "./categories.js";

// Rule-based attribution: given one live Plaid-shaped transaction and the
// property's transaction history (already-categorized pf_transactions rows,
// plus any manual pf_category_mappings), decide whether it belongs to the
// property, what category it likely is, and how confident we are.
//
// Returns null if the transaction clearly doesn't belong to the property
// (used to filter a whole-account feed down to rental-relevant activity).
export function matchPlaidTransaction(plaidTxn, { historicalTransactions = [], categoryMappings = [] } = {}) {
  const merchant = plaidTxn.merchant_name || plaidTxn.name || "";
  const merchantKey = normalizeMerchant(merchant);
  const amount = Math.abs(plaidTxn.amount);
  const direction = plaidTxn.amount < 0 ? "income" : "expense";

  const exactMapping = categoryMappings.find((m) => m.match_key === merchantKey);
  if (exactMapping) {
    return {
      normalizedCategory: exactMapping.normalized_category,
      direction,
      confidence: 0.95,
      explanation: `Merchant "${merchant}" was manually mapped to ${exactMapping.normalized_category} ${exactMapping.hit_count} time(s) before.`,
      matchedVia: "category_mapping",
    };
  }

  const historyHit = findBestHistoryMatch(merchant, amount, historicalTransactions);
  if (historyHit) {
    return {
      normalizedCategory: historyHit.category,
      direction,
      confidence: historyHit.confidence,
      explanation: historyHit.explanation,
      matchedVia: "history",
    };
  }

  const keywordCategory = suggestCategoryFromText(`${merchant} ${plaidTxn.name || ""}`);
  if (keywordCategory !== "Uncategorized") {
    return {
      normalizedCategory: keywordCategory,
      direction,
      confidence: 0.55,
      explanation: `Merchant name "${merchant}" matched a known keyword pattern for ${keywordCategory}.`,
      matchedVia: "keyword",
    };
  }

  return {
    normalizedCategory: "Uncategorized",
    direction,
    confidence: 0.15,
    explanation: `No merchant history, mapping, or keyword pattern matched "${merchant}". Needs manual review.`,
    matchedVia: "none",
  };
}

function normalizeMerchant(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Looks for prior transactions with the same normalized merchant, weighting
// confidence up when amounts also line up closely (recurring bill pattern).
function findBestHistoryMatch(merchant, amount, historicalTransactions) {
  const key = normalizeMerchant(merchant);
  if (!key) return null;
  const candidates = historicalTransactions.filter((t) => normalizeMerchant(t.merchant || "") === key);
  if (candidates.length === 0) return null;

  const categoryTally = {};
  candidates.forEach((t) => { categoryTally[t.normalizedCategory || t.normalized_category] = (categoryTally[t.normalizedCategory || t.normalized_category] || 0) + 1; });
  const [bestCategory, count] = Object.entries(categoryTally).sort((a, b) => b[1] - a[1])[0];

  const amountsClose = candidates.some((t) => Math.abs(Number(t.amount) - amount) / Math.max(amount, 1) < 0.15);
  const confidence = Math.min(0.5 + count * 0.1 + (amountsClose ? 0.15 : 0), 0.9);

  return {
    category: bestCategory,
    confidence,
    explanation: `Matched ${count} prior transaction(s) from "${merchant}" categorized as ${bestCategory}${amountsClose ? " with a similar amount" : ""}.`,
  };
}

// Recurring-charge detection: groups a transaction list (Plaid-shaped or
// pf_transactions rows) by normalized merchant and flags groups that recur
// on a roughly monthly cadence — utilities, HOA, insurance, subscriptions.
export function detectRecurringCharges(transactions, { minOccurrences = 2 } = {}) {
  const groups = {};
  for (const t of transactions) {
    const merchant = t.merchant_name || t.merchant || t.name || "";
    const key = normalizeMerchant(merchant);
    if (!key) continue;
    (groups[key] = groups[key] || []).push(t);
  }

  const recurring = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.length < minOccurrences) continue;
    const dates = group.map((t) => new Date(t.date || t.transaction_date)).sort((a, b) => a - b);
    const gapsInDays = [];
    for (let i = 1; i < dates.length; i++) gapsInDays.push((dates[i] - dates[i - 1]) / 86400000);
    const avgGap = gapsInDays.reduce((a, b) => a + b, 0) / (gapsInDays.length || 1);
    const isMonthlyish = avgGap >= 20 && avgGap <= 40;
    if (isMonthlyish || group.length >= 3) {
      recurring.push({
        merchantKey: key,
        merchant: group[0].merchant_name || group[0].merchant || group[0].name,
        occurrences: group.length,
        averageGapDays: Math.round(avgGap),
        averageAmount: Math.round((group.reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0) / group.length) * 100) / 100,
        likelyCategory: suggestCategoryFromText(group[0].merchant_name || group[0].merchant || group[0].name),
      });
    }
  }
  return recurring;
}

export function isKnownCategory(category) {
  return NORMALIZED_CATEGORIES.includes(category);
}
