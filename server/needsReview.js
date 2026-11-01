// The "Needs Review" definition, shared by GET /api/transactions?needs_review=1
// (via getTransactions in db.js) and pinned by test against
// getTransactionStats' needs_review aggregate, so the Transactions tile's number
// and the list behind it cannot drift apart.
//
// I/O-free on purpose (no pg), like limits.js, so it is unit-testable without a
// database.
//
// Mirrors getTransactionStats exactly, quirks included:
//   - visible = not hidden and not on a hidden account. Pending rows COUNT (the
//     tiles never excluded them).
//   - needs review = no assignment WITH a category_id (a NULL-category
//     assignment row still reads as unassigned) AND no splits.
// Written against the alias `t` for the transactions table.
export const NEEDS_REVIEW_CONDITIONS = [
  "(t.hidden IS NOT TRUE)",
  "(t.account NOT IN (SELECT account_id FROM hidden_accounts))",
  "NOT EXISTS (SELECT 1 FROM assignments a WHERE a.transaction_id = t.id AND a.category_id IS NOT NULL)",
  "NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)",
];

// Only the exact string "1" turns the filter on. Anything else (absent, "true",
// "0", "01", arrays from a repeated param) leaves /api/transactions as it was.
export function parseNeedsReview(raw) {
  return raw === "1";
}
