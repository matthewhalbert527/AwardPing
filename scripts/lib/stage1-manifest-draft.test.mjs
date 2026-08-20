import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildStage1ManifestDraft,
  stage1ManifestDraftScope,
  validateStage1ImmutableCaptureBinding,
  validateStage1ImmutableObjectKeys,
} from "./stage1-manifest-draft.mjs";
import {
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
  normalizeStage1HumanReviewRoot,
  stage1HumanReviewRootSha256,
} from "./stage1-human-review-root.mjs";
import {
  buildStage1ReviewedPromotionPlan,
  promotionRpcArgs,
} from "./stage1-reviewed-promotion.mjs";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_COHORT_DEFINITION,
  STAGE1_POLICY_VERSION,
} from "./stage1-cohort-readiness.mjs";

const NOW = new Date("2026-07-17T19:00:00.000Z");
const AWARD_ID = "11111111-1111-4111-8111-111111111111";
const HOME_SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const APPLY_SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const MONITOR_SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const WRONG_AWARD_ID = "99999999-9999-4999-8999-999999999999";
const HOME_CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";
const APPLY_CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
const RECONCILIATION_ID = "66666666-6666-4666-8666-666666666666";
const PAGE_AUDIT_ID = "77777777-7777-4777-8777-777777777777";
const HOME_HASH = "a".repeat(64);
const APPLY_HASH = "b".repeat(64);
const PUBLIC_FACTS = {
  overview: "Exact reviewed overview",
  eligibility: "Exact reviewed eligibility",
};

