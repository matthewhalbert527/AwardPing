import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STAGE1_REQUIRED_SOURCE_ROLES,
  applyStage1ReviewedSourceOnboardingPlan,
  buildStage1ReviewedSourceOnboardingPlan,
  verifyStage1ReviewedSourceOnboardingPlan,
} from "./stage1-reviewed-source-onboarding-plan.mjs";

describe("reviewed Stage 1 source onboarding plan", () => {
  it("accounts for all exact 25 awards and 200 roles with deterministic true totals", () => {
    const fixture = buildFixture();
    const first = buildStage1ReviewedSourceOnboardingPlan(fixture);
    const second = buildStage1ReviewedSourceOnboardingPlan({
      ...fixture,
      reviewReports: [...fixture.reviewReports].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.summary).toMatchObject({
      counts_are_complete: true,
      limits_applied: false,
      pagination: null,
      exact_award_count: 25,
      exact_award_role_slot_count: 200,
      accounted_award_role_slot_count: 200,
      unaccounted_award_role_slot_count: 0,
      role_gaps: [],
      input_reviewed_inventory_rows: 27,
      input_existing_source_rows: 25,
      input_new_page_candidate_rows: 3,
      unique_existing_sources: 25,
      new_page_requests: 2,
      total_normalized_sources: 27,
      existing_source_rows_collapsed: 0,
      new_page_candidate_rows_collapsed: 1,
      existing_source_role_links: 196,
      new_request_role_links: 4,
      total_source_role_links: 200,
      awards_requiring_new_page_review: 2,
    });
    expect(first.awards).toHaveLength(25);
    expect(first.awards.flatMap((award) => award.role_coverage)).toHaveLength(200);
    expect(first.confirmation.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyStage1ReviewedSourceOnboardingPlan(first)).toBe(first);
  });

  it("collapses only exact award-and-URL candidates and preserves reviewed role unions", () => {
    const fixture = buildFixture();
    const rank21 = fixture.reviewReports[2].document.awards.find(
      (award) => award.launch_rank === 21,
    );
    const sharedUrl = rank21.recommended_sources[1].url;
    const rank22 = fixture.reviewReports[2].document.awards.find(
      (award) => award.launch_rank === 22,
    );
    rank22.recommended_sources[0].roles = STAGE1_REQUIRED_SOURCE_ROLES.slice(1);
    rank22.recommended_sources.push({
      url: sharedUrl,
      source_id: null,
      inventory_status: "needs_new_page_review",
      roles: ["identity_home"],
    });

    const plan = buildStage1ReviewedSourceOnboardingPlan(fixture);
    const sameUrlRequests = plan.new_page_requests.filter(
      (request) => request.normalized_url === sharedUrl,
    );
    expect(sameUrlRequests).toHaveLength(2);
    expect(new Set(sameUrlRequests.map((request) => request.canonical_shared_award_id)).size).toBe(2);
    expect(new Set(sameUrlRequests.map((request) => request.request_id)).size).toBe(2);
    const award21 = sameUrlRequests.find((request) => request.launch_rank === 21);
    expect(award21.reviewed_roles).toEqual(["selection_interviews", "current_documents"]);
    expect(award21.monitor_only_roles).toEqual(["current_documents"]);
  });

  it("emits only historical baseline-only request rows with no ranking or enqueue charge", () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    for (const candidate of plan.new_page_requests) {
      expect(candidate).toMatchObject({
        acquisition_kind: "historical_import",
        notification_mode: "baseline_only",
        enqueue_paid_api_calls: 0,
      });
      expect(candidate.request_row).toMatchObject({
        id: candidate.request_id,
        matched_shared_award_id: candidate.canonical_shared_award_id,
        normalized_url: candidate.normalized_url,
        status: "pending",
        status_reason: "queued_from_reviewed_stage1_historical_import_baseline_only",
        acquisition_kind: "historical_import",
        notification_mode: "baseline_only",
        onboarding_batch_id: "stage1-national-25-reviewed-sources-v1",
      });
      expect(JSON.stringify(candidate)).not.toMatch(/candidate_score|candidate_rank|confidence/i);
      expect(candidate.evidence.ranked_candidates_auto_accepted).toBe(0);
    }
    expect(plan.safety_contract).toMatchObject({
      processing_lane: "new_page_review",
      processing_daily_spend_cap_usd: 5,
      enqueue_paid_api_calls: 0,
      existing_source_mutations: 0,
      cross_award_url_deduplication: false,
    });
  });

  it("retains NDSEG's authority homepage while classifying SysPlus as its delegated contractor source", () => {
    const fixture = buildFixture();
    const readinessAward = fixture.readinessReport.document.cohorts.find(
      (award) => award.launch_rank === 19,
    );
    readinessAward.cohort_key = "ndseg";
    readinessAward.canonical_identity.expected.official_homepage = "https://ndseg.org/";
    readinessAward.canonical_identity.actual.official_homepage = "https://ndseg.org/";
    readinessAward.sources = [
      {
        id: sourceId(19),
        shared_award_id: awardId(19),
        url: "https://ndseg.org/apply-link",
      },
      {
        id: "30000000-0000-4000-8000-000000000019",
        shared_award_id: awardId(19),
        url: "https://ndseg.sysplus.com/",
      },
      {
        id: "40000000-0000-4000-8000-000000000019",
        shared_award_id: awardId(19),
        url: "https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply.aspx",
      },
    ];
    const reviewedAward = fixture.reviewReports[2].document.awards.find(
      (award) => award.launch_rank === 19,
    );
    reviewedAward.cohort_key = "ndseg";
    reviewedAward.official_homepage = "https://ndseg.org/";
    reviewedAward.delegated_source_authority = {
      schema_version: "awardping.stage1.delegated-source-authority-review.v1",
      canonical_homepage: "https://ndseg.org/",
      authority_host_classification: "official_authority_host",
      delegated_host: "ndseg.sysplus.com",
      delegated_root_url: "https://ndseg.sysplus.com/",
      classification: "official_contractor_host",
      authority_evidence_url: "https://ndseg.org/apply-link",
      authority_evidence_summary: "The authority site delegates applications.",
      evidence_checked_at: "2026-07-17T14:41:57.337Z",
      current_fact_conflict: {
        publication_decision: "not_published",
        contractor_homepage: {
          url: "https://ndseg.sysplus.com/",
          reported_period: "August 3 through October 30, 2026 (5 PM Eastern)",
          cycle: "FY2027",
        },
        how_to_apply: {
          url: "https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply.aspx",
          reported_period: "August 15 through November 15",
          cycle: "next application cycle",
        },
      },
    };
    reviewedAward.recommended_sources = [
      {
        url: "https://ndseg.org/",
        source_id: null,
        inventory_status: "needs_new_page_review",
        roles: ["identity_home"],
      },
      {
        url: "https://ndseg.org/apply-link",
        source_id: sourceId(19),
        inventory_status: "open_authority_evidence",
        roles: ["identity_home"],
      },
      {
        url: "https://ndseg.sysplus.com/",
        source_id: "30000000-0000-4000-8000-000000000019",
        inventory_status: "open_conflicting_monitor_only",
        manifest_status: "not_published",
        roles: STAGE1_REQUIRED_SOURCE_ROLES.slice(1),
      },
      {
        url: "https://ndseg.sysplus.com/NDSEG/Applicants/How-to-Apply.aspx",
        source_id: "40000000-0000-4000-8000-000000000019",
        inventory_status: "open_conflicting_monitor_only",
        manifest_status: "not_published",
        roles: ["dates_cycle"],
      },
    ];

    const plan = buildStage1ReviewedSourceOnboardingPlan(fixture);
    const ndseg = plan.awards.find((award) => award.launch_rank === 19);
    expect(ndseg.registry_official_homepage).toBe("https://ndseg.org/");
    expect(ndseg.reviewed_official_homepage).toBe("https://ndseg.org/");
    expect(ndseg.identity_homepage_alignment).toMatchObject({
      normalized_exact_match: true,
      identity_equivalent: true,
      action: "retain_authority_homepage_delegated_contractor_source",
      automatic_identity_mutation: false,
      registry_homepage_classification: "official_authority_host",
      reviewed_homepage_classification: "official_authority_host",
      delegated_source_classification: "official_contractor_host",
      delegated_host: "ndseg.sysplus.com",
      delegated_root_url: "https://ndseg.sysplus.com/",
      delegation_evidence_url: "https://ndseg.org/apply-link",
      delegation_evidence_checked_at: "2026-07-17T14:41:57.337Z",
      current_fact_conflict: reviewedAward.delegated_source_authority.current_fact_conflict,
    });
    expect(ndseg.identity_homepage_alignment.delegation_review_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ndseg.new_page_requests).toHaveLength(1);
    expect(ndseg.new_page_requests[0].normalized_url).toBe("https://ndseg.org/");
    expect(plan.summary).toMatchObject({
      identity_homepage_migrations_requiring_separate_review: 0,
      delegated_contractor_homepages_retaining_authority_identity: 1,
    });
  });

  it.each([
    ["missing award rank", (fixture) => fixture.reviewReports[2].document.awards.pop(), /declared ranks|exactly 1-25|exactly ranks/i],
    ["wrong canonical ID", (fixture) => {
      fixture.reviewReports[0].document.awards[0].canonical_shared_award_id = awardId(25);
    }, /ID does not match/i],
    ["production mutation attestation", (fixture) => {
      fixture.reviewReports[1].document.attestation.production_mutations = 1;
    }, /production_mutations: 0/i],
    ["ranked candidate attestation", (fixture) => {
      fixture.reviewReports[2].document.attestation.ranked_candidates_auto_accepted = 1;
    }, /ranked_candidates_auto_accepted: 0/i],
    ["new-page status with existing source", (fixture) => {
      fixture.reviewReports[1].document.awards[0].recommended_sources[0].inventory_status =
        "needs_new_page_review";
    }, /conflicts with needs_new_page_review/i],
    ["missing reviewed role", (fixture) => {
      delete fixture.reviewReports[0].document.awards[0].roles.faq;
    }, /exact eight Stage 1 roles/i],
    ["non-HTTPS source", (fixture) => {
      fixture.reviewReports[1].document.awards[0].recommended_sources[0].url =
        "http://award-09.org/";
    }, /must use HTTPS/i],
    ["unbound paid URL", (fixture) => {
      fixture.reviewReports[0].document.awards[0].paid_new_page_review_urls.push(
        "https://award-01.org/unbound",
      );
    }, /unaccounted URL/i],
    ["stale attached source revalidation", (fixture) => {
      fixture.reviewReports[1].document.source_revalidation = {
        reviewed_at: fixture.reviewReports[1].document.reviewed_at,
        source_choices_current: true,
        production_registry_binding_current: false,
      };
    }, /production registry binding is not current/i],
    ["missing source revalidation", (fixture) => {
      delete fixture.reviewReports[1].document.source_revalidation;
    }, /source revalidation is required/i],
    ["mismatched existing source URL", (fixture) => {
      fixture.reviewReports[1].document.awards[0].recommended_sources[0].url =
        "https://award-09.org/different-page";
    }, /URL does not match the fresh readiness registry/i],
    ["missing existing source", (fixture) => {
      fixture.readinessReport.document.cohorts[8].sources = [];
    }, /absent from the fresh readiness registry/i],
  ])("fails closed for %s", (_label, mutate, expected) => {
    const fixture = buildFixture();
    mutate(fixture);
    expect(() => buildStage1ReviewedSourceOnboardingPlan(fixture)).toThrow(expected);
  });

  it("accepts exact sources owned by a signed retained alias member", () => {
    const fixture = buildFixture();
    const cohort = fixture.readinessReport.document.cohorts[8];
    const aliasId = "50000000-0000-4000-8000-000000000009";
    cohort.retained_members.resolved.push({ id: aliasId });
    cohort.sources[0].shared_award_id = aliasId;

    const plan = buildStage1ReviewedSourceOnboardingPlan(fixture);
    expect(plan.awards.find((award) => award.launch_rank === 9).existing_sources)
      .toHaveLength(1);
  });

  it("rejects any post-preview mutation under the exact confirmation hash", () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    plan.new_page_requests[0].reviewed_roles.push("faq");
    expect(() => verifyStage1ReviewedSourceOnboardingPlan(plan)).toThrow(/hash does not match/i);
  });

  it("atomically inserts missing requests and treats exact deterministic seeds as idempotent", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    const database = fakeSourceRequestDatabase(plan);
    const first = await applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    });
    expect(first).toMatchObject({
      planned_request_count: 2,
      inserted_request_count: 2,
      already_present_request_count: 0,
      existing_source_mutations: 0,
      paid_api_calls: 0,
      processing_started: false,
    });
    expect(database.insertBatches).toHaveLength(1);
    expect(database.insertBatches[0]).toHaveLength(2);

    const second = await applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    });
    expect(second).toMatchObject({
      inserted_request_count: 0,
      already_present_request_count: 2,
    });
    expect(database.insertBatches).toHaveLength(1);
  });

  it("refuses apply on an active exact-award URL collision with a different request ID", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    const database = fakeSourceRequestDatabase(plan);
    database.rows.push({
      ...plan.new_page_requests[0].request_row,
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    await expect(applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    })).rejects.toThrow(/active source intake collision/i);
    expect(database.insertBatches).toHaveLength(0);
  });

  it("refuses deterministic-ID reuse when the retained reviewed evidence differs", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    const database = fakeSourceRequestDatabase(plan);
    const conflicting = structuredClone(plan.new_page_requests[0].request_row);
    conflicting.ai_review.reviewed_source_onboarding_evidence.evidence_sha256 = "f".repeat(64);
    database.rows.push(conflicting);
    await expect(applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    })).rejects.toThrow(/conflicting reviewed evidence/i);
    expect(database.insertBatches).toHaveLength(0);
  });

  it("rejects an expired review or any live registry revision after the preview fence", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    const expiredDatabase = fakeSourceRequestDatabase(plan);
    await expect(applyStage1ReviewedSourceOnboardingPlan({
      supabase: expiredDatabase.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-18T14:44:26.567Z",
    })).rejects.toThrow(/plan expired/i);
    expect(expiredDatabase.insertBatches).toHaveLength(0);

    const driftDatabase = fakeSourceRequestDatabase(plan);
    driftDatabase.registryRows[0].updated_at = "2026-07-17T15:00:00.001Z";
    await expect(applyStage1ReviewedSourceOnboardingPlan({
      supabase: driftDatabase.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    })).rejects.toThrow(/changed or advanced after preview/i);
    expect(driftDatabase.insertBatches).toHaveLength(0);
  });

  it("rejects future-dated reviews and apply attempts that precede the review epoch", async () => {
    const futureFixture = buildFixture();
    futureFixture.reviewReports[0].document.generated_at = "2099-01-01T00:00:00.000Z";
    futureFixture.reviewReports[0].document.source_revalidation.reviewed_at =
      "2099-01-01T00:00:00.000Z";
    expect(() => buildStage1ReviewedSourceOnboardingPlan({
      ...futureFixture,
      now: "2026-07-17T15:00:00.000Z",
    })).toThrow(/too far in the future/i);

    const plan = buildStage1ReviewedSourceOnboardingPlan({
      ...buildFixture(),
      now: "2026-07-17T15:00:00.000Z",
    });
    const database = fakeSourceRequestDatabase(plan);
    await expect(applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T14:39:00.000Z",
    })).rejects.toThrow(/predates review epoch/i);
    expect(database.insertBatches).toHaveLength(0);
  });

  it("permits the documented five-minute build and apply clock skew", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan({
      ...buildFixture(),
      now: "2026-07-17T14:40:00.000Z",
    });
    const database = fakeSourceRequestDatabase(plan);
    const result = await applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T14:40:00.000Z",
    });
    expect(result.commit_state).toBe("verified_committed");
  });

  it("reconciles an incomplete insert response before issuing a verified receipt", async () => {
    const plan = buildStage1ReviewedSourceOnboardingPlan(buildFixture());
    const database = fakeSourceRequestDatabase(plan);
    database.insertResponseMode = "incomplete";
    const result = await applyStage1ReviewedSourceOnboardingPlan({
      supabase: database.client,
      plan,
      confirmationSha256: plan.confirmation.plan_sha256,
      now: "2026-07-17T15:00:00.000Z",
    });
    expect(result).toMatchObject({
      inserted_request_count: 2,
      insert_response_state: "incomplete_returning_set_reconciled",
      commit_state: "verified_committed",
    });
  });

  it("CLI writes a byte-stable local preview and requires confirmation before loading apply credentials", () => {
    const fixture = buildFixture();
    const directory = mkdtempSync(join(tmpdir(), "awardping-reviewed-source-plan-"));
    const paths = writeFixture(directory, fixture);
    const output = join(directory, "plan.json");
    const cli = resolve(process.cwd(), "scripts/build-stage1-reviewed-source-onboarding-plan.mjs");
    const args = [
      cli,
      `--readiness=${paths.readiness}`,
      `--review-1=${paths.reviews[0]}`,
      `--review-2=${paths.reviews[1]}`,
      `--review-3=${paths.reviews[2]}`,
      `--output=${output}`,
    ];
    const firstOutput = execFileSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    const firstBytes = readFileSync(output, "utf8");
    execFileSync(process.execPath, args, { encoding: "utf8", timeout: 20_000 });
    expect(readFileSync(output, "utf8")).toBe(firstBytes);
    expect(firstOutput).toMatch(/Exact awards \/ roles: 25 \/ 200/);
    expect(firstOutput).toMatch(/Plan build production writes: 0; paid API calls: 0/);

    const rejected = spawnSync(process.execPath, [cli, "--apply"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/--apply requires --confirm/);
  }, 20_000);
});

