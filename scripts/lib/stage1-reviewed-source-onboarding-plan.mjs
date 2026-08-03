import { createHash } from "node:crypto";
import { normalizeSourceIntakeUrl } from "./source-intake.mjs";

export const STAGE1_REVIEWED_SOURCE_PLAN_SCHEMA =
  "awardping.stage1.reviewed-source-onboarding-plan.v1";
export const STAGE1_REVIEWED_SOURCE_POLICY_VERSION =
  "stage1-national-25-reviewed-source-onboarding-v1";
export const STAGE1_REVIEWED_SOURCE_BATCH_ID =
  "stage1-national-25-reviewed-sources-v1";
export const STAGE1_REQUIRED_SOURCE_ROLES = Object.freeze([
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
]);

const roleSet = new Set(STAGE1_REQUIRED_SOURCE_ROLES);
const manifestStatuses = new Set(["present", "combined", "not_published"]);
const activeRequestStatuses = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const REVIEW_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const REVIEW_APPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const homepageDelegationContracts = new Map([
  ["ndseg", Object.freeze({
    authority_homepage: "https://ndseg.org/",
    delegated_root_url: "https://ndseg.sysplus.com/",
    delegated_host: "ndseg.sysplus.com",
    delegation_evidence_url: "https://ndseg.org/apply-link",
    authority_classification: "official_authority_host",
    reviewed_source_classification: "official_contractor_host",
  })],
]);

export function buildStage1ReviewedSourceOnboardingPlan({
  readinessReport,
  reviewReports,
  now = new Date(),
}) {
  const builtAt = requiredTimestamp(
    now instanceof Date ? now.toISOString() : now,
    "plan build time",
  );
  const readinessInput = normalizeInput(readinessReport, "readiness");
  const normalizedReviewInputs = requiredArray(reviewReports, "review reports")
    .map((input, index) => normalizeInput(input, `review-${index + 1}`));
  if (normalizedReviewInputs.length !== 3) {
    throw new Error("Reviewed source onboarding requires exactly three human-review reports.");
  }

  const registry = validateReadinessRegistry(readinessInput.document);
  const reviews = normalizeReviewReports(normalizedReviewInputs);
  const reportByRank = new Map();
  for (const review of reviews) {
    for (const award of review.document.awards) {
      if (reportByRank.has(award.launch_rank)) {
        throw new Error(`Launch rank ${award.launch_rank} appears in more than one review report.`);
      }
      reportByRank.set(award.launch_rank, review);
    }
  }
  assertExactIntegerRange([...reportByRank.keys()], 1, 25, "review launch ranks");

  const contexts = [];
  for (const canonical of registry.cohorts) {
    const review = reportByRank.get(canonical.launch_rank);
    const reviewedAward = review.document.awards.find(
      (award) => award.launch_rank === canonical.launch_rank,
    );
    validateAwardBinding(reviewedAward, canonical);
    const context = (
      review.kind === "official_role_review"
        ? normalizeRoleReviewAward({ reviewedAward, canonical, review })
        : normalizeOfficialSourceReviewAward({ reviewedAward, canonical, review })
    );
    validateExistingSourceBindings(context, registry.sourcesById);
    contexts.push(context);
  }

  const awards = contexts.map(finalizeAwardContext);
  const newPageRequests = awards
    .flatMap((award) => award.new_page_requests)
    .sort(compareRequests);
  const existingSources = awards.flatMap((award) => award.existing_sources);
  const roleCoverage = awards.flatMap((award) => award.role_coverage);
  const roleGaps = roleCoverage.filter((role) => !role.accounted);
  if (roleCoverage.length !== 200 || roleGaps.length) {
    throw new Error(
      `Reviewed source coverage must account for exactly 200 award-role slots; found ${roleCoverage.length} with ${roleGaps.length} gaps.`,
    );
  }

  const rawReviewedInventoryRows = contexts.reduce(
    (sum, context) => sum + context.counts.reviewed_inventory_rows,
    0,
  );
  const rawExistingRows = contexts.reduce(
    (sum, context) => sum + context.counts.existing_source_rows,
    0,
  );
  const rawNewCandidateRows = contexts.reduce(
    (sum, context) => sum + context.counts.new_candidate_rows,
    0,
  );
  const existingSourceRoleLinks = existingSources.reduce(
    (sum, source) => sum + source.reviewed_roles.length,
    0,
  );
  const newRequestRoleLinks = newPageRequests.reduce(
    (sum, request) => sum + request.reviewed_roles.length,
    0,
  );
  const reviewEpoch = latestTimestamp(
    reviews.map((review) => review.reviewedAt),
    "review timestamps",
  );
  if (Date.parse(reviewEpoch) > Date.parse(builtAt) + REVIEW_FUTURE_SKEW_MS) {
    throw new Error(
      `Review epoch ${reviewEpoch} is too far in the future for plan build time ${builtAt}.`,
    );
  }
  const applyNotAfter = new Date(
    Date.parse(reviewEpoch) + REVIEW_APPLY_WINDOW_MS,
  ).toISOString();

  const payload = {
    schema_version: STAGE1_REVIEWED_SOURCE_PLAN_SCHEMA,
    policy_version: STAGE1_REVIEWED_SOURCE_POLICY_VERSION,
    onboarding_batch_id: STAGE1_REVIEWED_SOURCE_BATCH_ID,
    plan_mode: "local_preview",
    execution_authority: "none_until_exact_confirmation",
    review_epoch: reviewEpoch,
    apply_not_after: applyNotAfter,
    registry_observed_at: requiredTimestamp(
      readinessInput.document.generated_at,
      "readiness generated_at",
    ),
    cohort_binding: {
      cohort_key: "stage1-national-25",
      exact_award_count: 25,
      required_source_roles: [...STAGE1_REQUIRED_SOURCE_ROLES],
      exact_award_role_slot_count: 200,
      registry_exact_definition_verified: true,
      remote_registry_snapshot_verified: true,
      live_identity_revalidation_required_at_apply: true,
      reject_registry_or_award_updates_after_observed_at: true,
    },
    safety_contract: {
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      processing_lane: "new_page_review",
      processing_daily_spend_cap_usd: 5,
      enqueue_paid_api_calls: 0,
      existing_source_write_mode: "read_only",
      existing_source_mutations: 0,
      ranked_candidates_auto_accepted: 0,
      production_writes_performed_by_plan_build: 0,
      deduplication_key: ["canonical_shared_award_id", "normalized_url"],
      cross_award_url_deduplication: false,
    },
    input_evidence: [
      inputEvidence(readinessInput, "readiness_registry"),
      ...reviews.map((review) => inputEvidence(review.input, review.kind)),
    ].sort(compareInputEvidence),
    summary: {
      counts_are_complete: true,
      limits_applied: false,
      pagination: null,
      exact_award_count: awards.length,
      exact_award_role_slot_count: roleCoverage.length,
      accounted_award_role_slot_count: roleCoverage.length - roleGaps.length,
      unaccounted_award_role_slot_count: roleGaps.length,
      role_gaps: roleGaps.map((role) => ({
        canonical_shared_award_id: role.canonical_shared_award_id,
        source_role: role.source_role,
      })),
      input_reviewed_inventory_rows: rawReviewedInventoryRows,
      input_existing_source_rows: rawExistingRows,
      input_new_page_candidate_rows: rawNewCandidateRows,
      unique_existing_sources: existingSources.length,
      new_page_requests: newPageRequests.length,
      total_normalized_sources: existingSources.length + newPageRequests.length,
      existing_source_rows_collapsed: rawExistingRows - existingSources.length,
      new_page_candidate_rows_collapsed: rawNewCandidateRows - newPageRequests.length,
      existing_source_role_links: existingSourceRoleLinks,
      new_request_role_links: newRequestRoleLinks,
      total_source_role_links: existingSourceRoleLinks + newRequestRoleLinks,
      awards_requiring_new_page_review: awards.filter(
        (award) => award.new_page_requests.length > 0,
      ).length,
      identity_homepage_migrations_requiring_separate_review: awards.filter(
        (award) => award.identity_homepage_alignment.action
          === "separate_identity_migration_review_required",
      ).length,
      delegated_contractor_homepages_retaining_authority_identity: awards.filter(
        (award) => award.identity_homepage_alignment.action
          === "retain_authority_homepage_delegated_contractor_source",
      ).length,
    },
    apply_handoff: {
      mode: "explicit_confirmation_only",
      confirmation_argument: "--confirm=<plan_sha256>",
      atomicity: "single_insert_statement_for_all_missing_requests",
      collision_policy: "fail_closed_unless_deterministic_request_id_and_seed_fields_match",
      existing_source_actions: "never_written",
      expected_request_count: newPageRequests.length,
      paid_calls_on_enqueue: 0,
      processing_is_separate: true,
      live_registry_and_award_identity_revalidation: true,
      review_expiry: applyNotAfter,
    },
    awards,
    new_page_requests: newPageRequests,
  };
  const planSha256 = sha256(canonicalJson(payload));
  return {
    ...payload,
    confirmation: {
      plan_sha256: planSha256,
      exact_confirmation_required: planSha256,
      confirmation_scope:
        "enqueue_only_new_page_requests_historical_import_baseline_only",
    },
  };
}