describe("Stage 1 manifest-draft builder", () => {
  it("builds a promotion-compatible draft from explicit evidence and allows source reuse", () => {
    const fixture = validFixture();
    const draft = buildStage1ManifestDraft({ ...fixture, now: NOW });

    expect(draft.schema_version).toBe(1);
    expect(draft.cohorts).toHaveLength(1);
    expect(draft.cohorts[0].manifests.map((entry) => entry.source_role))
      .toEqual(REQUIRED_SOURCE_ROLES);
    expect(draft.cohorts[0].manifests.filter((entry) =>
      entry.source_ids.includes(APPLY_SOURCE_ID))).toHaveLength(7);
    expect(draft.cohorts[0].manifests.at(-1)).toMatchObject({
      source_role: "current_documents",
      manifest_status: "not_published",
      source_ids: [APPLY_SOURCE_ID],
      evidence: {
        fact_candidate_ids: [],
        official: true,
        reconciliation_status: "not_applicable",
      },
    });
    expect(draft.draft_review).toMatchObject({
      target_mode: "single_exact_cohort",
      policy_version: STAGE1_POLICY_VERSION,
      stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
      safety: {
        ranked_candidates_auto_accepted: false,
        remote_mutations: 0,
        paid_api_calls: 0,
      },
    });
    expect(draft.draft_review.confirmation_sha256).toMatch(/^[0-9a-f]{64}$/);

    const promotionPlan = buildStage1ReviewedPromotionPlan({
      targetCohortKeys: ["marshall"],
      reviewRows: [{
        cohort_key: "marshall",
        review_hash: "c".repeat(64),
        snapshot: { cohort_key: "marshall", manifests: [] },
      }],
      manifestDocument: draft,
      actor: "operator@example.edu",
      reason: "review generated manifest in separate dry run",
    });
    expect(promotionPlan.manifest_entries).toHaveLength(8);
    expect(promotionRpcArgs(promotionPlan)).not.toHaveProperty("draft_review");
  });

  it("keeps a distinct reviewed monitor-only source outside reconciliation fact provenance", () => {
    const fixture = validFixture();
    addMonitorOnlyCurrentDocumentsSource(fixture);

    const draft = build(fixture);

    expect(draft.cohorts[0].manifests.at(-1)).toMatchObject({
      source_role: "current_documents",
      manifest_status: "not_published",
      source_ids: [MONITOR_SOURCE_ID],
      evidence: { fact_candidate_ids: [] },
    });
    expect(draft.draft_review.evidence[0]).toMatchObject({
      review_source_count: 3,
      contributor_source_count: 2,
      selected_candidate_count: 2,
    });
    expect(fixture.database.reconciliations[0].source_ids)
      .toEqual([HOME_SOURCE_ID, APPLY_SOURCE_ID]);
    expect(stage1ManifestDraftScope(fixture.mapping, NOW).source_ids)
      .toContain(MONITOR_SOURCE_ID);
  });

  it("rejects extra, missing, or wrong-owner reconciliation/manifest source identities", () => {
    const extra = validFixture();
    addMonitorOnlyCurrentDocumentsSource(extra);
    extra.database.reconciliations[0].source_ids.push(MONITOR_SOURCE_ID);
    expect(() => build(extra)).toThrow(/persisted human-review root/i);

    const missing = validFixture();
    missing.database.reconciliations[0].source_ids = [HOME_SOURCE_ID];
    expect(() => build(missing)).toThrow(/persisted human-review root/i);

    const wrongOwner = validFixture();
    addMonitorOnlyCurrentDocumentsSource(wrongOwner, WRONG_AWARD_ID);
    expect(() => build(wrongOwner)).toThrow(/does not belong to this exact cohort/i);
  });

  it("is deterministic when input object, role, and database row order changes", () => {
    const first = validFixture();
    const second = structuredClone(first);
    second.mapping.cohorts[0].roles.reverse();
    for (const key of Object.keys(second.database)) second.database[key].reverse();

    const one = buildStage1ManifestDraft({ ...first, now: NOW });
    const two = buildStage1ManifestDraft({ ...second, now: NOW });
    expect(two).toEqual(one);
  });

  it("returns only the explicit query scope and never invents ranked candidates", () => {
    const { mapping } = validFixture();
    expect(stage1ManifestDraftScope(mapping, NOW)).toEqual({
      cohort_keys: ["marshall"],
      canonical_award_ids: [AWARD_ID],
      source_ids: [HOME_SOURCE_ID, APPLY_SOURCE_ID].toSorted(),
      candidate_ids: [HOME_CANDIDATE_ID, APPLY_CANDIDATE_ID].toSorted(),
    });
  });

  it("accepts all exact national 25 for query scope and rejects every partial 2-24 set", () => {
    const { mapping } = validFixture();
    const template = mapping.cohorts[0];
    mapping.cohorts = STAGE1_COHORT_DEFINITION.map((definition) => ({
      ...structuredClone(template),
      cohort_key: definition.cohortKey,
      canonical_award: {
        ...structuredClone(template.canonical_award),
        search_key: definition.canonicalSearchKey,
        name: definition.canonicalName,
        official_homepage: definition.officialHomepage,
      },
      roles: template.roles.map((role) => ({
        ...structuredClone(role),
        sources: role.sources.map((source) => ({
          ...structuredClone(source),
          source_url: definition.officialHomepage,
          official_identity: {
            host: new URL(definition.officialHomepage).hostname.toLowerCase(),
            classification: "canonical_program_host",
            evidence_url: definition.officialHomepage,
            reviewed_reason: "Exact canonical program host for query-scope validation.",
          },
        })),
      })),
    }));
    expect(stage1ManifestDraftScope(mapping, NOW).cohort_keys)
      .toEqual(STAGE1_COHORT_DEFINITION.map((entry) => entry.cohortKey));

    mapping.cohorts.pop();
    expect(() => stage1ManifestDraftScope(mapping, NOW))
      .toThrow(/one cohort or the exact national 25/i);
  });

  it("rejects partial cohorts, missing roles, duplicate roles, and policy drift", () => {
    const partial = validFixture();
    partial.mapping.cohorts.push(structuredClone(partial.mapping.cohorts[0]));
    partial.mapping.cohorts[1].cohort_key = "rhodes_us";
    expect(() => build(partial)).toThrow(/one cohort or the exact national 25/i);

    const missing = validFixture();
    missing.mapping.cohorts[0].roles.pop();
    expect(() => build(missing)).toThrow(/exactly 8 source roles/i);

    const duplicate = validFixture();
    duplicate.mapping.cohorts[0].roles[1].source_role = "identity_home";
    expect(() => build(duplicate)).toThrow(/each required source role must appear exactly once/i);

    const policy = validFixture();
    policy.mapping.policy_version = "obsolete-policy";
    expect(() => build(policy)).toThrow(/policy_version/i);
  });

  it("requires explicit human review and never permits ranked auto-accept", () => {
    const method = validFixture();
    method.mapping.review.selection_method = "ranked_candidate";
    expect(() => build(method)).toThrow(/explicit_human_review/i);

    const accepted = validFixture();
    accepted.mapping.review.auto_accept_ranked_candidates = true;
    expect(() => build(accepted)).toThrow(/must be false/i);
  });

  it("requires identity_home to bind one exact registry homepage source", () => {
    const fixture = validFixture();
    fixture.mapping.cohorts[0].roles[0].sources[0].source_url += "about/";
    expect(() => build(fixture)).toThrow(/identity_home must exactly match|URL.*does not match/i);
  });

  it("requires not_published evidence to retain an official source, supporting text, and no candidates", () => {
    const withCandidate = validFixture();
    withCandidate.mapping.cohorts[0].roles.at(-1).fact_candidate_ids = [APPLY_CANDIDATE_ID];
    expect(() => build(withCandidate)).toThrow(/not_published.*zero candidates/i);

    const noText = validFixture();
    noText.mapping.cohorts[0].roles.at(-1).supporting_text = " ";
    expect(() => build(noText)).toThrow(/supporting_text is required/i);

    const noSource = validFixture();
    noSource.mapping.cohorts[0].roles.at(-1).sources = [];
    expect(() => build(noSource)).toThrow(/official source is required/i);
  });

  it("rejects non-HTTPS, non-official, closed, errored, stale, or cross-cohort sources", () => {
    const http = validFixture();
    http.mapping.cohorts[0].roles[1].sources[0].source_url = "http://www.marshallscholarship.org/apply/";
    expect(() => build(http)).toThrow(/HTTPS URL/i);

    const unofficial = validFixture();
    unofficial.mapping.cohorts[0].roles[1].official = false;
    expect(() => build(unofficial)).toThrow(/official must be true/i);

    const closed = validFixture();
    closed.database.sources[1].admin_review_status = "rejected";
    expect(() => build(closed)).toThrow(/URL, status, HTTPS, freshness, or error state/i);

    const errored = validFixture();
    errored.database.sources[1].last_error = "capture failed";
    expect(() => build(errored)).toThrow(/URL, status, HTTPS, freshness, or error state/i);

    const stale = validFixture();
    stale.mapping.cohorts[0].roles[1].sources[0].last_checked_at = "2026-07-15T18:30:00.000Z";
    expect(() => build(stale)).toThrow(/within 24 hours/i);

    const wrongAward = validFixture();
    wrongAward.database.sources[1].shared_award_id = "88888888-8888-4888-8888-888888888888";
    expect(() => build(wrongAward)).toThrow(/does not belong to this exact cohort/i);

    const externalHost = validFixture();
    for (const role of externalHost.mapping.cohorts[0].roles.slice(1)) {
      role.sources[0].source_url = "https://unrelated.example/apply/";
    }
    externalHost.database.sources[1].url = "https://unrelated.example/apply/";
    externalHost.database.visual_snapshots[1].source_url = "https://unrelated.example/apply/";
    externalHost.database.fact_candidates[1].source_url = "https://unrelated.example/apply/";
    expect(() => build(externalHost)).toThrow(/official_identity host must exactly match/i);
  });

  it("requires the human review to occur after every bound evidence event", () => {
    const fixture = validFixture();
    fixture.mapping.review.reviewed_at = "2026-07-17T18:39:00.000Z";
    expect(() => build(fixture)).toThrow(/review predates source evidence/i);
  });

  it("applies cohort identity exclusion rules to mapped sources", () => {
    const fixture = validFixture();
    fixture.database.identity_rules.push({
      id: 1,
      cohort_key: "marshall",
      rule_key: "exclude_wrong_path",
      url_pattern: "apply",
      title_pattern: null,
      reason: "test exclusion",
      policy_version: STAGE1_POLICY_VERSION,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
    });
    expect(() => build(fixture)).toThrow(/fails the cohort identity rules/i);
  });

  it("binds exact latest DB object keys and hashes to supplied R2 and local checks", () => {
    const dbHash = validFixture();
    dbHash.database.visual_snapshots[1].latest_hashes.image_hash = "d".repeat(64);
    expect(() => build(dbHash)).toThrow(/exact latest database, R2, and local snapshot identity/i);

    const objectKey = validFixture();
    objectKey.database.visual_snapshots[1].latest_object_keys.page = "different-key.png";
    expect(() => build(objectKey)).toThrow(/invalid generation path|exact latest database/i);

    const metadata = validFixture();
    metadata.database.visual_snapshots[1].latest_metadata.page_bytes = 101;
    expect(() => build(metadata)).toThrow(/exact latest database, R2, and local snapshot identity/i);

    const r2Hash = validFixture();
    r2Hash.mapping.cohorts[0].roles[1].sources[0].r2.hashes.image_hash = "d".repeat(64);
    expect(() => build(r2Hash)).toThrow(/R2 hashes do not match/i);

    const beforeCapture = validFixture();
    beforeCapture.mapping.cohorts[0].roles[1].sources[0].local.verified_at = "2026-07-17T18:29:00.000Z";
    expect(() => build(beforeCapture)).toThrow(/verification predates/i);
  });

  it("requires one complete immutable source generation for every object-key set", () => {
    const generation = "a".repeat(32);
    const prefix = `visual-snapshots/sources/${APPLY_SOURCE_ID}/captures/${generation}`;
    const webpage = {
      page: `${prefix}/page.jpg`,
      thumb: `${prefix}/thumb.jpg`,
      text: `${prefix}/text.txt`,
      meta: `${prefix}/meta.json`,
      layout: `${prefix}/layout.json`,
      expansion_state_01: `${prefix}/expansion-state-01.jpg`,
      expansion_state_01_layout: `${prefix}/expansion-state-01-layout.json`,
    };
    expect(validateStage1ImmutableObjectKeys({
      sourceId: APPLY_SOURCE_ID,
      objectKeys: webpage,
    })).toMatchObject({ kind: "webpage", family: "captures", generation });

    const pdf = {
      pdf: `${prefix}/document.pdf`,
      text: `${prefix}/text.txt`,
      meta: `${prefix}/meta.json`,
    };
    expect(validateStage1ImmutableObjectKeys({
      sourceId: APPLY_SOURCE_ID,
      objectKeys: pdf,
    })).toMatchObject({ kind: "pdf" });

    const cases = [
      [{
        page: `visual-snapshots/sources/${APPLY_SOURCE_ID}/latest/page.jpg`,
        thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`, meta: `${prefix}/meta.json`,
      }, /mutable|generation path/i],
      [{
        page: `visual-snapshots/sources/${APPLY_SOURCE_ID}/approved/${generation}/page.jpg`,
        thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`, meta: `${prefix}/meta.json`,
      }, /invalid generation path/i],
      [{
        page: `visual-snapshots/sources/${APPLY_SOURCE_ID}/captures/${"A".repeat(32)}/page.jpg`,
        thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`, meta: `${prefix}/meta.json`,
      }, /invalid 32-hex generation/i],
      [{
        page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`,
        text: `visual-snapshots/sources/${HOME_SOURCE_ID}/captures/${generation}/text.txt`,
        meta: `${prefix}/meta.json`,
      }, /another source/i],
      [{
        page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`,
        text: `visual-snapshots/sources/${APPLY_SOURCE_ID}/captures/${"b".repeat(32)}/text.txt`,
        meta: `${prefix}/meta.json`,
      }, /mix 32-hex generation/i],
      [{ page: `${prefix}/page.png`, thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`, meta: `${prefix}/meta.json` }, /wrong filename/i],
      [{ page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`, text: `${prefix}/page.jpg`, meta: `${prefix}/meta.json` }, /alias multiple slots/i],
      [{ page: `${prefix}/page.jpg`, text: `${prefix}/text.txt` }, /missing core slots/i],
      [{ pdf: `${prefix}/document.pdf`, text: `${prefix}/text.txt` }, /missing core slots/i],
      [{
        page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`, pdf: `${prefix}/document.pdf`,
        text: `${prefix}/text.txt`, meta: `${prefix}/meta.json`,
      }, /exactly one webpage or PDF/i],
      [{
        page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`, unexpected: `${prefix}/unexpected.bin`,
      }, /unknown slot/i],
      [{
        page: `${prefix}/page.jpg`, thumb: `${prefix}/thumb.jpg`, text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`, expansion_state_01: `${prefix}/expansion-state-01.jpg`,
      }, /missing its layout pair/i],
      [{
        pdf: `${prefix}/document.pdf`, text: `${prefix}/text.txt`, meta: `${prefix}/meta.json`,
        layout: `${prefix}/layout.json`,
      }, /forbidden webpage slots/i],
    ];
    for (const [objectKeys, error] of cases) {
      expect(() => validateStage1ImmutableObjectKeys({
        sourceId: APPLY_SOURCE_ID,
        objectKeys,
      })).toThrow(error);
    }
  });

  it("mirrors the durable SQL hash and metadata capture-binding contract", () => {
    const generation = "a".repeat(32);
    const prefix = `visual-snapshots/sources/${APPLY_SOURCE_ID}/captures/${generation}`;
    const webpage = {
      sourceId: APPLY_SOURCE_ID,
      kind: "webpage",
      objectKeys: {
        page: `${prefix}/page.jpg`,
        thumb: `${prefix}/thumb.jpg`,
        text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`,
      },
      hashes: { image_hash: "b".repeat(64), text_hash: "c".repeat(64) },
      metadata: { page_bytes: "100", text_object_bytes: 20, text_length: 19 },
    };
    expect(validateStage1ImmutableCaptureBinding(webpage)).toMatchObject({
      kind: "webpage",
      hashes: webpage.hashes,
      metadata: webpage.metadata,
    });

    const pdf = {
      sourceId: APPLY_SOURCE_ID,
      kind: "pdf",
      objectKeys: {
        pdf: `${prefix}/document.pdf`,
        text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`,
      },
      hashes: { file_hash: "d".repeat(64), text_hash: "e".repeat(64) },
      metadata: { file_bytes: 100, text_object_bytes: "20", text_length: "0" },
    };
    expect(validateStage1ImmutableCaptureBinding(pdf)).toMatchObject({ kind: "pdf" });

    for (const [mutate, error] of [
      [(value) => { value.kind = "pdf"; }, /kind conflicts/i],
      [(value) => { value.hashes.image_hash = "B".repeat(64); }, /lowercase image_hash/i],
      [(value) => { delete value.hashes.text_hash; }, /text_hash/i],
      [(value) => { value.metadata.page_bytes = "0"; }, /positive page_bytes/i],
      [(value) => { value.metadata.text_object_bytes = 0; }, /positive text_object_bytes/i],
      [(value) => { value.metadata.text_length = -1; }, /non-negative text_length/i],
    ]) {
      const invalid = structuredClone(webpage);
      mutate(invalid);
      expect(() => validateStage1ImmutableCaptureBinding(invalid)).toThrow(error);
    }
  });

  it("rejects missing, unselected, unquoted, source-mismatched, or legacy generic-quote candidates", () => {
    const missing = validFixture();
    missing.database.fact_candidates.pop();
    expect(() => build(missing)).toThrow(/candidate .* absent/i);

    const pending = validFixture();
    pending.database.fact_candidates[1].candidate_status = "pending";
    expect(() => build(pending)).toThrow(/not exact selected/i);

    const unquoted = validFixture();
    unquoted.database.fact_candidates[1].evidence_quote = null;
    expect(() => build(unquoted)).toThrow(/not exact selected/i);

    const sourceMismatch = validFixture();
    sourceMismatch.database.fact_candidates[1].shared_award_source_id = HOME_SOURCE_ID;
    expect(() => build(sourceMismatch)).toThrow(/not exact selected/i);

    const legacyGenericQuote = validFixture();
    delete legacyGenericQuote.database.fact_candidates[1].metadata.stage1_immutable_evidence;
    expect(() => build(legacyGenericQuote)).toThrow(/does not bind the reviewed public value/i);
  });

  it("requires the explicitly bound reconciliation to be latest, fresh, successful, and exact", () => {
    const failed = validFixture();
    failed.database.reconciliations[0].status = "failed";
    expect(() => build(failed)).toThrow(/fresh exact success/i);

    const incomplete = validFixture();
    incomplete.database.reconciliations[0].candidate_ids.pop();
    expect(() => build(incomplete)).toThrow(/fresh exact success/i);

    const superseded = validFixture();
    superseded.database.reconciliations.push({
      ...structuredClone(superseded.database.reconciliations[0]),
      id: "99999999-9999-4999-8999-999999999999",
      created_at: "2026-07-17T18:59:00.000Z",
      metadata: {
        ...structuredClone(superseded.database.reconciliations[0].metadata),
        stage1_review_root_sha256: "d".repeat(64),
      },
    });
    expect(() => build(superseded)).toThrow(/persisted human-review root/i);
  });

  it("requires the mapped page audit to be the latest fresh deterministic exact pass", () => {
    const failed = validFixture();
    failed.database.page_audits[0].audit_status = "failed";
    expect(() => build(failed)).toThrow(/fresh exact proof/i);

    const wrongFacts = validFixture();
    wrongFacts.database.page_audits[0].public_page_snapshot.overview = "drifted";
    expect(() => build(wrongFacts)).toThrow(/fresh exact proof/i);

    const superseded = validFixture();
    superseded.database.page_audits.push({
      ...structuredClone(superseded.database.page_audits[0]),
      id: "99999999-9999-4999-8999-999999999999",
      created_at: "2026-07-17T18:59:00.000Z",
      selected_fact_summary: {
        ...structuredClone(superseded.database.page_audits[0].selected_fact_summary),
        stage1_review_root_sha256: "d".repeat(64),
      },
    });
    expect(() => build(superseded)).toThrow(/fresh exact proof/i);
  });

  it("rejects unresolved blocking audits anywhere in the cohort", () => {
    const fixture = validFixture();
    fixture.database.page_audits.push({
      ...structuredClone(fixture.database.page_audits[0]),
      id: "99999999-9999-4999-8999-999999999999",
      audit_kind: "manual",
      audit_status: "needs_review",
      severity: "error",
      created_at: "2026-07-17T18:56:00.000Z",
      resolved_at: null,
    });
    expect(() => build(fixture)).toThrow(/unresolved blocking page-audit/i);
  });

  it("requires every reviewed public fact to have an explicit field choice", () => {
    const fixture = validFixture();
    fixture.mapping.cohorts[0].public_facts.deadline = "October 1";
    expect(() => build(fixture)).toThrow(/field choices must exactly cover/i);
  });
});

