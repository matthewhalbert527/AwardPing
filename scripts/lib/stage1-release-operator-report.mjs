import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const hashPattern = /^[0-9a-f]{64}$/;
const diagnosticSchemas = Object.freeze({
  non_cohort_leak_crawl:
    "awardping.stage1.non-cohort-leak-diagnostics.v1",
  r2_recovery_drill: "awardping.stage1.r2-recovery-diagnostics.v1",
});

export function buildStage1ReleaseOperatorReport({
  kind,
  measurement,
  target,
  evidenceHash,
  signedPayloadHash,
  startedAt,
  completedAt,
  validUntil,
  apply,
  artifact = null,
} = {}) {
  const diagnostics = normalizeOperatorDiagnostics(kind, measurement?.diagnostics);
  assertDiagnosticsBoundToSignedEvidence(kind, measurement?.evidence, diagnostics);
  return {
    schema_version: "awardping.stage1.release-evidence-operator-report.v1",
    generated_at: requiredTimestamp(completedAt, "completed_at"),
    artifact_kind: safeToken(kind, "artifact kind"),
    requested_apply: apply === true,
    measurement_status: safeToken(measurement?.status, "measurement status"),
    measurement_id: requiredUuid(
      measurement?.evidence?.measurement_id,
      "measurement ID",
    ),
    measured_app_revision: safeIdentifier(measurement?.appRevision),
    production_target: {
      app_origin: exactOrigin(target?.appOrigin),
      supabase_project_ref: safeIdentifier(target?.supabaseProjectRef),
      config_version: Number(target?.configVersion),
      config_hash: requiredHash(target?.targetConfigHash, "target config hash"),
      r2_bucket: cleanText(target?.r2Bucket) || null,
    },
    signing_preflight: {
      evidence_hash: requiredHash(evidenceHash, "evidence hash"),
      signed_payload_hash: requiredHash(signedPayloadHash, "signed payload hash"),
      started_at: requiredTimestamp(startedAt, "started_at"),
      completed_at: requiredTimestamp(completedAt, "completed_at"),
      valid_until: requiredTimestamp(validUntil, "valid_until"),
    },
    retained_artifact: artifact
      ? {
          id: safeIdentifier(artifact.id) || null,
          status: safeToken(artifact.status || measurement?.status, "artifact status"),
          evidence_hash: hashPattern.test(cleanText(artifact.evidence_hash))
            ? cleanText(artifact.evidence_hash)
            : requiredHash(evidenceHash, "evidence hash"),
        }
      : null,
    diagnostics,
  };
}

function assertDiagnosticsBoundToSignedEvidence(kind, evidenceValue, diagnostics) {
  if (!diagnosticSchemas[kind]) return;
  const evidence = evidenceValue && typeof evidenceValue === "object"
    ? evidenceValue
    : {};
  if (
    Number(evidence.failure_count) !== diagnostics.failure_count ||
    cleanText(evidence.failure_set_hash) !== diagnostics.failure_set_hash
  ) {
    throw new Error(
      "Operator diagnostics do not match the compact failure count and hash in signed evidence.",
    );
  }
}

