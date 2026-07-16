import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  baselineFactsFromIntakeReview,
  buildDiscoveredPdfIntakeRequest,
  buildSourceAcquisitionProposal,
  buildSourceAcquisitionRecord,
  captureIntakePage,
  deterministicSourceIntakeReview,
  factCandidateRowsFromIntake,
  matchSourceToExistingAward,
  normalizeGeminiIntakeResult,
  persistSourceIntakeFactCandidates,
  shouldCreateNewAwardFromIntake,
  sourceLikeFromIntake,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";

const request = {
  id: "request-1",
  award_name: "Example Research Fellowship",
  homepage_url: "https://example.edu/research-fellowship",
  normalized_url: "https://example.edu/research-fellowship",
  submitted_url: "https://example.edu/research-fellowship",
  notes: null,
  intake_type: "award_homepage",
};

const capture = {
  final_url: "https://example.edu/research-fellowship",
  canonical_url: "https://example.edu/research-fellowship",
  title: "Example Research Fellowship",
  page_description: "Official fellowship page with application details.",
  text: "Example Research Fellowship applications close March 1. The award provides a $5,000 stipend.",
  content_type: "text/html",
};

const acceptedReview = {
  status: "accepted",
  detected_award_name: "Example Research Fellowship",
  detected_sponsor: "Example University",
  source_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  page_type: "homepage",
  officialness: "official",
  confidence: "high",
  evidence_quotes: ["Example Research Fellowship applications close March 1."],
  facts: {
    description: "Official fellowship page with application details.",
    deadline: "March 1",
    amount: "$5,000 stipend",
    eligibility: ["Graduate students"],
    application_materials: ["Application form"],
    important_dates: ["Applications close: March 1"],
  },
};

const liveRequestId = "11111111-1111-4111-8111-111111111111";
const liveWorkerRunId = "22222222-2222-4222-8222-222222222222";
const liveParentSourceId = "33333333-3333-4333-8333-333333333333";

