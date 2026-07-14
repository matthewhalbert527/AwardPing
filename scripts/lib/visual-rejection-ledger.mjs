import { visualReviewEvidenceSignatureFromStoredCandidate } from "./visual-review-queue.mjs";

export const visualRejectionLedgerTable = "shared_award_visual_rejection_ledger";

export function visualRejectionLedgerRecord({
  candidate,
  policyIdentity,
  rejectionReason,
  now = new Date().toISOString(),
}) {
  const sourceId = candidate?.shared_award_source_id || candidate?.prompt_payload?.source?.id || null;
  const policyHash = cleanText(policyIdentity?.hash);
  if (!sourceId || !policyHash) return null;

  return {
    shared_award_source_id: sourceId,
    candidate_id: candidate?.id || null,
    evidence_signature: visualReviewEvidenceSignatureFromStoredCandidate(candidate),
    policy_id: cleanText(policyIdentity?.id) || null,
    policy_version: cleanText(policyIdentity?.version) || null,
    policy_hash: policyHash,
    rejection_reason: cleanText(rejectionReason) || "policy_rejected",
    previous_text_hash: cleanText(candidate?.previous_text_hash) || null,
    new_text_hash: cleanText(candidate?.new_text_hash) || null,
    previous_image_hash: cleanText(candidate?.previous_image_hash) || null,
    new_image_hash: cleanText(candidate?.new_image_hash) || null,
    previous_file_hash: cleanText(candidate?.previous_file_hash) || null,
    new_file_hash: cleanText(candidate?.new_file_hash) || null,
    comparison_snapshot_ref: {
      previous_snapshot_ref: objectValue(candidate?.previous_snapshot_ref),
      rejected_snapshot_ref: objectValue(candidate?.new_snapshot_ref),
    },
    deterministic_diff: objectValue(
      candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff,
    ),
    first_rejected_at: now,
    last_seen_at: now,
    seen_count: 1,
  };
}

export async function findVisualRejectionLedgerMatch(
  supabase,
  { sourceId, evidenceSignature, policyHash },
) {
  if (!sourceId || !evidenceSignature || !policyHash) return { match: null, unavailable: false };
  const { data, error } = await supabase
    .from(visualRejectionLedgerTable)
    .select("id,rejection_reason,last_seen_at,seen_count")
    .eq("shared_award_source_id", sourceId)
    .eq("evidence_signature", evidenceSignature)
    .eq("policy_hash", policyHash)
    .maybeSingle();
  if (error) {
    if (isMissingWorkerStateTableError(error)) return { match: null, unavailable: true };
    throw error;
  }
  return { match: data || null, unavailable: false };
}

export async function touchVisualRejectionLedgerMatch(supabase, match, now = new Date().toISOString()) {
  if (!match?.id) return;
  const { error } = await supabase
    .from(visualRejectionLedgerTable)
    .update({
      last_seen_at: now,
      seen_count: Math.max(1, Number(match.seen_count || 0) + 1),
      updated_at: now,
    })
    .eq("id", match.id);
  if (error && !isMissingWorkerStateTableError(error)) throw error;
}

export async function recordVisualRejectionLedger(
  supabase,
  { candidate, policyIdentity, rejectionReason, now = new Date().toISOString() },
) {
  const row = visualRejectionLedgerRecord({ candidate, policyIdentity, rejectionReason, now });
  if (!row) return { recorded: false, reason: "missing_ledger_identity" };

  const existing = await findVisualRejectionLedgerMatch(supabase, {
    sourceId: row.shared_award_source_id,
    evidenceSignature: row.evidence_signature,
    policyHash: row.policy_hash,
  });
  if (existing.unavailable) return { recorded: false, reason: "ledger_table_missing" };
  if (existing.match) {
    return updateVisualRejectionLedgerMatch(supabase, existing.match, row, now);
  }

  const { data, error } = await supabase
    .from(visualRejectionLedgerTable)
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    if (isMissingWorkerStateTableError(error)) {
      return { recorded: false, reason: "ledger_table_missing" };
    }
    if (error.code === "23505") {
      const raced = await findVisualRejectionLedgerMatch(supabase, {
        sourceId: row.shared_award_source_id,
        evidenceSignature: row.evidence_signature,
        policyHash: row.policy_hash,
      });
      if (raced.unavailable) return { recorded: false, reason: "ledger_table_missing" };
      if (raced.match) {
        return updateVisualRejectionLedgerMatch(supabase, raced.match, row, now);
      }
    }
    throw error;
  }
  return { recorded: true, created: true, id: data?.id || null };
}

async function updateVisualRejectionLedgerMatch(supabase, match, row, now) {
  const { error } = await supabase
    .from(visualRejectionLedgerTable)
    .update({
      candidate_id: row.candidate_id,
      rejection_reason: row.rejection_reason,
      comparison_snapshot_ref: row.comparison_snapshot_ref,
      deterministic_diff: row.deterministic_diff,
      last_seen_at: now,
      seen_count: Math.max(1, Number(match.seen_count || 0) + 1),
      updated_at: now,
    })
    .eq("id", match.id);
  if (error) {
    if (isMissingWorkerStateTableError(error)) {
      return { recorded: false, reason: "ledger_table_missing" };
    }
    throw error;
  }
  return { recorded: true, created: false, id: match.id };
}

export function isMissingWorkerStateTableError(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return (
    error?.code === "PGRST204" ||
    error?.code === "PGRST205" ||
    /does not exist|could not find the table|schema cache|relation .* not found/i.test(message)
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value || "").trim();
}
