import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applyProgramTextAlertSourceBindings, loadProgramTextAlertApprovals, loadProgramTextAlertSourceBindings, programTextAlertSourceIds } from "@/lib/program-text-alert-sources.server";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";
const epoch = "33333333-3333-4333-8333-333333333333", owner = "22222222-2222-4222-8222-222222222222", sourceId = "11111111-1111-4111-8111-111111111111";
function index() {
  const entry = { registry: { cohort_key: "example" }, canonicalAwardId: owner, memberAwardIds: [owner], effectivelyVerified: true,
    publishedFacts: { overview: "The accepted basic information." }, allowedSourceIds: ["legacy-source"], allowedSourceIdSet: new Set(["legacy-source"]) } as unknown as Stage1PublicationEntry;
  return { available: true, entries: [entry], verifiedEntries: [entry], verifiedCanonicalAwardIds: [owner], verifiedMemberAwardIds: [owner],
    entryByCohortKey: new Map([["example", entry]]), entryByMemberAwardId: new Map([[owner, entry]]) } as unknown as Stage1PublicationIndex;
}
function snapshot() { return { schema: "awardping.program-text-public-alert-sources.v1", epoch, source_count: 1,
  bindings: [{ cohort_key: "example", source_id: sourceId, shared_award_id: owner, url: "https://example.org/award?track=current", epoch }] }; }

describe("current text alert sources do not require complete fact inventories", () => {
  it("attaches exact independent alert authority without approving facts, routes or source cards", () => {
    const original = index(), result = applyProgramTextAlertSourceBindings(original, snapshot(), epoch), row = result.entries[0];
    expect(programTextAlertSourceIds(row)).toEqual([sourceId]);
    expect(row.approvedTextAlertSourceBindings?.[sourceId]).toEqual({ url: "https://example.org/award?track=current", shared_award_id: owner, epoch });
    expect(row.publishedFacts).toBe(original.entries[0].publishedFacts);
    expect(row.allowedSourceIds).toBe(original.entries[0].allowedSourceIds); expect(row.allowedSourceIdSet.has(sourceId)).toBe(false);
    expect(row.textFactReview).toBeUndefined(); expect(original.entries[0].approvedTextAlertSourceBindings).toBeUndefined();
    expect(result.entryByMemberAwardId.get(owner)).toBe(row); expect(result.entryByCohortKey.get("example")).toBe(row);
  });
  it.each([
    (s: ReturnType<typeof snapshot>) => { s.epoch = owner; }, (s: ReturnType<typeof snapshot>) => { s.bindings[0].epoch = owner; }, (s: ReturnType<typeof snapshot>) => { s.bindings[0].cohort_key = "another"; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[0].shared_award_id = sourceId; }, (s: ReturnType<typeof snapshot>) => { s.bindings[0].url = "https://user:password@example.org/"; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[0].url = "javascript:alert(1)"; }, (s: ReturnType<typeof snapshot>) => { s.bindings[0].url = "https://example.org/#section"; },
    (s: ReturnType<typeof snapshot>) => { s.source_count = 2; }, (s: ReturnType<typeof snapshot>) => { s.bindings.push({ ...s.bindings[0] }); s.source_count++; },
    (s: ReturnType<typeof snapshot>) => { Object.assign(s.bindings[0], { approved: true }); },
  ])("rejects stale, malformed, cross-award, duplicate or ambiguous authority %#", mutate => {
    const s = snapshot(); mutate(s); expect(() => applyProgramTextAlertSourceBindings(index(), s, epoch)).toThrow();
  });
  it("does not resurrect an unverified award through a source approval", () => {
    const original = index(); original.entries[0].effectivelyVerified = false;
    expect(() => applyProgramTextAlertSourceBindings(original, snapshot(), epoch)).toThrow("wrong award owner");
  });
  it("loads exactly one bounded snapshot through the service-only RPC", async () => {
    const rpc = vi.fn(async () => ({ data: snapshot(), error: null })), result = await loadProgramTextAlertSourceBindings({ rpc }, index(), epoch);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_program_text_public_alert_source_bindings", { p_epoch: epoch });
    expect(result.textAlertSourcesAvailable).toBe(true);
  });
  it.each(["error", "malformed", "transport"])("retains accepted public facts but removes extra alert permissions after %s failure", async kind => {
    const original = applyProgramTextAlertSourceBindings(index(), snapshot(), epoch);
    const rpc = vi.fn(async () => { if (kind === "transport") throw Error("Transport failed");
      return kind === "error" ? { data: null, error: { code: "42501" } } : { data: { ...snapshot(), source_count: 2 }, error: null }; });
    const result = await loadProgramTextAlertSourceBindings({ rpc }, original, epoch);
    expect(result.available).toBe(true); expect(result.textAlertSourcesAvailable).toBe(false);
    expect(programTextAlertSourceIds(result.entries[0])).toEqual([]); expect(result.entries[0].publishedFacts).toBe(original.entries[0].publishedFacts);
    expect(result.entries[0].allowedSourceIds).toBe(original.entries[0].allowedSourceIds); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("handles genuine zero current source approvals without carrying old permissions", () => {
    const original = applyProgramTextAlertSourceBindings(index(), snapshot(), epoch);
    const result = applyProgramTextAlertSourceBindings(original, { ...snapshot(), source_count: 0, bindings: [] }, epoch);
    expect(programTextAlertSourceIds(result.entries[0])).toEqual([]); expect(result.textAlertSourcesAvailable).toBe(true);
  });
  function approvalDatabase(rows: unknown[], error: unknown = null) {
    const calls: Array<{ table: string; ids?: string[]; limit?: number }> = [];
    return { calls, from(table: string) {
      const call: typeof calls[number] = { table }; calls.push(call);
      const q = { select: () => q, eq: () => q, in: (_key: string, ids: string[]) => { call.ids = ids; return q; },
        limit: (limit: number) => { call.limit = limit; return q; }, then: (yes: (value: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(yes) };
      return q;
    } };
  }
  it("loads only explicitly requested owner-approved event/candidate bindings", async () => {
    const db = approvalDatabase([{ id: sourceId, event_id: owner, content_hash: "a".repeat(64), status: "approved" }]);
    const approvals = await loadProgramTextAlertApprovals(db, [owner, owner]);
    expect(approvals.get(owner)).toEqual({ eventId: owner, candidateId: sourceId, contentHash: "a".repeat(64) });
    expect(db.calls).toEqual([{ table: "program_text_alert_reviews", ids: [owner], limit: 1 }]);
    expect(await loadProgramTextAlertApprovals(db, [])).toEqual(new Map()); expect(db.calls).toHaveLength(1);
  });
  it.each([
    { id: sourceId, event_id: owner, content_hash: "a".repeat(64), status: "pending" },
    { id: sourceId, event_id: epoch, content_hash: "a".repeat(64), status: "approved" },
    { id: sourceId, event_id: owner, content_hash: "invalid", status: "approved" },
  ])("rejects nonapproved, unsolicited or malformed owner-decision rows %j", async row => {
    await expect(loadProgramTextAlertApprovals(approvalDatabase([row]), [owner])).rejects.toThrow();
  });
  it("does not fall back to automatic text approval after a database error", async () => {
    await expect(loadProgramTextAlertApprovals(approvalDatabase([], { code: "42501" }), [owner])).rejects.toThrow("unavailable");
  });
});
