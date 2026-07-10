// Data-access layer for property-finance. Kept separate from routes.js
// (HTTP) and matching/importParsers (pure logic) so business rules never
// have to touch SQL and route handlers never have to touch SQL either.
import pool from "../db.js";

export async function listProperties() {
  const { rows } = await pool.query(
    `SELECT id, name, address, state, property_type, acquired_date, created_at FROM pf_properties ORDER BY id`
  );
  return rows;
}

export async function getProperty(id) {
  const { rows } = await pool.query(`SELECT * FROM pf_properties WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function createProperty({ name, address, state = "FL", propertyType = "condo", acquiredDate = null }) {
  const { rows } = await pool.query(
    `INSERT INTO pf_properties (name, address, state, property_type, acquired_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, address || null, state, propertyType, acquiredDate]
  );
  return rows[0];
}

export async function listYearsForProperty(propertyId) {
  const { rows } = await pool.query(
    `SELECT year, is_live, data_source, opening_note, closed_at
     FROM pf_property_years WHERE property_id = $1 ORDER BY year`,
    [propertyId]
  );
  return rows;
}

export async function ensurePropertyYear(propertyId, year, { isLive = false, dataSource = "backfill" } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pf_property_years (property_id, year, is_live, data_source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (property_id, year) DO UPDATE SET is_live = $3, data_source = $4
     RETURNING *`,
    [propertyId, year, isLive, dataSource]
  );
  return rows[0];
}

export async function demoteLiveYears(propertyId) {
  await pool.query(`UPDATE pf_property_years SET is_live = FALSE WHERE property_id = $1 AND is_live = TRUE`, [propertyId]);
}

export async function listTransactions(propertyId, { year, category, sourceType, isReconciled, allocation, startDate, endDate } = {}) {
  const conditions = ["property_id = $1"];
  const params = [propertyId];
  let i = 2;
  if (year) { conditions.push(`year = $${i++}`); params.push(year); }
  if (category) { conditions.push(`normalized_category = $${i++}`); params.push(category); }
  if (sourceType) { conditions.push(`source_type = $${i++}`); params.push(sourceType); }
  if (isReconciled !== undefined) { conditions.push(`is_reconciled = $${i++}`); params.push(isReconciled); }
  if (allocation === "rental") conditions.push(`rental_use_percent >= 100`);
  if (allocation === "personal") conditions.push(`personal_use_percent > 0`);
  if (allocation === "mixed") conditions.push(`rental_use_percent < 100 AND rental_use_percent > 0`);
  if (startDate) { conditions.push(`transaction_date >= $${i++}`); params.push(startDate); }
  if (endDate) { conditions.push(`transaction_date <= $${i++}`); params.push(endDate); }

  const { rows } = await pool.query(
    `SELECT * FROM pf_transactions WHERE ${conditions.join(" AND ")} ORDER BY transaction_date DESC, id`,
    params
  );
  return rows;
}

export async function upsertTransaction(t) {
  const { rows } = await pool.query(
    `INSERT INTO pf_transactions (
       id, property_id, transaction_date, posting_month, amount, direction,
       normalized_category, source_category, merchant, memo, source_type,
       source_reference_id, year, is_reconciled, reconciled_via_reserve_account,
       allocation_method, rental_use_percent, personal_use_percent, tax_year,
       match_confidence, match_explanation, needs_review, excluded, raw_source_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (id) DO UPDATE SET
       transaction_date = EXCLUDED.transaction_date,
       posting_month = EXCLUDED.posting_month,
       amount = EXCLUDED.amount,
       direction = EXCLUDED.direction,
       normalized_category = EXCLUDED.normalized_category,
       source_category = EXCLUDED.source_category,
       merchant = EXCLUDED.merchant,
       memo = EXCLUDED.memo,
       is_reconciled = EXCLUDED.is_reconciled,
       reconciled_via_reserve_account = EXCLUDED.reconciled_via_reserve_account,
       allocation_method = EXCLUDED.allocation_method,
       rental_use_percent = EXCLUDED.rental_use_percent,
       personal_use_percent = EXCLUDED.personal_use_percent,
       match_confidence = EXCLUDED.match_confidence,
       match_explanation = EXCLUDED.match_explanation,
       needs_review = EXCLUDED.needs_review,
       excluded = EXCLUDED.excluded,
       raw_source_payload = EXCLUDED.raw_source_payload,
       updated_at = NOW()
     RETURNING *`,
    [
      t.id, t.propertyId, t.transactionDate, t.postingMonth, t.amount, t.direction,
      t.normalizedCategory || "Uncategorized", t.sourceCategory || null, t.merchant || null, t.memo || null,
      t.sourceType || "import", t.sourceReferenceId || null, t.year, !!t.isReconciled, !!t.reconciledViaReserveAccount,
      t.allocationMethod || "full_rental", t.rentalUsePercent ?? 100, t.personalUsePercent ?? 0, t.taxYear || t.year,
      t.matchConfidence ?? null, t.matchExplanation || null, !!t.needsReview, !!t.excluded,
      t.rawSourcePayload ? JSON.stringify(t.rawSourcePayload) : null,
    ]
  );
  return rows[0];
}

// Clears a year's sheet-imported rows ahead of a re-import so the sheet is
// always the source of truth for that year. Plaid-sourced rows are untouched.
export async function deleteImportTransactions(propertyId, year) {
  const { rowCount } = await pool.query(
    `DELETE FROM pf_transactions WHERE property_id = $1 AND year = $2 AND source_type = 'import'`,
    [propertyId, year]
  );
  return rowCount;
}

export async function bulkUpsertTransactions(transactions) {
  let count = 0;
  for (const t of transactions) { await upsertTransaction(t); count++; }
  return count;
}

export async function updateTransactionCategory(id, normalizedCategory, actor = "jared") {
  const { rows: before } = await pool.query(`SELECT normalized_category FROM pf_transactions WHERE id = $1`, [id]);
  const { rows } = await pool.query(
    `UPDATE pf_transactions SET normalized_category = $1, needs_review = FALSE, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [normalizedCategory, id]
  );
  if (rows[0]) {
    await recordAudit(rows[0].property_id, id, "category_edit", { normalized_category: before[0]?.normalized_category }, { normalized_category: normalizedCategory }, actor);
    await bumpCategoryMapping(rows[0].property_id, rows[0].merchant || rows[0].memo, normalizedCategory);
  }
  return rows[0] || null;
}

export async function updateTransactionAllocation(id, { allocationMethod, rentalUsePercent, personalUsePercent }, actor = "jared") {
  const { rows: before } = await pool.query(`SELECT allocation_method, rental_use_percent, personal_use_percent FROM pf_transactions WHERE id = $1`, [id]);
  const { rows } = await pool.query(
    `UPDATE pf_transactions
     SET allocation_method = $1, rental_use_percent = $2, personal_use_percent = $3, updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [allocationMethod, rentalUsePercent, personalUsePercent, id]
  );
  if (rows[0]) {
    await recordAudit(rows[0].property_id, id, "allocation_edit", before[0], { allocation_method: allocationMethod, rental_use_percent: rentalUsePercent, personal_use_percent: personalUsePercent }, actor);
  }
  return rows[0] || null;
}

export async function setTransactionReconciled(id, isReconciled, { viaReserveAccount = false } = {}, actor = "jared") {
  const { rows } = await pool.query(
    `UPDATE pf_transactions SET is_reconciled = $1, reconciled_via_reserve_account = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
    [isReconciled, viaReserveAccount, id]
  );
  if (rows[0]) {
    await recordAudit(rows[0].property_id, id, isReconciled ? "reconcile" : "reopened", null, { is_reconciled: isReconciled, via_reserve: viaReserveAccount }, actor);
  }
  return rows[0] || null;
}

export async function setTransactionExcluded(id, excluded, actor = "jared") {
  const { rows } = await pool.query(
    `UPDATE pf_transactions SET excluded = $1, needs_review = FALSE, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [excluded, id]
  );
  if (rows[0]) await recordAudit(rows[0].property_id, id, "exclude", null, { excluded }, actor);
  return rows[0] || null;
}

export async function bumpCategoryMapping(propertyId, rawMerchantOrMemo, normalizedCategory) {
  const matchKey = String(rawMerchantOrMemo || "").toLowerCase().trim();
  if (!matchKey) return;
  await pool.query(
    `INSERT INTO pf_category_mappings (property_id, match_key, normalized_category, hit_count, last_used_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (property_id, match_key) DO UPDATE SET
       normalized_category = $3, hit_count = pf_category_mappings.hit_count + 1, last_used_at = NOW()`,
    [propertyId, matchKey, normalizedCategory]
  );
}

export async function listCategoryMappings(propertyId) {
  const { rows } = await pool.query(`SELECT * FROM pf_category_mappings WHERE property_id = $1 ORDER BY hit_count DESC`, [propertyId]);
  return rows;
}

export async function createImportBatch(propertyId, { year, sheetLabel }) {
  const { rows } = await pool.query(
    `INSERT INTO pf_import_batches (property_id, year, sheet_label) VALUES ($1, $2, $3) RETURNING *`,
    [propertyId, year || null, sheetLabel || null]
  );
  return rows[0];
}

export async function updateImportBatchCounts(id, { rowCount, importedCount, reviewCount, usagePeriodCount }) {
  await pool.query(
    `UPDATE pf_import_batches SET row_count = $1, imported_count = $2, review_count = $3, usage_period_count = $4 WHERE id = $5`,
    [rowCount, importedCount, reviewCount, usagePeriodCount, id]
  );
}

export async function deleteUsagePeriods(propertyId, year) {
  await pool.query(`DELETE FROM pf_usage_periods WHERE property_id = $1 AND year = $2`, [propertyId, year]);
}

export async function insertUsagePeriods(propertyId, usagePeriods) {
  let count = 0;
  for (const u of usagePeriods) {
    await pool.query(
      `INSERT INTO pf_usage_periods (property_id, year, start_date, end_date, usage_type, days, source_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [propertyId, u.year, u.startDate, u.endDate, u.usageType, u.days, u.sourceNote]
    );
    count++;
  }
  return count;
}

export async function listUsagePeriods(propertyId, year) {
  const params = [propertyId];
  let where = "property_id = $1";
  if (year) { where += " AND year = $2"; params.push(year); }
  const { rows } = await pool.query(`SELECT * FROM pf_usage_periods WHERE ${where} ORDER BY start_date`, params);
  return rows;
}

export async function addUsagePeriod(propertyId, { year, usageType, startDate, endDate, days, sourceNote }) {
  const { rows } = await pool.query(
    `INSERT INTO pf_usage_periods (property_id, year, start_date, end_date, usage_type, days, source_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [propertyId, year, startDate, endDate, usageType, days, sourceNote]
  );
  return rows[0];
}

export async function deleteUsagePeriod(id) {
  const { rowCount } = await pool.query(`DELETE FROM pf_usage_periods WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ── Depreciation (annual amounts per tax year) ────────────────────────────────
export async function listDepreciation(propertyId) {
  const { rows } = await pool.query(
    `SELECT property_id, year, amount::float FROM pf_depreciation WHERE property_id = $1 ORDER BY year`,
    [propertyId]
  );
  return rows;
}

export async function upsertDepreciation(propertyId, year, amount) {
  const { rows } = await pool.query(
    `INSERT INTO pf_depreciation (property_id, year, amount) VALUES ($1, $2, $3)
     ON CONFLICT (property_id, year) DO UPDATE SET amount = $3
     RETURNING property_id, year, amount::float`,
    [propertyId, year, amount]
  );
  return rows[0];
}

export async function deleteDepreciation(propertyId, year) {
  const { rowCount } = await pool.query(`DELETE FROM pf_depreciation WHERE property_id = $1 AND year = $2`, [propertyId, year]);
  return rowCount > 0;
}

export async function insertReviewRows(propertyId, importBatchId, reviewQueue) {
  let count = 0;
  for (const r of reviewQueue) {
    // Re-importing a year re-parses the same failing rows; skip any row already
    // queued (or already resolved) so re-imports don't duplicate the queue.
    const { rowCount } = await pool.query(
      `INSERT INTO pf_review_queue (property_id, import_batch_id, year, raw_row, reason)
       SELECT $1, $2, $3, $4::jsonb, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM pf_review_queue
         WHERE property_id = $1 AND year = $3 AND raw_row = $4::jsonb
       )`,
      [propertyId, importBatchId, r.year, JSON.stringify(r.rawRow), r.reason]
    );
    count += rowCount;
  }
  return count;
}

export async function listReviewQueue(propertyId, { resolved = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM pf_review_queue WHERE property_id = $1 AND resolved = $2 ORDER BY created_at DESC`,
    [propertyId, resolved]
  );
  return rows;
}

export async function resolveReviewRow(id) {
  await pool.query(`UPDATE pf_review_queue SET resolved = TRUE WHERE id = $1`, [id]);
}

export async function recordAudit(propertyId, transactionId, action, beforeValue, afterValue, actor = "jared") {
  await pool.query(
    `INSERT INTO pf_audit_log (property_id, transaction_id, action, before_value, after_value, actor)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [propertyId, transactionId || null, action, beforeValue ? JSON.stringify(beforeValue) : null, afterValue ? JSON.stringify(afterValue) : null, actor]
  );
}

export async function listAuditLog(propertyId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM pf_audit_log WHERE property_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [propertyId, limit]
  );
  return rows;
}

export async function recordReconciliationEvent(propertyId, transactionId, eventType, note) {
  await pool.query(
    `INSERT INTO pf_reconciliation_events (property_id, transaction_id, event_type, note) VALUES ($1,$2,$3,$4)`,
    [propertyId, transactionId, eventType, note || null]
  );
}