export function verifyStage1ReviewedSourceOnboardingPlan(plan) {
  const value = objectValue(plan, "onboarding plan");
  if (value.schema_version !== STAGE1_REVIEWED_SOURCE_PLAN_SCHEMA) {
    throw new Error("Reviewed source onboarding plan schema is unsupported.");
  }
  const confirmation = objectValue(value.confirmation, "plan confirmation");
  const expected = requiredSha256(confirmation.plan_sha256, "plan SHA-256");
  const { confirmation: ignored, ...payload } = value;
  void ignored;
  const actual = sha256(canonicalJson(payload));
  if (actual !== expected || confirmation.exact_confirmation_required !== expected) {
    throw new Error("Reviewed source onboarding plan confirmation hash does not match its payload.");
  }
  if (
    value.safety_contract?.acquisition_kind !== "historical_import"
    || value.safety_contract?.notification_mode !== "baseline_only"
    || value.safety_contract?.ranked_candidates_auto_accepted !== 0
    || value.safety_contract?.processing_daily_spend_cap_usd !== 5
    || value.safety_contract?.enqueue_paid_api_calls !== 0
    || value.safety_contract?.existing_source_mutations !== 0
    || value.summary?.exact_award_count !== 25
    || value.summary?.exact_award_role_slot_count !== 200
    || value.summary?.unaccounted_award_role_slot_count !== 0
  ) {
    throw new Error("Reviewed source onboarding plan safety or exact-cohort contract is invalid.");
  }
  const reviewEpoch = requiredTimestamp(value.review_epoch, "plan review epoch");
  const applyNotAfter = requiredTimestamp(value.apply_not_after, "plan apply expiry");
  if (Date.parse(applyNotAfter) !== Date.parse(reviewEpoch) + REVIEW_APPLY_WINDOW_MS) {
    throw new Error("Reviewed source onboarding plan must retain the exact 24-hour review window.");
  }
  const requests = requiredArray(value.new_page_requests, "new page requests");
  if (requests.length !== value.summary.new_page_requests) {
    throw new Error("Reviewed source onboarding request total does not match the plan summary.");
  }
  const awards = requiredArray(value.awards, "onboarding plan awards");
  if (awards.length !== 25) throw new Error("Reviewed source onboarding plan must contain 25 awards.");
  assertExactIntegerRange(awards.map((award) => award.launch_rank), 1, 25, "plan award ranks");
  if (new Set(awards.map((award) => award.canonical_shared_award_id)).size !== 25) {
    throw new Error("Reviewed source onboarding plan award IDs must be unique.");
  }
  const coverage = awards.flatMap((award) => requiredArray(
    award.role_coverage,
    `role coverage for ${cleanText(award.cohort_key)}`,
  ));
  if (
    coverage.length !== 200
    || coverage.some((slot) => slot.accounted !== true || !manifestStatuses.has(slot.manifest_status))
  ) throw new Error("Reviewed source onboarding plan does not contain 200 accounted role slots.");
  for (const award of awards) {
    assertExactRoleKeys(
      award.role_coverage.map((slot) => slot.source_role),
      `plan award ${cleanText(award.cohort_key)}`,
    );
  }
  for (const request of requests) validatePlannedRequest(request);
  if (
    new Set(requests.map((request) => request.request_id)).size !== requests.length
    || new Set(requests.map((request) => logicalRequestKey(request))).size !== requests.length
  ) throw new Error("Reviewed source onboarding requests contain duplicate IDs or award-and-URL keys.");
  const awardRequestIds = awards
    .flatMap((award) => requiredArray(award.new_page_requests, "award new-page requests"))
    .map((request) => request.request_id)
    .sort();
  const topLevelRequestIds = requests.map((request) => request.request_id).sort();
  if (canonicalJson(awardRequestIds) !== canonicalJson(topLevelRequestIds)) {
    throw new Error("Award request inventory does not exactly match the top-level request inventory.");
  }
  return value;
}

export async function applyStage1ReviewedSourceOnboardingPlan({
  supabase,
  plan,
  confirmationSha256,
  now = new Date(),
}) {
  const verified = verifyStage1ReviewedSourceOnboardingPlan(plan);
  const expected = verified.confirmation.plan_sha256;
  if (cleanText(confirmationSha256).toLowerCase() !== expected) {
    throw new Error(`Apply requires the exact reviewed plan SHA-256 ${expected}.`);
  }
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("Reviewed source onboarding apply requires a Supabase service client.");
  }
  const appliedAt = requiredTimestamp(
    now instanceof Date ? now.toISOString() : now,
    "apply time",
  );
  if (Date.parse(appliedAt) < Date.parse(verified.review_epoch) - REVIEW_FUTURE_SKEW_MS) {
    throw new Error(
      `Apply time ${appliedAt} predates review epoch ${verified.review_epoch}; rebuild from valid reviews.`,
    );
  }
  if (Date.parse(appliedAt) > Date.parse(verified.apply_not_after)) {
    throw new Error(
      `Reviewed source onboarding plan expired at ${verified.apply_not_after}; rebuild from fresh reviews.`,
    );
  }
  await validateLiveCohortIdentity({ supabase, plan: verified });
  const requests = verified.new_page_requests.map((item) => item.request_row);
  const ids = requests.map((request) => request.id);
  const byIdResult = await loadExactRowsByIds(supabase, ids, "pre-enqueue idempotency");
  const existingById = new Map(byIdResult.rows.map((row) => [row.id, row]));
  for (const request of requests) {
    const existing = existingById.get(request.id);
    if (existing) assertSameRequestSeed(existing, request);
  }
  await assertNoActiveLogicalCollisions(supabase, requests, "pre-enqueue");

  const missing = requests.filter((request) => !existingById.has(request.id));
  let insertResponseState = "not_needed";
  let returnedIds = [];
  if (missing.length) {
    const insertResult = await supabase
      .from("source_page_requests")
      .insert(missing)
      .select("id");
    returnedIds = (insertResult.data || []).map((row) => row.id).sort();
    const expectedIds = missing.map((request) => request.id).sort();
    insertResponseState = insertResult.error
      ? `database_error_reconciled:${safeDatabaseError(insertResult.error)}`
      : canonicalJson(returnedIds) === canonicalJson(expectedIds)
        ? "complete_returning_set"
        : "incomplete_returning_set_reconciled";
  }

  let after;
  try {
    after = await loadExactRowsByIds(supabase, ids, "post-enqueue reconciliation");
  } catch (error) {
    if (missing.length) {
      throw new Error(
        `Atomic enqueue response cannot be given a success receipt because commit-state reconciliation failed after the write attempt: ${cleanText(error?.message || error)}. Retry only the same confirmed plan.`,
      );
    }
    throw error;
  }
  const afterById = new Map(after.rows.map((row) => [row.id, row]));
  for (const request of requests) {
    const stored = afterById.get(request.id);
    if (!stored) {
      throw new Error(
        `Atomic enqueue has no complete success receipt: exact reconciliation found ${after.rows.length}/${requests.length} planned rows. Commit state may be incomplete; retry only the same confirmed plan.`,
      );
    }
    assertSameRequestSeed(stored, request);
  }
  await assertNoActiveLogicalCollisions(supabase, requests, "post-enqueue");
  return {
    schema_version: "awardping.stage1.reviewed-source-onboarding-apply-result.v1",
    plan_sha256: expected,
    planned_request_count: requests.length,
    inserted_request_count: missing.length,
    already_present_request_count: requests.length - missing.length,
    inserted_request_ids: missing.map((request) => request.id).sort(),
    insert_response_state: insertResponseState,
    commit_state: missing.length ? "verified_committed" : "verified_idempotent",
    verified_at: appliedAt,
    existing_source_mutations: 0,
    paid_api_calls: 0,
    processing_started: false,
  };
}

