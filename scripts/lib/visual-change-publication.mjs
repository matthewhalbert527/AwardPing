export async function persistVisualChangeAndReconciliation({
  eventIdentity = {},
  upsertEvent,
  findExistingEvent,
  enqueueReconciliation,
} = {}) {
  try {
    const inserted = await upsertEvent(eventIdentity);
    let event = inserted || null;
    const duplicate = !event?.id;
    if (duplicate) event = await findExistingEvent(eventIdentity);
    if (!event?.id) {
      return {
        action: "retry",
        reason: "change_event_identity_unresolved",
        event_id: null,
        duplicate,
      };
    }

    const reconciliation = await enqueueReconciliation(event.id);
    if (!durableReconciliation(reconciliation)) {
      return {
        action: "retry",
        reason: reconciliation?.reason || "award_reconciliation_enqueue_failed",
        event_id: event.id,
        duplicate,
      };
    }
    return {
      action: "publish",
      reason: "change_event_and_reconciliation_durable",
      event_id: event.id,
      duplicate,
      reconciliation,
    };
  } catch (error) {
    return {
      action: "retry",
      reason: "change_event_publication_error",
      event_id: null,
      duplicate: false,
      error: errorMessage(error),
    };
  }
}

function durableReconciliation(value) {
  if (!value?.id) return false;
  return value.queued === true || value.coalesced === true ||
    ["pending", "processing"].includes(value.status);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