function buildFixture() {
  const cohorts = Array.from({ length: 25 }, (_, index) => {
    const rank = index + 1;
    const name = `National Award ${String(rank).padStart(2, "0")}`;
    const homepage = `https://award-${String(rank).padStart(2, "0")}.org/`;
    return {
      launch_rank: rank,
      cohort_key: `award_${String(rank).padStart(2, "0")}`,
      canonical_name: name,
      publication: {
        policy_version: "stage1-publication-v1",
      },
      canonical_identity: {
        expected: {
          shared_award_id: awardId(rank),
          name,
          official_homepage: homepage,
        },
        actual: {
          id: awardId(rank),
          name,
          official_homepage: homepage,
          status: "active",
        },
        comparisons: {
          exact_name_matches: true,
          active: true,
        },
        blocking_drift: [],
      },
      retained_members: {
        resolved: [{ id: awardId(rank) }],
      },
      sources: [{
        id: sourceId(rank),
        shared_award_id: awardId(rank),
        url: homepage,
      }],
    };
  });
  const readinessReport = {
    source_label: "readiness.json",
    document: {
      schema_version: "stage1-cohort-readiness-v2",
      generated_at: "2026-07-17T15:00:00.000Z",
      summary: { exact_cohort_count: 25 },
      registry: {
        exact_definition: { ok: true, cohort_count: 25 },
        remote_snapshot_validation: {
          ok: true,
          cohort_count: 25,
          canonical_member_count: 25,
        },
      },
      required_source_roles: [...STAGE1_REQUIRED_SOURCE_ROLES],
      read_only_attestation: {
        remote_mutations: 0,
        paid_api_calls: 0,
        captures: 0,
        r2_object_requests: 0,
      },
      cohorts,
    },
  };
  const roleAwards = cohorts.slice(0, 8).map((cohort) => roleReviewAward(cohort));
  const roleReport = {
    source_label: "official-role-review-01-08.json",
    document: {
      schema_version: "awardping.stage1.official-role-review.v1",
      generated_at: "2026-07-17T14:44:26.566Z",
      read_only_attestation: {
        database_selects_only: true,
        production_mutations: 0,
        r2_object_requests: 0,
        page_captures: 0,
        paid_provider_calls: 0,
        ranked_candidates_auto_accepted: 0,
      },
      source_revalidation: currentSourceRevalidation("2026-07-17T14:44:26.566Z"),
      awards: roleAwards,
    },
  };
  const source09 = sourceReviewReport(cohorts.slice(8, 16), "2026-07-17T14:31:48.930Z");
  source09.source_label = "official-source-review-09-16.json";
  const source17 = sourceReviewReport(cohorts.slice(16), "2026-07-17T14:41:57.337Z");
  source17.source_label = "official-source-review-17-25.json";
  return {
    readinessReport,
    reviewReports: [roleReport, source09, source17],
  };
}

