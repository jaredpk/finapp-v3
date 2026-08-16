import test from "node:test";
import assert from "node:assert/strict";
import {
  runAskLoop, truncateJson, MAX_RESULT_CHARS, resolveMaxResultChars,
  functionDeclarations, reportSummaryArgs,
  resolveAskModel, thinkingConfigFor, ASK_DEADLINE_MS,
} from "../askAi.js";
// The route pairs the loop with this on both paths — the success one and, since
// a throw loses everything otherwise, the catch. See the throw tests below.
import { recordGeminiCall } from "../geminiUsage.js";

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

// Replaces "tool results over 50k chars are truncated with a marker", which
// asserted the behaviour that caused the bug: it pinned the result to
// MAX_RESULT_CHARS + "(truncated)" and required it to START with the payload's
// own bytes. Both expectations are now wrong on purpose — an oversized result
// yields no payload bytes at all — so the test asserts the refusal instead of
// the slice. (The payload also had to grow: 60k is under the new 100k ceiling.)
test("a tool result over the limit reaches the model as a refusal, not a slice of the data", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "get_transactions", args: {} }]),
    finalTurn("That was too much to read at once."),
  ]);
  const impl = { get_transactions: async () => ({ data: "x".repeat(120_000) }) };

  const out = await runAskLoop({ question: "Everything, please", generate, impl });

  assert.equal(out.answer, "That was too much to read at once.");
  const { result } = generate.calls[1][2].parts[0].functionResponse.response;
  // What the model actually receives must be parseable — the old sliced string
  // was cut mid-token and was not.
  const parsed = JSON.parse(result);
  assert.equal(parsed.error, "RESULT_TOO_LARGE");
  assert.equal(result.includes("(truncated)"), false);
  assert.equal(result.includes("xxx"), false);
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

// ── Oversized tool results ────────────────────────────────────────────────────
// The bug this encodes: an 8-month get_report_summary serialized past the old
// 50k ceiling, the string was sliced, and because buildReportSummary emits
// months oldest-first the slice removed the most RECENT ones. The model saw no
// August and reported August as $0.00 rather than as missing — a confidently
// formatted wrong answer with no signal. So a result that doesn't fit now
// carries no data whatsoever: partial aggregates are worse than none, because
// every month that survives the cut still looks complete and correct.

test("truncateJson returns the JSON string untouched when it fits, whatever its size", () => {
  const value = { rows: Array.from({ length: 200 }, (_, i) => ({ month: `2026-${i}`, spend: i })) };
  const json = JSON.stringify(value);
  // Exactly at the limit is "fits": the comparison is on length > maxChars.
  assert.equal(truncateJson(value, json.length), json);
  assert.equal(truncateJson(value, json.length + 1), json);
  assert.equal(truncateJson(value, MAX_RESULT_CHARS), json);
});

test("truncateJson refuses an oversized value with a structured error and none of the data", () => {
  const secret = "MERCHANT_NAME_THAT_MUST_NOT_LEAK";
  const value = { rows: Array.from({ length: 500 }, () => ({ merchant: secret })) };
  const json = JSON.stringify(value);

  const out = truncateJson(value, 100);

  // Valid JSON, and the shape the system prompt tells the model to act on.
  const parsed = JSON.parse(out);
  assert.equal(parsed.error, "RESULT_TOO_LARGE");
  assert.equal(typeof parsed.message, "string");
  assert.deepEqual(Object.keys(parsed), ["error", "message"]);

  // No fragment of the original payload survives — not the data, not the
  // marker, not even a truncated prefix of the first row.
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes("merchant"), false);
  assert.equal(out.includes("(truncated)"), false);
  assert.equal(out.includes(json.slice(0, 20)), false);
  assert.ok(out.length < json.length);
});

// "Too big" on its own tells the model nothing about how much narrower to go.
test("the refusal names both the actual size and the limit, and says not to read absence as zero", () => {
  const value = { rows: Array.from({ length: 500 }, (_, i) => ({ i })) };
  const size = JSON.stringify(value).length;

  const { message } = JSON.parse(truncateJson(value, 100));

  assert.ok(message.includes(String(size)), `message should name the actual size ${size}: ${message}`);
  assert.ok(message.includes("100"), `message should name the limit: ${message}`);
  assert.match(message, /narrow/i);       // what to do about it
  assert.match(message, /category/i);     // the other way out: a filter
  assert.match(message, /zero/i);         // and the inference it must not make
});

