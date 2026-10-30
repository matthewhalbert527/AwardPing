import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/program-expansion-tracking.server", () => ({ loadProgramExpansionTrackingContext: mocks.load }));
import { loadProgramExpansionPublicSources } from "./program-expansion-public-sources.server";
import type { Stage1PublicationEntry } from "./stage1-publication";
import type { createSupabaseAdminClient } from "./supabase/admin";

describe("admitted expansion public-source projection", () => {
  const publication = {} as Stage1PublicationEntry;
  const admin = { from() { throw Error("No independent broad source query is allowed"); } } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222",
    url: "https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=",
    title: "Study Scholarships: application requirements", page_type: "application", admin_review_status: "review_later",
    confidence: 0.95, reason: "Private internal intake notes", updated_at: "2026-10-30T10:00:00.000Z" };
  beforeEach(() => { vi.resetAllMocks(); mocks.load.mockResolvedValue({ context: { admission_id: "private admission" }, sources: [source] }); });
  it("reuses exact admitted authority and preserves programme query parameters", async () => {
    const result = await loadProgramExpansionPublicSources(admin, publication);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(admin, publication);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: source.id, shared_award_id: source.shared_award_id, url: source.url,
      title: source.title, page_type: "application", admin_review_status: "review_later", last_checked_at: null, last_error: null });
  });
  it("publishes no internal reason, confidence, admission metadata or unreviewed AI source fields", async () => {
    mocks.load.mockResolvedValue({ context: { admission_id: "private admission" }, sources: [{ ...source,
      display_title: "Unreviewed AI title", page_description: "Unreviewed AI description", page_metadata: { private: "secret" }, last_error: "Internal database diagnostic" }] });
    const value = JSON.stringify(await loadProgramExpansionPublicSources(admin, publication));
    for (const hidden of ["Private internal intake notes", "private admission", "Unreviewed AI", "secret", "Internal database", "confidence", "updated_at"]) expect(value).not.toContain(hidden);
  });
  it("does not fall back to an OPEN scan when current admission or source authority fails", async () => {
    mocks.load.mockRejectedValue(Error("Source identity changed"));
    await expect(loadProgramExpansionPublicSources(admin, publication)).rejects.toThrow("Source identity changed");
  });
});
