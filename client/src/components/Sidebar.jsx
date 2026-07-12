import React from "react";

const NAV = [
  { id: "dashboard",    label: "Dashboard",     icon: "◈" },
  { id: "accounts",     label: "Accounts",      icon: "▣" },
  { id: "transactions", label: "Transactions",  icon: "≡" },
  { id: "categories",   label: "Categories",    icon: "◑" },
  { id: "budget",       label: "Budget",        icon: "◎" },
  { id: "cashflow",     label: "Cash Flow",     icon: "⇌" },
  { id: "property",     label: "Property",      icon: "⌂" },
  { id: "settings",     label: "Settings",      icon: "⚙" },
];

export default function Sidebar({ active, setActive, onConnect, connecting, user, onSignOut, auditOverdue, isMobile }) {
  const displayName = user?.user_metadata?.full_name || user?.email || "Account";
  const avatarUrl = user?.user_metadata?.avatar_url;

  if (isMobile) {
    return (
      <nav style={styles.mobileNav}>
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setActive(item.id)}
            style={{
              ...styles.mobileNavItem,
              color: active === item.id ? "var(--text)" : "var(--muted)",
            }}
          >
            <span style={styles.mobileNavIcon}>{item.icon}</span>
            {item.id === "settings" && auditOverdue && active !== "settings" && (
              <span style={styles.mobileAuditDot} title="Audit needed" />
            )}
            {active === item.id && <span style={styles.mobileActiveDot} />}
          </button>
        ))}
        <button onClick={onConnect} disabled={connecting} style={{ ...styles.mobileNavItem, color: "var(--accent)" }}>
          <span style={styles.mobileNavIcon}>+</span>
        </button>
      </nav>
    );
  }

  return (
    <aside style={styles.aside}>
      <div style={styles.wordmark}>
        <span style={styles.logo}>fin</span>
        <span style={styles.logoAccent}>app</span>
      </div>

      <nav style={styles.nav}>
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => setActive(item.id)}
            style={{
              ...styles.navItem,
              ...(active === item.id ? styles.navActive : {}),
            }}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            <span>{item.label}</span>
            {item.id === "settings" && auditOverdue && active !== "settings" && (
              <span style={styles.auditDot} title="Audit needed" />
            )}
            {active === item.id && <span style={styles.activeDot} />}
          </button>
        ))}
      </nav>

      <div style={styles.spacer} />

      <button onClick={onConnect} disabled={connecting} style={styles.connectBtn}>
        {connecting ? "Connecting…" : "+ Connect Bank"}
      </button>

      <div style={styles.userRow}>
        <div style={styles.userInfo}>
          {avatarUrl && (
            <img src={avatarUrl} alt="" style={styles.avatar} />
          )}
          <span style={styles.userName}>{displayName}</span>
        </div>
        <button style={styles.signOutBtn} onClick={onSignOut} title="Sign out">
          ↩
        </button>
      </div>
    </aside>
  );
}

const styles = {
  aside: {
    width: 220,
    minHeight: "100vh",
    background: "var(--surface)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    padding: "28px 16px 24px",
    flexShrink: 0,
  },
  mobileNav: {
    position: "fixed", bottom: 0, left: 0, right: 0, height: 64,
    background: "rgba(255,255,255,0.85)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
    borderTop: "1px solid var(--border)", display: "flex", alignItems: "center",
    padding: "0 8px", zIndex: 100, overflowX: "auto", gap: 4,
  },
  mobileNavItem: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    background: "none", border: "none", padding: "8px 16px", position: "relative",
    cursor: "pointer", flexShrink: 0, height: "100%", transition: "color 0.2s",
  },
  mobileNavIcon: { fontSize: 22 },
  mobileActiveDot: { position: "absolute", bottom: 6, width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" },
  mobileAuditDot: { position: "absolute", top: 12, right: 12, width: 6, height: 6, borderRadius: "50%", background: "var(--red)", border: "1px solid var(--surface)" },
  wordmark: { fontSize: 26, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 36, paddingLeft: 8 },
  logo: { color: "var(--text)" },
  logoAccent: { color: "var(--accent)" },
  nav: { display: "flex", flexDirection: "column", gap: 4 },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: "none",
    border: "none",
    borderRadius: "var(--radius)",
    color: "var(--muted)",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "var(--font-display)",
    cursor: "pointer",
    textAlign: "left",
    position: "relative",
    transition: "color 0.15s, background 0.15s",
  },
  navActive: { background: "var(--surface2)", color: "var(--text)" },
  navIcon: { fontSize: 16, width: 20, textAlign: "center" },
  activeDot: { position: "absolute", right: 10, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" },
  auditDot: { position: "absolute", right: 10, width: 7, height: 7, borderRadius: "50%", background: "var(--red, #ef4444)", border: "1.5px solid var(--surface)" },
  spacer: { flex: 1 },
  connectBtn: {
    width: "100%",
    padding: "9px 12px",
    marginBottom: 12,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius)",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "var(--font-display)",
    cursor: "pointer",
    opacity: 1,
  },
  userRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 4px",
    borderTop: "1px solid var(--border)",
    marginTop: 8,
  },
  userInfo: { display: "flex", alignItems: "center", gap: 8, overflow: "hidden" },
  avatar: { width: 26, height: 26, borderRadius: "50%", flexShrink: 0 },
  userName: { fontSize: 12, color: "var(--muted)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  signOutBtn: {
    background: "none",
    border: "none",
    color: "var(--muted)",
    cursor: "pointer",
    fontSize: 16,
    padding: "4px 6px",
    borderRadius: 6,
    flexShrink: 0,
  },
};
