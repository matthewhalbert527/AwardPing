import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";
import { isStage1SourceIdentityExcluded } from "@/lib/stage1-publication";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";

type Source = Database["public"]["Tables"]["shared_award_sources"]["Row"];
export type ProgramVariationTrackingContext = {
  schema: "awardping.program-variation-tracking.v1";
  cohort_key: string; release_revision: string; inventory_id: string; inventory_revision: string;
  approval_id: string; approval_hash: string; epoch: string; shared_review_id: string; source_id: string | null;
  source_ids: string[]; source_bindings: Record<string, { url: string; shared_award_id: string; title: string | null; page_type: string | null }>;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function conflict(): never { throw Object.assign(new Error("Approved award tracking details changed. Refresh and try again."), { code: "40001" }); }

/** Explicit immutable publication proof; neither legacy OPEN nor an arbitrary
 * caller boolean grants variation authority. The authenticated RPC rechecks it. */
export async function loadProgramVariationTrackingSources(admin: SupabaseClient<Database>, publication: Stage1PublicationEntry, sourceId?: string) {
  const review = publication.textFactReview;
  if (!publication.effectivelyVerified || !review?.variationInventoryId || !review.current || sourceId !== undefined && !uuid(sourceId)) conflict();
  const result = await (admin as SupabaseClient).rpc("get_program_variation_tracking_context", { p_cohort: publication.registry.cohort_key, p_source: sourceId ?? null });
  const value: unknown = result.data;
  if (result.error || !object(value) || value.schema !== "awardping.program-variation-tracking.v1" || value.cohort_key !== publication.registry.cohort_key ||
      value.inventory_id !== review.variationInventoryId || value.inventory_revision !== review.variationInventoryRevision || value.release_revision !== review.releaseRevision ||
      value.approval_id !== review.id || typeof value.approval_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.approval_hash) ||
      !uuid(value.epoch) || !uuid(value.shared_review_id) || value.source_id !== (sourceId ?? null) || !Array.isArray(value.source_ids) ||
      !value.source_ids.length || value.source_ids.length > 500 || value.source_ids.some(id => !uuid(id)) || new Set(value.source_ids).size !== value.source_ids.length ||
      sourceId && (value.source_ids.length !== 1 || value.source_ids[0] !== sourceId) || !object(value.source_bindings) || Object.keys(value.source_bindings).length !== value.source_ids.length) conflict();
  const context = value as unknown as ProgramVariationTrackingContext;
  for (const id of context.source_ids) {
    const binding = context.source_bindings[id], approved = publication.approvedTextSourceBindings?.[id];
    if (!object(binding) || Object.keys(binding).length !== 4 || !approved || !publication.allowedSourceIdSet.has(id) ||
        binding.url !== approved.url || binding.shared_award_id !== approved.shared_award_id || !publication.memberAwardIds.includes(binding.shared_award_id) ||
        binding.title !== null && typeof binding.title !== "string" || binding.page_type !== null && typeof binding.page_type !== "string") conflict();
  }
  const sources: Source[] = [];
  for (let offset = 0; offset < context.source_ids.length; offset += 100) {
    const ids = context.source_ids.slice(offset, offset + 100);
    const query = await admin.from("shared_award_sources").select("*").in("id", ids).order("id").limit(101);
    if (query.error || query.data?.length !== ids.length || new Set(query.data.map(source => source.id)).size !== ids.length) conflict();
    for (const source of query.data) {
      const binding = context.source_bindings[source.id];
      if (!ids.includes(source.id) || !binding || !publication.memberAwardIds.includes(source.shared_award_id) || source.url !== binding.url || source.shared_award_id !== binding.shared_award_id ||
          !["open", "review_later"].includes(source.admin_review_status) || isStage1SourceIdentityExcluded(publication, source) ||
          !isMonitorableOfficialSource({ url: binding.url, page_type: binding.page_type })) conflict();
      sources.push(source);
    }
  }
  return { context, sources };
}

export async function trackProgramVariationForOffice(input: {
  supabase: SupabaseClient<Database>; publication: Stage1PublicationEntry; context: ProgramVariationTrackingContext;
  sources: Source[]; officeId: string; cadence: "daily";
}) {
  const ids = input.context.source_ids;
  if (!ids.length || ids.length > 500 || input.sources.length !== ids.length || new Set(input.sources.map(source => source.id)).size !== ids.length) conflict();
  for (const source of input.sources) {
    const binding = input.context.source_bindings[source.id];
    if (!ids.includes(source.id) || !binding || source.url !== binding.url || source.shared_award_id !== binding.shared_award_id ||
        !["open", "review_later"].includes(source.admin_review_status)) conflict();
  }
  // Keep distinct source IDs and exact URLs. A legacy URL-key collision is
  // rejected atomically by SQL instead of silently choosing another document.
  const bindings = [...input.sources].sort((a,b) => a.id.localeCompare(b.id)).map(source => ({ id: source.id, shared_award_id: source.shared_award_id,
    url: source.url, title: source.title, page_type: source.page_type, confidence: source.confidence, reason: source.reason,
    admin_review_status: source.admin_review_status, updated_at: source.updated_at }));
  const result = await (input.supabase as SupabaseClient).rpc("track_office_program_variation_atomic", {
    p_office_id: input.officeId, p_canonical_shared_award_id: input.publication.canonicalAwardId,
    p_expected_member_shared_award_ids: input.publication.memberAwardIds, p_expected_release_epoch: input.publication.registry.release_epoch,
    p_expected_source_bindings: bindings, p_expected_variation_context: input.context as unknown as Json, p_cadence: input.cadence,
  });
  if (result.error) throw Object.assign(new Error("Shared award could not be tracked. Refresh and try again."), { code: result.error.code });
  if (!object(result.data) || !object(result.data.award)) conflict();
  return result.data;
}
