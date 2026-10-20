import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateScraplingSourceManifest, selectScraplingSource } from "./scrapling-worker.mjs";
import { sourceQualityDecision } from "./source-quality.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = message => { throw new Error(`Scrapling alias proposal: ${message}`); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const hash = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const sourceColumns = "id,shared_award_id,url,page_type,admin_review_status,admin_review_note,admin_reviewed_at,admin_reviewed_by,title,display_title,page_metadata,page_metadata_generated_at,page_metadata_model,shared_awards!inner(id,status)";

async function exactRead(query, limit, label) {
  const { data, error, count } = await query.range(0, limit - 1).abortSignal(AbortSignal.timeout(30000));
  ensure(!error && Array.isArray(data) && Number.isSafeInteger(count) && count === data.length && count <= limit,
    `${label} read failed, exceeded its bound or was incomplete`);
  ensure(Buffer.byteLength(JSON.stringify(data)) <= 10 * 1024 * 1024, `${label} evidence exceeds bound`);
  // A transport/cache may reuse object references across reads. Retain the
  // first observation independently before comparing a later response.
  return structuredClone(data);
}

async function readObservation(supabase, awardIds, sourceIds) {
  const registry = await exactRead(supabase.from("stage1_award_registry")
    .select("cohort_key,canonical_shared_award_id", { count: "exact" }).order("cohort_key"), 25, "registry");
  ensure(registry.length === 25 && new Set(registry.map(row => row.cohort_key)).size === 25 &&
    new Set(registry.map(row => row.canonical_shared_award_id)).size === 25 &&
    registry.every(row => typeof row.cohort_key === "string" && /^[a-z0-9_-]{1,80}$/.test(row.cohort_key) &&
      awardIds.includes(row.canonical_shared_award_id)), "registry does not match the exact canonical 25");
  const members = await exactRead(supabase.from("stage1_award_members")
    .select("cohort_key,shared_award_id,member_kind", { count: "exact" })
    .in("cohort_key", registry.map(row => row.cohort_key)).order("shared_award_id"), 300, "membership");
  const sources = await exactRead(supabase.from("shared_award_sources").select(sourceColumns, { count: "exact" })
    .in("id", sourceIds).order("id"), 300, "sources");
  ensure(sources.length === sourceIds.length && new Set(sources.map(row => row.id)).size === sources.length &&
    sources.every(row => sourceIds.includes(row.id)), "source identities missing or duplicated");
  const registryByCohort = new Map(registry.map(row => [row.cohort_key, row]));
  const seen = new Set();
  for (const member of members) {
    const canonicalId = registryByCohort.get(member.cohort_key)?.canonical_shared_award_id;
    ensure(canonicalId && uuid.test(member.shared_award_id) && !seen.has(member.shared_award_id) &&
      ["canonical", "alias"].includes(member.member_kind), "invalid, duplicate or outsider membership");
    ensure(member.member_kind === "canonical" ? member.shared_award_id === canonicalId : !awardIds.includes(member.shared_award_id),
      "membership kind conflicts with canonical identity");
    seen.add(member.shared_award_id);
  }
  for (const row of registry) ensure(members.filter(member => member.cohort_key === row.cohort_key &&
    member.member_kind === "canonical" && member.shared_award_id === row.canonical_shared_award_id).length === 1,
  "canonical membership is missing");
  return { registry, members, sources };
}

/**
 * Read-only proposal for existing registered aliases. No source is reparented,
 * approved, merged or enrolled here. Queue, preserved bytes and maintenance
 * gates remain separate. The caller must retain this evidence with any proposal.
 * No CLI or implicit credential loading: this cannot run at import time.
 */
export async function buildScraplingStage1AliasProposal({ supabase, manifest, additions, reviewedAt } = {}) {
  const original = structuredClone(validateScraplingSourceManifest(manifest));
  ensure(Array.isArray(additions) && additions.length > 0 && additions.length <= 300, "alias additions required");
  ensure(typeof reviewedAt === "string" && Number.isFinite(Date.parse(reviewedAt)), "review timestamp required");
  const extra = structuredClone(additions);
  const sourceIds = [...original.sources.map(row => row.id), ...extra.map(row => row.id)];
  ensure(sourceIds.length <= 300 && sourceIds.every(id => uuid.test(id)) && new Set(sourceIds).size === sourceIds.length,
    "source list is oversized or duplicates an existing source");
  for (const row of extra) ensure(uuid.test(row.award_id) && !original.award_ids.includes(row.award_id) &&
    original.award_ids.includes(row.canonical_award_id), "an addition must name a stored alias and a canonical roster award");
  sourceIds.sort();
  const first = await readObservation(supabase, original.award_ids, sourceIds);
  const second = await readObservation(supabase, original.award_ids, sourceIds);
  ensure(isDeepStrictEqual(first, second), "registry, membership or approval inputs changed between reads");
  const canonicalByCohort = new Map(second.registry.map(row => [row.cohort_key, row.canonical_shared_award_id]));
  const membersById = new Map(second.members.map(row => [row.shared_award_id, row]));
  const sourceById = new Map(second.sources.map(row => [row.id, row]));
  const aliases = new Map();
  for (const row of [...original.sources, ...extra]) {
    const membership = membersById.get(row.award_id);
    ensure(membership, "source award is not a registered Stage 1 member");
    if (!original.award_ids.includes(row.award_id)) {
      const actual = { award_id: row.award_id, canonical_award_id: canonicalByCohort.get(membership.cohort_key),
        cohort_key: membership.cohort_key };
      const expected = extra.includes(row) ? row.canonical_award_id :
        original.award_aliases?.find(alias => alias.award_id === row.award_id)?.canonical_award_id;
      ensure(membership.member_kind === "alias" && actual.canonical_award_id === expected,
        "alias does not belong to the requested canonical award");
      const previous = original.award_aliases?.find(alias => alias.award_id === row.award_id);
      ensure(!previous || isDeepStrictEqual(previous, actual), "existing manifest alias disagrees with the registry");
      aliases.set(row.award_id, actual);
    }
    const live = sourceById.get(row.id);
    ensure(live?.shared_award_id === row.award_id && live.url === row.url && live.page_type !== "pdf" &&
      live.admin_review_status === "open" && live.shared_awards?.id === row.award_id && live.shared_awards.status === "active",
    "live source identity, open status or active award differs");
    ensure(sourceQualityDecision(live, { purpose: "monitoring" }).allowed === true,
      "existing monitoring approval does not allow this source");
  }
  const proposed = { ...original, reviewed_at: reviewedAt,
    sources: [...original.sources, ...extra.map(row => {
      const source = { ...row };
      delete source.canonical_award_id;
      return source;
    })],
    award_aliases: [...aliases.values()].sort((a, b) => a.award_id.localeCompare(b.award_id)) };
  validateScraplingSourceManifest(proposed);
  for (const source of second.sources) ensure(selectScraplingSource(source, proposed)?.id === source.id, "runtime identity mismatch");
  return {
    manifest: proposed,
    evidence: second,
    receipt: { schema: "awardping.scrapling-stage1-alias-proposal.v1", reviewed_at: reviewedAt,
      stable_two_pass_inputs: true, registry_sha256: hash(second.registry), members_sha256: hash(second.members),
      source_approval_inputs_sha256: hash(second.sources), canonical_award_count: 25, source_count: proposed.sources.length,
      alias_count: aliases.size, production_mutations: 0, provider_calls: 0, proposal_only: true,
      activation_authorized: false, queue_readiness_verified: false, retained_bytes_verified: false },
  };
}
