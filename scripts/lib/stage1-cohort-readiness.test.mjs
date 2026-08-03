import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_REMOTE_EFFECTIVE_BLOCKER,
  STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION,
  STAGE1_COHORT_DEFINITION,
  allStage1SearchKeys,
  buildStage1ReadinessReport,
  effectiveStage1PromotionCounts,
  inspectLocalVisualEvidence,
  isStage1DurableVerificationTimestampValid,
  isStage1LiveSourceCheckCurrent,
  isStage1ReviewedPromotionReady,
  nextActionForBlocker,
  rankOfficialSourceCandidates,
  reviewedStage1PromotionCounts,
  stage1ManifestSourceAuthority,
  sourceIdentityDisposition,
  validateExactStage1Definition,
  validateRemoteSnapshot,
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

  it("accepts the authoritative v3 publication snapshot contract", () => {
    const snapshot = {
      schema_version: STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION,
      cohorts: STAGE1_COHORT_DEFINITION.map((entry, index) => ({
        registry: { cohort_key: entry.cohortKey },
        members: [
          { member_kind: "canonical", shared_award_id: `canonical-${index}` },
          { member_kind: "alias", shared_award_id: `alias-${index}` },
        ],
      })),
    };

    expect(STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION).toBe(3);
    expect(validateRemoteSnapshot(snapshot)).toMatchObject({
      ok: true,
      errors: [],
      cohort_count: 25,
      canonical_member_count: 25,
      alias_member_count: 25,
    });
    expect(validateRemoteSnapshot({ ...snapshot, schema_version: 1 })).toMatchObject({
      ok: false,
      errors: ["unexpected_schema_version:1"],
    });
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

  it("uses the reviewed current Hertz and NDSEG product roots and exact role paths", () => {
    const cases = [
      {
        cohortKey: "hertz",
        oldHomepage: "https://www.hertzfoundation.org/the-fellowship/",
        sources: [
          source("hertz-home", "https://www.hertzfoundation.org/hertz-fellowship/", "Hertz Fellowship", "homepage"),
          source("hertz-old", "https://www.hertzfoundation.org/the-fellowship/", "Prior Hertz Fellowship", "homepage"),
          source("hertz-eligibility", "https://www.hertzfoundation.org/hertz-fellowship/who-can-apply/", "Who Can Apply", "eligibility"),
          source("hertz-apply", "https://www.hertzfoundation.org/hertz-fellowship/apply/", "Apply", "application"),
          source("hertz-funding", "https://www.hertzfoundation.org/hertz-fellowship/fellowship-benefits/", "Fellowship Benefits", "other"),
          source("hertz-faq", "https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/", "FAQ", "faq"),
        ],
        expected: {
          identity_home: "https://www.hertzfoundation.org/hertz-fellowship/",
          eligibility: "https://www.hertzfoundation.org/hertz-fellowship/who-can-apply/",
          application_materials: "https://www.hertzfoundation.org/hertz-fellowship/apply/",
          dates_cycle: "https://www.hertzfoundation.org/hertz-fellowship/apply/",
          funding: "https://www.hertzfoundation.org/hertz-fellowship/fellowship-benefits/",
          faq: "https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/",
          selection_interviews: "https://www.hertzfoundation.org/hertz-fellowship/apply/",
        },
      },
      {
        cohortKey: "ndseg",
        oldHomepage: "https://ndseg.org/",
        sources: [
          source("ndseg-home", "https://ndseg.sysplus.com/NDSEG/", "NDSEG", "homepage"),
          source("ndseg-old", "https://ndseg.org/", "Prior NDSEG identity", "homepage"),
          source("ndseg-eligibility", "https://ndseg.sysplus.com/NDSEG/About/Eligibility.aspx", "Eligibility", "eligibility"),
          source("ndseg-application", "https://ndseg.sysplus.com/NDSEG/Applicants/Application-Evaluation-Award", "Application, Evaluation & Award", "application"),
          source("ndseg-funding", "https://ndseg.sysplus.com/NDSEG/About/", "About NDSEG", "other"),
          source("ndseg-faq", "https://ndseg.sysplus.com/NDSEG/FAQ/Application", "Application FAQ", "faq"),
        ],
        expected: {
          identity_home: "https://ndseg.org/",
          eligibility: "https://ndseg.sysplus.com/NDSEG/About/Eligibility.aspx",
          application_materials: "https://ndseg.sysplus.com/NDSEG/Applicants/Application-Evaluation-Award",
          funding: "https://ndseg.sysplus.com/NDSEG/About/",
          faq: "https://ndseg.sysplus.com/NDSEG/FAQ/Application",
          selection_interviews: "https://ndseg.sysplus.com/NDSEG/Applicants/Application-Evaluation-Award",
        },
      },
    ];

    for (const testCase of cases) {
      const definition = STAGE1_COHORT_DEFINITION.find(
        (entry) => entry.cohortKey === testCase.cohortKey,
      );
      expect(definition.officialHomepage).toBe(testCase.expected.identity_home);
      for (const [role, url] of Object.entries(testCase.expected)) {
        const ranked = rankOfficialSourceCandidates({
          cohort: definition,
          role,
          sources: testCase.sources,
        });
        expect(ranked[0]?.url, `${testCase.cohortKey}/${role}`).toBe(url);
        expect(ranked[0]?.reasons, `${testCase.cohortKey}/${role}`)
          .toContain(role === "identity_home"
            ? "exact_official_homepage"
            : "program_specific_preferred_path");
        if (testCase.cohortKey === "ndseg" && role !== "identity_home") {
          expect(ranked[0]?.reasons).toContain("official_delegated_contractor");
        }
      }
    }
  });

  it("enforces canonical and delegated source authority at manifest binding time", () => {
    const ndseg = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "ndseg");
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://ndseg.org/",
      role: "identity_home",
      cohort: ndseg,
    })).toMatchObject({
      host: "ndseg.org",
      classification: "canonical_program_host",
      evidence_url: "https://ndseg.org/",
    });
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply",
      role: "dates_cycle",
      cohort: ndseg,
    })).toMatchObject({
      host: "ndseg.sysplus.com",
      classification: "official_contractor_host",
      evidence_url: "https://ndseg.org/apply-link",
    });
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://unrelated.example/ndseg-dates",
      role: "dates_cycle",
      cohort: ndseg,
    })).toBeNull();
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://ndseg.sysplus.com/",
      role: "identity_home",
      cohort: ndseg,
    })).toBeNull();
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://updates.ndseg.org/",
      role: "dates_cycle",
      cohort: ndseg,
    })).toBeNull();
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "http://ndseg.org/",
      role: "dates_cycle",
      cohort: ndseg,
    })).toBeNull();
    expect(stage1ManifestSourceAuthority({
      sourceUrl: "https://operator@ndseg.org/",
      role: "dates_cycle",
      cohort: ndseg,
    })).toBeNull();

    const identityCandidates = rankOfficialSourceCandidates({
      cohort: ndseg,
      role: "identity_home",
      sources: [
        source("delegated-home", "https://ndseg.sysplus.com/", "NDSEG contractor", "homepage"),
        source("canonical-home", "https://ndseg.org/", "NDSEG", "homepage"),
      ],
    });
    expect(identityCandidates.map((candidate) => candidate.url)).toEqual([
      "https://ndseg.org/",
    ]);
  });

  it("binds every Yenching and Samvid role to the reviewed official guidance paths", () => {
    const cases = [
      {
        cohortKey: "yenching",
        sources: [
          source("yenching-home", "https://yenchingacademy.pku.edu.cn/", "Yenching Academy", "homepage"),
          source("yenching-admissions", "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm", "Admissions", "application"),
          source("yenching-faq", "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm", "Frequently Asked Questions", "faq"),
        ],
        expected: {
          identity_home: "https://yenchingacademy.pku.edu.cn/",
          eligibility: "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm",
          application_materials: "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm",
          dates_cycle: "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm",
          funding: "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm",
          faq: "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
          selection_interviews: "https://yenchingacademy.pku.edu.cn/ADMISSIONS/Frequently_Asked_Questions.htm",
          current_documents: "https://yenchingacademy.pku.edu.cn/ADMISSIONS.htm",
        },
      },
      {
        cohortKey: "samvid",
        sources: [
          source("samvid-home", "https://samvidscholars.org/", "Samvid Scholars", "homepage"),
          source("samvid-apply", "https://samvidscholars.org/how-to-apply/", "How to Apply", "application"),
          source("samvid-program", "https://samvidscholars.org/program-details/", "Program Details", "other"),
        ],
        expected: {
          identity_home: "https://samvidscholars.org/",
          eligibility: "https://samvidscholars.org/how-to-apply/",
          application_materials: "https://samvidscholars.org/how-to-apply/",
          dates_cycle: "https://samvidscholars.org/how-to-apply/",
          funding: "https://samvidscholars.org/",
          faq: "https://samvidscholars.org/how-to-apply/",
          selection_interviews: "https://samvidscholars.org/how-to-apply/",
          current_documents: "https://samvidscholars.org/how-to-apply/",
        },
      },
    ];

    for (const entry of cases) {
      const cohortDefinition = STAGE1_COHORT_DEFINITION.find(
        (cohort) => cohort.cohortKey === entry.cohortKey,
      );
      for (const [role, url] of Object.entries(entry.expected)) {
        const ranked = rankOfficialSourceCandidates({
          cohort: cohortDefinition,
          role,
          sources: entry.sources,
        });
        expect(ranked[0]?.url, `${entry.cohortKey}:${role}`).toBe(url);
        expect(ranked[0]?.reasons, `${entry.cohortKey}:${role}`).toContain(
          "program_specific_preferred_path",
        );
      }
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

  it("hard-excludes non-US Rhodes constituency guidance without excluding US or global pages", () => {
    const rhodes = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "rhodes_us");
    const canada = source(
      "canada",
      "https://www.rhodeshouse.ox.ac.uk/media/clefvna2/canada-information-for-candidates-document-2027-final.pdf",
      "Rhodes Scholarship Canada Information for Candidates",
      "pdf",
    );
    const usa = source(
      "usa",
      "https://www.rhodeshouse.ox.ac.uk/files/usainformationforcandidates/",
      "Rhodes Scholarship USA Information for Candidates",
      "pdf",
    );
    const global = source(
      "global",
      "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/",
      "The Rhodes Scholarship",
      "homepage",
    );
    const indianapolis = source(
      "indianapolis",
      "https://www.rhodeshouse.ox.ac.uk/news/indianapolis-rhodes-scholar/",
      "Indianapolis Rhodes Scholar profile",
      "other",
    );

    expect(sourceIdentityDisposition(canada, rhodes.identityRules)).toMatchObject({
      excluded: true,
      rule_key: "exclude_rhodes_non_us_constituencies",
    });
    for (const eligible of [usa, global, indianapolis]) {
      expect(sourceIdentityDisposition(eligible, rhodes.identityRules)).toMatchObject({
        excluded: false,
      });
    }
    expect(rankOfficialSourceCandidates({
      cohort: rhodes,
      role: "current_documents",
      sources: [canada, usa],
    }).map((candidate) => candidate.url)).toEqual([usa.url]);
  });

  it("hard-excludes the distinct Gilman-McCain scholarship from Gilman roles", () => {
    const gilman = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "gilman");
    const mccain = source(
      "mccain",
      "https://www.gilmanscholarship.org/program/gilman-mccain-scholarships/",
      "Gilman-McCain Scholarship eligibility requirements",
      "eligibility",
    );
    const gilmanEligibility = source(
      "gilman-eligibility",
      "https://www.gilmanscholarship.org/applicants/eligibility/",
      "Gilman Scholarship eligibility",
      "eligibility",
    );

    expect(sourceIdentityDisposition(mccain, gilman.identityRules)).toMatchObject({
      excluded: true,
      rule_key: "exclude_gilman_mccain",
    });
    expect(sourceIdentityDisposition(gilmanEligibility, gilman.identityRules)).toMatchObject({
      excluded: false,
    });
    expect(rankOfficialSourceCandidates({
      cohort: gilman,
      role: "eligibility",
      sources: [mccain, gilmanEligibility],
    }).map((candidate) => candidate.url)).toEqual([gilmanEligibility.url]);
  });

  it("ranks Gilman's reviewed applicant pages above open recipient pages for every launch role", () => {
    const gilman = STAGE1_COHORT_DEFINITION.find((entry) => entry.cohortKey === "gilman");
    const preferred = [
      ["eligibility", "/applicants/eligibility/", "Gilman Scholarship Eligibility", "eligibility"],
      ["application_materials", "/applicants/application-overview/", "Application Overview", "application"],
      ["dates_cycle", "/applicants/deadlines-and-timeline/", "Deadlines & Timeline", "deadline"],
      ["funding", "/applicants/selection-criteria/", "Priorities & Selection Criteria", "requirements"],
      ["faq", "/applicants/applicants-faq-2/", "Applicants FAQ", "faq"],
      ["selection_interviews", "/applicants/selection-criteria/", "Priorities & Selection Criteria", "requirements"],
      ["current_documents", "/wp-content/uploads/2025/01/Application-PDF-Version.pdf", "Application PDF Version", "pdf"],
    ];
    const irrelevant = {
      ...source(
        "recipient",
        "https://www.gilmanscholarship.org/current-recipients/receiving-scholarship/",
        "Receiving Your Scholarship requirements",
        "requirements",
      ),
      admin_review_status: "open",
      last_checked_at: "2026-07-16T12:00:00.000Z",
    };

    for (const [role, path, title, pageType] of preferred) {
      const applicant = {
        ...source(
          `applicant-${role}`,
          `https://www.gilmanscholarship.org${path}`,
          title,
          pageType,
        ),
        admin_review_status: "review_later",
      };
      const ranked = rankOfficialSourceCandidates({
        cohort: gilman,
        role,
        sources: [irrelevant, applicant],
        now: new Date("2026-07-17T00:00:00.000Z"),
      });

      expect(ranked[0]).toMatchObject({
        url: applicant.url,
        reasons: expect.arrayContaining(["program_specific_preferred_path"]),
      });
    }
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

  it("turns every required evidence-query failure into a critical global blocker", () => {
    const report = buildStage1ReadinessReport({
      generatedAt: "2026-07-16T18:00:00.000Z",
      registryMode: "fallback_exact_definition",
      publicationSnapshotError: "function_not_found",
      archiveRoot: join(tmpdir(), "does-not-exist"),
      queryInventory: {
        errors: [{
          query: "shared_award_fact_candidates",
          code: "stage1_exact_count_unavailable",
          message: "The required exact count was unavailable.",
        }],
      },
    });

    expect(report.global_blockers).toContainEqual(expect.objectContaining({
      code: "required_stage1_query_failed",
      severity: "critical",
      evidence: expect.objectContaining({
        failed_query_count: 1,
        failed_queries: [expect.objectContaining({
          query: "shared_award_fact_candidates",
          code: "stage1_exact_count_unavailable",
        })],
      }),
    }));
    expect(report.summary.ready_for_verified_beta_count).toBe(0);
    expect(report.safe_next_action_plan.actions).toContainEqual(expect.objectContaining({
      blocker_code: "required_stage1_query_failed",
      action_type: "restore_readiness_evidence",
      creates_api_charge: "no",
    }));
  });

  it("never reports globally blocked cohorts as verified-beta ready", () => {
    const cohortReports = STAGE1_COHORT_DEFINITION.map((entry) => ({
      cohort_key: entry.cohortKey,
      ready_for_verified_beta_promotion: true,
    }));

    expect(effectiveStage1PromotionCounts({
      cohortReports,
      globalBlockers: [{ code: "required_stage1_query_failed", severity: "critical" }],
    })).toEqual({
      cohort_level_ready_count: 25,
      global_release_gate_clear: false,
      overall_ready_for_verified_beta: false,
      ready_for_verified_beta_count: 0,
      blocked_count: 25,
    });
  });

  it("removes only the expected remote gate from reviewed-promotion readiness", () => {
    expect(isStage1ReviewedPromotionReady([])).toBe(true);
    expect(isStage1ReviewedPromotionReady([
      { code: STAGE1_REMOTE_EFFECTIVE_BLOCKER },
    ])).toBe(true);
    expect(isStage1ReviewedPromotionReady([
      { code: STAGE1_REMOTE_EFFECTIVE_BLOCKER },
      { code: "canonical_page_audit_not_fresh_pass" },
    ])).toBe(false);
    expect(isStage1ReviewedPromotionReady([
      { code: "canonical_page_audit_not_fresh_pass" },
    ])).toBe(false);
  });

  it("keeps global evidence failures closed in reviewed-promotion counts", () => {
    const cohortReports = STAGE1_COHORT_DEFINITION.map((entry) => ({
      cohort_key: entry.cohortKey,
      ready_for_reviewed_promotion: true,
    }));

    expect(reviewedStage1PromotionCounts({
      cohortReports,
      globalBlockers: [{ code: "required_stage1_query_failed" }],
    })).toEqual({
      cohort_level_pre_promotion_ready_count: 25,
      global_pre_promotion_gate_clear: false,
      overall_ready_for_reviewed_promotion: false,
      ready_for_reviewed_promotion_count: 0,
      pre_promotion_blocked_count: 25,
    });
  });

  it("keeps unchanged immutable verification while requiring a current live source check", () => {
    const now = new Date("2026-07-17T18:00:00.000Z");

    expect(isStage1DurableVerificationTimestampValid("2025-01-01T00:00:00.000Z", now)).toBe(true);
    expect(isStage1DurableVerificationTimestampValid("2026-07-17T18:05:00.000Z", now)).toBe(true);
    expect(isStage1DurableVerificationTimestampValid("2026-07-17T18:05:00.001Z", now)).toBe(false);
    expect(isStage1DurableVerificationTimestampValid(null, now)).toBe(false);

    expect(isStage1LiveSourceCheckCurrent("2026-07-16T18:00:00.000Z", now)).toBe(true);
    expect(isStage1LiveSourceCheckCurrent("2026-07-16T17:59:59.999Z", now)).toBe(false);
    expect(isStage1LiveSourceCheckCurrent("2026-07-17T18:05:00.001Z", now)).toBe(false);
  });

  it("never treats an unavailable quarantine inventory as zero open quarantine", () => {
    const report = buildStage1ReadinessReport({
      generatedAt: "2026-07-16T18:00:00.000Z",
      registryMode: "fallback_exact_definition",
      publicationSnapshotError: "function_not_found",
      quarantines: [],
      archiveRoot: join(tmpdir(), "does-not-exist"),
      queryInventory: {
        errors: [{
          query: "manual_quarantine_registry_by_award",
          code: "query_failed",
          message: "statement timeout",
        }],
      },
    });

    expect(report.summary.actionable_quarantine_open).toBe(0);
    expect(report.global_blockers).toContainEqual(expect.objectContaining({
      code: "required_stage1_query_failed",
      evidence: expect.objectContaining({
        failed_queries: [expect.objectContaining({
          query: "manual_quarantine_registry_by_award",
        })],
      }),
    }));
    expect(report.summary.blockers_by_code.required_stage1_query_failed).toBe(1);
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
