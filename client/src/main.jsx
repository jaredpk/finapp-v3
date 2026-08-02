import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Authentication is Cloudflare Access, enforced at the edge and verified again
// by the server. Anything that reaches this script is already signed in, so
// there is no client-side auth bootstrap.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
