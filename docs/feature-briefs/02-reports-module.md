# Brief 02 — Reports Module

**Goal:** A new **Reports** view with server-side aggregation: monthly spending by
category, income vs. expense, net cash flow, and top merchants over a selectable date
range. Charts use Recharts (already a dependency, `^2.12.7`, see `Dashboard.jsx`).

## Design decisions (already made — do not revisit)

1. **Aggregate on the server**, not the client. The client currently loads ~90 days of
   transactions; reports need arbitrary ranges (e.g. 12 months) without shipping every
   row to the browser.
2. **New view `Reports.jsx` + Sidebar entry.** Do not build on `Budget.jsx` or
   `CashFlow.jsx` — both are partial scaffolds; leave them alone.
3. One endpoint returning all report datasets for a range in a single response
   (single-user app; simplicity beats granular endpoints).

## Correctness rules for aggregation (the actual hard part)

Every aggregate must apply, in this order:

1. **Exclusions:** `hidden IS NOT TRUE`, `status != 'pending'`, and
   `account NOT IN (SELECT account_id FROM hidden_accounts)`. This mirrors
   `getSpendingByCategory` (`server/db.js:670`) — read that function first and reuse
   its conditions.
2. **Effective category:** a transaction's category comes from the `assignments`
   table (`assignments.category_id → categories`), **except** when rows exist in
   `splits` for that transaction — then the transaction contributes its **split
   amounts to each split's category** instead of its full amount to the assigned
   category. Unassigned, unsplit transactions go to an "Uncategorized" bucket.
3. **Effective merchant:** `merchant_overrides.merchant_name` if present, else the
   transaction's `merchant` (fall back to `name`). Mirrors `getDisplayName` in
   `Transactions.jsx`.
4. **Sign convention:** in this schema positive `amount` = outflow/spend, negative =
   inflow (matches `getSpendingByCategory`'s `amount > 0` filter and the Dashboard's
   spend math — verify against `Dashboard.jsx` before coding). Spend aggregates use
   `amount > 0`; income aggregates use `amount < 0` with the sign flipped for
   display. **Exclude inter-account transfers from income/spend if a transfer
   category exists** — check the seeded categories; if there's a "Transfer"-like
   category, exclude it from income/expense totals but show it in the by-category
   table.

## Server changes

### Endpoint

`GET /api/reports/summary?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` — behind
`requireApiKeyOrAuth` (same guard as `GET /api/transactions`, so the MCP/API-key
surface can reuse it later). Response shape:

```json
{
  "start_date": "...", "end_date": "...",
  "monthly": [
    { "month": "2026-01",
      "income": 8200.00, "spend": 6100.25, "net": 2099.75,
      "by_category": [ { "category_id": "…|null", "name": "Groceries", "color": "#22c55e", "amount": 812.40 } ] }
  ],
  "totals": { "income": 0, "spend": 0, "net": 0,
              "by_category": [ …same shape, whole range… ] },
  "top_merchants": [ { "merchant": "Costco", "amount": 1240.10, "count": 9 } ]
}
```

Implement as a new exported function in `server/db.js` (e.g. `getReportSummary`).
Recommended approach: one SQL pass producing per-month × per-category rows using a
CTE that explodes splits — e.g. `LEFT JOIN splits s ON s.transaction_id = t.id`,
`COALESCE(s.amount, t.amount)` as the contribution and
`COALESCE(s.category_id, a.category_id)` as the category — then assemble the JSON in
JS. Top merchants: separate simple query (spend only, `amount > 0`, overrides
applied, `LIMIT 15`).

Guard rails: default range = last 6 full months when params are missing; reject
ranges > 5 years; dates validated as `YYYY-MM-DD`.

### Tests

Factor the month-bucketing/assembly (rows → response shape) into a pure function and
add cases to `server/test/` using `node:test`, including: a split transaction (splits
override the assignment; leftover amount, if splits don't sum to the total, stays
with the assigned category — match whatever convention the existing splits UI
implies, check `replaceSplits` in `db.js:1794` and the split editor in
`Transactions.jsx`), a hidden transaction (excluded), and an unassigned one
(Uncategorized).

## Client changes

- `api.js`: `fetchReportSummary(startDate, endDate)`.
- `views/Reports.jsx` (new), fetches on mount and when the range changes:
  - **Range picker:** preset chips — 3M / 6M / 12M / YTD / All — plus two date
    inputs. Default 6M.
  - **Income vs. Spend** — Recharts `BarChart`, two bars per month, plus a `Line`
    for net (use `ComposedChart`).
  - **Spending by category over time** — stacked `BarChart`, one series per category
    using each category's stored `color`; group categories beyond the top 8 (by
    range total) into "Other".
  - **Category totals table** — name, color swatch, total, % of spend, sorted desc.
  - **Top merchants table** — merchant, count, total.
  - Style with the existing inline-style + CSS-variable conventions
    (`--surface`, `--border`, `--muted`, `--accent`); follow `Dashboard.jsx` for
    Recharts theming (axis/grid colors, `ResponsiveContainer`).
- `components/Sidebar.jsx`: add a "Reports" nav item (icon: bar-chart), routed the
  same way as the existing 8 views (`App.jsx` view-switch — follow the pattern used
  by e.g. `Categories`).

## Out of scope

- CSV/PDF export of reports (the XLSX export endpoint already exists).
- Budget-vs-actual comparisons (belongs to Budget view).
- Property-finance reporting (`server/property/` has its own module).

## Acceptance criteria

1. Endpoint returns correct totals on a seeded test DB: a split transaction counts
   under its split categories; hidden transactions/accounts and Plaid-pending rows
   contribute nothing; income and spend match hand-computed sums.
2. Changing the range refetches and re-renders without errors; empty ranges render an
   empty state, not a crash.
3. New unit tests pass alongside the existing suite
   (`cd server && npm test`).
4. Dashboard, Transactions, and existing views are visually and functionally
   unchanged.
