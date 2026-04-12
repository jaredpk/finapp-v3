import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import "./index.css";

async function init() {
  // Fetch publishable key from server at runtime (avoids Vite build-time env var issues)
  let publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      publishableKey = data.clerkPublishableKey;
    } catch (_) {}
  }

  if (!publishableKey) {
    document.body.innerHTML = '<p style="color:red;padding:2rem">Configuration error: Clerk publishable key is missing. Check server environment variables.</p>';
    return;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <App />
      </ClerkProvider>
    </React.StrictMode>
  );
}

init();
