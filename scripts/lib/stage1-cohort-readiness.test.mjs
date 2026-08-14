import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { bindVisualTextGeometry } from "./visual-event-localization.mjs";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_REMOTE_EFFECTIVE_BLOCKER,
  STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION,
  STAGE1_COHORT_DEFINITION,
  allStage1SearchKeys,
  buildStage1ReadinessReport,
  effectiveStage1PromotionCounts,
  inspectLocalVisualEvidence,
  inspectStage1ImmutableR2CaptureBinding,
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const awardId = "22222222-2222-4222-8222-222222222222";
    const fixture = writeWebEvidenceFixture({ sourceId, awardId });

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(result).toMatchObject({
      baseline_exists: true,
      baseline_readable: true,
      source_identity_matches: true,
      capture_timestamp_matches: true,
      snapshot_hashes_match: true,
      artifact_paths_safe: true,
      missing_artifacts: [],
      artifact_hashes_match: true,
      recomputed_artifact_hashes: {
        image_hash: fixture.imageHash,
        text_hash: fixture.textHash,
        layout_hash: fixture.layout.geometry_hash,
      },
      mismatched_artifact_hash_fields: [],
      artifact_integrity_failures: [],
      metadata_bindings_match: true,
      text_object_bindings_match: true,
      layout_binding_required: true,
      layout_bindings_match: true,
      exact_available: true,
    });
  });

  it.each([
    ["mutable latest alias", (snapshot) => {
      snapshot.latest_object_keys.page = snapshot.latest_object_keys.page
        .replace(/\/captures\/[a-f0-9]{32}\//, "/latest/");
    }, "object_key_unsafe_or_mutable:page"],
    ["mixed generation", (snapshot) => {
      snapshot.latest_object_keys.thumb = snapshot.latest_object_keys.thumb
        .replace("a".repeat(32), "b".repeat(32));
    }, "object_keys_mixed_generations"],
    ["wrong source", (snapshot) => {
      snapshot.latest_object_keys.page = snapshot.latest_object_keys.page
        .replace(snapshot.shared_award_source_id, "ffffffff-ffff-4fff-8fff-ffffffffffff");
    }, "object_key_wrong_source:page"],
    ["incomplete webpage core", (snapshot) => {
      delete snapshot.latest_object_keys.thumb;
    }, "object_key_core_slot_missing:thumb"],
    ["missing artifact-binding schema", (snapshot) => {
      delete snapshot.latest_metadata.artifact_bindings_schema;
    }, "artifact_bindings_schema_missing_or_invalid"],
    ["artifact-binding slot mismatch", (snapshot) => {
      delete snapshot.latest_metadata.artifact_bindings.thumb;
    }, "artifact_binding_slots_do_not_match_object_keys"],
    ["malformed raw artifact binding", (snapshot) => {
      snapshot.latest_metadata.artifact_bindings.page.hash_mode = "semantic";
    }, "artifact_binding_missing_or_invalid:page"],
    ["stringified raw artifact byte length", (snapshot) => {
      snapshot.latest_metadata.artifact_bindings.page.byte_length = String(
        snapshot.latest_metadata.artifact_bindings.page.byte_length,
      );
    }, "artifact_binding_missing_or_invalid:page"],
    ["extra raw artifact binding field", (snapshot) => {
      snapshot.latest_metadata.artifact_bindings.page.unreviewed = true;
    }, "artifact_binding_missing_or_invalid:page"],
    ["stringified pointer metadata length", (snapshot) => {
      snapshot.latest_metadata.page_bytes = String(snapshot.latest_metadata.page_bytes);
    }, "metadata_length_missing_or_invalid:page_bytes"],
    ["missing retained-artifact projection", (snapshot) => {
      delete snapshot.latest_metadata.retained_artifact_projection;
    }, "retained_artifact_projection_missing_or_invalid"],
    ["contradictory retained-artifact projection", (snapshot) => {
      snapshot.latest_metadata.retained_artifact_projection.authoritative.layout_retained = false;
    }, "retained_artifact_projection_missing_or_invalid"],
  ])("rejects %s in an otherwise complete immutable R2 capture binding", (
    _label,
    mutate,
    expectedError,
  ) => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "15151515-1515-4515-8515-151515151515",
      awardId: "26262626-2626-4626-8626-262626262626",
    });
    mutate(fixture.snapshot);
    const binding = inspectStage1ImmutableR2CaptureBinding(fixture.snapshot);
    expect(binding.valid).toBe(false);
    expect(binding.errors).toContain(expectedError);
  });

  it("requires every authoritative main-layout claim to form one consistent binding", () => {
    const missingHash = writeWebEvidenceFixture({
      sourceId: "16161616-1616-4616-8616-161616161616",
      awardId: "27272727-2727-4727-8727-272727272727",
    });
    delete missingHash.snapshot.latest_hashes.layout_hash;
    expect(inspectStage1ImmutableR2CaptureBinding(missingHash.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["layout_hash_binding_missing:hashes"]),
    });

    const metadataOnly = writeWebEvidenceFixture({
      sourceId: "17171717-1717-4717-8717-171717171717",
      awardId: "28282828-2828-4828-8828-282828282828",
    });
    delete metadataOnly.snapshot.latest_object_keys.layout;
    expect(inspectStage1ImmutableR2CaptureBinding(metadataOnly.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["layout_object_key_missing"]),
    });

    const misleadingReadyState = writeWebEvidenceFixture({
      sourceId: "57575757-5757-4757-8757-575757575757",
      awardId: "68686868-6868-4868-8868-686868686868",
    });
    misleadingReadyState.snapshot.latest_metadata.localization = {
      ...misleadingReadyState.snapshot.latest_metadata.localization,
      status: "unavailable_capture_verification",
      geometry_ready: false,
      unavailable_reason: "The retained geometry was not verified.",
    };
    expect(inspectStage1ImmutableR2CaptureBinding(misleadingReadyState.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["layout_localization_state_mismatch"]),
    });

    const unaccounted = writeWebEvidenceFixture({
      sourceId: "18181818-1818-4818-8818-181818181818",
      awardId: "29292929-2929-4929-8929-292929292929",
    });
    removeAuthoritativeLayoutClaim(unaccounted.snapshot);
    unaccounted.snapshot.latest_metadata.localization = {};
    expect(inspectStage1ImmutableR2CaptureBinding(unaccounted.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["layout_missing_without_explicit_unavailable_status"]),
    });

    unaccounted.snapshot.latest_metadata.localization = {
      status: "geometry_ready",
      accounted_for: true,
      geometry_ready: false,
      unavailable_reason: "contradictory_ready_status",
    };
    expect(inspectStage1ImmutableR2CaptureBinding(unaccounted.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["layout_missing_without_explicit_unavailable_status"]),
    });

    unaccounted.snapshot.latest_metadata.localization = {
      status: "evidence_only_geometry_unavailable",
      exact: false,
      accounted_for: true,
      geometry_ready: false,
      unavailable_reason: "authoritative_layout_not_retained",
      geometry_hash: null,
      bound_image_hash: null,
    };
    expect(inspectStage1ImmutableR2CaptureBinding(unaccounted.snapshot)).toMatchObject({
      valid: true,
      layout_claimed: false,
      layout_explicitly_unavailable: true,
    });
  });

  it("requires every local webpage core slot, including the thumbnail", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "19191919-1919-4919-8919-191919191919",
      awardId: "30303030-3030-4030-8030-303030303030",
    });
    rmSync(fixture.paths.thumb);
    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(result.missing_artifacts).toContainEqual({ role: "thumb", reason: "file_missing" });
    expect(result.exact_available).toBe(false);
  });

  it("canonicalizes benign URL syntax while preserving query meaning", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "20202020-2020-4020-8020-202020202020",
      awardId: "31313131-3131-4131-8131-313131313131",
      sourceUrl: "https://www.example.test/award/?cycle=2027",
    });
    fixture.meta.source.url = "https://EXAMPLE.test/award?cycle=2027#eligibility";
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    expect(inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    }).exact_available).toBe(true);

    fixture.meta.source.url = "https://example.test/award?cycle=2028";
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    const changedQuery = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(changedQuery.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "meta",
      reason: "meta_source_url_mismatch",
    }));
    expect(changedQuery.exact_available).toBe(false);

    fixture.meta.source.url = "https://example.test/award?cycle=2027";
    fixture.snapshot.source_url = "https://example.test/award?cycle=2028";
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    const pointerQueryDrift = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(pointerQueryDrift.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      reason: "immutable_r2_source_url_binding_mismatch",
    }));
    expect(pointerQueryDrift.exact_available).toBe(false);
  });

  it("verifies every retained expansion-state screenshot and layout pair", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "21212121-2121-4121-8121-212121212121",
      awardId: "32323232-3232-4232-8232-323232323232",
    });
    const expansion = addExpansionStateEvidence(fixture);
    const valid = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(valid).toMatchObject({
      immutable_r2_binding_valid: true,
      expansion_state_bindings_match: true,
      recomputed_artifact_hashes: {
        expansion_state_01_image_hash: expansion.imageHash,
        expansion_state_01_layout_hash: expansion.layout.geometry_hash,
      },
      exact_available: true,
    });

    writeFileSync(expansion.paths.page, Buffer.from("tampered expansion screenshot"));
    const tampered = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(tampered.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "expansion_state_01",
      reason: "expansion_state_image_artifact_hash_mismatch",
    }));
    expect(tampered.exact_available).toBe(false);
  });

  it("rejects malformed, unsafe, or incomplete expansion-state evidence", () => {
    const malformed = writeWebEvidenceFixture({
      sourceId: "23232323-2323-4323-8323-232323232323",
      awardId: "34343434-3434-4434-8434-343434343434",
    });
    const malformedExpansion = addExpansionStateEvidence(malformed);
    writeFileSync(malformedExpansion.paths.layout, "{not-json");
    expect(inspectLocalVisualEvidence({
      archiveRoot: malformed.archiveRoot,
      source: malformed.source,
      snapshot: malformed.snapshot,
    })).toMatchObject({ expansion_state_bindings_match: false, exact_available: false });

    const unsafe = writeWebEvidenceFixture({
      sourceId: "24242424-2424-4424-8424-242424242424",
      awardId: "35353535-3535-4535-8535-353535353535",
    });
    addExpansionStateEvidence(unsafe);
    unsafe.baseline.capture.expansion_states[0].page = "../outside.jpg";
    writeFileSync(
      join(unsafe.archiveRoot, "sources", unsafe.source.id, "baseline.json"),
      JSON.stringify(unsafe.baseline),
    );
    const unsafeResult = inspectLocalVisualEvidence({
      archiveRoot: unsafe.archiveRoot,
      source: unsafe.source,
      snapshot: unsafe.snapshot,
    });
    expect(unsafeResult.artifact_paths_safe).toBe(false);
    expect(unsafeResult.exact_available).toBe(false);

    const incomplete = writeWebEvidenceFixture({
      sourceId: "25252525-2525-4525-8525-252525252525",
      awardId: "36363636-3636-4636-8636-363636363636",
    });
    addExpansionStateEvidence(incomplete);
    delete incomplete.snapshot.latest_object_keys.expansion_state_01_layout;
    expect(inspectStage1ImmutableR2CaptureBinding(incomplete.snapshot)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["expansion_layout_key_missing:01"]),
    });
    expect(inspectLocalVisualEvidence({
      archiveRoot: incomplete.archiveRoot,
      source: incomplete.source,
      snapshot: incomplete.snapshot,
    })).toMatchObject({
      immutable_r2_binding_valid: false,
      expansion_state_bindings_match: false,
      exact_available: false,
    });

    const expansionWithoutMain = writeWebEvidenceFixture({
      sourceId: "27272727-2727-4727-8727-272727272727",
      awardId: "38383838-3838-4838-8838-383838383838",
    });
    addExpansionStateEvidence(expansionWithoutMain);
    removeAuthoritativeLayoutClaim(expansionWithoutMain.snapshot);
    expansionWithoutMain.snapshot.latest_metadata.localization = {
      status: "evidence_only_geometry_unavailable",
      exact: false,
      accounted_for: true,
      geometry_ready: false,
      unavailable_reason: "main_layout_missing",
      geometry_hash: null,
      bound_image_hash: null,
    };
    expect(inspectStage1ImmutableR2CaptureBinding(expansionWithoutMain.snapshot)).toMatchObject({
      valid: true,
      errors: [],
      layout_claimed: false,
      expansion_states: [expect.objectContaining({ state_id: "expansion-state-01" })],
    });
    delete expansionWithoutMain.baseline.layout_hash;
    delete expansionWithoutMain.baseline.text_geometry;
    delete expansionWithoutMain.baseline.capture.layout;
    expansionWithoutMain.meta.layout_hash = null;
    expansionWithoutMain.meta.text_geometry = {
      status: "unavailable_layout_changed_during_screenshot",
      unavailable_reason: "main_layout_missing",
      geometry_hash: null,
      node_count: 0,
      run_count: 0,
      file: null,
      screenshot: { image_hash: null, image_ref: null },
    };
    expansionWithoutMain.meta.localization = structuredClone(
      expansionWithoutMain.snapshot.latest_metadata.localization,
    );
    expansionWithoutMain.meta.retained_artifact_projection = structuredClone(
      expansionWithoutMain.snapshot.latest_metadata.retained_artifact_projection,
    );
    expansionWithoutMain.meta.files.layout = null;
    expansionWithoutMain.baseline.summary_metadata.retained_artifact_projection = structuredClone(
      expansionWithoutMain.snapshot.latest_metadata.retained_artifact_projection,
    );
    writeFileSync(expansionWithoutMain.paths.meta, JSON.stringify(expansionWithoutMain.meta));
    refreshFixtureMetaBinding(expansionWithoutMain);
    writeFileSync(
      join(
        expansionWithoutMain.archiveRoot,
        "sources",
        expansionWithoutMain.source.id,
        "baseline.json",
      ),
      JSON.stringify(expansionWithoutMain.baseline),
    );
    expect(inspectLocalVisualEvidence({
      archiveRoot: expansionWithoutMain.archiveRoot,
      source: expansionWithoutMain.source,
      snapshot: expansionWithoutMain.snapshot,
    })).toMatchObject({
      immutable_r2_binding_valid: true,
      expansion_state_bindings_match: true,
      layout_binding_required: false,
      exact_available: true,
    });
  });

  it.each([
    ["missing exact=false", (metadata) => { delete metadata.localization.exact; }],
    ["exact=true", (metadata) => { metadata.localization.exact = true; }],
    ["unaccounted", (metadata) => { metadata.localization.accounted_for = false; }],
    ["geometry ready", (metadata) => { metadata.localization.geometry_ready = true; }],
    ["localization geometry hash", (metadata) => { metadata.localization.geometry_hash = "a".repeat(64); }],
    ["retained layout file", (metadata) => { metadata.files = { layout: "layout.json" }; }],
    ["geometry file", (metadata) => { metadata.text_geometry.file = "layout.json"; }],
    ["geometry image ref", (metadata) => { metadata.text_geometry.screenshot.image_ref = "page.jpg"; }],
    ["nonzero node count", (metadata) => { metadata.text_geometry.node_count = 1; }],
    ["nonzero run count", (metadata) => { metadata.text_geometry.run_count = 1; }],
    ["contradictory availability", (metadata) => { metadata.text_geometry.availability_status = "ready"; }],
  ])("rejects a non-canonical unavailable-layout marker: %s", (_label, mutate) => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "28282828-2828-4828-8828-282828282828",
      awardId: "39393939-3939-4939-8939-393939393939",
    });
    removeAuthoritativeLayoutClaim(fixture.snapshot);
    fixture.snapshot.latest_metadata.text_geometry = {
      status: "unavailable_layout_changed_during_screenshot",
      unavailable_reason: "The page moved.",
      geometry_hash: null,
      node_count: 0,
      run_count: 0,
      file: null,
      screenshot: { image_hash: null, image_ref: null },
    };
    fixture.snapshot.latest_metadata.files = { layout: null };
    fixture.snapshot.latest_metadata.localization = {
      status: "evidence_only_geometry_unavailable",
      exact: false,
      accounted_for: true,
      geometry_ready: false,
      unavailable_reason: "The page moved.",
      geometry_hash: null,
      bound_image_hash: null,
    };
    mutate(fixture.snapshot.latest_metadata);
    expect(inspectStage1ImmutableR2CaptureBinding(fixture.snapshot)).toMatchObject({
      valid: false,
      layout_explicitly_unavailable: false,
    });
  });

  it("rejects local artifacts whose bytes do not match otherwise-consistent baseline and snapshot claims", () => {
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const awardId = "44444444-4444-4444-8444-444444444444";
    const fixture = writeWebEvidenceFixture({
      sourceId,
      awardId,
      imageBytes: Buffer.from("expected-image"),
      text: "expected text",
    });
    writeFileSync(fixture.paths.page, Buffer.from("tampered-image"));
    writeFileSync(fixture.paths.text, "tampered text\n");

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });

    expect(result.snapshot_hashes_match).toBe(true);
    expect(result.artifact_hashes_match).toBe(false);
    expect(result.mismatched_artifact_hash_fields).toEqual(["image_hash", "text_hash"]);
    expect(result.artifact_integrity_failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash_field: "image_hash", reason: "artifact_hash_mismatch" }),
      expect.objectContaining({ hash_field: "text_hash", reason: "artifact_hash_mismatch" }),
    ]));
    expect(result.exact_available).toBe(false);
  });

  it.each([
    ["source identity", (meta) => { meta.source.id = "ffffffff-ffff-4fff-8fff-ffffffffffff"; }, "meta_source_id_mismatch"],
    ["award identity", (meta) => { meta.source.shared_award_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; }, "meta_shared_award_id_mismatch"],
    ["source URL", (meta) => { meta.source.url = "https://example.test/other"; }, "meta_source_url_mismatch"],
    ["capture timestamp", (meta) => { meta.captured_at = "2026-07-16T12:01:00.000Z"; }, "meta_captured_at_mismatch"],
    ["core image hash", (meta) => { meta.image_hash = "a".repeat(64); }, "meta_core_hash_mismatch"],
    ["localization geometry hash", (meta) => { meta.localization.geometry_hash = "c".repeat(64); }, "meta_layout_hash_binding_mismatch"],
    ["localization screenshot identity", (meta) => { meta.text_geometry.screenshot.image_ref = "sources/other/page.jpg"; }, "meta_layout_artifact_identity_mismatch"],
    ["localization node count", (meta) => { meta.text_geometry.node_count += 1; }, "meta_layout_reference_mismatch"],
    ["localization status", (meta) => { meta.localization.status = "unavailable"; }, "meta_localization_state_mismatch"],
  ])("rejects altered metadata %s even when page, text, baseline, and snapshot hashes still match", (
    _label,
    mutate,
    expectedReason,
  ) => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "77777777-7777-4777-8777-777777777777",
      awardId: "88888888-8888-4888-8888-888888888888",
    });
    mutate(fixture.meta);
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });

    expect(result.snapshot_hashes_match).toBe(true);
    expect(result.metadata_bindings_match).toBe(false);
    expect(result.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "meta",
      reason: expectedReason,
    }));
    if (/^(?:meta_layout|meta_localization)/.test(expectedReason)) {
      expect(result.layout_bindings_match).toBe(false);
    }
    expect(result.exact_available).toBe(false);
  });

  it.each([
    ["geometry content", (layout) => { layout.nodes[0].text = "altered geometry text"; }, "layout_geometry_binding_invalid"],
    ["screenshot hash", (layout) => { layout.screenshot.image_hash = "b".repeat(64); }, "layout_bound_image_hash_mismatch"],
    ["screenshot identity", (layout) => { layout.screenshot.image_ref = "sources/other/captures/capture-1/page.jpg"; }, "layout_bound_image_identity_mismatch"],
    ["capture state", (layout) => { layout.state_id = "other"; }, "layout_state_identity_mismatch"],
  ])("rejects altered layout %s even when the screenshot and text bytes still match", (
    _label,
    mutate,
    expectedReason,
  ) => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "99999999-9999-4999-8999-999999999999",
      awardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    mutate(fixture.layout);
    writeFileSync(fixture.paths.layout, JSON.stringify(fixture.layout));

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });

    expect(result.snapshot_hashes_match).toBe(true);
    expect(result.layout_binding_required).toBe(true);
    expect(result.layout_bindings_match).toBe(false);
    expect(result.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "layout",
      reason: expectedReason,
    }));
    expect(result.exact_available).toBe(false);
  });

  it("requires a valid layout artifact whenever the snapshot publishes a layout hash", () => {
    const missing = writeWebEvidenceFixture({
      sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      awardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    rmSync(missing.paths.layout);
    const missingResult = inspectLocalVisualEvidence({
      archiveRoot: missing.archiveRoot,
      source: missing.source,
      snapshot: missing.snapshot,
    });
    expect(missingResult.missing_artifacts).toContainEqual({ role: "layout", reason: "file_missing" });
    expect(missingResult.layout_bindings_match).toBe(false);
    expect(missingResult.exact_available).toBe(false);

    const malformed = writeWebEvidenceFixture({
      sourceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      awardId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    writeFileSync(malformed.paths.layout, "{not-json");
    const malformedResult = inspectLocalVisualEvidence({
      archiveRoot: malformed.archiveRoot,
      source: malformed.source,
      snapshot: malformed.snapshot,
    });
    expect(malformedResult.artifact_integrity_failures).toContainEqual({
      artifact_role: "layout",
      reason: "layout_json_invalid",
    });
    expect(malformedResult.layout_bindings_match).toBe(false);
    expect(malformedResult.exact_available).toBe(false);
  });

  it("rejects local layout claims that contradict an authoritative unavailable-layout contract", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "14141414-1414-4414-8414-141414141414",
      awardId: "25252525-2525-4525-8525-252525252525",
    });
    removeAuthoritativeLayoutClaim(fixture.snapshot);
    fixture.snapshot.latest_metadata.localization = {
      status: "evidence_only_geometry_unavailable",
      exact: false,
      accounted_for: true,
      geometry_ready: false,
      unavailable_reason: "authoritative_layout_not_retained",
      geometry_hash: null,
      bound_image_hash: null,
    };
    delete fixture.meta.layout_hash;
    delete fixture.meta.text_geometry;
    fixture.meta.localization = structuredClone(fixture.snapshot.latest_metadata.localization);
    fixture.meta.retained_artifact_projection = structuredClone(
      fixture.snapshot.latest_metadata.retained_artifact_projection,
    );
    fixture.baseline.summary_metadata.retained_artifact_projection = structuredClone(
      fixture.snapshot.latest_metadata.retained_artifact_projection,
    );
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    writeFileSync(fixture.paths.layout, "{locally-altered-layout");

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(result).toMatchObject({
      layout_binding_required: false,
      layout_bindings_match: null,
      exact_available: false,
    });
    expect(result.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "layout",
      reason: "local_layout_claim_conflicts_with_r2_unavailable",
    }));

    delete fixture.baseline.layout_hash;
    delete fixture.baseline.text_geometry;
    delete fixture.baseline.capture.layout;
    fixture.meta.files.layout = null;
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    writeFileSync(
      join(fixture.archiveRoot, "sources", fixture.source.id, "baseline.json"),
      JSON.stringify(fixture.baseline),
    );
    expect(inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    })).toMatchObject({
      layout_binding_required: false,
      layout_bindings_match: null,
      exact_available: true,
    });

    fixture.meta.localization = {
      status: "unavailable",
      unavailable_reason: "evidence_only_geometry_unavailable",
    };
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    expect(inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    })).toMatchObject({
      metadata_bindings_match: false,
      exact_available: false,
    });

    delete fixture.meta.localization;
    writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
    refreshFixtureMetaBinding(fixture);
    expect(inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    })).toMatchObject({
      metadata_bindings_match: false,
      exact_available: false,
    });
  });

  it("requires parseable metadata instead of trusting its mere file existence", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "12121212-1212-4212-8212-121212121212",
      awardId: "34343434-3434-4434-8434-343434343434",
    });
    writeFileSync(fixture.paths.meta, "[]");

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(result.metadata_bindings_match).toBe(false);
    expect(result.artifact_integrity_failures).toContainEqual({
      artifact_role: "meta",
      reason: "meta_object_invalid",
    });
    expect(result.exact_available).toBe(false);
  });

  it("hashes retained text semantically after exactly one writer framing newline", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "56565656-5656-4656-8656-565656565656",
      awardId: "78787878-7878-4878-8878-787878787878",
      text: "semantic text",
      textArtifact: "semantic text\r\n",
    });
    const accepted = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(accepted.exact_available).toBe(true);

    writeFileSync(fixture.paths.text, "semantic text\n\n");
    const altered = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(altered.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      hash_field: "text_hash",
      reason: "artifact_hash_mismatch",
    }));
    expect(altered.exact_available).toBe(false);
  });

  it("binds the raw text framing length recorded by the immutable snapshot metadata", () => {
    const fixture = writeWebEvidenceFixture({
      sourceId: "13131313-1313-4313-8313-131313131313",
      awardId: "24242424-2424-4424-8424-242424242424",
      text: "same semantic text",
    });
    // Both encodings have the same semantic text_hash after stripping one
    // framing newline, but only the original LF has the recorded byte length.
    writeFileSync(fixture.paths.text, "same semantic text\r\n");

    const result = inspectLocalVisualEvidence({
      archiveRoot: fixture.archiveRoot,
      source: fixture.source,
      snapshot: fixture.snapshot,
    });
    expect(result.recomputed_artifact_hashes.text_hash).toBe(fixture.textHash);
    expect(result.mismatched_artifact_hash_fields).not.toContain("text_hash");
    expect(result.text_object_bindings_match).toBe(false);
    expect(result.artifact_integrity_failures).toContainEqual(expect.objectContaining({
      artifact_role: "text",
      reason: "text_object_byte_length_mismatch",
    }));
    expect(result.exact_available).toBe(false);
  });

  it("binds PDF metadata and semantic text to the retained document bytes", () => {
    const archiveRoot = temporaryArchiveRoot("pdf");
    const sourceId = "90909090-9090-4090-8090-909090909090";
    const awardId = "abababab-abab-4bab-8bab-abababababab";
    const capturedAt = "2026-07-16T12:00:00.000Z";
    const captureRelative = `sources/${sourceId}/captures/capture-1`;
    const captureDir = join(archiveRoot, captureRelative);
    mkdirSync(captureDir, { recursive: true });
    const pdfBytes = Buffer.from("pdf bytes");
    const text = "pdf text";
    const fileHash = sha256(pdfBytes);
    const textHash = sha256(Buffer.from(text, "utf8"));
    const textBytes = Buffer.from(`${text}\n`, "utf8");
    const retainedProjection = {
      schema: "awardping.capture-retained-artifact-projection.v1",
      kind: "pdf",
      localization_status: "not_applicable_pdf",
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
      diagnostics: {
        authority: "diagnostic_only",
        storage_scope: "local_capture_directory_only",
        main_layout: null,
        expansion_states: [],
        excluded_state_count: 0,
      },
    };
    const metaBytes = Buffer.from(JSON.stringify({
      version: 1,
      kind: "pdf",
      source: { id: sourceId, shared_award_id: awardId },
      captured_at: capturedAt,
      file_hash: fileHash,
      image_hash: fileHash,
      text_hash: textHash,
      text_length: text.length,
      file_bytes: pdfBytes.length,
      retained_artifact_projection: retainedProjection,
    }));
    writeFileSync(join(captureDir, "document.pdf"), pdfBytes);
    writeFileSync(join(captureDir, "text.txt"), textBytes);
    writeFileSync(join(captureDir, "meta.json"), metaBytes);
    writeFileSync(join(archiveRoot, "sources", sourceId, "baseline.json"), JSON.stringify({
      version: 1,
      kind: "pdf",
      source: { id: sourceId, shared_award_id: awardId },
      captured_at: capturedAt,
      file_hash: fileHash,
      image_hash: fileHash,
      text_hash: textHash,
      capture: {
        dir: captureRelative,
        pdf: `${captureRelative}/document.pdf`,
        text: `${captureRelative}/text.txt`,
        meta: `${captureRelative}/meta.json`,
      },
      summary_metadata: {
        retained_artifact_projection: retainedProjection,
      },
    }));

    const result = inspectLocalVisualEvidence({
      archiveRoot,
      source: { id: sourceId, shared_award_id: awardId },
      snapshot: {
        shared_award_source_id: sourceId,
        source_url: "https://example.test/document.pdf",
        kind: "pdf",
        bucket: "awardping-test",
        latest_captured_at: "2026-07-16T12:00:00Z",
        latest_object_keys: {
          pdf: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/document.pdf`,
          text: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/text.txt`,
          meta: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/meta.json`,
        },
        latest_hashes: { file_hash: fileHash, image_hash: fileHash, text_hash: textHash },
        latest_metadata: {
          artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
          artifact_bindings: {
            pdf: rawArtifactBinding(pdfBytes, "application/pdf"),
            text: rawArtifactBinding(textBytes, "text/plain; charset=utf-8"),
            meta: rawArtifactBinding(metaBytes, "application/json; charset=utf-8"),
          },
          file_bytes: pdfBytes.length,
          text_object_bytes: Buffer.byteLength(`${text}\n`, "utf8"),
          text_length: text.length,
          retained_artifact_projection: retainedProjection,
        },
      },
    });
    expect(result).toMatchObject({
      metadata_bindings_match: true,
      text_object_bindings_match: true,
      layout_binding_required: false,
      layout_bindings_match: null,
      artifact_hashes_match: true,
      exact_available: true,
    });
  });

  it("fails closed for malformed hash claims and missing required local artifacts", () => {
    const archiveRoot = join(tmpdir(), `awardping-stage1-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    temporaryPaths.push(archiveRoot);
    const sourceId = "55555555-5555-4555-8555-555555555555";
    const awardId = "66666666-6666-4666-8666-666666666666";
    const captureDir = join(archiveRoot, "sources", sourceId, "captures", "capture-1");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "page.jpg"), Buffer.from("image"));
    writeFileSync(join(captureDir, "meta.json"), "{}");
    const textHash = sha256(Buffer.from("text", "utf8"));
    writeFileSync(join(archiveRoot, "sources", sourceId, "baseline.json"), JSON.stringify({
      kind: "webpage",
      source: { id: sourceId, shared_award_id: awardId },
      captured_at: "2026-07-16T12:00:00.000Z",
      image_hash: "not-a-sha256",
      text_hash: textHash,
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
        kind: "webpage",
        latest_captured_at: "2026-07-16T12:00:00Z",
        latest_hashes: { image_hash: "not-a-sha256", text_hash: textHash },
      },
    });

    expect(result.snapshot_hashes_match).toBe(true);
    expect(result.artifact_hashes_match).toBe(false);
    expect(result.missing_artifacts).toContainEqual({ role: "text", reason: "file_missing" });
    expect(result.artifact_integrity_failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash_field: "image_hash", reason: "claimed_hash_missing_or_malformed" }),
      expect.objectContaining({ hash_field: "text_hash", reason: "artifact_file_missing" }),
    ]));
    expect(result.exact_available).toBe(false);
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

