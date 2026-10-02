import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BULK_TRANSACTIONS, MAX_INSTRUCTION_CHARS, parseProposeRequest,
  validateChanges, proposeBulkUpdate, buildProposalPrompt,
} from "../bulkUpdate.js";
import pool, { applyBulkChanges } from "../db.js";

// No network, no database: `generate` is a scripted fake standing in for
// ai.models.generateContent (same pattern as askAi.test.js), and the apply test
// swaps pool.connect for a recording fake client.
function scriptedGenerate(turns) {
  const remaining = [...turns];
  const fn = async (contents) => {
    fn.calls.push(contents);
    const next = remaining.shift();
    if (!next) throw new Error("scripted generate exhausted");
    return next;
  };
  fn.calls = [];
  return fn;
}
const jsonTurn = (value, usageMetadata) => ({ text: JSON.stringify(value), usageMetadata });

const CAT_GROCERIES = "11111111-1111-1111-1111-111111111111";
const CAT_DINING = "22222222-2222-2222-2222-222222222222";
const categories = [{ id: CAT_GROCERIES, name: "Groceries" }, { id: CAT_DINING, name: "Dining" }];
const rows = [
  { id: "t1", date: "2026-09-01", merchant: "WHOLEFDS #123", amount: 45.2, category: null },
  { id: "t2", date: "2026-09-02", merchant: "SQ *COFFEE", amount: 4.5, category: null },
];
const ctx = { allowedIds: new Set(["t1", "t2"]), categoryIds: new Set([CAT_GROCERIES, CAT_DINING]) };

test("parseProposeRequest accepts ids + instruction and dedupes ids", () => {
  const r = parseProposeRequest({ transactionIds: ["a", "b", "a"], instruction: "  categorize as Groceries " });
  assert.deepEqual(r, { ids: ["a", "b"], instruction: "categorize as Groceries" });
});

test("parseProposeRequest rejects bad input", () => {
  assert.match(parseProposeRequest({ transactionIds: ["a"] }).error, /instruction/);
  assert.match(parseProposeRequest({ transactionIds: ["a"], instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1) }).error, /characters/);
  assert.match(parseProposeRequest({ instruction: "x" }).error, /transactionIds/);
  assert.match(parseProposeRequest({ transactionIds: [], instruction: "x" }).error, /transactionIds/);
  assert.match(parseProposeRequest({ transactionIds: [1], instruction: "x" }).error, /strings/);
});

test("parseProposeRequest enforces the size cap", () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `t${i}`);
  assert.ok(parseProposeRequest({ transactionIds: ids(MAX_BULK_TRANSACTIONS), instruction: "x" }).ids);
  assert.match(parseProposeRequest({ transactionIds: ids(MAX_BULK_TRANSACTIONS + 1), instruction: "x" }).error, /at most 100/);
});

test("validateChanges drops ids outside the requested set and duplicates", () => {
  const { changes, skipped } = validateChanges([
    { transactionId: "t1", categoryId: CAT_GROCERIES, merchant: null, reason: "grocery store" },
    { transactionId: "evil", categoryId: CAT_GROCERIES, merchant: null, reason: "x" },
    { transactionId: "t1", categoryId: CAT_DINING, merchant: null, reason: "again" },
  ], ctx);
  assert.deepEqual(changes, [{ transactionId: "t1", categoryId: CAT_GROCERIES, merchant: null, reason: "grocery store" }]);
  assert.deepEqual(skipped.map((s) => s.reason), ["transaction not in the requested set", "duplicate change for this transaction"]);
});

test("validateChanges flags an unknown category but keeps a merchant rename on the same row", () => {
  const { changes, skipped } = validateChanges([
    { transactionId: "t1", categoryId: "99999999-9999-9999-9999-999999999999", merchant: " Whole Foods ", reason: "r" },
    { transactionId: "t2", categoryId: "99999999-9999-9999-9999-999999999999", merchant: null, reason: "r" },
  ], ctx);
  assert.deepEqual(changes, [{ transactionId: "t1", categoryId: null, merchant: "Whole Foods", reason: "r" }]);
  assert.deepEqual(skipped, [
    { transactionId: "t1", reason: "unknown category" },
    { transactionId: "t2", reason: "unknown category" },
  ]);
});

