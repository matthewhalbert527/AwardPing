import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildStage1ReleaseOperatorReport,
  writeStage1ReleaseOperatorReport,
} from "./stage1-release-operator-report.mjs";

const hash = "a".repeat(64);
const target = Object.freeze({
  appOrigin: "https://awardping.com",
  supabaseProjectRef: "abcdefghijklmnopqrst",
  configVersion: 7,
  targetConfigHash: "b".repeat(64),
  r2Bucket: "awardping-snapshots",
});
const timestamps = Object.freeze({
  startedAt: "2026-07-17T18:00:00.000Z",
  completedAt: "2026-07-17T18:01:00.000Z",
  validUntil: "2026-07-18T18:01:00.000Z",
});

describe("Stage 1 release-evidence operator reports", () => {
  it("retains exact crawl paths and statuses while dropping unapproved secret fields", () => {
    const failures = [{
      group: "non_cohort",
      path: "/not-stage1",
      http_status: 200,
      redirected: false,
      redirect_location: null,
      under_verification: false,
      reason: "non_cohort_route_publicly_visible",
      error_code: null,
      recommended_safe_action: "Leak SUPER_SECRET into the report.",
      secret_access_key: "SUPER_SECRET",
    }];
    const failureSetHash = diagnosticsHash("non_cohort_leak_crawl", failures);
    const measurement = {
      status: "failed",
      appRevision: "revision-current",
      evidence: {
        measurement_id: "12345678-1234-4234-9234-123456789abc",
        failure_count: 1,
        failure_set_hash: failureSetHash,
      },
      diagnostics: {
        schema_version: "awardping.stage1.non-cohort-leak-diagnostics.v1",
        total_observations: 26,
        failure_count: 1,
        failure_set_hash: failureSetHash,
        authorization: "Bearer SUPER_SECRET",
        failures,
      },
    };

    const report = buildStage1ReleaseOperatorReport({
      kind: "non_cohort_leak_crawl",
      measurement,
      target,
      evidenceHash: hash,
      signedPayloadHash: "d".repeat(64),
      ...timestamps,
      apply: false,
    });

    expect(report.diagnostics).toMatchObject({
      failure_count: 1,
      failure_set_hash: failureSetHash,
      failures: [{
        path: "/not-stage1",
        http_status: 200,
        reason: "non_cohort_route_publicly_visible",
      }],
    });
    expect(JSON.stringify(report)).not.toMatch(/SUPER_SECRET|authorization|secret_access_key/i);

    measurement.evidence.failure_count = 0;
    expect(() => buildStage1ReleaseOperatorReport({
      kind: "non_cohort_leak_crawl",
      measurement,
      target,
      evidenceHash: hash,
      signedPayloadHash: "d".repeat(64),
      ...timestamps,
      apply: false,
    })).toThrow(/do not match.*signed evidence/i);
  });

  it("writes an ignored local report with exact non-secret R2 key/hash diagnostics", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-stage1-report-"));
    try {
      const failures = [{
        object_scope: "manifest_source",
        source_id: "11111111-1111-4111-8111-111111111111",
        artifact: "text",
        object_key:
          "visual-snapshots/sources/11111111-1111-4111-8111-111111111111/captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/text.txt",
        hash_mode: "utf8_text_single_trailing_newline_v1",
        outcome: "mismatch",
        error_code: null,
        expected_sha256: "f".repeat(64),
        actual_sha256: "0".repeat(64),
        expected_byte_length: 101,
        actual_byte_length: 99,
        expected_semantic_length: 100,
        actual_semantic_length: 98,
        expected_content_type: "text/plain; charset=utf-8",
        actual_content_type: "text/plain; charset=utf-8",
        recommended_safe_action: "Restore this exact immutable object.",
      }];
      const failureSetHash = diagnosticsHash("r2_recovery_drill", failures);
      const report = buildStage1ReleaseOperatorReport({
        kind: "r2_recovery_drill",
        measurement: {
          status: "failed",
          appRevision: "revision-current",
          evidence: {
            measurement_id: "12345678-1234-4234-9234-123456789abc",
            failure_count: 1,
            failure_set_hash: failureSetHash,
          },
          diagnostics: {
            schema_version: "awardping.stage1.r2-recovery-diagnostics.v1",
            total_observations: 2,
            failure_count: 1,
            failure_set_hash: failureSetHash,
            failures,
          },
        },
        target,
        evidenceHash: hash,
        signedPayloadHash: "d".repeat(64),
        ...timestamps,
        apply: true,
        artifact: { id: "artifact_123", status: "failed", evidence_hash: hash },
      });
      const path = writeStage1ReleaseOperatorReport({ root, report });
      expect(path).toContain(join("reports", "stage1-release-evidence"));
      expect(path).toMatch(
        /2026-07-17T18-01-00\.000Z-r2_recovery_drill-12345678-1234-4234-9234-123456789abc\.json$/,
      );
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.diagnostics.failures[0]).toMatchObject({
        artifact: "text",
        outcome: "mismatch",
        expected_sha256: "f".repeat(64),
        actual_sha256: "0".repeat(64),
      });
      expect(JSON.stringify(written)).not.toMatch(/credential|token|cookie|authorization/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an exact empty failure set for successful measurements", () => {
    const emptyFailureSetHash = diagnosticsHash("non_cohort_leak_crawl", []);
    const report = buildStage1ReleaseOperatorReport({
      kind: "non_cohort_leak_crawl",
      measurement: {
        status: "passed",
        appRevision: "revision-current",
        evidence: {
          measurement_id: "12345678-1234-4234-9234-123456789abc",
          failure_count: 0,
          failure_set_hash: emptyFailureSetHash,
        },
        diagnostics: {
          schema_version: "awardping.stage1.non-cohort-leak-diagnostics.v1",
          total_observations: 26,
          failure_count: 0,
          failure_set_hash: emptyFailureSetHash,
          failures: [],
        },
      },
      target,
      evidenceHash: hash,
      signedPayloadHash: "d".repeat(64),
      ...timestamps,
      apply: false,
    });
    expect(report.diagnostics).toMatchObject({
      failure_count: 0,
      failures: [],
    });
  });

  it("rejects missing or altered diagnostics before writing a report", () => {
    const base = {
      status: "failed",
      appRevision: "revision-current",
      evidence: {
        measurement_id: "12345678-1234-4234-9234-123456789abc",
        failure_count: 1,
        failure_set_hash: "c".repeat(64),
      },
    };
    expect(() => buildStage1ReleaseOperatorReport({
      kind: "non_cohort_leak_crawl",
      measurement: base,
      target,
      evidenceHash: hash,
      signedPayloadHash: "d".repeat(64),
      ...timestamps,
      apply: false,
    })).toThrow(/diagnostics are required/i);

    expect(() => buildStage1ReleaseOperatorReport({
      kind: "non_cohort_leak_crawl",
      measurement: {
        ...base,
        diagnostics: {
          schema_version: "awardping.stage1.non-cohort-leak-diagnostics.v1",
          total_observations: 1,
          failure_count: 1,
          failure_set_hash: "c".repeat(64),
          failures: [{
            group: "non_cohort",
            path: "/altered",
            http_status: 200,
            redirected: false,
            redirect_location: null,
            under_verification: false,
            reason: "non_cohort_route_publicly_visible",
            error_code: null,
          }],
        },
      },
      target,
      evidenceHash: hash,
      signedPayloadHash: "d".repeat(64),
      ...timestamps,
      apply: false,
    })).toThrow(/rows do not match.*failure-set hash/i);
  });
});

function diagnosticsHash(kind, failures) {
  const identities = failures.map((failure) => {
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
    const identity = { ...failure };
    delete identity.recommended_safe_action;
    return identity;
  });
  return createHash("sha256")
    .update(JSON.stringify(stableValue(identities)), "utf8")
    .digest("hex");
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
