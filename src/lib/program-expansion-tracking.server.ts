import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";
import { isStage1SourceIdentityExcluded } from "@/lib/stage1-publication";
import cohort from "../../config/program-award-expansion.json";
import monitoring from "../../config/program-text-monitoring.json";

export const programExpansionTrackingPolicy = "program-basic-expansion-v1";
type ExpansionPublication = Stage1PublicationEntry & { registry: Stage1PublicationEntry["registry"] & { policy_version: typeof programExpansionTrackingPolicy } };
type SourceBinding = Pick<Database["public"]["Tables"]["shared_award_sources"]["Row"],
  "id" | "shared_award_id" | "url" | "title" | "page_type" | "confidence" | "reason" | "admin_review_status" | "updated_at">;
export type ProgramExpansionTrackingContext = {
  schema: "awardping.program-award-expansion-tracking.v1";
  cohort_key: string; canonical_shared_award_id: string; admission_id: string; epoch: string;
  source_ids: string[]; sources: SourceBinding[];
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(v);
const nullableText = (v: unknown) => v === null || typeof v === "string";
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function conflict(): never { throw Object.assign(new Error("Award monitoring details changed. Refresh and try again."), { code: "40001" }); }

export function isProgramExpansionPublication(publication: Stage1PublicationEntry | null): publication is ExpansionPublication {
  return publication?.registry.policy_version === programExpansionTrackingPolicy;
}
/** A modern admitted identity is stronger than the legacy discovery heuristic.
 * In particular, the two reviewed DAAD detail_to_show documents are not broad
 * scholarship listings. This grants nothing to a changed or unbound URL. */
export function isApprovedProgramExpansionSource(publication: Stage1PublicationEntry, context: ProgramExpansionTrackingContext, source: Pick<SourceBinding, "id" | "shared_award_id" | "url">) {
  const approved = publication.approvedTextAlertSourceBindings?.[source.id];
  if (!isProgramExpansionPublication(publication) || context.schema !== "awardping.program-award-expansion-tracking.v1" || !uuid(context.admission_id) || context.epoch !== monitoring.epoch || context.cohort_key !== publication.registry.cohort_key ||
      context.canonical_shared_award_id !== publication.canonicalAwardId || !same(publication.memberAwardIds, [source.shared_award_id]) || source.shared_award_id !== context.canonical_shared_award_id ||
      !context.source_ids.includes(source.id) || !publication.allowedSourceIdSet.has(source.id) || !approved || approved.url !== source.url || approved.shared_award_id !== source.shared_award_id || approved.epoch !== context.epoch ||
      isStage1SourceIdentityExcluded(publication, source)) return false;
  try { const url = new URL(source.url); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port && !url.hash && url.href === source.url; }
  catch { return false; }
}

/** Only the exact public expansion and current admitted text-source DTO grants
 * modern follow eligibility. It never invents a legacy release epoch or changes
 * review_later to OPEN. Authenticated SQL rechecks admission and source bindings. */
export async function loadProgramExpansionTrackingContext(admin: SupabaseClient<Database>, publication: Stage1PublicationEntry, sourceId?: string, purpose: "track" | "untrack" = "track") {
  const identity = cohort.awards.find(a => a.cohort_key === publication.registry.cohort_key);
  if (!isProgramExpansionPublication(publication) || purpose === "track" && !publication.effectivelyVerified || !identity ||
      publication.canonicalAwardId !== identity.canonical_shared_award_id || publication.registry.canonical_shared_award_id !== identity.canonical_shared_award_id ||
      !same(publication.memberAwardIds, [identity.canonical_shared_award_id]) || sourceId !== undefined && !uuid(sourceId)) conflict();
  const result = await (admin as SupabaseClient).rpc("get_program_award_expansion_tracking_context", { p_shared_award_id: publication.canonicalAwardId });
  const value: unknown = result.data;
  if (result.error || !exact(value, ["schema", "cohort_key", "canonical_shared_award_id", "admission_id", "epoch", "source_ids", "sources"]) ||
      value.schema !== "awardping.program-award-expansion-tracking.v1" || value.cohort_key !== identity.cohort_key || value.canonical_shared_award_id !== identity.canonical_shared_award_id ||
      !uuid(value.admission_id) || !uuid(value.epoch) || purpose === "track" && value.epoch !== monitoring.epoch || !Array.isArray(value.source_ids) || !value.source_ids.length || value.source_ids.length > 6 ||
      value.source_ids.some(id => !uuid(id)) || new Set(value.source_ids).size !== value.source_ids.length || !Array.isArray(value.sources)) conflict();
  const context = value as unknown as ProgramExpansionTrackingContext;
  if (JSON.stringify(context.source_ids) !== JSON.stringify([...context.source_ids].sort()) || sourceId !== undefined && !context.source_ids.includes(sourceId)) conflict();
  // Removing an existing follow does not require fresh facts or a source that
  // remains monitorable. The authenticated RPC checks office ownership and the
  // immutable admitted source identity before deleting only that office's rows.
  if (purpose === "untrack") return { context, sources: [] };
  if (!same(context.source_ids, publication.allowedSourceIds) || !same(context.source_ids, [...publication.allowedSourceIdSet]) || context.sources.length !== context.source_ids.length) conflict();
  if (!same(context.sources.map(s => s.id), context.source_ids) || JSON.stringify(context.source_ids) !== JSON.stringify([...context.source_ids].sort()) ||
      JSON.stringify(context.sources.map(s => s.id)) !== JSON.stringify(context.source_ids)) conflict();
  for (const source of context.sources) {
    if (!exact(source, ["id", "shared_award_id", "url", "title", "page_type", "confidence", "reason", "admin_review_status", "updated_at"]) ||
        !isApprovedProgramExpansionSource(publication, context, source) ||
        typeof source.url !== "string" || !nullableText(source.title) || !nullableText(source.page_type) || !nullableText(source.reason) ||
        source.confidence !== null && (typeof source.confidence !== "number" || !Number.isFinite(source.confidence)) || typeof source.updated_at !== "string" || !Number.isFinite(Date.parse(source.updated_at)) ||
        !["open", "review_later"].includes(source.admin_review_status)) conflict();
  }
  if (sourceId !== undefined && !context.source_ids.includes(sourceId)) conflict();
  return { context, sources: sourceId === undefined ? context.sources : context.sources.filter(s => s.id === sourceId) };
}

export async function trackProgramExpansionForOffice(input: {
  supabase: SupabaseClient<Database>; publication: Stage1PublicationEntry; context: ProgramExpansionTrackingContext;
  sources: SourceBinding[]; officeId: string; cadence: "daily";
}) {
  if (!isProgramExpansionPublication(input.publication) || input.context.cohort_key !== input.publication.registry.cohort_key || input.context.canonical_shared_award_id !== input.publication.canonicalAwardId ||
      input.context.epoch !== monitoring.epoch || !uuid(input.context.admission_id) || !input.sources.length || input.sources.length > input.context.sources.length || new Set(input.sources.map(s => s.id)).size !== input.sources.length ||
      input.sources.some(s => !input.context.sources.some(current => JSON.stringify(current) === JSON.stringify(s)))) conflict();
  const result = await (input.supabase as SupabaseClient).rpc("track_office_program_expansion_atomic", {
    p_office_id: input.officeId, p_cohort_key: input.context.cohort_key, p_expected_admission_id: input.context.admission_id,
    p_expected_epoch: input.context.epoch, p_expected_source_bindings: [...input.sources].sort((a, b) => a.id.localeCompare(b.id)) as unknown as Json, p_cadence: input.cadence,
  });
  if (result.error) throw Object.assign(new Error("Shared award could not be tracked. Refresh and try again."), { code: result.error.code });
  if (!object(result.data) || !object(result.data.award)) conflict();
  return result.data;
}

export async function untrackProgramExpansionForOffice(input: {
  supabase: SupabaseClient<Database>; context: ProgramExpansionTrackingContext; officeId: string; sourceId?: string;
}) {
  if (!uuid(input.context.admission_id) || !uuid(input.context.epoch) || input.sourceId !== undefined && !input.context.source_ids.includes(input.sourceId)) conflict();
  const result = await (input.supabase as SupabaseClient).rpc("untrack_office_program_expansion_atomic", {
    p_office_id: input.officeId, p_cohort_key: input.context.cohort_key, p_expected_admission_id: input.context.admission_id,
    p_expected_epoch: input.context.epoch, p_source_id: input.sourceId ?? null,
  });
  if (result.error) throw Object.assign(new Error("Shared award could not be untracked. Refresh and try again."), { code: result.error.code });
  if (!object(result.data) || result.data.ok !== true) conflict();
  return result.data;
}
