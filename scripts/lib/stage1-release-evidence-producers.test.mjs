import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  measureStage1HostedRuntimeIdentity,
  measureStage1NonCohortLeakCrawl,
  measureStage1R2RecoveryDrill,
  measureStage1RollbackDrill,
  stage1ReleaseEvidenceProducerContract,
  stage1ReleaseEvidenceProducerSourceSha256,
  validateStage1ReleaseProducerTarget,
} from "./stage1-release-evidence-producers.mjs";

const target = Object.freeze({
  schema_version: "awardping.stage1.production-target.v1",
  configured: true,
  release_key: "stage1-national-25",
  config_version: 7,
  target_config_hash: "a".repeat(64),
  app_origin: "https://awardping.com",
  supabase_origin: "https://abcdefghijklmnopqrst.supabase.co",
  supabase_project_ref: "abcdefghijklmnopqrst",
  deployment_provider: "vercel",
  deployment_project_id: "prj_awardping_production",
  deployment_team_slug: "awardping-team",
  r2_account_id: "b".repeat(32),
  r2_bucket: "awardping-snapshots",
});
const measuredAt = "2026-07-16T18:00:00.000Z";
const measurementId = "12345678-1234-4234-9234-123456789abc";

describe("Stage 1 producer-owned release measurements", () => {
  it("accepts only the exact administrator-owned production identity", () => {
    const normalized = validateStage1ReleaseProducerTarget(target);
    expect(normalized.appOrigin).toBe("https://awardping.com");
    expect(normalized.supabaseProjectRef).toBe("abcdefghijklmnopqrst");
    expect(() => validateStage1ReleaseProducerTarget({
      ...target,
      app_origin: "https://awardping.com/path",
    })).toThrow("exact HTTPS origin");
    expect(() => validateStage1ReleaseProducerTarget({
      ...target,
      supabase_project_ref: "wrongprojectreference",
    })).toThrow("Supabase project identity");
  });

  it("measures the exact app and Supabase Auth origins without redirects", async () => {
    const fetchImpl = runtimeFetch();
    const result = await measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      fetchImpl,
      measuredAt,
      measurementId,
    });
    expect(result.status).toBe("passed");
    expect(result.evidence).toMatchObject({
      producer_contract: stage1ReleaseEvidenceProducerContract,
      producer_source_sha256: stage1ReleaseEvidenceProducerSourceSha256,
      measurement_id: measurementId,
      measured_at: measuredAt,
      production_app_origin: target.app_origin,
      supabase_origin: target.supabase_origin,
      identity_url: `${target.app_origin}/api/monitoring-policy-identity`,
      auth_settings_url: `${target.supabase_origin}/auth/v1/settings`,
      disable_signup: true,
    });
    expect(fetchImpl.urls).toEqual(expect.arrayContaining([
      `${target.app_origin}/api/monitoring-policy-identity`,
      `${target.supabase_origin}/auth/v1/settings`,
    ]));
  });

  it("refuses redirects and malformed producer measurement timestamps", async () => {
    await expect(measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      fetchImpl: runtimeFetch({ redirectIdentity: true }),
      measuredAt,
      measurementId,
    })).rejects.toThrow("refused a redirect");
    await expect(measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      fetchImpl: runtimeFetch(),
      measuredAt: "not-a-timestamp",
      measurementId,
    })).rejects.toThrow("ISO timestamp");
  });

  it("crawls the exact DB-owned 25-award and non-cohort route manifest", async () => {
    const manifest = leakManifest();
    const passed = await measureStage1NonCohortLeakCrawl({
      target,
      manifest,
      supabaseAnonKey: "public-anon-key",
      fetchImpl: runtimeFetch(),
      measuredAt,
      measurementId,
    });
    expect(passed.status).toBe("passed");
    expect(passed.evidence).toMatchObject({
      stage1_awards_observed: 25,
      stage1_under_verification_pages: 25,
      non_cohort_awards_sampled: 1,
      non_cohort_leaks: 0,
      unexpected_stage1_leaks: 0,
      route_manifest_sha256: "c".repeat(64),
    });

    const failed = await measureStage1NonCohortLeakCrawl({
      target,
      manifest,
      supabaseAnonKey: "public-anon-key",
      fetchImpl: runtimeFetch({ leakNonCohort: true }),
      measuredAt,
      measurementId,
    });
    expect(failed.status).toBe("failed");
    expect(failed.evidence.non_cohort_leaks).toBe(1);
  });

  it("GETs and hashes every DB-owned immutable R2 object", async () => {
    const bytes = Buffer.from("immutable visual evidence");
    const manifest = r2Manifest(bytes);
    const passed = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: r2Client(bytes),
      measuredAt,
      measurementId,
    });
    expect(passed.status).toBe("passed");
    expect(passed.evidence).toMatchObject({
      hash_verified: true,
      recovered_objects: 1,
      failed_objects: 0,
      refused_objects: 0,
      visual_objects_checked: 1,
    });

    const mismatched = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: r2Client(Buffer.from("tampered")),
      measuredAt,
      measurementId,
    });
    expect(mismatched.status).toBe("failed");
    expect(mismatched.evidence.hash_verified).toBe(false);
    expect(mismatched.evidence.failed_objects).toBe(1);
  });

  it("requires explicit exact-origin confirmation and observes rollback plus restore", async () => {
    let revision = "revision-current";
    const fetchImpl = runtimeFetch({ revision: () => revision });
    const deploymentController = {
      async assertProjectIdentity(receivedTarget) {
        expect(receivedTarget.deploymentProjectId).toBe(target.deployment_project_id);
      },
      async rollback() {
        revision = "revision-previous";
        return { exitCode: 0, stdout: "rolled back", stderr: "" };
      },
      async restore() {
        revision = "revision-current";
        return { exitCode: 0, stdout: "restored", stderr: "" };
      },
    };
    await expect(measureStage1RollbackDrill({
      target,
      contractStateHash: "d".repeat(64),
      rollbackDeployment: "dpl_previous123",
      restoreDeployment: "dpl_current123",
      confirmProductionOrigin: "https://wrong.example",
      executeProductionRollback: true,
      deploymentController,
      supabaseAnonKey: "public-anon-key",
      fetchImpl,
      pollAttempts: 1,
      sleep: async () => {},
      measuredAt,
      measurementId,
    })).rejects.toThrow("confirmation");

    const result = await measureStage1RollbackDrill({
      target,
      contractStateHash: "d".repeat(64),
      rollbackDeployment: "dpl_previous123",
      restoreDeployment: "dpl_current123",
      confirmProductionOrigin: target.app_origin,
      executeProductionRollback: true,
      deploymentController,
      supabaseAnonKey: "public-anon-key",
      fetchImpl,
      pollAttempts: 1,
      sleep: async () => {},
      measuredAt,
      measurementId,
    });
    expect(result.status).toBe("passed");
    expect(result.appRevision).toBe("revision-current");
    expect(result.evidence).toMatchObject({
      before_revision: "revision-current",
      rollback_revision: "revision-previous",
      restored_revision: "revision-current",
      rollback_succeeded: true,
      restore_succeeded: true,
      transition_events_checked: 2,
    });
  });

  it("attempts restoration in finally when the rollback transition cannot be verified", async () => {
    let revision = "revision-current";
    let restored = false;
    const deploymentController = {
      async assertProjectIdentity() {},
      async rollback() {
        // Leave the served revision unchanged so the rollback poll fails.
        return { exitCode: 0, stdout: "rollback requested", stderr: "" };
      },
      async restore() {
        restored = true;
        revision = "revision-current";
        return { exitCode: 0, stdout: "restored", stderr: "" };
      },
    };
    await expect(measureStage1RollbackDrill({
      target,
      contractStateHash: "d".repeat(64),
      rollbackDeployment: "dpl_previous123",
      restoreDeployment: "dpl_current123",
      confirmProductionOrigin: target.app_origin,
      executeProductionRollback: true,
      deploymentController,
      supabaseAnonKey: "public-anon-key",
      fetchImpl: runtimeFetch({ revision: () => revision }),
      pollAttempts: 1,
      sleep: async () => {},
      measuredAt,
      measurementId,
    })).rejects.toThrow("rolled-back production revision");
    expect(restored).toBe(true);
  });
});

