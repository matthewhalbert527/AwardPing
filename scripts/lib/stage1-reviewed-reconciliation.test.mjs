import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildReviewedStage1ReconciliationPlan,
  reviewedStage1SelectionScope,
} from "./stage1-reviewed-reconciliation.mjs";

const NOW = new Date("2026-07-17T20:00:00.000Z");
const AWARD_ID = "11111111-1111-4111-8111-111111111111";
const ALIAS_ID = "77777777-7777-4777-8777-777777777777";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_CANDIDATE_ID = "66666666-6666-4666-8666-666666666666";
const QUEUE_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);

describe("reviewed Stage 1 reconciliation", () => {
  it("builds a deterministic exact-candidate plan without ranking or materialization", () => {
    const fixture = validFixture();
    const first = build(fixture);
    const second = build(structuredClone(fixture));

    expect(second).toEqual(first);
    expect(first.queue_binding).toMatchObject({
      mode: "create",
      status: "pending",
      generation: 0,
    });
    expect(first.confirmation_phrase).toMatch(
      /^CONFIRM STAGE1 RECONCILIATION [0-9a-f]{64}$/,
    );
    expect(first.commit).toMatchObject({
      source_ids: [SOURCE_ID],
      candidate_ids: [CANDIDATE_ID],
      generated_candidates: [],
      public_facts: { overview: "Exact reviewed overview" },
      summary: "Exact reviewed overview. Baseline detail confidence: medium.",
      confidence: 0.5,
    });
    expect(first.review_binding.review_root.cohorts[0].publication).toEqual({
      summary: first.commit.summary,
      confidence: first.commit.confidence,
    });
    expect(first.review_binding.award).toMatchObject({
      replacement_summary: first.commit.summary,
      replacement_confidence: first.commit.confidence,
      replacement_summary_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      replacement_confidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first.commit.candidate_status_updates).toHaveLength(1);
    expect(first.commit.candidate_status_updates[0]).not.toHaveProperty("source_role");
    expect(first.review_binding.candidate_versions[0]).toMatchObject({
      source_relevance: "primary",
      reviewed_stage1_source_role: "identity_home",
      composition_method: "direct_exact",
      composition_index: null,
      immutable_evidence: immutableEvidence("Exact reviewed overview"),
      candidate_import: reviewedCandidateImport("Exact reviewed overview"),
    });
    expect(JSON.stringify(first.commit.evidence_rows)).not.toContain(
      "operator@example.edu",
    );
    expect(JSON.stringify(first.commit.evidence_rows)).not.toContain(
      "Exact local immutable text verified before candidate import.",
    );
    expect(first.safety).toEqual({
      explicit_human_selection: true,
      broader_candidates_loaded: 0,
      candidates_materialized: 0,
      monitoring_sources_retired: 0,
      paid_api_calls: 0,
      preview_remote_mutations: 0,
    });
  });

  it("rejects a forged publication projection and derives the audit exactly", () => {
    const forged = validFixture();
    forged.selection.cohorts[0].publication = {
      summary: "Unreviewed replacement summary",
      confidence: 1,
    };
    expect(() => build(forged)).toThrow(/publication summary\/confidence/i);

    const plan = build(validFixture());
    expect(plan.commit.audit_row).toMatchObject({
      audit_kind: "deterministic",
      audit_status: "passed",
      severity: "info",
      findings: [],
      suggested_fixes: [],
      field_conflicts: [],
      source_rejections: [],
      model: "explicit-human-reviewed-stage1-reconciliation",
    });
    const projection = {
      stage1_review_root_schema_version:
        "awardping.stage1.human-review-root.v1",
      stage1_review_root_sha256: plan.selection_sha256,
      stage1_reviewed_public_facts_sha256:
        sha256Canonical(plan.commit.public_facts),
      stage1_reviewed_summary_sha256: createHash("sha256")
        .update(plan.commit.summary, "utf8")
        .digest("hex"),
      stage1_reviewed_confidence_sha256:
        sha256Canonical(plan.commit.confidence),
      stage1_reviewed_evidence_rows_sha256: sha256Canonical(
        [...plan.commit.evidence_rows].toSorted((left, right) =>
          left.field_name < right.field_name
            ? -1
            : left.field_name > right.field_name
              ? 1
              : 0),
      ),
    };
    expect(plan.commit.audit_row.selected_fact_summary).toMatchObject(projection);
    expect(plan.commit.audit_row.public_page_snapshot)
      .toEqual({
        ...plan.commit.public_facts,
        reconciliation_audit_signature: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    const auditBase = structuredClone(plan.commit.audit_row);
    const signature = auditBase.public_page_snapshot.reconciliation_audit_signature;
    delete auditBase.public_page_snapshot.reconciliation_audit_signature;
    expect(signature).toBe(sha256Canonical(auditBase));
  });

  it("reconciles an alias-owned source into the canonical publication", () => {
    const fixture = validFixture();
    fixture.database.members.push({
      shared_award_id: ALIAS_ID,
      cohort_key: "marshall",
      member_kind: "alias",
    });
    fixture.database.sources[0].shared_award_id = ALIAS_ID;
    fixture.database.visual_snapshots[0].shared_award_id = ALIAS_ID;
    fixture.database.fact_candidates[0].shared_award_id = ALIAS_ID;

    const plan = build(fixture);
    expect(plan.commit.shared_award_id).toBe(AWARD_ID);
    expect(plan.review_binding.candidate_versions[0].shared_award_id).toBe(ALIAS_ID);
    expect(plan.review_binding.source_snapshots[0].shared_award_id).toBe(ALIAS_ID);
    expect(plan.commit.source_ids).toEqual([SOURCE_ID]);
  });

  it("derives query scope only from explicit candidate IDs", () => {
    expect(reviewedStage1SelectionScope(validFixture().selection, NOW)).toEqual({
      cohort_key: "marshall",
      canonical_award_id: AWARD_ID,
      source_ids: [SOURCE_ID],
      candidate_ids: [CANDIDATE_ID],
    });
  });

  it("rejects a missing, extra, or unselectable candidate instead of auto-ranking", () => {
    const missing = validFixture();
    missing.selection.cohorts[0].field_choices[0].candidate_ids = [OTHER_CANDIDATE_ID];
    missing.selection.cohorts[0].field_choices[0]
      .candidate_evidence[0].candidate_id = OTHER_CANDIDATE_ID;
    missing.selection.cohorts[0].roles[0].fact_candidate_ids = [OTHER_CANDIDATE_ID];
    expect(() => build(missing)).toThrow(/explicit candidate rows do not exactly match/i);

    const extra = validFixture();
    extra.database.fact_candidates.push({
      ...structuredClone(extra.database.fact_candidates[0]),
      id: OTHER_CANDIDATE_ID,
    });
    expect(() => build(extra)).toThrow(/explicit candidate rows do not exactly match/i);

    const rejected = validFixture();
    rejected.database.fact_candidates[0].candidate_status = "rejected";
    expect(() => build(rejected)).toThrow(/not exact retained selectable evidence/i);
  });

  it("changes confirmation on candidate, award, source-snapshot, or queue drift", () => {
    const baseline = validFixture();
    const original = build(baseline).confirmation_sha256;

    const candidate = structuredClone(baseline);
    candidate.database.fact_candidates[0].updated_at = "2026-07-17T19:56:00.000Z";
    expect(build(candidate).confirmation_sha256).not.toBe(original);

    const award = structuredClone(baseline);
    award.database.awards[0].updated_at = "2026-07-17T19:56:00.000Z";
    expect(build(award).confirmation_sha256).not.toBe(original);

    const snapshot = structuredClone(baseline);
    snapshot.database.visual_snapshots[0].latest_hashes.image_hash = "d".repeat(64);
    for (const role of snapshot.selection.cohorts[0].roles) {
      role.sources[0].snapshot.hashes.image_hash = "d".repeat(64);
      role.sources[0].r2.hashes.image_hash = "d".repeat(64);
      role.sources[0].local.hashes.image_hash = "d".repeat(64);
    }
    expect(build(snapshot).confirmation_sha256).not.toBe(original);

    const queue = structuredClone(baseline);
    queue.database.active_queue = [pendingQueue(build(queue))];
    const queued = build(queue);
    queue.database.active_queue[0].generation += 1;
    expect(build(queue).confirmation_sha256).not.toBe(queued.confirmation_sha256);
  });

  it("rejects a processing queue or wrong-owner source", () => {
    const processing = validFixture();
    processing.database.active_queue = [{
      ...pendingQueue(build(processing)),
      status: "processing",
      started_at: "2026-07-17T19:58:00.000Z",
    }];
    expect(() => build(processing)).toThrow(/not exact dedicated reviewed work/i);

    const unrelated = validFixture();
    unrelated.database.active_queue = [{
      ...pendingQueue(build(unrelated)),
      reason: "source_changed",
      metadata: {},
    }];
    expect(() => build(unrelated)).toThrow(/not exact dedicated reviewed work/i);

    const wrongOwner = validFixture();
    wrongOwner.database.sources[0].shared_award_id =
      "99999999-9999-4999-8999-999999999999";
    expect(() => build(wrongOwner)).toThrow(/source .* not currently selectable/i);
  });

  it("requires exact field values, evidence hashes, and explicit anti-ranking review flags", () => {
    const value = validFixture();
    value.database.fact_candidates[0].normalized_value = "Different overview";
    expect(() => build(value)).toThrow(/not exact retained selectable evidence/i);

    const evidence = validFixture();
    evidence.database.fact_candidates[0].intake_value_sha256 = "not-a-sha256";
    expect(() => build(evidence)).toThrow(/not exact retained selectable evidence/i);

    const explicitImport = validFixture();
    explicitImport.database.fact_candidates[0].intake_value_sha256 = null;
    expect(build(explicitImport).review_binding.candidate_versions[0]
      .intake_value_sha256).toBeNull();

    const ranking = validFixture();
    ranking.selection.review.auto_accept_ranked_candidates = true;
    expect(() => build(ranking)).toThrow(/auto_accept_ranked_candidates must be false/i);

    const extraPublicFact = validFixture();
    extraPublicFact.selection.cohorts[0].public_facts.operator_only_note = "must not publish";
    expect(() => build(extraPublicFact)).toThrow(/unsupported fields/i);
  });

  it("rejects legacy generic-quote candidates without exact immutable evidence", () => {
    const genericQuote = validFixture();
    genericQuote.database.fact_candidates[0].evidence_quote =
      "A generic page quote reused for every extracted fact.";
    expect(() => build(genericQuote)).toThrow(/not exact retained selectable evidence/i);

    const missingAttestation = validFixture();
    delete missingAttestation.database.fact_candidates[0].metadata
      .stage1_immutable_evidence;
    expect(() => build(missingAttestation)).toThrow(
      /not exact retained selectable evidence/i,
    );

    const wrongQuoteHash = validFixture();
    wrongQuoteHash.database.fact_candidates[0].metadata
      .stage1_immutable_evidence.evidence_quote_sha256 = "f".repeat(64);
    expect(() => build(wrongQuoteHash)).toThrow(
      /not exact retained selectable evidence/i,
    );

    const missingImportLedgerBinding = validFixture();
    delete missingImportLedgerBinding.database.fact_candidates[0].metadata
      .stage1_candidate_import;
    expect(() => build(missingImportLedgerBinding)).toThrow(
      /not exact retained selectable evidence/i,
    );

    const futureImportReview = validFixture();
    futureImportReview.database.fact_candidates[0].metadata
      .stage1_candidate_import.reviewed_at = "2026-07-17T19:56:00.000Z";
    futureImportReview.database.fact_candidates[0].extracted_at =
      "2026-07-17T19:56:00.000Z";
    expect(() => build(futureImportReview)).toThrow(
      /not exact retained selectable evidence/i,
    );
  });

  it("keeps raw intake relevance separate from the signed Stage 1 source role", () => {
    const supporting = validFixture();
    supporting.database.fact_candidates[0].source_role = "supporting";
    supporting.database.fact_candidates[0].metadata.stage1_candidate_import =
      candidateImportMetadata(
        "Exact reviewed overview",
        "overview.exact-reviewed-overview",
        { sourceRelevance: "supporting" },
      );
    const plan = build(supporting);
    expect(plan.review_binding.candidate_versions[0]).toMatchObject({
      source_relevance: "supporting",
      reviewed_stage1_source_role: "identity_home",
    });

    const relabeled = validFixture();
    relabeled.database.fact_candidates[0].source_role = "identity_home";
    expect(() => build(relabeled)).toThrow(/not exact retained selectable evidence/i);
  });

  it("composes array fields only from explicitly ordered exact item candidates", () => {
    const plan = build(orderedArrayFixture());
    expect(plan.commit.public_facts).toEqual({
      overview: "Exact reviewed overview",
      application_materials: ["Transcript", "Two references"],
    });
    expect(plan.review_binding.candidate_versions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_id: OTHER_CANDIDATE_ID,
        composition_method: "ordered_array_items",
        composition_index: 0,
        normalized_value: "Transcript",
      }),
      expect.objectContaining({
        candidate_id: THIRD_CANDIDATE_ID,
        composition_method: "ordered_array_items",
        composition_index: 1,
        normalized_value: "Two references",
      }),
    ]));

    const reversedValue = orderedArrayFixture();
    reversedValue.database.fact_candidates[1].normalized_value = "Two references";
    expect(() => build(reversedValue)).toThrow(
      /not exact retained selectable evidence/i,
    );
  });
});

