import React from "react";

export default function StatCard({ label, value, sub, accent, delay = 0, mono = false }) {
  return (
    <div className={`fade-up`} style={{ ...styles.card, animationDelay: `${delay}s` }}>
      <p style={styles.label}>{label}</p>
      <p style={{ ...styles.value, color: accent || "var(--text)", fontFamily: mono ? "var(--font-mono)" : "var(--font-display)" }}>
        {value}
      </p>
      {sub && <p style={styles.sub}>{sub}</p>}
    </div>
  );
}

const styles = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius2)",
    padding: "20px 22px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--muted)",
    fontFamily: "var(--font-mono)",
  },
  value: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "-0.03em",
    lineHeight: 1,
  },
  sub: {
    fontSize: 12,
    color: "var(--muted)",
    fontFamily: "var(--font-mono)",
    marginTop: 2,
  },
};
