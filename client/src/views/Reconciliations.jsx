import React from "react";
import MonthEnd from "./MonthEnd.jsx";

export default function Reconciliations() {
  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Reconciliations</h1>

      {/* Month-end reconciliation */}
      <MonthEnd />
    </div>
  );
}

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 1100 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },
};
