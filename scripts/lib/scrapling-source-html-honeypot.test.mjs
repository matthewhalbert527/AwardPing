import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { buildScraplingReviewDiff } from "./scrapling-review-diff.mjs";
import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const source = { id: "10000000-0000-4000-8000-000000000001", shared_award_id: "20000000-0000-4000-8000-000000000001",
  url: "https://example.edu/admissions/" };
const mainText = "Applicants must have an undergraduate degree. All degree requirements must be completed before August 1 of the enrollment year. " +
  "Candidates must be at least 18 but not yet 29 years of age. Applications require academic transcripts and three letters of recommendation.";
const disclaimer = "This field is for validation purposes and should be left unchanged.";
// Retained Schwarzman Admissions field_5_10 markup from the October 19
// 02:32/15:11 UTC captures; its label changed from Company to LinkedIn.
const trapHtml = label => `<form method='post' enctype='multipart/form-data' target='gform_ajax_frame_5' id='gform_5' action='/admissions/#gf_5' data-formid='5' novalidate>
  <div class='gform-body gform_body'><ul id='gform_fields_5'>
  <li id="field_5_10" class="gfield gfield--type-honeypot gform_validation_container field_sublabel_below gfield--has-description field_description_below field_validation_below gfield_visibility_visible"><label class='gfield_label gform-field-label' for='input_5_10'>${label}</label><div class='ginput_container'><input name='input_10' id='input_5_10' type='text' value='' autocomplete='new-password'/></div><div class='gfield_description' id='gfield_description_5_10'>${disclaimer}</div></li>
  </ul></div></form>`;
const block = (kind, text) => ({ kind, text, heading_path: [], list_path: [], table_row: [] });
function record(label, at) {
  const trapText = `${label} ${disclaimer}`;
  const html = `<html><head><title>Admissions</title></head><body><main><p>${mainText}</p></main>${trapHtml(label)}</body></html>`;
  const doc = { schema: "awardping.scrapling-html-document.v1", scope: "html-source-main-document", source_url: source.url,
    publishable: false, visibility_verified: false, title: "Admissions", text: `${mainText} ${trapText}`,
    blocks: [block("p", mainText), block("li", trapText)], links: [], base_hrefs: [], limitations: ["Source only."],
    counts: { html_bytes: Buffer.byteLength(html), nodes: 18, blocks: 2, links: 0, base_hrefs: 0 } };
  return { schema: "awardping.scrapling-capture.v1", capture_profile: SOURCE_HTML_PROFILE, source_id: source.id,
    url: source.url, final_url: source.url, captured_at: at, status_code: 200, content_type: "text/html; charset=utf-8", html,
    html_document: doc, source_main_document: { ...structuredClone(doc), title: "", scope: "html-source-main-element",
      text: mainText, blocks: [block("p", mainText)], counts: { html_bytes: Buffer.byteLength(`<main><p>${mainText}</p></main>`),
        nodes: 3, blocks: 1, links: 0, base_hrefs: 0 } },
    source_http: { schema: "awardping.scrapling-source-http.v1", method: "GET", response_complete: true, redirect_count: 0,
      body_encoding: "utf-8", content_encoding: "identity", body_byte_length: Buffer.byteLength(html), body_sha256: sha(html),
      acquisition: "ordinary_anonymous_http", visibility_verified: false, screenshot_available: false },
    warnings: ["source_html_only_not_browser_visible_or_screenshot_evidence", "linked_documents_forms_and_client_loaded_content_not_fetched"],
    engine: { scrapling: "0.4.15", client: "Fetcher", adaptive: false, stealth: false, impersonation: false } };
}
const directories = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function inputs(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "awardping-honeypot-review-")); directories.push(root);
  const before = record("Company", "2026-10-19T02:32:28.419834+00:00"), after = record("LinkedIn", "2026-10-19T15:11:28.329519+00:00");
  mutate(before, after);
  for (const value of [before, after]) {
    value.source_http.body_byte_length = Buffer.byteLength(value.html);
    value.source_http.body_sha256 = sha(value.html);
    value.html_document.counts.html_bytes = Buffer.byteLength(value.html);
  }
  const keep = value => captureScraplingWorkerSource(source, { archiveRoot: root, captureProfile: SOURCE_HTML_PROFILE, capture: async () => value });
  const baseline = await keep(before), capture = await keep(after);
  return { source, baseline, previous: { ...baseline, meta: baseline }, capture };
}

