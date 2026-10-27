import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { projectSmartPublisherJson, SMART_PUBLISHER_JSON_SOURCE_PROFILES, PROJECTOR_VERSION, SMART_PUBLISHER_DATA_SCHEMA } from "./program-text-smart-publisher-json.mjs";

// Sanitized synthetic publisher models. Only reviewed public static controller
// code and binding grammar are retained; no original programme/user/session data.
import { createSyntheticSmartPublisherJsonFixture } from "../fixtures/smart-publisher-json.mjs";

const source = key => SMART_PUBLISHER_JSON_SOURCE_PROFILES.find(p => p.key === key);
const fixture = key => createSyntheticSmartPublisherJsonFixture(key);
const encode = x => Buffer.from(JSON.stringify(x));
const project = (key, document = fixture(key)) => projectSmartPublisherJson(encode(document), { source: source(key) });
const at = (x, pointer) => pointer.split("/").slice(1).reduce((o, k) => o[k], x);
const root = (x, key) => at(x, source(key).programme_pointer);
const held = (key, edit, code) => { const x = fixture(key); edit(x); assert.throws(() => project(key, x), e => !!e.code?.startsWith("program_text_smart_json_") && (!code || e.code.endsWith(code))); };
const digest = x => createHash("sha256").update(x).digest("hex");

for (const key of ["home", "eligibility"]) test(`synthetic ${key} is deterministic and every UTF16 block binds complete text`, () => {
  const output = project(key), again = project(key);
  assert.deepEqual(output, again); assert.equal(output.provenance.version, PROJECTOR_VERSION);
  assert.deepEqual(Object.keys(output).sort(), ["blocks", "fields", "provenance", "source_links", "text"]);
  assert.equal(output.provenance.transport_binding_required, true);
  let cursor = 0;
  for (const block of output.blocks) {
    assert.equal(block.page, null); assert.equal(output.text.slice(block.start_utf16, block.end_utf16), block.text);
    assert.equal(output.text.slice(cursor, block.start_utf16).trim(), ""); cursor = block.end_utf16;
  }
  assert.equal(output.text.slice(cursor).trim(), "");
  assert(output.blocks.some(b => b.context.representation === "publisher_text"));
  assert(!output.text.includes("STORY_EXCLUDED")); assert(!output.text.includes("Excluded synthetic UI"));
});

test("source id, exact owner and exact page URL cannot be replaced by aliases or other routes", () => {
  for (const change of [{ id: "other" }, { shared_award_id: "wrong-owner" }, { url: source("home").url + "/" }, { url: source("eligibility").url }]) {
    assert.throws(() => projectSmartPublisherJson(encode(fixture("home")), { source: { ...source("home"), ...change } }), /source_identity/);
  }
});

test("strict entire-original parsing rejects duplicate keys even in excluded nested user/metadata", () => {
  const original = JSON.stringify(fixture("home"));
  for (const raw of [original.replace('"logged_in":false', '"logged_in":false,"logged_in":false'),
    original.replace('"logged_in":false', '"logged_in":false,"logg\\u0065d_in":false'),
    original.replace('"metatags":[]', '"metatags":[{"same":1,"same":2}]')]) {
    assert.throws(() => projectSmartPublisherJson(raw, { source: source("home") }), /duplicate_key/);
  }
});

test("invalid UTF8, incomplete JSON, invalid numeric overflow and excessive original are rejected", () => {
  for (const raw of [Buffer.from([0xff]), "{", '{"a":1e999}', Buffer.alloc(512 * 1024 + 1), '"\\ud800"', "\ud800"]) {
    assert.throws(() => projectSmartPublisherJson(raw, { source: source("home") }), e => e.code?.startsWith("program_text_smart_json_"));
  }
});

