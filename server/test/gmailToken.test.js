// checkGmailToken: the difference between "a token row exists" and "Google
// still accepts it". An expired refresh token (invalid_grant) used to read as
// connected until the daily alert run 500ed.
//
// No database and no network: the stored token comes from a stubbed
// pg Pool.prototype.query (db.js's pool is an instance of it), and the token
// mint is a stubbed OAuth2 getAccessToken. The three-valued contract is the
// point — only an explicit invalid_grant may read as "expired"; anything else
// that fails is "unknown", so a network blip never tells the owner to reconnect.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { auth as googleAuth } from "@googleapis/gmail";
import { checkGmailToken } from "../gmail.js";

function withEnv(t) {
  const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  t.after(() => {
    if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
  });
}

function storedToken(t, token) {
  return t.mock.method(pg.Pool.prototype, "query", async () => ({ rows: token ? [{ refresh_token: token }] : [] }));
}

function tokenMint(t, impl) {
  return t.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", impl);
}

test("a token Google accepts is valid", async (t) => {
  withEnv(t);
  storedToken(t, "rt-good");
  const mint = tokenMint(t, async () => ({ token: "at" }));
  assert.equal(await checkGmailToken(), true);
  assert.equal(mint.mock.callCount(), 1);
});

test("invalid_grant in the response body reads as expired", async (t) => {
  withEnv(t);
  storedToken(t, "rt-dead");
  tokenMint(t, async () => {
    const err = new Error("Request failed");
    err.response = { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    throw err;
  });
  assert.equal(await checkGmailToken(), false);
});

test("invalid_grant only in the message still reads as expired", async (t) => {
  withEnv(t);
  storedToken(t, "rt-dead");
  tokenMint(t, async () => { throw new Error("invalid_grant"); });
  assert.equal(await checkGmailToken(), false);
});

test("a network failure is unknown, not expired", async (t) => {
  withEnv(t);
  storedToken(t, "rt-good");
  tokenMint(t, async () => {
    const err = new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com");
    err.code = "ENOTFOUND";
    throw err;
  });
  assert.equal(await checkGmailToken(), null);
});

test("a different OAuth error is unknown, not expired", async (t) => {
  withEnv(t);
  storedToken(t, "rt-good");
  tokenMint(t, async () => {
    const err = new Error("Request failed with status 500");
    err.response = { data: { error: "internal_failure" } };
    throw err;
  });
  assert.equal(await checkGmailToken(), null);
});

test("not connected is unknown and never calls Google", async (t) => {
  withEnv(t);
  storedToken(t, null);
  const mint = tokenMint(t, async () => ({ token: "at" }));
  assert.equal(await checkGmailToken(), null);
  assert.equal(mint.mock.callCount(), 0);
});

test("not configured is unknown and touches neither the database nor Google", async (t) => {
  const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  t.after(() => {
    if (saved.id !== undefined) process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret !== undefined) process.env.GOOGLE_CLIENT_SECRET = saved.secret;
  });
  const query = storedToken(t, "rt-good");
  const mint = tokenMint(t, async () => ({ token: "at" }));
  assert.equal(await checkGmailToken(), null);
  assert.equal(query.mock.callCount(), 0);
  assert.equal(mint.mock.callCount(), 0);
});
