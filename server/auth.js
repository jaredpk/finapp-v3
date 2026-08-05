import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Portal assertion verification.
 *
 * This app is reached at portal.elevrics.ai/finance, and the portal requires a
 * sign-in before it will proxy anything here. That is not sufficient on its own:
 * the Fly hostname stays publicly reachable — deliberately, so Plaid webhooks
 * and MCP clients can still reach it — so browser-facing routes verify here
 * rather than trusting the portal.
 *
 * WHAT CHANGED. This used to verify `Cf-Access-Jwt-Assertion` against a
 * Cloudflare Zero Trust team domain. The portal has replaced Cloudflare Access
 * with its own accounts (WorkOS AuthKit) and now mints its own equivalent: an
 * ES256 JWT in `X-Elevrics-Assertion`, ~2 minutes, one per request, public keys
 * at /.well-known/portal-jwks.json. Same shape of check, different issuer.
 *
 * Unchanged: the Supabase auth used by the /oauth/* flow, which is how external
 * MCP clients authorize. That is a different audience and is intentionally left
 * alone — see requireApiKeyOrAuth in index.js.
 *
 * `aud` IS THE ROUTING PREFIX. The portal mints a token whose audience is the
 * path prefix it is forwarding to, so a token minted for /solayard cannot be
 * replayed here. Checking it is what makes that real.
 *
 * NO COOKIE FALLBACK. The old code also accepted a `CF_Authorization` cookie
 * because Access set one. Nothing sets it now, and the assertion is header-only
 * by design — minted per request, never stored, so there is no long-lived
 * credential sitting in a browser.
 */

/** Where the portal lives. The assertion's `iss`, and where the JWKS is. */
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN || "https://portal.elevrics.ai").replace(/\/$/, "");

/** This module's routing prefix on the portal — the assertion's `aud`. */
const AUDIENCE = process.env.PORTAL_AUDIENCE || "/finance";

/**
 * Cached and refreshed by jose, which is what makes the portal's key rotation
 * survivable: it can publish a second key and switch signing to it without this
 * app being redeployed.
 */
const jwks = createRemoteJWKSet(new URL(`${PORTAL_ORIGIN}/.well-known/portal-jwks.json`));

/**
 * Verify the portal assertion on a request.
 *
 * @returns {Promise<{email: string, claims: object} | null>} the identity, or
 *   null if the header is absent, unverifiable, expired, or minted for another
 *   module. Callers decide what to do about it — this gates financial data, so
 *   a null is never "carry on".
 */
export async function verifyPortalAssertion(req) {
  const token = req.get("x-elevrics-assertion");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      // Pinned. Without this a verifier accepts whatever algorithm the token
      // header names that the key material can satisfy.
      algorithms: ["ES256"],
      audience: AUDIENCE,
      issuer: PORTAL_ORIGIN,
    });
    return payload?.email ? { email: payload.email, claims: payload } : null;
  } catch {
    return null;
  }
}