describe("source intake worker helpers", () => {
  it("routes deterministic access pages to durable manual review instead of terminal rejection", () => {
    const decision = deterministicSourceIntakeReview({
      url: "https://example.edu/2027-guidance.pdf",
      title: "Access denied",
      text: "Forbidden. Verify you are human to continue.",
      requestedAwardName: "Example Research Fellowship",
      contentType: "text/html",
    });

    expect(decision).toMatchObject({
      allowed: false,
      status: "needs_manual_review",
      reason: "access-error",
      qualityFlags: expect.arrayContaining(["access-error"]),
    });
  });

  it("extracts real PDF text, page count, and an exact byte hash during capture", async () => {
    const pdf = minimalTextPdf("Applications are due March 15, 2027.");
    const result = await captureIntakePage("https://example.edu/2027-guidance.pdf", {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response(pdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    });

    expect(result.capture_method).toBe("fetch_pdf_text");
    expect(result.page_count).toBe(1);
    expect(result.pdf_text_error).toBeNull();
    expect(result.text).toContain("Applications are due March 15, 2027.");
    expect(result.capture_file_hash).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(result.artifact_bytes).toEqual(pdf);
    expect(Object.keys(result)).not.toContain("artifact_bytes");
    expect(JSON.stringify(result)).not.toContain("artifact_bytes");
  });

  it("rejects an oversized PDF from Content-Length before reading or parsing it", async () => {
    const body = minimalTextPdf("Applications are due March 15, 2027.");
    await expect(captureIntakePage("https://example.edu/oversized.pdf", {
      lookupImpl: publicLookup,
      maxPdfBytes: body.length - 1,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(body.length),
        },
      }),
    })).rejects.toThrow(/PDF is too large/);
  });

  it("stops a PDF body that exceeds the cap when Content-Length is absent", async () => {
    const body = minimalTextPdf("Applications are due March 15, 2027.");
    await expect(captureIntakePage("https://example.edu/streamed.pdf", {
      lookupImpl: publicLookup,
      maxPdfBytes: body.length - 1,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    })).rejects.toThrow(/PDF is too large/);
  });

  it("rejects private DNS answers before making a source-intake request", async () => {
    let fetchCalls = 0;
    await expect(captureIntakePage("https://public-looking.example.edu/guidance.pdf", {
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    })).rejects.toThrow(/private, local, or reserved network address/);
    expect(fetchCalls).toBe(0);
  });

  it("validates every redirect hop and refuses redirects to private addresses", async () => {
    let fetchCalls = 0;
    await expect(captureIntakePage("https://example.edu/guidance.pdf", {
      lookupImpl: publicLookup,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal.pdf" },
        });
      },
    })).rejects.toThrow(/Private, local, or internal URLs/);
    expect(fetchCalls).toBe(1);
  });

  it("normalizes Gemini intake output and builds baseline facts", () => {
    const normalized = normalizeGeminiIntakeResult(acceptedReview);
    expect(normalized.status).toBe("accepted");
    expect(normalized.evidence_quotes).toEqual(["Example Research Fellowship applications close March 1."]);

    const facts = baselineFactsFromIntakeReview(normalized);
    expect(facts.award_relevance).toBe("primary");
    expect(facts.cycle_relevance).toBe("current_or_upcoming");
    expect(facts.deadline).toBe("March 1");
  });

  it("fails closed when Gemini omits exact evidence", () => {
    const decision = validateIntakeAiDecision({ ...acceptedReview, evidence_quotes: [] });
    expect(decision.accepted).toBe(false);
    expect(decision.manual).toBe(true);
    expect(decision.reason).toBe("missing_evidence_quotes");
  });

  it("rejects sibling or generic listing decisions", () => {
    const sibling = validateIntakeAiDecision({
      ...acceptedReview,
      source_relevance: "sibling_program",
      rejection_reason: "sibling award",
    });
    expect(sibling.accepted).toBe(false);
    expect(sibling.manual).toBe(false);
    expect(sibling.reason).toBe("source_relevance_sibling_program");
  });

  it("matches an existing award by award identity and official url", () => {
    const match = matchSourceToExistingAward({
      awards: [
        { id: "a1", name: "Other Award", official_homepage: "https://other.edu/award" },
        { id: "a2", name: "Example Research Fellowship", official_homepage: "https://example.edu/research-fellowship" },
      ],
      request,
      capture,
      review: acceptedReview,
    });
    expect(match?.award.id).toBe("a2");
    expect(match?.score).toBeGreaterThan(0.85);
  });

  it("only creates new awards for high-confidence official primary pages", () => {
    const create = shouldCreateNewAwardFromIntake({
      review: acceptedReview,
      deterministicReview: { allowed: true, reason: "passes" },
      request,
      capture,
    });
    expect(create.create).toBe(true);

    const listing = shouldCreateNewAwardFromIntake({
      review: { ...acceptedReview, source_relevance: "generic_listing" },
      deterministicReview: { allowed: true, reason: "passes" },
      request,
      capture,
    });
    expect(listing.create).toBe(false);
  });

  it("builds monitorable source rows from accepted reviews", () => {
    const source = sourceLikeFromIntake({ request, capture, review: acceptedReview });
    expect(source.url).toBe("https://example.edu/research-fellowship");
    expect(source.page_type).toBe("homepage");
    expect(source.page_metadata.baseline_facts.award_relevance).toBe("primary");
  });

  it("does not duplicate fact candidates when a retained result replays after a downstream failure", async () => {
    const sourceLike = sourceLikeFromIntake({ request, capture, review: acceptedReview });
    const rows = factCandidateRowsFromIntake({
      awardId: "44444444-4444-4444-8444-444444444444",
      sourceId: "55555555-5555-4555-8555-555555555555",
      sourcePageRequestId: liveRequestId,
      sourceLike,
      review: acceptedReview,
      extractedAt: "2026-07-16T15:30:00.000Z",
    });
    const persisted = new Map();
    const supabase = replaySafeFactCandidateClient(persisted);

    await expect((async () => {
      const first = await persistSourceIntakeFactCandidates(supabase, rows);
      expect(first).toEqual({ inserted: rows.length, existing: 0 });
      throw new Error("injected failure after fact persistence");
    })()).rejects.toThrow("injected failure after fact persistence");

    const replay = await persistSourceIntakeFactCandidates(supabase, rows);
    expect(replay).toEqual({ inserted: 0, existing: rows.length });
    expect(persisted).toHaveLength(rows.length);
  });

  it("seals a genuinely new live-discovered PDF for first-capture review", () => {
    const captureHash = "a".repeat(64);
    const acquisition = buildSourceAcquisitionRecord({
      request: {
        id: liveRequestId,
        acquisition_kind: "live_discovery",
        notification_mode: "first_capture_candidate",
        parent_shared_award_source_id: liveParentSourceId,
      },
      source: { id: "source-1", url: "https://example.edu/2027-guidance.pdf" },
      review: { ...acceptedReview, page_type: "pdf" },
      capture: {
        final_url: "https://example.edu/2027-guidance.pdf",
        content_type: "application/pdf",
        text: capture.text,
        capture_file_hash: captureHash,
        page_count: 4,
        captured_at: "2026-07-16T12:00:00.000Z",
        retained_artifact: retainedArtifactFixture({
          requestId: liveRequestId,
          fileHash: captureHash,
          finalUrl: "https://example.edu/2027-guidance.pdf",
          capturedAt: "2026-07-16T12:00:00.000Z",
        }),
      },
      sourceWasInserted: true,
      awardCreated: false,
      workerRunId: liveWorkerRunId,
      sealedAt: "2026-07-16T12:01:00.000Z",
    });

    expect(acquisition).toMatchObject({
      create: true,
      reason: "sealed_live_discovery_for_existing_award",
      acquisition_kind: "live_discovery",
      notification_mode: "first_capture_candidate",
      row: {
        shared_award_source_id: "source-1",
        origin_source_page_request_id: liveRequestId,
        origin_worker_run_id: liveWorkerRunId,
        parent_shared_award_source_id: liveParentSourceId,
        review_seal: {
          sealed: true,
          status: "accepted",
          award_relevance: "primary",
          evidence_quotes: ["Example Research Fellowship applications close March 1."],
          exact_evidence_verified: true,
          capture_file_hash: captureHash,
          capture_page_count: 4,
          policy_name: "source_intake_acquisition_review",
          policy_version: 1,
          policy_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          seal_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("builds the source-independent acquisition payload consumed by atomic registration", () => {
    const proposal = buildSourceAcquisitionProposal({
      request: {
        id: liveRequestId,
        acquisition_kind: "live_discovery",
        notification_mode: "first_capture_candidate",
        parent_shared_award_source_id: liveParentSourceId,
      },
      source: { url: "https://example.edu/2027-guidance.pdf" },
      review: { ...acceptedReview, page_type: "pdf" },
      capture: {
        final_url: "https://example.edu/2027-guidance.pdf",
        content_type: "application/pdf",
        text: capture.text,
        capture_file_hash: "a".repeat(64),
        captured_at: "2026-07-16T12:00:00.000Z",
        retained_artifact: retainedArtifactFixture({
          requestId: liveRequestId,
          fileHash: "a".repeat(64),
          finalUrl: "https://example.edu/2027-guidance.pdf",
          capturedAt: "2026-07-16T12:00:00.000Z",
        }),
      },
      awardCreated: false,
      workerRunId: liveWorkerRunId,
    });

    expect(proposal.row).toMatchObject({
      acquisition_kind: "live_discovery",
      notification_mode: "first_capture_candidate",
      award_was_created: false,
      origin_source_page_request_id: liveRequestId,
      review_seal: {
        sealed: true,
        evidence_quotes: ["Example Research Fellowship applications close March 1."],
        capture_file_hash: "a".repeat(64),
      },
    });
    expect(proposal.row).not.toHaveProperty("shared_award_source_id");
  });

  it.each([
    [{ awardCreated: true }, "new_award_onboarding_baseline_only"],
    [{ request: { onboarding_batch_id: "batch-1" } }, "bulk_onboarding_baseline_only"],
    [{ request: { acquisition_kind: "admin_intake" } }, "non_live_discovery_baseline_only"],
    [{ request: { acquisition_kind: undefined } }, "non_live_discovery_baseline_only"],
  ])("keeps intentional onboarding first-capture contexts baseline-only", (overrides, reason) => {
    const acquisition = buildSourceAcquisitionRecord({
      request: {
        id: liveRequestId,
        acquisition_kind: "live_discovery",
        notification_mode: "first_capture_candidate",
        parent_shared_award_source_id: liveParentSourceId,
        ...(overrides.request || {}),
      },
      source: { id: "source-1", url: "https://example.edu/2027-guidance.pdf" },
      review: { ...acceptedReview, page_type: "pdf" },
      capture: {
        final_url: "https://example.edu/2027-guidance.pdf",
        content_type: "application/pdf",
        text: capture.text,
        capture_file_hash: "a".repeat(64),
        captured_at: "2026-07-16T12:00:00.000Z",
        retained_artifact: retainedArtifactFixture({
          requestId: liveRequestId,
          fileHash: "a".repeat(64),
          finalUrl: "https://example.edu/2027-guidance.pdf",
          capturedAt: "2026-07-16T12:00:00.000Z",
        }),
        ...(overrides.capture || {}),
      },
      sourceWasInserted: true,
      awardCreated: overrides.awardCreated || false,
      workerRunId: "worker-run-1",
    });

    expect(acquisition).toMatchObject({
      create: true,
      reason,
      notification_mode: "baseline_only",
    });
  });

  it.each([
    [
      { capture: { text: "The reviewed wording is absent." } },
      "exact_evidence_missing_manual_review",
    ],
    [
      { capture: { capture_file_hash: null } },
      "capture_hash_missing_manual_review",
    ],
    [
      { request: { parent_shared_award_source_id: null } },
      "parent_source_provenance_missing_manual_review",
    ],
    [
      { workerRunId: null },
      "worker_run_provenance_missing_manual_review",
    ],
    [
      { capture: { final_url: "https://cdn.example.edu/2027-guidance.pdf" } },
      "capture_final_url_mismatch_manual_review",
    ],
  ])("fails a live first-capture evidence gap into manual review", (overrides, reason) => {
    const acquisition = buildSourceAcquisitionRecord({
      request: {
        id: "request-1",
        acquisition_kind: "live_discovery",
        notification_mode: "first_capture_candidate",
        parent_shared_award_source_id: "parent-source-1",
        ...(overrides.request || {}),
      },
      source: { id: "source-1", url: "https://example.edu/2027-guidance.pdf" },
      review: { ...acceptedReview, page_type: "pdf" },
      capture: {
        final_url: "https://example.edu/2027-guidance.pdf",
        content_type: "application/pdf",
        text: capture.text,
        capture_file_hash: "a".repeat(64),
        ...(overrides.capture || {}),
      },
      sourceWasInserted: true,
      awardCreated: false,
      workerRunId: Object.hasOwn(overrides, "workerRunId")
        ? overrides.workerRunId
        : liveWorkerRunId,
    });

    expect(acquisition).toMatchObject({
      create: true,
      reason,
      notification_mode: "manual_review",
      row: {
        notification_mode: "manual_review",
        metadata: { requires_manual_review: true },
      },
    });
  });

  it("preserves an explicitly manual non-live intake without calling it a failed live first capture", () => {
    const acquisition = buildSourceAcquisitionProposal({
      request: {
        id: "request-1",
        acquisition_kind: "admin_intake",
        notification_mode: "manual_review",
      },
      source: { url: "https://example.edu/2027-guidance.pdf" },
      review: { ...acceptedReview, page_type: "pdf" },
      capture: {
        final_url: "https://example.edu/2027-guidance.pdf",
        content_type: "application/pdf",
        text: capture.text,
        capture_file_hash: "a".repeat(64),
      },
      awardCreated: false,
    });

    expect(acquisition).toMatchObject({
      reason: "explicit_manual_review",
      notification_mode: "manual_review",
    });
  });

  it("does not create a new acquisition when intake matched a preexisting source", () => {
    expect(buildSourceAcquisitionRecord({
      request: { acquisition_kind: "live_discovery", notification_mode: "first_capture_candidate" },
      source: { id: "source-1" },
      review: acceptedReview,
      capture,
      sourceWasInserted: false,
    })).toEqual({
      create: false,
      reason: "preexisting_source_not_reacquired",
      acquisition_kind: "live_discovery",
      notification_mode: "baseline_only",
      row: null,
    });
  });

  it("builds a live-discovery request that is matched to its award and parent source", () => {
    const row = buildDiscoveredPdfIntakeRequest({
      source: {
        id: "parent-source-1",
        shared_award_id: "award-1",
        url: "https://example.edu/fellowship",
        shared_awards: { name: "Example Research Fellowship" },
      },
      link: {
        url: "https://example.edu/2027-guidance.pdf",
        reason: "Applicant guidance link",
      },
      expanded: { controls_clicked: 2 },
      decision: {
        reason: "same_award_official_pdf",
        candidate: { url: "https://example.edu/2027-guidance.pdf" },
      },
      discoveryIntent: "live_recurring",
    });

    expect(row).toMatchObject({
      award_name: "Example Research Fellowship",
      normalized_url: "https://example.edu/2027-guidance.pdf",
      intake_type: "official_source",
      status: "pending",
      matched_shared_award_id: "award-1",
      acquisition_kind: "live_discovery",
      notification_mode: "first_capture_candidate",
      parent_shared_award_source_id: "parent-source-1",
      onboarding_batch_id: null,
    });
  });

  it("marks operator bulk discovery as historical baseline-only onboarding", () => {
    const row = buildDiscoveredPdfIntakeRequest({
      source: {
        id: "parent-source-1",
        shared_award_id: "award-1",
        url: "https://example.edu/fellowship",
        shared_awards: { name: "Example Research Fellowship" },
      },
      link: { url: "https://example.edu/archive/2022-guidance.pdf" },
      expanded: {},
      decision: {
        reason: "same_award_official_pdf",
        candidate: { url: "https://example.edu/archive/2022-guidance.pdf" },
      },
      discoveryIntent: "historical_onboarding",
      onboardingBatchId: "backfill-2026-07-16",
    });

    expect(row).toMatchObject({
      acquisition_kind: "historical_import",
      notification_mode: "baseline_only",
      onboarding_batch_id: "backfill-2026-07-16",
      status_reason: "queued_from_historical_pdf_discovery_baseline_only",
    });
  });
});

function replaySafeFactCandidateClient(persisted) {
  return {
    from(table) {
      if (table !== "shared_award_fact_candidates") {
        throw new Error(`Unexpected test table: ${table}`);
      }
      return {
        upsert(rows, options) {
          if (
            options?.onConflict !== "source_page_request_id,field_name,intake_value_sha256" ||
            options?.ignoreDuplicates !== true
          ) {
            throw new Error("Fact candidates were not persisted with the replay-safe conflict contract.");
          }
          return {
            async select(columns) {
              if (columns !== "id") throw new Error(`Unexpected test select: ${columns}`);
              const inserted = [];
              for (const row of rows) {
                const identity = [
                  row.source_page_request_id,
                  row.field_name,
                  row.intake_value_sha256,
                ].join(":");
                if (persisted.has(identity)) continue;
                const record = { ...row, id: `fact-${persisted.size + 1}` };
                persisted.set(identity, record);
                inserted.push({ id: record.id });
              }
              return { data: inserted, error: null };
            },
          };
        },
      };
    },
  };
}

function retainedArtifactFixture({ requestId, fileHash, finalUrl, capturedAt }) {
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  return {
    schema_version: 1,
    namespace: "source-intake-first-observation",
    request_id: requestId,
    captured_at: capturedAt,
    final_url: finalUrl,
    prefix,
    file_hash: fileHash,
    file_bytes: 1024,
    text_hash: "b".repeat(64),
    text_length: 100,
    r2_bucket: "awardping-snapshots",
    r2_store_id: "test-account.r2.cloudflarestorage.com",
    r2_verified_at: "2026-07-16T12:00:30.000Z",
    artifacts: {
      pdf: {
        key: `${prefix}/document.pdf`,
        sha256: fileHash,
        byte_length: 1024,
        content_type: "application/pdf",
      },
      text: {
        key: `${prefix}/text.txt`,
        sha256: "c".repeat(64),
        byte_length: 101,
        content_type: "text/plain; charset=utf-8",
      },
      capture_metadata: {
        key: `${prefix}/capture.json`,
        sha256: "d".repeat(64),
        byte_length: 512,
        content_type: "application/json",
      },
    },
  };
}

function minimalTextPdf(text) {
  const escaped = String(text).replace(/([\\()])/g, "\\$1");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document, "ascii"));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "ascii");
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

async function publicLookup() {
  return [{ address: "93.184.216.34", family: 4 }];
}
