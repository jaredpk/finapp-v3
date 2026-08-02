import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Authentication is WorkOS AuthKit, handled via server-side sessions.
// The App component checks auth state via /api/me and redirects to login if needed.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
