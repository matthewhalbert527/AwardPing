import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  isPublicChangeEvent: vi.fn(() => true),
  loadPublicEventVisualEvidence: vi.fn(async (_admin, eventIds: string[]) =>
    new Map(eventIds.map((id) => [id, { change_event_id: id }]))
  ),
}));

vi.mock("@/lib/public-change-event", () => ({
  isPublicChangeEvent: mocks.isPublicChangeEvent,
}));
vi.mock("@/lib/public-event-visual-evidence", () => ({
  loadPublicEventVisualEvidence: mocks.loadPublicEventVisualEvidence,
}));

import {
  comparePublicChangeEventsNewestFirst,
  dedupeEligiblePublicChangeEvents,
  loadEligiblePublicChangeEvents,
  publicChangeEventCursorFilter,
  type EligiblePublicChangeEvent,
  type PublicChangeEventRow,
} from "@/lib/public-change-events";
import type {
  Stage1PublicationEntry,
  Stage1PublicationIndex,
} from "@/lib/stage1-publication";

const canonicalAwardId = "10000000-0000-4000-8000-000000000001";
const memberAwardId = "20000000-0000-4000-8000-000000000001";
const allowedSourceId = "30000000-0000-4000-8000-000000000001";
const invalidSourceId = "30000000-0000-4000-8000-000000000002";

