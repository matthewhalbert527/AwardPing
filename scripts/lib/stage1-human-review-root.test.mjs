import { describe, expect, it } from "vitest";
import { REQUIRED_SOURCE_ROLES, STAGE1_POLICY_VERSION } from "./stage1-cohort-readiness.mjs";
import {
  normalizeStage1HumanReviewRoot,
  stableStage1HumanReviewJson,
  STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
  stage1HumanReviewRootScope,
  stage1HumanReviewRootSha256,
} from "./stage1-human-review-root.mjs";

const NOW = new Date("2026-07-17T19:00:00.000Z");
const AWARD_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";
const ARRAY_CANDIDATE_A = "44444444-4444-4444-8444-444444444444";
const ARRAY_CANDIDATE_B = "55555555-5555-4555-8555-555555555555";

describe("Stage 1 pre-commit human-review root", () => {
  it("normalizes and hashes only explicit human choices without generated IDs", () => {
    const root = fixture();
    const normalized = normalizeStage1HumanReviewRoot(root, NOW);
    expect(normalized.schema_version).toBe(STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION);
    expect(normalized.cohorts[0]).not.toHaveProperty("reconciliation");
    expect(normalized.cohorts[0]).not.toHaveProperty("page_audit");
    expect(normalized.cohorts[0].field_choices).toEqual([{
      field_name: "overview",
      composition_method: "direct_exact",
      candidate_ids: [CANDIDATE_ID],
      candidate_evidence: [expect.objectContaining({
        candidate_id: CANDIDATE_ID,
        source_id: SOURCE_ID,
      })],
    }]);
    expect(normalized.cohorts[0].publication).toEqual({
      summary: "Exact reviewed overview. Baseline detail confidence: medium.",
      confidence: 0.5,
    });
    expect(stage1HumanReviewRootSha256(root, NOW)).toMatch(/^[0-9a-f]{64}$/);
    expect(stage1HumanReviewRootScope(root, NOW)).toEqual({
      cohort_keys: ["marshall"],
      canonical_award_ids: [AWARD_ID],
      source_ids: [SOURCE_ID],
      candidate_ids: [CANDIDATE_ID],
    });
  });

  it("is idempotent after adding deterministic publication and snapshot fields", () => {
    const root = fixture();
    const normalized = normalizeStage1HumanReviewRoot(root, NOW);

    expect(normalizeStage1HumanReviewRoot(normalized, NOW)).toEqual(normalized);
    expect(stage1HumanReviewRootSha256(normalized, NOW))
      .toBe(stage1HumanReviewRootSha256(root, NOW));

    normalized.cohorts[0].roles[0].sources[0].snapshot.kind = "pdf";
    expect(() => normalizeStage1HumanReviewRoot(normalized, NOW))
      .toThrow(/snapshot kind conflicts/i);
  });

  it("keeps immutable evidence durable while rejecting future evidence", () => {
    const durable = fixture();
    durable.cohorts[0].roles.forEach((role) => role.sources.forEach((source) => {
      source.snapshot.captured_at = "2025-01-01T00:00:00.000Z";
      source.r2.verified_at = "2025-01-01T00:01:00.000Z";
      source.local.verified_at = "2025-01-01T00:02:00.000Z";
    }));
    expect(normalizeStage1HumanReviewRoot(durable, NOW).cohorts[0].roles)
      .toHaveLength(8);

    const futureCapture = fixture();
    futureCapture.cohorts[0].roles[0].sources[0].snapshot.captured_at =
      "2026-07-17T19:06:00.000Z";
    expect(() => normalizeStage1HumanReviewRoot(futureCapture, NOW))
      .toThrow(/captured_at must not be future-dated/i);

    const futureVerification = fixture();
    futureVerification.cohorts[0].roles[0].sources[0].r2.verified_at =
      "2026-07-17T19:06:00.000Z";
    expect(() => normalizeStage1HumanReviewRoot(futureVerification, NOW))
      .toThrow(/verified_at must not be future-dated/i);
  });

  it("accepts an explicitly reviewed official contractor host without fuzzy host inference", () => {
    const root = fixture();
    const contractor = root.cohorts[0].roles[1].sources[0];
    const contractorSourceId = "44444444-4444-4444-8444-444444444444";
    contractor.source_id = contractorSourceId;
    contractor.source_url = "https://apply.contractor.example/application";
    contractor.official_identity = {
      host: "apply.contractor.example",
      classification: "official_contractor_host",
      evidence_url: "https://www.marshallscholarship.org/",
      reviewed_reason: "The canonical program homepage links this exact application contractor.",
    };
    contractor.snapshot.object_keys = Object.fromEntries(
      Object.entries(contractor.snapshot.object_keys).map(([slot, key]) => [
        slot,
        key.replace(SOURCE_ID, contractorSourceId),
      ]),
    );
    expect(stage1HumanReviewRootScope(root, NOW).source_ids)
      .toEqual([SOURCE_ID, contractorSourceId]);
  });

  it("is canonical across input ordering but binds every accepted value", () => {
    const left = fixture();
    const right = fixture();
    right.cohorts[0].roles.reverse();
    right.cohorts[0].public_facts = { overview: "Exact reviewed overview" };
    expect(stage1HumanReviewRootSha256(right, NOW))
      .toBe(stage1HumanReviewRootSha256(left, NOW));

    right.review.reason = "A different explicit decision";
    expect(stage1HumanReviewRootSha256(right, NOW))
      .not.toBe(stage1HumanReviewRootSha256(left, NOW));
    expect(stableStage1HumanReviewJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("signs explicit ordered array composition without sorting away item order", () => {
    const root = fixture();
    root.cohorts[0].public_facts.documents = ["First document", "Second document"];
    root.cohorts[0].field_choices.push({
      field_name: "documents",
      composition_method: "ordered_array_items",
      candidate_ids: [ARRAY_CANDIDATE_B, ARRAY_CANDIDATE_A],
      candidate_evidence: [
        candidateEvidence(ARRAY_CANDIDATE_B),
        candidateEvidence(ARRAY_CANDIDATE_A),
      ],
    });
    const documentsRole = root.cohorts[0].roles.at(-1);
    documentsRole.manifest_status = "present";
    documentsRole.fact_candidate_ids = [ARRAY_CANDIDATE_A, ARRAY_CANDIDATE_B];

    const normalized = normalizeStage1HumanReviewRoot(root, NOW);
    expect(normalized.cohorts[0].field_choices[1].candidate_ids)
      .toEqual([ARRAY_CANDIDATE_B, ARRAY_CANDIDATE_A]);

    const reversed = structuredClone(root);
    reversed.cohorts[0].field_choices[1].candidate_ids.reverse();
    expect(stage1HumanReviewRootSha256(reversed, NOW))
      .not.toBe(stage1HumanReviewRootSha256(root, NOW));

    const short = structuredClone(root);
    short.cohorts[0].field_choices[1].candidate_ids.pop();
    expect(() => normalizeStage1HumanReviewRoot(short, NOW))
      .toThrow(/count must exactly match/i);

    const multipleDirect = fixture();
    multipleDirect.cohorts[0].field_choices[0].candidate_ids.push(ARRAY_CANDIDATE_A);
    multipleDirect.cohorts[0].field_choices[0].candidate_evidence.push(
      candidateEvidence(ARRAY_CANDIDATE_A),
    );
    expect(() => normalizeStage1HumanReviewRoot(multipleDirect, NOW))
      .toThrow(/direct_exact requires exactly one candidate/i);
  });

  it("rejects generated bindings, hidden contributors, and incomplete field choices", () => {
    const generated = fixture();
    generated.cohorts[0].reconciliation = { id: AWARD_ID };
    expect(() => normalizeStage1HumanReviewRoot(generated, NOW)).toThrow(/contain exactly/i);

    const materialize = fixture();
    materialize.review.materialize_candidates = true;
    expect(() => normalizeStage1HumanReviewRoot(materialize, NOW)).toThrow(/materialize_candidates/i);

    const hidden = fixture();
    hidden.cohorts[0].roles[1].manifest_status = "present";
    hidden.cohorts[0].roles[1].fact_candidate_ids = [
      CANDIDATE_ID,
      "44444444-4444-4444-8444-444444444444",
    ];
    expect(() => normalizeStage1HumanReviewRoot(hidden, NOW)).toThrow(/exactly one reviewed source role/i);

    const orphan = fixture();
    orphan.cohorts[0].field_choices = [];
    expect(() => normalizeStage1HumanReviewRoot(orphan, NOW)).toThrow(/exactly cover/i);

    const extraFact = fixture();
    extraFact.cohorts[0].public_facts.operator_only_note = "must not be hash-hidden";
    expect(() => normalizeStage1HumanReviewRoot(extraFact, NOW)).toThrow(/unsupported fields/i);

    const forgedPublication = fixture();
    forgedPublication.cohorts[0].publication = {
      summary: "Unreviewed public copy",
      confidence: 1,
    };
    expect(() => normalizeStage1HumanReviewRoot(forgedPublication, NOW))
      .toThrow(/publication summary\/confidence/i);

    const wrongHost = fixture();
    wrongHost.cohorts[0].roles.forEach((role) => {
      role.sources[0].official_identity.host = "example.edu";
    });
    expect(() => normalizeStage1HumanReviewRoot(wrongHost, NOW)).toThrow(/exactly match/i);

    const conflictingSource = fixture();
    conflictingSource.cohorts[0].roles[1].sources[0].official_identity.reviewed_reason =
      "Conflicting hidden reuse";
    expect(() => normalizeStage1HumanReviewRoot(conflictingSource, NOW))
      .toThrow(/conflicting reviewed bindings/i);

    const notPublished = fixture();
    notPublished.cohorts[0].roles.at(-1).fact_candidate_ids = [CANDIDATE_ID];
    expect(() => normalizeStage1HumanReviewRoot(notPublished, NOW)).toThrow(/zero candidates/i);
  });
});

function fixture() {
  const generation = "a".repeat(32);
  const prefix = `visual-snapshots/sources/${SOURCE_ID}/captures/${generation}`;
  const hashes = { image_hash: "b".repeat(64), text_hash: "c".repeat(64) };
  const source = {
    source_id: SOURCE_ID,
    source_url: "https://www.marshallscholarship.org/",
    official_identity: {
      host: "www.marshallscholarship.org",
      classification: "canonical_program_host",
      evidence_url: "https://www.marshallscholarship.org/",
      reviewed_reason: "Exact canonical program host and homepage.",
    },
    last_checked_at: "2026-07-17T18:30:00.000Z",
    snapshot: {
      captured_at: "2026-07-17T18:31:00.000Z",
      object_keys: {
        page: `${prefix}/page.jpg`,
        thumb: `${prefix}/thumb.jpg`,
        text: `${prefix}/text.txt`,
        meta: `${prefix}/meta.json`,
      },
      hashes,
      metadata: { page_bytes: 100, text_object_bytes: 20, text_length: 19 },
    },
    r2: {
      verified_at: "2026-07-17T18:32:00.000Z",
      hashes: structuredClone(hashes),
    },
    local: {
      verified_at: "2026-07-17T18:33:00.000Z",
      hashes: structuredClone(hashes),
    },
  };
  const roles = REQUIRED_SOURCE_ROLES.map((role) => ({
    source_role: role,
    manifest_status: role === "identity_home" ? "present" : "not_published",
    official: true,
    supporting_text: `Explicit reviewed ${role} source.`,
    cycle: "2027",
    sources: [structuredClone(source)],
    fact_candidate_ids: role === "identity_home" ? [CANDIDATE_ID] : [],
  }));
  return {
    schema_version: STAGE1_HUMAN_REVIEW_ROOT_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    review: {
      reviewed_by: "operator@example.edu",
      reviewed_at: "2026-07-17T18:45:00.000Z",
      reason: "Explicit review of exact role, source, field, and candidate choices.",
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
        candidate_evidence: [candidateEvidence(CANDIDATE_ID)],
      }],
      roles,
    }],
  };
}

function candidateEvidence(candidateId) {
  return {
    candidate_id: candidateId,
    source_id: SOURCE_ID,
    evidence_quote: "Exact reviewed overview",
    evidence_location: "main content",
    capture_text_sha256: "c".repeat(64),
    capture_text_object_key:
      `visual-snapshots/sources/${SOURCE_ID}/captures/${"a".repeat(32)}/text.txt`,
  };
}
