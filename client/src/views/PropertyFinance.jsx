import React, { useCallback, useEffect, useState } from "react";
import {
  fetchPropertyFinanceProperties, seedPropertyFinanceApi, fetchPropertyFinanceDetail,
  fetchPropertyTransactions, updatePropertyTransactionCategory, updatePropertyTransactionAllocation,
  reconcilePropertyTransaction, excludePropertyTransaction, fetchPropertyReviewQueue,
  resolvePropertyReviewRow, fetchPropertyUsagePeriods, fetchPropertyAuditLog,
  fetchPropertyPlaidPreview, applyPropertyPlaidPreview,
} from "../api.js";
import PropertyHeader from "../components/property/PropertyHeader.jsx";
import MonthlyPnL from "../components/property/MonthlyPnL.jsx";
import CategoryBreakdown from "../components/property/CategoryBreakdown.jsx";
import TransactionLedger from "../components/property/TransactionLedger.jsx";
import ReconciliationQueue from "../components/property/ReconciliationQueue.jsx";
import AllocationPanel from "../components/property/AllocationPanel.jsx";
import YearComparisonCards from "../components/property/YearComparisonCards.jsx";
import AuditDetail from "../components/property/AuditDetail.jsx";
import ImportSpreadsheetPanel from "../components/property/ImportSpreadsheetPanel.jsx";