function roleReviewAward(cohort) {
  const homepage = cohort.canonical_identity.expected.official_homepage;
  const catalog = {
    home: {
      id: sourceId(cohort.launch_rank),
      url: homepage,
      state: "open_fresh",
      evidence: "immutable_generation_local_exact",
    },
  };
  const paidUrl = `${homepage}reviewed-new-page`;
  const paidRoles = cohort.launch_rank === 3 ? new Set(["funding", "faq"]) : new Set();
  const roles = Object.fromEntries(STAGE1_REQUIRED_SOURCE_ROLES.map((role) => {
    const isPaid = paidRoles.has(role);
    return [role, {
      manifest_status_recommendation:
        role === "identity_home" || role === "current_documents" ? "present" : "combined",
      disposition: isPaid ? "source_intake_required" : "existing_repair_required",
      source_refs: isPaid ? [] : ["home"],
      ...(isPaid ? { official_urls: [paidUrl] } : {}),
      selected_candidate_ids: [],
    }];
  }));
  return {
    launch_rank: cohort.launch_rank,
    cohort_key: cohort.cohort_key,
    canonical_shared_award_id: cohort.canonical_identity.expected.shared_award_id,
    canonical_name: cohort.canonical_name,
    source_catalog: catalog,
    roles,
    paid_new_page_review_urls: paidRoles.size ? [paidUrl] : [],
  };
}

