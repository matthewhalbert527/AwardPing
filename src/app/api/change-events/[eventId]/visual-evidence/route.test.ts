import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createR2SignedReadUrl: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  getCurrentUser: vi.fn(),
  getR2Bucket: vi.fn(),
  getStage1PublicationEntryForAward: vi.fn(),
  hasR2Config: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  isStage1SourceIdentityExcluded: vi.fn(),
  tableFilters: {} as Record<string, Array<[string, unknown]>>,
  tableResults: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
vi.mock("@/lib/config", () => ({
  appConfig: { r2SignedUrlTtlSeconds: 900 },
  hasR2Config: mocks.hasR2Config,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/r2", () => ({
  createR2SignedReadUrl: mocks.createR2SignedReadUrl,
  getR2Bucket: mocks.getR2Bucket,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("@/lib/stage1-publication", () => ({
  getStage1PublicationEntryForAward: mocks.getStage1PublicationEntryForAward,
  isStage1SourceIdentityExcluded: mocks.isStage1SourceIdentityExcluded,
}));

import { GET } from "./route";
import {
  sha256VisualSemanticValue,
  visualChangeSemanticManifest,
} from "../../../../../../scripts/lib/visual-event-localization.mjs";

const eventId = "10000000-0000-4000-8000-000000000001";
const awardId = "20000000-0000-4000-8000-000000000002";
const sourceId = "30000000-0000-4000-8000-000000000003";
const candidateId = "40000000-0000-4000-8000-000000000004";
const routeChangeDetails = {
  change_type: "deadline_changed",
  exact_before: "Applications close October 1.",
};

describe("change event visual evidence route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.tableResults)) delete mocks.tableResults[key];
    for (const key of Object.keys(mocks.tableFilters)) delete mocks.tableFilters[key];

    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.hasR2Config.mockReturnValue(true);
    mocks.getR2Bucket.mockReturnValue("awardping-snapshots");
    mocks.getCurrentUser.mockResolvedValue({ id: "admin-1", email: "admin@example.test" });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.isStage1SourceIdentityExcluded.mockReturnValue(false);
    mocks.getStage1PublicationEntryForAward.mockResolvedValue({
      effectivelyVerified: true,
      canonicalAwardId: awardId,
      memberAwardIds: [awardId],
      allowedSourceIdSet: new Set([sourceId]),
      registry: { canonical_name: "Example Scholarship" },
      sourceIdentityRules: [],
    });
    mocks.createR2SignedReadUrl.mockImplementation(
      async (key: string) => `https://signed.example.test/${key}`,
    );
    mocks.from.mockImplementation((table: string) => queryFor(table));
    mocks.createSupabaseAdminClient.mockReturnValue({ from: mocks.from });
    mocks.tableResults.shared_award_change_events = { data: eventRow(), error: null };
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: evidenceRow(),
      error: null,
    };
  });

  it("signs only immutable event objects and exposes an exact crop on its verified side", async () => {
    const response = await requestEvent();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      change_event_id: eventId,
      evidence_scope: "change_event",
      localization_direction: "removed",
      source_id: sourceId,
      shared_award_id: awardId,
      latest: {
        exact_overlap: false,
        localization_status: "unavailable_ambiguous",
      },
      previous: {
        exact_overlap: true,
        localization_status: "verified",
      },
    });
    expect(payload.previous.objects.crop.key).toContain("/previous/crop.jpg");
    expect(payload.latest.objects.crop).toBeUndefined();

    const signedKeys = mocks.createR2SignedReadUrl.mock.calls.map(([key]) => key);
    expect(signedKeys).toContain(
      `visual-snapshots/published/${eventId}/previous/crop.jpg`,
    );
    expect(signedKeys).not.toContain(
      `visual-snapshots/published/${eventId}/current/crop.jpg`,
    );
    expect(signedKeys.every((key) => key.startsWith("visual-snapshots/published/"))).toBe(true);
  });

  it("fails closed when the manifest identity does not match the event", async () => {
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: evidenceRow({ shared_award_id: "different-award" }),
      error: null,
    };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
  });

  it("does not fall back to the mutable source snapshot when the event manifest is missing", async () => {
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: null,
      error: null,
    };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).not.toContain(
      "shared_award_source_visual_snapshots",
    );
  });

  it("rejects malformed event IDs before querying the service-role client", async () => {
    const response = await GET(
      new Request("https://awardping.test/api/change-events/not-a-uuid/visual-evidence"),
      { params: Promise.resolve({ eventId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
  });

  it("requires a public event to belong to a verified cohort and open source", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_award_sources = { data: null, error: null };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(
      expect.arrayContaining(["shared_award_sources"]),
    );
    expect(mocks.from.mock.calls.map(([table]) => table)).not.toContain("shared_awards");
  });

  it("authorizes a public event through the immutable registry and allowed open source", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_award_sources = { data: sourceRow(), error: null };

    const response = await requestEvent();

    expect(response.status).toBe(200);
    expect(mocks.tableFilters.shared_award_sources).toEqual(
      expect.arrayContaining([
        ["id", sourceId],
        ["shared_award_id", awardId],
        ["admin_review_status", "open"],
      ]),
    );
  });

  it("does not expose a suppressed event to non-admin viewers", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "user@example.test" });
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_award_change_events = {
      data: eventRow({ suppressed_at: "2026-07-15T02:00:00.000Z" }),
      error: null,
    };

    const response = await requestEvent();

    expect(response.status).toBe(403);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
  });

  it("does not expose evidence bound to a different visual-review candidate", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_award_sources = { data: sourceRow(), error: null };
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: evidenceRow({
        visual_review_candidate_id: "50000000-0000-4000-8000-000000000005",
      }),
      error: null,
    };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
  });

  it("does not expose an event from an award outside the verified beta", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.getStage1PublicationEntryForAward.mockResolvedValue(null);
    mocks.tableResults.shared_award_sources = { data: sourceRow(), error: null };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
  });

  it("converts a retained v1 crop into an honest event-specific full-screenshot fallback", async () => {
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: evidenceRow({ evidence_schema_version: "visual-event-evidence-v1" }),
      error: null,
    };

    const response = await requestEvent();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      evidence_status: "full_screenshot_fallback",
      stored_evidence_status: "verified",
      previous: {
        exact_overlap: false,
        localization_status: "full_screenshot_fallback",
      },
    });
    expect(payload.previous.objects.crop).toBeUndefined();
    expect(payload.previous.objects.full).toBeTruthy();
    expect(payload.previous.localization_reason).toMatch(/predates event-semantic/i);
  });

  it("lets an admin inspect retained historical evidence when the source row is gone", async () => {
    mocks.tableResults.shared_award_change_events = {
      data: eventRow({ shared_award_source_id: null }),
      error: null,
    };
    mocks.tableResults.shared_award_change_event_visual_evidence = {
      data: evidenceRow({ shared_award_source_id: null }),
      error: null,
    };

    const response = await requestEvent();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source_id).toBeNull();
    expect(mocks.createR2SignedReadUrl).toHaveBeenCalled();
  });
});

