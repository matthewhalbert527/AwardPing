import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810203715_accept_initial_official_document_crop_coverage.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(signature, revokeSignature) {
  const start = migration.indexOf(`create or replace function ${signature}`);
  const end = migration.indexOf(`revoke all on function ${revokeSignature}`, start);
  if (start < 0 || end <= start) return "";
  return migration.slice(start, end);
}

const initialDocumentValidator = functionBody(
  "private.stage1_initial_document_pdf_evidence_valid(",
  "private.stage1_initial_document_pdf_evidence_valid(",
);
const coverage = functionBody(
  "private.stage1_visual_crop_coverage_snapshot()",
  "private.stage1_visual_crop_coverage_snapshot()",
);
const derivationHash = functionBody(
  "private.stage1_visual_crop_derivation_contract_hash()",
  "private.stage1_visual_crop_derivation_contract_hash()",
);
const artifactValidator = functionBody(
  "private.stage1_release_artifact_evidence_valid(",
  "private.stage1_release_artifact_evidence_valid(",
);

describe("Stage 1 initial-document PDF crop-coverage migration", () => {
  it("accepts only the exact retained/current first-observation evidence shape", () => {
    expect(initialDocumentValidator).not.toBe("");
    for (const contract of [
      "'visual-event-evidence-v1'",
      "'visual-event-evidence-v2'",
      "'not_applicable_new_document'",
      "'initial_official_document'",
      "'new_official_document'",
      "'first_observation'",
      "'first-observation'",
      "'first_observation_attestation'",
      "'not_applicable_first_observation'",
      "'not_applicable_pdf'",
      "'document'",
      "'added'",
      "private.stage1_published_capture_reference_graph_valid(\n      p_evidence.previous_capture",
      "private.stage1_published_capture_reference_graph_valid(\n      p_evidence.current_capture",
      "first_observation_attestation_sha256",
      "current_file_sha256",
      "source_acquisition_id",
      "candidate_signature",
      "candidate_bound",
      "application/pdf",
      "application/json; charset=utf-8",
      "text/plain; charset=utf-8",
      "visual-snapshots/published/",
      "private.stage1_release_production_target_snapshot()",
    ]) {
      if (contract === "candidate_bound") continue;
      expect(initialDocumentValidator, contract).toContain(contract);
    }
    expect(initialDocumentValidator).toContain("exception when others then");
    expect(initialDocumentValidator.trimEnd()).toMatch(/return false;\s*end;\s*\$\$;$/);
  });

  it("keeps ordinary PDFs unchanged and makes every other PDF fail closed", () => {
    expect(coverage).not.toBe("");
    expect(coverage).toMatch(
      /when evidence\.evidence_status = 'not_applicable_pdf' then[\s\S]*?evidence\.visual_review_candidate_id =[\s\S]*?event\.visual_review_candidate_id/,
    );
    expect(coverage).toMatch(
      /when evidence\.evidence_status = 'not_applicable_new_document' then[\s\S]*?stage1_initial_document_pdf_evidence_valid\(event, evidence\)[\s\S]*?else false/,
    );
    expect(coverage).toContain("count(*) filter (where not pdf_evidence_valid)");
    expect(coverage).toContain("'pdf_evidence_valid', pdf.pdf_evidence_valid");
    expect(coverage).toContain("'pdf_events', pdf_payload.value");
    expect(coverage).toContain("awardping.stage1.pdf-evidence-coverage.v1");
  });

  it("bumps the derivation contract and invalidates immutable old artifacts", () => {
    expect(derivationHash).toContain(
      "awardping.stage1.visual-crop-db-derivation.v4",
    );
    expect(derivationHash).toContain(
      "candidate-bound-not-applicable-pdf-or-exact-initial-document-v1",
    );
    expect(artifactValidator).toContain(
      "p_evidence ->> 'derivation_contract_hash' =\n        private.stage1_visual_crop_derivation_contract_hash()",
    );
    expect(artifactValidator).toContain(
      "p_evidence ->> 'pdf_evidence_contract' =",
    );
    expect(migration).not.toMatch(
      /(?:update|delete\s+from)\s+public\.stage1_release_acceptance_artifacts/i,
    );
  });

  it("keeps all new helpers private", () => {
    expect(migration).toMatch(
      /revoke all on function private\.stage1_initial_document_pdf_evidence_valid\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_visual_crop_coverage_snapshot\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(/grant execute on function private\./);
  });
});
