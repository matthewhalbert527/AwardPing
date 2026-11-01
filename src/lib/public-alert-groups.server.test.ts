import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ eligible: vi.fn() }));
vi.mock("@/lib/public-change-events", () => ({ loadEligiblePublicChangeEvents: mocks.eligible,
  comparePublicChangeEventsNewestFirst: (a: { detected_at: string }, b: { detected_at: string }) => b.detected_at.localeCompare(a.detected_at) }));
import { attachPublicAlertGroups, loadPublicAlertGroups } from "./public-alert-groups.server";
import type { EligiblePublicChangeEvent } from "./public-change-events";
import type { Stage1PublicationIndex } from "./stage1-publication";
import type { PublicAlertGroupMember } from "./public-alert-groups";
import { KHS_ALIAS, KHS_CANONICAL, khsPublishedEvents, khsPublishedGroup } from "./test-support/published-khs-alias-group";
import type { Stage1PublicationEntry } from "./stage1-publication";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(50), review = (n: number) => id(100 + n);
const quote = (text: string) => ({ block_id: "block-1", start_utf16: 0, end_utf16: text.length, text });
function event(n: number): EligiblePublicChangeEvent {
  return { event: { id: id(n), shared_award_id: owner, visual_review_candidate_id: review(n),
    source_title: `Official page ${n}`, source_url: `https://example.edu/award/${n}`, detected_at: `2026-10-${String(30 - n).padStart(2, "0")}T12:00:00Z`,
    change_details: { schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary: "A deadline changed.",
      program_changes: [{ field: "deadline", operation: "replace", summary: "A deadline changed.", previous_quote: quote("Deadline October 1"), current_quote: quote("Deadline October 15") }] } },
    publication: { canonicalAwardId: owner, memberAwardIds: [owner] } } as unknown as EligiblePublicChangeEvent;
}
function group() {
  return { group_id: id(200), revision_id: id(201), content_hash: "a".repeat(64), shared_award_id: owner,
    event_ids: [id(1), id(2)], member_refs: [1, 2].map(n => ({ id: review(n), content_hash: String(n).repeat(64) })),
    event_refs: [1, 2].map(n => ({ review_id: review(n), event_id: id(n), content_hash: String(n).repeat(64) })), created_at: "2026-10-31T12:00:00Z" };
}
const index = {} as Stage1PublicationIndex;
const setup = (data: unknown = [group()]) => { const rpc = vi.fn().mockResolvedValue({ data, error: null }); return { rpc, admin: { rpc } as never }; };

