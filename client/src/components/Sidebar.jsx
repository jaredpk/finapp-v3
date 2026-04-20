import React from "react";

const NAV = [
  { id: "dashboard",    label: "Dashboard",     icon: "◈" },
  { id: "accounts",     label: "Accounts",      icon: "▣" },
  { id: "transactions", label: "Transactions",  icon: "≡" },
  { id: "categories",   label: "Categories",    icon: "◑" },
  { id: "budget",       label: "Budget",        icon: "◎" },
  { id: "cashflow",     label: "Cash Flow",     icon: "⇌" },
  { id: "settings",     label: "Settings",      icon: "⚙" },
];

export default function Sidebar({ active, setActive, onConnect, connecting, user, onSignOut }) {
  const displayName = user?.user_metadata?.full_name || user?.email || "Account";
  const avatarUrl = user?.user_metadata?.avatar_url;

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
            {active === item.id && <span style={styles.activeDot} />}
          </button>
        ))}
      </nav>

      <div style={styles.spacer} />

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
  spacer: { flex: 1 },
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