for (const [label, edit] of [
  ["wrong page id", x => { x.result.page.id = "another_page"; }],
  ["wrong page sysid", x => { x.result.page.sys_id = "wrong"; }],
  ["private page", x => { x.result.page.public = false; }],
  ["draft page", x => { x.result.page.draft = true; }],
  ["internal page", x => { x.result.page.internal = true; }],
  ["wrong portal", x => { x.result.page.u_portal = "wrong"; }],
  ["missing home portal", x => { delete x.result.page.u_portal; }],
  ["wrong route witness", x => { x.result.theme.header.data.loginWidget.data.pageURI = "/another"; }],
  ["logged in", x => { x.result.user.logged_in = true; }],
  ["debug or privileged", x => { x.result.user.can_debug_admin = true; }],
  ["unexpected account data", x => { x.result.user.email = "PRIVATE_ACCOUNT_SECRET"; }],
]) test(`${label} cannot become programme evidence`, () => held("home", edit));

test("eligibility legitimately omits page.u_portal but a published wrong value is rejected", () => {
  assert.equal(fixture("eligibility").result.page.u_portal, undefined);
  assert(project("eligibility").text);
  held("eligibility", x => { x.result.page.u_portal = "wrong"; });
});

for (const [label, edit] of [
  ["missing root widget", x => { x.result.containers = []; }],
  ["extra unreviewed widget", x => { x.result.containers.push({ rows: [{ columns: [{ widgets: [{ widget: structuredClone(root(x, "home")) }] }] }] }); }],
  ["wrong widget id", x => { root(x, "home").sys_id = "wrong"; }],
  ["private widget", x => { root(x, "home").public = false; }],
  ["async widget even when options says false", x => { root(x, "home").async_load = true; }],
  ["async options even when widget says false", x => { root(x, "home").options.async_load = true; }],
  ["changed programme controller", x => { root(x, "home").client_script += "\nfetch('/extra');"; }],
  ["changed programme link function", x => { root(x, "home").link += "\n/*changed*/"; }],
  ["unknown binding", x => { root(x, "home").template += '<p ng-if="data.extra">New rule</p>'; }],
  ["new inline executable", x => { root(x, "home").template += '<img onload="run()">'; }],
  ["new script", x => { root(x, "home").template += '<script>run()</script>'; }],
  ["new custom element", x => { root(x, "home").template += '<publisher-rule-loader>Missing live rules</publisher-rule-loader>'; }],
  ["new text outside the reviewed widget model", x => { x.result.containers[0].title = "Unreviewed programme condition"; }],
  ["unexpected programme data", x => { root(x, "home").data.extra = "Undisclosed requirement"; }],
  ["new header announcement", x => { x.result.theme.header.data.announcementWidget.data.informationAnnouncements.push({ text: "New governing announcement" }); }],
  ["header outage or announcement id without full data", x => { x.result.theme.header.data.announcementWidget.data.outageIDs = "unrestored-id"; }],
  ["unreviewed carousel page", x => { root(x, "home").data.smart_carousel.data.row_count = 1; }],
  ["new sections", x => { root(x, "home").data.program_and_eligibility.data.sections = [{ title: "New", description: "Rule" }]; }],
]) test(`${label} fails closed without a partial projection`, () => held("home", edit));

test("all discipline entries are consumed beyond a small display-sized list", () => {
  const x = fixture("eligibility"); root(x, "eligibility").data.loDiscipline = Array.from({ length: 81 }, (_, i) => ({ name: `DISCIPLINE_${i}`, value: `d${i}`, sysID: String(i).padStart(32, "0") }));
  const output = project("eligibility", x);
  for (let i = 0; i < 81; i++) assert(output.text.includes(`DISCIPLINE_${i}`));
  assert(output.blocks.some(b => b.context.sources.some(s => s.pointer.endsWith("/loDiscipline/80/name"))));
  held("eligibility", y => { root(y, "eligibility").data.loDiscipline = []; });
});

test("all four closed FAQ answers are retained even though Bootstrap CSS initially collapses them", () => {
  const x = fixture("eligibility"), parent = root(x, "eligibility"), $ = load(parent.template, {}, false);
  const answers = ["FAQ_ANSWER_ONE", "FAQ_ANSWER_TWO", "FAQ_ANSWER_THREE", "FAQ_ANSWER_FOUR"];
  assert.equal($(".collapse").length, 4);
  $(".collapse").each((i, node) => { $(node).append(" " + answers[i]); });
  parent.template = $.root().html();
  const output = project("eligibility", x);
  for (const answer of ["FAQ_ANSWER_ONE", "FAQ_ANSWER_TWO", "FAQ_ANSWER_THREE", "FAQ_ANSWER_FOUR"]) assert(output.text.includes(answer));
  for (const answer of answers) assert(output.blocks.some(b => b.text.includes(answer) && b.context.sources.some(s => s.pointer.endsWith("/widgets/1/widget/template"))));
});

