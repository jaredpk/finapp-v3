import test from "node:test";
import assert from "node:assert/strict";
import { stillNeedsReview, needsReviewBanner, needsReviewCsvLabel } from "../src/needsReviewFilter.js";
import { csvFilename } from "../src/csvExport.js";

const rows = [{ transaction_id: "a" }, { transaction_id: "b" }, { transaction_id: "c" }, { transaction_id: "d" }];

test("stillNeedsReview drops rows that gained a category or splits", () => {
  const out = stillNeedsReview(rows, { b: "cat1", c: null }, { d: [{ id: 1 }] });
  assert.deepEqual(out.map((t) => t.transaction_id), ["a", "c"]);
});

test("stillNeedsReview treats empty splits and missing maps as needing review", () => {
  assert.equal(stillNeedsReview(rows, undefined, undefined).length, 4);
  assert.equal(stillNeedsReview(rows, {}, { a: [] }).length, 4);
  assert.deepEqual(stillNeedsReview(null, {}, {}), []);
});

test("needsReviewBanner: complete set", () => {
  assert.equal(
    needsReviewBanner({ count: 1234, truncated: false, limit: 10000, dateFiltered: false }),
    "Showing 1,234 transactions needing review (all dates)"
  );
  assert.equal(
    needsReviewBanner({ count: 1, truncated: false, limit: 10000, dateFiltered: true }),
    "Showing 1 transaction needing review (date filter applied)"
  );
});

test("needsReviewBanner: truncated set is honest about the cap", () => {
  const s = needsReviewBanner({ count: 10000, truncated: true, limit: 10000, dateFiltered: false });
  assert.match(s, /newest 10,000/);
  assert.match(s, /more than the 10,000-row limit/);
});

test("needsReviewCsvLabel names the mode in the filename", () => {
  assert.equal(needsReviewCsvLabel(null), "needs-review");
  assert.equal(needsReviewCsvLabel("Groceries"), "needs-review Groceries");
  assert.equal(
    csvFilename({ categoryLabel: needsReviewCsvLabel(null), generatedOn: "2026-11-01" }),
    "finapp-transactions-needs-review-2026-11-01.csv"
  );
  assert.equal(
    csvFilename({ categoryLabel: needsReviewCsvLabel(null), partial: true, generatedOn: "2026-11-01" }),
    "finapp-transactions-needs-review-2026-11-01-partial.csv"
  );
});
