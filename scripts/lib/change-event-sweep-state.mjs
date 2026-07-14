export const monitoringPolicySweepStateTable = "monitoring_policy_sweep_state";

export function monitoringPolicySweepKey({ awardId = null, sourceId = null } = {}) {
  return ["change-event-noise", awardId || "all-awards", sourceId || "all-sources"].join(":");
}

export function monitoringPolicySweepStart(state, policyHash) {
  const normalizedPolicyHash = cleanText(policyHash);
  const reset = !state || cleanText(state.policy_hash) !== normalizedPolicyHash;
  return {
    reset,
    cursor: reset
      ? null
      : monitoringPolicySweepCursor({
          detected_at: state?.cursor_detected_at,
          id: state?.cursor_event_id,
        }),
    scanned_count: reset ? 0 : nonNegativeInt(state?.scanned_count),
  };
}

export function monitoringPolicySweepCursor(row) {
  const detectedAt = cleanText(row?.detected_at || row?.cursor_detected_at);
  const eventId = cleanText(row?.id || row?.event_id || row?.cursor_event_id);
  return detectedAt && eventId
    ? { detected_at: detectedAt, event_id: eventId }
    : null;
}

export function monitoringPolicySweepCursorAfterRows(rows, fallback = null) {
  if (!Array.isArray(rows) || !rows.length) return fallback;
  return monitoringPolicySweepCursor(rows[rows.length - 1]) || fallback;
}

export function monitoringPolicySweepKeysetFilter(cursor) {
  const normalized = monitoringPolicySweepCursor(cursor);
  if (!normalized) return null;
  return [
    `detected_at.gt.${normalized.detected_at}`,
    `and(detected_at.eq.${normalized.detected_at},id.gt.${normalized.event_id})`,
  ].join(",");
}

export function isMissingMonitoringPolicySweepStateError(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return (
    error?.code === "PGRST204" ||
    error?.code === "PGRST205" ||
    /does not exist|could not find the table|schema cache|relation .* not found/i.test(message)
  );
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function cleanText(value) {
  return String(value || "").trim();
}
