import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_COHORT_DEFINITION,
  allStage1SearchKeys,
  buildStage1ReadinessReport,
  inspectLocalVisualEvidence,
  nextActionForBlocker,
  rankOfficialSourceCandidates,
  sourceIdentityDisposition,
  validateExactStage1Definition,
} from "./stage1-cohort-readiness.mjs";

const temporaryPaths = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Stage 1 cohort readiness preflight", () => {
  it("pins exactly the intended 25 national awards and 25 retained aliases without substitutions", () => {
    const expectedCanonicalSearchKeys = [
      "rhodes scholarship",
      "marshall scholarship",
      "fulbright u.s. student program",
      "gates cambridge scholarship",
      "churchill scholarship",
      "schwarzman scholars",
      "knight-hennessy scholars",
      "yenching academy scholars",
      "luce scholars program",
      "truman scholarship",
      "goldwater scholarship",
      "udall scholarship",
      "beinecke scholarship",
      "gilman international scholarship",
      "boren awards",
      "critical language scholarship",
      "nsf graduate research fellowship program",
      "hertz foundation graduate fellowship",
      "national defense science and engineering graduate fellowship",
      "smart scholarship for service program",
      "gem national consortium",
      "noaa hollings scholarship",
      "paul & daisy soros fellowships for new americans",
      "samvid scholars program",
      "james c. gaither junior fellows program",
    ];

    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);
    expect(STAGE1_COHORT_DEFINITION.map((entry) => entry.launchRank)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(STAGE1_COHORT_DEFINITION.map((entry) => entry.canonicalSearchKey)).toEqual(
      expectedCanonicalSearchKeys,
    );
    expect(STAGE1_COHORT_DEFINITION.flatMap((entry) => entry.aliasSearchKeys)).toHaveLength(25);
    expect(allStage1SearchKeys()).toHaveLength(50);
    expect(new Set(allStage1SearchKeys())).toHaveProperty("size", 50);
    expect(validateExactStage1Definition()).toEqual({
      ok: true,
      errors: [],
      cohort_count: 25,
      alias_count: 25,
      unique_search_key_count: 50,
    });

    expect(allStage1SearchKeys()).toContain("udall scholarship");
    expect(allStage1SearchKeys()).toContain("gem national consortium");
    expect(allStage1SearchKeys()).toContain("smart scholarship for service program");
    expect(allStage1SearchKeys()).not.toContain("marshall sherfield fellowship");
    expect(allStage1SearchKeys()).not.toContain("gem fellowship");
  });

  it("treats the Marshall home and Apply pages as the core role candidates", () => {
    const marshall = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "marshall");
    const sources = [
      source("home", "https://www.marshallscholarship.org/", "Marshall Scholarship", "homepage"),
      source("apply", "https://www.marshallscholarship.org/apply/", "Apply", "application"),
      source("eligibility", "https://www.marshallscholarship.org/apply/eligibility/", "Eligibility", "eligibility"),
      source("faqs", "https://www.marshallscholarship.org/apply/faqs/", "FAQs", "faq"),
      source("interviews", "https://www.marshallscholarship.org/apply/interviews/", "Interviews", "other"),
      source("generic", "https://www.marshallscholarship.org/news/", "News", "other"),
    ];
    const expected = {
      identity_home: "https://www.marshallscholarship.org/",
      application_materials: "https://www.marshallscholarship.org/apply/",
      eligibility: "https://www.marshallscholarship.org/apply/eligibility/",
      faq: "https://www.marshallscholarship.org/apply/faqs/",
      selection_interviews: "https://www.marshallscholarship.org/apply/interviews/",
    };

    for (const [role, url] of Object.entries(expected)) {
      const ranked = rankOfficialSourceCandidates({ cohort: marshall, role, sources });
      expect(ranked[0]?.url, role).toBe(url);
      expect(ranked[0]?.reasons, role).toContain("program_specific_preferred_path");
    }
  });

  it("hard-excludes Marshall Sherfield URLs, media filenames, and postdoctoral titles", () => {
    const marshall = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "marshall");
    const cases = [
      source("sherfield", "https://www.marshallscholarship.org/marshall-sherfield/", "Marshall Sherfield", "homepage"),
      source("msf", "https://www.marshallscholarship.org/media/123/msf_rules.pdf", "Rules", "pdf"),
      source("postdoc", "https://www.marshallscholarship.org/another-page/", "Postdoctoral opportunity", "other"),
    ];
    for (const item of cases) {
      expect(sourceIdentityDisposition(item, marshall.identityRules)).toMatchObject({
        excluded: true,
        rule_key: "exclude_marshall_sherfield",
      });
    }
    expect(rankOfficialSourceCandidates({
      cohort: marshall,
      role: "current_documents",
      sources: cases,
    })).toEqual([]);
  });

  it("proves local evidence only when identity, capture, hashes, safe paths, and files all match", () => {
    const archiveRoot = join(tmpdir(), `awardping-stage1-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    temporaryPaths.push(archiveRoot);
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const awardId = "22222222-2222-4222-8222-222222222222";
    const captureDir = join(archiveRoot, "sources", sourceId, "captures", "capture-1");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "page.jpg"), "image");
    writeFileSync(join(captureDir, "text.txt"), "text");
    writeFileSync(join(captureDir, "meta.json"), "{}");
    writeFileSync(join(archiveRoot, "sources", sourceId, "baseline.json"), JSON.stringify({
      source: { id: sourceId, shared_award_id: awardId },
      captured_at: "2026-07-16T12:00:00.000Z",
      image_hash: "image-hash",
      text_hash: "text-hash",
      capture: {
        dir: `sources/${sourceId}/captures/capture-1`,
        page: `sources/${sourceId}/captures/capture-1/page.jpg`,
        text: `sources/${sourceId}/captures/capture-1/text.txt`,
        meta: `sources/${sourceId}/captures/capture-1/meta.json`,
      },
    }));

    const result = inspectLocalVisualEvidence({
      archiveRoot,
      source: { id: sourceId, shared_award_id: awardId },
      snapshot: {
        latest_captured_at: "2026-07-16T12:00:00Z",
        latest_hashes: { image_hash: "image-hash", text_hash: "text-hash", file_hash: null },
      },
    });
    expect(result).toMatchObject({
      baseline_exists: true,
      baseline_readable: true,
      source_identity_matches: true,
      capture_timestamp_matches: true,
      snapshot_hashes_match: true,
      artifact_paths_safe: true,
      missing_artifacts: [],
      exact_available: true,
    });
  });

  it("produces a fail-closed 25-award report and machine-readable no-charge registry action before deployment", () => {
    const report = buildStage1ReadinessReport({
      generatedAt: "2026-07-16T18:00:00.000Z",
      registryMode: "fallback_exact_definition",
      publicationSnapshotError: "function_not_found",
      archiveRoot: join(tmpdir(), "does-not-exist"),
    });

    expect(report.cohorts).toHaveLength(25);
    expect(report.required_source_roles).toEqual(REQUIRED_SOURCE_ROLES);
    expect(report.summary.ready_for_verified_beta_count).toBe(0);
    expect(report.read_only_attestation).toMatchObject({
      remote_mutations: 0,
      paid_api_calls: 0,
      captures: 0,
      r2_object_requests: 0,
    });
    expect(report.safe_next_action_plan.actions[0]).toMatchObject({
      action_type: "validate_and_deploy_registry",
      creates_api_charge: "no",
      mutates_remote_state: true,
      safe_to_run_automatically: false,
    });
  });

  it("recommends the actual repair lane for canonical audit and reconciliation blockers", () => {
    const cohort = { cohort_key: "marshall", launch_rank: 2 };

    expect(nextActionForBlocker(cohort, {
      code: "canonical_page_audit_not_fresh_pass",
      evidence: { status: "warnings" },
    })).toMatchObject({
      action_type: "review_audit_failure",
      creates_api_charge: "no",
      priority: 5,
    });
    expect(nextActionForBlocker(cohort, {
      code: "canonical_reconciliation_not_fresh_success",
      evidence: { status: "failed" },
    })).toMatchObject({
      action_type: "repair_then_reconcile",
      creates_api_charge: "no",
      priority: 4,
    });
    expect(nextActionForBlocker(cohort, {
      code: "canonical_homepage_drift",
      evidence: {},
    })).toMatchObject({
      action_type: "repair_exact_identity",
      priority: 2,
    });
  });

  it("keeps the live CLI structurally read-only", () => {
    const cli = readFileSync(new URL("../read-stage1-cohort-readiness.mjs", import.meta.url), "utf8");
    expect(cli).toContain('supabase.rpc("get_stage1_publication_snapshot")');
    for (const mutation of [".insert(", ".upsert(", ".update(", ".delete("]) {
      expect(cli, mutation).not.toContain(mutation);
    }
    expect(cli).not.toContain("capture-visual-snapshots");
    expect(cli).not.toContain("GEMINI_API_KEY");
    expect(cli).not.toContain("OPENAI_API_KEY");
  });
});

function source(id, url, title, pageType) {
  return {
    id,
    shared_award_id: "marshall-award",
    url,
    title,
    display_title: null,
    page_description: null,
    reason: null,
    page_type: pageType,
    confidence: 1,
    admin_review_status: "open",
    last_checked_at: new Date().toISOString(),
    last_error: null,
  };
}
