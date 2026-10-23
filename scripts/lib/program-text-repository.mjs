import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./program-text-review.mjs";
import { programTextReference } from "./program-text-storage.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const programTextEqual = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const table = "shared_award_visual_review_candidates"; // Private legacy table name; no visual inputs.
async function result(query, context) {
  const { data, error } = await query;
  if (error) throw new Error(`Program text repository: ${context} failed (${error.code || "database"})`);
  return data;
}
const iso = () => new Date().toISOString();

export function programTextCandidateWork(row) {
  return { schema: "awardping.program-text-review-work.v1", id: row.id,
    source: row.new_snapshot_ref?.source, epoch: row.worker_metadata?.epoch,
    cycle_id: row.prompt_payload?.comparison?.context?.cycle_id,
    previous_ref: row.previous_snapshot_ref, current_ref: row.new_snapshot_ref,
    comparison: row.prompt_payload?.comparison, packet_plan: row.prompt_payload?.packet_plan };
}

/** One small adapter around the existing private queue and source state. */
export function createProgramTextRepository(supabase, { loadCapture, bucket, sourceIsApproved = id => result(
  supabase.rpc("program_text_source_is_approved", { p_source_id: id }), "verify source approval"), loadAward = id => result(
  supabase.from("shared_awards").select("id,name,status").eq("id", id).single(), "read award identity") }) {
  async function programIdentity(source) {
    const award = await loadAward(source.shared_award_id);
    if (!award || award.id !== source.shared_award_id || award.status !== "active" || typeof award.name !== "string" || !award.name.trim()) {
      throw new Error("Authoritative award identity is unavailable");
    }
    return { award_id: award.id, award_name: award.name, source_url: source.url, source_title: source.title || null };
  }
  const repository = {
    async readState(sourceId) {
      const row = await result(supabase.from("shared_award_sources").select("text_monitoring_state").eq("id", sourceId).single(), "read state");
      return row.text_monitoring_state;
    },
    async compareAndSetState({ source_id, expected_state, next_state }) {
      return result(supabase.rpc("set_program_text_source_state", { p_source_id: source_id,
        p_expected_state: expected_state, p_next_state: next_state }), "source state CAS");
    },
    async enqueueReview(work) {
      const signature = work.comparison.comparison_id;
      if (!/^[a-f0-9]{64}$/.test(signature || "")) throw new Error("Invalid program comparison");
      const program = await programIdentity(work.source);
      const row = { shared_award_id: work.source.shared_award_id, shared_award_source_id: work.source.id,
        candidate_scope: "program_text_change", candidate_signature: signature,
        source_url: work.source.url, source_title: work.source.title || null, source_page_type: work.source.page_type || null,
        previous_snapshot_ref: work.previous_ref, new_snapshot_ref: work.current_ref,
        previous_text_hash: work.previous_ref.text_sha256, new_text_hash: work.current_ref.text_sha256,
        previous_image_hash: null, new_image_hash: null, previous_file_hash: null, new_file_hash: null,
        deterministic_diff: { comparison_id: signature, changed_blocks: work.comparison.changed_blocks.length },
        deterministic_classification: "program_text_review", prompt_payload: { program_identity: program, comparison: work.comparison, packet_plan: work.packet_plan },
        status: "pending", worker_metadata: { monitoring_contract: "program-text-v1", epoch: work.epoch,
          evidence_signature: signature, bucket } };
      const { data, error } = await supabase.from(table).insert(row).select("id").single();
      if (!error) return data;
      if (error.code !== "23505") throw new Error(`Program text enqueue failed (${error.code || "database"})`);
      const existing = await result(supabase.from(table).select("*").eq("candidate_signature", signature).single(), "read duplicate");
      if (existing.candidate_scope !== row.candidate_scope || existing.shared_award_source_id !== row.shared_award_source_id ||
          existing.shared_award_id !== row.shared_award_id || existing.source_url !== row.source_url ||
          existing.worker_metadata?.epoch !== work.epoch || existing.worker_metadata?.monitoring_contract !== "program-text-v1" ||
          existing.worker_metadata?.bucket !== bucket || existing.worker_metadata?.evidence_signature !== signature ||
          !programTextEqual(existing.prompt_payload, row.prompt_payload) ||
          !programTextEqual(existing.previous_snapshot_ref, row.previous_snapshot_ref) || !programTextEqual(existing.new_snapshot_ref, row.new_snapshot_ref)) {
        throw new Error("Program text candidate identity conflict");
      }
      return { id: existing.id };
    },
    async verifyCandidate(row) {
      if (row.candidate_scope !== "program_text_change" || row.worker_metadata?.monitoring_contract !== "program-text-v1" ||
          row.worker_metadata?.evidence_signature !== row.candidate_signature || row.worker_metadata?.bucket !== bucket ||
          ["previous_image_hash", "new_image_hash", "previous_file_hash", "new_file_hash"].some(key => row[key] != null)) throw new Error("Not text-only work");
      if (await sourceIsApproved(row.shared_award_source_id) !== true) throw new Error("Text review source is no longer approved");
      const source = await result(supabase.from("shared_award_sources").select("id,shared_award_id,url,title,admin_review_status,text_monitoring_state").eq("id", row.shared_award_source_id).single(), "verify source");
      const state = source.text_monitoring_state;
      if (source.admin_review_status !== "open" || source.shared_award_id !== row.shared_award_id || source.url !== row.source_url ||
          state?.epoch !== row.worker_metadata.epoch || !programTextEqual(state.baseline_ref, row.previous_snapshot_ref) ||
          !programTextEqual(state.latest_ref, row.new_snapshot_ref)) throw new Error("Text review pair is not current");
      if (!programTextEqual(await programIdentity(source), row.prompt_payload.program_identity)) throw new Error("Text review program identity changed");
      const [previous, current] = await Promise.all([loadCapture(row.previous_snapshot_ref), loadCapture(row.new_snapshot_ref)]);
      const comparison = buildProgramTextComparison(previous, current, { epoch: state.epoch, cycle_id: row.prompt_payload.comparison.context.cycle_id });
      if (!programTextEqual(comparison, row.prompt_payload.comparison) || comparison.comparison_id !== row.candidate_signature ||
          !programTextEqual(buildProgramTextReviewPackets(comparison, row.prompt_payload.packet_plan.limits), row.prompt_payload.packet_plan) ||
          !programTextEqual(programTextReference(previous), row.previous_snapshot_ref) || !programTextEqual(programTextReference(current), row.new_snapshot_ref)) {
        throw new Error("Text review originals do not match saved work");
      }
      return true;
    },
    async claim(row, token, model) {
      const metadata = { ...row.worker_metadata, program_text_claim_token: token, claim_started_at: iso() };
      const rows = await result(supabase.from(table).update({ status: "processing", model, worker_metadata: metadata, updated_at: iso() })
        .eq("id", row.id).eq("status", "pending").eq("candidate_scope", "program_text_change").select("*"), "claim review");
      return rows?.[0] || null;
    },
    async save(row, token, patch) {
      const rows = await result(supabase.from(table).update({ ...patch, updated_at: iso() }).eq("id", row.id)
        .eq("candidate_scope", "program_text_change").in("status", ["processing", "submitted"])
        .eq("worker_metadata->>program_text_claim_token", token).select("id"), "save review");
      if (rows?.length !== 1) throw new Error("Text review claim lost");
      return true;
    },
    async recordReviewResult({ candidate, validation, responses }) {
      const rows = await result(supabase.from(table).update({ status: validation.status === "held" ? "failed" : "succeeded",
        ai_result: { responses: responses || [], program_text_validation: validation }, completed_at: iso(), updated_at: iso(),
        rejection_reason: validation.status === "held" ? `manual_review_required:${validation.reasons?.[0] || "text_review"}` : null })
        .eq("id", candidate.id).eq("candidate_scope", "program_text_change")
        .eq("candidate_signature", candidate.comparison.comparison_id).eq("shared_award_source_id", candidate.source.id)
        .eq("shared_award_id", candidate.source.shared_award_id).eq("worker_metadata->>epoch", candidate.epoch)
        .in("status", ["pending", "submitted", "succeeded"]).select("id"), "persist validation");
      return { persisted: rows?.length === 1 };
    },
    async finishNoChange(candidateId) {
      const records = await result(supabase.from(table).update({ status: "rejected", rejection_reason: "no_program_change", updated_at: iso() })
        .eq("id", candidateId).eq("candidate_scope", "program_text_change").eq("status", "succeeded")
        .eq("ai_result->program_text_validation->>status", "no_program_change").select("id"), "finish no-change review");
      return records?.length === 1;
    },
    async publishProgramChange({ candidate, validation }) {
      const blocks = { previous: [], current: [] };
      for (const side of ["previous", "current"]) {
        const seen = new Set();
        for (const row of candidate.comparison.changed_blocks) if (row[side] && !seen.has(row[side].id)) {
          seen.add(row[side].id); blocks[side].push(row[side]);
        }
      }
      return result(supabase.rpc("publish_program_text_event", { p_candidate_id: candidate.id, p_details: validation.details,
        p_localization: { schema: "awardping.program-text-publication.v1", epoch: candidate.epoch,
          comparison_id: candidate.comparison.comparison_id, program_changes: validation.details.program_changes, supporting_blocks: blocks } }), "publish text event");
    },
    async listCandidates(statuses, limit = 20, { source_ids, epoch } = {}) {
      if (!Array.isArray(source_ids) || !source_ids.length || !epoch) return [];
      return result(supabase.from(table).select("*").eq("candidate_scope", "program_text_change")
        .in("shared_award_source_id", source_ids).eq("worker_metadata->>epoch", epoch)
        .in("status", statuses).order("created_at").limit(limit), "list text reviews");
    },
  };
  return repository;
}