export function writeStage1ReleaseOperatorReport({ root, report } = {}) {
  const workspaceRoot = resolve(requiredText(root, "workspace root"));
  const outputDirectory = resolve(workspaceRoot, "reports", "stage1-release-evidence");
  mkdirSync(outputDirectory, { recursive: true });
  const generatedAt = safeFilenamePart(report?.generated_at || new Date().toISOString());
  const kind = safeFilenamePart(report?.artifact_kind || "unknown");
  const measurementId = safeFilenamePart(report?.measurement_id || "unidentified");
  const path = resolve(outputDirectory, `${generatedAt}-${kind}-${measurementId}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return path;
}

function normalizeOperatorDiagnostics(kind, value) {
  const diagnostics = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  if (!diagnostics) {
    if (diagnosticSchemas[kind]) {
      throw new Error(`Operator diagnostics are required for ${kind}.`);
    }
    return {
      schema_version: "awardping.stage1.release-evidence-diagnostics-empty.v1",
      total_observations: 0,
      failure_count: 0,
      failure_set_hash: sha256("[]"),
      failures: [],
    };
  }
  const failures = Array.isArray(diagnostics.failures)
    ? diagnostics.failures.map((failure) => normalizeFailure(kind, failure))
    : [];
  if (diagnostics.schema_version !== diagnosticSchemas[kind]) {
    throw new Error(`Operator diagnostics use the wrong schema for ${kind}.`);
  }
  const failureCount = Number(diagnostics.failure_count);
  if (!Number.isSafeInteger(failureCount) || failureCount !== failures.length) {
    throw new Error("Operator diagnostics do not contain the exact failure count.");
  }
  const totalObservations = exactNonnegativeInteger(
    diagnostics.total_observations,
    "diagnostic observation count",
  );
  if (totalObservations < failureCount) {
    throw new Error("Operator diagnostics contain more failures than observations.");
  }
  const failureSetHash = requiredHash(
    diagnostics.failure_set_hash,
    "diagnostic failure-set hash",
  );
  const recomputedFailureSetHash = sha256(stableJson(
    failures.map((failure) => diagnosticFailureIdentity(kind, failure)),
  ));
  if (failureSetHash !== recomputedFailureSetHash) {
    throw new Error(
      "Operator diagnostic rows do not match their declared failure-set hash.",
    );
  }
  return {
    schema_version: diagnostics.schema_version,
    total_observations: totalObservations,
    failure_count: failureCount,
    failure_set_hash: failureSetHash,
    failures,
  };
}

function normalizeFailure(kind, failureValue) {
  const failure = failureValue && typeof failureValue === "object"
    ? failureValue
    : {};
  if (kind === "non_cohort_leak_crawl") {
    const normalized = {
      group: exactChoice(
        failure.group,
        ["stage1", "non_cohort"],
        "crawl failure group",
      ),
      path: exactPublicPath(failure.path),
      http_status: nullableHttpStatus(failure.http_status),
      redirected: failure.redirected === true,
      redirect_location: nullablePublicLocation(failure.redirect_location),
      under_verification: failure.under_verification === true,
      reason: exactChoice(
        failure.reason,
        [
          "request_failed",
          "redirect_refused",
          "unexpected_stage1_status",
          "under_verification_marker_missing",
          "non_cohort_route_publicly_visible",
        ],
        "crawl failure reason",
      ),
      error_code: nullableErrorCode(failure.error_code),
      recommended_safe_action: crawlSafeAction(failure.reason),
    };
    if (
      (normalized.reason === "request_failed") !== Boolean(normalized.error_code) ||
      (normalized.reason === "redirect_refused") !== normalized.redirected ||
      (
        ["unexpected_stage1_status", "under_verification_marker_missing"]
          .includes(normalized.reason) && normalized.group !== "stage1"
      ) ||
      (
        normalized.reason === "non_cohort_route_publicly_visible" &&
        normalized.group !== "non_cohort"
      )
    ) {
      throw new Error("Crawl diagnostic fields do not describe one coherent failure.");
    }
    return normalized;
  }
  if (kind === "r2_recovery_drill") {
    const objectScope = exactChoice(
      failure.object_scope,
      ["published_event", "manifest_source"],
      "R2 object scope",
    );
    const sourceId = nullableUuid(failure.source_id);
    if (
      (objectScope === "manifest_source" && !sourceId) ||
      (objectScope === "published_event" && sourceId)
    ) {
      throw new Error("R2 diagnostic source identity does not match its object scope.");
    }
    return {
      object_scope: objectScope,
      source_id: sourceId,
      artifact: safeToken(failure.artifact, "R2 artifact"),
      object_key: exactR2ObjectKey(failure.object_key),
      hash_mode: exactChoice(
        failure.hash_mode,
        ["raw_sha256", "utf8_text_single_trailing_newline_v1"],
        "R2 hash mode",
      ),
      outcome: exactChoice(
        failure.outcome,
        ["mismatch", "refused", "failed"],
        "R2 failure outcome",
      ),
      error_code: nullableErrorCode(failure.error_code),
      expected_sha256: nullableHash(failure.expected_sha256),
      actual_sha256: nullableHash(failure.actual_sha256),
      expected_byte_length: nullableNonnegativeInteger(failure.expected_byte_length),
      actual_byte_length: nullableNonnegativeInteger(failure.actual_byte_length),
      expected_semantic_length: nullableNonnegativeInteger(
        failure.expected_semantic_length,
      ),
      actual_semantic_length: nullableNonnegativeInteger(
        failure.actual_semantic_length,
      ),
      expected_content_type: nullableContentType(failure.expected_content_type),
      actual_content_type: nullableContentType(failure.actual_content_type),
      recommended_safe_action: r2SafeAction(failure.outcome),
    };
  }
  throw new Error(`Unsupported operator diagnostic kind: ${kind}.`);
}

function diagnosticFailureIdentity(kind, failure) {
  if (kind === "non_cohort_leak_crawl") {
    return {
      group: failure.group,
      path: failure.path,
      http_status: failure.http_status,
      redirected: failure.redirected,
      redirect_location: failure.redirect_location,
      under_verification: failure.under_verification,
      reason: failure.reason,
      error_code: failure.error_code,
    };
  }
  if (kind === "r2_recovery_drill") {
    const identity = { ...failure };
    delete identity.recommended_safe_action;
    return identity;
  }
  throw new Error(`Unsupported operator diagnostic kind: ${kind}.`);
}

function exactR2ObjectKey(value) {
  const key = requiredText(value, "R2 object key");
  if (
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("..") ||
    /[\u0000-\u001f\u007f?#]/.test(key)
  ) {
    throw new Error("R2 diagnostic object key is not safe to report.");
  }
  return key;
}

function exactPublicPath(value) {
  const path = requiredText(value, "public crawl path");
  if (!/^\/[a-z0-9][a-z0-9-]*$/.test(path)) {
    throw new Error("Crawl diagnostic path is not an exact public path.");
  }
  return path;
}

function nullablePublicLocation(value) {
  const location = cleanText(value);
  if (!location) return null;
  if (location === "[invalid-location]") return location;
  if (
    location.startsWith("/") &&
    !location.startsWith("//") &&
    location.length <= 2_048 &&
    !/[\u0000-\u001f\u007f?#]/.test(location)
  ) {
    return location;
  }
  try {
    const parsed = new URL(location);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("unsafe location");
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[redacted-invalid-location]";
  }
}

function exactOrigin(value) {
  const parsed = new URL(requiredText(value, "app origin"));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("Operator-report app origin is invalid.");
  }
  return parsed.origin;
}

function crawlSafeAction(reasonValue) {
  const reason = cleanText(reasonValue);
  if (reason === "request_failed") {
    return "Repair anonymous route availability, TLS, or network access, then rerun the exact crawl path.";
  }
  if (reason === "redirect_refused") {
    return "Remove the redirect and serve the expected response at this exact canonical path before rerunning.";
  }
  if (reason === "unexpected_stage1_status") {
    return "Restore this Stage 1 path to an HTTP 200 Under verification page, then rerun the crawl.";
  }
  if (reason === "under_verification_marker_missing") {
    return "Restore the Under verification marker on this Stage 1 path, then rerun the crawl.";
  }
  if (reason === "non_cohort_route_publicly_visible") {
    return "Remove this non-cohort path from anonymous publication and verify it returns HTTP 404 before rerunning.";
  }
  return "Keep publication closed and investigate this exact crawl path before rerunning.";
}

function r2SafeAction(outcomeValue) {
  const outcome = cleanText(outcomeValue);
  if (outcome === "mismatch") {
    return "Restore or recapture this exact immutable object generation, rebuild the DB-owned manifest, then rerun the R2 drill.";
  }
  if (outcome === "refused") {
    return "Repair read-only R2 credential or bucket access, keep the immutable manifest unchanged, then rerun the drill.";
  }
  return "Confirm this exact immutable object exists in the authoritative bucket, repair retrieval, then rerun the drill.";
}

function nullableErrorCode(value) {
  const code = cleanText(value);
  if (!code) return null;
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(code) ? code : "redacted_error_code";
}

function nullableContentType(value) {
  const contentType = cleanText(value).toLowerCase();
  if (!contentType) return null;
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/.test(contentType)
    ? contentType
    : "application/octet-stream";
}

function nullableUuid(value) {
  const identifier = cleanText(value).toLowerCase();
  if (!identifier) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    identifier,
  )
    ? identifier
    : null;
}

function requiredUuid(value, label) {
  const identifier = nullableUuid(value);
  if (!identifier) throw new Error(`${label} is invalid.`);
  return identifier;
}

function nullableHash(value) {
  const hash = cleanText(value);
  return hashPattern.test(hash) ? hash : null;
}

function requiredHash(value, label) {
  const hash = cleanText(value);
  if (!hashPattern.test(hash)) throw new Error(`${label} is invalid.`);
  return hash;
}

function nullableHttpStatus(value) {
  if (value === null || value === undefined) return null;
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  return status;
}

function nullableNonnegativeInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function exactNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return number;
}

function requiredTimestamp(value, label) {
  const timestamp = requiredText(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid.`);
  return timestamp;
}

function safeIdentifier(value) {
  const identifier = cleanText(value);
  return /^[A-Za-z0-9_-]{1,120}$/.test(identifier) ? identifier : null;
}

function safeToken(value, label) {
  const token = requiredText(value, label);
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(token)) throw new Error(`${label} is invalid.`);
  return token;
}

function exactChoice(value, choices, label) {
  const token = safeToken(value, label);
  if (!choices.includes(token)) throw new Error(`${label} is invalid.`);
  return token;
}

function safeFilenamePart(value) {
  return cleanText(value).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 160) || "unknown";
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}
