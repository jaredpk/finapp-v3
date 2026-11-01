// Pure logic behind the Transactions page's clickable "Needs Review" tile.
// No React, no fetch — testable with node --test (test/needsReviewFilter.test.js).
//
// The mode shows the server's needs-review set (GET /api/transactions?needs_review=1)
// instead of the 2000-row window, so rows older than that window are reachable.

// Rows of the fetched set that STILL need review given the page's live
// assignments/splits. Categorising or splitting a row in this mode drops it from
// the list immediately (the server set was a snapshot); the tile refetches its
// own count separately. Same test the page's loaded-row stats use: a falsy
// assignment (null category) and no splits.
export function stillNeedsReview(rows, assignments, splits) {
  return (rows || []).filter(
    (t) => !assignments?.[t.transaction_id] && !splits?.[t.transaction_id]?.length
  );
}

// The banner text. `truncated` means the server cap cut the needs-review set
// itself, so the count is a floor, not the number of rows that need review.
// `dateFiltered` is whether the page's own date preset is narrowing the set
// client-side (the fetch is always all-dates). `visible` is the number of rows
// actually listed; when a date filter narrows the set it is reported as
// "V of N" so the banner agrees with the list and the toolbar.
export function needsReviewBanner({ count, visible, truncated, limit, dateFiltered }) {
  const n = Number(count || 0).toLocaleString("en-US");
  const scope = dateFiltered ? "date filter applied" : "all dates";
  const narrowed = dateFiltered && visible != null && visible !== count;
  const v = narrowed ? Number(visible).toLocaleString("en-US") : null;
  if (truncated) {
    const cap = limit ? ` ${Number(limit).toLocaleString("en-US")}` : "";
    const shown = narrowed ? `${v} of the newest ${n}` : `the newest ${n}`;
    return `Showing ${shown} transactions needing review (${scope}) — there are more than the${cap}-row limit, so older ones are not listed.`;
  }
  if (narrowed) return `Showing ${v} of ${n} ${count === 1 ? "transaction" : "transactions"} needing review (${scope})`;
  return `Showing ${n} ${count === 1 ? "transaction" : "transactions"} needing review (${scope})`;
}

// Approval-chip figures in Needs Review mode: rows awaiting approval vs the size
// of the needs-review set (hidden rows / hidden accounts excluded, as in the
// list) — the set the chip filter and "Approve all shown" actually act on.
export function needsReviewApprovalCounts(rows, hiddenAccounts) {
  const set = (rows || []).filter((t) => !t.hidden && !hiddenAccounts?.has(t.account_id));
  return { awaiting: set.filter((t) => t.reviewed_at == null).length, total: set.length };
}

// CSV filename label: the export must not be mistakable for a full export, so
// the mode is named in the file; a category filter on top is appended.
export function needsReviewCsvLabel(categoryLabel) {
  return categoryLabel ? `needs-review ${categoryLabel}` : "needs-review";
}
