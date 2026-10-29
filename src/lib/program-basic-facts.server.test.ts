import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applyProgramBasicFacts, emptyBasicAwardFacts, loadProgramBasicFacts } from "@/lib/program-basic-facts.server";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";
import type { Json } from "@/lib/database.types";
const owner = "22222222-2222-4222-8222-222222222222", other = "44444444-4444-4444-8444-444444444444", snapshotId = "33333333-3333-4333-8333-333333333333";
function index() {
  const entries = [owner, other].map((id, n) => ({ registry: { cohort_key: `example_${n}` }, canonicalAwardId: id, memberAwardIds: [id], effectivelyVerified: true,
    publishedFacts: { overview: `Accepted old overview ${n}.`, deadline: "January 31, 2026" }, allowedSourceIds: ["legacy-source"], allowedSourceIdSet: new Set(["legacy-source"]), officialHomepageUrl: "https://example.org/" } as unknown as Stage1PublicationEntry));
  return { available: true, entries, verifiedEntries: entries, verifiedCanonicalAwardIds: [owner, other], verifiedMemberAwardIds: [owner, other],
    entryByCohortKey: new Map(entries.map(row => [row.registry.cohort_key, row])), entryByMemberAwardId: new Map(entries.map(row => [row.canonicalAwardId, row])) } as unknown as Stage1PublicationIndex;
}
function row() { return { award_id: owner, cohort_key: "example_0", snapshot_id: snapshotId, kind: "automated_source_verified_basics", current: true,
  public_facts: { ...emptyBasicAwardFacts(), overview: "Source-backed current basic information.", deadline: "January 31, 2027", reviewed_cycle: "2027", award_amounts: ["Master’s students: $10,000", "Doctoral students: $20,000"] } as Record<string, Json>,
  verified_at: "2026-10-28T12:34:56.123456+00:00" }; }

describe("individual automated basic-information snapshots", () => {
  it("shows one source-backed award without requiring25 approvals or changing public identity/source permissions", () => {
    const before = index(), result = applyProgramBasicFacts(before, [row()]), first = result.entries[0];
    expect(first.publishedFacts).toEqual(row().public_facts); expect(first.basicFactSnapshot).toEqual({ id: snapshotId, kind: "automated_source_verified_basics", current: true, verifiedAt: row().verified_at });
    expect(first.textFactReview).toBeUndefined(); expect(first.allowedSourceIds).toBe(before.entries[0].allowedSourceIds);
    expect(first.allowedSourceIdSet).toBe(before.entries[0].allowedSourceIdSet); expect(first.effectivelyVerified).toBe(true);
    expect(result.entries[1]).toBe(before.entries[1]); expect(before.entries[0].basicFactSnapshot).toBeUndefined();
    expect(result.entryByMemberAwardId.get(owner)).toBe(first); expect(result.entryByCohortKey.get("example_0")).toBe(first);
  });
  it("preserves the accepted ledger only when a successful lookup has no replacement", () => {
    const before = index(), result = applyProgramBasicFacts(before, []);
    expect(result.entries[0]).toBe(before.entries[0]); expect(result.entries[0].publishedFacts).toEqual(before.entries[0].publishedFacts);
  });
  it("blanks a stale replacement instead of resurfacing old ledger deadlines or unsupported facts", () => {
    const stale = { ...row(), current: false, public_facts: null }, result = applyProgramBasicFacts(index(), [stale]);
    expect(result.entries[0].publishedFacts).toEqual(emptyBasicAwardFacts()); expect(result.entries[0].basicFactSnapshot?.current).toBe(false);
    expect(result.entries[0].basicFactSnapshot?.verifiedAt).toBe(stale.verified_at);
  });
  it.each([
    (r: ReturnType<typeof row>) => { r.award_id = other; },
    (r: ReturnType<typeof row>) => { r.cohort_key = "unrelated"; },
    (r: ReturnType<typeof row>) => { r.kind = "human_approved_full_program"; },
    (r: ReturnType<typeof row>) => { r.verified_at = "2026-02-30T12:00:00Z"; },
    (r: ReturnType<typeof row>) => { r.verified_at = new Date(Date.now() + 10 * 60_000).toISOString(); },
    (r: ReturnType<typeof row>) => { Object.assign(r, { private_capture_refs: [] }); },
    (r: ReturnType<typeof row>) => { r.public_facts.how_to_apply = ["A manual applicant route leaked from a private draft."]; },
    (r: ReturnType<typeof row>) => { r.public_facts.not_published_fields = ["tuition"]; },
    (r: ReturnType<typeof row>) => { delete r.public_facts.eligibility; },
  ])("rejects a wrong scope, false approval, private material or unsupported field %#", mutate => {
    const r = row(); mutate(r); expect(() => applyProgramBasicFacts(index(), [r])).toThrow();
  });
  it("rejects duplicate award or snapshot identities", () => {
    const r = row(); expect(() => applyProgramBasicFacts(index(), [r, r])).toThrow();
    expect(() => applyProgramBasicFacts(index(), [r, { ...r, award_id: other, cohort_key: "example_1" }])).toThrow();
  });
  it("never presents an unverified award simply because a basic snapshot exists", () => {
    const before = index(); before.entries[0].effectivelyVerified = false;
    expect(() => applyProgramBasicFacts(before, [row()])).toThrow("wrong identity");
  });
  it("performs only the bounded getter and does not publish, create an alert or send a notification", async () => {
    const rpc = vi.fn(async () => ({ data: [row()], error: null })), result = await loadProgramBasicFacts({ rpc }, index());
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_program_basic_facts", { p_award_ids: [owner, other] });
    expect(result.entries[0].basicFactSnapshot?.current).toBe(true);
  });
  it.each(["database", "malformed", "transport"])("keeps identities/official links available but blanks unknown data after %s failure", async kind => {
    const before = index(), rpc = vi.fn(async () => { if (kind === "transport") throw Error("Transport failed");
      return kind === "database" ? { error: { code: "42501" }, data: null } : { error: null, data: [row(), row()] }; });
    const result = await loadProgramBasicFacts({ rpc }, before);
    expect(result.available).toBe(true); expect(result.verifiedEntries).toHaveLength(2);
    expect(result.entries[0].basicFactsUnavailable).toBe(true); expect(result.entries[0].basicFactSnapshot).toBeUndefined();
    expect(result.entries[0].publishedFacts).toEqual(emptyBasicAwardFacts()); expect(result.entries[0].officialHomepageUrl).toBe(before.entries[0].officialHomepageUrl);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("does not retain a current-looking snapshot identity after a replacement lookup fails", async () => {
    const previous = applyProgramBasicFacts(index(), [row()]);
    const result = await loadProgramBasicFacts({ rpc: async () => ({ data: null, error: { code: "42501" } }) }, previous);
    expect(result.entries[0].basicFactSnapshot).toBeUndefined(); expect(result.entries[0].basicFactsUnavailable).toBe(true);
    expect(result.entries[0].publishedFacts).toEqual(emptyBasicAwardFacts());
  });
});
