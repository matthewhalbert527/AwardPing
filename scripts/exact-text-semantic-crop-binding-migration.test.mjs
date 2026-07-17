import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260716224500_exact_text_semantic_crop_binding.sql", import.meta.url),
  "utf8",
);
const localizer = readFileSync(new URL("./lib/visual-event-localization.mjs", import.meta.url), "utf8");
const evidence = readFileSync(new URL("./lib/visual-event-evidence.mjs", import.meta.url), "utf8");
const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const publicGate = readFileSync(new URL("../src/lib/public-change-event.ts", import.meta.url), "utf8");

describe("v2 exact-text semantic crop binding migration", () => {
  it("rejects newly verified v1 crops and validates exact directional event wording", () => {
    expect(migration).toContain("new.evidence_schema_version <> 'visual-event-evidence-v2'");
    expect(migration).toContain("v1 crops are full-screenshot fallback only");
    expect(migration).toContain("awardping_visual_semantic_text_allowed");
    expect(migration).toContain("change_details.exact_before");
    expect(migration).toContain("change_details.exact_after");
    expect(migration).toContain("change_details.structured_diff.removed_text");
    expect(migration).toContain("change_details.structured_diff.added_text");
    expect(migration).toContain("change_details.changed_facts.removed_text");
    expect(migration).toContain("change_details.changed_facts.added_text");
    expect(migration).toContain("v_previous_required and v_current_required");
  });

  it("binds the semantic hash through localizer, crop, worker capture, and public presentation", () => {
    expect(localizer).toContain("VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION = 3");
    expect(localizer).toContain('VISUAL_EXACT_TEXT_BINDING_VERSION = "visual-exact-text-binding-v2"');
    expect(localizer).toContain("exact_text_not_bound_to_event_semantics");
    expect(evidence).toContain('VISUAL_EVENT_EVIDENCE_SCHEMA_VERSION = "visual-event-evidence-v2"');
    expect(evidence).toContain("semantic_binding_sha256: localization.semantic_binding.binding_sha256");
    expect(worker).toContain("final-state-text-node-geometry-with-open-sections-semantic-crop-v3");
    expect(worker).toContain('semantic_crop_contract: "visual-exact-text-binding-v2"');
    expect(publicGate).toContain("predates event-semantic wording verification");
    expect(publicGate).toContain("capturesSupportHonestFullScreenshotFallback");
  });

  it("keeps first-observation PDF evidence outside webpage crop semantics", () => {
    expect(evidence).toContain("preparePublishedInitialOfficialDocumentEvidence");
    expect(publicGate).toContain('evidence.evidence_status === "not_applicable_new_document"');
    expect(publicGate).toContain("captureHasFirstObservationAttestation");
    expect(publicGate).toContain("captureHasImmutableCurrentDocument");
  });
});
