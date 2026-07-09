import React from "react";
import { fmt } from "./propertyFinanceUtils.js";

export default function AllocationPanel({ transactions, usagePeriods }) {
  const rentalDays = usagePeriods.filter((u) => u.usage_type === "rental").reduce((s, u) => s + (u.days || 0), 0);
  const personalDays = usagePeriods.filter((u) => u.usage_type === "personal").reduce((s, u) => s + (u.days || 0), 0);

  let rentalAmount = 0, personalAmount = 0, mixedAmount = 0;
  for (const t of transactions) {
    if (t.excluded) continue;
    const rental = Number(t.rental_use_percent);
    const amt = Number(t.amount);
    if (rental >= 100) rentalAmount += amt;
    else if (rental <= 0) personalAmount += amt;
    else mixedAmount += amt;
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Rental / Personal Allocation</h2>
      <div style={styles.grid}>
        <div style={styles.stat}>
          <p style={styles.label}>Fully rental</p>
          <p style={styles.value}>{fmt(rentalAmount)}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.label}>Mixed use</p>
          <p style={styles.value}>{fmt(mixedAmount)}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.label}>Personal only</p>
          <p style={styles.value}>{fmt(personalAmount)}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.label}>Rental days (logged)</p>
          <p style={styles.value}>{rentalDays || "—"}</p>
        </div>
        <div style={styles.stat}>
          <p style={styles.label}>Personal days (logged)</p>
          <p style={styles.value}>{personalDays || "—"}</p>
        </div>
      </div>
      <p style={styles.hint}>Set each transaction's rental % in the ledger's Allocation column — usage/occupancy days from the backfilled sheets are tracked separately and don't count as transactions.</p>
    </section>
  );
}

const styles = {
  section: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: 20, marginBottom: 20 },
  heading: { fontSize: 15, fontWeight: 700, marginBottom: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 12 },
  stat: { padding: "10px 12px", background: "var(--surface2)", borderRadius: "var(--radius)" },
  label: { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" },
  value: { fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)", marginTop: 4 },
  hint: { fontSize: 12, color: "var(--muted)" },
};
