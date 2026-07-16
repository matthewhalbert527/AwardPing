import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentVisualReviewPolicyIdentity } from "./lib/visual-review-queue.mjs";

const worker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716171409_recover_rejected_initial_document_candidates.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("rejected initial-document zero-charge recovery", () => {
  it("revalidates the immutable result and current global policy before the CAS RPC", () => {
    const body = functionBody(
      worker,
      "async function recoverRejectedInitialOfficialDocumentCandidates",
    );
    expect(body).toContain('.eq("candidate_scope", INITIAL_OFFICIAL_DOCUMENT_SCOPE)');
    expect(body).toContain('.eq("status", "rejected")');
    expect(body).toContain(
      '.eq("rejection_reason", "missing_deterministic_applicant_fact_signal")',
    );
    expect(body).toContain("initialOfficialDocumentPublicationDecision");
    expect(body).toContain("latestVisualReviewPolicyDecision");
    expect(body).toContain("initialDocumentCurrentPolicyShadow(candidate)");
    expect(body).toContain("candidate: currentPolicyShadow");
    expect(body.indexOf("initialOfficialDocumentPublicationDecision")).toBeLessThan(
      body.indexOf('"recover_rejected_initial_official_document_candidate"'),
    );
    expect(body.indexOf("latestVisualReviewPolicyDecision")).toBeLessThan(
      body.indexOf('"recover_rejected_initial_official_document_candidate"'),
    );
    expect(body).toContain("p_expected_candidate_signature: candidate.candidate_signature");
    expect(body).toContain("p_expected_candidate_evidence_signature: candidateEvidenceSignature");
    expect(body).toContain("p_expected_quarantine_evidence_hash: quarantine.evidence_hash");
    expect(body).toContain("initial_document_zero_charge_recovery_publication_guard");
    expect(body).toContain("initial_document_zero_charge_recovery_current_policy");
    expect(body).not.toContain("recordInitialOfficialDocumentPublicationQuarantine({");
  });

  it("publishes recovered rows in the same pass without entering Gemini submission", () => {
    const poll = functionBody(worker, "async function pollExistingBatches");
    expect(poll).toContain("await recoverRejectedInitialOfficialDocumentCandidates()");
    expect(poll).toContain("await reconcileStoredSucceededCandidates(recoveredCandidateIds)");
    expect(poll).toContain("policyRefreshedRecoveredCandidateIds");
    expect(poll).toContain("{ priorityOnly: true }");
    expect(poll.indexOf("recoverRejectedInitialOfficialDocumentCandidates")).toBeLessThan(
      poll.indexOf("fetchGeminiJson"),
    );
    const reconcile = functionBody(worker, "async function reconcileStoredSucceededCandidates");
    expect(reconcile).toContain('.in("id", priorityCandidateIds)');
    expect(reconcile).toContain("policyRefreshedPriorityCandidateIds.push(candidate.id)");
    expect(reconcile).toContain("return policyRefreshedPriorityCandidateIds");
    expect(reconcile).toContain('candidate.candidate_scope === INITIAL_OFFICIAL_DOCUMENT_SCOPE\n        ? {}');
    const publisher = functionBody(worker, "async function publishInitialOfficialDocumentCandidate");
    expect(publisher).toContain(
      'rejection_disposition: "resolved_by_initial_document_publication"',
    );
    expect(publisher.indexOf('status: "published"')).toBeLessThan(
      publisher.indexOf("resolveInitialOfficialDocumentPublicationQuarantine(candidate)"),
    );
  });

  it("allows only the exact unassigned quarantine and immutable zero-charge candidate", () => {
    for (const contract of [
      "security definer",
      "set search_path = ''",
      "v_candidate.status <> 'rejected'",
      "missing_deterministic_applicant_fact_signal",
      "p_expected_candidate_signature",
      "p_expected_candidate_evidence_signature",
      "p_expected_quarantine_evidence_hash",
      "manual_quarantine_evidence_hash(v_quarantine.evidence)",
      "v_candidate.model is not null",
      "v_candidate.gemini_batch_name is not null",
      "v_candidate.estimated_cost_usd is not null",
      "v_candidate.actual_usage, '{}'::jsonb",
      "api_review_required",
      "creates_api_charge",
      "shared_award_change_events",
      "shared_award_change_event_visual_evidence",
      "v_acquisition.notification_mode <> 'first_capture_candidate'",
      "v_award.status <> 'active'",
      "v_quarantine.status <> 'quarantined'",
      "manual_quarantine_operator_assignments",
      "to service_role",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toContain("not coalesce(");
    expect(currentVisualReviewPolicyIdentity().hash).toMatch(
      /^fnv1a32x2-utf16:[0-9a-f]{16}$/,
    );
    expect(migration).toContain("^fnv1a32x2-utf16:[0-9a-f]{16}$");
    expect(migration).not.toMatch(/update public\.manual_quarantine_registry[\s\S]*status\s*=\s*'resolved'/i);
  });

  it("changes only retry state and audit metadata, never immutable evidence", () => {
    const update = migration.slice(
      migration.indexOf("update public.shared_award_visual_review_candidates candidate"),
      migration.indexOf("where candidate.id = v_candidate.id"),
    );
    expect(update).toContain("status = 'succeeded'");
    expect(update).toContain("rejection_reason = null");
    expect(update).toContain("'submits_ai', false");
    expect(update).toContain("'quarantine_resolves_only_after_publication', true");
    for (const immutableColumn of [
      "candidate_signature =",
      "source_acquisition_id =",
      "deterministic_diff =",
      "prompt_payload =",
      "ai_result =",
      "new_file_hash =",
      "previous_file_hash =",
    ]) {
      expect(update).not.toContain(immutableColumn);
    }
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const nextAsync = source.indexOf("\nasync function ", start + signature.length);
  const nextSync = source.indexOf("\nfunction ", start + signature.length);
  const candidates = [nextAsync, nextSync].filter((value) => value >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}