function build(fixture) {
  return buildStage1ManifestDraft({ ...fixture, now: NOW });
}

function validFixture() {
  const homeSource = mappedSource({
    sourceId: HOME_SOURCE_ID,
    url: "https://www.marshallscholarship.org/",
    hash: HOME_HASH,
    key: "marshall/home/latest.png",
  });
  const applySource = mappedSource({
    sourceId: APPLY_SOURCE_ID,
    url: "https://www.marshallscholarship.org/apply/eligibility/",
    hash: APPLY_HASH,
    key: "marshall/apply/latest.png",
  });
  const roles = REQUIRED_SOURCE_ROLES.map((sourceRole) => ({
    source_role: sourceRole,
    manifest_status: new Set(["identity_home", "eligibility"]).has(sourceRole)
      ? "present"
      : "not_published",
    official: true,
    supporting_text: new Set(["identity_home", "eligibility"]).has(sourceRole)
      ? `Human-reviewed ${sourceRole} evidence.`
      : `The reviewed official page does not separately publish ${sourceRole}; no substitute was used.`,
    cycle: "2027",
    sources: [structuredClone(sourceRole === "identity_home" ? homeSource : applySource)],
    fact_candidate_ids: sourceRole === "identity_home"
      ? [HOME_CANDIDATE_ID]
      : sourceRole === "eligibility"
        ? [APPLY_CANDIDATE_ID]
        : [],
  }));
  const fixture = {
    mapping: {
      schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
      policy_version: STAGE1_POLICY_VERSION,
      review: {
        reviewed_by: "operator@example.edu",
        reviewed_at: "2026-07-17T18:58:00.000Z",
        reason: "Explicit human review of exact Stage 1 sources and candidates.",
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
        public_facts: structuredClone(PUBLIC_FACTS),
        field_choices: [
          {
            field_name: "overview",
            composition_method: "direct_exact",
            candidate_ids: [HOME_CANDIDATE_ID],
            candidate_evidence: [reviewedCandidateEvidence(
              HOME_CANDIDATE_ID,
              HOME_SOURCE_ID,
              homeSource,
              PUBLIC_FACTS.overview,
            )],
          },
          {
            field_name: "eligibility",
            composition_method: "direct_exact",
            candidate_ids: [APPLY_CANDIDATE_ID],
            candidate_evidence: [reviewedCandidateEvidence(
              APPLY_CANDIDATE_ID,
              APPLY_SOURCE_ID,
              applySource,
              PUBLIC_FACTS.eligibility,
            )],
          },
        ],
        roles,
      }],
    },
    database: {
      registry: [{
        cohort_key: "marshall",
        launch_rank: 2,
        canonical_name: "Marshall Scholarship",
        canonical_shared_award_id: AWARD_ID,
        canonical_slug: "marshall-scholarship",
        official_homepage: "https://www.marshallscholarship.org/",
        publication_state: "pending",
        policy_version: STAGE1_POLICY_VERSION,
        created_at: "2026-07-16T00:00:00.000Z",
        updated_at: "2026-07-17T18:55:00.000Z",
      }],
      members: [{
        shared_award_id: AWARD_ID,
        cohort_key: "marshall",
        member_kind: "canonical",
        reason: "exact canonical identity",
        created_at: "2026-07-16T00:00:00.000Z",
        updated_at: "2026-07-16T00:00:00.000Z",
      }],
      identity_rules: [],
      awards: [{
        id: AWARD_ID,
        search_key: "marshall scholarship",
        name: "Marshall Scholarship",
        slug: "marshall-scholarship",
        official_homepage: "https://www.marshallscholarship.org/",
        public_facts: {
          ...structuredClone(PUBLIC_FACTS),
          source_titles: { internal_only: "not a published field" },
        },
        status: "active",
        created_at: "2026-07-16T00:00:00.000Z",
        updated_at: "2026-07-17T18:55:00.000Z",
      }],
      sources: [
        databaseSource(HOME_SOURCE_ID, homeSource.source_url, "Official Marshall home"),
        databaseSource(APPLY_SOURCE_ID, applySource.source_url, "Official Marshall Apply"),
      ],
      visual_snapshots: [
        databaseSnapshot(HOME_SOURCE_ID, homeSource, HOME_HASH),
        databaseSnapshot(APPLY_SOURCE_ID, applySource, APPLY_HASH),
      ],
      fact_candidates: [
        databaseCandidate(
          HOME_CANDIDATE_ID,
          HOME_SOURCE_ID,
          homeSource.source_url,
          "primary",
          "overview",
          PUBLIC_FACTS.overview,
        ),
        databaseCandidate(
          APPLY_CANDIDATE_ID,
          APPLY_SOURCE_ID,
          applySource.source_url,
          "supporting",
          "eligibility",
          PUBLIC_FACTS.eligibility,
        ),
      ],
      reconciliations: [{
        id: RECONCILIATION_ID,
        shared_award_id: AWARD_ID,
        reason: "explicit_human_review",
        source_ids: [HOME_SOURCE_ID, APPLY_SOURCE_ID],
        candidate_ids: [HOME_CANDIDATE_ID, APPLY_CANDIDATE_ID],
        status: "succeeded",
        priority: 1,
        created_at: "2026-07-17T18:45:00.000Z",
        started_at: "2026-07-17T18:46:00.000Z",
        completed_at: "2026-07-17T18:50:00.000Z",
        error: null,
        metadata: {},
      }],
      page_audits: [{
        id: PAGE_AUDIT_ID,
        shared_award_id: AWARD_ID,
        audit_kind: "deterministic",
        audit_status: "passed",
        severity: "info",
        findings: [],
        suggested_fixes: [],
        field_conflicts: [],
        source_rejections: [],
        selected_fact_summary: {},
        public_page_snapshot: {},
        model: "explicit-human-reviewed-stage1-reconciliation",
        created_at: "2026-07-17T18:55:00.000Z",
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      }],
      persisted_review_roots: [],
    },
  };
  bindPostCommitProof(fixture);
  return fixture;
}

