import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import cohort from "../../config/program-award-expansion.json";
import { emptyBasicAwardFacts } from "@/lib/program-basic-facts.server";
import { applyProgramAwardExpansion, loadProgramAwardExpansion } from "@/lib/program-award-expansion.server";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec", at = "2026-10-29T12:00:00.000Z";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function original() {
  const entries = Array.from({ length: 25 }, (_, n) => ({ registry: { cohort_key: `original_${n}` },
    canonicalAwardId: id(n + 1), memberAwardIds: [id(n + 1)], effectivelyVerified: true,
    publishedFacts: { overview: "Existing accepted details." }, allowedSourceIds: [id(n + 100)],
    allowedSourceIdSet: new Set([id(n + 100)]),
  } as unknown as Stage1PublicationEntry));
  return { available: true, unavailableReason: null, release: { releaseKey: "stage1-national-25" }, entries,
    entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
    entryByMemberAwardId: new Map(entries.map(entry => [entry.canonicalAwardId, entry])), verifiedEntries: entries,
    verifiedCanonicalAwardIds: entries.map(entry => entry.canonicalAwardId), verifiedMemberAwardIds: entries.map(entry => entry.canonicalAwardId),
  } as Stage1PublicationIndex;
}
function publication(count = 5) {
  return { schema: "awardping.program-award-expansion-publication.v1", epoch,
    awards: cohort.awards.slice(0, count).map((award, n) => ({
      registry: { cohort_key: award.cohort_key, launch_rank: award.launch_rank, canonical_name: award.canonical_name,
        canonical_shared_award_id: award.canonical_shared_award_id, canonical_slug: award.canonical_slug, official_homepage: award.official_homepage,
        publication_state: "pending", state_reason: "Text-only basic-information cohort.", policy_version: "program-basic-expansion-v1",
        fact_ledger_batch_id: null, release_epoch: null, evidence_checked_at: null, last_verified_at: null, created_at: at, updated_at: at },
      members: [{ shared_award_id: award.canonical_shared_award_id, cohort_key: award.cohort_key, member_kind: "canonical", reason: "Reviewed same programme.", created_at: at, updated_at: at }],
      source_ids: [id(n + 200)], reviewed_homepage: { source_id: id(n + 200), url: award.official_homepage },
      basic_fact: { award_id: award.canonical_shared_award_id, cohort_key: award.cohort_key, snapshot_id: id(n + 300),
        kind: "automated_source_verified_basics", current: true, verified_at: at,
        public_facts: { ...emptyBasicAwardFacts(), overview: `Source-supported ${award.canonical_name} overview.`, reviewed_cycle: "Current published guidance" } },
    })) };
}
describe("bounded text-only award expansion", () => {
  it.each([5, 10, 15, 20])("adds the complete reviewed batch of %i without changing the accepted25", count => {
    const before = original(), result = applyProgramAwardExpansion(before, publication(count), epoch);
    expect(result.entries).toHaveLength(25 + count); expect(result.verifiedCanonicalAwardIds).toHaveLength(25 + count);
    expect(result.entries.slice(0, 25)).toEqual(before.entries); expect(before.entries).toHaveLength(25);
    expect(result.release).toBe(before.release);
    expect(result.entries[25].basicFactSnapshot?.current).toBe(true);
    expect(result.entries[25].textFactReview).toBeUndefined();
    expect(result.entryByMemberAwardId.get(cohort.awards[0].canonical_shared_award_id)).toBe(result.entries[25]);
  });
  it("keeps the existing35 identities and facts intact when the third batch becomes public", () => {
    const existing = applyProgramAwardExpansion(original(), publication(10), epoch);
    const expanded = applyProgramAwardExpansion(original(), publication(15), epoch);
    expect(expanded.entries).toHaveLength(40);
    expect(expanded.entries.slice(0, 35)).toEqual(existing.entries);
    expect(expanded.entries.slice(35).map(entry => entry.registry.launch_rank)).toEqual([36, 37, 38, 39, 40]);
  });
  it("keeps every existing40 identity and approved basic fact when the fourth batch becomes public", () => {
    const existing = applyProgramAwardExpansion(original(), publication(15), epoch);
    const expanded = applyProgramAwardExpansion(original(), publication(20), epoch);
    expect(expanded.entries).toHaveLength(45);
    expect(expanded.entries.slice(0, 40)).toEqual(existing.entries);
    expect(expanded.entries.slice(40).map(entry => entry.registry.launch_rank)).toEqual([41, 42, 43, 44, 45]);
  });
  it.each([1, 2, 3])("rejects a fourth batch when prior batch %i is absent", batch => {
    const input = publication(20);
    const missing = new Set(cohort.awards.filter(award => award.batch === batch).map(award => award.cohort_key));
    input.awards = input.awards.filter(award => !missing.has(award.registry.cohort_key));
    expect(() => applyProgramAwardExpansion(original(), input, epoch)).toThrow("Expansion batch order changed.");
  });
  it("rejects a third batch published without either earlier batch", () => {
    const input = publication(15);
    input.awards = input.awards.slice(10);
    expect(() => applyProgramAwardExpansion(original(), input, epoch)).toThrow();
  });
  it("keeps all40 identities when a third-batch basic detail becomes stale", () => {
    const input = publication(15);
    Object.assign(input.awards[14].basic_fact, { current: false, public_facts: null });
    const expanded = applyProgramAwardExpansion(original(), input, epoch);
    expect(expanded.entries).toHaveLength(40);
    expect(expanded.entries[39].publishedFacts).toEqual(emptyBasicAwardFacts());
    expect(expanded.entries[39].basicFactSnapshot?.current).toBe(false);
  });
  it("keeps all45 identities and original40 facts when a fourth-batch basic detail becomes stale", () => {
    const input = publication(20);
    Object.assign(input.awards[19].basic_fact, { current: false, public_facts: null });
    const expanded = applyProgramAwardExpansion(original(), input, epoch);
    expect(expanded.entries).toHaveLength(45);
    expect(expanded.entries.slice(0, 40)).toEqual(applyProgramAwardExpansion(original(), publication(15), epoch).entries);
    expect(expanded.entries[44].publishedFacts).toEqual(emptyBasicAwardFacts());
    expect(expanded.entries[44].basicFactSnapshot?.current).toBe(false);
  });
  it("rejects a rank or publication count beyond the reviewed45", () => {
    const overRank = publication(20);
    overRank.awards[19].registry.launch_rank = 46;
    expect(() => applyProgramAwardExpansion(original(), overRank, epoch)).toThrow();
    const overCount = publication(20);
    overCount.awards.push(overCount.awards[19]);
    expect(() => applyProgramAwardExpansion(original(), overCount, epoch)).toThrow();
  });
  it("retains identity but clears stale details after a subsequent real change", () => {
    const input = publication(); Object.assign(input.awards[0].basic_fact, { current: false, public_facts: null });
    const result = applyProgramAwardExpansion(original(), input, epoch), added = result.entries[25];
    expect(added.effectivelyVerified).toBe(true); expect(added.publishedFacts).toEqual(emptyBasicAwardFacts());
    expect(added.basicFactSnapshot?.current).toBe(false);
  });
  it.each([
    (p: ReturnType<typeof publication>) => { p.epoch = id(999); },
    (p: ReturnType<typeof publication>) => { p.awards.pop(); },
    (p: ReturnType<typeof publication>) => { p.awards[0] = p.awards[1]; },
    (p: ReturnType<typeof publication>) => { p.awards = publication(10).awards.slice(5); },
    (p: ReturnType<typeof publication>) => { p.awards[0].registry.canonical_shared_award_id = id(999); },
    (p: ReturnType<typeof publication>) => { p.awards[0].registry.canonical_slug = "unreviewed-award"; },
    (p: ReturnType<typeof publication>) => { p.awards[0].registry.official_homepage = "https://unrelated.example/"; },
    (p: ReturnType<typeof publication>) => { p.awards[0].members[0].shared_award_id = id(998); },
    (p: ReturnType<typeof publication>) => { p.awards[0].source_ids.push(p.awards[0].source_ids[0]); },
    (p: ReturnType<typeof publication>) => { p.awards[0].source_ids = p.awards[1].source_ids; },
    (p: ReturnType<typeof publication>) => { p.awards[0].source_ids.push(id(100)); },
    (p: ReturnType<typeof publication>) => { p.awards[0].reviewed_homepage.source_id = id(997); },
    (p: ReturnType<typeof publication>) => { p.awards[0].registry.release_epoch = id(998) as unknown as null; },
    (p: ReturnType<typeof publication>) => { p.awards[0].basic_fact.kind = "full_manual_program_approval"; },
    (p: ReturnType<typeof publication>) => { p.awards[0].basic_fact.cohort_key = "original_0"; },
    (p: ReturnType<typeof publication>) => { p.awards[0].basic_fact.cohort_key = "original_0"; p.awards[0].basic_fact.award_id = id(1); },
    (p: ReturnType<typeof publication>) => { p.awards[0].registry.created_at = "2026-02-30T12:00:00Z"; },
  ])("rejects wrong identities, partial batches and unsupported publication %#", change => {
    const input = publication(); change(input); expect(() => applyProgramAwardExpansion(original(), input, epoch)).toThrow();
  });
  it("keeps the original25 available if expansion lookup fails", async () => {
    const before = original(); const rpc = vi.fn(async () => ({ error: { code: "unavailable" }, data: null }));
    expect(await loadProgramAwardExpansion({ rpc }, before, epoch)).toBe(before);
  });
  it("does not read expansion when the accepted release is unavailable", async () => {
    const before = { ...original(), available: false }; const rpc = vi.fn();
    expect(await loadProgramAwardExpansion({ rpc }, before, epoch)).toBe(before); expect(rpc).not.toHaveBeenCalled();
  });
});
