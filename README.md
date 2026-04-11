# FinApp — Plaid-Powered Personal Finance

A full-stack personal finance dashboard built with **Node.js/Express** (backend) and **React/Vite** (frontend), powered by the **Plaid API**.

## Features

| View | What it does |
|---|---|
| **Dashboard** | Net worth, monthly spend, 30-day spending chart, top categories |
| **Accounts** | All connected accounts grouped by type with live balances |
| **Transactions** | Searchable, filterable transaction history (last 90 days) |
| **Budget** | Per-category monthly budgets with editable limits and progress bars |

---

## Quick Start

### 1. Get Plaid credentials

1. Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com)
2. Go to **Team Settings → Keys**
3. Copy your **Client ID** and **Sandbox Secret**

---

### 2. Set up the backend

```bash
cd server
cp .env.example .env
# Edit .env and paste your PLAID_CLIENT_ID and PLAID_SECRET
npm install
npm run dev
# → Server running on http://localhost:3001
```

---

### 3. Set up the frontend

```bash
cd client
npm install
npm run dev
# → App running on http://localhost:5173
```

---

### 4. Connect a test bank (Sandbox)

1. Click **+ Connect Bank** in the sidebar
2. Plaid Link will open — use the test credentials:
   - Username: `user_good`
   - Password: `pass_good`
3. Select any institution and account type
4. Data loads automatically after connecting

---

## Project Structure

```
finapp/
├── server/
│   ├── index.js          # Express server + all Plaid endpoints
│   ├── .env.example      # Environment variable template
│   └── package.json
└── client/
    ├── src/
    │   ├── App.jsx           # Root component + data fetching
    │   ├── api.js            # API helper functions
    │   ├── components/
    │   │   ├── Sidebar.jsx   # Navigation + Connect Bank button
    │   │   └── StatCard.jsx  # Reusable stat card
    │   ├── hooks/
    │   │   └── usePlaid.js   # Plaid Link hook
    │   └── views/
    │       ├── Dashboard.jsx
    │       ├── Accounts.jsx
    │       ├── Transactions.jsx
    │       └── Budget.jsx
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/create_link_token` | Creates a Plaid Link token |
| POST | `/api/exchange_public_token` | Exchanges public token for access token |
| GET  | `/api/accounts` | Returns all accounts |
| GET  | `/api/transactions` | Returns last 90 days of transactions |
| GET  | `/api/balance` | Returns live balances |
| GET  | `/api/health` | Health check |

---

## Moving to Production

- Replace the in-memory `userItems` store with a real database (PostgreSQL, SQLite, etc.)
- Add user authentication (NextAuth, Clerk, etc.)
- Store access tokens encrypted at rest
- Switch `PLAID_ENV` from `sandbox` → `development` → `production`
- Add a `PLAID_WEBHOOK_URL` for real-time transaction updates

---

## Tech Stack

- **Backend**: Node.js, Express, Plaid Node SDK
- **Frontend**: React 18, Vite, Recharts, react-plaid-link
- **Design**: Custom CSS with Syne + DM Mono typography, dark editorial theme
