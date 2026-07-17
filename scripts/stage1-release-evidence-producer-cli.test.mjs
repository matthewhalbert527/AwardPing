import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./record-stage1-signed-release-evidence.mjs", import.meta.url),
  "utf8",
);

describe("Stage 1 release evidence producer CLI", () => {
  it("has no generic arbitrary-JSON import path", () => {
    expect(source).not.toContain("--evidence-json");
    expect(source).not.toContain("get_stage1_release_external_signing_payload");
    expect(source).not.toMatch(/readFileSync\([^)]*evidence/i);
  });

  it("measures a DB-owned target and uses only kind-specific preflights", () => {
    expect(source).toContain('"get_stage1_release_producer_target"');
    expect(source).toContain("validateStage1ReleaseProducerTarget(targetRow)");
    expect(source).toContain("supabaseUrl !== target.supabaseOrigin");
    expect(source).toContain("stage1ExternalReleasePreflightName(kind)");
    expect(source).toContain("stage1ExternalReleaseRecorderName(kind)");
    for (const producer of [
      "measureStage1HostedRuntimeIdentity",
      "measureStage1NonCohortLeakCrawl",
      "measureStage1R2RecoveryDrill",
      "measureStage1RollbackDrill",
    ]) {
      expect(source).toContain(producer);
    }
  });

  it("does not read the HMAC secret on a dry-run path", () => {
    const dryRunIndex = source.indexOf("if (args.apply !== true)");
    const secretIndex = source.indexOf(
      "AWARDPING_STAGE1_RELEASE_EVIDENCE_HMAC_SECRET",
    );
    expect(dryRunIndex).toBeGreaterThan(0);
    expect(secretIndex).toBeGreaterThan(dryRunIndex);
  });

  it("requires an explicit exact production-origin confirmation for rollback", () => {
    expect(source).toContain('values["execute-production-rollback"] === true');
    expect(source).toContain('values["confirm-production-origin"]');
    expect(source).toContain("assertProjectIdentity");
  });

  it("requires new Supabase keys and uses the secret-safe service transport", () => {
    expect(source).toContain("createSupabaseServiceClient");
    expect(source).toContain(
      'requireKeyPrefix(serviceRoleKey, "sb_secret_", "SUPABASE_SERVICE_ROLE_KEY")',
    );
    expect(source).toContain(
      'requireKeyPrefix(supabaseAnonKey, "sb_publishable_", "SUPABASE_ANON_KEY")',
    );
    expect(source).not.toContain('createClient(supabaseUrl, serviceRoleKey');
  });
});
