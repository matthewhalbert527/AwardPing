import "server-only";
import type { Json } from "@/lib/database.types";
import type { Stage1PublicationIndex } from "@/lib/stage1-publication";
import { PROGRAM_DETAIL_FIELDS } from "../../scripts/lib/program-change-contract.mjs";

const fields = ["overview", ...PROGRAM_DETAIL_FIELDS];
const scalar = new Set(["overview", "deadline", "opening_date", "cycle_status", "application_url"]);
const basic = new Set(["overview", "opening_date", "deadline", "cycle_status", "important_dates", "eligibility", "citizenship", "academic_levels", "disciplines",
  "award_amounts", "stipend", "tuition", "travel_research_allowance", "tenure", "application_url"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) && Date.parse(value) <= Date.now() + 5 * 60_000;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === "string" && Boolean(item.trim()) && item.length <= 4000);
function publicFacts(value: unknown): value is Record<string, Json> {
  return object(value) && Object.keys(value).length === fields.length + 3 && fields.every(field => Object.hasOwn(value, field) &&
    (scalar.has(field) ? value[field] === null || typeof value[field] === "string" && Boolean((value[field] as string).trim()) && (value[field] as string).length <= 4000 : list(value[field])) &&
    (basic.has(field) || (Array.isArray(value[field]) && (value[field] as unknown[]).length === 0))) &&
    typeof value.reviewed_cycle === "string" && Boolean(value.reviewed_cycle.trim()) && value.reviewed_cycle.length <= 120 &&
    list(value.application_urls) && Array.isArray(value.not_published_fields) && value.not_published_fields.length === 0;
}
export function emptyBasicAwardFacts(): Record<string, Json> {
  return { ...Object.fromEntries(fields.map(field => [field, scalar.has(field) ? null : []])), reviewed_cycle: "", application_urls: [], not_published_fields: [] };
}
function rebuild(index: Stage1PublicationIndex, entries: Stage1PublicationIndex["entries"]): Stage1PublicationIndex {
  return { ...index, entries, verifiedEntries: entries.filter(entry => entry.effectivelyVerified),
    entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
    entryByMemberAwardId: new Map(entries.flatMap(entry => entry.memberAwardIds.map(id => [id, entry] as const))) };
}

/** One award may have useful verified basics while other fields/awards stay held.
 * This is not a complete-program approval, application-route inventory or alert.
 */
export function applyProgramBasicFacts(index: Stage1PublicationIndex, rows: unknown): Stage1PublicationIndex {
  if (!index.available || !Array.isArray(rows) || rows.length > 100) throw Error("Basic award facts are unavailable.");
  const replacements = new Map<string, { id: string; current: boolean; verifiedAt: string; facts: Json }>();
  const snapshotIds = new Set<string>();
  for (const row of rows) {
    if (!object(row) || Object.keys(row).sort().join() !== ["award_id", "cohort_key", "snapshot_id", "kind", "current", "public_facts", "verified_at"].sort().join() ||
        !uuid(row.award_id) || !uuid(row.snapshot_id) || typeof row.cohort_key !== "string" || row.kind !== "automated_source_verified_basics" ||
        typeof row.current !== "boolean" || !timestamp(row.verified_at) || replacements.has(row.award_id) || snapshotIds.has(row.snapshot_id) ||
        (row.current ? !publicFacts(row.public_facts) : row.public_facts !== null)) throw Error("Invalid basic award snapshot.");
    const entry = index.entryByCohortKey.get(row.cohort_key);
    if (!entry?.effectivelyVerified || entry.canonicalAwardId !== row.award_id) throw Error("Basic award snapshot has the wrong identity.");
    snapshotIds.add(row.snapshot_id);
    replacements.set(row.award_id, { id: row.snapshot_id, current: row.current, verifiedAt: row.verified_at,
      facts: row.current ? row.public_facts as Json : emptyBasicAwardFacts() });
  }
  return rebuild(index, index.entries.map(entry => {
    const row = replacements.get(entry.canonicalAwardId);
    return row ? { ...entry, publishedFacts: row.facts, basicFactsUnavailable: false,
      basicFactSnapshot: { id: row.id, kind: "automated_source_verified_basics" as const, verifiedAt: row.verifiedAt, current: row.current } } : entry;
  }));
}

export async function loadProgramBasicFacts(db: unknown, index: Stage1PublicationIndex): Promise<Stage1PublicationIndex> {
  if (!index.available || !index.verifiedEntries.length) return index;
  try {
    const ids = index.verifiedEntries.map(entry => entry.canonicalAwardId);
    const client = db as { rpc(name: string, args: { p_award_ids: string[] }): PromiseLike<{ data: unknown; error: unknown }> };
    const result = await client.rpc("get_program_basic_facts", { p_award_ids: ids });
    if (result.error) throw Error("Basic award snapshot request failed.");
    return applyProgramBasicFacts(index, result.data);
  } catch {
    // An unreadable replacement must not resurrect an older conflicting ledger
    // value. Identities, official links and genuine update history stay available.
    return rebuild(index, index.entries.map(entry => ({ ...entry, publishedFacts: emptyBasicAwardFacts(), basicFactSnapshot: undefined, basicFactsUnavailable: true })));
  }
}
