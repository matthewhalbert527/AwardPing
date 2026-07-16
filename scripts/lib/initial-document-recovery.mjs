import { rebuildInitialOfficialDocumentCandidateForCurrentPolicy } from "./visual-review-queue.mjs";

/**
 * Builds an in-memory current-policy view for historical validation only.
 * The stored candidate remains untouched so the database recovery RPC can
 * compare-and-set its original signature and immutable evidence identity.
 */
export function initialDocumentCurrentPolicyShadow(candidate = {}) {
  const rebuilt = rebuildInitialOfficialDocumentCandidateForCurrentPolicy(candidate);
  return {
    ...candidate,
    candidate_signature: rebuilt.candidate_signature,
    prompt_payload: rebuilt.prompt_payload,
    worker_metadata: {
      ...(candidate.worker_metadata && typeof candidate.worker_metadata === "object"
        ? candidate.worker_metadata
        : {}),
      monitoring_policy: rebuilt.monitoring_policy,
      monitoring_policy_bundle: rebuilt.prompt_payload.monitoring_policy_bundle,
      initial_document_recovery_shadow_validation: true,
    },
  };
}