function validateReadinessRegistry(document) {
  const report = objectValue(document, "readiness report");
  if (report.schema_version !== "stage1-cohort-readiness-v2") {
    throw new Error("Readiness input must use stage1-cohort-readiness-v2.");
  }
  assertZeroAttestation(report.read_only_attestation, [
    "remote_mutations",
    "paid_api_calls",
    "captures",
    "r2_object_requests",
  ], "readiness report");
  if (report.summary?.exact_cohort_count !== 25) {
    throw new Error("Readiness registry must contain the exact 25-award cohort.");
  }
  if (
    report.registry?.exact_definition?.ok !== true
    || report.registry?.exact_definition?.cohort_count !== 25
    || report.registry?.remote_snapshot_validation?.ok !== true
    || report.registry?.remote_snapshot_validation?.cohort_count !== 25
    || report.registry?.remote_snapshot_validation?.canonical_member_count !== 25
  ) {
    throw new Error("Readiness registry exact-definition or remote snapshot validation is not green.");
  }
  if (canonicalJson(report.required_source_roles) !== canonicalJson(STAGE1_REQUIRED_SOURCE_ROLES)) {
    throw new Error("Readiness registry required source roles do not match the Stage 1 contract.");
  }
  const sourcesById = new Map();
  const cohorts = requiredArray(report.cohorts, "readiness cohorts")
    .map((cohort) => {
      const expected = objectValue(cohort.canonical_identity?.expected, "expected canonical identity");
      const actual = objectValue(cohort.canonical_identity?.actual, "actual canonical identity");
      const id = requiredUuid(expected.shared_award_id, "canonical shared award id");
      if (
        actual.id !== id
        || actual.name !== expected.name
        || actual.status !== "active"
        || cohort.canonical_name !== expected.name
        || cohort.canonical_identity?.comparisons?.exact_name_matches !== true
        || cohort.canonical_identity?.comparisons?.active !== true
        || requiredArray(
          cohort.canonical_identity?.blocking_drift,
          "canonical identity blocking drift",
        ).length !== 0
      ) {
        throw new Error(`Readiness canonical identity is not exact and active at rank ${cohort.launch_rank}.`);
      }
      const retainedMembers = requiredArray(
        cohort.retained_members?.resolved,
        `retained members for ${cohort.cohort_key}`,
      ).map((member) => requiredUuid(
        member?.id,
        `retained member ID for ${cohort.cohort_key}`,
      ));
      const retainedMemberIds = new Set(retainedMembers);
      if (!retainedMemberIds.has(id)) {
        throw new Error(`Readiness cohort ${cohort.cohort_key} omits its canonical retained member.`);
      }
      if (retainedMemberIds.size !== retainedMembers.length) {
        throw new Error(`Readiness cohort ${cohort.cohort_key} repeats a retained member.`);
      }
      for (const source of requiredArray(cohort.sources, `sources for ${cohort.cohort_key}`)) {
        const sourceId = requiredUuid(source?.id, `source ID for ${cohort.cohort_key}`);
        const ownerId = requiredUuid(
          source?.shared_award_id,
          `source owner for ${cohort.cohort_key}`,
        );
        if (!retainedMemberIds.has(ownerId)) {
          throw new Error(
            `Readiness source ${sourceId} is not owned by a retained member of ${cohort.cohort_key}.`,
          );
        }
        if (sourcesById.has(sourceId)) {
          throw new Error(`Readiness source ${sourceId} appears in more than one cohort.`);
        }
        sourcesById.set(sourceId, {
          source_id: sourceId,
          shared_award_id: ownerId,
          cohort_key: requiredText(cohort.cohort_key, "cohort key"),
          normalized_url: normalizeReadinessSourceUrl(source?.url),
        });
      }
      return {
        launch_rank: requiredInteger(cohort.launch_rank, "launch rank"),
        cohort_key: requiredText(cohort.cohort_key, "cohort key"),
        canonical_name: requiredText(expected.name, "canonical name"),
        canonical_shared_award_id: id,
        official_homepage: normalizeHttpsUrl(
          expected.official_homepage,
          `registry homepage for ${cohort.cohort_key}`,
        ),
        policy_version: requiredText(
          cohort.publication?.policy_version,
          `registry policy for ${cohort.cohort_key}`,
        ),
        retained_member_ids: [...retainedMemberIds].sort(),
      };
    })
    .sort(compareRank);
  assertExactIntegerRange(cohorts.map((cohort) => cohort.launch_rank), 1, 25, "registry ranks");
  if (new Set(cohorts.map((cohort) => cohort.cohort_key)).size !== 25) {
    throw new Error("Readiness registry cohort keys must be unique.");
  }
  if (new Set(cohorts.map((cohort) => cohort.canonical_shared_award_id)).size !== 25) {
    throw new Error("Readiness registry canonical award IDs must be unique.");
  }
  return { cohorts, sourcesById };
}

function normalizeReviewReports(inputs) {
  const reviews = inputs.map((input) => {
    const report = objectValue(input.document, "review report");
    if (report.schema_version === "awardping.stage1.official-role-review.v1") {
      assertZeroAttestation(report.read_only_attestation, [
        "production_mutations",
        "r2_object_requests",
        "page_captures",
        "paid_provider_calls",
        "ranked_candidates_auto_accepted",
      ], "official role review");
      if (report.read_only_attestation?.database_selects_only !== true) {
        throw new Error("Official role review must attest to database-select-only research.");
      }
      const awards = requiredArray(report.awards, "official role review awards");
      assertExactIntegerRange(awards.map((award) => award.launch_rank), 1, 8, "official role review ranks");
      const reviewedAt = requiredTimestamp(
        report.generated_at,
        "official role review generated_at",
      );
      validateSourceRevalidation(report, reviewedAt, "official role review");
      return {
        input,
        document: report,
        kind: "official_role_review",
        reviewedAt,
      };
    }
    if (report.schema_version === "awardping.stage1.official-source-human-review.v1") {
      assertZeroAttestation(report.attestation, [
        "production_mutations",
        "paid_api_calls",
        "ranked_candidates_auto_accepted",
      ], "official source review");
      if (report.mode !== "read_only_zero_charge") {
        throw new Error("Official source review must be read_only_zero_charge.");
      }
      const awards = requiredArray(report.awards, "official source review awards");
      const ranks = awards.map((award) => award.launch_rank).sort((left, right) => left - right);
      const declaredRanks = requiredArray(report.launch_ranks, "declared launch ranks")
        .slice()
        .sort((left, right) => left - right);
      if (canonicalJson(ranks) !== canonicalJson(declaredRanks)) {
        throw new Error("Official source review declared ranks do not match its award rows.");
      }
      const validRange =
        canonicalJson(ranks) === canonicalJson(integerRange(9, 16))
        || canonicalJson(ranks) === canonicalJson(integerRange(17, 25));
      if (!validRange) {
        throw new Error("Official source reviews must cover exactly ranks 9-16 or 17-25.");
      }
      const reviewedAt = requiredTimestamp(
        report.reviewed_at,
        "official source review reviewed_at",
      );
      validateSourceRevalidation(report, reviewedAt, "official source review");
      return {
        input,
        document: report,
        kind: "official_source_human_review",
        reviewedAt,
      };
    }
    throw new Error(`Unsupported review report schema: ${cleanText(report.schema_version) || "missing"}.`);
  });
  const kinds = reviews.map((review) => review.kind);
  if (kinds.filter((kind) => kind === "official_role_review").length !== 1) {
    throw new Error("Exactly one official role review is required.");
  }
  return reviews.sort((left, right) => (
    Math.min(...left.document.awards.map((award) => award.launch_rank))
    - Math.min(...right.document.awards.map((award) => award.launch_rank))
  ));
}

