import React from "react";
import ReactDOM from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import App from "./App.jsx";
import "./index.css";

async function init() {
  let supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  let supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      supabaseUrl = data.supabaseUrl;
      supabaseAnonKey = data.supabaseAnonKey;
    } catch (_) {}
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    document.body.innerHTML = '<p style="color:red;padding:2rem">Configuration error: Supabase keys missing.</p>';
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App supabase={supabase} />
    </React.StrictMode>
  );
}

init();
