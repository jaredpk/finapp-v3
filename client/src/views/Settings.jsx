import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/clerk-react";
import { getApiKey, generateApiKey } from "../api.js";

export default function Settings() {
  const { user } = useUser();
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getApiKey().then((data) => {
      setApiKey(data.key || null);
      setLoading(false);
    });
  }, []);

  async function handleGenerate() {
    setGenerating(true);
    const data = await generateApiKey();
    setApiKey(data.key);
    setGenerating(false);
  }

  function handleCopy(text) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const mcpConfig = apiKey ? JSON.stringify({
    mcpServers: {
      finapp: {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          `${window.location.origin}/mcp`,
          "--header",
          `x-api-key:${apiKey}`,
        ],
      },
    },
  }, null, 2) : null;

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Settings</h1>

      {/* Account info */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Account</h2>
        <div style={styles.row}>
          <span style={styles.label}>Name</span>
          <span style={styles.value}>{user?.fullName || "—"}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Email</span>
          <span style={styles.value}>{user?.primaryEmailAddress?.emailAddress || "—"}</span>
        </div>
      </section>

      {/* API Key */}
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Claude Desktop API Key</h2>
        <p style={styles.description}>
          Use this key to connect Claude Desktop to your financial data via MCP.
        </p>

        {loading ? (
          <p style={styles.muted}>Loading…</p>
        ) : apiKey ? (
          <>
            <div style={styles.keyBox}>
              <code style={styles.keyText}>{apiKey}</code>
              <button style={styles.copyBtn} onClick={() => handleCopy(apiKey)}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <button style={styles.regenerateBtn} onClick={handleGenerate} disabled={generating}>
              {generating ? "Regenerating…" : "Regenerate Key"}
            </button>
          </>
        ) : (
          <button style={styles.generateBtn} onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating…" : "Generate API Key"}
          </button>
        )}
      </section>

      {/* Claude Desktop config */}
      {mcpConfig && (
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Claude Desktop Config</h2>
          <p style={styles.description}>
            Add this to your <code style={styles.inlineCode}>~/Library/Application Support/Claude/claude_desktop_config.json</code> under the top-level object, then restart Claude Desktop.
          </p>
          <div style={styles.configBox}>
            <pre style={styles.configText}>{mcpConfig}</pre>
            <button style={styles.copyBtn} onClick={() => handleCopy(mcpConfig)}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const styles = {
  container: { padding: "40px 48px", maxWidth: 720 },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 32, color: "var(--text)" },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 24,
    marginBottom: 20,
  },
  cardTitle: { fontSize: 14, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 },
  row: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" },
  label: { color: "var(--muted)", fontSize: 14 },
  value: { color: "var(--text)", fontSize: 14, fontWeight: 500 },
  description: { color: "var(--muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.6 },
  muted: { color: "var(--muted)", fontSize: 13 },
  keyBox: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 14px",
    marginBottom: 12,
  },
  keyText: { flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", wordBreak: "break-all" },
  generateBtn: {
    background: "var(--accent)",
    color: "#0c0d0f",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  regenerateBtn: {
    background: "none",
    color: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 16px",
    fontWeight: 500,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-display)",
  },
  copyBtn: {
    background: "var(--surface2)",
    color: "var(--text)",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    flexShrink: 0,
    fontFamily: "var(--font-display)",
  },
  configBox: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 16,
    position: "relative",
  },
  configText: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  inlineCode: { fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--surface2)", padding: "1px 4px", borderRadius: 4 },
};
