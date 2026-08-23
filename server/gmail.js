// Gmail OAuth for the receipt scanner (Brief 01, Part B) and, since Brief 05,
// the outbound alert channel. Single-user, one-time manual flow: the Settings
// card fetches the consent URL, the owner approves in a browser, and pastes the
// resulting code back. The refresh token and the granted scopes are the only
// things persisted (gmail_tokens, one row).
//
// Nothing here touches Google at import time, so the app boots with none of the
// OAuth env vars set — the route handlers return "not configured" instead.
// Scoped @googleapis/gmail instead of the googleapis monolith: the monolith
// eagerly loads every Google API client and costs ~113 MB RSS at import,
// which OOMed the 256 MB production VM.
import { randomBytes } from "crypto";
import { auth as googleAuth, gmail } from "@googleapis/gmail";
import { saveGmailRefreshToken, getGmailGrant, getGmailRefreshToken } from "./db.js";

// Two scopes, requested together. They are not interchangeable and neither is
// optional: readonly is the receipt scanner, send is benefits alerting. A
// consent screen that granted only one of them leaves half the app broken
// silently, which is why the grant is stored and reported rather than assumed —
// see getGrantedScopes/canSendMail and /api/gmail/status.
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE];

// Desktop-credential loopback redirect. Google removed the old
// urn:ietf:wg:oauth:2.0:oob copy-paste page, so the consent flow ends on a
// http://localhost URL that won't load — the owner copies the `code` query
// parameter out of the address bar and pastes it into Settings. Same manual
// code-paste flow the brief describes, minus the retired oob endpoint.
const REDIRECT_URI = "http://localhost";

export function gmailConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function makeOAuthClient() {
  return new googleAuth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

export function getGmailAuthUrl() {
  return makeOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
  });
}

// Exchanges the pasted code for tokens and stores the refresh token plus the
// scopes Google actually granted (`tokens.scope`, space-separated).
//
// A partial grant is SAVED, not rejected: throwing here would discard a working
// refresh token and leave the app disconnected outright. Storing it instead
// makes the partial grant visible — Settings reads the scopes back and says
// what is missing, so a re-consent that dropped `readonly` and quietly broke
// the receipt scanner is reported rather than discovered weeks later.
export async function exchangeGmailAuthCode(code) {
  const { tokens } = await makeOAuthClient().getToken(code.trim());
  if (!tokens.refresh_token) {
    // Happens when consent was previously granted without prompt:consent —
    // Google omits the refresh token on re-approval.
    throw new Error("Google did not return a refresh token — revoke access at myaccount.google.com/permissions and retry");
  }
  const scopes = tokens.scope || "";
  await saveGmailRefreshToken(tokens.refresh_token, scopes);
  return splitScopes(scopes);
}

function splitScopes(scopes) {
  return String(scopes || "").split(/\s+/).filter(Boolean);
}

export async function gmailConnected() {
  return Boolean(await getGmailRefreshToken());
}

// The scopes on the stored grant. Empty when Gmail isn't connected, and also
// empty for a grant saved before the scopes column existed — that reads as
// "unknown", and an unknown grant is treated as not able to send.
export async function getGrantedScopes() {
  const grant = await getGmailGrant();
  if (!grant) return [];
  return splitScopes(grant.scopes);
}

export async function canSendMail() {
  return (await getGrantedScopes()).includes(GMAIL_SEND_SCOPE);
}

// Authenticated Gmail client for the scanner. Throws if not connected.
export async function getGmailClient() {
  const refreshToken = await getGmailRefreshToken();
  if (!refreshToken) throw new Error("Gmail is not connected");
  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return gmail({ version: "v1", auth });
}

// ── Sending ───────────────────────────────────────────────────────────────────

// RFC 2047 encoded-word for a header value. Plain ASCII goes out as-is; anything
// else is base64'd, because a raw UTF-8 byte in a header is mangled by the time
// it reaches an inbox ("Café" arriving as "CafÃ©").
function encodeHeaderValue(value) {
  const text = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

// Bodies go out base64 for the same reason headers do, plus it sidesteps the
// 998-character line limit that would otherwise mangle long HTML.
function bodyPart(contentType, content) {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(content), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");
}

export function buildRawMessage({ to, from, subject, text, html }) {
  const headers = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
  ];
  let message;
  if (text && html) {
    const boundary = `finapp-${randomBytes(12).toString("hex")}`;
    message = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      bodyPart("text/plain", text),
      `--${boundary}`,
      bodyPart("text/html", html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    const isHtml = !text && Boolean(html);
    message = [
      ...headers,
      bodyPart(isHtml ? "text/html" : "text/plain", isHtml ? html : (text || "")),
      "",
    ].join("\r\n");
  }
  return Buffer.from(message, "utf8").toString("base64url");
}

// Sends mail as the connected mailbox, TO the connected mailbox.
//
// The recipient is resolved from users.getProfile and is deliberately NOT
// configurable — no parameter, no env var, no database column. That is a
// structural guarantee: a bug anywhere in the alerting code (a bad template, a
// mis-joined query, a stray address in a benefit name) cannot cause this app to
// email anybody other than the owner of the mailbox that granted consent.
export async function sendMail({ subject, text, html }) {
  if (!(await canSendMail())) {
    throw new Error("Gmail is connected without the send scope — reconnect Gmail in Settings to grant it");
  }
  const client = await getGmailClient();
  const { data: profile } = await client.users.getProfile({ userId: "me" });
  const address = profile?.emailAddress;
  if (!address) throw new Error("Could not resolve the Gmail account address");

  const raw = buildRawMessage({ to: address, from: address, subject, text, html });
  const { data } = await client.users.messages.send({ userId: "me", requestBody: { raw } });
  return { id: data?.id || null, to: address };
}