function writeWebEvidenceFixture({
  sourceId,
  awardId,
  capturedAt = "2026-07-16T12:00:00.000Z",
  imageBytes = Buffer.from("image"),
  text = "text",
  textArtifact = null,
  sourceUrl = "https://example.test/award",
} = {}) {
  const archiveRoot = temporaryArchiveRoot("web");
  const captureRelative = `sources/${sourceId}/captures/capture-1`;
  const pageRelative = `${captureRelative}/page.jpg`;
  const thumbRelative = `${captureRelative}/thumb.jpg`;
  const textRelative = `${captureRelative}/text.txt`;
  const layoutRelative = `${captureRelative}/layout.json`;
  const metaRelative = `${captureRelative}/meta.json`;
  const captureDir = join(archiveRoot, captureRelative);
  mkdirSync(captureDir, { recursive: true });

  const imageHash = sha256(imageBytes);
  const textHash = sha256(Buffer.from(text, "utf8"));
  const retainedText = textArtifact ?? `${text}\n`;
  const thumbBytes = Buffer.from("thumbnail");
  const layout = bindVisualTextGeometry({
    version: 1,
    state_id: "main",
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 1_000, height: 2_000 },
    viewport: { width: 1_000, height: 800 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    nodes: [{
      order: 0,
      path: "html/body/main/p",
      flow_path: "html/body/main/p",
      text,
      separator_before: "",
      rects: [{ x: 20, y: 40, width: 200, height: 24 }],
      runs: [{
        start: 0,
        end: text.length,
        text,
        rects: [{ x: 20, y: 40, width: 200, height: 24 }],
      }],
    }],
  }, {
    capturedAt,
    imageHash,
    imageRef: pageRelative,
    screenshot: {
      css_width: 1_000,
      css_height: 2_000,
      pixel_width: 1_000,
      pixel_height: 2_000,
    },
  });
  const textGeometry = {
    version: layout.version,
    status: "ready",
    unavailable_reason: null,
    geometry_hash: layout.geometry_hash,
    coordinate_space: layout.coordinate_space,
    node_count: layout.node_count,
    run_count: layout.run_count,
    document: layout.document,
    viewport: layout.viewport,
    screenshot: layout.screenshot,
    file: layoutRelative,
  };
  const retainedProjection = {
    schema: "awardping.capture-retained-artifact-projection.v1",
    kind: "webpage",
    localization_status: "exact_geometry_available",
    authoritative: {
      layout_retained: true,
      layout_hash: layout.geometry_hash,
      expansion_state_count: 0,
    },
    diagnostics: {
      authority: "diagnostic_only",
      storage_scope: "local_capture_directory_only",
      main_layout: null,
      expansion_states: [],
      excluded_state_count: 0,
    },
  };
  const meta = {
    version: 1,
    kind: "webpage",
    source: { id: sourceId, shared_award_id: awardId, url: sourceUrl },
    captured_at: capturedAt,
    image_hash: imageHash,
    text_hash: textHash,
    text_length: text.length,
    page_bytes: imageBytes.length,
    thumb_bytes: thumbBytes.length,
    layout_hash: layout.geometry_hash,
    text_geometry: textGeometry,
    localization: {
      status: "geometry_ready",
      exact: false,
      accounted_for: true,
      geometry_ready: true,
      unavailable_reason: null,
      geometry_hash: layout.geometry_hash,
      bound_image_hash: imageHash,
      semantic_crop_contract: "visual-exact-text-binding-v2",
      captured_at: capturedAt,
    },
    expansion_state_screenshots: [],
    retained_artifact_projection: structuredClone(retainedProjection),
    files: {
      page: pageRelative,
      thumb: thumbRelative,
      text: textRelative,
      layout: layoutRelative,
      meta: metaRelative,
      expansion_states: [],
    },
  };
  const baseline = {
    version: 1,
    kind: "webpage",
    source: { id: sourceId, shared_award_id: awardId, url: sourceUrl },
    captured_at: capturedAt,
    image_hash: imageHash,
    text_hash: textHash,
    layout_hash: layout.geometry_hash,
    text_geometry: textGeometry,
    capture: {
      dir: captureRelative,
      page: pageRelative,
      thumb: thumbRelative,
      text: textRelative,
      layout: layoutRelative,
      meta: metaRelative,
      expansion_states: [],
    },
    summary_metadata: {
      retained_artifact_projection: structuredClone(retainedProjection),
    },
  };
  const snapshot = {
    shared_award_source_id: sourceId,
    source_url: sourceUrl,
    kind: "webpage",
    bucket: "awardping-test",
    latest_captured_at: capturedAt,
    latest_object_keys: {
      page: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/page.jpg`,
      thumb: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/thumb.jpg`,
      text: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/text.txt`,
      layout: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/layout.json`,
      meta: `visual-snapshots/sources/${sourceId}/captures/${"a".repeat(32)}/meta.json`,
    },
    latest_hashes: {
      image_hash: imageHash,
      text_hash: textHash,
      layout_hash: layout.geometry_hash,
      file_hash: null,
    },
    latest_metadata: {
      artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
      artifact_bindings: {
        page: rawArtifactBinding(imageBytes, "image/jpeg"),
        thumb: rawArtifactBinding(thumbBytes, "image/jpeg"),
        text: rawArtifactBinding(Buffer.from(retainedText, "utf8"), "text/plain; charset=utf-8"),
        layout: rawArtifactBinding(
          Buffer.from(JSON.stringify(layout)),
          "application/json; charset=utf-8",
        ),
        meta: rawArtifactBinding(
          Buffer.from(JSON.stringify(meta)),
          "application/json; charset=utf-8",
        ),
      },
      text_object_bytes: Buffer.byteLength(retainedText, "utf8"),
      text_length: text.length,
      page_bytes: imageBytes.length,
      thumb_bytes: thumbBytes.length,
      layout_hash: layout.geometry_hash,
      text_geometry: textGeometry,
      localization: meta.localization,
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      retained_artifact_projection: structuredClone(retainedProjection),
    },
  };
  const paths = {
    page: join(captureDir, "page.jpg"),
    thumb: join(captureDir, "thumb.jpg"),
    text: join(captureDir, "text.txt"),
    layout: join(captureDir, "layout.json"),
    meta: join(captureDir, "meta.json"),
  };
  writeFileSync(paths.page, imageBytes);
  writeFileSync(paths.thumb, thumbBytes);
  // text_hash is semantic; the writer's LF (and legacy CRLF) is storage framing.
  writeFileSync(paths.text, retainedText);
  writeFileSync(paths.layout, JSON.stringify(layout));
  writeFileSync(paths.meta, JSON.stringify(meta));
  writeFileSync(
    join(archiveRoot, "sources", sourceId, "baseline.json"),
    JSON.stringify(baseline),
  );

  return {
    archiveRoot,
    source: { id: sourceId, shared_award_id: awardId, url: sourceUrl },
    snapshot,
    baseline,
    layout,
    meta,
    paths,
    imageHash,
    textHash,
  };
}

