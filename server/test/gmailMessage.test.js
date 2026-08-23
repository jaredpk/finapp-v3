// RFC 2047 / MIME wire-format tests for the alert sender.
//
// buildRawMessage is the only part of gmail.js that is pure, and it is the part
// that decides whether a digest arrives readable or as mojibake. The encoded-word
// length rule in particular is not an edge case: buildDigestEmail puts an em-dash
// in every subject it composes, so every real subject takes the base64 path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRawMessage } from "../gmail.js";

const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");
const subjectLine = (msg) => {
  // Subject may be folded across continuation lines (CRLF + leading space).
  const m = msg.match(/^Subject: ((?:.*(?:\r\n[ \t].*)*))/m);
  return m ? m[1] : null;
};
const decodeEncodedWords = (value) =>
  value
    .split(/\r\n[ \t]/)
    .map((w) => {
      const m = w.match(/^=\?UTF-8\?B\?(.*)\?=$/);
      return m ? Buffer.from(m[1], "base64").toString("utf8") : w;
    })
    .join("");

test("an ASCII subject is sent as-is, not needlessly encoded", () => {
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject: "Plain subject", text: "hi" }));
  assert.match(msg, /^Subject: Plain subject\r$/m);
});

test("a non-ASCII subject round-trips through the encoded words", () => {
  const subject = "2 card benefits expiring — $315.00 unused, soonest in 8 days";
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject, text: "hi" }));
  assert.equal(decodeEncodedWords(subjectLine(msg).replace(/\r$/, "")), subject);
});

test("every encoded word stays inside the RFC 2047 75-character limit", () => {
  // Long, em-dashed, and realistic: this is the shape phase 2 will produce.
  const subject =
    "Card benefit expiring: Airline incidental fee credit for the selected carrier ($200.00) — in 14 days";
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject, text: "hi" }));
  const words = subjectLine(msg).replace(/\r/g, "").split(/\n[ \t]/);
  assert.ok(words.length > 1, "an over-length subject must be split across several words");
  for (const w of words) assert.ok(w.length <= 75, `encoded word too long (${w.length}): ${w}`);
  assert.equal(decodeEncodedWords(subjectLine(msg).replace(/\r$/, "")), subject);
});

test("splitting never cuts a multi-byte character in half", () => {
  // Every character is 3 bytes, so a naive 45-byte cut lands mid-character
  // unless the splitter walks code points.
  const subject = "日本語".repeat(40);
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject, text: "hi" }));
  const decoded = decodeEncodedWords(subjectLine(msg).replace(/\r$/, ""));
  assert.equal(decoded, subject);
  assert.ok(!decoded.includes("�"), "no replacement characters");
});

test("astral characters survive the split", () => {
  const subject = "🎉".repeat(30) + " — done";
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject, text: "hi" }));
  assert.equal(decodeEncodedWords(subjectLine(msg).replace(/\r$/, "")), subject);
});

test("no header line approaches the RFC 5322 998-character hard limit", () => {
  const subject = "Card benefit expiring: " + "A".repeat(2000) + " — soon";
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject, text: "hi" }));
  const headers = msg.split("\r\n\r\n")[0];
  for (const line of headers.split("\r\n")) {
    assert.ok(line.length <= 998, `header line ${line.length} chars exceeds RFC 5322 limit`);
  }
});

test("the raw output is base64url with no characters the Gmail API rejects", () => {
  const raw = buildRawMessage({ to: "a@b.com", from: "a@b.com", subject: "Über — ✓", text: "hi", html: "<p>hi</p>" });
  assert.doesNotMatch(raw, /[+/=]/);
});

test("a multipart message is properly delimited and terminated", () => {
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject: "x", text: "plain", html: "<p>rich</p>" }));
  const boundary = msg.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, "a multipart message declares a boundary");
  assert.ok(msg.includes(`--${boundary}--`), "closing delimiter present");
  assert.ok(msg.indexOf("text/plain") < msg.indexOf("text/html"), "plain part precedes html part");
});

test("body text cannot forge a MIME boundary", () => {
  // Bodies are base64-encoded, so attacker-supplied delimiter text is inert.
  const boundaryish = "--finapp-0000000000000000\r\nContent-Type: text/html\r\n\r\ninjected";
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject: "x", text: boundaryish, html: "<p>hi</p>" }));
  const boundary = msg.match(/boundary="([^"]+)"/)[1];
  assert.equal(msg.split(`--${boundary}`).length - 1, 3, "exactly two parts plus the terminator");
  assert.ok(!msg.includes("injected"), "raw attacker text never reaches the wire");
});

test("headers are CRLF-separated with no bare newlines", () => {
  const msg = decodeRaw(buildRawMessage({ to: "a@b.com", from: "a@b.com", subject: "Über — ✓", text: "hi" }));
  const headers = msg.split("\r\n\r\n")[0];
  assert.doesNotMatch(headers.replace(/\r\n/g, ""), /[\r\n]/, "no bare CR or LF");
});

test("a CRLF in the subject cannot inject a header", () => {
  const msg = decodeRaw(buildRawMessage({
    to: "a@b.com", from: "a@b.com",
    subject: "hi\r\nBcc: attacker@example.com", text: "hi",
  }));
  assert.ok(!/^Bcc:/m.test(msg), "no injected Bcc header");
});
