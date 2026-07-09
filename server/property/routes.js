import {
  listProperties, getProperty, createProperty, listYearsForProperty,
  listTransactions, updateTransactionCategory, updateTransactionAllocation,
  setTransactionReconciled, setTransactionExcluded, listReviewQueue, resolveReviewRow,
  listUsagePeriods, listAuditLog, listCategoryMappings, upsertTransaction,
  createImportBatch, updateImportBatchCounts, insertUsagePeriods, insertReviewRows,
  bulkUpsertTransactions,
} from "./repository.js";
import { parseWorkbook } from "./importParsers/index.js";
import { matchPlaidTransaction, detectRecurringCharges } from "./matching.js";
import { sampleLivePlaidTransactions } from "./fixtures/samplePlaidTransactions.js";
import { NORMALIZED_CATEGORIES } from "./categories.js";
import { seedPropertyFinanceData } from "./seed.js";

// Registers all /api/property-finance/* routes. Business logic lives in
// repository.js / matching.js / importParsers — handlers here only translate
// HTTP <-> those modules.
export function registerPropertyFinanceRoutes(app, requireAuth) {
  app.get("/api/property-finance/properties", requireAuth, async (_req, res) => {
    res.json({ properties: await listProperties() });
  });

  app.post("/api/property-finance/properties", requireAuth, async (req, res) => {
    const { name, address, state, propertyType, acquiredDate } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name required" });
    const property = await createProperty({ name: name.trim(), address, state, propertyType, acquiredDate });
    res.json({ property });
  });

  app.get("/api/property-finance/properties/:id", requireAuth, async (req, res) => {
    const property = await getProperty(req.params.id);
    if (!property) return res.status(404).json({ error: "not found" });
    const years = await listYearsForProperty(property.id);
    res.json({ property, years });
  });

  app.post("/api/property-finance/seed", requireAuth, async (_req, res) => {
    try {
      const result = await seedPropertyFinanceData();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("property-finance seed error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/property-finance/properties/:id/transactions", requireAuth, async (req, res) => {
    const { year, category, sourceType, isReconciled, allocation, startDate, endDate } = req.query;
    const transactions = await listTransactions(req.params.id, {
      year: year ? Number(year) : undefined,
      category: category || undefined,
      sourceType: sourceType || undefined,
      isReconciled: isReconciled === undefined ? undefined : isReconciled === "true",
      allocation: allocation || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
    res.json({ transactions, categories: NORMALIZED_CATEGORIES });
  });

  app.put("/api/property-finance/transactions/:id/category", requireAuth, async (req, res) => {
    const { normalizedCategory } = req.body || {};
    if (!NORMALIZED_CATEGORIES.includes(normalizedCategory)) return res.status(400).json({ error: "invalid category" });
    const updated = await updateTransactionCategory(req.params.id, normalizedCategory);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ transaction: updated });
  });

  app.put("/api/property-finance/transactions/:id/allocation", requireAuth, async (req, res) => {
    const { allocationMethod, rentalUsePercent, personalUsePercent } = req.body || {};
    const rental = Number(rentalUsePercent);
    const personal = Number(personalUsePercent);
    if (!Number.isFinite(rental) || !Number.isFinite(personal)) return res.status(400).json({ error: "percents required" });
    const updated = await updateTransactionAllocation(req.params.id, { allocationMethod: allocationMethod || "manual", rentalUsePercent: rental, personalUsePercent: personal });
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ transaction: updated });
  });

  app.post("/api/property-finance/transactions/:id/reconcile", requireAuth, async (req, res) => {
    const { isReconciled = true, viaReserveAccount = false } = req.body || {};
    const updated = await setTransactionReconciled(req.params.id, !!isReconciled, { viaReserveAccount: !!viaReserveAccount });
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ transaction: updated });
  });

  app.post("/api/property-finance/transactions/:id/exclude", requireAuth, async (req, res) => {
    const { excluded = true } = req.body || {};
    const updated = await setTransactionExcluded(req.params.id, !!excluded);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ transaction: updated });
  });

  app.get("/api/property-finance/properties/:id/review-queue", requireAuth, async (req, res) => {
    res.json({ items: await listReviewQueue(req.params.id) });
  });

  app.post("/api/property-finance/review-queue/:id/resolve", requireAuth, async (req, res) => {
    await resolveReviewRow(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/property-finance/properties/:id/usage-periods", requireAuth, async (req, res) => {
    res.json({ usagePeriods: await listUsagePeriods(req.params.id, req.query.year ? Number(req.query.year) : undefined) });
  });

  app.get("/api/property-finance/properties/:id/audit-log", requireAuth, async (req, res) => {
    res.json({ entries: await listAuditLog(req.params.id) });
  });

  // Preview import: parses posted sheet rows (array-of-rows-per-year) without
  // writing anything, so the UI can show what would land in the ledger vs.
  // the review queue before committing.
  app.post("/api/property-finance/properties/:id/import/preview", requireAuth, async (req, res) => {
    const { sheets } = req.body || {};
    if (!Array.isArray(sheets)) return res.status(400).json({ error: "sheets array required" });
    const result = parseWorkbook(sheets, { propertyId: Number(req.params.id), batchLabelPrefix: "preview" });
    res.json(result);
  });

  app.post("/api/property-finance/properties/:id/import/commit", requireAuth, async (req, res) => {
    const { sheets } = req.body || {};
    if (!Array.isArray(sheets)) return res.status(400).json({ error: "sheets array required" });
    const propertyId = Number(req.params.id);
    const batchResults = [];
    for (const sheet of sheets) {
      const batch = await createImportBatch(propertyId, { year: sheet.year, sheetLabel: sheet.label });
      const { transactions, usagePeriods, reviewQueue } = parseWorkbook([sheet], { propertyId, batchLabelPrefix: `batch_${batch.id}` });
      const imported = await bulkUpsertTransactions(transactions);
      const usageCount = await insertUsagePeriods(propertyId, usagePeriods);
      const reviewCount = await insertReviewRows(propertyId, batch.id, reviewQueue);
      await updateImportBatchCounts(batch.id, { rowCount: sheet.rows.length - 1, importedCount: imported, reviewCount, usagePeriodCount: usageCount });
      batchResults.push({ batchId: batch.id, year: sheet.year, imported, reviewCount, usageCount });
    }
    res.json({ batches: batchResults });
  });

  // Runs the mock live Plaid feed through the matching layer against this
  // property's history and returns suggestions without persisting — this is
  // the "preview attribution" step the reconciliation queue UI drives.
  app.get("/api/property-finance/properties/:id/plaid-preview", requireAuth, async (req, res) => {
    const propertyId = Number(req.params.id);
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const [historicalTransactions, categoryMappings] = await Promise.all([
      listTransactions(propertyId, {}),
      listCategoryMappings(propertyId),
    ]);
    const plaidTxns = sampleLivePlaidTransactions(year);
    const suggestions = plaidTxns.map((t) => ({
      plaidTransaction: t,
      match: matchPlaidTransaction(t, { historicalTransactions, categoryMappings }),
    }));
    const recurring = detectRecurringCharges([...plaidTxns, ...historicalTransactions]);
    res.json({ suggestions, recurring });
  });

  app.post("/api/property-finance/properties/:id/plaid-preview/apply", requireAuth, async (req, res) => {
    const propertyId = Number(req.params.id);
    const { transactionId } = req.body || {};
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const plaidTxns = sampleLivePlaidTransactions(year);
    const plaidTxn = plaidTxns.find((t) => t.transaction_id === transactionId);
    if (!plaidTxn) return res.status(404).json({ error: "not found in mock feed" });
    const [historicalTransactions, categoryMappings] = await Promise.all([
      listTransactions(propertyId, {}),
      listCategoryMappings(propertyId),
    ]);
    const match = matchPlaidTransaction(plaidTxn, { historicalTransactions, categoryMappings });
    const saved = await upsertTransaction({
      id: `pf_${propertyId}_${plaidTxn.transaction_id}`,
      propertyId,
      transactionDate: plaidTxn.date,
      postingMonth: plaidTxn.date.slice(0, 7),
      amount: Math.abs(plaidTxn.amount),
      direction: match.direction,
      normalizedCategory: match.normalizedCategory,
      merchant: plaidTxn.merchant_name,
      memo: plaidTxn.name,
      sourceType: "plaid",
      sourceReferenceId: plaidTxn.transaction_id,
      year,
      taxYear: year,
      matchConfidence: match.confidence,
      matchExplanation: match.explanation,
      needsReview: match.confidence < 0.5,
      rawSourcePayload: plaidTxn,
    });
    res.json({ transaction: saved });
  });
}