describe("loadEligiblePublicChangeEvents", () => {
  beforeEach(() => {
    mocks.isPublicChangeEvent.mockClear();
    mocks.loadPublicEventVisualEvidence.mockClear();
  });

  it("continues past invalid newer rows instead of starving an older valid update", async () => {
    const firstPage = [
      eventRow("2026-07-16T18:00:00.000Z", 4, invalidSourceId),
      eventRow("2026-07-16T17:00:00.000Z", 3, invalidSourceId),
    ];
    const eligible = eventRow(
      "2026-07-16T16:00:00.000Z",
      2,
      allowedSourceId,
    );
    const admin = fakeAdmin([[...firstPage], [eligible]], [sourceRow()]);

    const result = await loadEligiblePublicChangeEvents({
      admin: admin.client,
      publicationIndex: publicationIndex(),
      limit: 1,
      pageSize: 2,
      maxScannedRows: 10,
    });

    expect(result.map((entry) => entry.event.id)).toEqual([eligible.id]);
    expect(admin.changePageCalls).toBe(2);
    expect(admin.cursorFilters).toEqual([
      publicChangeEventCursorFilter(firstPage[1]),
    ]);
    expect(admin.changeInFilters).toContainEqual({
      column: "shared_award_source_id",
      values: [allowedSourceId],
    });
    expect(mocks.isPublicChangeEvent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the scan cap is crossed before enough eligible rows exist", async () => {
    const firstPage = [
      eventRow("2026-07-16T18:00:00.000Z", 4, invalidSourceId),
      eventRow("2026-07-16T17:00:00.000Z", 3, invalidSourceId),
    ];
    const beyondCap = eventRow(
      "2026-07-16T16:00:00.000Z",
      2,
      invalidSourceId,
    );
    const admin = fakeAdmin([firstPage, [beyondCap]], []);

    await expect(
      loadEligiblePublicChangeEvents({
        admin: admin.client,
        publicationIndex: publicationIndex(),
        limit: 1,
        pageSize: 2,
        maxScannedRows: 2,
      }),
    ).rejects.toThrow("exceeded 2 rows before the result was proven complete");
  });

  it("uses an empty probe to prove an exhaustive result ending exactly at the cap", async () => {
    const page = [
      eventRow("2026-07-16T18:00:00.000Z", 4, allowedSourceId),
      eventRow("2026-07-16T17:00:00.000Z", 3, allowedSourceId),
    ];
    const admin = fakeAdmin([page, []], [sourceRow()]);

    const result = await loadEligiblePublicChangeEvents({
      admin: admin.client,
      publicationIndex: publicationIndex(),
      limit: null,
      pageSize: 2,
      maxScannedRows: 2,
    });

    expect(result).toHaveLength(2);
    expect(admin.changePageCalls).toBe(2);
  });

  it("rejects a non-descending keyset page", async () => {
    const page = [
      eventRow("2026-07-16T17:00:00.000Z", 3, invalidSourceId),
      eventRow("2026-07-16T18:00:00.000Z", 4, invalidSourceId),
    ];
    const admin = fakeAdmin([page], []);

    await expect(
      loadEligiblePublicChangeEvents({
        admin: admin.client,
        publicationIndex: publicationIndex(),
        limit: 1,
        pageSize: 2,
      }),
    ).rejects.toThrow("not strictly descending");
  });

  it("rejects a release epoch that changes before the result is returned", async () => {
    const eligible = eventRow(
      "2026-07-16T18:00:00.123456Z",
      4,
      allowedSourceId,
    );
    const admin = fakeAdmin([[eligible]], [sourceRow()], {
      releaseEpoch: "60000000-0000-4000-8000-000000000002",
    });

    await expect(
      loadEligiblePublicChangeEvents({
        admin: admin.client,
        publicationIndex: publicationIndex(),
        limit: 1,
        pageSize: 2,
      }),
    ).rejects.toThrow("release changed while updates were loading");
  });

  it("orders distinct PostgreSQL microseconds without falling back to UUID order", async () => {
    const newer = eventRow(
      "2026-07-16T18:00:00.123456Z",
      2,
      allowedSourceId,
    );
    const older = eventRow(
      "2026-07-16T18:00:00.123455Z",
      9,
      allowedSourceId,
    );
    const admin = fakeAdmin([[newer, older]], [sourceRow()]);

    const result = await loadEligiblePublicChangeEvents({
      admin: admin.client,
      publicationIndex: publicationIndex(),
      limit: 2,
      pageSize: 2,
    });

    expect(result.map((entry) => entry.event.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("fetches a deep-linked event by id through the same member, source, evidence and predicate gates", async () => {
    const requested = eventRow("2026-07-10T09:00:00.000Z", 9, allowedSourceId);
    const admin = fakeAdmin([[requested]], [sourceRow()]);

    const result = await loadEligiblePublicChangeEvents({
      admin: admin.client,
      publicationIndex: publicationIndex(),
      limit: 1,
      memberAwardIds: [memberAwardId],
      eventIds: [requested.id],
    });

    expect(result.map((entry) => entry.event.id)).toEqual([requested.id]);
    expect(admin.changeInFilters).toEqual([
      { column: "shared_award_id", values: [memberAwardId] },
      { column: "shared_award_source_id", values: [allowedSourceId] },
      { column: "id", values: [requested.id] },
    ]);
    expect(admin.changePageCalls).toBe(1);
    expect(mocks.loadPublicEventVisualEvidence).toHaveBeenCalledWith(admin.client, [requested.id]);
    expect(mocks.isPublicChangeEvent).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for a deep-linked id the gates reject", async () => {
    const index = publicationIndex();
    const load = (
      admin: ReturnType<typeof fakeAdmin>,
      overrides: Partial<Parameters<typeof loadEligiblePublicChangeEvents>[0]> = {},
    ) =>
      loadEligiblePublicChangeEvents({
        admin: admin.client,
        publicationIndex: index,
        limit: 1,
        memberAwardIds: [memberAwardId],
        ...overrides,
      });

    // Suppressed: the row carries suppressed_at, and the public predicate (the
    // same one the recent list consults; its suppression rule has its own
    // tests) returns false for it.
    const suppressed = {
      ...eventRow("2026-07-10T09:00:00.000Z", 9, allowedSourceId),
      suppressed_at: "2026-07-11T00:00:00.000Z",
      suppression_reason: "duplicate",
    };
    mocks.isPublicChangeEvent.mockReturnValueOnce(false);
    expect(await load(fakeAdmin([[suppressed]], [sourceRow()]), { eventIds: [suppressed.id] })).toEqual([]);
    expect(mocks.isPublicChangeEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ id: suppressed.id, suppressed_at: suppressed.suppressed_at }) }),
    );

    // Wrong award: the row belongs to an award outside the publication index.
    const stranger = {
      ...eventRow("2026-07-10T09:00:00.000Z", 9, allowedSourceId),
      shared_award_id: "20000000-0000-4000-8000-000000000009",
    };
    expect(await load(fakeAdmin([[stranger]], [sourceRow()]), { eventIds: [stranger.id] })).toEqual([]);

    // Wrong award: the requesting page's member awards do not include the
    // event's award, so no page query is even issued.
    const requested = eventRow("2026-07-10T09:00:00.000Z", 9, allowedSourceId);
    const otherAwardAdmin = fakeAdmin([[requested]], [sourceRow()]);
    expect(
      await load(otherAwardAdmin, {
        memberAwardIds: ["20000000-0000-4000-8000-000000000009"],
        eventIds: [requested.id],
      }),
    ).toEqual([]);
    expect(otherAwardAdmin.changePageCalls).toBe(0);

    // Out of cohort / unverified: the publication is not effectively verified.
    const unverified = publicationIndex();
    unverified.verifiedEntries = [];
    unverified.verifiedMemberAwardIds = [];
    unverified.verifiedCanonicalAwardIds = [];
    const unverifiedAdmin = fakeAdmin([[requested]], [sourceRow()]);
    expect(
      await loadEligiblePublicChangeEvents({
        admin: unverifiedAdmin.client,
        publicationIndex: unverified,
        limit: 1,
        memberAwardIds: [memberAwardId],
        eventIds: [requested.id],
      }),
    ).toEqual([]);
    expect(unverifiedAdmin.changePageCalls).toBe(0);

    // Disallowed source: the event is on a source outside the reviewed manifest.
    const foreignSource = eventRow("2026-07-10T09:00:00.000Z", 9, invalidSourceId);
    expect(await load(fakeAdmin([[foreignSource]], [sourceRow()]), { eventIds: [foreignSource.id] })).toEqual([]);

    // Stale: the id no longer exists.
    const staleAdmin = fakeAdmin([[]], [sourceRow()]);
    expect(await load(staleAdmin, { eventIds: [requested.id] })).toEqual([]);
    expect(staleAdmin.changePageCalls).toBe(1);

    // Malformed ids never reach the database.
    const malformedAdmin = fakeAdmin([[requested]], [sourceRow()]);
    expect(await load(malformedAdmin, { eventIds: ["not-a-uuid", "", "40000000-0000-4000-8000-00000000000g"] })).toEqual([]);
    expect(malformedAdmin.changePageCalls).toBe(0);
  });
});

describe("publicChangeEventCursorFilter", () => {
  it("preserves the exact timestamp and includes the UUID tie breaker", () => {
    expect(
      publicChangeEventCursorFilter({
        detected_at: "2026-07-16T12:00:00-05:00",
        id: "40000000-0000-4000-8000-000000000001",
      }),
    ).toBe(
      "detected_at.lt.2026-07-16T12:00:00-05:00,and(detected_at.eq.2026-07-16T12:00:00-05:00,id.lt.40000000-0000-4000-8000-000000000001)",
    );
  });

  it("does not truncate PostgreSQL microseconds", () => {
    expect(
      publicChangeEventCursorFilter({
        detected_at: "2026-07-16T17:00:00.123456Z",
        id: "40000000-0000-4000-8000-000000000001",
      }),
    ).toContain("17:00:00.123456Z");
  });

  it("rejects an unsafe event id", () => {
    expect(() =>
      publicChangeEventCursorFilter({
        detected_at: "2026-07-16T17:00:00.000Z",
        id: "id),or(secret.eq.true",
      }),
    ).toThrow("invalid event id");
  });
});

describe("comparePublicChangeEventsNewestFirst", () => {
  it("orders adjacent PostgreSQL microseconds before falling back to the UUID", () => {
    const newerSmallerId = { id: "40000000-0000-4000-8000-000000000001", detected_at: "2026-07-16T18:00:00.123456Z" };
    const olderLargerId = { id: "40000000-0000-4000-8000-000000000009", detected_at: "2026-07-16T18:00:00.123455Z" };

    expect(comparePublicChangeEventsNewestFirst(newerSmallerId, olderLargerId)).toBeLessThan(0);
    expect(comparePublicChangeEventsNewestFirst(olderLargerId, newerSmallerId)).toBeGreaterThan(0);
    expect([olderLargerId, newerSmallerId].sort(comparePublicChangeEventsNewestFirst)).toEqual([
      newerSmallerId,
      olderLargerId,
    ]);
  });

  it("breaks exact timestamp ties by UUID, newest id first, and treats offsets exactly", () => {
    const smaller = { id: "40000000-0000-4000-8000-000000000001", detected_at: "2026-07-16T18:00:00.123456Z" };
    const larger = { id: "40000000-0000-4000-8000-000000000009", detected_at: "2026-07-16T18:00:00.123456Z" };
    const sameInstantOffset = { id: "40000000-0000-4000-8000-000000000005", detected_at: "2026-07-16T13:00:00.123456-05:00" };

    expect(comparePublicChangeEventsNewestFirst(larger, smaller)).toBeLessThan(0);
    expect(comparePublicChangeEventsNewestFirst(smaller, smaller)).toBe(0);
    expect(comparePublicChangeEventsNewestFirst(sameInstantOffset, larger)).toBeGreaterThan(0);
    expect(comparePublicChangeEventsNewestFirst(sameInstantOffset, smaller)).toBeLessThan(0);
  });

  it("rejects an invalid timestamp instead of guessing an order", () => {
    expect(() =>
      comparePublicChangeEventsNewestFirst(
        { id: "40000000-0000-4000-8000-000000000001", detected_at: "2026-07-16 18:00:00" },
        { id: "40000000-0000-4000-8000-000000000002", detected_at: "2026-07-16T18:00:00.000Z" },
      ),
    ).toThrow("timestamp is invalid");
  });
});

describe("dedupeEligiblePublicChangeEvents", () => {
  it("deduplicates aliases within one award without merging different awards", () => {
    const firstPublication = publicationIndex().verifiedEntries[0];
    const secondPublication = {
      ...firstPublication,
      canonicalAwardId: "10000000-0000-4000-8000-000000000002",
    } as Stage1PublicationEntry;
    const first = eventRow(
      "2026-07-16T18:00:00.000Z",
      4,
      allowedSourceId,
    );
    const aliasDuplicate = {
      ...first,
      id: "40000000-0000-4000-8000-000000000003",
      detected_at: "2026-07-16T17:00:00.000Z",
    };
    const otherAward = {
      ...first,
      id: "40000000-0000-4000-8000-000000000002",
      detected_at: "2026-07-16T16:00:00.000Z",
    };
    const source = sourceRow() as EligiblePublicChangeEvent["source"];
    const evidence = {
      change_event_id: first.id,
    } as EligiblePublicChangeEvent["evidence"];

    const result = dedupeEligiblePublicChangeEvents([
      { event: first, source, publication: firstPublication, evidence },
      { event: aliasDuplicate, source, publication: firstPublication, evidence },
      { event: otherAward, source, publication: secondPublication, evidence },
    ]);

    expect(result.map((entry) => entry.event.id)).toEqual([
      first.id,
      otherAward.id,
    ]);
  });
});

function publicationIndex(): Stage1PublicationIndex {
  const publication = {
    canonicalAwardId,
    memberAwardIds: [memberAwardId],
    allowedSourceIds: [allowedSourceId],
    allowedSourceIdSet: new Set([allowedSourceId]),
    effectivelyVerified: true,
    registry: {
      canonical_name: "Test Fellowship",
    },
  } as unknown as Stage1PublicationEntry;
  return {
    available: true,
    unavailableReason: null,
    entries: [publication],
    entryByCohortKey: new Map([["test", publication]]),
    entryByMemberAwardId: new Map([[memberAwardId, publication]]),
    verifiedEntries: [publication],
    verifiedCanonicalAwardIds: [canonicalAwardId],
    verifiedMemberAwardIds: [memberAwardId],
    release: {
      releaseKey: "stage1-national-25",
      releaseState: "verified_beta",
      releaseEpoch: "60000000-0000-4000-8000-000000000001",
      policyVersion: "stage1-publication-v1",
      cohortIdentityVersion: "stage1-national-25-v1",
      cohortIdentityHash: "a".repeat(64),
      activatedAt: "2026-07-16T17:00:00.000Z",
      effectivelyReleased: true,
      effectiveReason: "verified",
    },
  } as unknown as Stage1PublicationIndex;
}

function eventRow(
  detectedAt: string,
  suffix: number,
  sourceId: string,
): PublicChangeEventRow {
  return {
    id: `40000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    shared_award_id: memberAwardId,
    shared_award_source_id: sourceId,
    source_title: "Eligibility",
    source_url: "https://example.edu/eligibility",
    source_page_type: "eligibility",
    summary: `Material update ${suffix}`,
    change_details: {},
    suppressed_at: null,
    suppression_reason: null,
    suppression_source: null,
    visual_review_candidate_id:
      "50000000-0000-4000-8000-000000000001",
    detected_at: detectedAt,
  };
}

function sourceRow() {
  return {
    id: allowedSourceId,
    shared_award_id: memberAwardId,
    url: "https://example.edu/eligibility",
    admin_review_status: "open",
    title: "Eligibility",
    display_title: "Eligibility",
    page_metadata: {},
    page_metadata_generated_at: "2026-07-16T17:00:00.000Z",
    page_metadata_model: "test",
    page_type: "eligibility",
    source: "official",
    reason: null,
    submitted_by_user_id: null,
  };
}

function fakeAdmin(
  changePages: PublicChangeEventRow[][],
  sourceRows: unknown[],
  options: { releaseEpoch?: string } = {},
) {
  let changePageCalls = 0;
  const cursorFilters: string[] = [];
  const changeInFilters: Array<{ column: string; values: unknown[] }> = [];
  const client = {
    from(table: string) {
      if (table === "shared_award_change_events") {
        const builder = fluentBuilder(() => {
          const data = changePages[changePageCalls] || [];
          changePageCalls += 1;
          return { data, error: null };
        });
        builder.or = (filter: string) => {
          cursorFilters.push(filter);
          return builder;
        };
        builder.in = (column: string, values: unknown[]) => {
          changeInFilters.push({ column, values });
          return builder;
        };
        return builder;
      }
      if (table === "shared_award_sources") {
        return fluentBuilder(() => ({ data: sourceRows, error: null }));
      }
      if (table === "stage1_publication_release_state") {
        return fluentBuilder(() => ({
          data: {
            release_key: "stage1-national-25",
            release_state: "verified_beta",
            release_epoch:
              options.releaseEpoch ||
              "60000000-0000-4000-8000-000000000001",
            policy_version: "stage1-publication-v1",
            cohort_identity_version: "stage1-national-25-v1",
            cohort_identity_hash: "a".repeat(64),
          },
          error: null,
        }));
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  return {
    client: client as never,
    changeInFilters,
    cursorFilters,
    get changePageCalls() {
      return changePageCalls;
    },
  };
}

type FakeFluentBuilder = Record<string, unknown> & {
  then: (resolve: (value: unknown) => unknown) => unknown;
  or: (filter: string) => FakeFluentBuilder;
};

function fluentBuilder(result: () => unknown) {
  const builder: FakeFluentBuilder = {
    then(resolve) {
      return Promise.resolve(result()).then(resolve);
    },
    or() {
      return builder;
    },
  };
  for (const method of [
    "select",
    "in",
    "not",
    "is",
    "order",
    "limit",
    "gte",
    "eq",
    "maybeSingle",
  ]) {
    builder[method] = () => builder;
  }
  return builder;
}
