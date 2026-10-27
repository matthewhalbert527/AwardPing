import { createHash } from "node:crypto";
import { load } from "cheerio";
import { SMART_KB_REVIEWED_MODEL as MODEL } from "./program-text-smart-kb-reviewed-model.mjs";
import { SMART_GUIDE_KB_SOURCE_PROFILES } from "./program-text-smart-guide-profiles.mjs";
import { SMART_GUIDE_REVIEWED_MODEL as GUIDE_MODEL } from "./program-text-smart-guide-reviewed-model.mjs";
export { SMART_GUIDE_KB_SOURCE_PROFILES };

// Pure finite projection of the COMPLETE initial publisher response. It never
// evaluates site code or decides transport completeness, source/fact approval,
// HTML/live-update completeness, a baseline transition, or publication.
export const SMART_KB_PROJECTOR_VERSION = "smart-publisher-json-kb-v1";
const SCHEMA = "awardping.smart-publisher-json-projection.v1";
const DATA_SCHEMA = "awardping.smart-publisher-data.v1";
const PORTAL = "f2a05466db71c300b67330ca7c9619f0";
const ARTICLE = "/result/containers/3/rows/0/columns/0/widgets/0/widget";
export const SMART_KB_PUBLISHER_SOURCE_PROFILES = Object.freeze([
  Object.freeze({ key: "faq", id: "203baaf3-2905-4fdf-b4af-af84998195a8", shared_award_id: "d7d4d117-f312-456f-a75c-3dbd5d372c99", page_type: "faq", article_sys_id: "84f05b02db5ac3006bb8f4b40f9619cc", url: "https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc", page_id: "kb_article", page_sys_id: "dea5792147132100ba13a5554ee4902d", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: ARTICLE }),
  Object.freeze({ key: "submit", id: "2562f7c2-4709-4d63-ac25-c4638733a981", shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "application", article_sys_id: "b8fb18e0db8a8300ecc734cc7c9619d7", url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7", page_id: "kb_article", page_sys_id: "dea5792147132100ba13a5554ee4902d", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: ARTICLE }),
  Object.freeze({ key: "instructions", id: "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5", shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "deadline", article_sys_id: "0383c5d6db2a03006bb8f4b40f961956", url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956", page_id: "kb_article", page_sys_id: "dea5792147132100ba13a5554ee4902d", portal_id: PORTAL, expected_base_href: "/smart", programme_pointer: ARTICLE }),
].map(profile => Object.freeze({ ...profile, version: SMART_KB_PROJECTOR_VERSION })));
const MAX_BYTES = 512 * 1024;
const hash = x => createHash("sha256").update(x).digest("hex");
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = x => Array.isArray(x) ? x.map(canonical) : plain(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const digest = x => hash(JSON.stringify(canonical(x)));
const norm = x => x.replace(/\s+/gu, " ").trim();
const fail = reason => { throw Object.assign(new Error(`SMART KB publisher JSON held: ${reason}`), { code: `program_text_smart_kb_json_${reason}` }); };
const check = (condition, reason) => { if (!condition) fail(reason); };
const textValue = (x, max = MAX_BYTES) => typeof x === "string" && x.length <= max && !x.includes("\0") && Buffer.from(x).toString("utf8") === x;
const pointerKey = key => key.replaceAll("~", "~0").replaceAll("/", "~1");
const getAt = (x, pointer) => pointer.split("/").slice(1).reduce((v, k) => v?.[k.replaceAll("~1", "/").replaceAll("~0", "~")], x);
const isWidget = x => plain(x) && typeof x.client_script === "string" && typeof x.template === "string";

// Full original parser: duplicate decoded keys at every depth are a hold. Raw
// scalar UTF-16 spans bind typed values; no JSON.parse key loss is tolerated.
function parseOriginal(raw) {
  check(typeof raw === "string" || raw instanceof Uint8Array, "raw_bytes_required");
  const bytes = Buffer.from(raw); check(bytes.length > 0 && bytes.length <= MAX_BYTES, "raw_size");
  let input;
  try { input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail("invalid_utf8"); }
  check(Buffer.from(input).equals(bytes) && (typeof raw !== "string" || input === raw), "invalid_utf8");
  let at = 0, nodes = 0; const spans = new Map();
  const white = () => { while (/[\x20\t\r\n]/.test(input[at] || "x")) at++; };
  function string() {
    check(input[at] === '"', "invalid_json"); const start = at++;
    while (at < input.length) {
      const ch = input[at++]; if (ch === "\\") { at++; continue; }
      if (ch === '"') { let value; try { value = JSON.parse(input.slice(start, at)); } catch { fail("invalid_json"); }
        check(textValue(value), "invalid_json_string"); return value; }
    }
    fail("invalid_json");
  }
  function value(pointer, depth) {
    check(depth <= 64 && ++nodes <= 50000, "json_complexity"); white(); const start = at; let result;
    if (input[at] === "{") {
      at++; result = Object.create(null); white();
      if (input[at] !== "}") for (;;) { white(); const key = string(); check(!Object.hasOwn(result, key), "duplicate_key"); white(); check(input[at++] === ":", "invalid_json"); result[key] = value(pointer + "/" + pointerKey(key), depth + 1); white(); if (input[at] !== ",") break; at++; }
      check(input[at++] === "}", "invalid_json");
    } else if (input[at] === "[") {
      at++; result = []; white(); if (input[at] !== "]") for (;;) { result.push(value(pointer + "/" + result.length, depth + 1)); white(); if (input[at] !== ",") break; at++; } check(input[at++] === "]", "invalid_json");
    } else if (input[at] === '"') result = string();
    else { const match = input.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/); check(match, "invalid_json"); at += match[0].length; result = JSON.parse(match[0]); check(typeof result !== "number" || Number.isFinite(result), "invalid_number"); }
    spans.set(pointer, { start_utf16: start, end_utf16: at }); return result;
  }
  const document = value("", 0); white(); check(at === input.length, "invalid_json"); return { document, input, bytes, spans };
}

function shape(x, pointer) {
  const type = MODEL.flexible[pointer];
  if (type) { check(type === "nullable_string" ? x === null || textValue(x) : typeof x === type && (type !== "string" || textValue(x)) && (type !== "number" || Number.isFinite(x)), "field_type"); return { $type: type }; }
  if (isWidget(x)) return { $widget: x.sys_id };
  return Array.isArray(x) ? x.map((v, i) => shape(v, pointer + "/" + i)) : plain(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shape(v, pointer + "/" + pointerKey(k))])) : x;
}

function reviewedModel(document, profile) {
  const rows = [];
  function walk(x, pointer) {
    if (!x || typeof x !== "object") return;
    if (isWidget(x) || x.sys_class_name === "sp_widget") { check(isWidget(x), "widget_shape"); rows.push({ pointer, widget: x }); }
    for (const [key, v] of Object.entries(x)) if (key !== "user") walk(v, pointer + "/" + pointerKey(key));
  }
  walk(document.result, "/result");
  const rule = GUIDE_MODEL.profiles[profile.key] ?? MODEL.profiles[profile.key];
  check(equal(rows.map(r => ({ pointer: r.pointer, id: r.widget.sys_id })), rule.graph), "widget_graph");
  for (const row of rows) {
    const w = row.widget, expected = MODEL.widgets[w.sys_id];
    check(expected && equal(Object.keys(w).sort(), expected.keys), "widget_fields");
    const { data, _script_execution_time, _server_time, ...staticWidget } = w;
    check(Number.isFinite(_script_execution_time) && _script_execution_time >= 0 && typeof _server_time === "string" && /^\d+(?:\.\d+)?$/.test(_server_time) && _server_time.length <= 30 && digest(staticWidget) === expected.static_sha256, "widget_controller_or_markup");
    check(plain(data) && digest(shape(data, row.pointer + "/data")) === rule.data_sha256[row.pointer], "widget_data_changed");
  }
  check(digest(shape(document, "")) === rule.outer_sha256, "page_layout_or_metadata_changed");
  return rows;
}

/** The whole article is publisher text; shared status fields are separately
 * labelled publisher_data and MUST NOT become quotations or AI comparisons. */
export function projectSmartKbPublisherJson(raw, { source } = {}) {
  const profile = [...SMART_KB_PUBLISHER_SOURCE_PROFILES, ...SMART_GUIDE_KB_SOURCE_PROFILES].find(p => p.id === source?.id);
  const guide = !!profile?.title, markup = guide ? GUIDE_MODEL.markup[profile.key] : MODEL;
  check(profile && source.shared_award_id === profile.shared_award_id && source.url === profile.url && source.page_type === profile.page_type && (!guide || source.title === profile.title), "source_identity");
  const parsed = parseOriginal(raw), document = parsed.document, result = document?.result;
  check(plain(document) && equal(Object.keys(document), ["result"]) && plain(result), "result_shape");
  const rows = reviewedModel(document, profile), article = getAt(document, ARTICLE)?.data, page = result.page;
  check(!guide || article.short_description === profile.publisher_article_title, "article_title_identity");
  check(page.id === profile.page_id && page.sys_id === profile.page_sys_id && page.public === true && page.draft === false && page.internal === false, "page_identity");
  check(result.user.logged_in === false && result.user.can_debug === false && result.user.can_debug_admin === false, "anonymous_required");
  const header = result.theme.header.data;
  check(header.hasLogin === false && result.theme.footer.data.portal === "smart" && header.loginWidget.data.pageURI === new URL(profile.url).pathname + new URL(profile.url).search, "portal_route_identity");
  check(article.sys_id === profile.article_sys_id && article.isvalid === true && article.direct === false && article.showAttachments === false && Array.isArray(article.attachments) && article.attachments.length === 0, "article_identity_or_attachments");
  check(textValue(article.text) && norm(article.text) && textValue(article.short_description, 500) && norm(article.short_description) && page.title === article.short_description && article.breadcrumbs.length === 1 && article.breadcrumbs[0].label === article.short_description && article.breadcrumbs[0].url === "#", "article_title_or_body");
  const countdown = header.wCountdown.data.countDownWidget.data;
  check(Number.isSafeInteger(countdown.deadLine) && countdown.deadLine > 0 && countdown.deadLine <= 8640000000000000 && ["Closes", "Opens"].includes(countdown.status), "deadline_status_invalid");
  const errors = [], $ = load(article.text, { sourceCodeLocationInfo: true, onParseError: e => errors.push(e.code) }, false);
  check(!errors.length && !article.text.includes("{{") && !article.text.includes("}}"), "malformed_or_dynamic_html");
  const allNodes = $("*").toArray();
  check(allNodes.length > 0 && allNodes.length <= 5000, "article_markup_size");
  for (const el of allNodes) {
    check(markup.tags.includes(el.name) && el.sourceCodeLocation?.startTag, "unreviewed_article_markup");
    for (const [key, value] of Object.entries(el.attribs || {})) {
      const allowed = markup.attributes[el.name + ":" + key];
      check(allowed && (key === "href" || allowed.includes(value)), "unreviewed_article_attribute");
      check(textValue(value, 10000), "invalid_article_attribute");
    }
  }
  // Literal tooltip values are not discarded arbitrary metadata. The reviewed
  // finite anchor sequence must remain exact; changed/new/moved titles hold.
  const titleSignature = $("a").toArray().flatMap((el, ordinal) => Object.hasOwn(el.attribs, "title") ? [{ ordinal, title: el.attribs.title }] : []);
  check(hash(JSON.stringify(titleSignature)) === (GUIDE_MODEL.profiles[profile.key] ?? MODEL.profiles[profile.key]).article_title_attributes_sha256, "unreviewed_article_title_attributes");
  const blocks = [], blockSources = [], fields = [], source_links = [], exclusions = [];
  let text = "", current = [], supports = [], heading = article.short_description, kind = "paragraph";
  function flush(blockKind = kind) {
    const value = norm(current.join("")), sources = supports; current = []; supports = [];
    if (!value) return;
    check(value.length <= 20000 && sources.length <= 128 && blocks.length < 2000, "projection_limit");
    if (text) text += "\n\n"; const start_utf16 = text.length; text += value;
    const id = `block-${String(blocks.length).padStart(6, "0")}`, unique = [...new Map(sources.map(s => [JSON.stringify(s), s])).values()];
    blocks.push({ id, text: value, start_utf16, end_utf16: text.length, heading, page: null, kind: blockKind, context: { schema: SCHEMA, representation: "publisher_text", verbatim: true, sources: unique } });
    blockSources.push({ id, sources: unique });
  }
  const breakTags = new Set(guide ? ["div", "section", "p", "li", "ul", "ol", "h2", "h3", "br"] : ["div", "p", "li", "ul", "h2"]);
  const nodeText = node => node.type === "text" ? node.data : (node.children || []).map(nodeText).join("");
  function render(node, depth = 0) {
    check(depth <= 64, "html_depth");
    if (node.type === "comment") return;
    if (node.type === "text") {
      const location = node.sourceCodeLocation;
      check(location && textValue(node.data), "unbound_article_text"); current.push(node.data);
      supports.push({ pointer: ARTICLE + "/data/text", operation: "html_text", decoded_start_utf16: location.startOffset, decoded_end_utf16: location.endOffset }); return;
    }
    check(node.type === "tag" && markup.tags.includes(node.name), "unreviewed_article_node");
    if (breakTags.has(node.name)) flush();
    const previousKind = kind; if (node.name === "h2" || guide && node.name === "h3") kind = "heading"; else if (node.name === "li") kind = "li";
    if (node.name === "a" && Object.hasOwn(node.attribs, "href")) {
      const raw_href = node.attribs.href; let url;
      try { url = new URL(raw_href, new URL(profile.expected_base_href, profile.url)); } catch { fail("invalid_source_link"); }
      check(["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(raw_href), "invalid_source_link");
      const location = node.sourceCodeLocation.attrs?.href; check(location, "unbound_source_link");
      source_links.push({ raw_href, resolved_url: url.href, text: norm(nodeText(node)), pointer: ARTICLE + "/data/text", sources: [{ pointer: ARTICLE + "/data/text", operation: "literal_href", decoded_start_utf16: location.startOffset, decoded_end_utf16: location.endOffset }] });
    }
    for (const child of node.children || []) render(child, depth + 1);
    if (breakTags.has(node.name)) { flush(); if (kind === "heading" && blocks.length) heading = blocks.at(-1).text; }
    kind = previousKind;
  }
  current.push(article.short_description); supports.push({ pointer: ARTICLE + "/data/short_description", operation: "literal" }); flush("heading");
  for (const node of $.root().contents().toArray()) render(node); flush();
  // Prove every decoded, non-comment body text node was visited once in order;
  // paragraph boundaries only add whitespace, never remove article prose.
  const bodyText = [], projectedBody = blocks.slice(1).map(b => b.text).join(" ");
  const collect = node => { if (node.type === "text") bodyText.push(node.data); else if (node.type !== "comment") for (const child of node.children || []) collect(child); };
  for (const node of $.root().contents().toArray()) collect(node);
  check(norm(projectedBody).replace(/\s/gu, "") === norm(bodyText.join("")).replace(/\s/gu, ""), "article_prose_not_complete");
  function dataField(pointer, semantic) {
    const value = getAt(document, pointer), span = parsed.spans.get(pointer);
    check(span && ["boolean", "number", "string"].includes(typeof value), "publisher_field_missing");
    const raw_value = parsed.input.slice(span.start_utf16, span.end_utf16); fields.push({ pointer, semantic, value, raw_value });
    if (text) text += "\n\n"; const start_utf16 = text.length; text += `Publisher data (not a source quotation): ${pointer} = ${raw_value}`;
    blocks.push({ id: `block-${String(blocks.length).padStart(6, "0")}`, text: text.slice(start_utf16), start_utf16, end_utf16: text.length, heading: "Publisher data as of response", page: null, kind: "publisher_data", context: { schema: DATA_SCHEMA, representation: "publisher_data", verbatim: false, pointer, semantic, value, raw_value } });
  }
  for (const [pointer, semantic] of [
    ["/result/theme/header/data/showApply", "publisher_show_apply"],
    ["/result/theme/header/data/showClosedWarning", "publisher_show_closed_warning"],
    ["/result/theme/header/data/pyOpenNextYear", "publisher_reopen_value"],
    ["/result/theme/header/data/wCountdown/data/showCountDown", "publisher_countdown_displayed"],
    ["/result/theme/header/data/wCountdown/data/countDownWidget/data/visible", "publisher_countdown_visible"],
    ["/result/theme/header/data/wCountdown/data/countDownWidget/data/deadLine", "publisher_deadline_epoch_ms"],
    ["/result/theme/header/data/wCountdown/data/countDownWidget/data/status", "publisher_countdown_status"],
  ]) dataField(pointer, semantic);
  for (let i = 0; i < source_links.length; i++) {
    const link = source_links[i]; if (text) text += "\n\n"; const start_utf16 = text.length; text += link.raw_href;
    blocks.push({ id: `source-link-${String(i).padStart(6, "0")}`, text: link.raw_href, start_utf16, end_utf16: text.length, heading: link.text, page: null, kind: "source_link", context: { schema: SCHEMA, representation: "publisher_attribute", verbatim: false, pointer: link.pointer, source_attribute: "href", link_text: link.text, base_hrefs: [profile.expected_base_href], base_url: new URL(profile.expected_base_href, profile.url).href, navigation_source_url: profile.url, source_representation: "publisher_json", resolved_url: link.resolved_url, sources: link.sources } });
  }
  const exclude = (pointer, reason) => { const value = getAt(document, pointer); check(value !== undefined, "exclusion_missing"); exclusions.push({ pointer, reason, count: Array.isArray(value) ? value.length : 1, content_sha256: hash(JSON.stringify(value)) }); };
  for (const pointer of ["/result/user", "/result/theme/footer", "/result/theme/header/data/menu", "/result/theme/header/data/loginWidget", "/result/theme/header/data/announcementWidget", "/result/metatags", "/result/seotags", "/result/containers/1/rows/0/columns/0/widgets/0/widget"]) exclude(pointer, "complete_hash_accounted_reviewed_non_programme_UI_or_empty_announcements");
  for (const key of Object.keys(article).filter(k => !["text", "short_description"].includes(k))) exclude(ARTICLE + "/data/" + key, "article_identity_or_non_programme_metadata_not_cycle_authority");
  check(text.length > 0 && text.length <= 500000 && blocks.length <= 2000 && blocks.length > fields.length, "projection_limit");
  return { text, blocks, fields, source_links, provenance: { schema: SCHEMA, version: SMART_KB_PROJECTOR_VERSION, representation: "publisher_json", source_id: profile.id, raw_sha256: hash(parsed.bytes), raw_byte_length: parsed.bytes.length, page_id: page.id, page_sys_id: page.sys_id, article_sys_id: article.sys_id, expected_portal_id: PORTAL, portal_id_published_in_page: page.u_portal ?? null, expected_base_href: profile.expected_base_href, transport_binding_required: true, programme_widget_pointer: ARTICLE, widget_count: rows.length, blocks: blockSources, exclusions, semantic_scope: "Complete initial literal KB article and separately labelled shared publisher data only; no HTML completeness, callback execution, push refresh, complete governing source set, factual approval or programme-cycle inference." } };
}
