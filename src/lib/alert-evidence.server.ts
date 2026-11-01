import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createR2Client, getR2Bucket } from "@/lib/r2";
import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";
import { loadProgramTextCapture } from "../../scripts/lib/program-text-artifacts.mjs";
import { createProgramTextRepository, programTextEqual } from "../../scripts/lib/program-text-repository.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, validateProgramTextReviewResult } from "../../scripts/lib/program-text-review.mjs";
import { programTextReference } from "../../scripts/lib/program-text-storage.mjs";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Loaded only for an explicit review decision; list pages never import R2/PDF work.
export async function verifySavedAlertEvidence(id: string, details: unknown, db: SupabaseClient, status: "pending" | "approved", eventId?: string, localization?: unknown) {
  const candidate = await db.from("shared_award_visual_review_candidates").select("*").eq("id", id).single();
  if (candidate.error || !object(candidate.data) || candidate.data.id !== id || candidate.data.status !== (status === "pending" ? "succeeded" : "published") ||
      (status === "pending" ? Boolean(candidate.data.published_at) : !candidate.data.published_at) || !object(candidate.data.prompt_payload) || !object(candidate.data.ai_result)) throw Error("Alert candidate unavailable.");
  const client = createR2Client(), bucket = getR2Bucket();
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof loadProgramTextCapture>>>>();
  const loadCapture = (ref: Parameters<typeof loadProgramTextCapture>[0]) => {
    const key = JSON.stringify(ref);
    if (!cache.has(key)) cache.set(key, loadProgramTextCapture(ref, { client, bucket }));
    return cache.get(key)!;
  };
  if (status === "pending") {
    await createProgramTextRepository(db, { loadCapture, bucket }).verifyCandidate(candidate.data);
  } else {
    await verifyApprovedGroupEvidence(candidate.data, details, eventId!, db, loadCapture, localization);
  }
  const payload = candidate.data.prompt_payload, aiResult = candidate.data.ai_result;
  const validated = validateProgramTextReviewResult(payload.comparison, payload.packet_plan, aiResult.responses);
  if (validated.status !== "accepted" || !("details" in validated) || !parseProgramTextChangeDetails(details) ||
      !programTextEqual(validated.details, details) || !programTextEqual(validated, aiResult.program_text_validation)) {
    throw Error("The saved alert no longer matches its verified source comparison.");
  }
}

/** Cold-check a historical member without pretending its old pair is today's baseline. */
export async function verifyApprovedGroupEvidence(candidate: Record<string, unknown>, details: unknown, eventId: string, db: SupabaseClient,
  loadCapture: (ref: Parameters<typeof loadProgramTextCapture>[0]) => ReturnType<typeof loadProgramTextCapture>, localization?: unknown) {
  if (candidate.candidate_scope !== "program_text_change" || ["previous_image_hash", "new_image_hash", "previous_file_hash", "new_file_hash"].some(key => candidate[key] != null) || !object(candidate.worker_metadata) || !object(candidate.prompt_payload) || !object(candidate.ai_result) || candidate.worker_metadata.change_event_id !== eventId || candidate.worker_metadata.evidence_signature !== candidate.candidate_signature || candidate.worker_metadata.monitoring_contract !== "program-text-v1") throw Error("Invalid approved source evidence.");
  const [event, evidence] = await Promise.all([
    db.from("shared_award_change_events").select("id,shared_award_id,shared_award_source_id,source_url,visual_review_candidate_id,change_details").eq("id", eventId).single(),
    db.from("shared_award_change_event_visual_evidence").select("change_event_id,visual_review_candidate_id,candidate_signature,bucket,evidence_status,evidence_schema_version,previous_capture,current_capture,localization").eq("change_event_id", eventId).single(),
  ]);
  const e = event.data, proof = evidence.data;
  if (event.error || evidence.error || !object(e) || !object(proof) || e.id !== eventId || e.visual_review_candidate_id !== candidate.id || e.shared_award_id !== candidate.shared_award_id || e.shared_award_source_id !== candidate.shared_award_source_id || e.source_url !== candidate.source_url || !programTextEqual(e.change_details, details) || !object(localization) || !programTextEqual(proof.localization, localization) || proof.change_event_id !== eventId || proof.visual_review_candidate_id !== candidate.id || proof.candidate_signature !== candidate.candidate_signature || proof.bucket !== candidate.worker_metadata.bucket || proof.evidence_status !== "verified_text" || proof.evidence_schema_version !== "program-text-event-evidence-v1" || !programTextEqual(proof.previous_capture, candidate.previous_snapshot_ref) || !programTextEqual(proof.current_capture, candidate.new_snapshot_ref)) throw Error("The approved event does not match its retained evidence.");
  const payload = candidate.prompt_payload;
  if (!object(payload.comparison) || !object(payload.comparison.context) || !object(payload.packet_plan) || !object(payload.packet_plan.limits)) throw Error("Invalid approved comparison.");
  const [previous, current] = await Promise.all([loadCapture(candidate.previous_snapshot_ref as Parameters<typeof loadProgramTextCapture>[0]), loadCapture(candidate.new_snapshot_ref as Parameters<typeof loadProgramTextCapture>[0])]);
  const comparison = buildProgramTextComparison(previous, current, { epoch: candidate.worker_metadata.epoch, cycle_id: payload.comparison.context.cycle_id });
  if (!programTextEqual(comparison, payload.comparison) || comparison.comparison_id !== candidate.candidate_signature || !programTextEqual(programTextReference(previous), candidate.previous_snapshot_ref) || !programTextEqual(programTextReference(current), candidate.new_snapshot_ref) || !programTextEqual(buildProgramTextReviewPackets(comparison, payload.packet_plan.limits), payload.packet_plan)) throw Error("Approved originals no longer match the saved comparison.");
}
