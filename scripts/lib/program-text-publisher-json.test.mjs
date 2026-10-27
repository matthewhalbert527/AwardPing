import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { load } from "cheerio";
import { syntheticPublisherJsonObservation } from "../fixtures/program-text-publisher-json.mjs";
import { captureProgramTextSource, buildProgramTextCapture, validateProgramTextCapture } from "./program-text-capture.mjs";
import { programTextArtifactMap, programTextReference, validateProgramTextReference, loadProgramTextCapture } from "./program-text-artifacts.mjs";
import { validateScraplingPublisherJsonObservation, publisherJsonObservationMetadata, restorePublisherJsonObservation } from "./program-text-publisher-json.mjs";
import { projectSmartPublisherJson, PROJECTOR_VERSION } from "./program-text-smart-publisher-json.mjs";
import { programTextPublisherJsonSourceProfile } from "./program-text-capture-contract.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, validateProgramTextReviewResult } from "./program-text-review.mjs";
import { monitorProgramTextSource } from "./program-text-monitor.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec";
export function syntheticPublisherCapture(key = "home", options = {}) {
  const { source, observation } = syntheticPublisherJsonObservation(key, options);
  const raw = Buffer.from(observation.raw_json), projection = projectSmartPublisherJson(raw, { source });
  return buildProgramTextCapture({ source, captured_at: observation.captured_at, acquisition: "publisher_json",
    extractor: { name: "smart-publisher-json", version: programTextPublisherJsonSourceProfile(source)?.version ?? PROJECTOR_VERSION }, raw_bytes: raw, content_type: "application/json",
    text: projection.text, blocks: projection.blocks,
    publisher_json: { observation: publisherJsonObservationMetadata(observation, { source }), projection: projection.provenance } });
}

