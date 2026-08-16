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
//   part: { functionResponse: { name, response: { result: <JSON string> } } },
//   plus `id` when the model populated FunctionCall.id (Gemini 3 does; 2.5
//   doesn't, and its request shape must stay exactly as it is above).
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

// Gemini 3 pairs each functionResponse with its functionCall by id, so a turn
// with parallel calls to the same tool is ambiguous without it.
test("function call ids are echoed back on the matching functionResponse", async () => {
  const generate = scriptedGenerate([
    modelTurn([
      { id: "call_a1", name: "get_transactions", args: { category: "Groceries" } },
      { id: "call_b2", name: "get_transactions", args: { category: "Fuel" } },
    ]),
    finalTurn("Groceries and fuel, then."),
  ]);
  const impl = { get_transactions: async ({ category }) => [{ category }] };

  const out = await runAskLoop({ question: "Groceries vs fuel?", generate, impl });

  assert.equal(out.answer, "Groceries and fuel, then.");
  const second = generate.calls[1];
  assert.deepEqual(second[2], {
    role: "user",
    parts: [{ functionResponse: {
      id: "call_a1",
      name: "get_transactions",
      response: { result: JSON.stringify([{ category: "Groceries" }]) },
    } }],
  });
  assert.deepEqual(second[3], {
    role: "user",
    parts: [{ functionResponse: {
      id: "call_b2",
      name: "get_transactions",
      response: { result: JSON.stringify([{ category: "Fuel" }]) },
    } }],
  });
});

// The other half of the contract: gemini-2.5-flash doesn't populate call ids.
// JSON.stringify would drop an `id: undefined` before it reached the wire, so
// this pins the object shape rather than the payload — the key stays absent,
// which keeps the 2.5 request exactly what works today.
test("a function call without an id produces a functionResponse with no id key at all", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "list_categories", args: {} }]),
    finalTurn("Four categories."),
  ]);
  const impl = { list_categories: async () => [{ id: "c1", name: "Groceries" }] };

  await runAskLoop({ question: "How many categories?", generate, impl });

  const fnResponse = generate.calls[1][2].parts[0].functionResponse;
  assert.equal("id" in fnResponse, false);
  assert.deepEqual(Object.keys(fnResponse), ["name", "response"]);
});

// A tool that failed still has to be attributable to the call that failed.
test("the call id is echoed back on an error functionResponse too", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ id: "call_c3", name: "get_transactions", args: {} }]),
    finalTurn("Couldn't read those."),
  ]);
  const impl = { get_transactions: async () => { throw new Error("db exploded"); } };

  await runAskLoop({ question: "What did I buy?", generate, impl });

  assert.deepEqual(generate.calls[1][2].parts[0].functionResponse, {
    id: "call_c3",
    name: "get_transactions",
    response: { result: JSON.stringify({ error: "db exploded" }) },
  });
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

// Thinking is turned down to cut latency, but only where it can be and only
// with the field that generation accepts: 2.5 flash takes thinkingBudget 0,
// 3.x flash takes thinkingLevel, gemini-2.5-pro cannot go below 128 and 400s
// on 0. Because the model comes from ASK_AI_MODEL, sending a field
// unconditionally would turn one env var into a config that fails every
// request — the guard is what stops that, so it gets a test of its own.
test("the resolved model decides thinking: default turns it down, ASK_AI_MODEL is honoured", (t) => {
  const original = process.env.ASK_AI_MODEL;
  t.after(() => {
    if (original === undefined) delete process.env.ASK_AI_MODEL;
    else process.env.ASK_AI_MODEL = original;
  });

  delete process.env.ASK_AI_MODEL;
  assert.equal(resolveAskModel(), "gemini-3.7-flash");
  assert.deepEqual(thinkingConfigFor(resolveAskModel()), { thinkingConfig: { thinkingLevel: "LOW" } });

  process.env.ASK_AI_MODEL = "gemini-2.5-pro";
  assert.equal(resolveAskModel(), "gemini-2.5-pro");
  assert.deepEqual(thinkingConfigFor(resolveAskModel()), {});
});