describe("approved public alert group hydration", () => {
  beforeEach(() => mocks.eligible.mockReset().mockResolvedValue([]));
  it("uses no lookup for an empty eligible feed", async () => {
    const { admin, rpc } = setup();
    expect(await loadPublicAlertGroups({ admin, publicationIndex: index, events: [] })).toEqual({ events: [], groups: [] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("accepts the actual KHS alias-owned approved group under its verified canonical publication", async () => {
    const publication = { canonicalAwardId: KHS_CANONICAL, memberAwardIds: [KHS_CANONICAL, KHS_ALIAS] } as Stage1PublicationEntry;
    const events = khsPublishedEvents(publication), { admin } = setup([khsPublishedGroup()]);
    const result = await loadPublicAlertGroups({ admin, publicationIndex: index, events });
    expect(result.groups).toEqual([khsPublishedGroup()]);
    expect(result.events.map(row => row.event.id)).toEqual(events.map(row => row.event.id));
    expect(result.events.every(row => row.publication.canonicalAwardId === KHS_CANONICAL && row.event.shared_award_id === KHS_ALIAS)).toBe(true);
  });
  it.each(["unreviewed_alias", "different_actual_owner", "mixed_canonical"])("rejects a production-shaped group with %s", async failure => {
    const publication = { canonicalAwardId: KHS_CANONICAL, memberAwardIds: [KHS_CANONICAL, KHS_ALIAS] } as Stage1PublicationEntry;
    const events = khsPublishedEvents(publication), { admin } = setup([khsPublishedGroup()]);
    if (failure === "unreviewed_alias") publication.memberAwardIds = [KHS_CANONICAL];
    if (failure === "different_actual_owner") events[1].event.shared_award_id = KHS_CANONICAL;
    if (failure === "mixed_canonical") events[1].publication = { ...publication, canonicalAwardId: id(999) };
    expect((await loadPublicAlertGroups({ admin, publicationIndex: index, events })).groups).toEqual([]);
  });
  it("hydrates a deep-linked child and requires the original eligibility loader for its parent", async () => {
    const { admin, rpc } = setup(), child = event(1), parent = event(2), before = structuredClone(child);
    mocks.eligible.mockResolvedValue([parent]);
    const result = await loadPublicAlertGroups({ admin, publicationIndex: index, events: [child] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_program_text_published_alert_groups", { p_event_ids: [child.event.id] });
    expect(mocks.eligible).toHaveBeenCalledExactlyOnceWith({ admin, publicationIndex: index, eventIds: [parent.event.id], preserveDistinctEventIds: true, limit: null, pageSize: 100 });
    expect(result.events.map(row => row.event.id)).toEqual([id(1), id(2)]);
    expect(result.groups).toEqual([group()]);
    expect(child).toEqual(before);
  });
  it("keeps an eligible child standalone when a grouped sibling fails public approval or source gates", async () => {
    const { admin } = setup(), child = event(1);
    const result = await loadPublicAlertGroups({ admin, publicationIndex: index, events: [child] });
    expect(result).toEqual({ events: [child], groups: [] });
  });
  it.each(["owner", "review", "contract"])("does not group a member with mismatched %s", async mismatch => {
    const { admin } = setup(), parent = event(2);
    if (mismatch === "owner") parent.publication.canonicalAwardId = id(999);
    if (mismatch === "review") parent.event.visual_review_candidate_id = id(999);
    if (mismatch === "contract") parent.event.change_details = {};
    mocks.eligible.mockResolvedValue([parent]);
    expect(await loadPublicAlertGroups({ admin, publicationIndex: index, events: [event(1)] })).toEqual({ events: [event(1)], groups: [] });
  });
  it.each(["hash", "members", "events", "overlap"])("holds malformed %s without a partial group", async mismatch => {
    const g = group();
    if (mismatch === "hash") g.content_hash = "invalid";
    if (mismatch === "members") g.member_refs[1].content_hash = "f".repeat(64);
    if (mismatch === "events") g.event_ids[1] = g.event_ids[0];
    const { admin } = setup(mismatch === "overlap" ? [g, { ...g, group_id: id(203) }] : [g]);
    await expect(loadPublicAlertGroups({ admin, publicationIndex: index, events: [event(1), event(2)] })).rejects.toThrow("could not be verified");
  });
  it("holds failed grouping lookups rather than silently sending duplicate grouped notifications", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "Unavailable" } });
    await expect(loadPublicAlertGroups({ admin: { rpc } as never, publicationIndex: index, events: [event(1)] })).rejects.toThrow("could not be verified");
  });
  it("paginates large grouping lookups within the documented 1000-ID RPC bound", async () => {
    const { admin, rpc } = setup([]);
    const base = event(1), events = Array.from({ length: 1001 }, (_, n) => ({ ...base, event: { ...base.event, id: id(1000 + n) } }));
    const result = await loadPublicAlertGroups({ admin, publicationIndex: index, events });
    expect(result.events).toHaveLength(1001);
    expect(rpc.mock.calls.map(call => call[1].p_event_ids.length)).toEqual([1000, 1]);
    expect(mocks.eligible).not.toHaveBeenCalled();
  });
  it("adds display metadata without mutating any original member or source contract", () => {
    const rows = [1, 2].map(n => ({ id: id(n), sourceId: id(300 + n), sourceTitle: `Source ${n}`, sourceUrl: `https://example.edu/${n}`,
      sourcePageType: "application", summary: "A deadline changed.", changeDetails: event(n).event.change_details, detectedAt: event(n).event.detected_at })) as PublicAlertGroupMember[];
    const before = structuredClone(rows), result = attachPublicAlertGroups(rows, [group()]);
    expect(rows).toEqual(before);
    expect(result[0].group?.memberEventIds).toEqual([id(1), id(2)]);
    expect(result[0].group?.members).toEqual(rows);
    expect(result[0].changeDetails).toBe(rows[0].changeDetails);
    expect(result[1].group).toBe(result[0].group);
  });
});