function sourceReviewReport(cohorts, reviewedAt) {
  return {
    document: {
      schema_version: "awardping.stage1.official-source-human-review.v1",
      mode: "read_only_zero_charge",
      reviewed_at: reviewedAt,
      launch_ranks: cohorts.map((cohort) => cohort.launch_rank),
      attestation: {
        production_mutations: 0,
        paid_api_calls: 0,
        ranked_candidates_auto_accepted: 0,
      },
      source_revalidation: currentSourceRevalidation(reviewedAt),
      awards: cohorts.map((cohort) => sourceReviewAward(cohort)),
    },
  };
}

function currentSourceRevalidation(reviewedAt) {
  return {
    reviewed_at: reviewedAt,
    source_choices_current: true,
    production_registry_binding_current: true,
  };
}

function sourceReviewAward(cohort) {
  const common = {
    launch_rank: cohort.launch_rank,
    cohort_key: cohort.cohort_key,
    canonical_name: cohort.canonical_name,
    official_homepage: cohort.canonical_identity.expected.official_homepage,
  };
  if (cohort.launch_rank !== 21) {
    return {
      ...common,
      recommended_sources: [{
        url: cohort.canonical_identity.expected.official_homepage,
        source_id: sourceId(cohort.launch_rank),
        inventory_status: "open",
        roles: [...STAGE1_REQUIRED_SOURCE_ROLES],
      }],
    };
  }
  const newUrl = `${cohort.canonical_identity.expected.official_homepage}apply`;
  return {
    ...common,
    recommended_sources: [
      {
        url: cohort.canonical_identity.expected.official_homepage,
        source_id: sourceId(cohort.launch_rank),
        inventory_status: "open",
        roles: STAGE1_REQUIRED_SOURCE_ROLES.slice(0, 6),
      },
      {
        url: newUrl,
        source_id: null,
        inventory_status: "needs_new_page_review",
        roles: ["selection_interviews"],
      },
      {
        url: newUrl,
        source_id: null,
        inventory_status: "needs_new_page_review_monitor_only",
        roles: ["current_documents"],
        manifest_status: "not_published",
        reason: "No separate current document was reviewed.",
      },
    ],
  };
}