function queryFor(table: string) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () =>
      mocks.tableResults[table] || { data: null, error: null },
    ),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockImplementation((column: string, value: unknown) => {
    (mocks.tableFilters[table] ||= []).push([column, value]);
    return builder;
  });
  return builder;
}

function requestEvent() {
  return GET(
    new Request(`https://awardping.test/api/change-events/${eventId}/visual-evidence`),
    { params: Promise.resolve({ eventId }) },
  );
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: eventId,
    shared_award_id: awardId,
    shared_award_source_id: sourceId,
    source_url: "https://example.edu/award",
    source_title: "Award deadline",
    source_page_type: "deadline",
    summary: "The application deadline changed from October 1 to October 8.",
    change_details: routeChangeDetails,
    suppressed_at: null,
    suppression_reason: null,
    suppression_source: null,
    visual_review_candidate_id: candidateId,
    ...overrides,
  };
}

function sourceRow() {
  return {
    id: sourceId,
    shared_award_id: awardId,
    admin_review_status: "open",
    url: "https://example.edu/award",
    title: "Award deadline",
    display_title: "Award deadline",
    page_type: "deadline",
    source: "admin",
    reason: "Official deadline page.",
    submitted_by_user_id: null,
    page_metadata_generated_at: "2026-07-15T00:00:00.000Z",
    page_metadata_model: "review-model",
    page_metadata: {
      baseline_facts: {
        award_relevance: "primary",
        cycle_relevance: "current-or-upcoming",
        confidence: "high",
      },
    },
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  const semantic = semanticEvidenceParts();
  return {
    id: "60000000-0000-4000-8000-000000000006",
    change_event_id: eventId,
    shared_award_id: awardId,
    shared_award_source_id: sourceId,
    visual_review_candidate_id: candidateId,
    candidate_signature: "verified-review-candidate",
    bucket: "awardping-snapshots",
    evidence_status: "verified",
    evidence_schema_version: "visual-event-evidence-v2",
    created_at: "2026-07-15T01:00:00.000Z",
    verified_at: "2026-07-15T01:05:00.000Z",
    backfilled_at: null,
    ...semantic,
    ...overrides,
  };
}

function capture(
  side: "previous" | "current",
  exactOverlap: boolean,
  semanticBinding: Record<string, unknown> | null = null,
) {
  const base = `visual-snapshots/published/${eventId}/${side}`;
  const stateId = `state-${side}`;
  const clip = { x: 10, y: 20, width: 300, height: 120 };
  const full = {
    object_key: `${base}/full.jpg`,
    sha256: side === "previous" ? "a".repeat(64) : "b".repeat(64),
    byte_length: 12_000,
    content_type: "image/jpeg",
    width: 1200,
    height: 4800,
  };
  return {
    captured_at: "2026-07-15T01:00:00.000Z",
    state_id: stateId,
    full,
    metadata: {
      object_key: `${base}/meta.json`,
      sha256: side === "previous" ? "c".repeat(64) : "d".repeat(64),
      content_type: "application/json",
    },
    layout: {
      object_key: `${base}/layout.json`,
      sha256: side === "previous" ? "1".repeat(64) : "2".repeat(64),
      content_type: "application/json",
      state_id: stateId,
      geometry_hash: side === "previous" ? "1".repeat(64) : "2".repeat(64),
    },
    crop: {
      object_key: `${base}/crop.jpg`,
      sha256: side === "previous" ? "e".repeat(64) : "f".repeat(64),
      content_type: "image/jpeg",
      width: 900,
      height: 500,
      exact_overlap: exactOverlap,
      state_id: stateId,
      clip,
      css_clip: clip,
      source_image_object_key: full.object_key,
      source_image_sha256: full.sha256,
      source_image_byte_length: full.byte_length,
      semantic_binding_sha256: semanticBinding?.binding_sha256,
      exact_text_sha256: semanticBinding?.exact_text_sha256,
      geometry_sha256: semanticBinding?.geometry_sha256,
    },
  };
}

function semanticEvidenceParts() {
  const rect = { x: 10, y: 20, width: 300, height: 120 };
  const manifest = visualChangeSemanticManifest(routeChangeDetails);
  const candidate = manifest.sides.previous.candidates[0] as {
    source: string;
    normalized_text: string;
    normalized_text_sha256: string;
  };
  const bindingCore = {
    contract: "visual-exact-text-binding-v2",
    algorithm_version: 3,
    side: "previous",
    wording_source: candidate.source,
    exact_text_sha256: candidate.normalized_text_sha256,
    candidates_sha256: manifest.sides.previous.candidates_sha256,
    change_semantics_sha256: manifest.change_semantics_sha256,
    state_id: "state-previous",
    geometry_sha256: "1".repeat(64),
    matched_node_orders: [0],
    matched_rects_sha256: sha256VisualSemanticValue([rect]),
    crop_rect_sha256: sha256VisualSemanticValue(rect),
    crop_rect_pixels_sha256: sha256VisualSemanticValue(rect),
  };
  const binding = {
    ...bindingCore,
    binding_sha256: sha256VisualSemanticValue(bindingCore),
  };
  return {
    previous_capture: capture("previous", true, binding),
    current_capture: capture("current", true),
    localization: {
      direction: "removed",
      semantic_contract: manifest.contract,
      change_semantics_sha256: manifest.change_semantics_sha256,
      sides: {
        previous: {
          status: "verified",
          exact_overlap: true,
          exact_text: candidate.normalized_text,
          matched_rects: [rect],
          crop_rect: rect,
          crop_rect_pixels: rect,
          algorithm_version: "3",
          state_id: "state-previous",
          reason: "Removed wording has verified exact overlap.",
          semantic_verified: true,
          semantic_binding: binding,
        },
        current: {
          status: "unavailable_ambiguous",
          exact_overlap: false,
          reason: "The added wording location is ambiguous.",
        },
      },
    },
  };
}
