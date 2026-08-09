import React, { useState, useRef, useEffect } from "react";
import { askAi } from "../api.js";

// Ask AI (Brief 03): a chat over POST /api/ask. The thread lives in component
// state only (no persistence in v1); each send carries the last ≤10 prior
// turns as history. Answers render as plain text with newlines preserved.
const HISTORY_TURNS = 10;
const MAX_QUESTION_CHARS = 2000;

const SUGGESTIONS = [
  "How much did I spend last month?",
  "What were my 5 biggest purchases in June?",
  "What's my current total cash balance?",
];

export default function AskAI() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function send(text) {
    const question = (text ?? input).trim();
    if (!question || sending) return;
    const history = messages.slice(-HISTORY_TURNS);
    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setNotice(null);
    setSending(true);
    try {
      const { answer } = await askAi(question, history);
      setMessages((m) => [...m, { role: "model", text: answer || "(no answer)" }]);
    } catch (e) {
      if (e.status === 503) setNotice("Ask AI isn't configured — add GEMINI_API_KEY to server/.env.");
      else if (e.status === 429) setNotice("Rate limited — wait a minute.");
      else setNotice(e.message || "AI request failed");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={styles.wrap}>
      <h1 className="fade-up" style={styles.heading}>Ask AI</h1>

      <div style={styles.chatCard}>
        <div ref={scrollRef} style={styles.thread}>
          {messages.length === 0 && !sending && (
            <div style={styles.emptyState}>
              <p style={styles.emptyText}>Ask anything about your finances.</p>
              <div style={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} style={styles.suggestion} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.bubble,
                ...(m.role === "user" ? styles.userBubble : styles.modelBubble),
              }}
            >
              {m.text}
            </div>
          ))}
          {sending && (
            <div style={{ ...styles.bubble, ...styles.modelBubble }}>
              <span className="pulse" style={styles.thinking}>Thinking…</span>
            </div>
          )}
        </div>

        {notice && <div style={styles.noticeBox}>{notice}</div>}

        <div style={styles.composer}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about your spending, balances, categories…"
            maxLength={MAX_QUESTION_CHARS}
            rows={2}
            style={styles.textarea}
          />
          <button
            onClick={() => send()}
            disabled={sending || !input.trim()}
            style={{ ...styles.sendBtn, opacity: sending || !input.trim() ? 0.5 : 1 }}
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  wrap: { padding: "36px clamp(16px, 5vw, 40px)", maxWidth: 900 },
  heading: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 24, color: "var(--text)" },

  chatCard: {
    display: "flex", flexDirection: "column",
    height: "min(720px, calc(100vh - 200px))", minHeight: 360,
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius2)", overflow: "hidden",
  },
  thread: {
    flex: 1, overflowY: "auto", display: "flex", flexDirection: "column",
    gap: 10, padding: "20px 20px 12px",
  },

  emptyState: { margin: "auto", textAlign: "center", padding: 24 },
  emptyText: { color: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)", marginBottom: 16 },
  suggestions: { display: "flex", flexDirection: "column", gap: 8, alignItems: "center" },
  suggestion: {
    padding: "7px 14px", background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: 99, color: "var(--muted)", fontSize: 12, cursor: "pointer",
    fontFamily: "var(--font-mono)",
  },

  bubble: {
    maxWidth: "80%", padding: "10px 14px", borderRadius: 14,
    fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "break-word",
  },
  userBubble: {
    alignSelf: "flex-end", background: "var(--accent)", color: "#fff",
    borderBottomRightRadius: 4,
  },
  modelBubble: {
    alignSelf: "flex-start", background: "var(--surface2)", color: "var(--text)",
    border: "1px solid var(--border)", borderBottomLeftRadius: 4,
  },
  thinking: { color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12 },

  noticeBox: {
    margin: "0 20px 10px", padding: "8px 12px", background: "var(--surface2)",
    border: "1px solid var(--border)", borderRadius: "var(--radius)",
    color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)",
  },

  composer: {
    display: "flex", gap: 10, alignItems: "flex-end",
    padding: "12px 20px 16px", borderTop: "1px solid var(--border)",
  },
  textarea: {
    flex: 1, resize: "none", padding: "10px 12px",
    background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", color: "var(--text)", fontSize: 13,
    fontFamily: "inherit", lineHeight: 1.5, outline: "none",
  },
  sendBtn: {
    padding: "10px 18px", background: "var(--accent)", color: "#fff",
    border: "none", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600,
    fontFamily: "var(--font-display)", cursor: "pointer", flexShrink: 0,
  },
};
