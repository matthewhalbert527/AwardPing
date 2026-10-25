import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createR2Client, getR2Bucket } from "@/lib/r2";
import type { Json } from "@/lib/database.types";
import type { ProgramFactBatchItem, ProgramFactPublication } from "@/lib/program-fact-review-types";
import { emptyProgramFactReview, validateProgramFactReview } from "../../scripts/lib/program-text-facts.mjs";
import { loadProgramTextCapture } from "../../scripts/lib/program-text-artifacts.mjs";
import monitoring from "../../config/program-text-monitoring.json";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }

export async function loadProgramFactBatch() {
  const db = createSupabaseAdminClient();
  const [batch, publication] = await Promise.all([db.rpc("get_program_text_fact_review_batch"), db.rpc("get_program_text_fact_publication")]);
  if (batch.error || publication.error || !Array.isArray(batch.data) || batch.data.length !== 25 || !object(publication.data) ||
      publication.data.schema !== "awardping.program-fact-publication.v1" || !uuid(publication.data.revision)) throw new Error("The current 25-award review batch is unavailable.");
  if (batch.data.some(item => !object(item) || !uuid(item.award_id) || typeof item.cohort_key !== "string" ||
      !Array.isArray(item.sources)) || new Set(batch.data.map(item => (item as Record<string, Json>).cohort_key)).size !== 25) throw new Error("Incomplete award identities in review batch.");
  return { awards: batch.data as unknown as ProgramFactBatchItem[], publication: publication.data as unknown as ProgramFactPublication };
}

async function contextFor(cohort: string) {
  const db = createSupabaseAdminClient();
  const [registry, roles, members] = await Promise.all([
    db.from("stage1_award_registry").select("cohort_key,canonical_shared_award_id").eq("cohort_key", cohort).single(),
    db.from("program_text_source_roster").select("*").eq("cohort_key", cohort).order("source_role").limit(100),
    db.from("stage1_award_members").select("shared_award_id").eq("cohort_key", cohort).limit(100),
  ]);
  if (registry.error || roles.error || members.error || !registry.data || !roles.data?.length || roles.data.length === 100 || !members.data?.length || members.data.length === 100) throw new Error("Current source roles are unavailable.");
  const ids = [...new Set(roles.data.flatMap(role => role.source_ids))];
  if (!ids.length || ids.length > 500) throw new Error("Source set is incomplete.");
  const sources = await db.from("shared_award_sources").select("id,shared_award_id,url,title,page_type,admin_review_status,text_monitoring_state").in("id", ids).limit(501);
  if (sources.error || sources.data?.length !== ids.length) throw new Error("Required source identities are unavailable.");
  const client = createR2Client(), bucket = getR2Bucket();
  return { registry: registry.data, roles: roles.data, sources: sources.data, memberIds: members.data.map(row => row.shared_award_id), epoch: monitoring.epoch,
    loadCapture: (ref: Parameters<typeof loadProgramTextCapture>[0]) => loadProgramTextCapture(ref, { client, bucket }) };
}

/** Full saved originals are restored again immediately before each approval. */
export async function saveProgramFactProposal(review: unknown, actor: string) {
  if (!object(review) || typeof review.cohort_key !== "string" || !/^[a-z0-9_-]{1,80}$/.test(review.cohort_key)) throw new Error("Choose one reviewed award.");
  const context = await contextFor(review.cohort_key);
  const validation = await validateProgramFactReview(review, context);
  const saved = await createSupabaseAdminClient().rpc("save_program_text_fact_review", { p_validation: json(validation), p_actor: actor });
  if (saved.error) throw new Error("The proposal is stale or unsupported; nothing was approved.");
  return saved.data;
}

/** Preparing an empty proposal cannot verify a field, approve it, or publish it. */
export async function prepareProgramFactProposal(cohort: string, cycle: string, actor: string) {
  const context = await contextFor(cohort);
  const review = emptyProgramFactReview({ ...context, cycle });
  return saveProgramFactProposal(review, actor);
}

/** Admin-only caller: restore one proposal's originals, never sign a public asset URL. */
export async function loadProgramFactProposal(id: string) {
  const row = await createSupabaseAdminClient().from("program_text_fact_reviews")
    .select("id,cohort_key,validation,content_hash,status").eq("id", id).single();
  if (row.error || !row.data || !object(row.data.validation)) throw new Error("The saved proposal is unavailable.");
  const context = await contextFor(row.data.cohort_key);
  const validation = await validateProgramFactReview(row.data.validation.review, context);
  return { id: row.data.id, content_hash: row.data.content_hash, status: row.data.status, review: validation.review,
    sources: validation.source_text.map((doc: { reference: { source: { id: string; url: string }; capture_id: string }; text: string; blocks: unknown[] }) => ({ id: doc.reference.source.id, url: doc.reference.source.url,
      title: context.sources.find(source => source.id === doc.reference.source.id)?.title || null,
      text: doc.text, blocks: doc.blocks, capture_id: doc.reference.capture_id })) };
}

export async function approveProgramFactProposal(id: string, expectedHash: string, actor: string) {
  const db = createSupabaseAdminClient();
  const row = await db.from("program_text_fact_reviews").select("id,cohort_key,validation,content_hash").eq("id", id).single();
  if (row.error || !row.data || row.data.content_hash !== expectedHash || !object(row.data.validation)) throw new Error("The proposal changed; reload it before approval.");
  const context = await contextFor(row.data.cohort_key);
  await validateProgramFactReview(row.data.validation.review, { ...context, forApproval: true });
  const approved = await db.rpc("approve_program_text_fact_review", { p_id: id, p_expected_hash: expectedHash, p_actor: actor });
  if (approved.error) throw new Error("Current source or approval checks failed; nothing was published.");
  return approved.data;
}

export async function publishProgramFactBatch(revision: string, ids: Record<string, string>, actor: string) {
  const published = await createSupabaseAdminClient().rpc("publish_program_text_fact_batch", {
    p_expected_revision: revision, p_review_ids: ids, p_actor: actor,
  });
  if (published.error) throw new Error("The exact 25-award batch is not ready, or its version changed. Nothing was published.");
  return published.data;
}
