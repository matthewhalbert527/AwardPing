import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { createSyntheticSmartKbPublisherJsonFixture as fixture } from "../fixtures/smart-kb-publisher-json.mjs";
import { createSyntheticSmartKbPlatformBuildFixture as platformFixture } from "../fixtures/smart-kb-platform-build.mjs";
import { syntheticPublisherJsonObservation } from "../fixtures/program-text-publisher-json.mjs";
import { buildProgramTextCapture, validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { publisherJsonObservationMetadata } from "./program-text-publisher-json.mjs";
import { createSyntheticSmartPublisherJsonFixture as oldFixture } from "../fixtures/smart-publisher-json.mjs";
import { projectSmartKbPublisherJson, SMART_KB_PUBLISHER_SOURCE_PROFILES as profiles, SMART_KB_PROJECTOR_VERSION } from "./program-text-smart-kb-publisher-json.mjs";
import { projectSmartPublisherJson, SMART_PUBLISHER_JSON_SOURCE_PROFILES as oldProfiles } from "./program-text-smart-publisher-json.mjs";
const source = key => profiles.find(p => p.key === key);
const article = doc => doc.result.containers[3].rows[0].columns[0].widgets[0].widget;
const encode = JSON.stringify;
const project = (key, doc = fixture(key)) => projectSmartKbPublisherJson(encode(doc), { source: source(key) });
const held = (edit, code, key = "faq") => { const doc = fixture(key); edit(doc); assert.throws(() => project(key, doc), e => e.code?.startsWith("program_text_smart_kb_json_") && (!code || e.code.endsWith(code))); };

for (const key of ["faq", "submit", "instructions"]) test(`${key}: complete reviewed platform build preserves all projected programme content`, () => {
  const legacy = project(key), current = project(key, platformFixture(key));
  // Produced independently by the original accepted edc355e projector.
  const frozen = { faq: "c6d9890b268ed50d8a9744c0d93469b30865f5f849269774191af86c5afc1f99", submit: "cb23a6b7025e2bd60e5fd0b6cfdda7a5b979359411eafa465d027e1483c314d3", instructions: "63248a775970017837fb68263048195abb59393337ea303572c4d87fb2b9ac5e" };
  assert.equal(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"), frozen[key]);
  for (const field of ["text", "blocks", "fields", "source_links"]) assert.deepEqual(current[field], legacy[field]);
  assert.equal(current.provenance.version, SMART_KB_PROJECTOR_VERSION);
});

const menu = doc => doc.result.theme.header.data.menu;
const technicalHelp = doc => doc.result.containers[1].rows[0].columns[0].widgets[0].widget.data.technical_help_widget;
const dependency = widget => widget.dependencies[0].files[0];
for (const key of ["faq", "submit", "instructions"]) test(`${key}: current build cold replay retains exact raw and transport bindings`, () => {
  const { source: identity, observation } = syntheticPublisherJsonObservation(key, { edit(document) {
    const current = platformFixture(key);
    menu(document).dependencies = menu(current).dependencies;
    technicalHelp(document).dependencies = technicalHelp(current).dependencies;
  } });
  const raw = Buffer.from(observation.raw_json), projection = projectSmartKbPublisherJson(raw, { source: identity });
  const capture = buildProgramTextCapture({ source: identity, final_url: observation.navigation.final_url,
    captured_at: observation.captured_at, acquisition: "publisher_json", extractor: { name: "smart-publisher-json", version: SMART_KB_PROJECTOR_VERSION },
    raw_bytes: raw, content_type: "application/json", text: projection.text, blocks: projection.blocks,
    publisher_json: { observation: publisherJsonObservationMetadata(observation, { source: identity }), projection: projection.provenance } });
  assert.equal(validateProgramTextCapture(capture, { source: identity }), capture);
  assert.equal(capture.raw_source.sha256, observation.response.raw_sha256);
});
for (const [name, edit] of [
  ["unobserved menu build", doc => { dependency(menu(doc)).url = "/scripts/angular-truncate.js?v=10-27-2026_0000"; }],
  ["unobserved reCAPTCHA build", doc => { dependency(technicalHelp(doc)).url = "https://www.google.com/recaptcha/api.js?v=10-27-2026_0000"; }],
  ["current menu with legacy reCAPTCHA", doc => { dependency(technicalHelp(doc)).url = "https://www.google.com/recaptcha/api.js?v=10-13-2026_1237"; }],
  ["legacy menu with current reCAPTCHA", doc => { dependency(menu(doc)).url = "/scripts/angular-truncate.js?v=10-13-2026_1237"; }],
  ["dependency host change", doc => { dependency(technicalHelp(doc)).url = "https://example.invalid/recaptcha/api.js?v=10-26-2026_2343"; }],
  ["dependency path change", doc => { dependency(menu(doc)).url = "/scripts/another.js?v=10-26-2026_2343"; }],
  ["dependency module change", doc => { menu(doc).dependencies[0].module = "another"; }],
  ["dependency type change", doc => { dependency(menu(doc)).type = "stylesheet"; }],
  ["controller change", doc => { menu(doc).client_script += "\nfetch('/unreviewed');"; }],
  ["template change", doc => { technicalHelp(doc).template += "<p>Unreviewed</p>"; }],
  ["CSS change", doc => { article(doc).css += " .unreviewed{display:none}"; }],
  ["attachment change", doc => { article(doc).data.attachments.push({ file_name: "Unreviewed.pdf" }); }],
  ["article identity change", doc => { article(doc).data.sys_id = source("submit").article_sys_id; }],
]) test(`reviewed platform build still rejects ${name}`, () => {
  const doc = platformFixture("faq"); edit(doc);
  assert.throws(() => project("faq", doc), error => error.code?.startsWith("program_text_smart_kb_json_"));
});

for (const key of ["faq", "submit", "instructions"]) test(`finite ${key}: deterministic complete text, UTF16 provenance, all links and typed status`, () => {
  const doc = fixture(key), output = project(key, doc);
  assert.deepEqual(output, project(key, doc)); assert.deepEqual(output, projectSmartPublisherJson(encode(doc), { source: source(key) }));
  assert.equal(output.provenance.version, SMART_KB_PROJECTOR_VERSION); assert.equal(output.provenance.article_sys_id, source(key).article_sys_id);
  assert.equal(output.provenance.widget_count, 10); assert.equal(output.provenance.transport_binding_required, true);
  let at = 0;
  for (const b of output.blocks) { assert.equal(output.text.slice(b.start_utf16, b.end_utf16), b.text); assert.equal(output.text.slice(at, b.start_utf16).trim(), ""); assert.equal(b.page, null); at = b.end_utf16; }
  assert.equal(output.text.slice(at).trim(), "");
  const body = output.blocks.filter(b => b.context.representation === "publisher_text").slice(1).map(b => b.text).join("").replace(/\s/gu, "");
  assert.equal(body, load(article(doc).data.text, {}, false).root().text().replace(/\s/gu, ""));
  const expected = load(article(doc).data.text, {}, false)("a[href]").toArray().map(el => el.attribs.href);
  assert.deepEqual(output.source_links.map(x => x.raw_href), expected);
  for (const link of output.source_links) assert.equal(link.resolved_url, new URL(link.raw_href, "https://www.smartscholarship.org/smart").href);
  for (const block of output.blocks.filter(b => b.kind === "source_link")) { assert.equal(block.context.representation, "publisher_attribute"); assert.equal(block.context.verbatim, false); assert.deepEqual(block.context.base_hrefs, ["/smart"]); }
  for (const block of output.blocks.filter(b => b.kind === "publisher_data")) { assert.equal(block.context.verbatim, false); assert.equal(block.context.representation, "publisher_data"); assert(block.text.includes("not a source quotation")); }
  assert.equal(output.fields.length, 7);
  for (const block of output.blocks.filter(b => b.context.representation === "publisher_text")) assert.equal(block.context.verbatim, true);
  assert(output.provenance.semantic_scope.includes("no HTML completeness"));
});

test("all thirty synthetic FAQ questions and complete answers survive without excerpt limits", () => {
  const out = project("faq");
  assert.equal(out.blocks.filter(b => /^Synthetic question \d+\?$/.test(b.text)).length, 30);
  for (let i = 1; i <= 30; i++) { assert(out.text.includes(`Synthetic question ${i}?`)); assert(out.text.includes(`Complete synthetic answer ${i}; preserve every answer.`)); }
});

for (const key of ["faq", "submit", "instructions"]) test(`${key} exact original source/owner/URL/type cannot be recast`, () => {
  for (const change of [{ id: "different" }, { shared_award_id: "d7d4d117-f312-456f-a75c-3dbd5d372c99-other" }, { url: source(key).url + "&extra=1" }, { url: source(key).url.replace("/smart", "/smart/") }, { page_type: "other" }]) {
    assert.throws(() => projectSmartKbPublisherJson(encode(fixture(key)), { source: { ...source(key), ...change } }), /source_identity/);
  }
  if (key !== "faq") assert.throws(() => projectSmartKbPublisherJson(encode(fixture(key)), { source: { ...source(key), shared_award_id: source("faq").shared_award_id } }), /source_identity/);
});

test("en_home and arbitrary other KB routes are outside this finite projector", () => {
  for (const s of [{ ...source("faq"), id: "92eebc07-7392-4136-ba13-d9cd5455c8f9", url: "https://www.smartscholarship.org/smart/en" }, { ...source("faq"), url: source("submit").url }]) assert.throws(() => projectSmartKbPublisherJson(encode(fixture("faq")), { source: s }), /source_identity/);
});

test("the separately authorized literal en_home source uses its own v1 identity and reviewed home model", () => {
  const alias = oldProfiles.find(p => p.id === "92eebc07-7392-4136-ba13-d9cd5455c8f9");
  assert.equal(alias.shared_award_id, "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108"); assert.equal(alias.url, "https://www.smartscholarship.org/smart/en");
  assert.equal(alias.page_type, "homepage"); assert.equal(alias.key, "home"); assert.equal(alias.version, "smart-publisher-json-v1");
  const doc = oldFixture("home"); doc.result.theme.header.data.loginWidget.data.pageURI = "/smart/en";
  const out = projectSmartPublisherJson(encode(doc), { source: alias });
  assert.equal(out.provenance.source_id, alias.id); assert.equal(out.provenance.version, alias.version);
  assert(out.blocks.filter(b => b.kind === "source_link").every(b => b.context.navigation_source_url === alias.url));
  assert.equal(out.provenance.page_id, "smart_index");
});

test("en_home cannot borrow canonical owner, type, URL or canonical response route", () => {
  const alias = oldProfiles.find(p => p.id === "92eebc07-7392-4136-ba13-d9cd5455c8f9"), doc = oldFixture("home");
  doc.result.theme.header.data.loginWidget.data.pageURI = "/smart/en";
  for (const change of [{ shared_award_id: source("faq").shared_award_id }, { page_type: "other" }, { page_type: undefined }, { url: "https://www.smartscholarship.org/smart" }, { url: alias.url + "/" }, { url: alias.url + "?id=smart_index" }]) assert.throws(() => projectSmartPublisherJson(encode(doc), { source: { ...alias, ...change } }), /source_identity/);
  doc.result.theme.header.data.loginWidget.data.pageURI = "/smart";
  assert.throws(() => projectSmartPublisherJson(encode(doc), { source: alias }), /portal_route_identity/);
});

test("KB versions are explicit and distinct without adding metadata to the original two profiles", () => {
  assert(profiles.every(p => p.version === SMART_KB_PROJECTOR_VERSION));
  for (const id of ["58aefec0-0d42-4b7b-9887-60d25940b3d0", "c33cc2f4-2cbd-458c-b630-537eb3d50f72"]) assert.equal(Object.hasOwn(oldProfiles.find(p => p.id === id), "version"), false);
});

test("whole-original parse rejects duplicate decoded keys, including excluded metadata", () => {
  const raw = encode(fixture("faq"));
  for (const x of [raw.replace('"logged_in":false', '"logged_in":false,"logged_in":false'), raw.replace('"logged_in":false', '"logged_in":false,"logg\\u0065d_in":false'), raw.replace('"metatags":[]', '"metatags":[{"a":1,"a":2}]')]) assert.throws(() => projectSmartKbPublisherJson(x, { source: source("faq") }), /duplicate_key/);
});

test("incomplete/invalid UTF8/oversize JSON and excessive nesting remain held", () => {
  for (const raw of [Buffer.from([0xff]), "{", Buffer.alloc(512 * 1024 + 1), '{"a":1e999}', '"\\ud800"', "\ud800", "[".repeat(66) + "0" + "]".repeat(66)]) assert.throws(() => projectSmartKbPublisherJson(raw, { source: source("faq") }), e => e.code?.startsWith("program_text_smart_kb_json_"));
});

for (const [name, edit] of [
  ["wrong page identity", x => { x.result.page.id = "another"; }],
  ["private page", x => { x.result.page.public = false; }],
  ["draft page", x => { x.result.page.draft = true; }],
  ["new privileged user property", x => { x.result.user.email = "private@example.invalid"; }],
  ["logged-in response", x => { x.result.user.logged_in = true; }],
  ["wrong route witness", x => { x.result.theme.header.data.loginWidget.data.pageURI = "/another"; }],
  ["unknown result field", x => { x.result.new_programme_section = "Unreviewed rule"; }],
  ["unknown container", x => { x.result.containers.push({ rule: "Unreviewed rule" }); }],
  ["unknown nested widget field", x => { article(x).new_policy = "Unreviewed rule"; }],
  ["changed programme controller", x => { article(x).client_script += "\nfetch('/new-rule');"; }],
  ["changed shared header controller", x => { x.result.theme.header.client_script += "\nfetch('/new-rule');"; }],
  ["changed template", x => { article(x).template += "<p>New rule</p>"; }],
  ["changed CSS", x => { article(x).css += " .new-policy{display:none}"; }],
  ["new data field", x => { article(x).data.new_rule = "Unreviewed"; }],
  ["wrong article sysid", x => { article(x).data.sys_id = source("submit").article_sys_id; }],
  ["invalid article", x => { article(x).data.isvalid = false; }],
  ["direct attachment-only article", x => { article(x).data.direct = true; }],
  ["new attachment", x => { article(x).data.attachments.push({ file_name: "Unreviewed rules.pdf" }); }],
  ["attachment display", x => { article(x).data.showAttachments = true; }],
  ["title mismatch", x => { article(x).data.short_description = "Another title"; }],
  ["new announcement", x => { x.result.theme.header.data.announcementWidget.data.informationAnnouncements.push({ text: "Unreviewed programme rule" }); }],
  ["new menu destination", x => { x.result.theme.header.data.menu.data.menu.items.push({ href: "/unknown-guidance" }); }],
  ["invalid deadline", x => { x.result.theme.header.data.wCountdown.data.countDownWidget.data.deadLine = 1.5; }],
  ["new countdown state", x => { x.result.theme.header.data.wCountdown.data.countDownWidget.data.status = "Unknown"; }],
  ["null body", x => { article(x).data.text = null; }],
  ["empty body", x => { article(x).data.text = " "; }],
]) test(`${name} fails closed`, () => held(edit));

for (const html of [
  '<script>fetch("/new-rule")</script><p>Rules</p>', '<iframe src="/new-rule"></iframe>', '<img src="/policy.png">',
  '<p ng-bind="data.newRule">Rules</p>', '<p onclick="loadRule()">Rules</p>', '<p>{{data.rule}}</p>',
  '<p hidden>Rule</p>', '<p style="display:none">Rule</p>', '<base href="https://elsewhere.invalid/">',
  '<a href="/first" href="/second">Rules</a>', '<a href="javascript:loadRule()">Rules</a>', '<a href="https://user:password@example.invalid">Rules</a>',
  '<a href="/new\npath">Rules</a>', '<form>Uncollected rule</form>', '<p><span data-rule="unknown">Rules</span></p>',
]) test(`unreviewed/dynamic/malformed article HTML holds: ${html.slice(0, 45)}`, () => held(x => { article(x).data.text = html; }));

test("full article prose and links can change without dropping the last requirement", () => {
  const doc = fixture("submit"), old = project("submit", doc);
  article(doc).data.text += '<p>Additional complete synthetic rule 🧪 at the end, with <a href="/smart?id=kb_article&amp;sys_id=c6cd2a0edbd6c3006bb8f4b40f961952">literal guidance</a>.</p>';
  const out = project("submit", doc); assert.notEqual(out.text, old.text); assert(out.text.includes("Additional complete synthetic rule 🧪 at the end")); assert.equal(out.source_links.length, old.source_links.length + 1);
  const link = out.source_links.at(-1); assert(link.raw_href.includes("&sys_id=")); assert(!link.raw_href.includes("&amp;")); assert(link.sources.every(s => Number.isInteger(s.decoded_start_utf16) && s.decoded_end_utf16 > s.decoded_start_utf16));
});

test("new or changed tooltip programme text is held instead of disappearing from comparison", () => {
  held(x => { article(x).data.text = article(x).data.text.replace('<a href=', '<a title="Applicants must be United States citizens." href='); }, "unreviewed_article_attribute");
  // Even another already-reviewed metadata label cannot be moved to a new
  // anchor and silently compare unchanged.
  held(x => { article(x).data.text = article(x).data.text.replace('<a href=', '<a title="Follow link" href='); }, "unreviewed_article_title_attributes");
});

test("exact typed deadline/status mutation is monitored as non-verbatim publisher_data", () => {
  const doc = fixture("instructions"), before = project("instructions", doc);
  const data = doc.result.theme.header.data;
  data.showApply = false; data.showClosedWarning = true; data.pyOpenNextYear = "Synthetic next cycle";
  data.wCountdown.data.countDownWidget.data.deadLine += 86400000;
  data.wCountdown.data.countDownWidget.data.status = "Opens";
  const after = project("instructions", doc);
  assert.notEqual(after.text, before.text);
  assert.deepEqual(after.blocks.filter(b => b.context.verbatim), before.blocks.filter(b => b.context.verbatim));
  assert(after.fields.some(f => f.semantic === "publisher_countdown_status" && f.value === "Opens"));
  assert(after.blocks.filter(b => b.kind === "publisher_data").every(b => b.context.verbatim === false));
});

test("only known operational timing/view metadata may vary without a programme change", () => {
  const doc = fixture("faq"), before = project("faq", doc);
  doc.result.theme.header._script_execution_time += 1; doc.result.theme.header._server_time = "0.123";
  article(doc).data.sys_view_count = "999,999"; article(doc).data.publishedUtc = "2001-01-01";
  const after = project("faq", doc);
  assert.equal(after.text, before.text); assert.deepEqual(after.blocks, before.blocks); assert.notDeepEqual(after.provenance.exclusions, before.provenance.exclusions);
});

for (const key of ["home", "eligibility"]) test(`old ${key} delegate remains exactly its old projection/version`, () => {
  // Independently produced from frozen old projector 54d9a03f... and unchanged
  // synthetic fixture, before this early finite delegate was introduced.
  const expected = { home: "48fbf8c3c2bef9704615f0dbf599aa667994abde29f5b239243af987b0f44668", eligibility: "55074ccfcf3bfd47f7038a49896bb28a23c869ad00139e7ffbe90cb24d1cb77d" };
  const s = oldProfiles.find(p => p.key === key), raw = encode(oldFixture(key));
  assert.equal(createHash("sha256").update(JSON.stringify(projectSmartPublisherJson(raw, { source: s }))).digest("hex"), expected[key]);
});
