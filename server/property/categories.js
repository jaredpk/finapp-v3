// Canonical normalized categories for rental-property accounting (Schedule E aligned).
export const NORMALIZED_CATEGORIES = [
  "Rents",
  "Utilities",
  "Management Fees",
  "Maintenance",
  "Repairs",
  "Insurance",
  "Taxes",
  "Advertising",
  "Travel",
  "Improvement",
  "Commissions",
  "Uncategorized",
];

export const INCOME_CATEGORIES = new Set(["Rents"]);

export function directionForCategory(category) {
  return INCOME_CATEGORIES.has(category) ? "income" : "expense";
}

// Loose keyword → normalized-category heuristics used both by the spreadsheet
// importer (to fall back on when a sheet's own category text doesn't map
// cleanly) and by the Plaid matcher's category-suggestion step.
const KEYWORD_RULES = [
  [/\b(airbnb|vrbo)\b.*\bpayouts?\b|\bpayouts?\b.*\b(airbnb|vrbo)\b/i, "Rents"],
  [/\brent(al)?\s*(income|received|deposit)?\b/i, "Rents"],
  [/\b(hoa|association|electric|power ?&? ?light|water|sewer|gas|cable|internet|utility|utilities|comcast|fpl|duke energy)\b/i, "Utilities"],
  [/\b(management fee|property manager|host fee|service fee|management co)\b/i, "Management Fees"],
  [/\b(maintenance|cleaning|pest control|lawn|landscap|hvac service|pool service)\b/i, "Maintenance"],
  [/\b(repair|plumb|handyman|fix|replace(ment)? part)\b/i, "Repairs"],
  [/\b(insurance|hurricane policy|flood policy)\b/i, "Insurance"],
  [/\b(property tax|county tax|tax assessor|tourist tax|sales tax)\b/i, "Taxes"],
  [/\b(advertis|listing fee|marketing|zillow|furnished finder)\b/i, "Advertising"],
  [/\b(travel|mileage|airfare|flight|hotel stay|rental car)\b/i, "Travel"],
  [/\b(renovat|remodel|improvement|upgrade|new appliance|capital)\b/i, "Improvement"],
  [/\b(commission|referral fee|booking commission|airbnb service fee|vrbo commission)\b/i, "Commissions"],
];

export function suggestCategoryFromText(text) {
  if (!text) return "Uncategorized";
  for (const [pattern, category] of KEYWORD_RULES) {
    if (pattern.test(text)) return category;
  }
  return "Uncategorized";
}

export function isValidCategory(category) {
  return NORMALIZED_CATEGORIES.includes(category);
}