describe("source-only Gravity Forms honeypot label changes", () => {
  it("recognizes the retained Company-to-LinkedIn trap without changing any retained evidence", async () => {
    const input = await inputs();
    const original = JSON.stringify(input);
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "unchanged", reason: "gravity_forms_honeypot_label_only",
      publishable: false, baseline_advance_allowed: false, retain_both_captures: true });
    expect(JSON.stringify(input)).toBe(original);
  });
  it("continues to require normal change review when the trap is inside main", async () => {
    const input = await inputs((before, after) => {
      for (const value of [before, after]) {
        value.html = value.html.replace("</main>", "").replace("</form>", "</form></main>");
        value.source_main_document.text = value.html_document.text;
        value.source_main_document.blocks = structuredClone(value.html_document.blocks);
      }
    });
    expect(buildScraplingReviewDiff(input)).toMatchObject({ status: "changed_needs_review", publishable: false,
      baseline_advance_allowed: false });
  });
  it.each([
    ["an award requirement also changes", (_before, after) => {
      for (const doc of [after.html_document, after.source_main_document]) {
        doc.text = doc.text.replace("before August 1", "before July 1");
        doc.blocks[0].text = doc.blocks[0].text.replace("before August 1", "before July 1");
      }
      after.html = after.html.replace("before August 1", "before July 1");
    }],
    ["additional outside-main prose changes", (before, after) => {
      for (const [value, text] of [[before, "Contact admissions."], [after, "Contact the program director."]]) {
        value.html = value.html.replace("</body>", `<p>${text}</p></body>`);
        value.html_document.text += ` ${text}`; value.html_document.blocks.push(block("p", text));
      }
    }],
    ["the trap is inside another role=main", (before, after) => {
      for (const value of [before, after]) value.html = value.html.replace("<form ", '<div role="main"><form ').replace("</form>", "</form></div>");
    }],
    ["another honeypot marker makes the match ambiguous", (_before, after) => {
      after.html = after.html.replace("</body>", '<div class="gform_validation_container"></div></body>');
    }],
    ["a required input control is missing", (_before, after) => { after.html = after.html.replace(/<input[^>]+\/>/, ""); }],
    ["one of the required container markers is missing", (_before, after) => { after.html = after.html.replace("gfield--type-honeypot ", ""); }],
    ["the label is no longer bound to the input", (_before, after) => { after.html = after.html.replace("for='input_5_10'", "for='input_5_11'"); }],
    ["the input has a nonempty value", (_before, after) => { after.html = after.html.replace("value=''", "value='required'"); }],
    ["the standard disclaimer is changed", (_before, after) => { after.html = after.html.replace(disclaimer, "Enter your company to apply."); }],
    ["another document counter changes", (_before, after) => { after.html_document.counts.nodes += 1; }],
    ["an outside-main link destination also changes", (before, after) => {
      for (const [value, href] of [[before, "/contact"], [after, "/apply"]]) {
        value.html = value.html.replace("</body>", `<a href="${href}">Contact</a></body>`);
        value.html_document.text += " Contact";
        value.html_document.links.push({ text: "Contact", raw_href: href, source_url: source.url, base_hrefs: [], heading_path: [], list_path: [] });
      }
    }],
    ["other full-body prose is not accounted for by blocks", (_before, after) => {
      after.html = after.html.replace("</body>", "Additional application requirement.</body>");
      after.html_document.text += " Additional application requirement.";
    }],
    ["the changed block appears elsewhere as well", (before, after) => {
      for (const value of [before, after]) {
        const text = value.html_document.blocks[1].text;
        value.html = value.html.replace("</body>", `<p>${text}</p></body>`);
        value.html_document.text += ` ${text}`; value.html_document.blocks.push(block("p", text));
      }
    }],
  ])("continues to hold when %s", async (_label, mutate) => {
    const input = await inputs(mutate), original = JSON.stringify(input), result = buildScraplingReviewDiff(input);
    expect(result.status).toBe("manual_review_required");
    expect(result).toMatchObject({ publishable: false, baseline_advance_allowed: false });
    expect(JSON.stringify(input)).toBe(original);
  });
});
