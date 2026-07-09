// Pure helpers shared across the Property Finance components. Kept out of
// the components themselves per the "business logic out of UI" constraint —
// these are display/aggregation helpers, not data access.
export const fmt = (n) =>
  "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtSigned = (n) => {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : ""}${fmt(v)}`;
};

export function signedAmount(t) {
  const amt = Math.abs(Number(t.amount) || 0);
  return t.direction === "income" ? amt : -amt;
}

export function summarizeYear(transactions) {
  let income = 0, expense = 0, unreconciled = 0, needsReview = 0;
  for (const t of transactions) {
    if (t.excluded) continue;
    if (t.direction === "income") income += Number(t.amount);
    else expense += Number(t.amount);
    if (!t.is_reconciled) unreconciled++;
    if (t.needs_review) needsReview++;
  }
  return { income, expense, net: income - expense, unreconciled, needsReview, count: transactions.length };
}

export function groupByMonth(transactions) {
  const map = {};
  for (const t of transactions) {
    if (t.excluded) continue;
    const key = t.posting_month;
    if (!map[key]) map[key] = { month: key, income: 0, expense: 0 };
    if (t.direction === "income") map[key].income += Number(t.amount);
    else map[key].expense += Number(t.amount);
  }
  return Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
}

export function groupByCategory(transactions) {
  const map = {};
  for (const t of transactions) {
    if (t.excluded) continue;
    const key = t.normalized_category || "Uncategorized";
    if (!map[key]) map[key] = { category: key, income: 0, expense: 0, count: 0 };
    if (t.direction === "income") map[key].income += Number(t.amount);
    else map[key].expense += Number(t.amount);
    map[key].count++;
  }
  return Object.values(map).sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
}

export function monthLabel(monthKey) {
  if (!monthKey) return "";
  const [y, m] = monthKey.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
}