function runtimeFetch({
  redirectIdentity = false,
  leakNonCohort = false,
  revision = () => "revision-current",
} = {}) {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    expect(options.redirect).toBe("manual");
    if (url === `${target.supabase_origin}/auth/v1/settings`) {
      return jsonResponse({ disable_signup: true });
    }
    if (url === `${target.app_origin}/api/monitoring-policy-identity`) {
      if (redirectIdentity) {
        return new Response("", {
          status: 302,
          headers: { location: "https://wrong.example" },
        });
      }
      return jsonResponse({
        schemaVersion: "monitoring-promotion-app-identity-v1",
        revision: revision(),
        policy_hash: "policy-hash",
        batch_policy_hash: "batch-policy-hash",
        suppression_policy_hash: "suppression-policy-hash",
        matcher_hash: "e".repeat(64),
      });
    }
    if (url === `${target.app_origin}/not-stage1`) {
      return new Response(leakNonCohort ? "leaked award" : "not found", {
        status: leakNonCohort ? 200 : 404,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.startsWith(`${target.app_origin}/award-`)) {
      return new Response("<h1>Under verification</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function leakManifest() {
  return {
    schema_version: "awardping.stage1.leak-crawl-manifest.v1",
    target,
    stage1_route_count: 25,
    non_cohort_route_count: 1,
    route_manifest_sha256: "c".repeat(64),
    stage1_routes: Array.from({ length: 25 }, (_, index) => ({
      path: `/award-${index + 1}`,
    })),
    non_cohort_routes: [{ path: "/not-stage1" }],
  };
}

function r2Manifest(bytes) {
  return {
    schema_version: "awardping.stage1.r2-verification-manifest.v1",
    target,
    visual_object_count: 1,
    visual_object_set_hash: "f".repeat(64),
    unexpected_bucket_count: 0,
    malformed_object_count: 0,
    objects: [{
      bucket: target.r2_bucket,
      object_key: "visual-snapshots/published/event/current/crop.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_length: bytes.length,
      content_type: "image/png",
    }],
  };
}

function r2Client(bytes) {
  return {
    async send(command) {
      expect(command.input).toMatchObject({
        Bucket: target.r2_bucket,
        Key: "visual-snapshots/published/event/current/crop.png",
      });
      return {
        ContentType: "image/png",
        Body: { async transformToByteArray() { return bytes; } },
      };
    },
  };
}
