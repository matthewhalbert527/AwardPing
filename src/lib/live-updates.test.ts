import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ eligible: vi.fn(), related: vi.fn(), index: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIndex: mocks.index }));
vi.mock("@/lib/public-change-events", async original => ({ ...(await original<typeof import("./public-change-events")>()), loadEligiblePublicChangeEvents: mocks.eligible }));
vi.mock("@/lib/public-alert-groups.server", async original => ({
  ...(await original<typeof import("./public-alert-groups.server")>()), loadPublicAlertGroups: mocks.related,
}));
import { getLiveUpdateItems } from "./live-updates";
import { KHS_ALIAS, KHS_CANONICAL, khsPublishedEvents, khsPublishedGroup } from "./test-support/published-khs-alias-group";
import type { Stage1PublicationEntry } from "./stage1-publication";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(99);
function event(n: number) {
  return { event: { id: id(n), shared_award_id: owner, shared_award_source_id: id(10 + n), source_title: `Page ${n}`,
    source_url: `https://example.edu/award/${n}`, source_page_type: "application", summary: `The application instructions on page ${n} changed.`,
    change_details: {}, detected_at: `2026-10-${String(30 - n).padStart(2, "0")}T12:00:00Z` },
    publication: { canonicalAwardId: owner, registry: { canonical_name: "Example Award", canonical_slug: "example-award" } } };
}
describe("grouped public feed DTOs", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.index.mockResolvedValue({ available: true, verifiedMemberAwardIds: [owner] }); });
  it("passes the real alias-owned KHS approved payload through actual hydration into one feed card", async () => {
    const publication = { canonicalAwardId: KHS_CANONICAL, memberAwardIds: [KHS_CANONICAL, KHS_ALIAS],
      registry: { canonical_name: "Knight-Hennessy Scholars", canonical_slug: "knight-hennessy-scholars" } } as Stage1PublicationEntry;
    const events = khsPublishedEvents(publication);
    mocks.index.mockResolvedValue({ available: true, verifiedMemberAwardIds: publication.memberAwardIds });
    mocks.eligible.mockResolvedValue(events);
    mocks.rpc.mockResolvedValue({ data: [khsPublishedGroup()], error: null });
    const actual = await vi.importActual<typeof import("./public-alert-groups.server")>("./public-alert-groups.server");
    mocks.related.mockImplementation(actual.loadPublicAlertGroups);
    const feed = await getLiveUpdateItems(80, new Date("2026-11-01T02:00:00Z"));
    expect(feed).toHaveLength(1); expect(feed[0].awardId).toBe(KHS_CANONICAL);
    expect(feed[0].group?.id).toBe(khsPublishedGroup().group_id);
    expect(new Set(feed[0].group?.memberEventIds)).toEqual(new Set(events.map(row => row.event.id)));
  });
  it("returns one card for a complete approved family without removing either member's original source", async () => {
    const child = event(1), parent = event(2), before = structuredClone(child);
    mocks.eligible.mockResolvedValue([child]);
    mocks.related.mockResolvedValue({ events: [child, parent], groups: [{ group_id: id(200), content_hash: "a".repeat(64), event_ids: [id(1), id(2)] }] });
    const feed = await getLiveUpdateItems(1, new Date("2026-10-31T12:00:00Z"));
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe(child.event.id);
    expect(feed[0].group?.members.map(member => [member.id, member.sourceUrl])).toEqual([
      [child.event.id, child.event.source_url], [parent.event.id, parent.event.source_url],
    ]);
    expect(child).toEqual(before);
    expect(mocks.eligible.mock.calls[0][0].limit).toBe(1);
  });
  it("does not hide a standalone eligible event when no published grouping applies", async () => {
    const child = event(1);
    mocks.eligible.mockResolvedValue([child]);
    mocks.related.mockResolvedValue({ events: [child], groups: [] });
    const feed = await getLiveUpdateItems(8, new Date("2026-10-31T12:00:00Z"));
    expect(feed).toHaveLength(1);
    expect(feed[0].group).toBeUndefined();
    expect(feed[0].id).toBe(child.event.id);
  });
});