test("whole testimonials stay private and accounted, while story edits cannot produce rule changes", () => {
  const before = fixture("eligibility"), after = structuredClone(before);
  root(after, "eligibility").data.scholars[3].text = "<p>STORY_CHANGED_SECRET</p>";
  const a = project("eligibility", before), b = project("eligibility", after);
  assert.equal(a.text, b.text); assert.deepEqual(a.blocks, b.blocks);
  const exclusion = b.provenance.exclusions.find(e => e.pointer.endsWith("/data/scholars"));
  assert.equal(exclusion.count, 4); assert.equal(exclusion.content_sha256, digest(JSON.stringify(root(after, "eligibility").data.scholars)));
  assert(!JSON.stringify(b).includes("STORY_CHANGED_SECRET"));
});

test("known metric changes and excluded recipient promotion do not become programme changes", () => {
  const a = fixture("home"), b = structuredClone(a);
  root(b, "home").data.facilities++; root(b, "home").data.scholars++;
  root(b, "home").data.scholar_recipients.data.description = "<p>RECIPIENT_PROMO_SECRET</p>";
  assert.equal(project("home", a).text, project("home", b).text);
  assert(!JSON.stringify(project("home", b)).includes("RECIPIENT_PROMO_SECRET"));
});

test("inactive reopen values are omitted, active closure keeps actual template and scalar with provenance", () => {
  const a = fixture("home"), b = structuredClone(a);
  b.result.theme.header.data.pyOpenNextYear = "INACTIVE_FUTURE_DATE";
  root(b, "home").data.pyOpenNextYear = "INACTIVE_FUTURE_DATE";
  assert.equal(project("home", a).text, project("home", b).text);
  b.result.theme.header.data.showClosedWarning = true;
  const output = project("home", b); assert(output.text.includes("INACTIVE_FUTURE_DATE"));
  assert(output.blocks.some(block => block.context.sources?.some(s => s.pointer === "/result/theme/header/data/pyOpenNextYear")));
});

test("absolute deadline/status changes are monitored as exact labelled DATA, not fabricated quotations", () => {
  const a = fixture("home"), b = structuredClone(a), p = "/result/theme/header/data/wCountdown/data/countDownWidget/data/deadLine";
  at(b, "/result/theme/header/data/wCountdown/data/countDownWidget/data").deadLine++;
  const before = project("home", a), after = project("home", b); assert.notEqual(before.text, after.text);
  const field = after.fields.find(f => f.pointer === p), block = after.blocks.find(b => b.context.pointer === p);
  assert.equal(field.raw_value, String(field.value)); assert.equal(block.kind, "publisher_data");
  assert.equal(block.context.schema, SMART_PUBLISHER_DATA_SCHEMA); assert.equal(block.context.verbatim, false);
  assert(block.text.includes("not a source quotation")); assert.equal(block.page, null);
  held("home", x => { at(x, "/result/theme/header/data/wCountdown/data/countDownWidget/data").deadLine = null; });
});

test("pure program paragraph and destination changes remain observable", () => {
  const a = fixture("home"), b = structuredClone(a);
  root(b, "home").data.program_and_eligibility.data.description += "<p>NEW_REAL_REQUIREMENT</p>";
  root(b, "home").data.program_and_eligibility.data.buttons[0].href = "/smart/en?id=changed_application";
  const output = project("home", b); assert(output.text.includes("NEW_REAL_REQUIREMENT")); assert(output.text.includes("/smart/en?id=changed_application"));
  assert.notEqual(project("home", a).text, output.text);
});

test("dynamic or executable injected data HTML and populated unfetched contact content stay held", () => {
  for (const value of ['<p ng-if="data.secret">Hidden rule</p>', '<script>fetch()</script>', '<img onload="run()">', '<sp-widget widget="data.extra"></sp-widget>', '<p>{{arbitrary()}}</p>', '<base href="https://foreign.test/"><a href="rules">Rule</a>', '<iframe src="/unobserved"></iframe>', '<noscript>Unreviewed fallback rule</noscript>']) {
    held("home", x => { root(x, "home").data.program_and_eligibility.data.description = value; });
  }
  held("eligibility", x => { root(x, "eligibility").data.kbText = "Unfetched rule"; });
});

