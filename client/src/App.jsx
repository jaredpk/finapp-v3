import React, { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Accounts from "./views/Accounts.jsx";
import Transactions from "./views/Transactions.jsx";
import Budget from "./views/Budget.jsx";
import CashFlow from "./views/CashFlow.jsx";
import { usePlaidConnect } from "./hooks/usePlaid.js";
import { fetchAccounts, fetchTransactions } from "./api.js";

export default function App() {
  const [view, setView] = useState("dashboard");
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [acctRes, txnRes] = await Promise.all([
        fetchAccounts(),
        fetchTransactions(),
      ]);
      setAccounts(acctRes.accounts || []);
      setTransactions(txnRes.transactions || []);
    } catch (e) {
      console.error("Failed to load data", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const { openPlaid, connecting } = usePlaidConnect(loadData);

  useEffect(() => {
    loadData();
  }, []);

  const VIEWS = { dashboard: Dashboard, accounts: Accounts, transactions: Transactions, budget: Budget, cashflow: CashFlow };
  const ActiveView = VIEWS[view] || Dashboard;

  return (
    <div style={styles.app}>
      <Sidebar
        active={view}
        setActive={setView}
        onConnect={openPlaid}
        connecting={connecting}
      />

      <main style={styles.main}>
        {loading && accounts.length === 0 ? (
          <div style={styles.loader}>
            <span className="pulse" style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
              Loading…
            </span>
          </div>
        ) : (
          <ActiveView accounts={accounts} transactions={transactions} />
        )}
      </main>
    </div>
  );
}

const styles = {
  app: {
    display: "flex",
    minHeight: "100vh",
    background: "var(--bg)",
  },
  main: {
    flex: 1,
    overflowY: "auto",
    minHeight: "100vh",
  },
  loader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
  },
};
