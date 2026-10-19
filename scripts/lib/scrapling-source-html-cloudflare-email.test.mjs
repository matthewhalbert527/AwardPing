import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const source = { id: "8e929d16-8b19-4ce6-9b5f-b1276da0a426", shared_award_id: "3cf7c610-0246-4dfb-b26c-289254e40ce6", url: "https://pdsoros.org/application-process/" };
// Exact CF payloads/anchor forms from the retained 14:59 and 15:50 Soros pair.
const tokens = [
  ["dfacaaafafb0adab9facb2beafafb3a6f1b6b0", "1646524579647965566672657964796538796471", "caa3a4aca58abaaeb9a5b8a5b9e4a5b8ad"],
  ["01727471716e737541726c6071716d782f686e", "104054437f627f63506074637f627f633e7f6277", "e38a8d858ca39387908c918c90cd8c9184"],
];
const href = hex => `/cdn-cgi/l/email-protection#${hex}`;
const encode = (address, key = 1) => Buffer.from([key, ...Buffer.from(address)].map((value, index) => index ? value ^ key : value)).toString("hex");
const prose = "Applicants must complete all application requirements before the stated deadline. Academic transcripts, personal statements and recommendations are required. " +
  "Review the complete eligibility requirements and instructions before submitting the application. Contact smapply.io for registration assistance.";
const block = text => ({ kind: "p", text, heading_path: [], list_path: [], table_row: [] });
const link = (text, raw_href) => ({ text, raw_href, source_url: source.url, base_hrefs: [], heading_path: [], list_path: [] });
function record(index) {
  const values = tokens[index], main = `<main><p>${prose}</p><a href="${href(values[0])}" target="_blank" rel="noreferrer noopener">smapply.io</a><a href="/apply">Apply</a></main>`;
  const html = `<html><head><title>Application Process</title></head><body>${main}<footer><a href="${href(values[1])}"><span class="__cf_email__" data-cfemail="${values[2]}">[email&nbsp;protected]</span></a>` +
    `<div id="gform_wrapper_1" class="gf_browser_${index ? "chrome" : "unknown"}"><input type="hidden" name="state_1" value="opaque-${index}"/></div></footer></body></html>`;
  const doc = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    publishable: false, visibility_verified: false, title: "Application Process", text: `${prose} smapply.io Apply [email protected]`,
    blocks: [block(prose), block("[email protected]")], links: [link("smapply.io", href(values[0])), link("Apply", "/apply"), link("[email protected]", href(values[1]))],
    base_hrefs: [], limitations: ["Source only."], counts: { html_bytes: Buffer.byteLength(html), nodes: 20, blocks: 2, links: 3, base_hrefs: 0 } };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE, source_id: source.id, url: source.url, final_url: source.url,
    captured_at: index ? "2026-10-19T15:50:54.339290+00:00" : "2026-10-19T14:59:41.084175+00:00", status_code: 200,
    content_type: "text/html; charset=utf-8", html, html_document: doc,
    source_main_document: { ...structuredClone(doc), scope: "html-source-main-element", title: "", text: `${prose} smapply.io Apply`, blocks: [block(prose)],
      links: doc.links.slice(0, 2), counts: { html_bytes: Buffer.byteLength(`<html><body>${main}</body></html>`), nodes: 10, blocks: 1, links: 2, base_hrefs: 0 } },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0, body_encoding: "utf-8", content_encoding: "identity",
      body_byte_length: Buffer.byteLength(html), body_sha256: sha(html), acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function inputs(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "awardping-cf-source-review-")); roots.push(root);
  const old = record(0), current = record(1); mutate(old, current);
  for (const value of [old, current]) {
    value.source_http.body_byte_length = Buffer.byteLength(value.html); value.source_http.body_sha256 = sha(value.html);
    value.html_document.counts.html_bytes = Buffer.byteLength(value.html);
  }
  const keep = value => captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => value });
  const before = await keep(old), capture = await keep(current);
  return { source, baseline: before, previous: { meta: before, html: before.html, text: before.text }, capture };
}
function replaceTarget(value, oldHex, newHex) {
  value.html = value.html.replace(href(oldHex), href(newHex));
  for (const doc of [value.html_document, value.source_main_document])
    for (const item of doc.links) if (item.raw_href === href(oldHex)) item.raw_href = href(newHex);
}

