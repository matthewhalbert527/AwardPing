import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  eventVisualEvidencePresentation,
  isPublicChangeEvent,
  type PublicChangeEventVisualEvidence,
} from "@/lib/public-change-event";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";
import {
  sha256VisualSemanticValue,
  visualChangeSemanticManifest,
} from "../../scripts/lib/visual-event-localization.mjs";

const defaultChangeDetails = {
  change_type: "deadline_changed",
  exact_before: "Applications close October 1.",
  exact_after: "Applications close October 8.",
};

describe("public change-event eligibility", () => {
  it("allows a useful unsuppressed event only for a verified active award and reviewed source", () => {
    expect(isPublicChangeEvent(publicFixture())).toBe(true);
  });

  it("rejects column and legacy nested suppression", () => {
    expect(
      isPublicChangeEvent(
        publicFixture({ event: { suppressed_at: "2026-07-16T18:00:00.000Z" } }),
      ),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({
          event: {
            change_details: {
              suppression_reason: "layout_noise",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects unpublished awards, mismatched sources, and quality failures", () => {
    expect(
      isPublicChangeEvent(publicFixture({ effectivelyVerified: false })),
    ).toBe(false);
    expect(
      isPublicChangeEvent(publicFixture({ identityExcluded: true })),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({ allowedSourceIds: [] }),
      ),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({ source: { shared_award_id: "another-award" } }),
      ),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({
          event: { source_url: "https://example.edu/stale-eligibility" },
        }),
      ),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({
          source: {
            page_metadata: {
              baseline_facts: {
                award_relevance: "unclear",
                cycle_relevance: "unclear",
                confidence: "low",
              },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects an excluded immutable event identity even if the current source looks safe", () => {
    expect(
      isPublicChangeEvent(
        publicFixture({
          identityExcluded: true,
          event: {
            source_url: "https://example.edu/marshall-sherfield/apply",
            source_title: "Marshall Sherfield postdoctoral fellowship",
          },
        }),
      ),
    ).toBe(false);
  });

  it("requires visual evidence to be bound to the exact event and review candidate", () => {
    expect(isPublicChangeEvent(publicFixture({ evidence: null }))).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({ evidence: { change_event_id: "different-event" } }),
      ),
    ).toBe(false);
    expect(
      isPublicChangeEvent(
        publicFixture({ evidence: { visual_review_candidate_id: "different-candidate" } }),
      ),
    ).toBe(false);
  });

  it("uses an exact crop only on semantically verified sides and otherwise keeps an honest full fallback", () => {
    const withoutCrop = (side: "previous" | "current", details: Record<string, unknown>) => {
      const capture = verifiedCapture(side, details);
      delete (capture as { crop?: unknown }).crop;
      return capture;
    };

    const addedDetails = changeDetailsForDirection("added");
    const addedWithoutPrevious = publicFixture({
      event: { change_details: addedDetails },
      evidence: {
        ...verifiedEvidenceForDirection("added", addedDetails),
        previous_capture: withoutCrop("previous", addedDetails),
      },
    });
    expect(isPublicChangeEvent(addedWithoutPrevious)).toBe(true);
    expect(eventVisualEvidencePresentation(
      addedWithoutPrevious.event,
      addedWithoutPrevious.evidence!,
    ).exactCropAllowed).toBe(true);

    for (const [direction, missingSide] of [
      ["added", "current"],
      ["removed", "previous"],
      ["changed", "current"],
    ] as const) {
      const details = changeDetailsForDirection(direction);
      const fixture = publicFixture({
        event: { change_details: details },
        evidence: {
          ...verifiedEvidenceForDirection(direction, details),
          [`${missingSide}_capture`]: withoutCrop(missingSide, details),
        },
      });
      expect(isPublicChangeEvent(fixture)).toBe(true);
      expect(eventVisualEvidencePresentation(fixture.event, fixture.evidence!)).toMatchObject({
        evidenceStatus: "full_screenshot_fallback",
        exactCropAllowed: false,
      });
    }
  });

  it("permits only an honest event-specific full-screenshot fallback", () => {
    const fallbackSide = {
      status: "full_screenshot_fallback",
      exact_overlap: false,
      reason: "Exact wording rectangle was unavailable after page expansion.",
    };
    expect(
      isPublicChangeEvent(
        publicFixture({
          evidence: {
            evidence_status: "full_screenshot_fallback",
            verified_at: null,
            localization: {
              direction: "changed",
              sides: { previous: fallbackSide, current: fallbackSide },
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isPublicChangeEvent(
        publicFixture({
          evidence: {
            evidence_status: "full_screenshot_fallback",
            verified_at: null,
            localization: {
              direction: "changed",
              sides: { previous: fallbackSide, current: { status: "verified" } },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("permits truthfully terminal historical loss without inventing a crop", () => {
    const unavailableSide = {
      status: "historical_artifact_unrecoverable",
      reason: "The retained candidate artifact no longer exists.",
    };
    expect(
      isPublicChangeEvent(
        publicFixture({
          event: { visual_review_candidate_id: null },
          evidence: {
            visual_review_candidate_id: null,
            evidence_status: "historical_artifact_unrecoverable",
            backfilled_at: "2026-07-16T19:00:00.000Z",
            localization: {
              terminal_artifact_loss_confirmed: true,
              sides: { previous: unavailableSide, current: unavailableSide },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("publishes a first-observed official document only with its immutable attestation and current PDF", () => {
    const firstObservation = publicFixture({
      event: {
        source_page_type: "pdf",
        change_details: {
          event_kind: "new_official_document",
          candidate_scope: "initial_official_document",
          observation_kind: "first_observation",
          first_observation: true,
          candidate_signature: "candidate-signature",
          exact_after: "Official 2027 application guidance.",
        },
      },
      evidence: initialDocumentEvidence(),
    });

    expect(isPublicChangeEvent(firstObservation)).toBe(true);
    expect(
      isPublicChangeEvent(publicFixture({
        event: firstObservation.event,
        evidence: {
          ...initialDocumentEvidence(),
          previous_capture: {},
        },
      })),
    ).toBe(false);
  });
});

function publicFixture(overrides: {
  effectivelyVerified?: boolean;
  identityExcluded?: boolean;
  allowedSourceIds?: string[];
  event?: Record<string, unknown>;
  award?: Record<string, unknown>;
  source?: Record<string, unknown>;
  evidence?: Record<string, unknown> | null;
} = {}) {
  const allowedSourceIds = overrides.allowedSourceIds ?? ["source-1"];
  const eventChangeDetails = overrides.event?.change_details &&
      typeof overrides.event.change_details === "object" &&
      !Array.isArray(overrides.event.change_details)
    ? overrides.event.change_details as Record<string, unknown>
    : defaultChangeDetails;
  const publication = {
    registry: {
      cohort_key: "example",
      launch_rank: 1,
      canonical_name: "Example Scholarship",
      canonical_shared_award_id: "award-1",
      canonical_slug: "example-scholarship",
      official_homepage: "https://example.edu/award/",
      publication_state: "verified_beta",
      state_reason: "Verified fixture.",
      policy_version: "stage1-publication-v1",
      fact_ledger_batch_id: "batch-1",
      release_epoch: "11111111-1111-4111-8111-111111111111",
      evidence_checked_at: "2026-07-16T18:00:00.000Z",
      last_verified_at: "2026-07-16T18:00:00.000Z",
      created_at: "2026-07-16T18:00:00.000Z",
      updated_at: "2026-07-16T18:00:00.000Z",
    },
    canonicalAwardId: "award-1",
    memberAwardIds: ["award-1"],
    allowedSourceIds,
    allowedSourceIdSet: new Set(allowedSourceIds),
    publishedFacts: { overview: "Verified overview." },
    officialHomepageSourceId: "source-1",
    officialHomepageUrl: "https://example.edu/award/",
    sourceIdentityRules: overrides.identityExcluded
      ? [{
          id: 1,
          cohort_key: "example",
          rule_key: "exclude_sibling",
          url_pattern: "marshall-sherfield",
          title_pattern: "application deadline|sherfield|postdoctoral",
          reason: "Separate sibling program.",
          policy_version: "stage1-publication-v1",
          created_at: "2026-07-16T18:00:00.000Z",
          updated_at: "2026-07-16T18:00:00.000Z",
        }]
      : [],
    effectiveReason: overrides.effectivelyVerified === false ? "state_pending" : "verified",
    evaluatedAt: "2026-07-16T18:00:00.000Z",
    effectivelyVerified: overrides.effectivelyVerified ?? true,
  } as Stage1PublicationEntry;
  const evidence: PublicChangeEventVisualEvidence | null = overrides.evidence === null
    ? null
    : ({
        id: "evidence-1",
        change_event_id: "event-1",
        shared_award_id: "award-1",
        shared_award_source_id: "source-1",
        visual_review_candidate_id: "candidate-1",
        candidate_signature: "candidate-signature",
        bucket: "awardping-evidence",
        evidence_status: "verified",
        ...verifiedEvidenceForDirection("changed", eventChangeDetails),
        created_at: "2026-07-16T18:00:00.000Z",
        verified_at: "2026-07-16T18:05:00.000Z",
        backfilled_at: null,
        ...overrides.evidence,
      } as PublicChangeEventVisualEvidence);

  return {
    publication,
    event: {
      id: "event-1",
      shared_award_id: "award-1",
      shared_award_source_id: "source-1",
      source_title: "Application deadline",
      source_url: "https://example.edu/award/deadline",
      source_page_type: "deadline",
      summary: "The application deadline changed from October 1 to October 8.",
      change_details: defaultChangeDetails,
      suppressed_at: null,
      suppression_reason: null,
      suppression_source: null,
      visual_review_candidate_id: "candidate-1",
      ...overrides.event,
    },
    award: {
      id: "award-1",
      name: "Example Scholarship",
      status: "active",
      ...overrides.award,
    },
    source: {
      id: "source-1",
      shared_award_id: "award-1",
      admin_review_status: "open",
      url: "https://example.edu/award/deadline",
      title: "Application deadline",
      display_title: "Application deadline",
      page_type: "deadline",
      source: "admin",
      reason: "Official application deadline page.",
      submitted_by_user_id: null,
      page_metadata_generated_at: "2026-07-16T18:00:00.000Z",
      page_metadata_model: "review-model",
      page_metadata: {
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "current-or-upcoming",
          confidence: "high",
        },
      },
      ...overrides.source,
    },
    evidence,
  };
}

function verifiedCapture(
  side: "previous" | "current",
  changeDetails: Record<string, unknown> = defaultChangeDetails,
) {
  const fullKey = `visual-snapshots/published/event-1/${side}/full.png`;
  const stateId = `state-${side}`;
  const cssClip = { x: 10, y: 20, width: 300, height: 120 };
  const localization = verifiedLocalization(side, changeDetails);
  const semanticBinding = localization.semantic_binding;
  const geometryHash = side === "previous" ? "1".repeat(64) : "2".repeat(64);
  return {
    captured_at: "2026-07-16T18:00:00.000Z",
    state_id: stateId,
    full: {
      object_key: fullKey,
      sha256: "a".repeat(64),
    },
    metadata: {
      object_key: `visual-snapshots/published/event-1/${side}/metadata.json`,
      sha256: "b".repeat(64),
    },
    layout: {
      object_key: `visual-snapshots/published/event-1/${side}/layout.json`,
      sha256: "d".repeat(64),
      state_id: stateId,
      geometry_hash: geometryHash,
    },
    crop: {
      object_key: `visual-snapshots/published/event-1/${side}/crop.png`,
      sha256: "c".repeat(64),
      exact_overlap: true,
      state_id: stateId,
      clip: cssClip,
      css_clip: cssClip,
      source_image_object_key: fullKey,
      source_image_sha256: "a".repeat(64),
      semantic_binding_sha256: semanticBinding?.binding_sha256,
      exact_text_sha256: semanticBinding?.exact_text_sha256,
      geometry_sha256: semanticBinding?.geometry_sha256,
    },
  };
}

function verifiedLocalization(
  side: "previous" | "current",
  changeDetails: Record<string, unknown> = defaultChangeDetails,
) {
  const rect = { x: 10, y: 20, width: 300, height: 120 };
  const manifest = visualChangeSemanticManifest(changeDetails);
  const candidate = manifest.sides[side].candidates[0] as {
    source: string;
    normalized_text: string;
    normalized_text_sha256: string;
  } | undefined;
  const geometryHash = side === "previous" ? "1".repeat(64) : "2".repeat(64);
  const bindingCore = candidate ? {
    contract: "visual-exact-text-binding-v2",
    algorithm_version: 3,
    side,
    wording_source: candidate.source,
    exact_text_sha256: candidate.normalized_text_sha256,
    candidates_sha256: manifest.sides[side].candidates_sha256,
    change_semantics_sha256: manifest.change_semantics_sha256,
    state_id: `state-${side}`,
    geometry_sha256: geometryHash,
    matched_node_orders: [0],
    matched_rects_sha256: sha256VisualSemanticValue([rect]),
    crop_rect_sha256: sha256VisualSemanticValue(rect),
    crop_rect_pixels_sha256: sha256VisualSemanticValue(rect),
  } : null;
  return {
    status: "verified",
    exact_text: candidate?.normalized_text || null,
    matched_rects: [rect],
    crop_rect: rect,
    crop_rect_pixels: rect,
    exact_overlap: true,
    algorithm_version: "3",
    state_id: `state-${side}`,
    semantic_verified: Boolean(bindingCore),
    semantic_binding: bindingCore ? {
      ...bindingCore,
      binding_sha256: sha256VisualSemanticValue(bindingCore),
    } : null,
  };
}

function verifiedLocalizationManifest(
  direction: "added" | "removed" | "changed",
  changeDetails: Record<string, unknown> = changeDetailsForDirection(direction),
) {
  const manifest = visualChangeSemanticManifest(changeDetails);
  return {
    direction,
    semantic_contract: manifest.contract,
    change_semantics_sha256: manifest.change_semantics_sha256,
    sides: {
      previous: verifiedLocalization("previous", changeDetails),
      current: verifiedLocalization("current", changeDetails),
    },
  };
}

function changeDetailsForDirection(direction: "added" | "removed" | "changed") {
  return {
    change_type: "deadline_changed",
    ...(direction !== "added" ? { exact_before: defaultChangeDetails.exact_before } : {}),
    ...(direction !== "removed" ? { exact_after: defaultChangeDetails.exact_after } : {}),
  };
}

function verifiedEvidenceForDirection(
  direction: "added" | "removed" | "changed",
  changeDetails: Record<string, unknown> = changeDetailsForDirection(direction),
) {
  return {
    previous_capture: verifiedCapture("previous", changeDetails),
    current_capture: verifiedCapture("current", changeDetails),
    localization: verifiedLocalizationManifest(direction, changeDetails),
    evidence_schema_version: "visual-event-evidence-v2",
  };
}

function initialDocumentEvidence() {
  const attestationSha = "8".repeat(64);
  return {
    evidence_status: "not_applicable_new_document",
    verified_at: null,
    backfilled_at: null,
    previous_capture: {
      kind: "first_observation_attestation",
      state_id: "first-observation",
      full: null,
      captured_at: "2026-07-16T18:00:00.000Z",
      metadata: {
        object_key: "visual-snapshots/published/event-1/previous/attestation.json",
        sha256: attestationSha,
        content_type: "application/json; charset=utf-8",
      },
      capture_hashes: { attestation_hash: attestationSha },
    },
    current_capture: {
      kind: "pdf",
      state_id: "document",
      captured_at: "2026-07-16T18:00:00.000Z",
      full: {
        object_key: "visual-snapshots/published/event-1/current/document.pdf",
        sha256: "9".repeat(64),
        content_type: "application/pdf",
      },
      metadata: {
        object_key: "visual-snapshots/published/event-1/current/metadata.json",
        sha256: "7".repeat(64),
        content_type: "application/json",
      },
    },
    localization: {
      direction: "added",
      sides: {
        previous: {
          status: "not_applicable_first_observation",
          required: false,
          reason: "No earlier AwardPing capture exists; the attestation is retained.",
        },
        current: {
          status: "not_applicable_pdf",
          reason: "The exact current official PDF is retained.",
        },
      },
    },
  };
}
