import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access verification.
 *
 * This app is reached at portal.elevrics.ai/finance, which sits behind an Access
 * application. The Fly hostname stays publicly reachable — deliberately, so
 * Plaid webhooks and MCP clients can still reach it — so browser-facing routes
 * verify the Access token here rather than trusting the portal.
 *
 * Replaces the previous Supabase login for the app UI. Supabase auth is still
 * used by the /oauth/* flow, which is how external MCP clients authorize; that
 * is a different audience and is intentionally left alone.
 *
 * CF_ACCESS_TEAM_DOMAIN is the Zero Trust team URL, CF_ACCESS_AUD the Access
 * application's Audience tag.
 */

const TEAM_DOMAIN = (process.env.CF_ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
const AUD = process.env.CF_ACCESS_AUD || "";

export const accessConfigured = Boolean(TEAM_DOMAIN && AUD);

const jwks = accessConfigured
  ? createRemoteJWKSet(new URL(`${TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  const match = raw.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/**
 * Verify the Access token on a request.
 * @returns {Promise<{email: string} | null>} the identity, or null if absent/invalid
 */
export async function verifyAccess(req) {
  if (!jwks) return null;

  const token =
    req.get("cf-access-jwt-assertion") || readCookie(req, "CF_Authorization");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: AUD,
      issuer: TEAM_DOMAIN,
    });
    return payload?.email ? { email: payload.email } : null;
  } catch {
    return null;
  }
}
