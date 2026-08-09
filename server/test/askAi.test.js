import test from "node:test";
import assert from "node:assert/strict";
import { runAskLoop, truncateJson, MAX_RESULT_CHARS } from "../askAi.js";

// runAskLoop is the pure half of POST /api/ask: `generate` is a scripted fake
// standing in for ai.models.generateContent, `impl` a fake tool map. The
// contract these tests encode (verified against @google/genai 2.16.0):
// - generate's return exposes `functionCalls` (undefined/empty when the model
//   is done answering), `text`, and `candidates[0].content.parts`.
// - Each tool result goes back as a user turn with a single functionResponse
//   part: { functionResponse: { name, response: { result: <JSON string> } } }.
// - Tool errors are passed back the same way ({ error }) and the loop
//   continues rather than aborting the request.

// A model turn that asks for the given function calls.
const modelTurn = (calls) => ({
  functionCalls: calls,
  candidates: [{ content: { role: "model", parts: calls.map((c) => ({ functionCall: c })) } }],
});

// A final text answer (no function calls).
const finalTurn = (text) => ({
  text,
  functionCalls: undefined,
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
});

// Returns each scripted turn in order and records a deep copy of the contents
// it was called with (the loop mutates the array in place).
function scriptedGenerate(turns) {
  const remaining = [...turns];
  const fn = async (contents) => {
    fn.calls.push(structuredClone(contents));
    const next = remaining.shift();
    if (!next) throw new Error("scripted generate exhausted");
    return next;
  };
  fn.calls = [];
  return fn;
}

test("two function calls then a final answer: impl invoked with args, responses appended in shape, answer returned", async () => {
  const generate = scriptedGenerate([
    modelTurn([
      { name: "get_spending_by_category", args: { start_date: "2026-07-01", end_date: "2026-07-31" } },
      { name: "list_categories", args: {} },
    ]),
    finalTurn("You spent $1,234.56 in July."),
  ]);
  const seen = { spendingArgs: null, categoriesCalls: 0 };
  const spendingRows = [{ category: "Groceries", total: 1234.56, count: 9 }];
  const categoryRows = [{ id: "c1", name: "Groceries" }];
  const impl = {
    get_spending_by_category: async (args) => { seen.spendingArgs = args; return spendingRows; },
    list_categories: async () => { seen.categoriesCalls++; return categoryRows; },
  };

  const out = await runAskLoop({ question: "How much did I spend in July?", generate, impl });

  assert.equal(out.answer, "You spent $1,234.56 in July.");
  assert.deepEqual(out.toolCalls, ["get_spending_by_category", "list_categories"]);
  assert.deepEqual(seen.spendingArgs, { start_date: "2026-07-01", end_date: "2026-07-31" });
  assert.equal(seen.categoriesCalls, 1);

  // First generate call: just the question.
  assert.deepEqual(generate.calls[0], [
    { role: "user", parts: [{ text: "How much did I spend in July?" }] },
  ]);
  // Second call: question + echoed model turn + one functionResponse per call.
  const second = generate.calls[1];
  assert.equal(second.length, 4);
  assert.equal(second[1].role, "model");
  assert.deepEqual(second[1].parts.map((p) => p.functionCall.name),
    ["get_spending_by_category", "list_categories"]);
  assert.deepEqual(second[2], {
    role: "user",
    parts: [{ functionResponse: {
      name: "get_spending_by_category",
      response: { result: JSON.stringify(spendingRows) },
    } }],
  });
  assert.deepEqual(second[3], {
    role: "user",
    parts: [{ functionResponse: {
      name: "list_categories",
      response: { result: JSON.stringify(categoryRows) },
    } }],
  });
});

test("hitting maxIterations returns the fallback answer", async () => {
  let generateCalls = 0;
  const generate = async () => {
    generateCalls++;
    return modelTurn([{ name: "get_latest_balances", args: {} }]);
  };
  const impl = { get_latest_balances: async () => [] };

  const out = await runAskLoop({ question: "Loop forever", generate, impl, maxIterations: 3 });

  assert.equal(out.answer, "I couldn't finish answering that — try a narrower question.");
  assert.equal(generateCalls, 3);
  assert.deepEqual(out.toolCalls, [
    "get_latest_balances", "get_latest_balances", "get_latest_balances",
  ]);
});

test("a throwing impl function is passed back as the functionResponse and the loop continues", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "get_transactions", args: { start_date: "bogus" } }]),
    finalTurn("Sorry, I couldn't read your transactions."),
  ]);
  const impl = {
    get_transactions: async () => { throw new Error("db exploded"); },
  };

  const out = await runAskLoop({ question: "What did I buy?", generate, impl });

  assert.equal(out.answer, "Sorry, I couldn't read your transactions.");
  assert.deepEqual(generate.calls[1][2], {
    role: "user",
    parts: [{ functionResponse: {
      name: "get_transactions",
      response: { result: JSON.stringify({ error: "db exploded" }) },
    } }],
  });
});

test("an unknown tool name is answered with an error response, not a crash", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "delete_everything", args: {} }]),
    finalTurn("I can't do that."),
  ]);

  const out = await runAskLoop({ question: "Wipe it", generate, impl: {} });

  assert.equal(out.answer, "I can't do that.");
  assert.deepEqual(generate.calls[1][2].parts[0].functionResponse.response, {
    result: JSON.stringify({ error: "Unknown tool: delete_everything" }),
  });
});

test("tool results over 50k chars are truncated with a marker", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "get_transactions", args: {} }]),
    finalTurn("Lots of transactions."),
  ]);
  const impl = { get_transactions: async () => ({ data: "x".repeat(60_000) }) };

  const out = await runAskLoop({ question: "Everything, please", generate, impl });

  assert.equal(out.answer, "Lots of transactions.");
  const { result } = generate.calls[1][2].parts[0].functionResponse.response;
  assert.equal(result.length, MAX_RESULT_CHARS + "(truncated)".length);
  assert.ok(result.endsWith("(truncated)"));
  assert.ok(result.startsWith('{"data":"xxx'));
});

test("truncateJson leaves short values alone", () => {
  assert.equal(truncateJson({ a: 1 }), '{"a":1}');
  assert.equal(truncateJson([1, 2, 3], 10), "[1,2,3]");
});

test("history is clamped to the last 10 turns and junk entries are dropped", async () => {
  const history = [];
  for (let i = 1; i <= 12; i++) {
    history.push({ role: i % 2 ? "user" : "model", text: `turn ${i}` });
  }
  history.push({ role: "system", text: "not a real role" });
  history.push({ role: "user", text: "   " });
  const generate = scriptedGenerate([finalTurn("ok")]);

  await runAskLoop({ question: "and now?", history, generate, impl: {} });

  const contents = generate.calls[0];
  assert.equal(contents.length, 11); // 10 history turns + the question
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "turn 3" }] });
  assert.deepEqual(contents[9], { role: "model", parts: [{ text: "turn 12" }] });
  assert.deepEqual(contents[10], { role: "user", parts: [{ text: "and now?" }] });
});