function build(fixture) {
  return buildReviewedStage1ReconciliationPlan({ ...fixture, now: NOW });
}

function validFixture() {
  return {
    selection: {
      schema_version: "awardping.stage1.human-review-root.v1",
      policy_version: "stage1-publication-v1",
      review: {
        reviewed_by: "operator@example.edu",
        reviewed_at: "2026-07-17T19:55:00.000Z",
        reason: "Human review of exact Marshall public facts and evidence.",
        selection_method: "explicit_human_review",
        auto_accept_ranked_candidates: false,
        materialize_candidates: false,
      },
      cohorts: [{
        cohort_key: "marshall",
        canonical_award: {
          id: AWARD_ID,
          search_key: "marshall scholarship",
          name: "Marshall Scholarship",
          official_homepage: "https://www.marshallscholarship.org/",
        },
        public_facts: { overview: "Exact reviewed overview" },
        field_choices: [{
          field_name: "overview",
          composition_method: "direct_exact",
          candidate_ids: [CANDIDATE_ID],
          candidate_evidence: [reviewedCandidateEvidence(
            CANDIDATE_ID,
            "Exact reviewed overview",
          )],
        }],
        roles: reviewedRoles(),
      }],
    },
    database: {
      registry: [{
        cohort_key: "marshall",
        canonical_name: "Marshall Scholarship",
        canonical_shared_award_id: AWARD_ID,
        official_homepage: "https://www.marshallscholarship.org/",
        publication_state: "pending",
        policy_version: "stage1-publication-v1",
      }],
      members: [{
        shared_award_id: AWARD_ID,
        cohort_key: "marshall",
        member_kind: "canonical",
      }],
      identity_rules: [],
      awards: [{
        id: AWARD_ID,
        search_key: "marshall scholarship",
        name: "Marshall Scholarship",
        slug: "marshall-scholarship",
        official_homepage: "https://www.marshallscholarship.org/",
        summary: "Prior summary",
        public_facts: { overview: "Prior overview" },
        status: "active",
        updated_at: "2026-07-17T19:50:00.000Z",
      }],
      sources: [{
        id: SOURCE_ID,
        shared_award_id: AWARD_ID,
        url: "https://www.marshallscholarship.org/",
        title: "Marshall Scholarship",
        display_title: "Marshall Scholarship",
        page_description: "Official Marshall homepage",
        page_type: "homepage",
        admin_review_status: "open",
        last_checked_at: "2026-07-17T19:45:00.000Z",
        last_error: null,
        updated_at: "2026-07-17T19:45:00.000Z",
      }],
      visual_snapshots: [{
        shared_award_source_id: SOURCE_ID,
        shared_award_id: AWARD_ID,
        source_url: "https://www.marshallscholarship.org/",
        source_page_type: "homepage",
        kind: "webpage",
        bucket: "awardping-evidence",
        latest_captured_at: "2026-07-17T19:40:00.000Z",
        latest_object_keys: snapshotObjectKeys(),
        latest_hashes: { image_hash: HASH, text_hash: "b".repeat(64) },
        latest_metadata: {
          page_bytes: 1200,
          text_object_bytes: 240,
          text_length: 239,
        },
        updated_at: "2026-07-17T19:41:00.000Z",
      }],
      fact_candidates: [{
        id: CANDIDATE_ID,
        shared_award_id: AWARD_ID,
        shared_award_source_id: SOURCE_ID,
        source_url: "https://www.marshallscholarship.org/",
        source_title: "Marshall Scholarship",
        source_role: "primary",
        field_name: "overview",
        normalized_value: "Exact reviewed overview",
        evidence_quote: "Exact reviewed overview",
        evidence_location: "main content",
        extracted_at: "2026-07-17T19:40:00.000Z",
        model: "source-intake",
        confidence: "high",
        candidate_status: "pending",
        rejection_reason: null,
        selected_reason: null,
        source_page_request_id: null,
        intake_value_sha256: null,
        metadata: {
          stage1_immutable_evidence: immutableEvidence("Exact reviewed overview"),
          stage1_candidate_import: candidateImportMetadata(
            "Exact reviewed overview",
          ),
        },
        updated_at: "2026-07-17T19:42:00.000Z",
      }],
      active_queue: [],
    },
  };
}

