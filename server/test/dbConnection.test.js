import test from "node:test";
import assert from "node:assert/strict";
import { isLocalConnectionString } from "../db.js";

// Which DATABASE_URLs are allowed to drop TLS.
//
// db.js turns SSL off for a loopback connection string, because the local
// test/dev Postgres speaks no TLS at all and a Pool that insists on it cannot
// connect. Every other host keeps `ssl: { rejectUnauthorized: false }` — the
// production pooler included — so this predicate is the whole of the decision,
// and getting it wrong sends the password and every row over the wire in
// cleartext.
//
// The trap it has to survive: node-postgres parses the DSN with
// pg-connection-string, which follows libpq, where a `host=` QUERY PARAMETER
// overrides the URL authority completely. Verified against the installed
// parser:
//
//   pg-connection-string.parse("postgres://u:p@localhost:5432/db?host=remote.example.com")
//     → { host: "remote.example.com", ... }
//
// and confirmed by dialling a real server: a DSN whose authority is an
// unresolvable name connects fine when `?host=` names a reachable one. So a URL
// whose authority reads `localhost` can connect to a remote server, and
// deciding from `new URL(url).hostname` alone disabled TLS on a genuinely
// remote connection. The parameter has to be part of the decision.
//
// `hostaddr` counts too, even though node-postgres dials `host` and ignores
// `hostaddr` today: it is libpq's "connect to THIS address", so a DSN carrying
// a non-loopback one is ambiguous about where it lands, and ambiguous keeps
// TLS.
//
// The posture throughout is fail-safe INTO SSL: anything unreadable, unset or
// merely ambiguous keeps TLS.
const CASES = [
  // ── Plain authority ─────────────────────────────────────────────────────────
  ["postgres://postgres@127.0.0.1:55432/finapp_test", true, "the local test database"],
  ["postgres://u:p@localhost:5432/db", true, "localhost by name"],
  ["postgres://u:p@[::1]:5432/db", true, "IPv6 loopback, brackets stripped"],
  ["postgresql://postgres:pw@LOCALHOST:5432/db", true, "host names are case-insensitive"],
  ["postgres://u:p@db.abcdefgh.supabase.co:5432/postgres", false, "production Supabase keeps SSL"],
  ["postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres", false, "production pooler keeps SSL"],
  ["postgres://u:p@localhost.evil.example.com:5432/db", false, "a name that merely starts with localhost"],
  ["postgres://u:p@127.0.0.1.evil.example.com:5432/db", false, "a name that merely starts with 127.0.0.1"],
  ["postgres://u:p@10.0.0.5:5432/db", false, "a private address is still not loopback"],

  // ── The ?host= / ?hostaddr= override ────────────────────────────────────────
  ["postgres://u:p@localhost:5432/db?host=remote.example.com", false,
    "a loopback authority overridden to a REMOTE host: the connection is remote, so it keeps SSL"],
  ["postgres://u:p@localhost:5432/db?hostaddr=203.0.113.9", false,
    "a remote hostaddr= is ambiguous about where this lands, so it keeps SSL"],
  ["postgres://u:p@localhost:5432/db?host=localhost&hostaddr=203.0.113.9", false,
    "a loopback host= does not rescue a remote hostaddr="],
  ["postgres://u:p@remote.example.com:5432/db?host=127.0.0.1", true,
    "and the reverse: the parameter wins, so this connection really is loopback"],
  ["postgres://u:p@localhost:5432/db?host=127.0.0.1", true, "an override that agrees with the authority"],
  ["postgres://u:p@localhost:5432/db?host=%2Fvar%2Frun%2Fpostgresql", true,
    "a unix socket path never leaves the machine, so there is no cleartext hop"],
  ["postgres://u:p@localhost:5432/db?host=localhost,127.0.0.1", true,
    "libpq's comma-separated host list, every entry loopback"],
  ["postgres://u:p@localhost:5432/db?host=localhost,remote.example.com", false,
    "one remote entry in the list is enough to keep SSL"],
  ["postgres://u:p@localhost:5432/db?host=", false, "an empty override is ambiguous, so it keeps SSL"],
  ["postgres://u:p@localhost:5432/db?application_name=finapp", true,
    "an unrelated query parameter changes nothing"],

  // ── Unreadable ──────────────────────────────────────────────────────────────
  ["", false, "an empty string"],
  [undefined, false, "an unset DATABASE_URL"],
  [null, false, "a null DATABASE_URL"],
  ["not a url at all", false, "something new URL() cannot parse"],
];

test("only a connection that really lands on loopback may drop TLS", () => {
  for (const [dsn, expected, why] of CASES) {
    assert.equal(isLocalConnectionString(dsn), expected, `${why}: ${String(dsn)}`);
  }
});
