export async function persistVisualChangeAndReconciliation({
  eventIdentity = {},
  publishEventWithEvidence,
  enqueueReconciliation,
} = {}) {
  let publication = null;
  try {
    publication = await publishEventWithEvidence(eventIdentity);
    if (!durableEvidencePublication(publication)) {
      return {
        action: "retry",
        reason: publication?.reason || "change_event_evidence_not_durable",
        event_id: publication?.change_event_id || null,
        evidence_id: publication?.evidence_id || null,
        duplicate: publication?.inserted === false,
      };
    }
  } catch (error) {
    return {
      action: "retry",
      reason: "change_event_evidence_publication_error",
      event_id: publication?.change_event_id || null,
      evidence_id: publication?.evidence_id || null,
      duplicate: publication?.inserted === false,
      error: errorMessage(error),
    };
  }

  const eventId = publication.change_event_id;
  const evidenceId = publication.evidence_id;
  const duplicate = publication.inserted === false;
  try {
    const reconciliation = await enqueueReconciliation(eventId);
    if (!durableReconciliation(reconciliation)) {
      return {
        action: "retry",
        reason: reconciliation?.reason || "award_reconciliation_enqueue_failed",
        event_id: eventId,
        evidence_id: evidenceId,
        duplicate,
      };
    }
    return {
      action: "publish",
      reason: "change_event_evidence_and_reconciliation_durable",
      event_id: eventId,
      evidence_id: evidenceId,
      duplicate,
      reconciliation,
    };
  } catch (error) {
    return {
      action: "retry",
      reason: "award_reconciliation_enqueue_error",
      event_id: eventId,
      evidence_id: evidenceId,
      duplicate,
      error: errorMessage(error),
    };
  }
}

function durableEvidencePublication(value) {
  return Boolean(value?.change_event_id && value?.evidence_id);
}

function durableReconciliation(value) {
  if (!value?.id) return false;
  return value.queued === true || value.coalesced === true ||
    ["pending", "processing"].includes(value.status);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