function addExpansionStateEvidence(fixture) {
  const stateId = "expansion-state-01";
  const capturedAt = "2026-07-16T12:00:01.000Z";
  const captureRelative = fixture.baseline.capture.dir;
  const pageRelative = `${captureRelative}/expansion-state-01.jpg`;
  const layoutRelative = `${captureRelative}/expansion-state-01-layout.json`;
  const pageBytes = Buffer.from("expanded accordion screenshot");
  const imageHash = sha256(pageBytes);
  const text = "Expanded eligibility wording";
  const textHash = sha256(Buffer.from(text, "utf8"));
  const layout = bindVisualTextGeometry({
    version: 1,
    state_id: stateId,
    captured_at: capturedAt,
    coordinate_space: "document-css-pixels",
    document: { width: 1_000, height: 2_200 },
    viewport: { width: 1_000, height: 800 },
    scroll: { x: 0, y: 0 },
    device_pixel_ratio: 1,
    nodes: [{
      order: 0,
      path: "html/body/main/details/p",
      flow_path: "html/body/main/details/p",
      text,
      separator_before: "",
      rects: [{ x: 30, y: 400, width: 300, height: 24 }],
      runs: [{
        start: 0,
        end: text.length,
        text,
        rects: [{ x: 30, y: 400, width: 300, height: 24 }],
      }],
    }],
  }, {
    capturedAt,
    imageHash,
    imageRef: pageRelative,
    screenshot: {
      css_width: 1_000,
      css_height: 2_200,
      pixel_width: 1_000,
      pixel_height: 2_200,
    },
  });
  const textGeometry = {
    version: layout.version,
    status: "ready",
    unavailable_reason: null,
    geometry_hash: layout.geometry_hash,
    coordinate_space: layout.coordinate_space,
    node_count: layout.node_count,
    run_count: layout.run_count,
    document: layout.document,
    viewport: layout.viewport,
    screenshot: layout.screenshot,
    file: layoutRelative,
  };
  const isolation = { verified: true, fresh_page: true };
  fixture.baseline.capture.expansion_states = [{
    state_id: stateId,
    index: 0,
    label: "Eligibility",
    captured_at: capturedAt,
    image_hash: imageHash,
    layout_hash: layout.geometry_hash,
    isolation,
    page: pageRelative,
    layout: layoutRelative,
  }];
  fixture.meta.expansion_state_screenshots = [{
    state_id: stateId,
    index: 0,
    tag: "details",
    label: "Eligibility",
    page: pageRelative,
    image_hash: imageHash,
    layout: layoutRelative,
    layout_hash: layout.geometry_hash,
    text_geometry: textGeometry,
    text_hash: textHash,
    text_length: text.length,
    page_bytes: pageBytes.length,
    isolation,
  }];
  fixture.meta.files.expansion_states = [{
    state_id: stateId,
    label: "Eligibility",
    page: pageRelative,
    layout: layoutRelative,
  }];
  const generationPrefix = fixture.snapshot.latest_object_keys.page.replace(/\/page[.]jpg$/, "");
  fixture.snapshot.latest_object_keys.expansion_state_01 =
    `${generationPrefix}/expansion-state-01.jpg`;
  fixture.snapshot.latest_object_keys.expansion_state_01_layout =
    `${generationPrefix}/expansion-state-01-layout.json`;
  fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01 =
    rawArtifactBinding(pageBytes, "image/jpeg");
  fixture.snapshot.latest_metadata.artifact_bindings.expansion_state_01_layout =
    rawArtifactBinding(
      Buffer.from(JSON.stringify(layout)),
      "application/json; charset=utf-8",
    );
  fixture.snapshot.latest_metadata.expansion_state_count = 1;
  fixture.snapshot.latest_metadata.expansion_state_screenshots = [{
    state_id: stateId,
    label: "Eligibility",
    image_hash: imageHash,
    layout_hash: layout.geometry_hash,
    text_geometry: textGeometry,
    text_hash: textHash,
    text_length: text.length,
    page_bytes: pageBytes.length,
    isolation,
  }];
  fixture.snapshot.latest_metadata.retained_artifact_projection.authoritative
    .expansion_state_count = 1;
  fixture.meta.retained_artifact_projection.authoritative.expansion_state_count = 1;
  fixture.baseline.summary_metadata.retained_artifact_projection.authoritative
    .expansion_state_count = 1;
  const paths = {
    page: join(fixture.archiveRoot, pageRelative),
    layout: join(fixture.archiveRoot, layoutRelative),
  };
  writeFileSync(paths.page, pageBytes);
  writeFileSync(paths.layout, JSON.stringify(layout));
  writeFileSync(fixture.paths.meta, JSON.stringify(fixture.meta));
  refreshFixtureMetaBinding(fixture);
  writeFileSync(
    join(fixture.archiveRoot, "sources", fixture.source.id, "baseline.json"),
    JSON.stringify(fixture.baseline),
  );
  return { paths, layout, imageHash };
}

