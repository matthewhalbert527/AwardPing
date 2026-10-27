// Offline derivation, SQL AST and pure-reference regression tests. No DB client
// or operational fixture is imported or executed by the normal test runner.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { syntheticPublisherJsonObservation } from "../fixtures/program-text-publisher-json.mjs";
import { projectSmartPublisherJson } from "./program-text-smart-publisher-json.mjs";
import { SMART_KB_PUBLISHER_SOURCE_PROFILES } from "./program-text-smart-kb-publisher-json.mjs";
import { buildProgramTextCapture, programTextPublisherJsonSourceProfile } from "./program-text-capture-contract.mjs";
import { publisherJsonObservationMetadata } from "./program-text-publisher-json.mjs";
import { programTextReference, validateProgramTextReference } from "./program-text-artifacts.mjs";

const release = new URL("../../", import.meta.url), migrations = new URL("supabase/migrations/", release);
const require = createRequire(new URL("package.json", release));
const { parse } = require("libpg-query");
const sha = value => createHash("sha256").update(value).digest("hex");
const read = name => readFileSync(new URL(name, migrations), "utf8").replaceAll("\r\n", "\n");
const candidates = readdirSync(migrations).filter(name => /^\d{14}_program_text_smart_six_initial_coverage\.sql$/.test(name));
assert.equal(candidates.length, 1, "Exactly one applied finite-six successor is required");
const sql = read(candidates[0]), prior = read("20261027050254_program_text_smart_publisher_json.sql");
const unquote = value => value.replaceAll("''", "'");
function body(source, qualifiedName) {
  const start = source.toLowerCase().indexOf("function " + qualifiedName.toLowerCase() + "("); assert.ok(start >= 0, qualifiedName);
  const tail = source.slice(start), marker = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(tail); assert.ok(marker);
  const at = marker.index + marker[0].length, end = tail.indexOf(marker[1], at); assert.ok(end > at);
  return tail.slice(at, end);
}
function guard(source, name) {
  const start = source.indexOf("do $" + name + "$"); assert.ok(start >= 0, name);
  const end = source.indexOf("end $" + name + "$;", start); assert.ok(end > start);
  return source.slice(start, end);
}
function jsonEdits(source) {
  const match = /jsonb_array_elements\('((?:''|[^'])*)'::jsonb\)/.exec(source); assert.ok(match);
  return JSON.parse(unquote(match[1]));
}
function applyEdits(original, edits) {
  let next = original;
  for (const edit of edits) { assert.equal(next.split(edit.needle).length, 2, "Unique exact insertion point"); next = next.replace(edit.needle, () => edit.replacement); }
  return next;
}
const metadataBefore = body(prior, "private.awardping_smart_publisher_json_reference_metadata_valid");
const transitionBefore = body(prior, "public.transition_known_smart_html_shell");
const referenceBase = body(read("20261026231050_program_text_public_drive_pdf.sql"), "private.awardping_program_text_reference_valid");
const referenceBefore = applyEdits(referenceBase, jsonEdits(guard(prior, "guard_0")));
const referenceEdit = /next_body:=replace\(prior_body,'((?:''|[^'])*)','((?:''|[^'])*)'\);/.exec(guard(sql, "smart_six_guard_2"));
assert.ok(referenceEdit);
const changes = [
  { name: "metadata", original: metadataBefore, edits: jsonEdits(guard(sql, "smart_six_guard_0")), preimage: "9946936b031678bb7407ddd099ef8f04ae2201099ec91863de49c537d7bdc5a7", postimage: "c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4" },
  { name: "transition", original: transitionBefore, edits: jsonEdits(guard(sql, "smart_six_guard_1")), preimage: "86035c4977d4150af5e0b87936c45f3f00ca93855b746425f7648157576a37ff", postimage: "6fe6fbf76282405cf732f0621868fd5c7a5324c2bbe01a40a9f41daa26e72d4d" },
  { name: "reference", original: referenceBefore, edits: [{ needle: unquote(referenceEdit[1]), replacement: unquote(referenceEdit[2]) }], preimage: "f64a4a4dd53df2e02026a46603f709768ea2ebadcca3483dd69b8d2c48a528a2", postimage: "72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027" },
].map(change => ({ ...change, next: applyEdits(change.original, change.edits) }));
const metadata = changes[0].next, rpc = changes[1].next, reference = changes[2].next;
const oldIds = ["58aefec0-0d42-4b7b-9887-60d25940b3d0", "c33cc2f4-2cbd-458c-b630-537eb3d50f72"];
const aliasId = "92eebc07-7392-4136-ba13-d9cd5455c8f9", owner = "d7d4d117-f312-456f-a75c-3dbd5d372c99", aliasOwner = "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108";

test("finite successor parses as three guarded function-body edits plus schema notification", async () => {
  const ast = await parse(sql); assert.equal(ast.stmts.length, 4);
  assert.deepEqual(ast.stmts.map(item => Object.keys(item.stmt)[0]), ["DoStmt", "DoStmt", "DoStmt", "NotifyStmt"]);
  assert.equal(sha(sql), "8ba67f1a0178aba034b60f7b9b5206fbd59a8a7c68fe1bbcdd4779791ff688af");
});
for (const change of changes) test(`${change.name}: complete reviewed pre/post body hashes and unique reversible changes`, () => {
  assert.equal(sha(change.original), change.preimage); assert.equal(sha(change.next), change.postimage); assert.ok(sql.includes(change.preimage));
  let reversed = change.next;
  for (const edit of [...change.edits].reverse()) { assert.equal(reversed.split(edit.replacement).length, 2); reversed = reversed.replace(edit.replacement, () => edit.needle); }
  assert.equal(reversed, change.original);
});
test("new metadata SQL expression parses independently; the original two-source branch stays literal", async () => {
  assert.equal((await parse(metadata)).stmts.length, 1);
  const oldBranch = metadataBefore.slice(0, metadataBefore.indexOf(changes[0].edits[0].needle) + 2);
  assert.ok(metadata.startsWith(oldBranch));
});
test("metadata tuple identities equal the exact four production projection profiles", () => {
  const rows = [...metadata.matchAll(/\('([^']+)','([^']+)','([^']+)','([^']+)','([^']+)'\)/g)].map(match => match.slice(1));
  const { source: alias } = syntheticPublisherJsonObservation("home_alias");
  const expected = [...SMART_KB_PUBLISHER_SOURCE_PROFILES.map(p => [p.id, p.shared_award_id, p.url, p.page_type, p.version]), [alias.id, alias.shared_award_id, alias.url, alias.page_type, "smart-publisher-json-v1"]];
  assert.deepEqual(rows, expected); assert.equal(new Set(rows.map(row => row[0])).size, 4);
  assert.equal(rows.find(row => row[0] === "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5")[3], "deadline");
});
test("metadata admission retains acquisition/name/final URL and all five exact tuple comparisons", () => {
  for (const fragment of ["p_ref->>'acquisition'='publisher_json'", "p_ref#>>'{extractor,name}'='smart-publisher-json'", "p_ref->>'final_url'=p_ref#>>'{source,url}'", "'{source,id}'=reviewed.id", "'{source,shared_award_id}'=reviewed.owner_id", "'{source,url}'=reviewed.url", "'{source,page_type}'=reviewed.page_type", "'{extractor,version}'=reviewed.version"]) assert.ok(metadata.includes(fragment), fragment);
  assert.doesNotMatch(metadata, /like |~\*|host\(/i);
});
test("transition admits exactly six UUIDs with explicit alias ownership and membership", () => {
  const allowed = /p_source_id not in \(([^)]+)\)/.exec(rpc)[1];
  const ids = [...allowed.matchAll(/'([a-f0-9-]+)'::uuid/g)].map(match => match[1]);
  assert.deepEqual(ids, [...oldIds, ...SMART_KB_PUBLISHER_SOURCE_PROFILES.map(p => p.id), aliasId]);
  assert.ok(rpc.includes("s.shared_award_id is distinct from (case when s.id in ("));
  assert.ok(rpc.includes("then '" + aliasOwner + "'::uuid else '" + owner + "'::uuid end)"));
  assert.ok(rpc.includes("member.member_kind='alias'"));
});
test("current epoch/authority/roles/owner/type checks and lock order are unchanged", () => {
  for (const fragment of ["pg_advisory_xact_lock", "awardping_program_source_allowed(s.id)", "awardping_program_text_source_access(s.id,'smart',policy_epoch)", "for update", "r#>>'{source,shared_award_id}' is distinct from s.shared_award_id::text", "r#>>'{source,page_type}' is distinct from s.page_type", "p_policy is distinct from 'awardping.smart-publisher-initial-coverage.v1'"]) assert.ok(rpc.includes(fragment), fragment);
  assert.ok(rpc.indexOf("pg_advisory_xact_lock") < rpc.indexOf("select epoch"));
});
test("entire identity-to-end suffix preserves exact CAS, retained document, idempotence and timing", () => {
  const at = transitionBefore.indexOf(" identity:="); assert.ok(at >= 0);
  assert.equal(rpc.slice(rpc.indexOf(" identity:=")), transitionBefore.slice(at));
  for (const fragment of ["s.text_monitoring_state is distinct from prior.next_state", "old_ref is distinct from p_expected_state->'latest_ref'", "awardping_program_fact_known_html_shell(old_ref) is distinct from true", "awardping_program_source_approval_document_valid(p_document) is distinct from true", "get diagnostics changed=row_count", "changed<>1 then raise exception"]) assert.ok(rpc.includes(fragment), fragment);
});
test("every unresolved legacy/current/failed comparison still blocks before any journal insertion", () => {
  const at = rpc.indexOf("if exists(select 1 from public.shared_award_visual_review_candidates"); assert.ok(at >= 0);
  const unresolved = rpc.slice(at, rpc.indexOf("then raise exception", at));
  assert.ok(unresolved.includes("candidate.status not in ('superseded','rejected','published')"));
  assert.doesNotMatch(unresolved, /candidate_scope|epoch/);
  assert.ok(at < rpc.indexOf("insert into public.program_text_smart_initial_coverage_journal"));
});
test("migration neither writes source/history nor modifies journal structure, ACLs or triggers", () => {
  assert.doesNotMatch(sql, /create (?:table|trigger|function)|alter table|grant |revoke |delete from|truncate|insert into|update public\./i);
  assert.doesNotMatch(sql, /http_post|pg_cron|publish_program_|ai_result|budget/i);
  for (const index of [0, 1, 2]) { const patch = guard(sql, "smart_six_guard_" + index); assert.ok(patch.includes("pg_catalog.pg_get_functiondef")); assert.ok(patch.includes("execute replace(definition,prior_body,next_body)")); }
});
test("reserved KB version is the only reference edit; strict original path/MIME/size/Drive guards survive", () => {
  assert.equal(changes[2].edits.length, 1);
  assert.deepEqual(changes[2].edits[0], { needle: "p_ref#>>'{extractor,version}'='smart-publisher-json-v1'", replacement: "p_ref#>>'{extractor,version}' in ('smart-publisher-json-v1','smart-publisher-json-kb-v1')" });
  for (const fragment of ["'original.json'", "v_json then 524288", "v_json then v_artifact->>'content_type'='application/json'", "private.awardping_program_public_drive_pdf_metadata_valid(p_ref)"]) assert.ok(reference.includes(fragment), fragment);
});
for (const key of ["home", "eligibility", "faq", "submit", "instructions", "home_alias"]) test(`${key}: strict typed reference passes; reserved KB-as-HTML fails while ordinary HTML control passes`, () => {
  const { source, observation } = syntheticPublisherJsonObservation(key), projection = projectSmartPublisherJson(observation.raw_json, { source });
  const capture = buildProgramTextCapture({ source, captured_at: observation.captured_at, acquisition: "publisher_json", extractor: { name: "smart-publisher-json", version: programTextPublisherJsonSourceProfile(source).version }, raw_bytes: Buffer.from(observation.raw_json), content_type: "application/json", text: projection.text, blocks: projection.blocks, publisher_json: { observation: publisherJsonObservationMetadata(observation, { source }), projection: projection.provenance } });
  const ref = programTextReference(capture); assert.equal(validateProgramTextReference(ref), ref);
  const forged = structuredClone(ref); forged.acquisition = "http_html"; forged.extractor = { name: "synthetic-generic-html", version: "smart-publisher-json-kb-v1" };
  forged.artifacts.raw.object_key = forged.artifacts.raw.object_key.replace("original.json", "original.html"); forged.artifacts.raw.content_type = "text/html";
  const control = structuredClone(forged); control.extractor.version = "synthetic-generic-html-v1";
  assert.equal(validateProgramTextReference(control), control);
  assert.throws(() => validateProgramTextReference(forged), /invalid_publisher_json_reference/);
});