function addMonitorOnlyCurrentDocumentsSource(fixture, ownerAwardId = AWARD_ID) {
  const monitorSource = mappedSource({
    sourceId: MONITOR_SOURCE_ID,
    url: "https://www.marshallscholarship.org/apply/documents/",
    hash: "d".repeat(64),
    key: "marshall/documents/latest.png",
  });
  fixture.mapping.cohorts[0].roles.at(-1).sources = [structuredClone(monitorSource)];
  fixture.database.sources.push({
    ...databaseSource(
      MONITOR_SOURCE_ID,
      monitorSource.source_url,
      "Official Marshall document monitor",
    ),
    shared_award_id: ownerAwardId,
  });
  fixture.database.visual_snapshots.push(
    databaseSnapshot(MONITOR_SOURCE_ID, monitorSource, "d".repeat(64)),
  );
  bindPostCommitProof(fixture);
}

function mappedSource({ sourceId, url, hash }) {
  const prefix = `visual-snapshots/sources/${sourceId}/captures/${hash.slice(0, 32)}`;
  const hashes = { image_hash: hash, text_hash: hash };
  return {
    source_id: sourceId,
    source_url: url,
    official_identity: {
      host: "www.marshallscholarship.org",
      classification: "canonical_program_host",
      evidence_url: "https://www.marshallscholarship.org/",
      reviewed_reason: "The source is hosted on the exact canonical program domain.",
    },
    last_checked_at: "2026-07-17T18:30:00.000Z",
    snapshot: {
      captured_at: "2026-07-17T18:35:00.000Z",
      object_keys: {
        page: `${prefix}/page.jpg`,
        thumb: `${prefix}/thumb.jpg`,
        text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`,
      },
      hashes,
      metadata: {
        page_bytes: 100,
        text_object_bytes: 20,
        text_length: 19,
      },
    },
    r2: {
      verified_at: "2026-07-17T18:40:00.000Z",
      hashes: structuredClone(hashes),
    },
    local: {
      verified_at: "2026-07-17T18:41:00.000Z",
      hashes: structuredClone(hashes),
    },
  };
}

function databaseSource(id, url, title) {
  return {
    id,
    shared_award_id: AWARD_ID,
    url,
    title,
    display_title: title,
    page_description: "Official Marshall program source",
    page_type: "application",
    admin_review_status: "open",
    last_checked_at: "2026-07-17T18:30:00.000Z",
    last_error: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-17T18:30:00.000Z",
  };
}

function databaseSnapshot(sourceId, mapped, hash) {
  return {
    shared_award_source_id: sourceId,
    shared_award_id: AWARD_ID,
    source_url: mapped.source_url,
    source_title: "Official source",
    source_page_type: "application",
    kind: "webpage",
    bucket: "awardping-evidence",
    latest_captured_at: mapped.snapshot.captured_at,
    latest_object_keys: structuredClone(mapped.snapshot.object_keys),
    latest_hashes: { image_hash: hash, text_hash: hash },
    latest_metadata: structuredClone(mapped.snapshot.metadata),
    previous_captured_at: null,
    previous_object_keys: {},
    previous_hashes: {},
    previous_metadata: {},
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-17T18:35:00.000Z",
  };
}

function databaseCandidate(id, sourceId, sourceUrl, sourceRole, fieldName, value) {
  const mapped = sourceId === HOME_SOURCE_ID
    ? mappedSource({ sourceId, url: sourceUrl, hash: HOME_HASH })
    : mappedSource({ sourceId, url: sourceUrl, hash: APPLY_HASH });
  const evidence = reviewedCandidateEvidence(id, sourceId, mapped, value);
  return {
    id,
    shared_award_id: AWARD_ID,
    shared_award_source_id: sourceId,
    source_url: sourceUrl,
    source_title: "Official source",
    source_role: sourceRole,
    source_quality_decision: {},
    field_name: fieldName,
    raw_value: value,
    normalized_value: value,
    evidence_quote: value,
    evidence_location: "main content",
    extracted_at: "2026-07-17T18:35:00.000Z",
    model: "deterministic",
    confidence: "high",
    candidate_status: "selected",
    rejection_reason: null,
    selected_reason: "operator-reviewed exact evidence",
    intake_value_sha256: createHash("sha256").update(value).digest("hex"),
    metadata: {
      stage1_immutable_evidence: {
        schema_version: "awardping.stage1.candidate-immutable-evidence.v1",
        source_id: sourceId,
        capture_text_sha256: evidence.capture_text_sha256,
        capture_text_object_key: evidence.capture_text_object_key,
        evidence_quote_sha256: createHash("sha256")
          .update(evidence.evidence_quote, "utf8")
          .digest("hex"),
        verification_method: "exact_local_text_substring",
      },
    },
    created_at: "2026-07-17T18:36:00.000Z",
    updated_at: "2026-07-17T18:50:00.000Z",
  };
}

function reviewedCandidateEvidence(candidateId, sourceId, mapped, value) {
  return {
    candidate_id: candidateId,
    source_id: sourceId,
    evidence_quote: value,
    evidence_location: "main content",
    capture_text_sha256: mapped.snapshot.hashes.text_hash,
    capture_text_object_key: mapped.snapshot.object_keys.text,
  };
}

function bindPostCommitProof(fixture) {
  const rootHash = stage1HumanReviewRootSha256(fixture.mapping, NOW);
  const normalizedRoot = normalizeStage1HumanReviewRoot(fixture.mapping, NOW);
  const reviewSourceIds = [...new Set(fixture.mapping.cohorts[0].roles.flatMap(
    (role) => role.sources.map((source) => source.source_id),
  ))].toSorted();
  const reconciliation = fixture.database.reconciliations[0];
  reconciliation.metadata = {
    processor: "reconcile-reviewed-stage1-selection",
    selection_mode: "explicit_human_review",
    selection_sha256: rootHash,
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: rootHash,
    review_source_ids: reviewSourceIds,
    reviewed_contributor_source_ids: [HOME_SOURCE_ID, APPLY_SOURCE_ID],
    reviewed_candidate_ids: [HOME_CANDIDATE_ID, APPLY_CANDIDATE_ID],
    paid_api_calls: 0,
    ranked_candidates_accepted: 0,
    monitoring_sources_retired: 0,
  };
  const audit = fixture.database.page_audits[0];
  audit.selected_fact_summary = {
    overview: [HOME_CANDIDATE_ID],
    eligibility: [APPLY_CANDIDATE_ID],
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: rootHash,
  };
  audit.public_page_snapshot = {
    ...structuredClone(PUBLIC_FACTS),
    reconciliation_audit_signature: "c".repeat(64),
    stage1_review_root_schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    stage1_review_root_sha256: rootHash,
  };
  fixture.database.persisted_review_roots = [{
    schema_version: "awardping.stage1.human-review-root-retrieval.v1",
    root_sha256: rootHash,
    recomputed_sha256: rootHash,
    hash_matches: true,
    cohort_key: "marshall",
    canonical_shared_award_id: AWARD_ID,
    reviewed_at: fixture.mapping.review.reviewed_at,
    created_at: "2026-07-17T18:51:00.000Z",
    review_root: normalizedRoot,
  }];
}