function awardId(rank) {
  return `10000000-0000-4000-8000-${rank.toString(16).padStart(12, "0")}`;
}

function sourceId(rank) {
  return `20000000-0000-4000-8000-${rank.toString(16).padStart(12, "0")}`;
}

function writeFixture(directory, fixture) {
  const readiness = join(directory, "readiness.json");
  writeFileSync(readiness, JSON.stringify(fixture.readinessReport.document, null, 2));
  const reviews = fixture.reviewReports.map((review, index) => {
    const path = join(directory, `review-${index + 1}.json`);
    writeFileSync(path, JSON.stringify(review.document, null, 2));
    return path;
  });
  return { readiness, reviews };
}

function fakeSourceRequestDatabase(plan) {
  const state = {
    rows: [],
    insertBatches: [],
    insertResponseMode: "complete",
    registryRows: plan.awards.map((award) => ({
      cohort_key: award.cohort_key,
      launch_rank: award.launch_rank,
      canonical_name: award.canonical_name,
      canonical_shared_award_id: award.canonical_shared_award_id,
      official_homepage: award.registry_official_homepage,
      policy_version: award.registry_policy_version,
      updated_at: "2026-07-17T14:59:59.000Z",
    })),
    awardRows: plan.awards.map((award) => ({
      id: award.canonical_shared_award_id,
      name: award.canonical_name,
      official_homepage: award.registry_official_homepage,
      status: "active",
      updated_at: "2026-07-17T14:59:59.000Z",
    })),
  };
  state.client = {
    from(table) {
      const rows = table === "source_page_requests"
        ? state.rows
        : table === "stage1_award_registry"
          ? state.registryRows
          : table === "shared_awards"
            ? state.awardRows
            : null;
      if (!rows) throw new Error(`Unexpected table ${table}.`);
      return {
        select(fields, options) {
          return selectQuery(rows, fields, options);
        },
        insert(batch) {
          if (table !== "source_page_requests") throw new Error(`Unexpected insert table ${table}.`);
          return {
            async select(fields) {
              if (fields !== "id") throw new Error(`Unexpected insert select ${fields}.`);
              const copies = batch.map((row) => structuredClone(row));
              state.insertBatches.push(copies);
              state.rows.push(...copies);
              return {
                data: state.insertResponseMode === "incomplete"
                  ? copies.slice(0, 1).map((row) => ({ id: row.id }))
                  : copies.map((row) => ({ id: row.id })),
                error: null,
              };
            },
          };
        },
      };
    },
  };
  return state;
}

function selectQuery(rows, fields, options) {
  const filters = [];
  const query = {
    in(field, values) {
      filters.push({ field, values });
      return query;
    },
    eq(field, value) {
      filters.push({ field, values: [value] });
      return query;
    },
    async limit(limit) {
      const matching = rows.filter((row) => filters.every(
        (filter) => filter.values.includes(row[filter.field]),
      ));
      const selected = matching.slice(0, limit);
      const keys = fields.split(",");
      return {
        data: selected.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]]))),
        error: null,
        count: options?.count === "exact" ? matching.length : null,
      };
    },
  };
  return query;
}