function snapshotObjectKeys() {
  const prefix = `visual-snapshots/sources/${SOURCE_ID}/captures/${"e".repeat(32)}`;
  return {
    page: `${prefix}/page.jpg`,
    thumb: `${prefix}/thumb.jpg`,
    text: `${prefix}/text.txt`,
    meta: `${prefix}/meta.json`,
  };
}

function reviewedRoles() {
  return [
    "identity_home",
    "eligibility",
    "application_materials",
    "dates_cycle",
    "funding",
    "faq",
    "selection_interviews",
    "current_documents",
  ].map((sourceRole) => ({
    source_role: sourceRole,
    manifest_status: sourceRole === "identity_home" ? "present" : "not_published",
    official: true,
    supporting_text: sourceRole === "identity_home"
      ? "The exact official homepage supports the reviewed overview."
      : `The reviewed ${sourceRole} role is not separately published.`,
    cycle: "2027",
    sources: [{
      source_id: SOURCE_ID,
      source_url: "https://www.marshallscholarship.org/",
      official_identity: {
        host: "www.marshallscholarship.org",
        classification: "canonical_program_host",
        evidence_url: "https://www.marshallscholarship.org/",
        reviewed_reason: "Exact canonical Marshall program host.",
      },
      last_checked_at: "2026-07-17T19:45:00.000Z",
      snapshot: {
        captured_at: "2026-07-17T19:40:00.000Z",
        object_keys: snapshotObjectKeys(),
        hashes: { image_hash: HASH, text_hash: "b".repeat(64) },
        metadata: {
          page_bytes: 1200,
          text_object_bytes: 240,
          text_length: 239,
        },
      },
      r2: {
        verified_at: "2026-07-17T19:46:00.000Z",
        hashes: { image_hash: HASH, text_hash: "b".repeat(64) },
      },
      local: {
        verified_at: "2026-07-17T19:47:00.000Z",
        hashes: { image_hash: HASH, text_hash: "b".repeat(64) },
      },
    }],
    fact_candidate_ids: sourceRole === "identity_home" ? [CANDIDATE_ID] : [],
  }));
}

