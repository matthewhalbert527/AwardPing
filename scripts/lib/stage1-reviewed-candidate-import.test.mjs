import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_CANDIDATE_EVIDENCE_SCHEMA_VERSION,
  STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION,
  STAGE1_CANDIDATE_IMPORT_RECEIPT_SCHEMA_VERSION,
  buildStage1CandidateImportApplyReceipt,
  buildStage1CandidateImportPlan,
  stage1CandidateImportRpcArgs,
  stage1CandidateImportScope,
  validateStage1CandidateImportApplyProof,
} from "./stage1-reviewed-candidate-import.mjs";
import { STAGE1_POLICY_VERSION } from "./stage1-cohort-readiness.mjs";

const NOW = new Date("2026-07-17T19:00:00.000Z");
const AWARD_ID = "11111111-1111-4111-8111-111111111111";
const ALIAS_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const SEMANTIC_TEXT = "Marshall Scholarship. Exact reviewed eligibility. Apply through the official portal.";
const QUOTE = "Exact reviewed eligibility";
const TEXT_HASH = sha(SEMANTIC_TEXT);
const GENERATION = "a".repeat(32);
const TEXT_KEY = `visual-snapshots/sources/${SOURCE_ID}/captures/${GENERATION}/text.txt`;

describe("Stage 1 reviewed candidate import", () => {
  it("builds a deterministic zero-paid plan with exact immutable local-text evidence", () => {
    const fixture = validFixture();
    const plan = buildStage1CandidateImportPlan({ ...fixture, now: NOW });

    expect(plan.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.confirmation_phrase)
      .toBe(`CONFIRM STAGE1 CANDIDATE IMPORT ${plan.confirmation_sha256}`);
    expect(plan.candidate_rows).toHaveLength(1);
    expect(plan.candidate_rows[0]).toMatchObject({
      shared_award_id: AWARD_ID,
      shared_award_source_id: SOURCE_ID,
      source_role: "primary",
      field_name: "eligibility",
      normalized_value: QUOTE,
      evidence_quote: QUOTE,
      evidence_location: evidenceLocation(),
      candidate_status: "pending",
      source_page_request_id: null,
      intake_value_sha256: null,
      metadata: {
        stage1_immutable_evidence: {
          schema_version: STAGE1_CANDIDATE_EVIDENCE_SCHEMA_VERSION,
          source_id: SOURCE_ID,
          capture_text_sha256: TEXT_HASH,
          capture_text_object_key: TEXT_KEY,
          evidence_quote_sha256: sha(QUOTE),
          verification_method: "exact_local_text_substring",
        },
        stage1_candidate_import: {
          bundle_sha256: plan.bundle_sha256,
          item_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          paid_api_calls: 0,
        },
      },
    });
    expect(plan.candidate_rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.safety).toMatchObject({
      exact_local_text_substring_verifications: 1,
      paid_api_calls: 0,
      source_mutations: 0,
      release_mutations: 0,
      publication_mutations: 0,
    });
    expect(stage1CandidateImportRpcArgs(plan)).toEqual({
      p_import_binding: plan.import_binding,
      p_confirmation_sha256: plan.confirmation_sha256,
    });

    const second = buildStage1CandidateImportPlan({
      ...structuredClone(fixture),
      now: NOW,
    });
    expect(second).toEqual(plan);

    const freshlyReverified = buildStage1CandidateImportPlan({
      ...structuredClone(fixture),
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(freshlyReverified.confirmation_sha256).toBe(plan.confirmation_sha256);
    expect(freshlyReverified.candidate_rows).toEqual(plan.candidate_rows);
    expect(freshlyReverified.source_bindings[0].local_verified_at)
      .not.toBe(plan.source_bindings[0].local_verified_at);
  });

  it("binds the award timestamp verbatim from the database and source timestamps verbatim from the bundle", () => {
    const fixture = validFixture();
    fixture.database.awards[0].updated_at = "2026-07-17T18:30:00.676122+00:00";
    const plan = buildStage1CandidateImportPlan({ ...fixture, now: NOW });

    // Award fence compares by exact timestamptz equality: raw database string.
    expect(plan.import_binding.award.updated_at).toBe("2026-07-17T18:30:00.676122+00:00");
    // Source entries must equal the bundle's attested strings (jsonb equality in the RPC).
    expect(plan.import_binding.source_bindings[0].source_updated_at)
      .toBe(fixture.bundle.sources[0].source_updated_at);
    expect(plan.import_binding.source_bindings[0].captured_at)
      .toBe(fixture.bundle.sources[0].captured_at);
  });

  it("exposes only the explicit one-cohort/source query scope", () => {
    const { bundle } = validFixture();
    expect(stage1CandidateImportScope(bundle, NOW)).toEqual({
      cohort_key: "marshall",
      canonical_award_id: AWARD_ID,
      source_ids: [SOURCE_ID],
    });
  });

  it("retains an alias source owner while keeping the import identity canonical", () => {
    const fixture = validFixture();
    fixture.database.members.push({
      cohort_key: "marshall",
      member_kind: "alias",
      shared_award_id: ALIAS_ID,
    });
    fixture.database.sources[0].shared_award_id = ALIAS_ID;
    fixture.database.visual_snapshots[0].shared_award_id = ALIAS_ID;

    const plan = build(fixture);
    expect(plan.source_bindings[0].shared_award_id).toBe(ALIAS_ID);
    expect(plan.candidate_rows[0].shared_award_id).toBe(ALIAS_ID);
    expect(plan.import_binding.review_bundle.cohort.canonical_award.id).toBe(AWARD_ID);
    expect(plan.candidate_rows[0].metadata.stage1_candidate_import.item_sha256)
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only a complete zero-mutation atomic apply proof", () => {
    const plan = build(validFixture());
    const proof = {
      status: "succeeded",
      bundle_sha256: plan.bundle_sha256,
      confirmation_sha256: plan.confirmation_sha256,
      candidate_count: 1,
      inserted_count: 1,
      existing_count: 0,
      paid_api_calls: 0,
      source_mutations: 0,
      release_mutations: 0,
      reconciliation_mutations: 0,
      publication_mutations: 0,
    };
    expect(validateStage1CandidateImportApplyProof(proof, plan)).toEqual(proof);

    for (const [field, value] of [
      ["confirmation_sha256", "f".repeat(64)],
      ["existing_count", 1],
      ["paid_api_calls", 1],
      ["source_mutations", 1],
      ["release_mutations", 1],
      ["reconciliation_mutations", 1],
      ["publication_mutations", 1],
    ]) {
      expect(() => validateStage1CandidateImportApplyProof({
        ...proof,
        [field]: value,
      }, plan)).toThrow(/unexpected safety proof/i);
    }
    const partial = structuredClone(proof);
    delete partial.publication_mutations;
    expect(() => validateStage1CandidateImportApplyProof(partial, plan))
      .toThrow(/must contain exactly/i);
  });

  it("builds a PII-free write-once apply receipt from the verified proof", () => {
    const plan = build(validFixture());
    const proof = {
      status: "succeeded",
      bundle_sha256: plan.bundle_sha256,
      confirmation_sha256: plan.confirmation_sha256,
      candidate_count: 1,
      inserted_count: 0,
      existing_count: 1,
      paid_api_calls: 0,
      source_mutations: 0,
      release_mutations: 0,
      reconciliation_mutations: 0,
      publication_mutations: 0,
    };
    const receipt = buildStage1CandidateImportApplyReceipt({
      plan,
      proof,
      appliedAt: NOW,
    });
    expect(receipt).toEqual({
      schema_version: STAGE1_CANDIDATE_IMPORT_RECEIPT_SCHEMA_VERSION,
      applied_at: NOW.toISOString(),
      cohort_key: "marshall",
      canonical_shared_award_id: AWARD_ID,
      bundle_sha256: plan.bundle_sha256,
      confirmation_sha256: plan.confirmation_sha256,
      candidate_ids: [plan.candidate_rows[0].id],
      candidate_count: 1,
      inserted_count: 0,
      existing_count: 1,
      safety_attestation: {
        paid_api_calls: 0,
        source_mutations: 0,
        release_mutations: 0,
        reconciliation_mutations: 0,
        publication_mutations: 0,
      },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("operator@example.edu");
    expect(serialized).not.toContain("reviewed_by");
    expect(serialized).not.toContain("service_role");
  });

  it("rejects quote, range, local hash, byte count, and snapshot-key drift", () => {
    const wrongRange = validFixture();
    wrongRange.bundle.items[0].evidence_location = "immutable_text_chars:0-8";
    expect(() => build(wrongRange)).toThrow(/does not exactly match/i);

    const wrongQuote = validFixture();
    wrongQuote.bundle.items[0].evidence_quote = "unrelated generic quote";
    expect(() => build(wrongQuote)).toThrow(/does not exactly match/i);

    const wrongHash = validFixture();
    wrongHash.localEvidence[0].semantic_text_sha256 = "f".repeat(64);
    expect(() => build(wrongHash)).toThrow(/local immutable text changed/i);

    const forgedText = validFixture();
    forgedText.localEvidence[0].semantic_text = forgedText.localEvidence[0].semantic_text
      .replace("Marshall", "Tampered");
    expect(() => build(forgedText)).toThrow(/local immutable text changed/i);

    const wrongBytes = validFixture();
    wrongBytes.localEvidence[0].raw_bytes += 1;
    expect(() => build(wrongBytes)).toThrow(/local immutable text changed/i);

    const wrongKey = validFixture();
    wrongKey.database.visual_snapshots[0].latest_object_keys.text =
      TEXT_KEY.replace("text.txt", "other.txt");
    expect(() => build(wrongKey)).toThrow(/wrong filename|local immutable text changed/i);
  });

  it("rejects stale/CAS-drifted sources, non-published fields, and paid review claims", () => {
    const stale = validFixture();
    stale.bundle.sources[0].last_checked_at = "2026-07-15T18:00:00.000Z";
    expect(() => build(stale)).toThrow(/within 24 hours/i);

    const cas = validFixture();
    cas.database.sources[0].updated_at = "2026-07-17T18:59:00.000Z";
    expect(() => build(cas)).toThrow(/changed after review|local immutable text changed/i);

    const internalField = validFixture();
    internalField.bundle.items[0].field_name = "description";
    expect(() => build(internalField)).toThrow(/not a published/i);

    const paid = validFixture();
    paid.bundle.review.paid_api_calls = 1;
    expect(() => build(paid)).toThrow(/must be zero/i);

    for (const field of ["source_updated_at", "snapshot_updated_at", "captured_at"]) {
      const paradox = validFixture();
      paradox.bundle.sources[0][field] = "2026-07-17T18:56:00.000Z";
      expect(() => build(paradox)).toThrow(/review predates the exact source or snapshot state/i);
    }
  });

  it("rejects unreviewed sources, hidden extra sources, and intake-role relabeling", () => {
    const unreviewed = validFixture();
    unreviewed.bundle.items[0].source_id = "33333333-3333-4333-8333-333333333333";
    expect(() => build(unreviewed)).toThrow(/not explicitly reviewed/i);

    const hidden = validFixture();
    hidden.bundle.sources.push(structuredClone(hidden.bundle.sources[0]));
    hidden.bundle.sources[1].source_id = "33333333-3333-4333-8333-333333333333";
    hidden.bundle.sources[1].capture_text_object_key = TEXT_KEY.replace(
      SOURCE_ID,
      hidden.bundle.sources[1].source_id,
    );
    expect(() => build(hidden)).toThrow(/sources must exactly equal|rows do not exactly match/i);

    const relabeled = validFixture();
    relabeled.bundle.items[0].source_relevance = "eligibility";
    expect(() => build(relabeled)).toThrow(/primary or supporting/i);
  });
});

function build(fixture) {
  return buildStage1CandidateImportPlan({ ...fixture, now: NOW });
}

function validFixture() {
  const start = SEMANTIC_TEXT.indexOf(QUOTE);
  const rawText = `${SEMANTIC_TEXT}\n`;
  return {
    bundle: {
      schema_version: STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION,
      policy_version: STAGE1_POLICY_VERSION,
      review: {
        reviewed_by: "operator@example.edu",
        reviewed_at: "2026-07-17T18:50:00.000Z",
        reason: "Exact human transcription from immutable official text.",
        selection_method: "explicit_human_review",
        paid_api_calls: 0,
      },
      cohort: {
        cohort_key: "marshall",
        canonical_award: {
          id: AWARD_ID,
          search_key: "marshall scholarship",
          name: "Marshall Scholarship",
          official_homepage: "https://www.marshallscholarship.org/",
        },
      },
      sources: [{
        source_id: SOURCE_ID,
        source_url: "https://www.marshallscholarship.org/",
        official_identity: {
          host: "www.marshallscholarship.org",
          classification: "canonical_program_host",
          evidence_url: "https://www.marshallscholarship.org/",
          reviewed_reason: "Exact configured canonical program homepage.",
        },
        source_updated_at: "2026-07-17T18:30:00.000Z",
        last_checked_at: "2026-07-17T18:30:00.000Z",
        snapshot_updated_at: "2026-07-17T18:35:00.000Z",
        captured_at: "2026-06-01T18:35:00.000Z",
        capture_text_sha256: TEXT_HASH,
        capture_text_object_key: TEXT_KEY,
      }],
      items: [{
        item_key: "eligibility.minimum-gpa",
        source_id: SOURCE_ID,
        source_relevance: "primary",
        field_name: "eligibility",
        normalized_value: QUOTE,
        evidence_quote: QUOTE,
        evidence_location: `immutable_text_chars:${start}-${start + QUOTE.length}`,
      }],
    },
    database: {
      registry: [{
        cohort_key: "marshall",
        launch_rank: 2,
        canonical_name: "Marshall Scholarship",
        canonical_shared_award_id: AWARD_ID,
        official_homepage: "https://www.marshallscholarship.org/",
        policy_version: STAGE1_POLICY_VERSION,
      }],
      members: [{
        cohort_key: "marshall",
        member_kind: "canonical",
        shared_award_id: AWARD_ID,
      }],
      identity_rules: [],
      awards: [{
        id: AWARD_ID,
        search_key: "marshall scholarship",
        name: "Marshall Scholarship",
        official_homepage: "https://www.marshallscholarship.org/",
        status: "active",
        updated_at: "2026-07-17T18:30:00.000Z",
      }],
      sources: [{
        id: SOURCE_ID,
        shared_award_id: AWARD_ID,
        url: "https://www.marshallscholarship.org/",
        title: "Marshall Scholarship",
        display_title: "Marshall Scholarship",
        admin_review_status: "open",
        last_checked_at: "2026-07-17T18:30:00.000Z",
        last_error: null,
        updated_at: "2026-07-17T18:30:00.000Z",
      }],
      visual_snapshots: [{
        shared_award_source_id: SOURCE_ID,
        shared_award_id: AWARD_ID,
        source_url: "https://www.marshallscholarship.org/",
        kind: "webpage",
        latest_captured_at: "2026-06-01T18:35:00.000Z",
        latest_object_keys: {
          page: TEXT_KEY.replace("text.txt", "page.jpg"),
          thumb: TEXT_KEY.replace("text.txt", "thumb.jpg"),
          text: TEXT_KEY,
          meta: TEXT_KEY.replace("text.txt", "meta.json"),
        },
        latest_hashes: {
          image_hash: "b".repeat(64),
          text_hash: TEXT_HASH,
        },
        latest_metadata: {
          page_bytes: 100,
          text_object_bytes: Buffer.byteLength(rawText, "utf8"),
          text_length: SEMANTIC_TEXT.length,
        },
        updated_at: "2026-07-17T18:35:00.000Z",
      }],
    },
    localEvidence: [{
      source_id: SOURCE_ID,
      path: `D:/AwardPingVisualSnapshots/sources/${SOURCE_ID}/captures/example/text.txt`,
      raw_bytes: Buffer.byteLength(rawText, "utf8"),
      semantic_text: SEMANTIC_TEXT,
      semantic_text_sha256: TEXT_HASH,
      text_length: SEMANTIC_TEXT.length,
      capture_text_sha256: TEXT_HASH,
      capture_text_object_key: TEXT_KEY,
    }],
  };
}

function evidenceLocation() {
  const start = SEMANTIC_TEXT.indexOf(QUOTE);
  return `immutable_text_chars:${start}-${start + QUOTE.length}`;
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
