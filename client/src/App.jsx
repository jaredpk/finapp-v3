import React, { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Accounts from "./views/Accounts.jsx";
import Transactions from "./views/Transactions.jsx";
import Categories from "./views/Categories.jsx";
import Budget from "./views/Budget.jsx";
import CashFlow from "./views/CashFlow.jsx";
import Settings from "./views/Settings.jsx";
import { usePlaidConnect } from "./hooks/usePlaid.js";
import {
  fetchAccounts, fetchTransactions, setTokenGetter,
  fetchCategories, fetchAssignments, fetchMerchantOverrides,
} from "./api.js";

const ALLOWED_EMAIL = "jaredpk@gmail.com";

export default function App({ supabase }) {
  const [session, setSession] = useState(undefined); // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, [supabase]);

  if (session === undefined) {
    return (
      <div style={loginStyles.container}>
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>Loading…</span>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen supabase={supabase} />;
  }

  if (session.user.email !== ALLOWED_EMAIL) {
    return (
      <div style={loginStyles.container}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--muted)", marginBottom: 16 }}>Access restricted.</p>
          <button onClick={() => supabase.auth.signOut()} style={loginStyles.signOutBtn}>Sign out</button>
        </div>
      </div>
    );
  }

  return <AuthenticatedApp supabase={supabase} session={session} />;
}

function LoginScreen({ supabase }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleGoogleLogin() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) { setError(error.message); setLoading(false); }
  }

  return (
    <div style={loginStyles.container}>
      <div style={loginStyles.card}>
        <div style={loginStyles.wordmark}>
          fin<span style={{ color: "var(--accent)" }}>app</span>
        </div>
        <p style={loginStyles.subtitle}>Personal Finance Dashboard</p>
        <button onClick={handleGoogleLogin} disabled={loading} style={loginStyles.googleBtn}>
          {loading ? "Redirecting…" : "Sign in with Google"}
        </button>
        {error && <p style={loginStyles.error}>{error}</p>}
      </div>
    </div>
  );
}

function AuthenticatedApp({ supabase, session }) {
  const [view, setView] = useState("dashboard");
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [merchantOverrides, setMerchantOverrides] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTokenGetter(async () => session.access_token);
  }, [session]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [acctRes, txnRes, catRes, assnRes, overrideRes] = await Promise.all([
        fetchAccounts(),
        fetchTransactions(),
        fetchCategories(),
        fetchAssignments(),
        fetchMerchantOverrides(),
      ]);
      setAccounts(acctRes.accounts || []);
      setTransactions(txnRes.transactions || []);
      setCategories(catRes.categories || []);

      const assnMap = {};
      (assnRes.assignments || []).forEach((a) => { assnMap[a.transaction_id] = a.category_id; });
      setAssignments(assnMap);

      const overrideMap = {};
      (overrideRes.overrides || []).forEach((o) => { overrideMap[o.transaction_id] = o.merchant_name; });
      setMerchantOverrides(overrideMap);
    } catch (e) {
      console.error("Failed to load data", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const { openPlaid, connecting } = usePlaidConnect(loadData);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const sharedProps = {
    accounts,
    transactions,
    categories,
    assignments,
    merchantOverrides,
    setCategories,
    setAssignments,
    setMerchantOverrides,
    reloadData: loadData,
    user: session.user,
  };

  const VIEWS = {
    dashboard: Dashboard,
    accounts: Accounts,
    transactions: Transactions,
    categories: Categories,
    budget: Budget,
    cashflow: CashFlow,
    settings: Settings,
  };
  const ActiveView = VIEWS[view] || Dashboard;

  return (
    <div style={styles.app}>
      <Sidebar
        active={view}
        setActive={setView}
        onConnect={openPlaid}
        connecting={connecting}
        user={session.user}
        onSignOut={() => supabase.auth.signOut()}
      />
      <main style={styles.main}>
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
  main: { flex: 1, overflowY: "auto", minHeight: "100vh" },
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