test("paragraph content can change without changing reviewed binding grammar", () => {
  const x = fixture("home"); root(x, "home").template = root(x, "home").template.replace("Synthetic rule", "SUBSTANTIVE_UPDATED_RULE");
  assert(project("home", x).text.includes("SUBSTANTIVE_UPDATED_RULE"));
});

test("reading nested link labels never removes their official text from the programme projection", () => {
  for (const key of ["home", "eligibility"]) {
    const output = project(key), prose = output.blocks.filter(b => b.context.representation === "publisher_text").map(b => b.text).join(" ");
    for (const link of output.source_links) assert(prose.includes(link.text), `${key}: ${link.text}`);
    for (const block of output.blocks.filter(b => b.kind === "source_link")) {
      assert.deepEqual(block.context.base_hrefs, ["/smart"]); assert.equal(block.context.base_url, "https://www.smartscholarship.org/smart");
      assert.equal(block.context.navigation_source_url, source(key).url);
      assert.equal(block.context.source_representation, "publisher_json");
    }
  }
});

test("UTF16 offsets and source pointers survive Unicode, entities and nested literal HTML links", () => {
  const x = fixture("home"); root(x, "home").data.program_and_eligibility.data.description = '<p>Criterion 😀 and José &amp; another rule.</p><p>Read <a href="/smart/rules"><strong>nested official guidance</strong></a>.</p>';
  const output = project("home", x);
  assert(output.text.includes("Criterion 😀 and José & another rule.")); assert(output.text.includes("nested official guidance"));
  for (const block of output.blocks) assert.equal(output.text.slice(block.start_utf16, block.end_utf16), block.text);
  assert(output.blocks.some(block => block.context.sources?.some(s => s.pointer.endsWith("/program_and_eligibility/data/description"))));
  assert(output.source_links.some(link => link.raw_href === "/smart/rules" && link.text === "nested official guidance"));
});

test("excluded anonymous UI values remain private hashes and cannot enter facts or quotes", () => {
  const x = fixture("home"); x.result.theme.header.data.loginWidget.data.errorMsg = "UI_PRIVATE_SECRET";
  x.result.metatags = [{ content: "META_PRIVATE_SECRET" }];
  const output = project("home", x);
  assert(!JSON.stringify(output).includes("PRIVATE_SECRET"));
  assert(output.provenance.exclusions.some(e => e.pointer === "/result/metatags"));
  held("home", y => { root(y, "home").template += '<div data-fetch="/unobserved">Additional rule</div>'; });
});

test("relative publisher links use the actual attested finite /smart base rather than the eligibility route", () => {
  const x = fixture("eligibility"), w = root(x, "eligibility");
  w.template = w.template.replace('/smart/en?id=smart_opportunities', 'governing-rules');
  const output = project("eligibility", x), link = output.source_links.find(s => s.raw_href === "governing-rules");
  assert.equal(link.resolved_url, "https://www.smartscholarship.org/governing-rules");
  assert.equal(output.provenance.expected_base_href, "/smart");
  assert.equal(output.provenance.transport_binding_required, true);
});

test("hidden clock flags never hide a changed raw deadline from typed comparison", () => {
  const before = fixture("home"), after = structuredClone(before);
  before.result.theme.header.data.wCountdown.data.showCountDown = false;
  after.result.theme.header.data.wCountdown.data.showCountDown = false;
  at(before, "/result/theme/header/data/wCountdown/data/countDownWidget/data").visible = false;
  at(after, "/result/theme/header/data/wCountdown/data/countDownWidget/data").visible = false;
  at(after, "/result/theme/header/data/wCountdown/data/countDownWidget/data").deadLine++;
  const a = project("home", before), b = project("home", after); assert.notEqual(a.text, b.text);
  assert(b.fields.some(f => f.semantic === "publisher_deadline_epoch_ms"));
  assert(b.blocks.filter(b => b.kind === "publisher_data").every(b => b.context.verbatim === false));
});