function removeAuthoritativeLayoutClaim(snapshot) {
  delete snapshot.latest_object_keys.layout;
  delete snapshot.latest_metadata.artifact_bindings.layout;
  delete snapshot.latest_hashes.layout_hash;
  delete snapshot.latest_metadata.layout_hash;
  delete snapshot.latest_metadata.text_geometry;
  delete snapshot.latest_metadata.localization?.geometry_hash;
  snapshot.latest_metadata.retained_artifact_projection = {
    ...snapshot.latest_metadata.retained_artifact_projection,
    localization_status: "evidence_only_geometry_unavailable",
    authoritative: {
      ...snapshot.latest_metadata.retained_artifact_projection?.authoritative,
      layout_retained: false,
      layout_hash: null,
    },
  };
}

function rawArtifactBinding(bytes, contentType) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    sha256: sha256(body),
    byte_length: body.length,
    content_type: contentType,
    hash_mode: "raw_sha256",
  };
}

function refreshFixtureMetaBinding(fixture) {
  fixture.snapshot.latest_metadata.artifact_bindings.meta = rawArtifactBinding(
    Buffer.from(JSON.stringify(fixture.meta)),
    "application/json; charset=utf-8",
  );
}

function temporaryArchiveRoot(label) {
  const archiveRoot = join(
    tmpdir(),
    `awardping-stage1-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  temporaryPaths.push(archiveRoot);
  return archiveRoot;
}

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