function validateSourceRevalidation(report, reviewedAt, label) {
  if (report.source_revalidation === undefined) {
    throw new Error(`${label} source revalidation is required.`);
  }
  const revalidation = objectValue(report.source_revalidation, `${label} source revalidation`);
  if (revalidation.source_choices_current !== true) {
    throw new Error(`${label} source choices are not currently revalidated.`);
  }
  if (revalidation.production_registry_binding_current !== true) {
    throw new Error(`${label} production registry binding is not current.`);
  }
  const revalidatedAt = requiredTimestamp(
    revalidation.reviewed_at,
    `${label} source revalidation reviewed_at`,
  );
  if (revalidatedAt !== reviewedAt) {
    throw new Error(`${label} source revalidation timestamp does not match its review timestamp.`);
  }
}

function validateExistingSourceBindings(context, sourcesById) {
  const retainedMembers = new Set(context.canonical.retained_member_ids);
  for (const row of context.existingRows) {
    const source = sourcesById.get(row.source_id);
    if (!source) {
      throw new Error(
        `${context.canonical.cohort_key}: reviewed source ${row.source_id} is absent from the fresh readiness registry.`,
      );
    }
    if (
      source.cohort_key !== context.canonical.cohort_key
      || !retainedMembers.has(source.shared_award_id)
    ) {
      throw new Error(
        `${context.canonical.cohort_key}: reviewed source ${row.source_id} is not owned by the signed cohort.`,
      );
    }
    if (source.normalized_url !== row.normalized_url) {
      throw new Error(
        `${context.canonical.cohort_key}: reviewed source ${row.source_id} URL does not match the fresh readiness registry.`,
      );
    }
  }
}

function normalizeRoleReviewAward({ reviewedAward, canonical, review }) {
  const sourceCatalog = objectValue(reviewedAward.source_catalog, "source catalog");
  const reviewedRoles = objectValue(reviewedAward.roles, "reviewed roles");
  assertExactRoleKeys(Object.keys(reviewedRoles), `role review ${canonical.cohort_key}`);
  const catalogEntries = Object.entries(sourceCatalog);
  const existingRows = catalogEntries.map(([reference, source]) => ({
    reference,
    source_id: requiredUuid(source?.id, `source catalog ${reference} id`),
    normalized_url: normalizeHttpsUrl(source?.url, `source catalog ${reference} URL`),
    inventory_status: requiredText(source?.state, `source catalog ${reference} state`),
    evidence_status: cleanNullable(source?.evidence),
    roles: [],
    monitor_only_roles: [],
    review_reason_by_role: {},
  }));
  const existingByReference = new Map(existingRows.map((row) => [row.reference, row]));
  const paidUrls = requiredArray(
    reviewedAward.paid_new_page_review_urls,
    `paid new-page URLs for ${canonical.cohort_key}`,
  ).map((url) => normalizeHttpsUrl(url, `paid new-page URL for ${canonical.cohort_key}`));
  if (new Set(paidUrls).size !== paidUrls.length) {
    throw new Error(`Paid new-page URLs contain duplicates for ${canonical.cohort_key}.`);
  }
  const newRows = paidUrls.map((normalizedUrl) => ({
    normalized_url: normalizedUrl,
    inventory_status: "source_intake_required",
    roles: [],
    monitor_only_roles: [],
    manifest_status_by_role: {},
    review_reason_by_role: {},
  }));
  const newByUrl = new Map(newRows.map((row) => [row.normalized_url, row]));
  const roleSlots = [];
  const explicitlyMappedNewUrls = new Set();

  for (const role of STAGE1_REQUIRED_SOURCE_ROLES) {
    const reviewedRole = objectValue(reviewedRoles[role], `${canonical.cohort_key} ${role}`);
    const status = requiredManifestStatus(
      reviewedRole.manifest_status_recommendation,
      `${canonical.cohort_key} ${role}`,
    );
    const disposition = requiredText(reviewedRole.disposition, `${canonical.cohort_key} ${role} disposition`);
    const assignments = [];
    for (const reference of arrayValue(reviewedRole.source_refs)) {
      const existing = existingByReference.get(requiredText(reference, "source reference"));
      if (!existing) {
        throw new Error(`Unknown source reference ${reference} for ${canonical.cohort_key} ${role}.`);
      }
      existing.roles.push(role);
      if (status === "not_published") existing.monitor_only_roles.push(role);
      existing.review_reason_by_role[role] = cleanNullable(reviewedRole.reason);
      assignments.push({ binding_kind: "existing_source", binding_key: existing.source_id });
    }
    const officialUrls = arrayValue(reviewedRole.official_urls).map((url) =>
      normalizeHttpsUrl(url, `explicit reviewed URL for ${canonical.cohort_key} ${role}`));
    if (disposition === "source_intake_required" && officialUrls.length === 0) {
      throw new Error(`Source-intake role ${canonical.cohort_key} ${role} lacks an explicit reviewed URL mapping.`);
    }
    if (disposition !== "source_intake_required" && officialUrls.length > 0) {
      throw new Error(`Only source-intake roles may declare new official URLs for ${canonical.cohort_key} ${role}.`);
    }
    for (const normalizedUrl of officialUrls) {
      const candidate = newByUrl.get(normalizedUrl);
      if (!candidate) {
        throw new Error(`Explicit role URL is not bound to the paid review list for ${canonical.cohort_key} ${role}.`);
      }
      explicitlyMappedNewUrls.add(normalizedUrl);
      candidate.roles.push(role);
      if (status === "not_published") candidate.monitor_only_roles.push(role);
      candidate.manifest_status_by_role[role] = status;
      candidate.review_reason_by_role[role] = cleanNullable(reviewedRole.reason);
      assignments.push({ binding_kind: "new_page_request", binding_key: normalizedUrl });
    }
    if (assignments.length === 0) {
      throw new Error(`Reviewed role ${canonical.cohort_key} ${role} has no exact source attribution.`);
    }
    roleSlots.push({ source_role: role, manifest_status: status, assignments });
  }
  if (
    explicitlyMappedNewUrls.size !== newByUrl.size
    || [...newByUrl.keys()].some((url) => !explicitlyMappedNewUrls.has(url))
  ) {
    throw new Error(`Paid new-page URL list has an unaccounted URL for ${canonical.cohort_key}.`);
  }
  for (const row of existingRows) {
    if (row.roles.length === 0) {
      throw new Error(`Source catalog row ${row.reference} is not attributed to a role for ${canonical.cohort_key}.`);
    }
  }
  return makeAwardContext({
    canonical,
    reviewedAward,
    review,
    roleSlots,
    existingRows,
    newRows,
    reviewedHomepage: homepageFromRoleSlots(roleSlots, existingRows, newRows),
    counts: {
      reviewed_inventory_rows: catalogEntries.length,
      existing_source_rows: catalogEntries.length,
      new_candidate_rows: paidUrls.length,
    },
  });
}