// ASK_AI_MODEL is the rollback path: the default tracks the current-generation
// flash model, and pinning the previous one is how a bad default gets undone
// without a deploy. If the env var ever stopped overriding, that path is gone.
test("ASK_AI_MODEL pins the previous generation as a rollback from the default", (t) => {
  const original = process.env.ASK_AI_MODEL;
  t.after(() => {
    if (original === undefined) delete process.env.ASK_AI_MODEL;
    else process.env.ASK_AI_MODEL = original;
  });

  process.env.ASK_AI_MODEL = "gemini-2.5-flash";
  assert.equal(resolveAskModel(), "gemini-2.5-flash");
  assert.deepEqual(thinkingConfigFor(resolveAskModel()), { thinkingConfig: { thinkingBudget: 0 } });
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

// Gemini 3 replaced thinkingBudget with thinkingLevel, so the 2.5 tier must
// keep getting the budget and only the budget — a stray thinkingLevel here
// would be as wrong as a stray thinkingBudget on 3.x.
test("thinkingConfigFor: the 2.5 flash tier carries thinkingBudget and no thinkingLevel", () => {
  for (const model of [
    "gemini-2.5-flash", "gemini-2.5-flash-lite",
    "gemini-2.5-flash-preview-09-2025", "gemini-2.5-flash-lite-preview-06-17",
  ]) {
    const { thinkingConfig } = thinkingConfigFor(model);
    assert.equal(thinkingConfig.thinkingBudget, 0, `${model} must disable thinking`);
    assert.equal("thinkingLevel" in thinkingConfig, false, `${model} must carry no thinkingLevel`);
  }
});

// The 3.x flash tier takes thinkingLevel instead, and LOW is the floor:
// gemini-3.7-flash rejects MINIMAL at request validation, so thinking can be
// turned down on 3.x but never switched off.
test("thinkingConfigFor: the 3.x flash tier carries thinkingLevel LOW and no thinkingBudget", () => {
  for (const model of [
    "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.7-flash-lite",
    "gemini-3.9-flash-preview-11-2026",
  ]) {
    const { thinkingConfig } = thinkingConfigFor(model);
    assert.equal(thinkingConfig.thinkingLevel, "LOW", `${model} must ask for low thinking`);
    assert.notEqual(thinkingConfig.thinkingLevel, "MINIMAL", `${model} rejects minimal`);
    assert.equal("thinkingBudget" in thinkingConfig, false, `${model} must carry no thinkingBudget`);
  }
});

// The SDK declares this enum name twice and only one spelling belongs to our
// path: generateContent's ThinkingConfig.thinkingLevel is the UPPERCASE enum
// (ThinkingLevel.LOW === "LOW"), while the lowercase "low" belongs to
// GenerationConfig_2.thinking_level on the agent/streaming surface. Casing is
// the kind of thing that survives a diff review unnoticed, so it gets an
// assertion that fails the moment someone lowercases it.
test("thinkingConfigFor: the 3.x thinkingLevel is the SDK's uppercase enum value, not the lowercase one", () => {
  const { thinkingConfig } = thinkingConfigFor("gemini-3.7-flash");
  assert.equal(thinkingConfig.thinkingLevel, "LOW");
  assert.notEqual(thinkingConfig.thinkingLevel, "low");
  assert.equal(thinkingConfig.thinkingLevel, thinkingConfig.thinkingLevel.toUpperCase());
});

// The two fields are mutually exclusive — a request setting both is an error
// on Gemini 3 — so no input, recognised or not, may ever produce both.
test("thinkingConfigFor: never emits thinkingBudget and thinkingLevel together", () => {
  const models = [
    "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-preview-09-2025",
    "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.7-flash-lite",
    "gemini-3.7-pro", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash",
    "gemini-3-flash", "some-other-model", "", undefined, null,
  ];
  for (const model of models) {
    const { thinkingConfig } = thinkingConfigFor(model);
    if (!thinkingConfig) continue; // no config at all: trivially not both
    assert.equal(
      "thinkingBudget" in thinkingConfig && "thinkingLevel" in thinkingConfig, false,
      `${model} must not set both thinking fields`
    );
  }
});

// Pro is pro whatever the generation: a 3.x pro model must not inherit the
// 3.x flash branch's thinkingLevel.
test("thinkingConfigFor: pro models carry no thinkingConfig in either generation", () => {
  for (const model of ["gemini-3.7-pro", "gemini-2.5-pro"]) {
    const config = thinkingConfigFor(model);
    assert.equal("thinkingConfig" in config, false, `${model} must carry no thinkingConfig`);
    assert.deepEqual(config, {});
  }
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
