import { rmSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSourceHtmlPublicationFixture, sourceHtmlFixtureSource as source, sourceHtmlFixtureCandidateId as candidateId,
  sourceHtmlFixtureDetails as details, sourceHtmlFixtureEvent as event } from "../../scripts/test-support/source-html-publication-fixture.mjs";
import { hasPublishableEventVisualEvidence, eventVisualEvidencePresentation, type PublicChangeEventVisualEvidence } from "./public-change-event";
import { buildEventVisualEvidenceSide } from "./change-event-visual-evidence";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";

vi.mock("server-only", () => ({}));

const props = { changeEventId: event.id, sourceId: source.id, sourceTitle: source.title, sourceUrl: source.url,
  changeSummary: event.summary, changeDetails: details };
let root: string;
let evidence: PublicChangeEventVisualEvidence;

beforeAll(async () => {
  const fixture = await createSourceHtmlPublicationFixture();
  root = fixture.root;
  evidence = fixture.evidence as PublicChangeEventVisualEvidence;
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("source-only public presentation contract", () => {
  it("accepts the actual immutable publisher output without inventing visual verification", () => {
    expect(hasPublishableEventVisualEvidence(event, evidence)).toBe(true);
    expect(eventVisualEvidencePresentation(event, evidence)).toEqual({ evidenceStatus: "not_applicable_source_html", exactCropAllowed: false, fallbackReason: null });
  });

  it.each(["schema", "status", "signature", "event", "award", "source", "profile", "kind", "acquisition", "url", "final-url", "timestamp",
    "order", "visible", "screenshot", "crop", "layout", "extra-object", "image-hash", "html-hash", "missing-hash", "path", "bytes", "content-type",
    "verified-at", "backfilled-at", "localization-extra", "localization-status", "exact-overlap", "required", "semantic", "digest", "extra-side"])
  ("rejects %s corruption rather than falling back to browser authority", mutation => {
    const value = structuredClone(evidence);
    const current = value.current_capture as Record<string, unknown>;
    const artifact = current.full as Record<string, unknown>;
    const hashes = current.capture_hashes as Record<string, unknown>;
    const localization = value.localization as Record<string, unknown>;
    const sides = localization.sides as Record<string, Record<string, unknown>>;
    if (mutation === "schema") value.evidence_schema_version = "visual-event-evidence-v2";
    if (mutation === "status") value.evidence_status = "full_screenshot_fallback";
    if (mutation === "signature") value.candidate_signature = "b".repeat(64);
    if (mutation === "event") value.change_event_id = "other";
    if (mutation === "award") current.shared_award_id = "other";
    if (mutation === "source") current.source_id = "other";
    if (mutation === "profile") current.capture_profile = "scrapling-evidence-v1";
    if (mutation === "kind") current.kind = "image";
    if (mutation === "acquisition") current.acquisition = "browser";
    if (mutation === "url") current.source_url = "https://example.edu/other";
    if (mutation === "final-url") current.final_url = "https://example.edu/other";
    if (mutation === "timestamp") current.captured_at = "invalid";
    if (mutation === "order") current.captured_at = "2026-10-18T17:00:00.000Z";
    if (mutation === "visible") current.visibility_verified = true;
    if (mutation === "screenshot") current.screenshot_available = true;
    if (mutation === "crop") current.crop = artifact;
    if (mutation === "layout") current.layout = artifact;
    if (mutation === "extra-object") artifact.url = "https://private.test/raw";
    if (mutation === "image-hash") hashes.image_hash = "f".repeat(64);
    if (mutation === "html-hash") hashes.html_sha256 = "f".repeat(64);
    if (mutation === "missing-hash") delete hashes.source_main_sha256;
    if (mutation === "path") artifact.object_key = String(artifact.object_key).replace(candidateId, "other");
    if (mutation === "bytes") artifact.byte_length = 0;
    if (mutation === "content-type") artifact.content_type = "text/html";
    if (mutation === "verified-at") value.verified_at = "2026-10-18T20:00:00.000Z";
    if (mutation === "backfilled-at") value.backfilled_at = "2026-10-18T20:00:00.000Z";
    if (mutation === "localization-extra") localization.verified = true;
    if (mutation === "localization-status") sides.current.status = "verified";
    if (mutation === "exact-overlap") sides.current.exact_overlap = true;
    if (mutation === "required") sides.current.required = true;
    if (mutation === "semantic") sides.current.semantic_verified = true;
    if (mutation === "digest") localization.change_semantics_sha256 = "f".repeat(64);
    if (mutation === "extra-side") sides.other = sides.current;
    expect(hasPublishableEventVisualEvidence(event, value)).toBe(false);
  });

  it("requires both typed display markers and the exact event wording binding", () => {
    for (const changed of [{ ...details, evidence_kind: "image" }, { ...details, capture_profile: "scrapling-evidence-v1" },
      { ...details, exact_after: "October 31, 2026" }]) {
      expect(hasPublishableEventVisualEvidence({ ...event, change_details: changed }, evidence)).toBe(false);
    }
  });

  it("never signs source HTML, metadata, text, or contradictory image claims", async () => {
    for (const marker of ["all", "kind", "profile", "status", "content-type"]) {
      const capture = structuredClone(evidence.current_capture) as Record<string, unknown>;
      const localization = { status: marker === "all" || marker === "status" ? "not_applicable_source_html" : "verified", exact_overlap: true };
      if (marker !== "all" && marker !== "kind") delete capture.kind;
      if (marker !== "all" && marker !== "profile") delete capture.capture_profile;
      capture.crop = { ...(capture.full as object), exact_overlap: true };
      const signObjectKey = vi.fn(async () => "https://signed.test/private");
      const response = await buildEventVisualEvidenceSide({ captureValue: capture, localizationValue: localization, exactCropAllowed: true, signObjectKey });
      expect(response).toMatchObject({ kind: "source_html", exact_overlap: false, objects: {}, highlights: null, state_id: null });
      expect(signObjectKey).not.toHaveBeenCalled();
    }
  });

  it("renders only the official-source action with no snapshot trigger, image, or loading placeholder", () => {
    const html = renderToStaticMarkup(createElement(ChangeEvidencePanel, props));
    expect(html).toContain(`href="${source.url}"`);
    expect(html).toContain("Official source");
    expect(html).not.toMatch(/<button|<img|screenshot|Snapshot|Loading|Changed section/i);
  });

});
