import { parseYearSheet } from "./parseYearSheet.js";

export { parseYearSheet };

// Parses a full workbook's worth of year tabs (2021-2026) and assigns stable,
// deterministic import-scoped ids to each transaction so re-running an import
// is idempotent for a given batch label.
export function parseWorkbook(sheets, { propertyId, batchLabelPrefix = "import" } = {}) {
  const transactions = [];
  const usagePeriods = [];
  const reviewQueue = [];

  for (const sheet of sheets) {
    const result = parseYearSheet(sheet);
    result.transactions.forEach((t, i) => {
      transactions.push({
        ...t,
        id: `${batchLabelPrefix}_${propertyId}_${sheet.year}_${i}`,
        propertyId,
        taxYear: t.year,
      });
    });
    usagePeriods.push(...result.usagePeriods.map((u) => ({ ...u, propertyId })));
    reviewQueue.push(...result.reviewQueue);
  }

  return { transactions, usagePeriods, reviewQueue };
}
