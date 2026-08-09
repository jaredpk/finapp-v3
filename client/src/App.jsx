import React, { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar.jsx";
import AccountReviewModal from "./components/AccountReviewModal.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Accounts from "./views/Accounts.jsx";
import Transactions from "./views/Transactions.jsx";
import Categories from "./views/Categories.jsx";
import Budget from "./views/Budget.jsx";
import CashFlow from "./views/CashFlow.jsx";
import Reports from "./views/Reports.jsx";
import AskAI from "./views/AskAI.jsx";
import PropertyFinance from "./views/PropertyFinance.jsx";
import Settings from "./views/Settings.jsx";
import { usePlaidConnect, usePlaidUpdateLink } from "./hooks/usePlaid.js";
import useIsMobile from "./hooks/useIsMobile.js";
import {
  fetchAccounts, fetchTransactions,
  fetchCategories, fetchAssignments, fetchMerchantOverrides,
  fetchSplits, fetchHiddenAccounts, addHiddenAccountApi,
  getLastAudit,
} from "./api.js";

const ALLOWED_EMAIL = "jaredpk@gmail.com";

export default function App() {
  // Cloudflare Access authenticates before anything reaches the browser, so
  // there is no login screen. This only resolves *who* is signed in, which the
  // sidebar displays; the server verifies the Access token on every request
  // regardless of what this returns.
  const [user, setUser] = useState(undefined); // undefined = loading

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/me`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data ?? null))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <div style={loginStyles.container}>
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={loginStyles.container}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--muted)", marginBottom: 16 }}>
            Session expired. Reload to sign in again through the portal.
          </p>
          <button onClick={() => window.location.reload()} style={loginStyles.signOutBtn}>Reload</button>
        </div>
      </div>
    );
  }

  return <AuthenticatedApp user={user} />;
}

function AuthenticatedApp({ user }) {
  const isMobile = useIsMobile();
  const [view, setView] = useState("dashboard");
  const [accounts, setAccounts] = useState([]);
  const [itemErrors, setItemErrors] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [merchantOverrides, setMerchantOverrides] = useState({});
  const [splits, setSplits] = useState({});
  const [hiddenAccounts, setHiddenAccounts] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [auditOverdue, setAuditOverdue] = useState(false);

  useEffect(() => {
    getLastAudit().then(({ log }) => {
      if (!log) { setAuditOverdue(true); return; }
      const days = (Date.now() - new Date(log.audit_date).getTime()) / 86400000;
      setAuditOverdue(days > 14);
    }).catch(() => setAuditOverdue(false));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [acctRes, txnRes, catRes, assnRes, overrideRes, splitRes, hiddenAcctRes] = await Promise.all([
        fetchAccounts(),
        fetchTransactions(),
        fetchCategories(),
        fetchAssignments(),
        fetchMerchantOverrides(),
        fetchSplits(),
        fetchHiddenAccounts(),
      ]);
      setAccounts(acctRes.accounts || []);
      setItemErrors(acctRes.itemErrors || []);
      setTransactions(txnRes.transactions || []);
      setCategories(catRes.categories || []);

      const assnMap = {};
      (assnRes.assignments || []).forEach((a) => { assnMap[a.transaction_id] = a.category_id; });
      setAssignments(assnMap);

      const overrideMap = {};
      (overrideRes.overrides || []).forEach((o) => { overrideMap[o.transaction_id] = o.merchant_name; });
      setMerchantOverrides(overrideMap);

      const splitsMap = {};
      (splitRes.splits || []).forEach((s) => {
        if (!splitsMap[s.transaction_id]) splitsMap[s.transaction_id] = [];
        splitsMap[s.transaction_id].push(s);
      });
      setSplits(splitsMap);

      setHiddenAccounts(new Set(hiddenAcctRes.accounts || []));
    } catch (e) {
      console.error("Failed to load data", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const [reviewAccounts, setReviewAccounts] = useState(null);

  function handleNewAccounts(newAccounts) {
    if (newAccounts.length > 0) {
      setReviewAccounts(newAccounts);
    } else {
      loadData();
    }
  }

  async function handleReviewConfirm(replacements) {
    await Promise.all(Object.values(replacements).map((id) => addHiddenAccountApi(id)));
    setReviewAccounts(null);
    loadData();
  }

  const { openPlaid, connecting } = usePlaidConnect(handleNewAccounts);
  const { openUpdate, updating } = usePlaidUpdateLink(loadData);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const sharedProps = {
    accounts,
    itemErrors,
    openUpdate,
    updating,
    transactions,
    categories,
    assignments,
    merchantOverrides,
    splits,
    setSplits,
    hiddenAccounts,
    setHiddenAccounts,
    setCategories,
    setAssignments,
    setMerchantOverrides,
    reloadData: loadData,
    user,
  };

  const VIEWS = {
    dashboard: Dashboard,
    accounts: Accounts,
    transactions: Transactions,
    categories: Categories,
    budget: Budget,
    cashflow: CashFlow,
    reports: Reports,
    askai: AskAI,
    property: PropertyFinance,
    settings: Settings,
  };
  const ActiveView = VIEWS[view] || Dashboard;

  return (
    <div style={{ ...styles.app, flexDirection: isMobile ? "column" : "row" }}>
      {reviewAccounts && (
        <AccountReviewModal
          newAccounts={reviewAccounts}
          existingAccounts={accounts.filter((a) => a.source !== "plaid")}
          onConfirm={handleReviewConfirm}
          onClose={() => { setReviewAccounts(null); loadData(); }}
        />
      )}
      <Sidebar
        active={view}
        setActive={setView}
        onConnect={openPlaid}
        connecting={connecting}
        user={user}
        onSignOut={() => { window.location.href = "/cdn-cgi/access/logout"; }}
        auditOverdue={auditOverdue}
        isMobile={isMobile}
      />
      <main style={{ ...styles.main, paddingBottom: isMobile ? 64 : 0 }}>
        {loading && accounts.length === 0 && transactions.length === 0 ? (
          <div style={styles.loader}>
            <span className="pulse" style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
              Loading…
            </span>
          </div>
        ) : (
          <ActiveView {...sharedProps} />
        )}
      </main>
    </div>
  );
}

const styles = {
  app: { display: "flex", minHeight: "100vh", background: "var(--bg)" },
  main: { flex: 1, minWidth: 0, overflowY: "auto", minHeight: "100vh" },
  loader: { display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" },
};

const loginStyles = {
  container: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "var(--bg)" },
  card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: "48px 40px", maxWidth: 400, width: "90%", textAlign: "center" },
  wordmark: { fontSize: "2rem", fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 8 },
  subtitle: { color: "var(--muted)", fontSize: 14, marginBottom: 32 },
  googleBtn: {
    width: "100%", padding: "12px 24px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  error: { color: "#f87171", fontSize: 13, marginTop: 12 },
  signOutBtn: { padding: "8px 16px", background: "var(--surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" },
};
