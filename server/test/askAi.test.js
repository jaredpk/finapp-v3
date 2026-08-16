import test from "node:test";
import assert from "node:assert/strict";
import {
  runAskLoop, truncateJson, MAX_RESULT_CHARS, functionDeclarations,
  resolveAskModel, thinkingConfigFor, ASK_DEADLINE_MS,
} from "../askAi.js";

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

// Fake clock for the wall-clock deadline: returns each scripted timestamp in
// turn and then holds the last one, so tests move time without waiting for it.
// runAskLoop calls `now` once up front to fix the deadline, then once at the
// top of every iteration.
function scriptedClock(times) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
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

// The deadline exists so a slow question degrades to our own JSON answer
// instead of running past the proxy's timeout and handing the client a gateway
// HTML page. It is enforced between round-trips only.
test("passing the deadline stops the loop, keeps partial tool calls, and reports it distinctly", async () => {
  let generateCalls = 0;
  const generate = async () => {
    generateCalls++;
    return modelTurn([{ name: "get_latest_balances", args: {} }]);
  };
  const impl = { get_latest_balances: async () => [] };
  // Deadline lands at 0 + ASK_DEADLINE_MS. Iteration 0 checks at 1000
  // (inside), the call it starts takes the clock past the budget, and
  // iteration 1 checks at 1000 + ASK_DEADLINE_MS (outside).
  const now = scriptedClock([0, 1_000, 1_000 + ASK_DEADLINE_MS]);

  const out = await runAskLoop({ question: "Something slow", generate, impl, now });

  assert.equal(out.answer, "That took too long to answer — try a narrower question.");
  // Distinct from the iteration-cap wording, so logs say which limit bit.
  assert.notEqual(out.answer, "I couldn't finish answering that — try a narrower question.");
  assert.equal(generateCalls, 1); // the in-flight call ran; no new one started
  assert.deepEqual(out.toolCalls, ["get_latest_balances"]); // partial work kept
});

test("a run that finishes inside the deadline is unaffected by it", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "list_categories", args: {} }]),
    finalTurn("You have 4 categories."),
  ]);
  const impl = { list_categories: async () => [{ id: "c1", name: "Groceries" }] };
  const now = scriptedClock([0, 10, 20]);

  const out = await runAskLoop({ question: "How many categories?", generate, impl, now });

  assert.equal(out.answer, "You have 4 categories.");
  assert.deepEqual(out.toolCalls, ["list_categories"]);
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

// Regression: an OBJECT schema with empty `properties` is rejected by the API
// at request validation (400 INVALID_ARGUMENT), and since every declaration is
// sent on every generateContent call, one bad entry breaks all of Ask AI. A
// zero-argument tool must omit `parameters` entirely rather than declare an
// empty OBJECT.
test("no function declaration declares an OBJECT with empty properties", () => {
  for (const decl of functionDeclarations) {
    if (!decl.parameters) continue; // zero-argument tool: correct by omission
    if (decl.parameters.type !== "OBJECT") continue;
    const properties = decl.parameters.properties;
    assert.ok(
      properties && Object.keys(properties).length > 0,
      `${decl.name}: OBJECT parameters need non-empty properties — omit \`parameters\` instead`
    );
  }
});

// Thinking is switched off to cut latency, but only where it can be: flash
// accepts thinkingBudget 0, gemini-2.5-pro cannot go below 128 and 400s on 0.
// Because the model comes from ASK_AI_MODEL, sending the field unconditionally
// would turn one env var into a config that fails every request — the guard is
// what stops that, so it gets a test of its own.
test("the resolved model decides thinking: default disables it, ASK_AI_MODEL is honoured", (t) => {
  const original = process.env.ASK_AI_MODEL;
  t.after(() => {
    if (original === undefined) delete process.env.ASK_AI_MODEL;
    else process.env.ASK_AI_MODEL = original;
  });

  delete process.env.ASK_AI_MODEL;
  assert.equal(resolveAskModel(), "gemini-2.5-flash");
  assert.deepEqual(thinkingConfigFor(resolveAskModel()), { thinkingConfig: { thinkingBudget: 0 } });

  process.env.ASK_AI_MODEL = "gemini-2.5-pro";
  assert.equal(resolveAskModel(), "gemini-2.5-pro");
  assert.deepEqual(thinkingConfigFor(resolveAskModel()), {});
});

test("thinkingConfigFor: 2.5 flash and flash-lite disable thinking, pro carries none", () => {
  assert.deepEqual(thinkingConfigFor("gemini-2.5-flash"), { thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(thinkingConfigFor("gemini-2.5-flash-lite"), { thinkingConfig: { thinkingBudget: 0 } });

  // Absent, not present-and-undefined: a key that exists still gets serialized
  // into the request, which is the exact thing pro rejects.
  const pro = thinkingConfigFor("gemini-2.5-pro");
  assert.equal("thinkingConfig" in pro, false);
  assert.deepEqual(Object.keys({ systemInstruction: "s", ...pro }), ["systemInstruction"]);
});

// The guard must not be a substring search for "flash": the pre-2.5 flash
// models have no thinkingConfig at all, so sending thinkingBudget 0 to one
// would 400 every request just as surely as sending it to pro. Anything not
// on the allow-list keeps the model's own default instead.
test("thinkingConfigFor: pre-2.5 flash models get no thinkingConfig", () => {
  for (const model of ["gemini-2.0-flash", "gemini-1.5-flash"]) {
    const config = thinkingConfigFor(model);
    assert.equal("thinkingConfig" in config, false, `${model} must carry no thinkingConfig`);
    assert.deepEqual(config, {});
  }
});

// Fails safe: an unrecognised name gets no thinkingConfig, so the worst case
// of a future model is "slower than it could be", never "400s every request".
test("thinkingConfigFor: unrecognised model names fall through to no thinkingConfig", () => {
  for (const model of ["", undefined, "gemini-3-flash", "some-other-model"]) {
    assert.deepEqual(thinkingConfigFor(model), {}, `${model} must carry no thinkingConfig`);
  }
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