// ── The result ceiling ────────────────────────────────────────────────────────
// 50k → 100k because gemini-3.7-flash has a 1M-token context and 50k was very
// conservative — but deliberately NOT higher: each tool result stays in
// `contents` and is re-sent on every later round-trip, so its token cost is
// multiplied by up to MAX_ITERATIONS.
test("the default result ceiling is 100k chars", () => {
  assert.equal(MAX_RESULT_CHARS, 100_000);
});

test("ASK_MAX_RESULT_CHARS overrides the ceiling and truncateJson honours it per call", (t) => {
  const original = process.env.ASK_MAX_RESULT_CHARS;
  t.after(() => {
    if (original === undefined) delete process.env.ASK_MAX_RESULT_CHARS;
    else process.env.ASK_MAX_RESULT_CHARS = original;
  });

  process.env.ASK_MAX_RESULT_CHARS = "20";
  assert.equal(resolveMaxResultChars(), 20);
  // Read at call time, not at import: the value below is 29 chars of JSON.
  assert.equal(JSON.parse(truncateJson({ hello: "world-world-world" })).error, "RESULT_TOO_LARGE");

  process.env.ASK_MAX_RESULT_CHARS = "500000";
  assert.equal(resolveMaxResultChars(), 500_000);
  assert.equal(truncateJson({ hello: "world-world-world" }), '{"hello":"world-world-world"}');
});

// A NaN ceiling is the dangerous parse: every `length <= NaN` is false, so the
// limit would refuse everything — and a zero or negative one would too. All of
// them mean "not configured" and take the default instead.
test("junk ASK_MAX_RESULT_CHARS values fall back to the default, never NaN", (t) => {
  const original = process.env.ASK_MAX_RESULT_CHARS;
  t.after(() => {
    if (original === undefined) delete process.env.ASK_MAX_RESULT_CHARS;
    else process.env.ASK_MAX_RESULT_CHARS = original;
  });

  for (const raw of ["", "   ", "abc", "-1", "0", "1e", "NaN"]) {
    process.env.ASK_MAX_RESULT_CHARS = raw;
    const resolved = resolveMaxResultChars();
    assert.equal(resolved, MAX_RESULT_CHARS, `${JSON.stringify(raw)} must fall back to the default`);
    assert.ok(Number.isFinite(resolved), `${JSON.stringify(raw)} must not resolve to NaN`);
    // And the fallback is live: a small value still serializes through.
    assert.equal(truncateJson({ a: 1 }), '{"a":1}');
  }

  delete process.env.ASK_MAX_RESULT_CHARS;
  assert.equal(resolveMaxResultChars(), MAX_RESULT_CHARS);
});