function orderedArrayFixture() {
  const fixture = validFixture();
  const cohort = fixture.selection.cohorts[0];
  cohort.public_facts = {
    overview: "Exact reviewed overview",
    application_materials: ["Transcript", "Two references"],
  };
  cohort.field_choices.push({
    field_name: "application_materials",
    composition_method: "ordered_array_items",
    candidate_ids: [OTHER_CANDIDATE_ID, THIRD_CANDIDATE_ID],
    candidate_evidence: [
      reviewedCandidateEvidence(OTHER_CANDIDATE_ID, "Transcript"),
      reviewedCandidateEvidence(THIRD_CANDIDATE_ID, "Two references"),
    ],
  });
  for (const role of cohort.roles) {
    if (role.source_role === "application_materials") {
      role.manifest_status = "present";
      role.fact_candidate_ids = [OTHER_CANDIDATE_ID, THIRD_CANDIDATE_ID];
    }
  }
  const first = fixture.database.fact_candidates[0];
  const arrayTemplate = {
    ...structuredClone(first),
    id: OTHER_CANDIDATE_ID,
    field_name: "application_materials",
    normalized_value: "Transcript",
    evidence_quote: "Transcript",
    intake_value_sha256: null,
    metadata: {
      stage1_immutable_evidence: immutableEvidence("Transcript"),
      stage1_candidate_import: candidateImportMetadata(
        "Transcript",
        "application-materials.transcript",
        { fieldName: "application_materials" },
      ),
    },
    updated_at: "2026-07-17T19:43:00.000Z",
  };
  fixture.database.fact_candidates.push(arrayTemplate, {
    ...structuredClone(arrayTemplate),
    id: THIRD_CANDIDATE_ID,
    source_role: "supporting",
    normalized_value: "Two references",
    evidence_quote: "Two references",
    intake_value_sha256: null,
    metadata: {
      stage1_immutable_evidence: immutableEvidence("Two references"),
      stage1_candidate_import: candidateImportMetadata(
        "Two references",
        "application-materials.references",
        {
          fieldName: "application_materials",
          sourceRelevance: "supporting",
        },
      ),
    },
    updated_at: "2026-07-17T19:44:00.000Z",
  });
  return fixture;
}