function normalizeOfficialSourceReviewAward({ reviewedAward, canonical, review }) {
  const recommended = requiredArray(
    reviewedAward.recommended_sources,
    `recommended sources for ${canonical.cohort_key}`,
  );
  const existingRows = [];
  const newRows = [];
  const assignmentsByRole = new Map(
    STAGE1_REQUIRED_SOURCE_ROLES.map((role) => [role, []]),
  );
  for (const [index, source] of recommended.entries()) {
    const normalizedUrl = normalizeHttpsUrl(
      source?.url,
      `${canonical.cohort_key} recommended source ${index + 1}`,
    );
    const inventoryStatus = requiredText(
      source?.inventory_status,
      `${canonical.cohort_key} inventory status`,
    );
    const roles = uniqueRoles(source?.roles, `${canonical.cohort_key} recommended source ${index + 1}`);
    const monitorOnly = inventoryStatus.includes("monitor_only")
      || source?.manifest_status === "not_published";
    const explicitStatus = source?.manifest_status == null
      ? null
      : requiredManifestStatus(source.manifest_status, `${canonical.cohort_key} source status`);
    const common = {
      normalized_url: normalizedUrl,
      inventory_status: inventoryStatus,
      roles,
      monitor_only_roles: monitorOnly ? [...roles] : [],
      manifest_status_by_role: Object.fromEntries(
        roles.map((role) => [role, explicitStatus]),
      ),
      review_reason_by_role: Object.fromEntries(
        roles.map((role) => [role, cleanNullable(source?.reason || source?.note)]),
      ),
    };
    const newPageStatus = inventoryStatus.startsWith("needs_new_page_review");
    let bindingKind;
    let bindingKey;
    if (source?.source_id == null) {
      if (!newPageStatus) {
        throw new Error(`Unbound source for ${canonical.cohort_key} is not marked needs_new_page_review.`);
      }
      newRows.push(common);
      bindingKind = "new_page_request";
      bindingKey = normalizedUrl;
    } else {
      if (newPageStatus) {
        throw new Error(`Existing source ID for ${canonical.cohort_key} conflicts with needs_new_page_review.`);
      }
      const sourceId = requiredUuid(source.source_id, `${canonical.cohort_key} source id`);
      existingRows.push({ ...common, source_id: sourceId });
      bindingKind = "existing_source";
      bindingKey = sourceId;
    }
    for (const role of roles) {
      assignmentsByRole.get(role).push({
        binding_kind: bindingKind,
        binding_key: bindingKey,
        explicit_status: explicitStatus,
        monitor_only: monitorOnly,
      });
    }
  }
  const roleSlots = STAGE1_REQUIRED_SOURCE_ROLES.map((role) => {
    const assignments = assignmentsByRole.get(role);
    if (assignments.length === 0) {
      throw new Error(`Official source review left ${canonical.cohort_key} ${role} unaccounted.`);
    }
    const explicitStatuses = [...new Set(
      assignments.map((assignment) => assignment.explicit_status).filter(Boolean),
    )];
    if (explicitStatuses.length > 1) {
      throw new Error(`Official source review has conflicting statuses for ${canonical.cohort_key} ${role}.`);
    }
    if (
      explicitStatuses[0] === "not_published"
      && assignments.some((assignment) => !assignment.monitor_only)
    ) {
      throw new Error(`Not-published role ${canonical.cohort_key} ${role} includes a non-monitor source.`);
    }
    const manifestStatus = explicitStatuses[0]
      || (role === "identity_home" || role === "current_documents" ? "present" : "combined");
    return {
      source_role: role,
      manifest_status: manifestStatus,
      assignments: assignments.map(({ binding_kind, binding_key }) => ({
        binding_kind,
        binding_key,
      })),
    };
  });
  return makeAwardContext({
    canonical,
    reviewedAward,
    review,
    roleSlots,
    existingRows,
    newRows,
    reviewedHomepage: normalizeHttpsUrl(
      reviewedAward.official_homepage,
      `reviewed homepage for ${canonical.cohort_key}`,
    ),
    counts: {
      reviewed_inventory_rows: recommended.length,
      existing_source_rows: existingRows.length,
      new_candidate_rows: newRows.length,
    },
  });
}

function makeAwardContext({
  canonical,
  reviewedAward,
  review,
  roleSlots,
  existingRows,
  newRows,
  reviewedHomepage,
  counts,
}) {
  return {
    canonical,
    reviewedAward,
    review,
    roleSlots,
    existingRows,
    newRows,
    reviewedHomepage,
    counts,
  };
}

function finalizeAwardContext(context) {
  const { canonical, review } = context;
  const existingSources = groupExistingSources(context);
  const newPageRequests = groupNewPageRequests(context);
  const existingById = new Map(existingSources.map((source) => [source.source_id, source]));
  const requestByUrl = new Map(newPageRequests.map((request) => [request.normalized_url, request]));
  const roleCoverage = context.roleSlots.map((slot) => {
    const assignments = slot.assignments.map((assignment) => {
      if (assignment.binding_kind === "existing_source") {
        const source = existingById.get(assignment.binding_key);
        if (!source) throw new Error(`Missing normalized existing source ${assignment.binding_key}.`);
        return {
          binding_kind: "existing_source",
          source_id: source.source_id,
          normalized_url: source.normalized_url,
          action: "retain_read_only",
          monitor_only: source.monitor_only_roles.includes(slot.source_role),
        };
      }
      const request = requestByUrl.get(assignment.binding_key);
      if (!request) throw new Error(`Missing normalized new-page request ${assignment.binding_key}.`);
      return {
        binding_kind: "new_page_request",
        request_id: request.request_id,
        normalized_url: request.normalized_url,
        action: "enqueue_after_exact_confirmation",
        monitor_only: request.monitor_only_roles.includes(slot.source_role),
      };
    });
    return {
      canonical_shared_award_id: canonical.canonical_shared_award_id,
      source_role: slot.source_role,
      manifest_status: slot.manifest_status,
      accounted: assignments.length > 0,
      assignments,
    };
  });
  assertExactRoleKeys(roleCoverage.map((slot) => slot.source_role), canonical.cohort_key);
  const reviewedHomepage = context.reviewedHomepage;
  const registryHomepage = canonical.official_homepage;
  const homepagesMatch = reviewedHomepage === registryHomepage;
  const homepagesIdentityEquivalent = homepageIdentityEquivalent(
    reviewedHomepage,
    registryHomepage,
  );
  const delegation = resolveHomepageDelegation({
    canonical,
    reviewedAward: context.reviewedAward,
    reviewedHomepage,
    registryHomepage,
    existingSources,
    newPageRequests,
  });
  return {
    launch_rank: canonical.launch_rank,
    cohort_key: canonical.cohort_key,
    canonical_shared_award_id: canonical.canonical_shared_award_id,
    canonical_name: canonical.canonical_name,
    registry_policy_version: canonical.policy_version,
    registry_official_homepage: registryHomepage,
    reviewed_official_homepage: reviewedHomepage,
    identity_homepage_alignment: {
      normalized_exact_match: homepagesMatch,
      identity_equivalent: homepagesIdentityEquivalent,
      action: delegation
        ? "retain_authority_homepage_delegated_contractor_source"
        : homepagesMatch
        ? "none"
        : homepagesIdentityEquivalent
          ? "none_www_alias_equivalent"
          : "separate_identity_migration_review_required",
      automatic_identity_mutation: false,
      registry_homepage_classification: delegation?.authority_classification
        || "official_authority_host",
      reviewed_homepage_classification: "official_authority_host",
      delegated_source_classification: delegation?.reviewed_source_classification || null,
      delegated_host: delegation?.delegated_host || null,
      delegated_root_url: delegation?.delegated_root_url || null,
      delegation_evidence_url: delegation?.delegation_evidence_url || null,
      delegation_evidence_checked_at: delegation?.evidence_checked_at || null,
      delegation_review_sha256: delegation?.review_sha256 || null,
      current_fact_conflict: delegation?.current_fact_conflict || null,
    },
    review_provenance: {
      review_kind: review.kind,
      review_input_sha256: review.input.sha256,
      reviewed_at: review.reviewedAt,
      human_selected_official_urls: true,
      ranked_candidates_auto_accepted: 0,
    },
    coverage: {
      required_role_count: 8,
      accounted_role_count: roleCoverage.filter((slot) => slot.accounted).length,
      role_gap_count: roleCoverage.filter((slot) => !slot.accounted).length,
    },
    role_coverage: roleCoverage,
    existing_sources: existingSources,
    new_page_requests: newPageRequests,
  };
}

function groupExistingSources(context) {
  const grouped = new Map();
  for (const row of context.existingRows) {
    const sourceId = requiredUuid(row.source_id, "existing source id");
    const current = grouped.get(sourceId);
    if (current && current.normalized_url !== row.normalized_url) {
      throw new Error(`Existing source ${sourceId} has conflicting reviewed URLs.`);
    }
    const target = current || {
      canonical_shared_award_id: context.canonical.canonical_shared_award_id,
      source_id: sourceId,
      normalized_url: row.normalized_url,
      action: "retain_read_only",
      reviewed_roles: [],
      monitor_only_roles: [],
      inventory_statuses: [],
      evidence_statuses: [],
    };
    target.reviewed_roles.push(...row.roles);
    target.monitor_only_roles.push(...row.monitor_only_roles);
    target.inventory_statuses.push(row.inventory_status);
    if (row.evidence_status) target.evidence_statuses.push(row.evidence_status);
    grouped.set(sourceId, target);
  }
  return [...grouped.values()].map((source) => ({
    ...source,
    reviewed_roles: sortRoles(source.reviewed_roles),
    monitor_only_roles: sortRoles(source.monitor_only_roles),
    inventory_statuses: sortedUnique(source.inventory_statuses),
    evidence_statuses: sortedUnique(source.evidence_statuses),
  })).sort((left, right) => left.source_id.localeCompare(right.source_id));
}