export default function PropertyFinance() {
  const [properties, setProperties] = useState(null); // null = loading
  const [property, setProperty] = useState(null);
  const [years, setYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [transactionsByYear, setTransactionsByYear] = useState({});
  const [categories, setCategories] = useState([]);
  const [reviewQueue, setReviewQueue] = useState([]);
  const [usagePeriods, setUsagePeriods] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [plaidPreview, setPlaidPreview] = useState([]);
  const [seeding, setSeeding] = useState(false);
  const [loadingYear, setLoadingYear] = useState(false);

  const loadProperties = useCallback(async () => {
    const { properties: list } = await fetchPropertyFinanceProperties();
    setProperties(list || []);
    if (list && list.length > 0) {
      const { property: p, years: y } = await fetchPropertyFinanceDetail(list[0].id);
      setProperty(p);
      setYears(y);
      const liveYear = y.find((yr) => yr.is_live)?.year;
      setSelectedYear(liveYear || y[y.length - 1]?.year || new Date().getFullYear());
    }
  }, []);

  useEffect(() => { loadProperties(); }, [loadProperties]);

  const loadYearData = useCallback(async (propertyId, year) => {
    setLoadingYear(true);
    try {
      const [txnRes, reviewRes, usageRes, auditRes] = await Promise.all([
        fetchPropertyTransactions(propertyId, { year }),
        fetchPropertyReviewQueue(propertyId),
        fetchPropertyUsagePeriods(propertyId, year),
        fetchPropertyAuditLog(propertyId),
      ]);
      setTransactions(txnRes.transactions || []);
      setCategories(txnRes.categories || []);
      setTransactionsByYear((prev) => ({ ...prev, [year]: txnRes.transactions || [] }));
      setReviewQueue((reviewRes.items || []).filter((r) => !r.resolved));
      setUsagePeriods(usageRes.usagePeriods || []);
      setAuditLog(auditRes.entries || []);

      const isLive = years.find((y) => y.year === year)?.is_live;
      if (isLive) {
        const preview = await fetchPropertyPlaidPreview(propertyId, year);
        setPlaidPreview(preview.suggestions || []);
      } else {
        setPlaidPreview([]);
      }
    } finally {
      setLoadingYear(false);
    }
  }, [years]);

  useEffect(() => {
    if (property && selectedYear) loadYearData(property.id, selectedYear);
  }, [property, selectedYear, loadYearData]);

  // Fetch a lightweight summary for every other year so comparison cards
  // don't require re-fetching the active year's full ledger each switch.
  useEffect(() => {
    if (!property) return;
    years.forEach((y) => {
      if (y.year === selectedYear || transactionsByYear[y.year]) return;
      fetchPropertyTransactions(property.id, { year: y.year }).then((res) => {
        setTransactionsByYear((prev) => ({ ...prev, [y.year]: res.transactions || [] }));
      });
    });
  }, [property, years, selectedYear, transactionsByYear]);

  async function handleSeed() {
    setSeeding(true);
    try {
      await seedPropertyFinanceApi();
      await loadProperties();
    } finally {
      setSeeding(false);
    }
  }

  async function handleCategoryChange(id, normalizedCategory) {
    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, normalized_category: normalizedCategory, needs_review: false } : t)));
    await updatePropertyTransactionCategory(id, normalizedCategory);
  }

  async function handleAllocationChange(id, rentalUsePercent) {
    const personalUsePercent = 100 - rentalUsePercent;
    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, rental_use_percent: rentalUsePercent, personal_use_percent: personalUsePercent } : t)));
    await updatePropertyTransactionAllocation(id, { allocationMethod: "manual", rentalUsePercent, personalUsePercent });
  }

  async function handleReconcileToggle(id, isReconciled) {
    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, is_reconciled: isReconciled } : t)));
    await reconcilePropertyTransaction(id, isReconciled);
  }

  async function handleExclude(id) {
    setTransactions((prev) => prev.map((t) => (t.id === id ? { ...t, excluded: true } : t)));
    await excludePropertyTransaction(id, true);
  }

  async function handleApplyPlaidSuggestion(transactionId) {
    await applyPropertyPlaidPreview(property.id, transactionId, selectedYear);
    await loadYearData(property.id, selectedYear);
  }

  async function handleResolveReview(id) {
    await resolvePropertyReviewRow(id);
    setReviewQueue((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleImported() {
    setTransactionsByYear({}); // re-imported years need fresh summaries
    await loadProperties();
    if (property && selectedYear) await loadYearData(property.id, selectedYear);
  }

  if (properties === null) {
    return <div style={styles.wrap}><p style={styles.muted}>Loading property finance…</p></div>;
  }

  if (properties.length === 0) {
    return (
      <div style={styles.wrap}>
        <h1 style={styles.heading}>Property Finance</h1>
        <p style={styles.muted}>No rental property set up yet. Seed the Seaside Condo demo (2021-{new Date().getFullYear()}) to explore the page.</p>
        <button onClick={handleSeed} disabled={seeding} style={styles.seedBtn}>
          {seeding ? "Seeding…" : "Seed demo property data"}
        </button>
      </div>
    );
  }

  if (!property || !selectedYear) return <div style={styles.wrap} />;

  const isLiveYear = years.find((y) => y.year === selectedYear)?.is_live;

  return (
    <div style={styles.wrap}>
      <PropertyHeader property={property} years={years} selectedYear={selectedYear} onSelectYear={setSelectedYear} transactions={transactions} />

      {loadingYear ? (
        <p style={styles.muted}>Loading {selectedYear}…</p>
      ) : (
        <>
          <YearComparisonCards years={years} transactionsByYear={transactionsByYear} selectedYear={selectedYear} onSelectYear={setSelectedYear} />
          <div style={styles.twoCol}>
            <MonthlyPnL transactions={transactions} />
            <CategoryBreakdown transactions={transactions} />
          </div>
          <TransactionLedger
            transactions={transactions}
            categories={categories}
            onCategoryChange={handleCategoryChange}
            onAllocationChange={handleAllocationChange}
            onReconcileToggle={handleReconcileToggle}
            onExclude={handleExclude}
          />
          <ReconciliationQueue
            isLiveYear={isLiveYear}
            plaidPreview={plaidPreview}
            onApply={handleApplyPlaidSuggestion}
            reviewQueue={reviewQueue}
            onResolveReview={handleResolveReview}
          />
          <AllocationPanel transactions={transactions} usagePeriods={usagePeriods} />
          <ImportSpreadsheetPanel propertyId={property.id} onImported={handleImported} />
          <AuditDetail entries={auditLog} />
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { padding: "32px 40px", maxWidth: 1200 },
  heading: { fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 12 },
  muted: { color: "var(--muted)", fontSize: 14, marginBottom: 16 },
  seedBtn: { padding: "10px 18px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: "var(--radius)", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 },
};
