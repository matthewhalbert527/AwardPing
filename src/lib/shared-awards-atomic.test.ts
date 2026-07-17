import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));

import {
  selectTrackableSharedAwardSources,
  trackSharedAwardForOffice,
  untrackSharedAwardForOffice,
  untrackSharedAwardSourceForOffice,
} from "@/lib/shared-awards";

describe("atomic office award tracking client", () => {
  const rpc = vi.fn();
  const supabase = { rpc } as unknown as SupabaseClient<Database>;

  beforeEach(() => vi.clearAllMocks());

  it("deduplicates canonical URLs and prefers the canonical catalog source", () => {
    const selected = selectTrackableSharedAwardSources(
      [
        sharedSource({
          id: "alias-source",
          shared_award_id: "alias-award",
          url: "https://www.example.edu/apply/?utm_source=legacy",
        }),
        sharedSource({
          id: "canonical-source",
          shared_award_id: "canonical-award",
          url: "https://example.edu/apply",
        }),
      ],
      "canonical-award",
    );

    expect(selected.map((source) => source.id)).toEqual(["canonical-source"]);
  });

  it("sends sorted immutable source bindings with the release/member CAS", async () => {
    rpc.mockResolvedValue({
      data: {
        award: { id: "office-award" },
        sources: [],
        monitors: [],
        alreadyTracked: false,
      },
      error: null,
    });

    await trackSharedAwardForOffice({
      supabase,
      canonicalSharedAwardId: "canonical-award",
      officeId: "office",
      cadence: "daily",
      expectedMemberSharedAwardIds: ["canonical-award", "alias-award"],
      expectedReleaseEpoch: "release-epoch",
      sharedSources: [
        sharedSource({ id: "source-b", url: "https://example.edu/b" }),
        sharedSource({ id: "source-a", url: "https://example.edu/a" }),
      ],
    });

    expect(rpc).toHaveBeenCalledWith("track_office_shared_award_atomic", {
      p_office_id: "office",
      p_canonical_shared_award_id: "canonical-award",
      p_expected_member_shared_award_ids: [
        "canonical-award",
        "alias-award",
      ],
      p_expected_release_epoch: "release-epoch",
      p_expected_source_bindings: [
        expect.objectContaining({
          id: "source-a",
          shared_award_id: "canonical-award",
          url: "https://example.edu/a",
          updated_at: "2026-07-16T20:00:00.000Z",
        }),
        expect.objectContaining({
          id: "source-b",
          shared_award_id: "canonical-award",
          url: "https://example.edu/b",
          updated_at: "2026-07-16T20:00:00.000Z",
        }),
      ],
      p_cadence: "daily",
    });
  });

  it("passes optional publication CAS data to reversible award untracking", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, alreadyTracked: true, preserved: true },
      error: null,
    });

    await untrackSharedAwardForOffice({
      supabase,
      officeId: "office",
      requestedSharedAwardId: "alias-award",
      expectedMemberSharedAwardIds: ["canonical-award", "alias-award"],
      expectedReleaseEpoch: "release-epoch",
      validateReleaseEpoch: true,
    });

    expect(rpc).toHaveBeenCalledWith(
      "untrack_office_shared_award_atomic",
      {
        p_office_id: "office",
        p_requested_shared_award_id: "alias-award",
        p_expected_member_shared_award_ids: [
          "canonical-award",
          "alias-award",
        ],
        p_expected_release_epoch: "release-epoch",
        p_validate_release_epoch: true,
      },
    );
  });

  it("routes source untracking through its dedicated atomic RPC", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, tracked: false, preserved: true },
      error: null,
    });

    await untrackSharedAwardSourceForOffice({
      supabase,
      officeId: "office",
      requestedSharedAwardId: "canonical-award",
      sharedAwardSourceId: "source-a",
      expectedMemberSharedAwardIds: null,
      expectedReleaseEpoch: null,
      validateReleaseEpoch: false,
    });

    expect(rpc).toHaveBeenCalledWith(
      "untrack_office_shared_award_source_atomic",
      expect.objectContaining({
        p_office_id: "office",
        p_requested_shared_award_id: "canonical-award",
        p_shared_award_source_id: "source-a",
        p_validate_release_epoch: false,
      }),
    );
  });

  it("preserves the database conflict code for the route response", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "Stage 1 release changed." },
    });

    await expect(
      untrackSharedAwardForOffice({
        supabase,
        officeId: "office",
        requestedSharedAwardId: "canonical-award",
        expectedMemberSharedAwardIds: null,
        expectedReleaseEpoch: null,
        validateReleaseEpoch: false,
      }),
    ).rejects.toMatchObject({ code: "40001" });
  });
});

function sharedSource(overrides: Partial<SharedSource> = {}): SharedSource {
  const source: SharedSource = {
    id: "source",
    shared_award_id: "canonical-award",
    url: "https://example.edu",
    title: "Official source",
    display_title: null,
    page_description: null,
    page_metadata: {
      baseline_facts: {
        award_relevance: "primary",
        cycle_relevance: "evergreen",
        confidence: "high",
      },
    },
    page_metadata_generated_at: "2026-07-16T20:00:00.000Z",
    page_metadata_model: "review-model",
    page_type: "homepage",
    admin_review_note: null,
    admin_reviewed_at: null,
    admin_reviewed_by: null,
    confidence: 1,
    reason: "Reviewed official source",
    source: "admin",
    submitted_by_user_id: null,
    admin_review_status: "open",
    last_hash: null,
    last_checked_at: null,
    next_check_at: "2026-07-17T00:00:00.000Z",
    consecutive_failures: 0,
    last_error: null,
    created_at: "2026-07-16T19:00:00.000Z",
    updated_at: "2026-07-16T20:00:00.000Z",
  };
  return { ...source, ...overrides } as SharedSource;
}

type SharedSource =
  Database["public"]["Tables"]["shared_award_sources"]["Row"];
