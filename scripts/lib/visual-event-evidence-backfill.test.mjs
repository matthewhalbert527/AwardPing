import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DeterministicVisualArtifactError } from "./visual-event-evidence.mjs";
import {
  backfillEvidenceRpcPayload,
  createDryRunPublishedArtifactStore,
  createImmutablePublishedArtifactStore,
  executeHistoricalBackfillStep,
  historicalArtifactUnrecoverableEvidence,
  historicalBackfillRepairPlan,
  matchHistoricalTerminalLossConfirmation,
  normalizePreparedHistoricalEvidence,
  parseHistoricalTerminalLossConfirmations,
  resolveHistoricalEventCandidate,
} from "./visual-event-evidence-backfill.mjs";

describe("historical visual event evidence backfill", () => {
  it.each([
    ["direct_fk", { direct: true }],
    ["candidate_signature", { signature: true }],
    ["reverse_worker_metadata", { reverse: true }],
  ])("resolves only a strong %s binding with exact identities", (method, binding) => {
    const candidate = candidateRow(binding.reverse ? { worker_metadata: { change_event_id: "event-1" } } : {});
    const event = eventRow({
      visual_review_candidate_id: binding.direct ? candidate.id : null,
      change_details: binding.signature ? { candidate_signature: candidate.candidate_signature } : {},
    });

    const result = resolveHistoricalEventCandidate({
      event,
      directCandidates: binding.direct ? [candidate] : [],
      signatureCandidates: binding.signature ? [candidate] : [],
      reverseCandidates: binding.reverse ? [candidate] : [],
    });

    expect(result).toMatchObject({ resolved: true, candidate: { id: candidate.id } });
    expect(result.methods).toContain(method);
  });

  it("fails closed for contradictory bindings", () => {
    const direct = candidateRow({ id: "candidate-direct" });
    const signed = candidateRow({ id: "candidate-signed", candidate_signature: "signed-other" });
    const event = eventRow({
      visual_review_candidate_id: direct.id,
      change_details: { candidate_signature: signed.candidate_signature },
    });

    const result = resolveHistoricalEventCandidate({
      event,
      directCandidates: [direct],
      signatureCandidates: [signed],
    });

    expect(result).toMatchObject({
      resolved: false,
      reason_code: "contradictory_candidate_bindings",
    });
  });

  it("rejects award/source and previous/current visual hash mismatches", () => {
    const candidate = candidateRow();
    expect(resolveHistoricalEventCandidate({
      event: eventRow({ shared_award_id: "other-award", visual_review_candidate_id: candidate.id }),
      directCandidates: [candidate],
    })).toMatchObject({ resolved: false, reason_code: "award_identity_mismatch" });

    expect(resolveHistoricalEventCandidate({
      event: eventRow({ new_hash: "visual:wrong", visual_review_candidate_id: candidate.id }),
      directCandidates: [candidate],
    })).toMatchObject({ resolved: false, reason_code: "event_visual_identity_mismatch" });
  });

  it("retains candidate-bound full artifacts but truthfully downgrades missing geometry", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate, {
      evidence_status: "full_screenshot_fallback",
      previousStatus: "unavailable_image_state",
      currentStatus: "unavailable_image_state",
    });

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result.recoverable).toBe(true);
    expect(result.evidence).toMatchObject({
      visual_review_candidate_id: candidate.id,
      evidence_status: "unavailable_geometry_missing",
      localization: {
        sides: {
          previous: { status: "unavailable_geometry_missing", exact_overlap: false },
          current: { status: "unavailable_geometry_missing", exact_overlap: false },
        },
      },
    });
  });

  it("preserves a surviving side when the peer full artifact is unrecoverable", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate);
    evidence.previous_capture.full = null;

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result).toMatchObject({
      recoverable: true,
      partial: true,
      reason_code: "historical_side_artifact_missing",
      evidence: {
        visual_review_candidate_id: candidate.id,
        candidate_signature: candidate.candidate_signature,
        evidence_status: "unavailable_image_missing",
        previous_capture: {},
        current_capture: { full: { object_key: expect.stringContaining("/current/") } },
        localization: {
          sides: {
            previous: { status: "unavailable_image_missing", exact_overlap: false },
          },
        },
      },
    });
  });

  it("keeps total candidate-bound artifact loss retryable until operator confirmation", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate);
    evidence.previous_capture.full = null;
    evidence.current_capture.full = null;

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result).toMatchObject({
      recoverable: false,
      reason_code: "historical_artifacts_unrecoverable",
      evidence: null,
      terminal_evidence_input: { candidate: { id: candidate.id } },
    });
  });

  it("preserves one immutable PDF side when its peer document is incomplete", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate);
    for (const side of ["previous", "current"]) {
      const fileHash = side === "previous" ? candidate.previous_file_hash : candidate.new_file_hash;
      evidence[`${side}_capture`] = {
        ...capture(side),
        kind: "pdf",
        full: {
          ...capture(side).full,
          sha256: fileHash,
          content_type: "application/pdf",
        },
        metadata: {
          object_key: `visual-snapshots/published/candidate-1/${side}/metadata.json`,
          sha256: "e".repeat(64),
          byte_length: 50,
          content_type: "application/json; charset=utf-8",
        },
        capture_hashes: { file_hash: fileHash },
      };
    }
    evidence.previous_capture.metadata = null;

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result).toMatchObject({
      recoverable: true,
      partial: true,
      reason_code: "historical_pdf_side_artifact_missing",
      evidence: {
        visual_review_candidate_id: candidate.id,
        candidate_signature: candidate.candidate_signature,
        evidence_status: "unavailable_image_missing",
        previous_capture: {},
        current_capture: {
          kind: "pdf",
          full: { sha256: candidate.new_file_hash, content_type: "application/pdf" },
        },
      },
    });
  });

  it("keeps total candidate-bound PDF loss retryable until operator confirmation", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate);
    for (const side of ["previous", "current"]) {
      evidence[`${side}_capture`] = {
        ...capture(side),
        kind: "pdf",
        full: { ...capture(side).full, content_type: "application/pdf" },
        metadata: null,
        capture_hashes: { file_hash: "f".repeat(64) },
      };
    }

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result).toMatchObject({
      recoverable: false,
      reason_code: "historical_pdf_artifact_incomplete",
      evidence: null,
      terminal_evidence_input: { candidate: { id: candidate.id } },
    });
  });

  it("builds truthful candidate-null evidence when no binding exists and strips retry-varying timestamps", () => {
    const evidence = historicalArtifactUnrecoverableEvidence({
      event: eventRow({
        change_details: { exact_before: "Old wording", exact_after: "New wording" },
      }),
      reason: "No exact candidate binding survives.",
      terminalArtifactLossConfirmed: true,
    });
    const payload = backfillEvidenceRpcPayload({
      ...evidence,
      created_at: "now",
      verified_at: "now",
      backfilled_at: "now",
    });

    expect(evidence.localization.direction).toBe("mixed");
    expect(evidence.localization).toMatchObject({
      terminal_artifact_loss_confirmed: true,
      terminal_artifact_loss_reason: "No exact candidate binding survives.",
    });
    expect(evidence.localization.sides.previous.reason).toBe("No exact candidate binding survives.");
    expect(payload).not.toHaveProperty("created_at");
    expect(payload).not.toHaveProperty("verified_at");
    expect(payload).not.toHaveProperty("backfilled_at");
  });

  it("keeps unresolved linkage retryable without publishing or advancing", async () => {
    const publishEvidence = vi.fn();
    const advance = vi.fn();
    const unresolved = await executeHistoricalBackfillStep({
      createEvidence: async () => ({
        evidence: null,
        outcome: "missing_candidate_binding",
        retryable: true,
        publishable: false,
      }),
      recoverDeterministicFailure: vi.fn(),
      publishEvidence,
      advance,
    });

    expect(unresolved).toMatchObject({
      evidence: null,
      publication: null,
      advanced: false,
      retryable: true,
    });
    expect(publishEvidence).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();

    const recoveredEvidence = { evidence_status: "verified", visual_review_candidate_id: "candidate-1" };
    const recovered = await executeHistoricalBackfillStep({
      createEvidence: async () => ({ evidence: recoveredEvidence, outcome: "candidate_bound" }),
      recoverDeterministicFailure: vi.fn(),
      publishEvidence: publishEvidence.mockResolvedValueOnce({ inserted: true }),
      advance,
    });

    expect(recovered).toMatchObject({
      evidence: recoveredEvidence,
      publication: { inserted: true },
      advanced: true,
    });
    expect(publishEvidence).toHaveBeenCalledWith(recoveredEvidence);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("rejects any unrecoverable evidence without terminal loss confirmation", () => {
    expect(() => historicalArtifactUnrecoverableEvidence({
      event: eventRow(),
      reason: "Candidate resolution is incomplete.",
    })).toThrow("terminal artifact-loss confirmation");
    expect(() => historicalArtifactUnrecoverableEvidence({
      event: eventRow(),
      candidate: candidateRow(),
      reason: "The bound archive is temporarily unavailable.",
    })).toThrow("terminal artifact-loss confirmation");
  });

  it("parses auditable terminal-loss confirmations and rejects stale reason codes", () => {
    const confirmations = parseHistoricalTerminalLossConfirmations([{
      event_id: "event-1",
      resolution_reason_code: "historical_artifacts_unrecoverable",
      reason: "Both independently retained sides were confirmed destroyed.",
      actor: "operator@example.com",
      confirmed_at: "2026-07-15T19:00:00.000Z",
    }]);
    const confirmation = confirmations.get("event-1");

    expect(matchHistoricalTerminalLossConfirmation({
      confirmation,
      currentReasonCode: "historical_artifacts_unrecoverable",
    })).toMatchObject({ accepted: true, confirmation });
    expect(matchHistoricalTerminalLossConfirmation({
      confirmation,
      currentReasonCode: "historical_pdf_artifact_incomplete",
    })).toMatchObject({
      accepted: false,
      reason_code: "terminal_loss_confirmation_reason_mismatch",
    });

    const terminalEvidence = historicalArtifactUnrecoverableEvidence({
      event: eventRow(),
      candidate: candidateRow(),
      reason: confirmation.reason,
      terminalArtifactLossConfirmed: true,
      terminalArtifactLossConfirmation: confirmation,
    });
    expect(terminalEvidence.localization).toMatchObject({
      terminal_artifact_loss_confirmed: true,
      terminal_artifact_loss_reason: confirmation.reason,
      terminal_artifact_loss_actor: confirmation.actor,
      terminal_artifact_loss_confirmed_at: confirmation.confirmed_at,
      terminal_artifact_loss_resolution_reason_code: confirmation.resolution_reason_code,
    });
  });

  it("downgrades legacy crops that lack complete new-format state/hash identity", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const evidence = preparedEvidence(candidate, {
      evidence_status: "verified",
      previousStatus: "verified",
      currentStatus: "verified",
    });
    evidence.previous_capture.crop = crop("previous");
    evidence.current_capture.crop = crop("current");

    const result = normalizePreparedHistoricalEvidence({ event, candidate, evidence });

    expect(result.evidence.evidence_status).toBe("full_screenshot_fallback");
    expect(result.evidence.previous_capture.crop).toBeNull();
    expect(result.evidence.current_capture.crop).toBeNull();
    expect(result.evidence.localization.sides.previous).toMatchObject({
      status: "full_screenshot_fallback",
      exact_overlap: false,
    });
  });

  it("keeps verified crops only when crop, layout, state, and overlap identities are complete", () => {
    const candidate = candidateRow();
    const event = eventRow();
    const complete = verifiedPreparedEvidence(candidate);

    expect(normalizePreparedHistoricalEvidence({
      event,
      candidate,
      evidence: structuredClone(complete),
    }).evidence.evidence_status).toBe("verified");

    const invalidVariants = [
      (value) => { value.previous_capture.states = []; },
      (value) => { value.previous_capture.layout.geometry_hash = null; },
      (value) => { value.localization.sides.previous.crop_rect_pixels = null; },
      (value) => {
        value.localization.sides.previous.matched_rects = [{ x: 500, y: 500, width: 10, height: 10 }];
      },
    ];
    for (const invalidate of invalidVariants) {
      const value = structuredClone(complete);
      invalidate(value);
      expect(normalizePreparedHistoricalEvidence({
        event,
        candidate,
        evidence: value,
      }).evidence.evidence_status).toBe("full_screenshot_fallback");
    }
  });

  it("maps unsafe repair classes to explicit operator-safe solutions", () => {
    expect(historicalBackfillRepairPlan("event_visual_identity_mismatch")).toMatchObject({
      category: "quarantine_identity_conflict",
      solution: expect.stringContaining("do not relink"),
    });
    expect(historicalBackfillRepairPlan("ambiguous_candidate_signature")).toMatchObject({
      category: "explicit_operator_linkage",
      solution: expect.stringContaining("explicit operator linkage"),
    });
    expect(historicalBackfillRepairPlan("historical_pdf_side_artifact_missing")).toMatchObject({
      category: "preserve_survivors_mark_unavailable",
      solution: expect.stringContaining("Preserve every independently verified immutable survivor"),
    });
    expect(historicalBackfillRepairPlan("backfill_rpc_dependency_failure")).toMatchObject({
      category: "dependency_repair_idempotent_retry",
      solution: expect.stringContaining("resume the same idempotent backfill"),
    });
    expect(historicalBackfillRepairPlan("terminal_loss_confirmation_reason_mismatch")).toMatchObject({
      category: "stale_terminal_loss_confirmation",
      solution: expect.stringContaining("current reason code"),
    });
  });

  it("aborts an R2 outage without publishing or advancing the checkpoint", async () => {
    const publishEvidence = vi.fn();
    const advance = vi.fn();
    const recoverDeterministicFailure = vi.fn();

    await expect(executeHistoricalBackfillStep({
      createEvidence: async () => {
        throw Object.assign(new Error("R2 HeadObject network outage"), {
          $metadata: { httpStatusCode: 503 },
        });
      },
      recoverDeterministicFailure,
      publishEvidence,
      advance,
    })).rejects.toThrow("R2 HeadObject network outage");

    expect(recoverDeterministicFailure).not.toHaveBeenCalled();
    expect(publishEvidence).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
  });

  it("downgrades only typed deterministic artifact failures before durable advance", async () => {
    const evidence = { evidence_status: "historical_artifact_unrecoverable" };
    const publishEvidence = vi.fn().mockResolvedValue({ inserted: true });
    const advance = vi.fn();

    const result = await executeHistoricalBackfillStep({
      createEvidence: async () => {
        throw new DeterministicVisualArtifactError("Local retained artifact is unreadable.");
      },
      recoverDeterministicFailure: async () => ({ evidence, outcome: "unrecoverable" }),
      publishEvidence,
      advance,
    });

    expect(result.publication).toEqual({ inserted: true });
    expect(publishEvidence).toHaveBeenCalledWith(evidence);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("keeps dry runs local and never overwrites an immutable existing object", async () => {
    const dryRun = createDryRunPublishedArtifactStore("bucket-1");
    const body = Buffer.from("artifact");
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    await dryRun.put({ key: "key-1", body, contentType: "text/plain", sha256 });
    expect(await dryRun.head({ key: "key-1" })).toMatchObject({ byte_length: body.length, sha256 });

    const base = {
      bucket: "bucket-1",
      head: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFound" }))
        .mockResolvedValueOnce({ byte_length: body.length, sha256 }),
      put: vi.fn(),
      destroy: vi.fn(),
    };
    const immutable = createImmutablePublishedArtifactStore(base);
    await immutable.put({ key: "key-1", body, contentType: "text/plain", sha256 });
    await immutable.put({ key: "key-1", body, contentType: "text/plain", sha256 });

    expect(base.put).toHaveBeenCalledTimes(1);
  });
});

function eventRow(overrides = {}) {
  return {
    id: "event-1",
    shared_award_id: "award-1",
    shared_award_source_id: "source-1",
    previous_hash: `visual:${"a".repeat(64)}`,
    new_hash: `visual:${"b".repeat(64)}`,
    change_details: {},
    visual_review_candidate_id: null,
    ...overrides,
  };
}

function candidateRow(overrides = {}) {
  return {
    id: "candidate-1",
    shared_award_id: "award-1",
    shared_award_source_id: "source-1",
    candidate_signature: "signature-1",
    previous_file_hash: "a".repeat(64),
    new_file_hash: "b".repeat(64),
    previous_snapshot_ref: {},
    new_snapshot_ref: {},
    prompt_payload: {},
    deterministic_diff: {},
    worker_metadata: {},
    ...overrides,
  };
}

function preparedEvidence(candidate, {
  evidence_status = "unavailable_geometry_missing",
  previousStatus = "unavailable_geometry_missing",
  currentStatus = "unavailable_geometry_missing",
} = {}) {
  return {
    shared_award_id: candidate.shared_award_id,
    shared_award_source_id: candidate.shared_award_source_id,
    visual_review_candidate_id: candidate.id,
    candidate_signature: candidate.candidate_signature,
    bucket: "bucket-1",
    evidence_status,
    previous_capture: capture("previous"),
    current_capture: capture("current"),
    localization: {
      direction: "mixed",
      sides: {
        previous: { status: previousStatus, required: true, exact_overlap: false },
        current: { status: currentStatus, required: true, exact_overlap: false },
      },
    },
    evidence_schema_version: "visual-event-evidence-v1",
  };
}

function verifiedPreparedEvidence(candidate) {
  const evidence = preparedEvidence(candidate, {
    evidence_status: "verified",
    previousStatus: "verified",
    currentStatus: "verified",
  });
  for (const side of ["previous", "current"]) {
    const stateId = `${side}-state`;
    const full = {
      ...evidence[`${side}_capture`].full,
      width: 800,
      height: 600,
    };
    const geometryHash = side === "previous" ? "1".repeat(64) : "2".repeat(64);
    const geometry = {
      object_key: `visual-snapshots/published/candidate-1/${side}/layout.json`,
      sha256: side === "previous" ? "3".repeat(64) : "4".repeat(64),
      byte_length: 200,
      content_type: "application/json; charset=utf-8",
    };
    const layout = { ...geometry, state_id: stateId, geometry_hash: geometryHash };
    const cssRect = { x: 0, y: 0, width: 100, height: 50 };
    const pixelRect = { x: 0, y: 0, width: 100, height: 50 };
    evidence[`${side}_capture`] = {
      ...evidence[`${side}_capture`],
      full,
      captured_at: "2026-07-15T12:00:00.000Z",
      capture_hashes: {
        image_hash: side === "previous" ? "5".repeat(64) : "6".repeat(64),
        text_hash: side === "previous" ? "7".repeat(64) : "8".repeat(64),
      },
      state_id: stateId,
      layout,
      crop: {
        ...crop(side),
        clip: pixelRect,
        css_clip: cssRect,
        exact_overlap: true,
        state_id: stateId,
        source_image_object_key: full.object_key,
        source_image_sha256: full.sha256,
        source_image_byte_length: full.byte_length,
      },
      states: [{
        state_id: stateId,
        kind: "main",
        image: full,
        geometry,
        geometry_hash: geometryHash,
      }],
    };
    evidence.localization.sides[side] = {
      status: "verified",
      required: true,
      exact_text: "Exact changed wording",
      matched_rects: [{ x: 10, y: 10, width: 20, height: 10 }],
      crop_rect: cssRect,
      crop_rect_pixels: pixelRect,
      exact_overlap: true,
      reason: null,
      algorithm_version: "1",
      state_id: stateId,
    };
  }
  return evidence;
}

function capture(side) {
  return {
    full: {
      object_key: `visual-snapshots/published/candidate-1/${side}/full.jpg`,
      sha256: side === "previous" ? "c".repeat(64) : "d".repeat(64),
      byte_length: 100,
      content_type: "image/jpeg",
    },
    metadata: {
      object_key: `visual-snapshots/published/candidate-1/${side}/metadata.json`,
      sha256: "e".repeat(64),
      byte_length: 50,
      content_type: "application/json; charset=utf-8",
    },
    crop: null,
    layout: null,
    kind: "webpage",
  };
}

function crop(side) {
  return {
    object_key: `visual-snapshots/published/candidate-1/${side}/crop.jpg`,
    sha256: "f".repeat(64),
    byte_length: 25,
    content_type: "image/jpeg",
    width: 100,
    height: 50,
    clip: { x: 0, y: 0, width: 100, height: 50 },
    exact_overlap: true,
  };
}