function groupNewPageRequests(context) {
  const grouped = new Map();
  for (const row of context.newRows) {
    const logicalKey = `${context.canonical.canonical_shared_award_id}\n${row.normalized_url}`;
    const current = grouped.get(logicalKey) || {
      normalized_url: row.normalized_url,
      reviewed_roles: [],
      monitor_only_roles: [],
      inventory_statuses: [],
      manifest_status_by_role: {},
      review_reason_by_role: {},
    };
    current.reviewed_roles.push(...row.roles);
    current.monitor_only_roles.push(...row.monitor_only_roles);
    current.inventory_statuses.push(row.inventory_status);
    for (const [role, status] of Object.entries(row.manifest_status_by_role || {})) {
      if (
        current.manifest_status_by_role[role]
        && status
        && current.manifest_status_by_role[role] !== status
      ) throw new Error(`Conflicting new-page manifest status for ${context.canonical.cohort_key} ${role}.`);
      if (status) current.manifest_status_by_role[role] = status;
    }
    for (const [role, reason] of Object.entries(row.review_reason_by_role || {})) {
      if (reason) current.review_reason_by_role[role] = reason;
    }
    grouped.set(logicalKey, current);
  }
  return [...grouped.values()].map((group) => {
    const reviewedRoles = sortRoles(group.reviewed_roles);
    const monitorOnlyRoles = sortRoles(group.monitor_only_roles);
    const requestId = deterministicUuid(
      `${STAGE1_REVIEWED_SOURCE_POLICY_VERSION}\n${context.canonical.canonical_shared_award_id}\n${group.normalized_url}`,
    );
    const provenanceBasis = {
      schema_version: "awardping.stage1.reviewed-source-onboarding-evidence.v1",
      policy_version: STAGE1_REVIEWED_SOURCE_POLICY_VERSION,
      onboarding_batch_id: STAGE1_REVIEWED_SOURCE_BATCH_ID,
      canonical_shared_award_id: context.canonical.canonical_shared_award_id,
      canonical_name: context.canonical.canonical_name,
      normalized_url: group.normalized_url,
      reviewed_roles: reviewedRoles,
      monitor_only_roles: monitorOnlyRoles,
      inventory_statuses: sortedUnique(group.inventory_statuses),
      manifest_status_by_role: orderedRoleObject(group.manifest_status_by_role),
      review_reason_by_role: orderedRoleObject(group.review_reason_by_role),
      review_input_sha256: context.review.input.sha256,
      review_input_schema_version: context.review.document.schema_version,
      reviewed_at: context.review.reviewedAt,
      selection_method: "explicit_human_reviewed_official_url",
      ranked_candidates_auto_accepted: 0,
      paid_lane: "new_page_review",
      notification_after_approval: "baseline_only",
    };
    const evidence = {
      ...provenanceBasis,
      evidence_sha256: sha256(canonicalJson(provenanceBasis)),
    };
    const intakeType = reviewedRoles.includes("identity_home")
      ? "award_homepage"
      : "official_source";
    const requestRow = {
      id: requestId,
      award_name: context.canonical.canonical_name,
      homepage_url: group.normalized_url,
      notes: "Explicitly selected by the Stage 1 official-source human review. Route through the separate $5/day new-page review lane. Historical onboarding is baseline-only and must not publish a first-observation alert. Do not change the award identity or activate a source by ranking.",
      intake_type: intakeType,
      submitted_url: group.normalized_url,
      normalized_url: group.normalized_url,
      detected_award_name: context.canonical.canonical_name,
      matched_shared_award_id: context.canonical.canonical_shared_award_id,
      status: "pending",
      status_reason: "queued_from_reviewed_stage1_historical_import_baseline_only",
      ai_review: {
        reviewed_source_onboarding_evidence: evidence,
      },
      deterministic_review: {
        status: "explicit_human_reviewed_candidate",
        reason: "reviewed_official_url_requires_separate_paid_new_page_review",
        normalizedUrl: group.normalized_url,
        reviewed_source_onboarding_evidence_sha256: evidence.evidence_sha256,
      },
      discovered_links: [],
      capture_metadata: {
        reviewed_source_onboarding: {
          policy_version: STAGE1_REVIEWED_SOURCE_POLICY_VERSION,
          evidence_sha256: evidence.evidence_sha256,
          source_activation: "review_then_baseline_only",
          notification_after_approval: "baseline_only",
          paid_lane: "new_page_review",
          daily_spend_cap_usd: 5,
        },
      },
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      onboarding_batch_id: STAGE1_REVIEWED_SOURCE_BATCH_ID,
    };
    return {
      launch_rank: context.canonical.launch_rank,
      cohort_key: context.canonical.cohort_key,
      canonical_shared_award_id: context.canonical.canonical_shared_award_id,
      request_id: requestId,
      normalized_url: group.normalized_url,
      reviewed_roles: reviewedRoles,
      monitor_only_roles: monitorOnlyRoles,
      inventory_statuses: sortedUnique(group.inventory_statuses),
      intake_type: intakeType,
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      enqueue_paid_api_calls: 0,
      evidence,
      request_row: requestRow,
    };
  }).sort(compareRequests);
}

function validateAwardBinding(reviewedAward, canonical) {
  if (
    requiredInteger(reviewedAward?.launch_rank, "review launch rank") !== canonical.launch_rank
    || requiredText(reviewedAward?.cohort_key, "review cohort key") !== canonical.cohort_key
    || requiredText(reviewedAward?.canonical_name, "review canonical name") !== canonical.canonical_name
  ) {
    throw new Error(`Reviewed award identity does not exactly match registry rank ${canonical.launch_rank}.`);
  }
  if (
    reviewedAward.canonical_shared_award_id != null
    && requiredUuid(reviewedAward.canonical_shared_award_id, "review canonical award id")
      !== canonical.canonical_shared_award_id
  ) {
    throw new Error(`Reviewed award ID does not match registry rank ${canonical.launch_rank}.`);
  }
}

function validatePlannedRequest(item) {
  const request = objectValue(item.request_row, "planned request row");
  assertExactObjectKeys(request, [
    "id",
    "award_name",
    "homepage_url",
    "notes",
    "intake_type",
    "submitted_url",
    "normalized_url",
    "detected_award_name",
    "matched_shared_award_id",
    "status",
    "status_reason",
    "ai_review",
    "deterministic_review",
    "discovered_links",
    "capture_metadata",
    "acquisition_kind",
    "notification_mode",
    "onboarding_batch_id",
  ], "planned source_page_requests row");
  const normalizedUrl = normalizeHttpsUrl(request.normalized_url, "planned request URL");
  const expectedId = deterministicUuid(
    `${STAGE1_REVIEWED_SOURCE_POLICY_VERSION}\n${item.canonical_shared_award_id}\n${normalizedUrl}`,
  );
  if (
    item.request_id !== request.id
    || item.request_id !== expectedId
    || item.canonical_shared_award_id !== request.matched_shared_award_id
    || item.normalized_url !== normalizedUrl
    || request.homepage_url !== normalizedUrl
    || request.submitted_url !== normalizedUrl
    || request.detected_award_name !== request.award_name
    || request.acquisition_kind !== "historical_import"
    || request.notification_mode !== "baseline_only"
    || request.onboarding_batch_id !== STAGE1_REVIEWED_SOURCE_BATCH_ID
    || request.status !== "pending"
    || item.enqueue_paid_api_calls !== 0
  ) throw new Error(`Invalid planned new-page request ${cleanText(item.request_id) || "missing"}.`);
  requiredUuid(request.id, "planned request id");
  const reviewedRoles = uniqueRoles(item.reviewed_roles, "planned request");
  if (canonicalJson(reviewedRoles) !== canonicalJson(item.reviewed_roles)) {
    throw new Error(`Planned request ${request.id} roles are not in canonical order.`);
  }
  if (
    item.evidence?.canonical_shared_award_id !== request.matched_shared_award_id
    || item.evidence?.normalized_url !== normalizedUrl
    || item.evidence?.ranked_candidates_auto_accepted !== 0
    || item.evidence?.paid_lane !== "new_page_review"
    || item.evidence?.notification_after_approval !== "baseline_only"
    || canonicalJson(request.ai_review?.reviewed_source_onboarding_evidence)
      !== canonicalJson(item.evidence)
  ) throw new Error(`Planned request ${request.id} has invalid reviewed evidence binding.`);
}

