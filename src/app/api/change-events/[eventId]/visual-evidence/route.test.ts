import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createR2SignedReadUrl: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  getCurrentUser: vi.fn(),
  getR2Bucket: vi.fn(),
  hasR2Config: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  isSiteAdminEmail: vi.fn(),
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

import { GET } from "./route";

const eventId = "10000000-0000-4000-8000-000000000001";
const awardId = "20000000-0000-4000-8000-000000000002";
const sourceId = "30000000-0000-4000-8000-000000000003";

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

  it("requires a public event to belong to an active award and open source", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_awards = { data: { id: awardId }, error: null };
    mocks.tableResults.shared_award_sources = { data: null, error: null };

    const response = await requestEvent();

    expect(response.status).toBe(404);
    expect(mocks.createR2SignedReadUrl).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(
      expect.arrayContaining(["shared_awards", "shared_award_sources"]),
    );
  });

  it("authorizes a public event through the exact active award and open source", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
    mocks.tableResults.shared_awards = { data: { id: awardId }, error: null };
    mocks.tableResults.shared_award_sources = { data: { id: sourceId }, error: null };

    const response = await requestEvent();

    expect(response.status).toBe(200);
    expect(mocks.tableFilters.shared_awards).toEqual(
      expect.arrayContaining([
        ["id", awardId],
        ["status", "active"],
      ]),
    );
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
    suppressed_at: null,
    ...overrides,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    change_event_id: eventId,
    shared_award_id: awardId,
    shared_award_source_id: sourceId,
    bucket: "awardping-snapshots",
    evidence_status: "verified",
    evidence_schema_version: "visual-event-evidence-v1",
    previous_capture: capture("previous", true),
    current_capture: capture("current", true),
    localization: {
      direction: "removed",
      sides: {
        previous: {
          status: "verified",
          exact_overlap: true,
          reason: "Removed wording has verified exact overlap.",
        },
        current: {
          status: "unavailable_ambiguous",
          exact_overlap: false,
          reason: "The added wording location is ambiguous.",
        },
      },
    },
    ...overrides,
  };
}

function capture(side: "previous" | "current", exactOverlap: boolean) {
  const base = `visual-snapshots/published/${eventId}/${side}`;
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
    state_id: `state-${side}`,
    full,
    metadata: {
      object_key: `${base}/meta.json`,
      content_type: "application/json",
    },
    crop: {
      object_key: `${base}/crop.jpg`,
      content_type: "image/jpeg",
      width: 900,
      height: 500,
      exact_overlap: exactOverlap,
      source_image_object_key: full.object_key,
      source_image_sha256: full.sha256,
      source_image_byte_length: full.byte_length,
    },
  };
}