describe("source-only exact Cloudflare email representation changes", () => {
  it("retains exact case-preserved support/target/display values from the actual pair without changing evidence or claiming DOM equality", async () => {
    const input = await inputs(), original = JSON.stringify(input), result = buildScraplingReviewDiff(input);
    expect(result).toMatchObject({ status: "unchanged", reason: "source_semantics_cloudflare_email_only", retain_both_captures: true,
      publishable: false, baseline_advance_allowed: false, raw_dom_equality_verified: false });
    expect(result.limitations.join(" ")).toContain("unmodeled raw form state");
    expect(JSON.stringify(input)).toBe(original);
  });
  it("retains both raw captures when only the independently bound display encoding changes", async () => {
    const input = await inputs((_old, current) => {
      replaceTarget(current, tokens[1][0], tokens[0][0]); replaceTarget(current, tokens[1][1], tokens[0][1]);
    });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "unchanged", reason: "source_semantics_cloudflare_email_only", retain_both_captures: true });
  });
  it.each([
    ["a decoded target address changes", (_old, current) => replaceTarget(current, tokens[1][0], encode("other@smapply.io"))],
    ["address case changes", (_old, current) => replaceTarget(current, tokens[1][0], encode("Support@smapply.io"))],
    ["the separately encoded display address changes", (_old, current) => { current.html = current.html.replace(tokens[1][2], encode("other@pdsoros.org")); }],
    ["a target has malformed hex", (_old, current) => replaceTarget(current, tokens[1][0], "01zz")],
    ["a display has malformed hex", (_old, current) => { current.html = current.html.replace(tokens[1][2], "0"); }],
    ["decoded bytes are not printable ASCII", (_old, current) => replaceTarget(current, tokens[1][0], "010041626f642f626e6c")],
    ["a protected anchor moves", (_old, current) => { current.html = current.html.replace(`<a href="${href(tokens[1][0])}"`, `<div><a href="${href(tokens[1][0])}"`).replace("smapply.io</a>", "smapply.io</a></div>"); }],
    ["a raw protected anchor is duplicated", (_old, current) => { current.html = current.html.replace("</footer>", `<a href="${href(tokens[1][0])}">smapply.io</a></footer>`); }],
    ["another encoded anchor has no retained link mapping", (_old, current) => { current.html = current.html.replace("</footer>", `<a href="${href(encode("unmapped@example.edu"))}">Unmapped</a></footer>`); }],
    ["a retained CF link has duplicate mappings", (old, current) => { for (const value of [old, current]) value.html_document.links.push({ ...value.html_document.links[0] }); }],
    ["a token is carried by an unmapped attribute", (_old, current) => { current.html = current.html.replace("<footer>", `<footer data-other="${href(tokens[1][0])}">`); }],
    ["the old raw target has no CF proof", (old) => { old.html = old.html.replace(href(tokens[0][0]), "mailto:support@smapply.io"); for (const doc of [old.html_document, old.source_main_document]) doc.links[0].raw_href = "mailto:support@smapply.io"; }],
    ["a CF anchor's other attribute changes", (_old, current) => { current.html = current.html.replace('target="_blank"', 'target="_self"'); }],
    ["the display marker is missing", (_old, current) => { current.html = current.html.replace('class="__cf_email__"', 'class="ordinary"'); }],
    ["an award requirement changes", (_old, current) => { for (const doc of [current.html_document, current.source_main_document]) { doc.text = doc.text.replace("Academic transcripts", "Official transcripts"); doc.blocks[0].text = doc.blocks[0].text.replace("Academic transcripts", "Official transcripts"); } current.html = current.html.replace("Academic transcripts", "Official transcripts"); }],
    ["a plain link destination changes", (_old, current) => { current.html = current.html.replace('href="/apply"', 'href="/other"'); for (const doc of [current.html_document, current.source_main_document]) doc.links[1].raw_href = "/other"; }],
    ["main link context changes", (_old, current) => { current.source_main_document.links[0].details_path = ["Different audience"]; }],
    ["an unrelated full-body counter changes", (_old, current) => { current.html_document.counts.nodes += 1; }],
    ["the main-fragment byte counter changes", (_old, current) => { current.source_main_document.counts.html_bytes += 1; }],
  ])("holds when %s", async (_label, mutate) => {
    const input = await inputs(mutate), original = JSON.stringify(input), result = buildScraplingReviewDiff(input);
    expect(result).toMatchObject({ status: "manual_review_required", reason: "cloudflare_email_change_requires_review", retain_both_captures: true,
      publishable: false, baseline_advance_allowed: false });
    expect(JSON.stringify(input)).toBe(original);
  });
});