function assertSameRequestSeed(existing, planned) {
  const fields = [
    "id",
    "award_name",
    "homepage_url",
    "intake_type",
    "submitted_url",
    "normalized_url",
    "detected_award_name",
    "matched_shared_award_id",
    "acquisition_kind",
    "notification_mode",
    "onboarding_batch_id",
  ];
  for (const field of fields) {
    if (existing?.[field] !== planned?.[field]) {
      throw new Error(`Existing deterministic request ${planned.id} has a conflicting ${field}.`);
    }
  }
  const existingEvidenceHash = existing?.ai_review
    ?.reviewed_source_onboarding_evidence?.evidence_sha256;
  const plannedEvidenceHash = planned?.ai_review
    ?.reviewed_source_onboarding_evidence?.evidence_sha256;
  if (existingEvidenceHash !== plannedEvidenceHash) {
    throw new Error(
      `Existing deterministic request ${planned.id} has conflicting reviewed evidence.`,
    );
  }
}

function plannedRequestSelect() {
  return [
    "id",
    "award_name",
    "homepage_url",
    "intake_type",
    "submitted_url",
    "normalized_url",
    "detected_award_name",
    "matched_shared_award_id",
    "acquisition_kind",
    "notification_mode",
    "onboarding_batch_id",
    "ai_review",
  ].join(",");
}

async function validateLiveCohortIdentity({ supabase, plan }) {
  const plannedAwards = requiredArray(plan.awards, "planned awards");
  const cohortKeys = plannedAwards.map((award) => award.cohort_key);
  const awardIds = plannedAwards.map((award) => award.canonical_shared_award_id);
  const registryResult = await supabase
    .from("stage1_award_registry")
    .select(
      "cohort_key,launch_rank,canonical_name,canonical_shared_award_id,official_homepage,policy_version,updated_at",
      { count: "exact" },
    )
    .in("cohort_key", cohortKeys)
    .limit(25);
  assertExactQueryResult(registryResult, 25, "live Stage 1 registry identity");
  const registryByKey = new Map(registryResult.data.map((row) => [row.cohort_key, row]));
  const observedAt = Date.parse(plan.registry_observed_at);
  for (const planned of plannedAwards) {
    const current = registryByKey.get(planned.cohort_key);
    if (
      !current
      || current.launch_rank !== planned.launch_rank
      || current.canonical_name !== planned.canonical_name
      || current.canonical_shared_award_id !== planned.canonical_shared_award_id
      || normalizeHttpsUrl(current.official_homepage, "live registry homepage")
        !== planned.registry_official_homepage
      || current.policy_version !== planned.registry_policy_version
      || !Number.isFinite(Date.parse(current.updated_at))
      || Date.parse(current.updated_at) > observedAt
    ) {
      throw new Error(
        `Live Stage 1 registry identity changed or advanced after preview for ${planned.cohort_key}; rebuild the plan.`,
      );
    }
  }

  const awardsResult = await supabase
    .from("shared_awards")
    .select("id,name,official_homepage,status,updated_at", { count: "exact" })
    .in("id", awardIds)
    .limit(25);
  assertExactQueryResult(awardsResult, 25, "live canonical shared awards");
  const awardsById = new Map(awardsResult.data.map((row) => [row.id, row]));
  for (const planned of plannedAwards) {
    const current = awardsById.get(planned.canonical_shared_award_id);
    if (
      !current
      || current.name !== planned.canonical_name
      || current.status !== "active"
      || normalizeHttpsUrl(current.official_homepage, "live shared-award homepage")
        !== planned.registry_official_homepage
      || !Number.isFinite(Date.parse(current.updated_at))
      || Date.parse(current.updated_at) > observedAt
    ) {
      throw new Error(
        `Live canonical shared-award identity changed or advanced after preview for ${planned.cohort_key}; rebuild the plan.`,
      );
    }
  }
}

async function loadExactRowsByIds(supabase, ids, label) {
  const result = await supabase
    .from("source_page_requests")
    .select(plannedRequestSelect(), { count: "exact" })
    .in("id", ids)
    .limit(ids.length);
  if (result.error) {
    throw new Error(`Reviewed source onboarding ${label} read failed: ${safeDatabaseError(result.error)}`);
  }
  if (!Number.isInteger(result.count) || result.count !== (result.data || []).length) {
    throw new Error(`Reviewed source onboarding ${label} read was capped or lacked an exact count.`);
  }
  return { rows: result.data || [], count: result.count };
}

async function assertNoActiveLogicalCollisions(supabase, requests, phase) {
  for (const request of requests) {
    const result = await supabase
      .from("source_page_requests")
      .select("id,status,matched_shared_award_id,normalized_url", { count: "exact" })
      .eq("matched_shared_award_id", request.matched_shared_award_id)
      .eq("normalized_url", request.normalized_url)
      .in("status", activeRequestStatuses)
      .limit(2);
    if (result.error) {
      throw new Error(
        `Reviewed source onboarding ${phase} exact collision read failed: ${safeDatabaseError(result.error)}`,
      );
    }
    if (!Number.isInteger(result.count) || result.count !== (result.data || []).length) {
      throw new Error(
        `Reviewed source onboarding ${phase} collision check was capped or ambiguous for ${request.id}.`,
      );
    }
    if (result.count > 1) {
      throw new Error(`Multiple active requests exist for exact award and URL ${request.id}.`);
    }
    const existing = result.data?.[0];
    if (existing && existing.id !== request.id) {
      throw new Error(
        `Active source intake collision for exact award and URL; expected ${request.id}, found ${existing.id}.`,
      );
    }
  }
}

function assertExactQueryResult(result, expectedCount, label) {
  if (result.error) throw new Error(`${label} read failed: ${safeDatabaseError(result.error)}`);
  if (
    result.count !== expectedCount
    || !Array.isArray(result.data)
    || result.data.length !== expectedCount
  ) throw new Error(`${label} must return exactly ${expectedCount} uncapped rows.`);
}

function logicalRequestKey(request) {
  return `${cleanText(
    request?.matched_shared_award_id || request?.canonical_shared_award_id,
  ).toLowerCase()}\n${cleanText(request?.normalized_url)}`;
}

function normalizeInput(input, fallbackLabel) {
  const wrapper = input?.document ? input : { document: input };
  const document = objectValue(wrapper.document, `${fallbackLabel} document`);
  const label = cleanText(wrapper.source_label || wrapper.file_name || fallbackLabel);
  const hash = wrapper.sha256
    ? requiredSha256(wrapper.sha256, `${fallbackLabel} SHA-256`)
    : sha256(canonicalJson(document));
  return { document, source_label: label, sha256: hash };
}

function normalizeReadinessSourceUrl(value) {
  try {
    return normalizeHttpsUrl(value, "readiness source URL");
  } catch {
    return null;
  }
}

function inputEvidence(input, kind) {
  return {
    kind,
    source_label: input.source_label,
    schema_version: requiredText(input.document.schema_version, "input schema version"),
    sha256: input.sha256,
  };
}

function homepageFromRoleSlots(roleSlots, existingRows, newRows) {
  const identity = roleSlots.find((slot) => slot.source_role === "identity_home");
  const assignment = identity?.assignments?.[0];
  if (!assignment) throw new Error("Reviewed identity_home role has no homepage assignment.");
  if (assignment.binding_kind === "existing_source") {
    return existingRows.find((row) => row.source_id === assignment.binding_key)?.normalized_url
      || missingHomepage();
  }
  return newRows.find((row) => row.normalized_url === assignment.binding_key)?.normalized_url
    || missingHomepage();
}

function missingHomepage() {
  throw new Error("Reviewed identity_home assignment could not be resolved to an exact URL.");
}

