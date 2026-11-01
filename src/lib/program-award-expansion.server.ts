import "server-only";
import { z } from "zod";
import cohort from "../../config/program-award-expansion.json";
import { applyProgramBasicFacts, emptyBasicAwardFacts } from "@/lib/program-basic-facts.server";
import type { Stage1MemberRow, Stage1PublicationEntry, Stage1PublicationIndex, Stage1PublicationRead, Stage1RegistryRow } from "@/lib/stage1-publication";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now() + 300_000);
const registry = z.object({
  cohort_key: z.string(), launch_rank: z.number().int().min(26).max(45), canonical_name: z.string(),
  canonical_shared_award_id: uuid, canonical_slug: z.string(), official_homepage: z.string().url().startsWith("https://"),
  publication_state: z.enum(["pending", "verified_beta", "revalidation_pending", "suspended"]),
  state_reason: z.string().min(1), policy_version: z.literal("program-basic-expansion-v1"),
  fact_ledger_batch_id: z.null(), release_epoch: z.null(), evidence_checked_at: timestamp.nullable(),
  last_verified_at: timestamp.nullable(), created_at: timestamp, updated_at: timestamp,
}).strict();
const member = z.object({ shared_award_id: uuid, cohort_key: z.string(), member_kind: z.literal("canonical"),
  reason: z.string().min(1), created_at: timestamp, updated_at: timestamp }).strict();
const snapshot = z.object({ schema: z.literal("awardping.program-award-expansion-publication.v1"), epoch: uuid,
  awards: z.array(z.object({ registry, members: z.array(member).length(1), source_ids: z.array(uuid).min(1).max(6),
    reviewed_homepage: z.object({ source_id: uuid, url: z.string().url().startsWith("https://") }).strict(),
    basic_fact: z.object({ award_id: uuid, cohort_key: z.string(), snapshot_id: uuid,
      kind: z.literal("automated_source_verified_basics"), current: z.boolean(), public_facts: z.unknown(), verified_at: timestamp }).strict(),
  }).strict()).max(20),
}).strict();

/** The original release is validated first. Only the four reviewed five-award batches can
 * extend it; basic information never becomes a complete-program approval.
 */
export function applyProgramAwardExpansion(index: Stage1PublicationIndex, value: unknown, epoch: string): Stage1PublicationIndex {
  if (!index.available || index.verifiedEntries.length !== 25 || index.entries.length !== 25) throw Error("Original award release is unavailable.");
  const parsed = snapshot.parse(value);
  if (parsed.epoch !== epoch || ![0, 5, 10, 15, 20].includes(parsed.awards.length)) throw Error("Expansion publication is incomplete.");
  if (!parsed.awards.length) return index;
  const known = new Map(cohort.awards.map(award => [award.cohort_key, award]));
  const seen = new Set<string>(), sources = new Set<string>();
  const extra: Stage1PublicationEntry[] = [];
  for (const row of parsed.awards) {
    const identity = known.get(row.registry.cohort_key);
    if (!identity || seen.has(identity.cohort_key) || index.entryByCohortKey.has(identity.cohort_key) ||
        index.entryByMemberAwardId.has(identity.canonical_shared_award_id) ||
        ["launch_rank", "canonical_shared_award_id", "canonical_name", "canonical_slug", "official_homepage"].some(key =>
          row.registry[key as keyof typeof row.registry] !== identity[key as keyof typeof identity]) ||
        row.registry.publication_state === "suspended" || row.members[0].cohort_key !== identity.cohort_key ||
        row.members[0].shared_award_id !== identity.canonical_shared_award_id ||
        row.basic_fact.cohort_key !== identity.cohort_key || row.basic_fact.award_id !== identity.canonical_shared_award_id ||
        new Set(row.source_ids).size !== row.source_ids.length || row.source_ids.some(id => sources.has(id) || index.entries.some(entry => entry.allowedSourceIdSet.has(id))) ||
        !row.source_ids.includes(row.reviewed_homepage.source_id) || row.reviewed_homepage.url !== identity.official_homepage) {
      throw Error("Expansion identity or source boundary changed.");
    }
    seen.add(identity.cohort_key); row.source_ids.forEach(id => sources.add(id));
    extra.push({ registry: row.registry as Stage1RegistryRow, canonicalAwardId: identity.canonical_shared_award_id,
      memberAwardIds: row.members.map(member => (member as Stage1MemberRow).shared_award_id),
      allowedSourceIds: row.source_ids, allowedSourceIdSet: new Set(row.source_ids), publishedFacts: emptyBasicAwardFacts(),
      officialHomepageSourceId: row.reviewed_homepage.source_id, officialHomepageUrl: row.reviewed_homepage.url,
      sourceIdentityRules: [], effectiveReason: "source_verified_basics", evaluatedAt: row.registry.updated_at, effectivelyVerified: true });
  }
  const expected = cohort.awards.filter(award => award.batch <= parsed.awards.length / 5);
  if (expected.some(award => !seen.has(award.cohort_key))) throw Error("Expansion batch order changed.");
  const entries = [...index.entries, ...extra.sort((a, b) => a.registry.launch_rank - b.registry.launch_rank)];
  const expanded = { ...index, entries, verifiedEntries: entries.filter(entry => entry.effectivelyVerified),
    verifiedCanonicalAwardIds: entries.filter(entry => entry.effectivelyVerified).map(entry => entry.canonicalAwardId),
    verifiedMemberAwardIds: entries.filter(entry => entry.effectivelyVerified).flatMap(entry => entry.memberAwardIds),
    entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
    entryByMemberAwardId: new Map(entries.flatMap(entry => entry.memberAwardIds.map(id => [id, entry] as const))) };
  return applyProgramBasicFacts(expanded, parsed.awards.map(row => row.basic_fact));
}

/** A missing or invalid expansion cannot hide or weaken the accepted 25. */
export async function loadProgramAwardExpansion(db: unknown, index: Stage1PublicationIndex, epoch: string, read?: Stage1PublicationRead): Promise<Stage1PublicationIndex> {
  if (!index.available) return index;
  try {
    const client = db as { rpc(name: string, args: { p_epoch: string }): PromiseLike<{ data: unknown; error: unknown }> };
    const result = await (read ? read() : client.rpc("get_program_award_expansion_publication", { p_epoch: epoch }));
    if (result.error) throw Error("Expansion publication request failed.");
    return applyProgramAwardExpansion(index, result.data, epoch);
  } catch { return index; }
}
