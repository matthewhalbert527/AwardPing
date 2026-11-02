import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import cohort from "../../config/program-award-expansion.json";
import textMonitoring from "../../config/program-text-monitoring.json";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

// Model React's documented request dispatcher lifetime, never a global memo.
const state = vi.hoisted(() => ({ scope: null as Map<unknown, unknown> | null, read: vi.fn(), raw: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (fn: () => unknown) => () => {
  if (!state.scope) return fn();
  if (!state.scope.has(fn)) state.scope.set(fn, fn());
  return state.scope.get(fn);
} }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIdentityIndex: state.read, loadStage1PublicationIndex: state.raw }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: state.rpc }) }));
import { loadPublicRenderPublicationIndex, loadPublicRenderDirectoryPublicationIndex } from "@/lib/public-render-publication";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";
import { emptyBasicAwardFacts } from "@/lib/program-basic-facts.server";
const at = "2026-10-29T12:00:00.000Z", id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const publicCount = 25 + cohort.awards.length;
function original(): Stage1PublicationIndex {
  const entries = Array.from({ length: 25 }, (_, n) => ({ registry: { cohort_key: `original_${n}` }, canonicalAwardId: id(n + 1), memberAwardIds: [id(n + 1)],
    effectivelyVerified: true, allowedSourceIds: [id(n + 100)], allowedSourceIdSet: new Set([id(n + 100)]), publishedFacts: emptyBasicAwardFacts(), basicFactsUnavailable: true } as unknown as Stage1PublicationEntry));
  return { available: true, entries, verifiedEntries: entries, verifiedCanonicalAwardIds: entries.map(e => e.canonicalAwardId), verifiedMemberAwardIds: entries.map(e => e.canonicalAwardId),
    entryByCohortKey: new Map(entries.map(e => [e.registry.cohort_key, e])), entryByMemberAwardId: new Map(entries.map(e => [e.canonicalAwardId, e])) } as Stage1PublicationIndex;
}
function identities() {
  return { schema: "awardping.program-award-expansion-identities.v1", epoch: textMonitoring.epoch,
    awards: cohort.awards.map((a, n) => ({ registry: { cohort_key: a.cohort_key, launch_rank: a.launch_rank, canonical_name: a.canonical_name, canonical_shared_award_id: a.canonical_shared_award_id,
      canonical_slug: a.canonical_slug, official_homepage: a.official_homepage, publication_state: "pending", state_reason: "Reviewed test identity", policy_version: "program-basic-expansion-v1",
      fact_ledger_batch_id: null, release_epoch: null, evidence_checked_at: null, last_verified_at: null, created_at: at, updated_at: at },
      members: [{ shared_award_id: a.canonical_shared_award_id, cohort_key: a.cohort_key, member_kind: "canonical", reason: "Reviewed test identity", created_at: at, updated_at: at }],
      source_ids: [id(n + 200)], reviewed_homepage: { source_id: id(n + 200), url: a.official_homepage } })) };
}
function basicRows(ids: string[]) {
  return ids.map((award_id, n) => ({ award_id, cohort_key: original().entryByMemberAwardId.get(award_id)?.registry.cohort_key || cohort.awards.find(a => a.canonical_shared_award_id === award_id)!.cohort_key,
    snapshot_id: id(n + 300), kind: "automated_source_verified_basics", current: true, verified_at: at,
    public_facts: { ...emptyBasicAwardFacts(), reviewed_cycle: "Current test cycle", overview: "Fresh source-supported basics" } }));
}
beforeEach(() => {
  state.scope = null; state.read.mockReset().mockImplementation(async () => original()); state.raw.mockReset(); state.rpc.mockReset();
  state.rpc.mockImplementation(async (name: string, args: { p_award_ids?: string[] }) => {
    if (name === "get_program_award_expansion_identities") return { data: identities(), error: null };
    if (name === "get_program_text_public_alert_source_bindings") return { data: { schema: "awardping.program-text-public-alert-sources.v1", epoch: textMonitoring.epoch, source_count: 0, bindings: [] }, error: null };
    if (name === "get_program_basic_facts") return { data: basicRows(args.p_award_ids!), error: null };
    throw Error("Unexpected public read " + name);
  });
});

it("homepage/update identity reads share one in-flight render read and never scan60 basic facts", async () => {
  let finish!: (value: Stage1PublicationIndex) => void; state.read.mockReturnValue(new Promise(resolve => { finish = resolve; })); state.scope = new Map();
  const home = loadPublicRenderPublicationIndex(), updates = loadPublicRenderPublicationIndex(); expect(home).toBe(updates); expect(state.read).toHaveBeenCalledTimes(1);
  finish(original()); const index = await updates;
  expect(index.verifiedEntries).toHaveLength(publicCount); expect(index.entries.every(e => e.basicFactsUnavailable && (e.publishedFacts as { overview: unknown }).overview === null)).toBe(true);
  expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["get_program_award_expansion_identities", "get_program_text_public_alert_source_bindings"]);
});

