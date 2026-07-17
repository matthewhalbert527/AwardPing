import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signStage1ReleaseEvidencePayload,
  stage1ExternalReleasePreflightName,
  stage1ExternalReleaseRecorderName,
  stage1ReleaseEvidenceStatus,
} from "./stage1-release-evidence-signing.mjs";

describe("Stage 1 signed external release evidence", () => {
  it("produces the exact SHA-256 HMAC PostgreSQL verifies", () => {
    const payloadHash = "a".repeat(64);
    const secret = "release-evidence-secret-with-32-plus-chars";
    expect(signStage1ReleaseEvidencePayload({ payloadHash, secret })).toBe(
      createHmac("sha256", secret).update(payloadHash, "utf8").digest("hex"),
    );
  });

  it("fails closed for malformed hashes and weak secrets", () => {
    expect(() => signStage1ReleaseEvidencePayload({
      payloadHash: "not-a-hash",
      secret: "release-evidence-secret-with-32-plus-chars",
    })).toThrow("SHA-256");
    expect(() => signStage1ReleaseEvidencePayload({
      payloadHash: "b".repeat(64),
      secret: "too-short",
    })).toThrow("at least 32");
  });

  it("routes each proof through kind-specific preflight and recorder RPCs", () => {
    expect(stage1ExternalReleasePreflightName("hosted_runtime_identity")).toBe(
      "prepare_stage1_hosted_runtime_identity_artifact",
    );
    expect(stage1ExternalReleasePreflightName("non_cohort_leak_crawl")).toBe(
      "prepare_stage1_non_cohort_leak_crawl_artifact",
    );
    expect(stage1ExternalReleaseRecorderName("hosted_runtime_identity")).toBe(
      "record_stage1_hosted_runtime_identity_artifact",
    );
    expect(stage1ExternalReleaseRecorderName("r2_recovery_drill")).toBe(
      "record_stage1_r2_recovery_drill_artifact",
    );
    expect(() => stage1ExternalReleaseRecorderName("visual_crop_coverage")).toThrow(
      "Unsupported",
    );
    expect(() => stage1ExternalReleasePreflightName("visual_crop_coverage")).toThrow(
      "Unsupported",
    );
  });

  it("fails closed instead of treating a mistyped status as passed", () => {
    expect(stage1ReleaseEvidenceStatus()).toBe("passed");
    expect(stage1ReleaseEvidenceStatus("failed")).toBe("failed");
    expect(() => stage1ReleaseEvidenceStatus("passsed")).toThrow("passed or failed");
  });
});
