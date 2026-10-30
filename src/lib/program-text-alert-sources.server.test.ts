import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applyProgramTextAlertSourceBindings, loadProgramTextAlertApprovals, loadProgramTextAlertSourceBindings, programTextAlertSourceIds } from "@/lib/program-text-alert-sources.server";
import { loadProgramAwardExpansion } from "@/lib/program-award-expansion.server";
import expansionCohort from "../../config/program-award-expansion.json";
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
function absentExpansionBinding() {
  const award = expansionCohort.awards[0];
  return { cohort_key: award.cohort_key, source_id: "44444444-4444-4444-8444-444444444444", shared_award_id: award.canonical_shared_award_id,
    url: award.official_homepage, epoch };
}

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
  it("keeps all original25 alert bindings when expansion lookup fails while active extra bindings exist", async () => {
    const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
    const base = index().entries[0];
    const entries = Array.from({ length: 25 }, (_, n) => ({ ...base, registry: { ...base.registry, cohort_key: `original_${n}` },
      canonicalAwardId: id(n + 1), memberAwardIds: [id(n + 1)] }));
    const original = { ...index(), entries, verifiedEntries: entries, verifiedCanonicalAwardIds: entries.map(row => row.canonicalAwardId),
      verifiedMemberAwardIds: entries.flatMap(row => row.memberAwardIds), entryByCohortKey: new Map(entries.map(row => [row.registry.cohort_key, row])),
      entryByMemberAwardId: new Map(entries.map(row => [row.canonicalAwardId, row])) };
    const bindings = entries.map((row, n) => ({ cohort_key: row.registry.cohort_key, source_id: id(n + 100),
      shared_award_id: row.canonicalAwardId, url: `https://example.org/award-${n}`, epoch }));
    const activeExtra = absentExpansionBinding();
    const rpc = vi.fn(async (name: string) => name === "get_program_award_expansion_publication"
      ? { data: null, error: { code: "unavailable" } }
      : { data: { schema: snapshot().schema, epoch, source_count: 26, bindings: [...bindings, activeExtra] }, error: null });
    const unchanged = await loadProgramAwardExpansion({ rpc }, original, epoch);
    const result = await loadProgramTextAlertSourceBindings({ rpc }, unchanged, epoch);
    expect(unchanged).toBe(original); expect(result.entries).toHaveLength(25); expect(result.textAlertSourcesAvailable).toBe(true);
    result.entries.forEach((row, n) => {
      expect(programTextAlertSourceIds(row)).toEqual([id(n + 100)]);
      expect(row.publishedFacts).toBe(original.entries[n].publishedFacts);
    });
    expect(result.entryByCohortKey.has(activeExtra.cohort_key)).toBe(false);
    expect(result.entryByMemberAwardId.has(activeExtra.shared_award_id)).toBe(false);
  });
  it.each([
    (s: ReturnType<typeof snapshot>) => { s.bindings[1].cohort_key = "unreviewed_expansion"; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[1].shared_award_id = sourceId; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[1].epoch = owner; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[1].url = "https://user:password@example.org/"; },
    (s: ReturnType<typeof snapshot>) => { s.bindings[1].source_id = sourceId; },
    (s: ReturnType<typeof snapshot>) => { s.bindings.push({ ...s.bindings[1] }); s.source_count++; },
    (s: ReturnType<typeof snapshot>) => { Object.assign(s.bindings[1], { approved: true }); },
  ])("still validates ignored expansion rows and global duplicate source IDs %#", mutate => {
    const input = snapshot(); input.bindings.push(absentExpansionBinding()); input.source_count++;
    mutate(input); expect(() => applyProgramTextAlertSourceBindings(index(), input, epoch)).toThrow();
  });
  it("does not grant permissions to an absent reviewed expansion owner", () => {
    const input = snapshot(), extra = absentExpansionBinding(); input.bindings.push(extra); input.source_count++;
    const result = applyProgramTextAlertSourceBindings(index(), input, epoch);
    expect(programTextAlertSourceIds(result.entries[0])).toEqual([sourceId]);
    expect(result.entryByCohortKey.has(extra.cohort_key)).toBe(false); expect(result.entries).toHaveLength(1);
  });
  it("still rejects an expansion identity already present but unverified", () => {
    const extra = absentExpansionBinding(), original = index();
    const held = { ...original.entries[0], registry: { ...original.entries[0].registry, cohort_key: extra.cohort_key },
      canonicalAwardId: extra.shared_award_id, memberAwardIds: [extra.shared_award_id], effectivelyVerified: false };
    original.entryByCohortKey.set(extra.cohort_key, held); original.entryByMemberAwardId.set(extra.shared_award_id, held);
    const input = snapshot(); input.bindings.push(extra); input.source_count++;
    expect(() => applyProgramTextAlertSourceBindings(original, input, epoch)).toThrow("wrong award owner");
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