it("directory makes exactly one bounded60-award facts query after thin authority completes", async () => {
  state.scope = new Map(); const index = await loadPublicRenderDirectoryPublicationIndex();
  expect(index.verifiedEntries).toHaveLength(publicCount); expect(index.entries.every(e => e.basicFactSnapshot?.current)).toBe(true);
  expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["get_program_award_expansion_identities", "get_program_text_public_alert_source_bindings", "get_program_basic_facts"]);
  const ids = state.rpc.mock.calls[2][1].p_award_ids; expect(ids).toHaveLength(publicCount); expect(new Set(ids).size).toBe(publicCount);
  await loadPublicRenderDirectoryPublicationIndex(); expect(state.rpc).toHaveBeenCalledTimes(3);
});

it("never overlaps the directory facts scan with the preceding source-authority query", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let finish!: (result: unknown) => void;
  state.rpc.mockImplementation((name: string, args: { p_award_ids?: string[] }) => name === "get_program_text_public_alert_source_bindings"
    ? new Promise(resolve => { finish = resolve; }) : normal(name, args));
  const loading = loadPublicRenderDirectoryPublicationIndex();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(state.rpc.mock.calls.some(([name]) => name === "get_program_basic_facts")).toBe(false);
  finish({ data: { schema: "awardping.program-text-public-alert-sources.v1", epoch: textMonitoring.epoch, source_count: 0, bindings: [] }, error: null });
  expect((await loading).verifiedEntries).toHaveLength(publicCount);
  expect(state.rpc.mock.calls.filter(([name]) => name === "get_program_basic_facts")).toHaveLength(1);
});

it("a new render rechecks authority and does not retain previous facts after a release closes", async () => {
  state.scope = new Map(); expect((await loadPublicRenderDirectoryPublicationIndex()).verifiedEntries).toHaveLength(publicCount);
  state.read.mockResolvedValueOnce({ ...original(), available: false, verifiedEntries: [] }); state.scope = new Map();
  const next = await loadPublicRenderDirectoryPublicationIndex(); expect(next.available).toBe(false); expect(next.verifiedEntries).toHaveLength(0); expect(state.rpc).toHaveBeenCalledTimes(3);
});

it("identity or fact failures never fabricate expansion rows or resurrect retired facts", async () => {
  state.rpc.mockResolvedValueOnce({ data: { ...identities(), awards: identities().awards.slice(0, 24) }, error: null });
  expect((await loadPublicRenderPublicationIndex()).verifiedEntries).toHaveLength(25);
  state.rpc.mockImplementation(async (name: string) => name === "get_program_award_expansion_identities" ? { data: identities(), error: null } : name === "get_program_text_public_alert_source_bindings"
    ? { data: { schema: "awardping.program-text-public-alert-sources.v1", epoch: textMonitoring.epoch, source_count: 0, bindings: [] }, error: null } : { data: null, error: { code: "57014" } });
  const failed = await loadPublicRenderDirectoryPublicationIndex(); expect(failed.verifiedEntries).toHaveLength(publicCount); expect(failed.entries.every(e => e.basicFactsUnavailable && (e.publishedFacts as { overview: unknown }).overview === null)).toBe(true);
});

it("raw actions and delivery remain uncached while non-render callers do not reuse a memo", async () => {
  state.raw.mockResolvedValue({ available: false, verifiedEntries: [] }); state.scope = new Map(); await loadStage1PublicationIndex(); await loadStage1PublicationIndex(); expect(state.raw).toHaveBeenCalledTimes(2);
  state.scope = null; await loadPublicRenderPublicationIndex(); await loadPublicRenderPublicationIndex(); expect(state.read).toHaveBeenCalledTimes(2);
});

it("publication/read-state/delivery keep full current authority and no persistent or private cache exists", () => {
  for (const path of ["../app/api/shared-awards/[id]/route.ts", "../app/api/shared-award-change-reads/route.ts", "./public-updates.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8"); expect(source).toContain("loadStage1PublicationIndex"); expect(source).not.toContain("public-render-publication");
  }
  expect(readFileSync(new URL("./public-render-publication.ts", import.meta.url), "utf8")).not.toMatch(/unstable_cache|setTimeout|new Map|userId|officeId|force-cache/);
});

it("keeps the original50 public while the final ten remain unadmitted", async () => { const normal=state.rpc.getMockImplementation()!; state.rpc.mockImplementation((name: string, args: { p_award_ids?: string[] }) => name === "get_program_award_expansion_identities" ? Promise.resolve({data:{...identities(),awards:identities().awards.slice(0,25)},error:null}) : normal(name,args)); const index=await loadPublicRenderDirectoryPublicationIndex(); expect(index.verifiedEntries).toHaveLength(50); expect(state.rpc.mock.calls.find(([name])=>name === "get_program_basic_facts")![1].p_award_ids).toHaveLength(50); });