// ── get_report_summary's category filter ──────────────────────────────────────
// The argument mapping is the half that can be tested without a database:
// `category` has to reach getReportSummary under its db.js name, and the date
// defaults have to keep applying when the model omits them.
test("reportSummaryArgs threads the category through and defaults the dates", () => {
  const withCategory = reportSummaryArgs({
    start_date: "2026-01-01", end_date: "2026-08-31", category: "Personal - Jared",
  });
  assert.deepEqual(withCategory, {
    startDate: "2026-01-01", endDate: "2026-08-31", category: "Personal - Jared",
  });

  // Omitted entirely: the filter is optional, and its absence is what keeps
  // GET /api/reports/summary's unfiltered behaviour intact.
  const noCategory = reportSummaryArgs({ start_date: "2026-01-01", end_date: "2026-08-31" });
  assert.equal(noCategory.category, undefined);

  // No dates: the 6-month default range still applies, with the category kept.
  const defaulted = reportSummaryArgs({ category: "Personal - Jared" });
  assert.match(defaulted.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(defaulted.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(defaulted.startDate < defaulted.endDate);
  assert.equal(defaulted.category, "Personal - Jared");

  // Called with nothing at all (the model can send `args: {}`).
  assert.equal(reportSummaryArgs().category, undefined);
  assert.match(reportSummaryArgs().startDate, /^\d{4}-\d{2}-\d{2}$/);
});

// The declaration is what the model reads; an optional filter it can't see is
// no filter at all.
test("get_report_summary declares the optional category parameter", () => {
  const decl = functionDeclarations.find((d) => d.name === "get_report_summary");
  assert.equal(decl.parameters.properties.category.type, "STRING");
  // Optional: nothing on this tool is required, so an unfiltered call stays legal.
  assert.equal("required" in decl.parameters, false);
});

// The two taxonomies are invisible in the data, so the descriptions are the
// only place the model can learn they are different namespaces.
test("the category-bearing tools say which taxonomy they speak", () => {
  const byName = Object.fromEntries(functionDeclarations.map((d) => [d.name, d.description]));
  assert.match(byName.get_transactions, /PLAID/);
  assert.match(byName.get_spending_by_category, /PLAID/);
  assert.match(byName.list_categories, /BUDGET/);
  assert.match(byName.get_report_summary, /BUDGET/);
  // And the pending inconsistency, which nothing else exposes.
  assert.match(byName.get_transactions, /INCLUDES pending/);
  assert.match(byName.get_spending_by_category, /[Ee]xcludes pending/);
  assert.match(byName.get_report_summary, /[Ee]xcludes pending/);
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

// ── Token accounting ──────────────────────────────────────────────────────────
// A question costs one bill across up to MAX_ITERATIONS round-trips, and each
// one re-sends the whole conversation so far, so the later calls are the
// expensive ones. Anything less than the sum under-reports the month.
// usageMetadata field names verified against dist/genai.d.ts on 2.16.0.
const withUsage = (turn, usageMetadata) => ({ ...turn, usageMetadata });

test("runAskLoop sums usageMetadata across every iteration", async () => {
  const generate = scriptedGenerate([
    withUsage(modelTurn([{ name: "list_categories", args: {} }]), {
      promptTokenCount: 1000, candidatesTokenCount: 20, totalTokenCount: 1020,
    }),
    withUsage(modelTurn([{ name: "get_latest_balances", args: {} }]), {
      promptTokenCount: 1500, candidatesTokenCount: 30, cachedContentTokenCount: 800,
      totalTokenCount: 1530,
    }),
    withUsage(finalTurn("Four categories and $100."), {
      promptTokenCount: 2000, candidatesTokenCount: 40, thoughtsTokenCount: 60,
      totalTokenCount: 2100,
    }),
  ]);
  const impl = { list_categories: async () => [], get_latest_balances: async () => [] };

  const out = await runAskLoop({ question: "Anything?", generate, impl });

  assert.equal(out.answer, "Four categories and $100.");
  assert.deepEqual(out.usage, {
    promptTokens: 4500,
    // 20 + 30 + 40 candidates, plus the 60 thinking tokens: Gemini bills those
    // at the output rate and 3.x can't switch thinking off, so leaving them out
    // would under-report every call the default model makes.
    outputTokens: 150,
    cachedTokens: 800,
    totalTokens: 4650,
  });
});

// The existing suite's fakes carry no usageMetadata at all, and neither would a
// future SDK that dropped the field. Zeros are the honest answer there — a
// scripted fake cost nothing — and they must not be NaN, which would poison
// every SUM taken over the usage table afterwards.
test("runAskLoop returns zero usage when the response carries no usageMetadata", async () => {
  const generate = scriptedGenerate([
    modelTurn([{ name: "list_categories", args: {} }]),
    finalTurn("Four categories."),
  ]);
  const impl = { list_categories: async () => [{ id: "c1", name: "Groceries" }] };

  const out = await runAskLoop({ question: "How many categories?", generate, impl });

  assert.equal(out.answer, "Four categories."); // unchanged: usage is additive
  assert.deepEqual(out.usage, {
    promptTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0,
  });
  for (const v of Object.values(out.usage)) assert.ok(Number.isFinite(v));
});

// A run that gave up still spent what it spent, and those are the runs most
// worth accounting for — the iteration cap and the deadline are both hit by
// expensive questions.
test("runAskLoop reports the usage accumulated before it hit the iteration cap", async () => {
  const generate = async () =>
    withUsage(modelTurn([{ name: "get_latest_balances", args: {} }]), {
      promptTokenCount: 500, candidatesTokenCount: 10, totalTokenCount: 510,
    });
  const impl = { get_latest_balances: async () => [] };

  const out = await runAskLoop({ question: "Loop forever", generate, impl, maxIterations: 3 });

  assert.equal(out.answer, "I couldn't finish answering that — try a narrower question.");
  assert.deepEqual(out.usage, {
    promptTokens: 1500, outputTokens: 30, cachedTokens: 0, totalTokens: 1530,
  });
});

test("runAskLoop reports the usage of the in-flight call when the deadline stops it", async () => {
  const generate = async () =>
    withUsage(modelTurn([{ name: "get_latest_balances", args: {} }]), {
      promptTokenCount: 700, candidatesTokenCount: 15, totalTokenCount: 715,
    });
  const impl = { get_latest_balances: async () => [] };
  const now = scriptedClock([0, 1_000, 1_000 + ASK_DEADLINE_MS]);

  const out = await runAskLoop({ question: "Something slow", generate, impl, now });

  assert.equal(out.answer, "That took too long to answer — try a narrower question.");
  // Exactly one round-trip happened before the deadline bit, and it is billed.
  assert.deepEqual(out.usage, {
    promptTokens: 700, outputTokens: 15, cachedTokens: 0, totalTokens: 715,
  });
});

// ── Usage when the loop THROWS ────────────────────────────────────────────────
// The one exit that can't return a value, and the one where the tokens are
// biggest: a question that dies on its third round-trip has already paid for
// two, each re-sending the whole conversation. POST /api/ask only records on
// its success path, so before the loop attached its running total to the error
// every one of those calls went unaccounted — a budget guard under-reporting
// exactly when spending spiked, on the failure its own comment calls expected
// ("free-tier 429s are expected under bursts"). recordGeminiCall is imported
// here rather than left to a route test because the contract has two halves —
// the loop attaching `usage`, the catch recording it — and neither is worth
// much alone.
const rateLimited = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });

// Two full round-trips, then the 429. The counts are the reproduction's:
// 100k prompt (a re-sent conversation) + 1k output per call.
const BILLED_TURN = { promptTokenCount: 100_000, candidatesTokenCount: 1_000, totalTokenCount: 101_000 };
function generateThenThrow(billedCalls) {
  const fn = async () => {
    if (fn.calls++ >= billedCalls) throw rateLimited();
    return withUsage(modelTurn([{ name: "get_latest_balances", args: {} }]), BILLED_TURN);
  };
  fn.calls = 0;
  return fn;
}

test("a throw mid-loop still carries the usage spent before it, and reaches the caller unchanged", async () => {
  const generate = generateThenThrow(2);
  const impl = { get_latest_balances: async () => [] };

  let thrown;
  await assert.rejects(
    runAskLoop({ question: "Everything, in detail", generate, impl }),
    (err) => { thrown = err; return true; }
  );

  // The SAME error object, not a wrapper: the route branches on err.status to
  // answer 429 rather than 502, so rewrapping would turn every rate limit into
  // a gateway error.
  assert.equal(thrown.status, 429);
  assert.equal(thrown.message, "429 Too Many Requests");
  assert.ok(thrown instanceof Error);
  // And the two calls that were billed before it are summed, not lost.
  assert.deepEqual(thrown.usage, {
    promptTokens: 200_000, outputTokens: 2_000, cachedTokens: 0, totalTokens: 202_000,
  });
  assert.equal(generate.calls, 3); // two billed, one that threw
});

test("what a mid-loop throw carries is what the route records: the pre-throw tokens, priced", async () => {
  const impl = { get_latest_balances: async () => [] };
  const rows = [];
  const record = async (row) => { rows.push(row); };
  // Exactly what POST /api/ask's catch does with it, including the guard that
  // keeps a call that never billed out of the table.
  const recordLikeTheRoute = async (err) => {
    if (err?.usage?.totalTokens > 0) {
      await recordGeminiCall({
        feature: "ask_ai", model: "gemini-3.7-flash", usage: err.usage,
        now: () => Date.parse("2026-08-16T12:00:00Z"), record,
      });
    }
  };

  // try/catch rather than assert.rejects: a validator handed to assert.rejects
  // is not awaited, so an async one would race the assertions below.
  const runAndRecord = async (billedCalls) => {
    let threw = false;
    try {
      await runAskLoop({ question: "Everything, in detail", generate: generateThenThrow(billedCalls), impl });
    } catch (err) {
      threw = true;
      await recordLikeTheRoute(err);
    }
    assert.ok(threw, "the loop must have thrown");
  };

  await runAndRecord(2);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].feature, "ask_ai");
  assert.equal(rows[0].promptTokens, 200_000);
  assert.equal(rows[0].outputTokens, 2_000);
  assert.equal(rows[0].totalTokens, 202_000);
  // 200k in + 2k out at gemini-3.7-flash's intro rates ($0.75/$3.75 per 1M).
  assert.equal(rows[0].estimatedCostUsd, 0.1575);
  assert.equal(rows[0].priced, "exact");

  // A 429 on the very first round-trip billed nothing, and a zero row would
  // only inflate the card's call count.
  await runAndRecord(0);
  assert.equal(rows.length, 1);
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
