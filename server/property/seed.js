import { parseWorkbook } from "./importParsers/index.js";
import { allBackfillSheets } from "./fixtures/sampleSheets.js";
import { sampleLivePlaidTransactions } from "./fixtures/samplePlaidTransactions.js";
import { matchPlaidTransaction } from "./matching.js";
import {
  listProperties, createProperty, ensurePropertyYear,
  createImportBatch, updateImportBatchCounts, insertUsagePeriods, insertReviewRows,
  bulkUpsertTransactions, listCategoryMappings, upsertTransaction, recordAudit,
  setTransactionReconciled,
} from "./repository.js";

const SEED_PROPERTY_NAME = "Seaside Condo";

// Idempotent-ish demo seed: creates the Seaside Condo property (if missing),
// backfills 2021-2025 from the mock spreadsheet fixtures through the real
// import pipeline, and seeds 2026 as the "live" year by running the mock
// Plaid feed through the real matching layer. Safe to call more than once —
// re-running re-imports the same deterministic ids (upsert) and only adds a
// fresh review-queue/audit trail entry per run.
export async function seedPropertyFinanceData() {
  const existing = await listProperties();
  let property = existing.find((p) => p.name === SEED_PROPERTY_NAME);
  if (!property) {
    property = await createProperty({
      name: SEED_PROPERTY_NAME,
      address: "1200 Gulf Shore Blvd, Naples, FL 34102",
      state: "FL",
      propertyType: "condo",
      acquiredDate: "2020-11-01",
    });
  }
  const propertyId = property.id;
  const currentYear = new Date().getFullYear();

  for (const sheet of allBackfillSheets) {
    await ensurePropertyYear(propertyId, sheet.year, { isLive: false, dataSource: "backfill" });
    const batch = await createImportBatch(propertyId, { year: sheet.year, sheetLabel: sheet.label });
    const { transactions, usagePeriods, reviewQueue } = parseWorkbook([sheet], { propertyId, batchLabelPrefix: `seed_${batch.id}` });
    const imported = await bulkUpsertTransactions(transactions);
    const usageCount = await insertUsagePeriods(propertyId, usagePeriods);
    const reviewCount = await insertReviewRows(propertyId, batch.id, reviewQueue);
    await updateImportBatchCounts(batch.id, {
      rowCount: sheet.rows.length - 1,
      importedCount: imported,
      reviewCount,
      usagePeriodCount: usageCount,
    });
    await recordAudit(propertyId, null, "import", null, { year: sheet.year, imported, reviewCount }, "seed");
  }

  await ensurePropertyYear(propertyId, currentYear, { isLive: true, dataSource: "live" });
  const categoryMappings = await listCategoryMappings(propertyId);
  const livePlaid = sampleLivePlaidTransactions(currentYear);

  let liveInserted = 0;
  for (const plaidTxn of livePlaid) {
    const match = matchPlaidTransaction(plaidTxn, { historicalTransactions: [], categoryMappings });
    const amount = Math.abs(plaidTxn.amount);
    const saved = await upsertTransaction({
      id: `pf_${propertyId}_${plaidTxn.transaction_id}`,
      propertyId,
      transactionDate: plaidTxn.date,
      postingMonth: plaidTxn.date.slice(0, 7),
      amount,
      direction: match.direction,
      normalizedCategory: match.normalizedCategory,
      sourceCategory: null,
      merchant: plaidTxn.merchant_name,
      memo: plaidTxn.name,
      sourceType: "plaid",
      sourceReferenceId: plaidTxn.transaction_id,
      year: currentYear,
      taxYear: currentYear,
      matchConfidence: match.confidence,
      matchExplanation: match.explanation,
      needsReview: match.confidence < 0.5,
      rawSourcePayload: plaidTxn,
    });
    liveInserted++;
    if (saved && match.confidence >= 0.9 && match.direction === "income") {
      await setTransactionReconciled(saved.id, true, { viaReserveAccount: false }, "seed");
    }
  }
  await recordAudit(propertyId, null, "import", null, { year: currentYear, imported: liveInserted, source: "plaid_mock" }, "seed");

  return { propertyId, backfillYears: allBackfillSheets.map((s) => s.year), liveYear: currentYear, liveInserted };
}
