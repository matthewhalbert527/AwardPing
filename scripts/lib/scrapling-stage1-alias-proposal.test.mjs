import { describe, expect, it } from "vitest";
import { buildScraplingStage1AliasProposal } from "./scrapling-stage1-alias-proposal.mjs";
import { validateScraplingSourceManifest, selectScraplingSource } from "./scrapling-worker.mjs";

const ids = Array.from({ length: 25 }, (_, n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`);
const aliasId = "10000000-0000-0000-0000-000000000001";
const anotherAliasId = "10000000-0000-0000-0000-000000000002";
const sourceId = "20000000-0000-0000-0000-000000000001";
const aliasSourceId = "20000000-0000-0000-0000-000000000002";
const time = "2026-10-19T01:42:14.325Z";
const alias = () => ({ award_id: aliasId, canonical_award_id: ids[0], cohort_key: "award-0" });
function fixture() {
  const original = { schema: "awardping.scrapling-source-manifest.v1", profile: "scrapling-evidence-v1", reviewed_at: time,
    award_ids: ids, sources: [{ id: sourceId, award_id: ids[0], url: "https://example.edu/eligibility/", kind: "html", roles: ["eligibility"] }] };
  const additions = [{ id: aliasSourceId, award_id: aliasId, canonical_award_id: ids[0],
    url: "https://example.edu/", kind: "html", roles: ["homepage", "cycle_announcements"] }];
  const registry = ids.map((id, n) => ({ cohort_key: `award-${n}`, canonical_shared_award_id: id }));
  const members = [...registry.map(row => ({ cohort_key: row.cohort_key, shared_award_id: row.canonical_shared_award_id, member_kind: "canonical" })),
    { cohort_key: "award-0", shared_award_id: aliasId, member_kind: "alias" }];
  const sources = [...original.sources, ...additions].map(row => ({ id: row.id, shared_award_id: row.award_id, url: row.url,
    page_type: row.roles[0], admin_review_status: "open", shared_awards: { id: row.award_id, status: "active" },
    page_metadata_generated_at: time, page_metadata_model: "existing-recorded-model", page_metadata: {
      baseline_facts: { award_relevance: "primary", cycle_relevance: "current-or-upcoming", confidence: "high" },
    } }));
  return { original, additions, registry, members, sources };
}
function client(data, mutate = () => {}) {
  const calls = [], reads = {};
  return { calls, from(table) {
    const call = { table }; calls.push(call);
    return {
      select(columns, options) { call.columns = columns; call.options = options; return this; },
      in(column, values) { call.filter = { column, values }; return this; },
      order(column) { call.order = column; return this; },
      range(start, end) { call.range = [start, end]; return this; },
      async abortSignal(signal) {
        expect(signal).toBeInstanceOf(AbortSignal);
        reads[table] = (reads[table] || 0) + 1;
        const key = { stage1_award_registry: "registry", stage1_award_members: "members", shared_award_sources: "sources" }[table];
        expect(key).toBeTruthy();
        const response = { data: structuredClone(data[key]), count: data[key].length, error: null };
        mutate(response, table, reads[table]);
        return response;
      },
    };
  } };
}
const run = (data, supabase = client(data)) => buildScraplingStage1AliasProposal({ supabase,
  manifest: data.original, additions: data.additions, reviewedAt: time });
function withAlias() {
  const f = fixture();
  return { ...f.original, sources: [...f.original.sources, ...f.additions.map(row => {
    const source = { ...row }; delete source.canonical_award_id; return source;
  })],
    award_aliases: [alias()] };
}

describe("explicit cohort alias manifest scope", () => {
  it("preserves direct-only manifests and exact stored ownership for aliases", () => {
    const original = fixture().original, bytes = JSON.stringify(original);
    expect(validateScraplingSourceManifest(original)).toBe(original);
    expect(JSON.stringify(original)).toBe(bytes);
    const manifest = validateScraplingSourceManifest(withAlias());
    expect(manifest.award_ids).toHaveLength(25);
    expect(selectScraplingSource({ id: aliasSourceId, shared_award_id: aliasId, url: "https://example.edu/", page_type: "homepage" }, manifest))
      .toMatchObject({ id: aliasSourceId, award_id: aliasId });
    expect(() => selectScraplingSource({ id: aliasSourceId, shared_award_id: ids[0], url: "https://example.edu/", page_type: "homepage" }, manifest)).toThrow(/identity/);
  });
  it.each([false, true])("allows the canonical and declared alias owners at one URL (reverse=%s)", reverse => {
    const manifest = withAlias();
    manifest.sources[1].url = manifest.sources[0].url;
    if (reverse) manifest.sources.reverse();
    const bytes = JSON.stringify(manifest);
    expect(validateScraplingSourceManifest(manifest)).toBe(manifest);
    expect(JSON.stringify(manifest)).toBe(bytes);
    for (const row of manifest.sources) expect(selectScraplingSource({ id: row.id, shared_award_id: row.award_id, url: row.url }, manifest)).toBe(row);
  });
  it("allows two distinct declared aliases sharing a URL in the same cohort", () => {
    const manifest = withAlias();
    manifest.award_aliases.push({ ...alias(), award_id: anotherAliasId });
    manifest.sources.push({ ...manifest.sources[1], id: ids[2], award_id: anotherAliasId });
    expect(validateScraplingSourceManifest(manifest)).toBe(manifest);
  });
  it.each([
    ["missing mapping", m => delete m.award_aliases],
    ["outsider canonical", m => m.award_aliases[0].canonical_award_id = anotherAliasId],
    ["duplicate alias", m => m.award_aliases.push(alias())],
    ["canonical masquerading as alias", m => m.award_aliases[0].award_id = ids[0]],
    ["unknown field", m => m.award_aliases[0].approved = true],
    ["missing cohort", m => delete m.award_aliases[0].cohort_key],
    ["null mapping", m => m.award_aliases = null],
    ["unused mapping", m => m.sources.pop()],
    ["expanded canonical roster", m => m.award_ids = [...m.award_ids, aliasId]],
    ["cohort conflict", m => m.award_aliases.push({ award_id: anotherAliasId, canonical_award_id: ids[1], cohort_key: "award-0" })],
    ["canonical conflict", m => m.award_aliases.push({ award_id: anotherAliasId, canonical_award_id: ids[0], cohort_key: "other" })],
    ["duplicate canonical-owner URL", m => m.sources.push({ ...m.sources[0], id: ids[2] })],
    ["duplicate alias-owner URL", m => m.sources.push({ ...m.sources[1], id: ids[2] })],
  ])("rejects %s", (_, mutate) => {
    const manifest = withAlias(); mutate(manifest);
    expect(() => validateScraplingSourceManifest(manifest)).toThrow();
  });
});

describe("read-only actual Stage 1 membership proposal builder", () => {
  it("uses two complete registry/member/source reads; keeps old entries and never grants activation", async () => {
    const f = fixture(), original = structuredClone(f), supabase = client(f);
    const result = await run(f, supabase);
    expect(f).toEqual(original);
    expect(result.manifest.sources[0]).toEqual(f.original.sources[0]);
    expect(result.manifest.award_ids).toEqual(f.original.award_ids);
    expect(result.manifest.award_aliases).toEqual([alias()]);
    expect(result.manifest.sources[1]).not.toHaveProperty("canonical_award_id");
    expect(result.manifest.sources[1].award_id).toBe(aliasId);
    expect(result.evidence).toEqual({ registry: f.registry, members: f.members, sources: f.sources });
    expect(result.receipt).toMatchObject({ stable_two_pass_inputs: true, canonical_award_count: 25, source_count: 2,
      alias_count: 1, activation_authorized: false, queue_readiness_verified: false, retained_bytes_verified: false,
      production_mutations: 0, provider_calls: 0, proposal_only: true });
    expect(result.receipt.members_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(supabase.calls).toHaveLength(6);
    for (const call of supabase.calls) expect(call.options).toEqual({ count: "exact" });
    expect(supabase.calls.filter(call => call.table === "shared_award_sources").every(call =>
      JSON.stringify(call.filter) === JSON.stringify({ column: "id", values: [sourceId, aliasSourceId] }))).toBe(true);
  });
  it("keeps both same-URL source rows and stored owners through two independent membership observations", async () => {
    const f = fixture();
    f.additions[0].url = f.original.sources[0].url;
    f.sources[1].url = f.original.sources[0].url;
    const original = structuredClone(f), supabase = client(f), result = await run(f, supabase);
    expect(f).toEqual(original);
    expect(result.manifest.sources).toEqual([f.original.sources[0], {
      id: aliasSourceId, award_id: aliasId, url: f.original.sources[0].url, kind: "html", roles: f.additions[0].roles,
    }]);
    expect(result.manifest.award_aliases).toEqual([alias()]);
    for (const row of f.sources) expect(selectScraplingSource(row, result.manifest)).toMatchObject({ id: row.id, award_id: row.shared_award_id });
    expect(result.evidence.sources).toEqual(f.sources);
    expect(result.receipt).toMatchObject({ stable_two_pass_inputs: true, source_count: 2, alias_count: 1,
      activation_authorized: false, queue_readiness_verified: false, retained_bytes_verified: false,
      production_mutations: 0, provider_calls: 0, proposal_only: true });
    expect(supabase.calls).toHaveLength(6);
    expect(supabase.calls.filter(call => call.table === "shared_award_sources").map(call => call.filter)).toEqual([
      { column: "id", values: [sourceId, aliasSourceId] }, { column: "id", values: [sourceId, aliasSourceId] },
    ]);
  });
  it.each([
    ["missing membership", f => f.members.pop()],
    ["wrong cohort", f => f.members.at(-1).cohort_key = "award-1"],
    ["reparenting", f => f.sources[1].shared_award_id = ids[0]],
    ["URL drift", f => f.sources[1].url += "different/"],
    ["duplicate source ID", f => f.additions[0].id = sourceId],
  ])("same-URL proposals still reject %s", async (_, mutate) => {
    const f = fixture();
    f.additions[0].url = f.original.sources[0].url;
    f.sources[1].url = f.original.sources[0].url;
    mutate(f);
    await expect(run(f)).rejects.toThrow();
  });
  it.each([
    ["guessed canonical target", f => f.additions[0].canonical_award_id = ids[1]],
    ["missing alias membership", f => f.members.pop()],
    ["duplicate alias membership", f => f.members.push({ ...f.members.at(-1) })],
    ["alias in another cohort", f => f.members.at(-1).cohort_key = "award-1"],
    ["unknown cohort", f => f.members.at(-1).cohort_key = "outsider"],
    ["invalid member kind", f => f.members.at(-1).member_kind = "guessed"],
    ["missing canonical member", f => f.members.shift()],
    ["canonical reused as alias", f => f.members.at(-1).shared_award_id = ids[1]],
    ["registry outsider", f => f.registry[0].canonical_shared_award_id = anotherAliasId],
    ["registry duplicate", f => f.registry[1].cohort_key = f.registry[0].cohort_key],
    ["missing registry cohort", f => f.registry.pop()],
    ["source reparented", f => f.sources[1].shared_award_id = ids[0]],
    ["URL redirect substitution", f => f.sources[1].url += "apply/"],
    ["closed approval", f => f.sources[1].admin_review_status = "review_later"],
    ["inactive alias award", f => f.sources[1].shared_awards.status = "inactive"],
    ["source quality rejected", f => f.sources[1].page_metadata.baseline_facts.award_relevance = "unrelated"],
    ["missing source", f => f.sources.pop()],
    ["PDF source", f => f.sources[1].page_type = "pdf"],
    ["source ID outside allowlist", f => f.sources[1].id = ids[1]],
  ])("rejects %s", async (_, mutate) => { const f = fixture(); mutate(f); await expect(run(f)).rejects.toThrow(); });
  it.each(["stage1_award_registry", "stage1_award_members", "shared_award_sources"])("rejects %s drift between reads", async table => {
    const f = fixture(), supabase = client(f, (response, actual, pass) => {
      if (actual === table && pass === 2) response.data[0].unexpected_changed_input = true;
    });
    await expect(run(f, supabase)).rejects.toThrow(/changed between reads/);
  });
  it("retains independent observations when a transport mutates and reuses its row objects", async () => {
    const f = fixture();
    const supabase = client(f, (response, table, pass) => {
      if (table !== "shared_award_sources") return;
      if (pass === 2) f.sources[1].admin_review_note = "different observed approval input";
      response.data = f.sources;
    });
    await expect(run(f, supabase)).rejects.toThrow(/changed between reads/);
  });
  it("returned evidence cannot be changed by later transport-buffer mutation", async () => {
    const f = fixture(), supabase = client(f, (response, table) => {
      if (table === "shared_award_sources") response.data = f.sources;
    });
    const result = await run(f, supabase);
    f.sources[1].url = "https://example.edu/elsewhere/";
    expect(result.evidence.sources[1].url).toBe("https://example.edu/");
  });
  it.each(["query error", "missing count", "truncated count"])("rejects %s without mutation", async kind => {
    const f = fixture(), supabase = client(f, response => {
      if (kind === "query error") response.error = { message: "private diagnostic must not be echoed" };
      if (kind === "missing count") response.count = null;
      if (kind === "truncated count") response.count += 1;
    });
    await expect(run(f, supabase)).rejects.toThrow("read failed");
  });
});
