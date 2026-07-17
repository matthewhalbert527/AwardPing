import { createHmac } from "node:crypto";

export const stage1ExternalReleaseArtifactKinds = Object.freeze([
  "hosted_runtime_identity",
  "rollback_drill",
  "non_cohort_leak_crawl",
  "r2_recovery_drill",
]);

const sha256Pattern = /^[0-9a-f]{64}$/;

/**
 * Sign the canonical payload hash returned by the artifact-kind-specific
 * producer preflight. The evidence producer must use a secret isolated from
 * the app/acceptance runtime; Postgres verifies the result against the
 * matching Supabase Vault secret.
 */
export function signStage1ReleaseEvidencePayload({ payloadHash, secret } = {}) {
  const normalizedHash = cleanText(payloadHash).toLowerCase();
  const normalizedSecret = cleanText(secret);
  if (!sha256Pattern.test(normalizedHash)) {
    throw new Error("A lowercase SHA-256 signing-payload hash is required.");
  }
  if (normalizedSecret.length < 32) {
    throw new Error("The release evidence HMAC secret must be at least 32 characters.");
  }
  return createHmac("sha256", normalizedSecret).update(normalizedHash, "utf8").digest("hex");
}

export function stage1ExternalReleaseRecorderName(kind) {
  const normalizedKind = cleanText(kind);
  const names = {
    hosted_runtime_identity: "record_stage1_hosted_runtime_identity_artifact",
    rollback_drill: "record_stage1_rollback_drill_artifact",
    non_cohort_leak_crawl: "record_stage1_non_cohort_leak_crawl_artifact",
    r2_recovery_drill: "record_stage1_r2_recovery_drill_artifact",
  };
  const name = names[normalizedKind];
  if (!name) throw new Error(`Unsupported Stage 1 external evidence kind: ${normalizedKind || "missing"}.`);
  return name;
}

export function stage1ExternalReleasePreflightName(kind) {
  const normalizedKind = cleanText(kind);
  const names = {
    hosted_runtime_identity: "prepare_stage1_hosted_runtime_identity_artifact",
    rollback_drill: "prepare_stage1_rollback_drill_artifact",
    non_cohort_leak_crawl: "prepare_stage1_non_cohort_leak_crawl_artifact",
    r2_recovery_drill: "prepare_stage1_r2_recovery_drill_artifact",
  };
  const name = names[normalizedKind];
  if (!name) {
    throw new Error(
      `Unsupported Stage 1 external evidence kind: ${normalizedKind || "missing"}.`,
    );
  }
  return name;
}

export function stage1ReleaseEvidenceStatus(value) {
  const normalizedStatus = cleanText(value) || "passed";
  if (!["passed", "failed"].includes(normalizedStatus)) {
    throw new Error("Stage 1 release evidence status must be passed or failed.");
  }
  return normalizedStatus;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}