function reviewedCandidateEvidence(candidateId, evidenceQuote) {
  return {
    candidate_id: candidateId,
    source_id: SOURCE_ID,
    evidence_quote: evidenceQuote,
    evidence_location: "main content",
    capture_text_sha256: "b".repeat(64),
    capture_text_object_key: snapshotObjectKeys().text,
  };
}

function immutableEvidence(evidenceQuote) {
  return {
    schema_version: "awardping.stage1.candidate-immutable-evidence.v1",
    source_id: SOURCE_ID,
    capture_text_sha256: "b".repeat(64),
    capture_text_object_key: snapshotObjectKeys().text,
    evidence_quote_sha256: createHash("sha256")
      .update(evidenceQuote, "utf8")
      .digest("hex"),
    verification_method: "exact_local_text_substring",
  };
}

function candidateImportMetadata(
  evidenceQuote,
  itemKey = "overview.exact-reviewed-overview",
  {
    fieldName = "overview",
    normalizedValue = evidenceQuote,
    sourceRelevance = "primary",
  } = {},
) {
  const itemIdentity = {
    schema_version: "awardping.stage1.reviewed-candidate-import-item.v1",
    policy_version: "stage1-publication-v1",
    canonical_shared_award_id: AWARD_ID,
    source_id: SOURCE_ID,
    source_url: "https://www.marshallscholarship.org/",
    source_relevance: sourceRelevance,
    field_name: fieldName,
    normalized_value: normalizedValue,
    evidence_quote: evidenceQuote,
    evidence_location: "main content",
    capture_text_sha256: "b".repeat(64),
    capture_text_object_key: snapshotObjectKeys().text,
  };
  return {
    schema_version: "awardping.stage1.reviewed-candidate-import-item.v1",
    bundle_sha256: "9".repeat(64),
    item_sha256: sha256Canonical(itemIdentity),
    item_key: itemKey,
    reviewed_by: "operator@example.edu",
    reviewed_at: "2026-07-17T19:40:00.000Z",
    review_reason: "Exact local immutable text verified before candidate import.",
    paid_api_calls: 0,
  };
}

function reviewedCandidateImport(evidenceQuote) {
  const metadata = candidateImportMetadata(evidenceQuote);
  return {
    schema_version: metadata.schema_version,
    bundle_sha256: metadata.bundle_sha256,
    item_sha256: metadata.item_sha256,
  };
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).toSorted().map(
      (key) => [key, stableValue(value[key])],
    ));
  }
  return value ?? null;
}

function pendingQueue(plan) {
  return {
    id: QUEUE_ID,
    shared_award_id: AWARD_ID,
    reason: "explicit_human_review",
    source_ids: [SOURCE_ID],
    candidate_ids: [CANDIDATE_ID],
    status: "pending",
    priority: 1,
    generation: 4,
    created_at: "2026-07-17T19:53:00.000Z",
    started_at: null,
    completed_at: null,
    error: null,
    metadata: {
      processor: "reconcile-reviewed-stage1-selection",
      selection_mode: "explicit_human_review",
      selection_sha256: plan.selection_sha256,
      stage1_review_root_schema_version: "awardping.stage1.human-review-root.v1",
      stage1_review_root_sha256: plan.selection_sha256,
      reviewed_contributor_source_ids: [SOURCE_ID],
      reviewed_candidate_ids: [CANDIDATE_ID],
    },
  };
}
