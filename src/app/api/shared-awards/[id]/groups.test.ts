import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ index: vi.fn(), events: vi.fn(), rpc: vi.fn(), sources: [] as unknown[] }));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: () => true, hasSupabaseAdminConfig: () => true }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
vi.mock("@/lib/offices", () => ({ getOfficeContext: vi.fn() }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIndex: mocks.index, isStage1SourceIdentityExcluded: () => false }));
vi.mock("@/lib/source-quality", async original => ({ ...(await original<typeof import("@/lib/source-quality")>()), isPublicAwardSource: () => true }));
vi.mock("@/lib/public-change-events", async original => ({ ...(await original<typeof import("@/lib/public-change-events")>()), loadEligiblePublicChangeEvents: mocks.events }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: () => {
  const query: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mocks.sources, error: null }).then(resolve) };
  for (const method of ["select", "in", "eq", "order"]) query[method] = () => query;
  return query;
} }) }));
import { GET } from "./route";
import { KHS_ALIAS, KHS_CANONICAL, KHS_SOURCE, KHS_SOURCE_URL, KHS_NEW_EVENT, KHS_OLD_EVENT, khsPublishedEvents, khsPublishedGroup } from "@/lib/test-support/published-khs-alias-group";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";

describe("related public award API projection", () => {
  beforeEach(() => vi.resetAllMocks());
  it("reports one display update while preserving both alias-owned raw event IDs and source-scoped group metadata", async () => {
    const home = "10000000-0000-4000-8000-000000000001", homepage = "https://knight-hennessy.stanford.edu/";
    const publication = { canonicalAwardId: KHS_CANONICAL, memberAwardIds: [KHS_CANONICAL, KHS_ALIAS], effectivelyVerified: true,
      registry: { canonical_name: "Knight-Hennessy Scholars", canonical_slug: "knight-hennessy-scholars", official_homepage: homepage },
      officialHomepageSourceId: home, officialHomepageUrl: homepage, allowedSourceIds: [home, KHS_SOURCE], allowedSourceIdSet: new Set([home, KHS_SOURCE]),
      publishedFacts: { overview: "Basic KHS information." } } as unknown as Stage1PublicationEntry;
    mocks.index.mockResolvedValue({ available: true, entryByMemberAwardId: new Map([[KHS_CANONICAL, publication]]) });
    const events = khsPublishedEvents(publication);
    mocks.events.mockResolvedValue(events);
    mocks.rpc.mockResolvedValue({ data: [khsPublishedGroup()], error: null });
    mocks.sources = [{ id: home, shared_award_id: KHS_CANONICAL, url: homepage, title: "Homepage", page_type: "homepage" },
      { id: KHS_SOURCE, shared_award_id: KHS_ALIAS, url: KHS_SOURCE_URL, title: "Eligibility", page_type: "eligibility" }];
    const response = await GET(new Request(`https://awardping.com/api/shared-awards/${KHS_CANONICAL}`), { params: Promise.resolve({ id: KHS_CANONICAL }) });
    expect(response.status).toBe(200);
    const { award } = await response.json();
    expect(award.id).toBe(KHS_CANONICAL); expect(award.changeCount).toBe(1);
    expect(award.changes.map((row: { id: string }) => row.id)).toEqual([KHS_NEW_EVENT, KHS_OLD_EVENT]);
    expect(award.changes.every((row: { group: { id: string } }) => row.group.id === khsPublishedGroup().group_id)).toBe(true);
    expect(award.sources[0].latestChanges).toEqual([]);
    expect(award.sources[1].latestChanges.map((row: { id: string }) => row.id)).toEqual([KHS_NEW_EVENT, KHS_OLD_EVENT]);
    expect(award.sources[1].latestChanges.every((row: { group: { id: string } }) => row.group.id === khsPublishedGroup().group_id)).toBe(true);

    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Private group diagnostic" } });
    const held = await GET(new Request(`https://awardping.com/api/shared-awards/${KHS_CANONICAL}`), { params: Promise.resolve({ id: KHS_CANONICAL }) });
    expect(held.status).toBe(503);
    expect(await held.json()).toEqual({ error: "Shared award details are unavailable right now." });
  });
});