test("validateChanges omits no-op rows and tolerates a non-array", () => {
  assert.deepEqual(validateChanges([{ transactionId: "t1", categoryId: null, merchant: "  ", reason: "" }], ctx).changes, []);
  assert.deepEqual(validateChanges({ nope: true }, ctx), { changes: [], skipped: [] });
});

test("validateChanges caps the list at MAX_BULK_TRANSACTIONS", () => {
  const ids = Array.from({ length: MAX_BULK_TRANSACTIONS + 5 }, (_, i) => `t${i}`);
  const raw = ids.map((id) => ({ transactionId: id, categoryId: CAT_DINING, merchant: null, reason: "r" }));
  const { changes, skipped } = validateChanges(raw, { allowedIds: new Set(ids), categoryIds: ctx.categoryIds });
  assert.equal(changes.length, MAX_BULK_TRANSACTIONS);
  assert.ok(skipped.some((s) => /capped/.test(s.reason)));
});

test("proposeBulkUpdate: one scripted call, validated output, usage reported", async () => {
  const generate = scriptedGenerate([
    jsonTurn(
      [
        { transactionId: "t1", categoryId: CAT_GROCERIES, merchant: "Whole Foods", reason: "grocery" },
        { transactionId: "t2", categoryId: "bogus", merchant: null, reason: "coffee" },
        { transactionId: "t3", categoryId: CAT_DINING, merchant: null, reason: "not requested" },
      ],
      { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
    ),
  ]);
  const out = await proposeBulkUpdate({ rows, categories, instruction: "clean up", generate });
  assert.equal(generate.calls.length, 1);
  assert.match(generate.calls[0], /Instruction: clean up/);
  assert.match(generate.calls[0], new RegExp(`${CAT_GROCERIES}: Groceries`));
  assert.deepEqual(out.changes, [{ transactionId: "t1", categoryId: CAT_GROCERIES, merchant: "Whole Foods", reason: "grocery" }]);
  assert.equal(out.skipped.length, 2);
  assert.equal(out.usage.totalTokens, 120);
});

test("proposeBulkUpdate: unparseable response throws with usage attached", async () => {
  const generate = scriptedGenerate([{ text: "not json", usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }]);
  await assert.rejects(
    proposeBulkUpdate({ rows, categories, instruction: "x", generate }),
    (err) => /unparseable/.test(err.message) && err.usage.totalTokens === 10
  );
});

test("buildProposalPrompt sends only the given row fields", () => {
  const p = buildProposalPrompt({ rows, categories, instruction: "i" });
  assert.match(p, /WHOLEFDS #123/);
});

test("applyBulkChanges writes both upserts in one BEGIN/COMMIT and counts them", async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => { queries.push({ sql: sql.trim().split(/\s+/)[0], params }); return { rows: [] }; },
    release: () => { client.released = true; },
  };
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    const counts = await applyBulkChanges([
      { transactionId: "t1", categoryId: CAT_GROCERIES, merchant: "Whole Foods" },
      { transactionId: "t2", categoryId: null, merchant: "Coffee" },
    ]);
    assert.deepEqual(counts, { categories: 1, merchants: 2 });
    assert.deepEqual(queries.map((q) => q.sql), ["BEGIN", "INSERT", "INSERT", "INSERT", "COMMIT"]);
    assert.ok(client.released);
  } finally {
    pool.connect = original;
  }
});

test("applyBulkChanges rolls back and rethrows when a write fails", async () => {
  const seen = [];
  const client = {
    query: async (sql) => {
      const verb = sql.trim().split(/\s+/)[0];
      seen.push(verb);
      if (verb === "INSERT") throw new Error("fk violation");
      return { rows: [] };
    },
    release: () => {},
  };
  const original = pool.connect;
  pool.connect = async () => client;
  try {
    await assert.rejects(applyBulkChanges([{ transactionId: "t1", categoryId: CAT_GROCERIES, merchant: null }]), /fk violation/);
    assert.deepEqual(seen, ["BEGIN", "INSERT", "ROLLBACK"]);
  } finally {
    pool.connect = original;
  }
});
