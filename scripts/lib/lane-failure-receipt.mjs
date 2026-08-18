export const LANE_FAILURE_RECEIPT_PREFIX = "AWARDPING_LANE_FAILURE ";
export const LANE_FAILURE_RECEIPT_SCHEMA_VERSION = "awardping.lane-failure.v1";
const ALLOWED_LANE_FAILURES = new Set([
  "manual_quarantine:database_statement_timeout",
  "manual_quarantine:registry_sync_failed",
]);

export function formatLaneFailureReceipt(input) {
  return `${LANE_FAILURE_RECEIPT_PREFIX}${JSON.stringify(normalizeReceipt(input))}`;
}

export function parseLaneFailureReceipt(output) {
  const tail = String(output || "").slice(-32_768);
  const lines = tail.split(/\r?\n/).reverse();
  for (const line of lines) {
    const markerIndex = line.indexOf(LANE_FAILURE_RECEIPT_PREFIX);
    if (markerIndex < 0) continue;
    try {
      const value = JSON.parse(line.slice(markerIndex + LANE_FAILURE_RECEIPT_PREFIX.length));
      if (value?.schema_version !== LANE_FAILURE_RECEIPT_SCHEMA_VERSION) continue;
      return normalizeReceipt(value);
    } catch {
      // A malformed or truncated marker is not evidence. Keep looking for the
      // last complete receipt and otherwise fall back to the child exit code.
    }
  }
  return null;
}

function normalizeReceipt(input) {
  const laneKey = safeCode(input?.lane_key, "lane_key");
  const failureCode = safeCode(input?.failure_code, "failure_code");
  if (!ALLOWED_LANE_FAILURES.has(`${laneKey}:${failureCode}`)) {
    throw new Error("lane_key and failure_code are not an allowlisted failure contract.");
  }
  return {
    schema_version: LANE_FAILURE_RECEIPT_SCHEMA_VERSION,
    lane_key: laneKey,
    failure_code: failureCode,
    retry_automatic: input?.retry_automatic === true,
    creates_api_charge: input?.creates_api_charge === true,
  };
}

function safeCode(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,99}$/.test(text)) {
    throw new Error(`${label} must be a bounded lowercase machine code.`);
  }
  return text;
}