function normalizeHttpsUrl(value, label) {
  const raw = requiredText(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute public HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  const normalized = normalizeSourceIntakeUrl(raw);
  if (!normalized.startsWith("https://")) throw new Error(`${label} must normalize to HTTPS.`);
  return normalized;
}

function homepageIdentityEquivalent(left, right) {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  const host = (value) => value.hostname.toLowerCase().replace(/^www\./, "");
  return host(leftUrl) === host(rightUrl)
    && leftUrl.pathname === rightUrl.pathname
    && leftUrl.search === rightUrl.search;
}

function resolveHomepageDelegation({
  canonical,
  reviewedAward,
  reviewedHomepage,
  registryHomepage,
  existingSources,
  newPageRequests,
}) {
  const contract = homepageDelegationContracts.get(canonical.cohort_key);
  const declaration = reviewedAward?.delegated_source_authority;
  if (!declaration) {
    if (!contract) return null;
    throw new Error(
      `Reviewed delegation evidence is required for ${canonical.cohort_key}.`,
    );
  }
  if (!contract) {
    throw new Error(`Unexpected delegated source authority for ${canonical.cohort_key}.`);
  }
  const value = objectValue(
    declaration,
    `delegated source authority for ${canonical.cohort_key}`,
  );
  if (value.schema_version !== "awardping.stage1.delegated-source-authority-review.v1") {
    throw new Error(`Delegated source authority schema is unsupported for ${canonical.cohort_key}.`);
  }
  const authorityHomepage = normalizeHttpsUrl(
    value.canonical_homepage,
    `${canonical.cohort_key} delegation authority homepage`,
  );
  const delegatedRootUrl = normalizeHttpsUrl(
    value.delegated_root_url,
    `${canonical.cohort_key} delegated root URL`,
  );
  const evidenceUrl = normalizeHttpsUrl(
    value.authority_evidence_url,
    `${canonical.cohort_key} delegation evidence URL`,
  );
  const delegatedHost = requiredText(
    value.delegated_host,
    `${canonical.cohort_key} delegated host`,
  ).toLowerCase();
  const conflict = objectValue(
    value.current_fact_conflict,
    `${canonical.cohort_key} delegated fact conflict`,
  );
  const contractorHomepage = objectValue(
    conflict.contractor_homepage,
    `${canonical.cohort_key} contractor homepage conflict evidence`,
  );
  const howToApply = objectValue(
    conflict.how_to_apply,
    `${canonical.cohort_key} how-to conflict evidence`,
  );
  const currentFactConflict = {
    publication_decision: requiredText(
      conflict.publication_decision,
      `${canonical.cohort_key} conflict publication decision`,
    ),
    contractor_homepage: {
      url: normalizeHttpsUrl(
        contractorHomepage.url,
        `${canonical.cohort_key} conflicting contractor homepage URL`,
      ),
      reported_period: requiredText(
        contractorHomepage.reported_period,
        `${canonical.cohort_key} contractor homepage reported period`,
      ),
      cycle: requiredText(
        contractorHomepage.cycle,
        `${canonical.cohort_key} contractor homepage cycle`,
      ),
    },
    how_to_apply: {
      url: normalizeHttpsUrl(
        howToApply.url,
        `${canonical.cohort_key} conflicting how-to URL`,
      ),
      reported_period: requiredText(
        howToApply.reported_period,
        `${canonical.cohort_key} how-to reported period`,
      ),
      cycle: requiredText(
        howToApply.cycle,
        `${canonical.cohort_key} how-to cycle`,
      ),
    },
  };
  if (
    registryHomepage !== contract.authority_homepage
    || reviewedHomepage !== contract.authority_homepage
    || authorityHomepage !== contract.authority_homepage
    || delegatedRootUrl !== contract.delegated_root_url
    || delegatedHost !== contract.delegated_host
    || new URL(delegatedRootUrl).hostname.toLowerCase() !== delegatedHost
    || evidenceUrl !== contract.delegation_evidence_url
    || value.authority_host_classification !== contract.authority_classification
    || value.classification !== contract.reviewed_source_classification
    || currentFactConflict.publication_decision !== "not_published"
  ) {
    throw new Error(
      `Reviewed delegation contract does not match the authority, contractor, or publication fence for ${canonical.cohort_key}.`,
    );
  }
  const normalizedSources = [...existingSources, ...newPageRequests];
  const sourceAt = (url) => normalizedSources.find((source) => source.normalized_url === url);
  const canonicalSource = sourceAt(authorityHomepage);
  const evidenceSource = sourceAt(evidenceUrl);
  const conflictSources = [
    sourceAt(currentFactConflict.contractor_homepage.url),
    sourceAt(currentFactConflict.how_to_apply.url),
  ];
  if (
    !canonicalSource?.reviewed_roles.includes("identity_home")
    || !evidenceSource?.reviewed_roles.includes("identity_home")
    || conflictSources.some(
      (source) => !source?.reviewed_roles.includes("dates_cycle")
        || !source.monitor_only_roles.includes("dates_cycle"),
    )
  ) {
    throw new Error(
      `Reviewed delegation sources are not bound to exact identity and monitor-only date roles for ${canonical.cohort_key}.`,
    );
  }
  return {
    ...contract,
    evidence_checked_at: requiredTimestamp(
      value.evidence_checked_at,
      `${canonical.cohort_key} delegation evidence_checked_at`,
    ),
    current_fact_conflict: currentFactConflict,
    review_sha256: sha256(canonicalJson(value)),
  };
}

function uniqueRoles(value, label) {
  const roles = requiredArray(value, `${label} roles`).map((role) => requiredText(role, `${label} role`));
  if (!roles.length || roles.some((role) => !roleSet.has(role))) {
    throw new Error(`${label} contains a missing or unsupported Stage 1 role.`);
  }
  if (new Set(roles).size !== roles.length) throw new Error(`${label} contains duplicate roles.`);
  return sortRoles(roles);
}

function assertExactRoleKeys(roles, label) {
  if (canonicalJson(sortRoles(roles)) !== canonicalJson(STAGE1_REQUIRED_SOURCE_ROLES)) {
    throw new Error(`${label} must account for each of the exact eight Stage 1 roles once.`);
  }
}

function sortRoles(values) {
  return [...new Set(values)].sort(
    (left, right) => STAGE1_REQUIRED_SOURCE_ROLES.indexOf(left)
      - STAGE1_REQUIRED_SOURCE_ROLES.indexOf(right),
  );
}

function orderedRoleObject(value) {
  return Object.fromEntries(
    STAGE1_REQUIRED_SOURCE_ROLES
      .filter((role) => value?.[role] != null)
      .map((role) => [role, value[role]]),
  );
}

function assertZeroAttestation(attestation, fields, label) {
  const value = objectValue(attestation, `${label} attestation`);
  for (const field of fields) {
    if (value[field] !== 0) throw new Error(`${label} must attest ${field}: 0.`);
  }
}

function requiredManifestStatus(value, label) {
  const status = requiredText(value, `${label} manifest status`);
  if (!manifestStatuses.has(status)) throw new Error(`${label} has unsupported manifest status ${status}.`);
  return status;
}

function assertExactIntegerRange(values, start, end, label) {
  const actual = values.map((value) => requiredInteger(value, label)).sort((left, right) => left - right);
  const expected = integerRange(start, end);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} must be exactly ${start}-${end}.`);
  }
}

function integerRange(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function latestTimestamp(values, label) {
  const timestamps = values.map((value) => requiredTimestamp(value, label));
  return timestamps.sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(milliseconds).toISOString();
}

function requiredUuid(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!uuidPattern.test(text)) throw new Error(`${label} must be a UUID.`);
  return text;
}

function requiredSha256(value, label) {
  const text = requiredText(value, label).toLowerCase();
  if (!sha256Pattern.test(text)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return text;
}

function requiredInteger(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanNullable(value) {
  return cleanText(value) || null;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertExactObjectKeys(value, keys, label) {
  const actual = Object.keys(objectValue(value, label)).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} must contain only its exact approved insert fields.`);
  }
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value != null))].sort();
}

function compareRank(left, right) {
  return left.launch_rank - right.launch_rank;
}

function compareRequests(left, right) {
  return left.launch_rank - right.launch_rank
    || left.normalized_url.localeCompare(right.normalized_url);
}

function compareInputEvidence(left, right) {
  return left.kind.localeCompare(right.kind) || left.source_label.localeCompare(right.source_label);
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeDatabaseError(error) {
  return cleanText(error?.code || error?.message || "database_error").slice(0, 500);
}