describe("complete retained publisher JSON observations", () => {
  it.each(["faq", "submit", "instructions"])("%s metadata and typed labels cannot hide an empty or loading-only article body", key => {
    const edit = text => document => {
      const data = document.result.containers[3].rows[0].columns[0].widgets[0].widget.data, $ = load(data.text, {}, false);
      // Preserve every reviewed anchor/tooltip signature. The completeness
      // rejection must be about body prose, not an incidental model mismatch.
      const anchors = $("a").toArray().map(el => { const link = $(el).clone(); link.empty(); return $.html(link); }).join("");
      data.text = `<p>${text}</p><p>${anchors}</p>`;
    };
    for (const text of ["", "Loading...", "Please wait. Skip to page content"]) expect(() => syntheticPublisherCapture(key, { edit: edit(text) })).toThrow(/publisher_json_article_body_incomplete/);
    const short = syntheticPublisherCapture(key, { edit: edit("Applications closed.") });
    expect(short.completeness.status).toBe("complete"); expect(short.text).toContain("Applications closed.");
  });
  it.each(["http_html", "rendered_html"])("reserved publisher name/versions cannot masquerade as otherwise-valid %s evidence", acquisition => {
    const source = syntheticPublisherJsonObservation("home").source, text = "Complete synthetic application details for ordinary HTML.";
    const input = { source, captured_at: "2026-10-27T04:00:00.000Z", acquisition, raw_bytes: Buffer.from(`<html><body>${text}</body></html>`),
      content_type: "text/html", text, blocks: [{ id: "body", text, start_utf16: 0, end_utf16: text.length }],
      extractor: { name: "synthetic-html", version: "synthetic-v1" } };
    const control = buildProgramTextCapture(input), controlRef = programTextReference(control);
    expect(validateProgramTextCapture(control)).toBe(control); expect(validateProgramTextReference(controlRef)).toBe(controlRef);
    expect(controlRef.artifacts.raw.object_key).toMatch(/\/original\.html$/); expect(controlRef.artifacts.raw.content_type).toBe("text/html");
    for (const extractor of [{ name: "smart-publisher-json", version: "synthetic-v1" },
      { name: "synthetic-html", version: "smart-publisher-json-v1" }, { name: "synthetic-html", version: "smart-publisher-json-kb-v1" }]) {
      expect(() => buildProgramTextCapture({ ...input, extractor })).toThrow(/invalid_publisher_json_provenance/);
      const forgedRef = structuredClone(controlRef); forgedRef.extractor = extractor;
      expect(() => validateProgramTextReference(forgedRef)).toThrow(/invalid_publisher_json_reference/);
    }
  });
  it.each(["home", "eligibility", "faq", "submit", "instructions", "home_alias"])("retains and cold-restores exact %s original with deterministic programme projection", async key => {
    const capture = syntheticPublisherCapture(key), reference = validateProgramTextReference(programTextReference(capture));
    expect(reference.artifacts.raw.object_key).toMatch(/\/original\.json$/);
    expect(reference.artifacts.raw.content_type).toBe("application/json");
    const artifacts = programTextArtifactMap(capture), objects = new Map(artifacts.map(item => [item.binding.object_key, item.body]));
    const calls = [];
    const restored = await loadProgramTextCapture(reference, { bucket: "synthetic", client: { async send(command) {
      calls.push(command); const bytes = objects.get(command.input.Key); return { Body: Readable.from([bytes]), ContentLength: bytes.length };
    } } });
    expect(restored).toEqual(capture); expect(calls).toHaveLength(3);
    expect(JSON.parse(artifacts.find(a => a.role === "metadata").body).publisher_json.observation.raw_json).toBeUndefined();
  });
  it.each(["home", "eligibility", "faq", "submit", "instructions", "home_alias"])("explicit %s adapter uses the typed observation without the ordinary HTTP or HTML path", async key => {
    const { source, observation } = syntheticPublisherJsonObservation(key); let calls = 0;
    const result = await captureProgramTextSource({ source, acquisition: "publisher_json", publisher_json_profile: "smart-page-v1",
      adapters: { publisherJson: async (actual, options) => { calls++; expect(actual).toEqual(source); expect(options.publisherJsonProfile).toBe("smart-page-v1"); return observation; },
        fetch: async () => { throw new Error("Unexpected ordinary fetch"); }, htmlExtraction: async () => { throw new Error("Unexpected HTML extraction"); } } });
    expect(calls).toBe(1); expect(result).toEqual(syntheticPublisherCapture(key));
  });
  it("accepts retained Python microseconds and rejects rolled-over calendar dates", () => {
    const { source, observation } = syntheticPublisherJsonObservation("home", { captured_at: "2026-10-27T04:00:00.123456Z" });
    expect(validateScraplingPublisherJsonObservation(observation, { source }).captured_at).toBe(observation.captured_at);
    observation.captured_at = "2026-02-30T04:00:00.000Z";
    expect(() => validateScraplingPublisherJsonObservation(observation, { source })).toThrow(/observation_shape/);
  });
  it.each([
    ["text", c => { c.text = c.text.replace("Synthetic", "Fabricated"); c.text_sha256 = sha(c.text); }],
    ["projection", c => { c.publisher_json.projection.semantic_scope = "Unverified replacement"; }],
    ["transport", c => { c.publisher_json.observation.response.from_cache = true; }],
    ["unexpected document base", c => { c.publisher_json.observation.navigation.base_hrefs = ["https://elsewhere.example/"]; }],
    ["JSON original", c => { c.raw_source.bytes = Buffer.from('{"other":true}'); c.raw_source.byte_length = c.raw_source.bytes.length; c.raw_source.sha256 = sha(c.raw_source.bytes); }],
    ["wrong owner", c => { c.source.shared_award_id = "11111111-1111-4111-8111-111111111111"; }],
    ["omitted provenance", c => { delete c.publisher_json; }],
    ["unknown metadata", c => { c.publisher_json.observation.raw_json = "hidden duplicate"; }],
    ["changed extractor", c => { c.extractor.version = "unreviewed"; }],
    ["pretend HTML", c => { c.acquisition = "rendered_html"; c.raw_source.content_type = "text/html"; }],
  ])("rejects tampered %s rather than accepting partial programme evidence", (_label, edit) => {
    const capture = syntheticPublisherCapture(); edit(capture); expect(() => validateProgramTextCapture(capture)).toThrow();
  });
  it("rejects extra restore metadata and exact original byte changes", () => {
    const { source, observation } = syntheticPublisherJsonObservation(), metadata = publisherJsonObservationMetadata(observation, { source });
    expect(() => restorePublisherJsonObservation({ ...metadata, raw_json: observation.raw_json }, Buffer.from(observation.raw_json), { source })).toThrow();
    expect(() => restorePublisherJsonObservation(metadata, Buffer.from(observation.raw_json + " "), { source })).toThrow(/raw_binding/);
  });
  it.each(["home", "eligibility", "faq", "submit", "instructions", "home_alias"])("pins exact %s owner/type/version for both collection and cold references", async key => {
    const capture = syntheticPublisherCapture(key), profile = programTextPublisherJsonSourceProfile(capture.source);
    const version = ["faq", "submit", "instructions"].includes(key) ? "smart-publisher-json-kb-v1" : "smart-publisher-json-v1";
    expect(profile?.version).toBe(version); expect(capture.extractor.version).toBe(version);
    const otherVersion = version === "smart-publisher-json-v1" ? "smart-publisher-json-kb-v1" : "smart-publisher-json-v1";
    const wrongCapture = { ...capture, extractor: { ...capture.extractor, version: otherVersion } };
    expect(() => validateProgramTextCapture(wrongCapture)).toThrow(/invalid_publisher_json_provenance/);
    const wrongRef = structuredClone(programTextReference(capture)); wrongRef.extractor.version = otherVersion;
    expect(() => validateProgramTextReference(wrongRef)).toThrow(/invalid_publisher_json_reference/);
    const wrongTypeRef = structuredClone(programTextReference(capture)); wrongTypeRef.source.page_type = "other";
    expect(() => validateProgramTextReference(wrongTypeRef)).toThrow(/invalid_publisher_json_reference/);
    expect(() => validateProgramTextCapture(capture, { source: { ...capture.source, page_type: "other" } })).toThrow(/invalid_publisher_json_provenance/);
    for (const badSource of [{ ...capture.source, page_type: "other" }, { ...capture.source, page_type: undefined },
      { ...capture.source, shared_award_id: "11111111-1111-4111-8111-111111111111" }, { ...capture.source, url: capture.source.url + "&other=1" }]) {
      expect(programTextPublisherJsonSourceProfile(badSource)).toBeNull();
      let called = false;
      await expect(captureProgramTextSource({ source: badSource, acquisition: "publisher_json", publisher_json_profile: "smart-page-v1",
        adapters: { publisherJson: async () => { called = true; throw new Error("Invalid source must not capture"); } } })).rejects.toThrow(/invalid_publisher_json_mode/);
      expect(called).toBe(false);
    }
  });
  it.each(["raw path", "MIME", "owner", "URL", "extractor", "size"])("rejects invalid JSON reference %s", label => {
    const ref = programTextReference(syntheticPublisherCapture());
    if (label === "raw path") ref.artifacts.raw.object_key = ref.artifacts.raw.object_key.replace("original.json", "original.html");
    if (label === "MIME") ref.artifacts.raw.content_type = "text/html";
    if (label === "owner") ref.source.shared_award_id = "11111111-1111-4111-8111-111111111111";
    if (label === "URL") ref.source.url += "/";
    if (label === "extractor") ref.extractor.version = "unknown";
    if (label === "size") ref.artifacts.raw.byte_length = 512 * 1024 + 1;
    expect(() => validateProgramTextReference(ref)).toThrow();
  });
  it("cannot turn a changed absolute deadline into a model no-change or paid request", () => {
    const previous = syntheticPublisherCapture(), current = syntheticPublisherCapture("home", {
      captured_at: "2026-10-27T05:00:00.000Z", edit: x => { x.result.theme.header.data.wCountdown.data.countDownWidget.data.deadLine += 86400000; } });
    const comparison = buildProgramTextComparison(previous, current, { epoch, cycle_id: null });
    expect(comparison.status).toBe("review_required");
    expect(buildProgramTextReviewPackets(comparison)).toEqual({ status: "held", reasons: ["publisher_data_change_requires_review"] });
    expect(validateProgramTextReviewResult(comparison, {}, [])).toMatchObject({ status: "held", reasons: ["publisher_data_change_requires_review"] });
  });
  it("retains a changed structured value in held state without advancing the baseline or submitting a review", async () => {
    const previous = syntheticPublisherCapture(), current = syntheticPublisherCapture("home", {
      captured_at: "2026-10-27T05:00:00.000Z", edit: x => { x.result.theme.header.data.showApply = false; } });
    const before = programTextReference(previous), after = programTextReference(current);
    let state = { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: before, latest_ref: before,
      first_captured_at: before.captured_at, last_checked_at: before.captured_at, successful_checks: 2 };
    const writes = [];
    const outcome = await monitorProgramTextSource({ source: previous.source, epoch, callbacks: {
      capture: async () => current, retain: async () => after, verifyRetention: async () => current, readState: async () => state,
      loadCapture: async ref => ref.capture_id === before.capture_id ? previous : current,
      compareAndSetState: async input => { writes.push(input); state = input.next_state; return true; },
      enqueueReview: async () => { throw new Error("Structured value must not enter paid review"); },
    } });
    expect(outcome).toMatchObject({ status: "held", reason: "publisher_data_change_requires_review", creates_update: false, paid_review_required: false });
    expect(writes).toHaveLength(1); expect(state).toMatchObject({ status: "held", baseline_ref: before, latest_ref: after, successful_checks: 3 });
  });
  it("a changed excluded marketing metric preserves same programme text and needs no model", () => {
    const previous = syntheticPublisherCapture(), current = syntheticPublisherCapture("home", { captured_at: "2026-10-27T05:00:00.000Z",
      edit: (x, profile) => { const root = profile.programme_pointer.split("/").slice(1).reduce((obj, key) => obj[key], x); root.data.facilities = 99999; } });
    expect(previous.raw_source.sha256).not.toBe(current.raw_source.sha256);
    expect(previous.text_sha256).toBe(current.text_sha256);
    const comparison = buildProgramTextComparison(previous, current, { epoch, cycle_id: null });
    expect(comparison.status).toBe("unchanged"); expect(validateProgramTextReviewResult(comparison, {}, [])).toMatchObject({ status: "no_program_change" });
  });
  it.each(["home", "eligibility", "faq", "submit", "instructions", "home_alias"])("journals first meaningful %s coverage instead of comparing a historical shell with programme content", async key => {
    const current = syntheticPublisherCapture(key), after = programTextReference(current);
    const shellText = "Loading... Skip to page contentSkip to chat Skip to page contentSkip to chat";
    const before = { ...structuredClone(after), capture_id: "1".repeat(64), captured_at: "2026-10-25T23:00:00.000Z", acquisition: "http_html",
      extractor: { name: "scrapling-full-body-html", version: "program-text-v1/html-document-v2" }, text_length: shellText.length, text_sha256: sha(shellText), blocks_sha256: "2".repeat(64) };
    const prefix = `program-text/sources/${current.source.id}/${before.capture_id}/`;
    for (const [role, artifact] of Object.entries(before.artifacts)) artifact.object_key = prefix + (role === "raw" ? "original.html" : role === "text" ? "text.txt" : "metadata.json");
    before.artifacts.raw.content_type = "text/html"; before.artifacts.text.sha256 = before.text_sha256; before.artifacts.text.byte_length = Buffer.byteLength(shellText);
    validateProgramTextReference(before);
    const state = { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: before, latest_ref: before,
      first_captured_at: "2026-10-23T20:00:00.000Z", last_checked_at: before.captured_at, successful_checks: 5 };
    let transitions = 0;
    const callbacks = { capture: async () => current, retain: async () => after, verifyRetention: async () => current, readState: async () => state,
      loadCapture: async () => { throw new Error("A shell must never be compared to programme content"); },
      compareAndSetState: async () => { throw new Error("Generic CAS cannot authorize acquisition replacement"); },
      enqueueReview: async () => { throw new Error("First coverage cannot enter paid review"); },
      transitionKnownHtmlShell: async input => { transitions++; expect(input.expected_state).toEqual(state);
        expect(input.next_state).toMatchObject({ baseline_ref: after, latest_ref: after, successful_checks: 1, first_captured_at: after.captured_at });
        return { applied: true, journal_id: "11111111-1111-4111-8111-111111111111", state: input.next_state, initial_coverage: true, creates_update: false }; } };
    const outcome = await monitorProgramTextSource({ source: current.source, epoch, callbacks });
    expect(outcome).toMatchObject({ status: "baseline_ready", initial_coverage: true, creates_update: false }); expect(transitions).toBe(1);
    expect(after.extractor.version).toBe(programTextPublisherJsonSourceProfile(current.source).version);
    const blocked = await monitorProgramTextSource({ source: current.source, epoch, callbacks: { ...callbacks, transitionKnownHtmlShell: undefined } });
    expect(blocked).toMatchObject({ status: "held", reason: "extraction_configuration_changed" });
    const journalMissing = await monitorProgramTextSource({ source: current.source, epoch, callbacks: { ...callbacks,
      transitionKnownHtmlShell: async input => ({ applied: true, state: input.next_state, initial_coverage: true, creates_update: false }) } });
    expect(journalMissing).toMatchObject({ status: "held", reason: "meaningful_first_coverage_unconfirmed" });
    const denied = await monitorProgramTextSource({ source: current.source, epoch, callbacks: { ...callbacks,
      transitionKnownHtmlShell: async () => { throw new Error("Existing unresolved comparison prevents transition"); } } });
    expect(denied).toMatchObject({ status: "held", reason: "meaningful_first_coverage_transition_failed" });
    const identityMismatch = await monitorProgramTextSource({ source: { ...current.source, page_type: "other" }, epoch, callbacks });
    expect(identityMismatch.status).toBe("held"); expect(transitions).toBe(1);
    state.status = "held";
    expect(await monitorProgramTextSource({ source: current.source, epoch, callbacks })).toMatchObject({ status: "held", reason: "extraction_configuration_changed" });
    expect(transitions).toBe(1);
    // An existing paid/review pair is preserved before capture, retention or
    // the special journal callback can run. Historical queues are not cleared.
    const other = structuredClone(before); other.capture_id = "3".repeat(64); other.captured_at = "2026-10-26T00:00:00.000Z";
    for (const a of Object.values(other.artifacts)) a.object_key = a.object_key.replace(before.capture_id, other.capture_id);
    state.status = "awaiting_review"; state.latest_ref = other; state.last_checked_at = other.captured_at;
    const pending = await monitorProgramTextSource({ source: current.source, epoch, callbacks: { ...callbacks,
      capture: async () => { throw new Error("In-flight comparison must not recapture"); } } });
    expect(pending).toMatchObject({ status: "awaiting_review", reason: "existing_review_pair_preserved" }); expect(transitions).toBe(1);
  });
});
