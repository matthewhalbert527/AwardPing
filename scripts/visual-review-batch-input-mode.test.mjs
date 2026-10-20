import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { batchInputModeForRequests } from "./lib/gemini-batch-support.mjs";

// Parse the worker without importing its main, configuration or service client.
const source = readFileSync(new URL("./process-visual-review-batch.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("process-visual-review-batch.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function descendants(node, predicate) {
  const found = [];
  function visit(value) { if (predicate(value)) found.push(value); ts.forEachChild(value, visit); }
  visit(node); return found;
}
function namedFunction(name) {
  const nodes = descendants(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(nodes.length, 1, `exact worker function ${name}`); return nodes[0];
}
const submit = namedFunction("submitCandidateChunk");
const modeNodes = descendants(submit, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "mode");
assert.equal(modeNodes.length, 1, "one mode decision per submitted chunk");
const modeDeclaration = modeNodes[0];
const modeStatement = modeDeclaration.parent.parent;
assert.ok(ts.isVariableStatement(modeStatement));
const chooseWorkerMode = new Function("requests", "inlineThreshold", "batchInputModeForRequests", `${modeStatement.getText(ast)}\nreturn mode;`);
const choose = (requests, inlineThreshold = 100) => chooseWorkerMode(requests, inlineThreshold, batchInputModeForRequests);
const defaultCap = 14 * 1024 * 1024;
const envelopeBytes = requests => Buffer.byteLength(JSON.stringify({ batch: { inputConfig: { requests: { requests } } } }), "utf8");
const request = text => ({ request: { contents: [{ role: "user", parts: [{ text }] }] }, metadata: { key: "synthetic" } });
function exactEnvelope(bytes) {
  const requests = [request("")], overhead = envelopeBytes(requests);
  assert.ok(bytes >= overhead); requests[0].request.contents[0].parts[0].text = "a".repeat(bytes - overhead);
  assert.equal(envelopeBytes(requests), bytes); return requests;
}

test("actual worker imports and executes the existing byte-aware helper exactly once", () => {
  const imports = ast.statements.filter(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "./lib/gemini-batch-support.mjs");
  assert.equal(imports.length, 1);
  assert.ok(imports[0].importClause.namedBindings.elements.some(node => node.name.text === "batchInputModeForRequests" && !node.propertyName));
  const initializer = modeDeclaration.initializer;
  assert.ok(ts.isCallExpression(initializer)); assert.equal(initializer.expression.getText(ast), "batchInputModeForRequests");
  assert.deepEqual(initializer.arguments.map(node => node.getText(ast)), ["requests", "{ inlineThreshold }"]);
  const requests = [request("small")]; let calls = 0;
  const result = chooseWorkerMode(requests, 7, (actual, options) => { calls++; assert.equal(actual, requests); assert.deepEqual(options, { inlineThreshold: 7 }); return batchInputModeForRequests(actual, options); });
  assert.equal(result, "inline"); assert.equal(calls, 1);
});
for (const [offset, expected] of [[-1, "inline"], [0, "inline"], [1, "jsonl_file"]]) {
  test(`actual assignment honors the default 14 MiB envelope boundary ${offset >= 0 ? "+" : ""}${offset}`, () => {
    const requests = exactEnvelope(defaultCap + offset);
    assert.equal(requests.length, 1); assert.equal(choose(requests), expected);
  });
}
test("UTF-8 bytes, not JavaScript character count, select the file path", () => {
  const requests = exactEnvelope(defaultCap), part = requests[0].request.contents[0].parts[0];
  part.text = part.text.slice(0, -256) + "😀".repeat(128);
  assert.equal(JSON.stringify({ batch: { inputConfig: { requests: { requests } } } }).length, defaultCap);
  assert.equal(envelopeBytes(requests), defaultCap + 256); assert.equal(choose(requests), "jsonl_file");
});
test("multiple large inline images choose JSONL despite a low request count", () => {
  const requests = [0, 1].map(index => ({ request: { contents: [{ parts: [{ inlineData: { mimeType: "image/jpeg", data: "a".repeat(8 * 1024 * 1024) } }] }] }, metadata: { key: `synthetic-${index}` } }));
  assert.ok(requests.length < 100 && envelopeBytes(requests) > defaultCap); assert.equal(choose(requests), "jsonl_file");
});
test("the count threshold still works at and above its boundary", () => {
  assert.equal(choose(Array.from({ length: 100 }, () => request("small"))), "inline");
  assert.equal(choose(Array.from({ length: 101 }, () => request("small"))), "jsonl_file");
  assert.equal(choose([request("one"), request("two")], 1), "jsonl_file");
});
test("empty/default small requests stay inline without mutating their payloads", () => {
  const requests = [request("small")], before = JSON.stringify(requests);
  Object.freeze(requests[0].request.contents[0].parts[0]); Object.freeze(requests[0]); Object.freeze(requests);
  assert.equal(choose([]), "inline"); assert.equal(choose(requests), "inline"); assert.equal(JSON.stringify(requests), before);
});
test("mode is decided before estimation/reservation and remains the same immutable local", () => {
  assert.ok(modeDeclaration.parent.flags & ts.NodeFlags.Const);
  const calls = descendants(submit, ts.isCallExpression);
  for (const name of ["estimateGeminiMaximumBatchRequestsCostUsd", "reserveGeminiSpend", "createGeminiBatchJob", "persistSubmittedClaim"]) {
    const matches = calls.filter(node => node.expression.getText(ast) === name);
    assert.equal(matches.length, 1, name); assert.ok(modeStatement.getStart(ast) < matches[0].getStart(ast), `decision before ${name}`);
  }
  const assignments = descendants(submit, node => ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === "mode");
  assert.equal(assignments.length, 0, "no mode replacement after claims, reservation, create or ambiguity");
  for (const name of ["createGeminiBatchJob", "persistSubmittedClaim"]) {
    const call = calls.find(node => node.expression.getText(ast) === name);
    const properties = call.arguments[0].properties.filter(node => node.name?.getText(ast) === "mode");
    assert.equal(properties.length, 1); assert.ok(ts.isShorthandPropertyAssignment(properties[0]), `same mode passed to ${name}`);
  }
  assert.match(namedFunction("persistSubmittedClaim").getText(ast), /batch_input_mode: mode/);
});

function providerHarness() {
  const events = [], requestsSent = [];
  let error = null;
  const create = new Function("uploadGeminiJsonlRequests", "runPaidVisualProviderCreateBoundary", "fetchGeminiJson", "geminiBatchUrl",
    `${namedFunction("createGeminiBatchJob").getText(ast)}\nreturn createGeminiBatchJob;`)(
    async value => { events.push("upload"); requestsSent.push(value.requests); return "synthetic-input-file"; },
    async ({ journalCreateStart, authorizeAtProviderBoundary, providerCreate }) => { await journalCreateStart(); await authorizeAtProviderBoundary(); return providerCreate(); },
    async (_url, options) => { events.push(options.kind); requestsSent.push(JSON.parse(options.body)); if (error) throw error; return { name: "synthetic-batch" }; },
    () => "https://synthetic.invalid/not-requested",
  );
  return { create, events, requestsSent, fail(value) { error = value; }, callbacks: { journalCreateStart: async () => { events.push("journal"); }, authorizeAtProviderBoundary: async () => { events.push("authorize"); } } };
}
test("the actual JSONL branch consumes the selected mode and exact original request array", async () => {
  const h = providerHarness(), requests = [request("one"), request("two")], mode = choose(requests, 1);
  const result = await h.create({ model: "synthetic-model", requests, displayName: "synthetic", mode, ...h.callbacks });
  assert.equal(result.name, "synthetic-batch"); assert.equal(h.requestsSent[0], requests);
  assert.deepEqual(h.events, ["upload", "journal", "authorize", "batch_create_file"]);
  assert.deepEqual(h.requestsSent[1].batch.inputConfig, { fileName: "synthetic-input-file" });
});
test("the unchanged small inline branch consumes the same selected mode and payload", async () => {
  const h = providerHarness(), requests = [request("small")];
  await h.create({ model: "synthetic-model", requests, displayName: "synthetic", mode: choose(requests), ...h.callbacks });
  assert.deepEqual(h.events, ["journal", "authorize", "batch_create_inline"]);
  assert.deepEqual(h.requestsSent[0].batch.inputConfig.requests.requests, requests);
});
for (const mode of ["inline", "jsonl_file"]) {
  test(`an ambiguous ${mode} submission never swaps mode or invokes another provider path`, async () => {
    const h = providerHarness(), error = new Error("synthetic unknown submission outcome"); h.fail(error);
    await assert.rejects(h.create({ model: "synthetic-model", requests: [request("small")], displayName: "synthetic", mode, ...h.callbacks }), value => value === error);
    assert.equal(h.events.filter(value => value.startsWith("batch_create_")).length, 1);
    assert.equal(h.events.at(-1), mode === "inline" ? "batch_create_inline" : "batch_create_file");
    assert.equal(h.events.filter(value => value === "upload").length, mode === "inline" ? 0 : 1);
  });
}
