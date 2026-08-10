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
import { publishedVisualEvidenceObjectKey } from "./visual-event-evidence.mjs";

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
const publishedEventCandidateId = "22222222-2222-4222-8222-222222222222";

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
      supabaseServiceRoleKey: "service-role-key",
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
      vault_profile_url:
        `${target.supabase_origin}/rest/v1/decrypted_secrets?select=id&limit=1`,
      disable_signup: true,
      vault_profile_http_status: 406,
      vault_profile_postgrest_code: "PGRST106",
      vault_profile_exposed: false,
    });
    expect(fetchImpl.urls).toEqual(expect.arrayContaining([
      `${target.app_origin}/api/monitoring-policy-identity`,
      `${target.supabase_origin}/auth/v1/settings`,
      `${target.supabase_origin}/rest/v1/decrypted_secrets?select=id&limit=1`,
    ]));
  });

  it("refuses redirects and malformed producer measurement timestamps", async () => {
    await expect(measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl: runtimeFetch({ redirectIdentity: true }),
      measuredAt,
      measurementId,
    })).rejects.toThrow("refused a redirect");
    await expect(measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl: runtimeFetch(),
      measuredAt: "not-a-timestamp",
      measurementId,
    })).rejects.toThrow("ISO timestamp");
    await expect(measureStage1HostedRuntimeIdentity({
      target,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl: runtimeFetch({ exposeVault: true }),
      measuredAt,
      measurementId,
    })).rejects.toThrow("denied access to the Vault Data API profile");
  });

  it("crawls the exact DB-owned 25-award and non-cohort route manifest", async () => {
    const manifest = leakManifest();
    const passed = await measureStage1NonCohortLeakCrawl({
      target,
      manifest,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
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
      failure_count: 0,
      route_manifest_sha256: "c".repeat(64),
    });
    expect(passed.evidence.failure_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(passed.diagnostics).toMatchObject({
      total_observations: 26,
      failure_count: 0,
      failure_set_hash: passed.evidence.failure_set_hash,
      failures: [],
    });

    const failed = await measureStage1NonCohortLeakCrawl({
      target,
      manifest,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl: runtimeFetch({ leakNonCohort: true }),
      measuredAt,
      measurementId,
    });
    expect(failed.status).toBe("failed");
    expect(failed.evidence.non_cohort_leaks).toBe(1);
    expect(failed.evidence.failure_count).toBe(1);
    expect(failed.diagnostics).toMatchObject({
      failure_count: 1,
      failure_set_hash: failed.evidence.failure_set_hash,
      failures: [{
        group: "non_cohort",
        path: "/not-stage1",
        http_status: 200,
        reason: "non_cohort_route_publicly_visible",
      }],
    });
    expect(failed.diagnostics.failures[0].recommended_safe_action).toMatch(/404/);
    expect(failed.evidence).not.toHaveProperty("failures");
    expect(failed.evidence).not.toHaveProperty("diagnostics");

    const redirected = await measureStage1NonCohortLeakCrawl({
      target,
      manifest,
      supabaseAnonKey: "public-anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl: runtimeFetch({ redirectNonCohort: true }),
      measuredAt,
      measurementId,
    });
    expect(redirected.diagnostics.failures[0]).toMatchObject({
      path: "/not-stage1",
      http_status: 302,
      redirected: true,
      redirect_location: "https://elsewhere.example/public-path",
      reason: "redirect_refused",
    });
    expect(JSON.stringify(redirected.diagnostics)).not.toContain("SUPER_SECRET");
  });

  it("GETs and hashes every DB-owned immutable R2 object", async () => {
    const bytes = Buffer.from("immutable visual evidence");
    const manifest = r2Manifest(bytes);
    const passed = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: r2Client(bytes, manifest.objects[0].object_key),
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
      published_event_objects_checked: 1,
      manifest_source_objects_checked: 0,
      hash_mode_contract: "db_manifest_declared_hash_modes_v1",
    });

    const mismatched = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: r2Client(Buffer.from("tampered"), manifest.objects[0].object_key),
      measuredAt,
      measurementId,
    });
    expect(mismatched.status).toBe("failed");
    expect(mismatched.evidence.hash_verified).toBe(false);
    expect(mismatched.evidence.failed_objects).toBe(1);
    expect(mismatched.evidence.failure_count).toBe(1);
    expect(mismatched.evidence.failure_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mismatched.diagnostics).toMatchObject({
      failure_count: 1,
      failure_set_hash: mismatched.evidence.failure_set_hash,
      failures: [{
        object_scope: "published_event",
        artifact: "crop",
        object_key: manifest.objects[0].object_key,
        outcome: "mismatch",
        expected_sha256: createHash("sha256").update(bytes).digest("hex"),
        actual_sha256: createHash("sha256").update("tampered").digest("hex"),
      }],
    });
    expect(mismatched.diagnostics.failures[0].recommended_safe_action).toMatch(
      /exact immutable object generation/i,
    );
    expect(mismatched.evidence).not.toHaveProperty("failures");
    expect(mismatched.evidence).not.toHaveProperty("diagnostics");

    const mimeMismatched = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: mappedR2Client(new Map([[
        manifest.objects[0].object_key,
        { body: bytes, contentType: "image/jpeg; charset=binary" },
      ]])),
      measuredAt,
      measurementId,
    });
    expect(mimeMismatched.status).toBe("failed");
    expect(mimeMismatched.evidence.failed_objects).toBe(1);

    const refused = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: {
        async send() {
          const error = new Error("secret-bearing message must not be retained");
          error.name = "AccessDenied";
          error.$metadata = { httpStatusCode: 403 };
          throw error;
        },
      },
      measuredAt,
      measurementId,
    });
    expect(refused.evidence).toMatchObject({
      failed_objects: 0,
      refused_objects: 1,
      failure_count: 1,
    });
    expect(refused.diagnostics.failures[0]).toMatchObject({
      object_key: manifest.objects[0].object_key,
      outcome: "refused",
      error_code: "AccessDenied",
    });
    expect(JSON.stringify(refused.diagnostics)).not.toContain("secret-bearing");
  });

  it("accepts only exact generator-bound published-event role contracts", async () => {
    const contracts = [
      ["full", "previous", "main-full", "image/jpeg", "jpg"],
      ["full", "current", "state-expansion-state-01", "image/jpeg", "jpg"],
      ["full", "current", "document", "application/pdf", "pdf"],
      ["crop", "current", "changed-section-crop", "image/jpeg", "jpg"],
      ["layout", "current", "geometry-main", "application/json; charset=utf-8", "json"],
      ["layout", "current", "geometry-expansion-state-01", "application/json; charset=utf-8", "json"],
      ["metadata", "current", "metadata", "application/json; charset=utf-8", "json"],
      ["metadata", "previous", "recovery-metadata", "application/json; charset=utf-8", "json"],
      ["metadata", "previous", "first-observation-attestation", "application/json; charset=utf-8", "json"],
    ];

    for (const [artifact, side, role, contentType, extension] of contracts) {
      const bytes = Buffer.from(`immutable ${artifact} ${role}\n`, "utf8");
      const manifest = r2Manifest(bytes, {
        artifact,
        side,
        role,
        contentType,
        extension,
      });
      const object = manifest.objects[0];
      const measured = await measureStage1R2RecoveryDrill({
        target,
        manifest,
        appRevision: "revision-current",
        r2Client: mappedR2Client(new Map([[
          object.object_key,
          { body: bytes, contentType },
        ]])),
        measuredAt,
        measurementId,
      });
      expect(measured.status, `${artifact}:${role}`).toBe("passed");
    }
  });

  it("rejects malformed, unbound, wrong-role, missing-key, and duplicate event rows", async () => {
    const bytes = Buffer.from("%PDF-1.7\nimmutable official document\n", "utf8");
    const valid = r2Manifest(bytes, {
      artifact: "full",
      side: "current",
      role: "document",
      contentType: "application/pdf",
      extension: "pdf",
    });
    const invalidCases = [
      ["unknown artifact", (manifest) => { manifest.objects[0].artifact = "unknown"; }],
      ["candidate mismatch", (manifest) => {
        manifest.objects[0].candidate_id = "33333333-3333-4333-8333-333333333333";
      }],
      ["missing candidate", (manifest) => { delete manifest.objects[0].candidate_id; }],
      ["side mismatch", (manifest) => { manifest.objects[0].side = "previous"; }],
      ["wrong role", (manifest) => {
        setPublishedEventObjectKey(manifest.objects[0], {
          role: "changed-section-crop",
          extension: "jpg",
        });
      }],
      ["role MIME mismatch", (manifest) => {
        manifest.objects[0].content_type = "image/jpeg";
      }],
      ["PDF MIME on crop", (manifest) => {
        manifest.objects[0].artifact = "crop";
        setPublishedEventObjectKey(manifest.objects[0], {
          role: "changed-section-crop",
          extension: "jpg",
        });
      }],
      ["PDF MIME on layout", (manifest) => {
        manifest.objects[0].artifact = "layout";
        setPublishedEventObjectKey(manifest.objects[0], {
          role: "geometry-main",
          extension: "json",
        });
      }],
      ["PDF MIME on metadata", (manifest) => {
        manifest.objects[0].artifact = "metadata";
        setPublishedEventObjectKey(manifest.objects[0], {
          role: "metadata",
          extension: "json",
        });
      }],
      ["current first-observation attestation", (manifest) => {
        manifest.objects[0].artifact = "metadata";
        manifest.objects[0].content_type = "application/json; charset=utf-8";
        setPublishedEventObjectKey(manifest.objects[0], {
          role: "first-observation-attestation",
          extension: "json",
        });
      }],
      ["filename hash mismatch", (manifest) => {
        setPublishedEventObjectKey(manifest.objects[0], { sha256: "0".repeat(64) });
      }],
      ["extension mismatch", (manifest) => {
        setPublishedEventObjectKey(manifest.objects[0], { extension: "json" });
      }],
      ["unknown role", (manifest) => {
        setPublishedEventObjectKey(manifest.objects[0], { role: "arbitrary-document" });
      }],
      ["missing key", (manifest) => { delete manifest.objects[0].object_key; }],
      ["duplicate key reuse", (manifest) => {
        manifest.objects.push(structuredClone(manifest.objects[0]));
        refreshManifestCounts(manifest);
      }],
      ["reported duplicate count", (manifest) => {
        manifest.duplicate_object_key_count = 1;
      }],
    ];

    for (const [label, mutate] of invalidCases) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      await expect(measureStage1R2RecoveryDrill({
        target,
        manifest: malformed,
        appRevision: "revision-current",
        r2Client: {
          async send() {
            throw new Error("Published-event validation must happen before R2");
          },
        },
        measuredAt,
        measurementId,
      }), label).rejects.toThrow(
        /R2 object key|invalid object binding|incomplete or target-mismatched/,
      );
    }
  });

  it("verifies every published and immutable manifest-source artifact as exact raw bytes", async () => {
    const eventBytes = Buffer.from("immutable crop");
    const pageBytes = Buffer.from("immutable page image");
    const textBytes = Buffer.from("Eligibility requires U.S. citizenship.\n", "utf8");
    const manifest = mixedR2Manifest({ eventBytes, pageBytes, textBytes });
    const sourceBodies = mixedR2SourceBodies({ pageBytes, textBytes });
    const bodies = new Map(manifest.objects.map((object) => [
      object.object_key,
      object.scope === "manifest_source"
        ? { body: sourceBodies[object.artifact], contentType: object.content_type }
        : { body: eventBytes, contentType: "image/jpeg" },
    ]));

    const measured = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: mappedR2Client(bodies),
      measuredAt,
      measurementId,
    });

    expect(measured.status).toBe("passed");
    expect(measured.evidence).toMatchObject({
      recovered_objects: 8,
      published_event_objects_checked: 1,
      manifest_source_objects_checked: 7,
      visual_objects_checked: 8,
    });
  });

  it("preserves the exact three-object manifest-source PDF contract", async () => {
    const eventBytes = Buffer.from("immutable event crop");
    const { manifest, bodies } = pdfSourceR2Fixture(eventBytes);
    const measured = await measureStage1R2RecoveryDrill({
      target,
      manifest,
      appRevision: "revision-current",
      r2Client: mappedR2Client(bodies),
      measuredAt,
      measurementId,
    });

    expect(measured.status).toBe("passed");
    expect(measured.evidence).toMatchObject({
      recovered_objects: 4,
      published_event_objects_checked: 1,
      manifest_source_objects_checked: 3,
      visual_objects_checked: 4,
    });
  });

  it("rejects mutable, incomplete, mixed-generation, legacy-hash, and duplicate source bindings", async () => {
    const eventBytes = Buffer.from("immutable crop");
    const pageBytes = Buffer.from("immutable page image");
    const textBytes = Buffer.from("Eligibility\n", "utf8");
    const base = mixedR2Manifest({ eventBytes, pageBytes, textBytes });
    const client = { async send() { throw new Error("validation must happen before R2"); } };

    for (const mutate of [
      (manifest) => {
        manifest.objects.find((object) => object.scope === "manifest_source").side =
          "previous";
      },
      (manifest) => {
        const meta = manifest.objects.find((object) => object.artifact === "meta");
        meta.object_key = meta.object_key.replace(/meta[.]json$/, "document.pdf");
        meta.content_type = "application/pdf";
      },
      (manifest) => {
        manifest.objects.find((object) => object.artifact === "text").object_key =
          "visual-snapshots/sources/11111111-1111-4111-8111-111111111111/latest/text.txt";
      },
      (manifest) => {
        manifest.objects = manifest.objects.filter((object) => object.artifact !== "thumb");
        refreshManifestCounts(manifest);
      },
      (manifest) => {
        manifest.objects.find((object) => object.artifact === "text").object_key =
          "visual-snapshots/sources/11111111-1111-4111-8111-111111111111/captures/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/text.txt";
      },
      (manifest) => {
        const text = manifest.objects.find((object) => object.artifact === "text");
        text.object_key = manifest.objects.find((object) => object.artifact === "page").object_key;
      },
      (manifest) => {
        manifest.objects = manifest.objects.filter(
          (object) => object.artifact !== "expansion_state_01_layout",
        );
        refreshManifestCounts(manifest);
      },
      (manifest) => {
        manifest.objects = manifest.objects.filter(
          (object) => object.artifact !== "layout",
        );
        refreshManifestCounts(manifest);
      },
      (manifest) => {
        const text = manifest.objects.find((object) => object.artifact === "text");
        text.hash_mode = "utf8_text_single_trailing_newline_v1";
        text.semantic_length = "Eligibility".length;
      },
      (manifest) => {
        manifest.objects.find((object) => object.artifact === "meta").content_type =
          "application/json";
      },
      (manifest) => {
        manifest.schema_version = "awardping.stage1.r2-verification-manifest.v2";
      },
      (manifest) => {
        delete manifest.artifact_bindings_schema;
      },
      (manifest) => {
        manifest.artifact_bindings_schema = "awardping.r2.capture-artifact-bindings.v0";
      },
    ]) {
      const malformed = structuredClone(base);
      mutate(malformed);
      await expect(measureStage1R2RecoveryDrill({
        target,
        manifest: malformed,
        appRevision: "revision-current",
        r2Client: client,
        measuredAt,
        measurementId,
      })).rejects.toThrow(/invalid object binding|incomplete or target-mismatched/);
    }
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
      supabaseServiceRoleKey: "service-role-key",
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
      supabaseServiceRoleKey: "service-role-key",
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
      supabaseServiceRoleKey: "service-role-key",
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
  redirectNonCohort = false,
  exposeVault = false,
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
    if (
      url ===
        `${target.supabase_origin}/rest/v1/decrypted_secrets?select=id&limit=1`
    ) {
      expect(options.headers["accept-profile"]).toBe("vault");
      expect(options.headers.apikey).toBe("service-role-key");
      expect(options.headers.authorization).toBe("Bearer service-role-key");
      return exposeVault
        ? jsonResponse([])
        : jsonResponse({ code: "PGRST106", message: "schema unavailable" }, 406);
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
      if (redirectNonCohort) {
        return new Response("", {
          status: 302,
          headers: {
            location:
              "https://elsewhere.example/public-path?token=SUPER_SECRET#fragment",
          },
        });
      }
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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
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

function r2Manifest(bytes, contract = {}) {
  const eventObject = publishedEventObject(bytes, contract);
  return {
    schema_version: "awardping.stage1.r2-verification-manifest.v3",
    artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    target,
    visual_object_count: 1,
    published_event_object_count: 1,
    manifest_source_object_count: 0,
    visual_object_set_hash: "f".repeat(64),
    unexpected_bucket_count: 0,
    malformed_object_count: 0,
    manifest_binding_error_count: 0,
    duplicate_object_key_count: 0,
    objects: [eventObject],
  };
}

function publishedEventObject(bytes, {
  artifact = "crop",
  candidateId = publishedEventCandidateId,
  side = "current",
  role = "changed-section-crop",
  contentType = "image/jpeg",
  extension = "jpg",
} = {}) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bucket: target.r2_bucket,
    scope: "published_event",
    source_id: null,
    candidate_id: candidateId,
    artifact,
    side,
    object_key: publishedVisualEvidenceObjectKey({
      candidateId,
      side,
      role,
      sha256,
      extension,
    }),
    sha256,
    hash_mode: "raw_sha256",
    byte_length: bytes.length,
    semantic_length: null,
    content_type: contentType,
  };
}

function setPublishedEventObjectKey(object, overrides = {}) {
  const segments = String(object.object_key || "").split("/");
  const fileName = segments.at(-1) || "";
  object.object_key = publishedVisualEvidenceObjectKey({
    candidateId: overrides.candidateId || object.candidate_id,
    side: overrides.side || object.side,
    role: overrides.role || segments.at(-2),
    sha256: overrides.sha256 || object.sha256,
    extension: overrides.extension || fileName.split(".").at(-1),
  });
}

function mixedR2Manifest({ eventBytes, pageBytes, textBytes }) {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}`;
  const sourceBodies = mixedR2SourceBodies({ pageBytes, textBytes });
  const sourceContracts = [
    ["page", "page.jpg", "image/jpeg"],
    ["thumb", "thumb.jpg", "image/jpeg"],
    ["text", "text.txt", "text/plain; charset=utf-8"],
    ["meta", "meta.json", "application/json; charset=utf-8"],
    ["layout", "layout.json", "application/json; charset=utf-8"],
    ["expansion_state_01", "expansion-state-01.jpg", "image/jpeg"],
    [
      "expansion_state_01_layout",
      "expansion-state-01-layout.json",
      "application/json; charset=utf-8",
    ],
  ];
  const sourceObjects = sourceContracts.map(([artifact, fileName, contentType]) => ({
    bucket: target.r2_bucket,
    scope: "manifest_source",
    source_id: sourceId,
    candidate_id: null,
    artifact,
    side: "current",
    object_key: `${prefix}/${fileName}`,
    sha256: createHash("sha256").update(sourceBodies[artifact]).digest("hex"),
    hash_mode: "raw_sha256",
    byte_length: sourceBodies[artifact].length,
    semantic_length: null,
    content_type: contentType,
  }));
  return {
    schema_version: "awardping.stage1.r2-verification-manifest.v3",
    artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    target,
    visual_object_count: 1 + sourceObjects.length,
    published_event_object_count: 1,
    manifest_source_object_count: sourceObjects.length,
    visual_object_set_hash: "f".repeat(64),
    unexpected_bucket_count: 0,
    malformed_object_count: 0,
    manifest_binding_error_count: 0,
    duplicate_object_key_count: 0,
    objects: [
      publishedEventObject(eventBytes),
      ...sourceObjects,
    ],
  };
}

function mixedR2SourceBodies({ pageBytes, textBytes }) {
  return {
    page: pageBytes,
    thumb: Buffer.from("immutable thumbnail image"),
    text: textBytes,
    meta: Buffer.from('{"capture":"bound"}\n'),
    layout: Buffer.from('{"runs":[]}\n'),
    expansion_state_01: Buffer.from("immutable expanded page image"),
    expansion_state_01_layout: Buffer.from('{"runs":[{"text":"Eligibility"}]}\n'),
  };
}

function pdfSourceR2Fixture(eventBytes) {
  const sourceId = "44444444-4444-4444-8444-444444444444";
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${"c".repeat(32)}`;
  const sourceBodies = {
    meta: Buffer.from('{"kind":"pdf"}\n', "utf8"),
    pdf: Buffer.from("%PDF-1.7\nimmutable source document\n", "utf8"),
    text: Buffer.from("Official source document\n", "utf8"),
  };
  const contracts = [
    ["meta", "meta.json", "application/json; charset=utf-8"],
    ["pdf", "document.pdf", "application/pdf"],
    ["text", "text.txt", "text/plain; charset=utf-8"],
  ];
  const manifest = r2Manifest(eventBytes);
  manifest.objects.push(...contracts.map(([artifact, fileName, contentType]) => ({
    bucket: target.r2_bucket,
    scope: "manifest_source",
    source_id: sourceId,
    candidate_id: null,
    artifact,
    side: "current",
    object_key: `${prefix}/${fileName}`,
    sha256: createHash("sha256").update(sourceBodies[artifact]).digest("hex"),
    hash_mode: "raw_sha256",
    byte_length: sourceBodies[artifact].length,
    semantic_length: null,
    content_type: contentType,
  })));
  refreshManifestCounts(manifest);
  const bodies = new Map(manifest.objects.map((object) => [
    object.object_key,
    object.scope === "manifest_source"
      ? { body: sourceBodies[object.artifact], contentType: object.content_type }
      : { body: eventBytes, contentType: object.content_type },
  ]));
  return { manifest, bodies };
}

function refreshManifestCounts(manifest) {
  manifest.visual_object_count = manifest.objects.length;
  manifest.published_event_object_count = manifest.objects.filter(
    (object) => object.scope === "published_event",
  ).length;
  manifest.manifest_source_object_count = manifest.objects.filter(
    (object) => object.scope === "manifest_source",
  ).length;
}

function mappedR2Client(bodies) {
  return {
    async send(command) {
      const entry = bodies.get(command.input.Key);
      if (!entry) throw new Error(`Unexpected R2 object: ${command.input.Key}`);
      return {
        ContentType: entry.contentType,
        Body: { async transformToByteArray() { return entry.body; } },
      };
    },
  };
}

function r2Client(bytes, objectKey) {
  return {
    async send(command) {
      expect(command.input).toMatchObject({
        Bucket: target.r2_bucket,
        Key: objectKey,
      });
      return {
        ContentType: "image/jpeg",
        Body: { async transformToByteArray() { return bytes; } },
      };
    },
  };
}
