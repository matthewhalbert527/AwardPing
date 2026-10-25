import type { Json } from "@/lib/database.types";
import type { Stage1PublicationIndex } from "@/lib/stage1-publication";
import { PROGRAM_DETAIL_FIELDS } from "../../scripts/lib/program-change-contract.mjs";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const stamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const fields = ["overview", ...PROGRAM_DETAIL_FIELDS];
const scalars = new Set(["overview", "deadline", "opening_date", "cycle_status", "application_url"]);
function publicValues(value: unknown): value is Record<string, Json> {
  if (!object(value) || Object.keys(value).length !== fields.length + 3 || !fields.every(name => Object.hasOwn(value, name)) ||
    typeof value.reviewed_cycle !== "string" || !value.reviewed_cycle.trim() || value.reviewed_cycle.length > 120) return false;
  const list = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 256 && x.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 4000);
  if (!fields.every(name => scalars.has(name) ? value[name] === null || typeof value[name] === "string" && (value[name] as string).length <= 4000 : list(value[name])) ||
    !list(value.application_urls) || !list(value.not_published_fields) || new Set(value.not_published_fields).size !== value.not_published_fields.length ||
    value.not_published_fields.some(name => !fields.includes(name))) return false;
  return typeof value.overview === "string" && value.overview.trim().length > 0;
}

/** Apply only an atomically published whole batch, on top of the legacy identity gate. */
export function applyProgramFactPublication(index: Stage1PublicationIndex, snapshot: unknown): Stage1PublicationIndex {
  if (!object(snapshot) || snapshot.schema !== "awardping.program-fact-publication.v1" || !uuid(snapshot.revision) ||
    typeof snapshot.active !== "boolean" || !Array.isArray(snapshot.cohorts)) throw new Error("Invalid approved program-fact release.");
  if (!snapshot.active) {
    if (snapshot.cohorts.length) throw new Error("Inactive fact release contains published reviews.");
    return index;
  }
  if (!index.available || index.verifiedEntries.length !== 25 || snapshot.cohorts.length !== 25) throw new Error("Incomplete program-fact release.");
  const cohorts = snapshot.cohorts;
  const seen = new Set<string>(), sources = new Set<string>(), reviews = new Set<string>();
  const entries = index.entries.map(entry => {
    const row = cohorts.find(row => object(row) && row.cohort_key === entry.registry.cohort_key);
    if (!object(row) || seen.has(String(row.cohort_key)) || row.award_id !== entry.canonicalAwardId ||
      !uuid(row.review_id) || reviews.has(row.review_id) || !uuid(row.epoch) || !stamp(row.reviewed_at) || typeof row.current !== "boolean" ||
      !publicValues(row.public_facts) ||
      !Array.isArray(row.source_ids) || !row.source_ids.length || row.source_ids.length > 500 ||
      !row.source_ids.every(uuid) || new Set(row.source_ids).size !== row.source_ids.length ||
      row.source_ids.some(id => sources.has(id))) throw new Error("Wrong or incomplete award approval.");
    seen.add(String(row.cohort_key)); reviews.add(row.review_id); row.source_ids.forEach(id => sources.add(id));
    // Keep the independently pinned identity homepage even if its collection
    // role has moved to a new official page. No legacy identity is rewritten.
    const allowedSourceIds = [...new Set([...row.source_ids, ...(entry.officialHomepageSourceId ? [entry.officialHomepageSourceId] : [])])];
    return { ...entry, publishedFacts: row.public_facts as Json, allowedSourceIds, allowedSourceIdSet: new Set(allowedSourceIds),
      textFactReview: { id: row.review_id, reviewedAt: row.reviewed_at, current: row.current, releaseRevision: snapshot.revision as string } };
  });
  if (seen.size !== 25) throw new Error("Duplicate program-fact review identities.");
  return { ...index, entries, verifiedEntries: entries.filter(entry => entry.effectivelyVerified),
    entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
    entryByMemberAwardId: new Map(entries.flatMap(entry => entry.memberAwardIds.map(id => [id, entry] as const))) };
}
