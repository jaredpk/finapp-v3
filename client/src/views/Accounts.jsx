import React from "react";

const TYPE_COLORS = {
  depository: "var(--green)",
  credit:     "var(--red)",
  investment: "var(--accent)",
  loan:       "var(--accent2)",
  other:      "var(--blue)",
};

const fmt = (n) =>
  n == null ? "—" : "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

export default function Accounts({ accounts }) {
  const byType = accounts.reduce((acc, a) => {
    const t = a.type || "other";
    if (!acc[t]) acc[t] = [];
    acc[t].push(a);
    return acc;
  }, {});

  if (!accounts.length) {
    return (
      <div style={styles.wrap}>
        <h1 style={styles.heading}>Accounts</h1>
        <Empty />
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Accounts</h1>

      {Object.entries(byType).map(([type, accts], gi) => (
        <div key={type} className="fade-up" style={{ animationDelay: `${gi * 0.08}s`, marginBottom: 32 }}>
          <p style={styles.groupLabel}>{type}</p>
          <div style={styles.grid}>
            {accts.map((a) => (
              <div key={a.account_id} style={styles.card}>
                <div style={styles.cardTop}>
                  <div>
                    <p style={styles.bankName}>{a.name}</p>
                    <p style={styles.subtype}>{a.subtype || a.type}</p>
                  </div>
                  <span style={{ ...styles.badge, background: TYPE_COLORS[a.type] || "var(--blue)" + "22", color: TYPE_COLORS[a.type] || "var(--blue)" }}>
                    {a.type}
                  </span>
                </div>

                <div style={styles.divider} />

                <div style={styles.balRow}>
                  <div>
                    <p style={styles.balLabel}>Current</p>
                    <p style={{ ...styles.balAmt, color: a.type === "credit" || a.type === "loan" ? "var(--red)" : "var(--green)" }}>
                      {fmt(a.balances?.current)}
                    </p>
                  </div>
                  {a.balances?.available != null && (
                    <div style={{ textAlign: "right" }}>
                      <p style={styles.balLabel}>Available</p>
                      <p style={styles.balAmt}>{fmt(a.balances.available)}</p>
                    </div>
                  )}
                  {a.balances?.limit != null && (
                    <div style={{ textAlign: "right" }}>
                      <p style={styles.balLabel}>Limit</p>
                      <p style={styles.balAmt}>{fmt(a.balances.limit)}</p>
                    </div>
                  )}
                </div>

                {a.mask && (
                  <p style={styles.mask}>···· {a.mask}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return <p style={{ color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", marginTop: 48, textAlign: "center" }}>No accounts connected yet.</p>;
}

const styles = {
  wrap: { padding: "36px 40px", maxWidth: 960 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 32, color: "var(--text)" },
  groupLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 12 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius2)", padding: "20px 22px" },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  bankName: { fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 3 },
  subtype: { fontSize: 12, color: "var(--muted)", fontFamily: "var(--font-mono)" },
  badge: { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 99, background: "rgba(240,180,41,0.12)", color: "var(--accent)" },
  divider: { height: 1, background: "var(--border)", marginBottom: 16 },
  balRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
  balLabel: { fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontFamily: "var(--font-mono)", marginBottom: 4 },
  balAmt: { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: "-0.02em", color: "var(--text)" },
  mask: { marginTop: 14, fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" },
};
