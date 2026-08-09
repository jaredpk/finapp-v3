// Gmail OAuth for the receipt scanner (Brief 01, Part B). Single-user, one-time
// manual flow: the Settings card fetches the consent URL, the owner approves in
// a browser, and pastes the resulting code back. Read-only scope; the refresh
// token is the only thing persisted (gmail_tokens, one row).
//
// Nothing here touches Google at import time, so the app boots with none of the
// OAuth env vars set — the route handlers return "not configured" instead.
import { google } from "googleapis";
import { saveGmailRefreshToken, getGmailRefreshToken } from "./db.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

export function getGmailAuthUrl() {
  return makeOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_SCOPE],
  });
}

// Exchanges the pasted code for tokens and stores the refresh token.
export async function exchangeGmailAuthCode(code) {
  const { tokens } = await makeOAuthClient().getToken(code.trim());
  if (!tokens.refresh_token) {
    // Happens when consent was previously granted without prompt:consent —
    // Google omits the refresh token on re-approval.
    throw new Error("Google did not return a refresh token — revoke access at myaccount.google.com/permissions and retry");
  }
  await saveGmailRefreshToken(tokens.refresh_token);
}

export async function gmailConnected() {
  return Boolean(await getGmailRefreshToken());
}

// Authenticated Gmail client for the scanner. Throws if not connected.
export async function getGmailClient() {
  const refreshToken = await getGmailRefreshToken();
  if (!refreshToken) throw new Error("Gmail is not connected");
  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth });
}
