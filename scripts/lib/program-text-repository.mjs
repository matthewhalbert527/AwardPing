import { buildProgramTextComparison, buildProgramTextReviewPackets } from "./program-text-review.mjs";
import { programTextReference } from "./program-text-storage.mjs";
import { programTextDeterministicNoChange, validatedProgramTextDeterministicProvenance, PROGRAM_TEXT_UNPAID_NULL_FIELDS } from "./program-text-deterministic-no-change.mjs";
import { attachProgramTextSourceApprovals, hasProgramTextSourceAccess } from "./program-text-source-access.mjs";
import { validateProgramTextCapture } from "./program-text-capture-contract.mjs";
import { validateProgramTextCollectionFailureRequest } from "./program-text-collection-quality.mjs";
import { reviewedPdfInitialCoverageDocument, REVIEWED_PDF_INITIAL_POLICY, REVIEWED_PDF_INITIAL_REASON } from "./program-text-reviewed-pdf-transition.mjs";
import { BASIC_CONTINUITY_SOURCE_IDS, prepareBasicContinuity } from "./current-basic-reviewed-repeat.mjs";

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
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** Seven approved technical profiles only; never enumerates the paid queue. */
export async function listBasicContinuityWork(supabase, { epoch, source_ids } = {}) {
  if (source_ids && !source_ids.some(id => BASIC_CONTINUITY_SOURCE_IDS.includes(id))) return [];
  const data = await result(supabase.rpc("list_program_basic_continuity_sources"), "list basic continuity");
  if (!data || data.schema !== "awardping.program-basic-continuity-work.v1" || !Array.isArray(data.sources) || data.sources.length > 7 ||
      new Set(data.sources.map(row => row.source_id)).size !== data.sources.length || data.sources.some(row =>
        !BASIC_CONTINUITY_SOURCE_IDS.includes(row.source_id) || !uuid(row.epoch))) throw Error("Invalid bounded basic continuity work");
  return data.sources.filter(row => (!epoch || row.epoch === epoch) && (!source_ids || source_ids.includes(row.source_id)));
}
// Same RFC3339 calendar/offset rules as the existing promotion verifier, kept
// local so text-only review does not import the legacy visual dependency tree.
function candidateMicros(value) {
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) throw new Error("Invalid candidate creation timestamp");
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number), offsetHour = Number(m[10] || 0), offsetMinute = Number(m[11] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw new Error("Invalid candidate creation timestamp");
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new Error("Invalid candidate creation timestamp");
  return BigInt(date.getTime() - (m[9] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60000) * 1000n + BigInt((m[7] || "").padEnd(6, "0"));
}
function compareCandidates(a, b) {
  const left = candidateMicros(a.created_at), right = candidateMicros(b.created_at);
  return left === right ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : left < right ? -1 : 1;
}

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
    async reconcileBasicContinuity(sourceId) {
      if (!BASIC_CONTINUITY_SOURCE_IDS.includes(sourceId)) return { source_id: sourceId, status: "skipped" };
      try {
        const inspection = await result(supabase.rpc("inspect_program_basic_continuity", { p_source_id: sourceId }), "inspect basic continuity");
        if (inspection?.schema !== "awardping.program-basic-continuity-inspection.v1" || inspection.source_id !== sourceId) throw Error("Continuity scope changed");
        if (inspection.status !== "ready") {
          if (!["skipped", "held"].includes(inspection.status)) throw Error("Invalid continuity inspection status");
          return { source_id: sourceId, status: inspection.status, reason: inspection.reason || null };
        }
        const request = await prepareBasicContinuity(inspection, { loadCapture });
        // One mutation only. An uncertain response is resolved by readback;
        // never repeat a paid request, attestation or publication blindly.
        let response;
        try { response = await result(supabase.rpc("attest_program_basic_continuity", request), "attest basic continuity"); }
        catch {
          const after = await result(supabase.rpc("inspect_program_basic_continuity", { p_source_id: sourceId }), "read back basic continuity");
          if (after?.schema === inspection.schema && after.source_id === sourceId && after.status === "skipped" && after.reason === "already_current" &&
              after.expected_head === inspection.expected_head && programTextEqual(after.current_ref, inspection.current_ref)) {
            return { source_id: sourceId, status: "current", already_applied: true };
          }
          throw Error("Continuity attestation unconfirmed");
        }
        if (!response || response.ok !== true || !uuid(response.id) || typeof response.already_applied !== "boolean") throw Error("Continuity response unconfirmed");
        return { source_id: sourceId, status: "current", already_applied: response.already_applied };
      } catch { return { source_id: sourceId, status: "held", reason: "basic_continuity_not_confirmed" }; }
    },
    async readState(sourceId) {
      const row = await result(supabase.from("shared_award_sources").select("text_monitoring_state").eq("id", sourceId).single(), "read state");
      return row.text_monitoring_state;
    },
    async recordCollectionFailure(request) {
      validateProgramTextCollectionFailureRequest(request);
      return result(supabase.rpc("record_program_text_collection_failure", { p_request: request }), "collection failure journal");
    },
    async compareAndSetState({ source_id, expected_state, next_state }) {
      return result(supabase.rpc("set_program_text_source_state", { p_source_id: source_id,
        p_expected_state: expected_state, p_next_state: next_state }), "source state CAS");
    },
    async transitionKnownHtmlShell({ source_id, expected_state, next_state, current_ref }) {
      // Cold replay the full original and transport/projection bindings again
      // before the finite server transaction. Old references go into its journal.
      const capture = await loadCapture(current_ref);
      validateProgramTextCapture(capture);
      if (capture.acquisition !== "publisher_json" || capture.source.id !== source_id ||
          !programTextEqual(programTextReference(capture), current_ref)) throw new Error("Publisher first coverage original changed");
      const document = { reference: current_ref, text: capture.text, blocks: capture.blocks, blocks_json: JSON.stringify(canonical(capture.blocks)) };
      return result(supabase.rpc("transition_known_smart_html_shell", { p_source_id: source_id, p_expected_state: expected_state,
        p_next_state: next_state, p_document: document, p_policy: "awardping.smart-publisher-initial-coverage.v1",
        p_reason: "First meaningful programme coverage replaces only this verified historical loading shell. Preserve the original state and require an independent repeat; no update or fact approval." }), "meaningful first coverage");
    },
    async transitionReviewedPdfFirstCoverage(request) {
      const capture = await loadCapture(request.current_ref);
      const document = reviewedPdfInitialCoverageDocument(capture, request);
      return result(supabase.rpc("transition_reviewed_pdf_first_coverage", { p_source_id: request.source_id,
        p_expected_state: request.expected_state, p_next_state: request.next_state, p_document: document,
        p_policy: REVIEWED_PDF_INITIAL_POLICY, p_reason: REVIEWED_PDF_INITIAL_REASON }), "reviewed PDF first coverage");
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
      const currentSource = await result(supabase.from("shared_award_sources").select("id,shared_award_id,url,title,admin_review_status,text_monitoring_state").eq("id", row.shared_award_source_id).single(), "verify source");
      const [source] = await attachProgramTextSourceApprovals(supabase, [currentSource], { epoch: row.worker_metadata.epoch });
      const state = source.text_monitoring_state;
      if (!hasProgramTextSourceAccess(source, { epoch: row.worker_metadata.epoch }) || source.shared_award_id !== row.shared_award_id || source.url !== row.source_url ||
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
    async recordReviewResult({ candidate, validation, responses, deterministicCandidate, deterministicProvenance }) {
      const local = deterministicCandidate ? programTextDeterministicNoChange(deterministicCandidate) : null;
      if (deterministicCandidate && (!local || !programTextEqual(programTextCandidateWork(deterministicCandidate), candidate) ||
          !programTextEqual(local.validation, validation) || !programTextEqual(local.responses, responses))) throw new Error("Invalid deterministic no-change proof");
      const provenance = local?.provenance || (deterministicProvenance && validatedProgramTextDeterministicProvenance(candidate, validation, responses, deterministicProvenance));
      if (deterministicProvenance && !provenance) throw new Error("Invalid stored deterministic provenance");
      let query = supabase.from(table).update({ status: validation.status === "held" ? "failed" : "succeeded",
        ai_result: { responses: responses || [], program_text_validation: validation,
          ...(provenance ? { program_text_review_provenance: provenance } : {}) }, completed_at: iso(), updated_at: iso(),
        rejection_reason: validation.status === "held" ? `manual_review_required:${validation.reasons?.[0] || "text_review"}` : null })
        .eq("id", candidate.id).eq("candidate_scope", "program_text_change")
        .eq("candidate_signature", candidate.comparison.comparison_id).eq("shared_award_source_id", candidate.source.id)
        .eq("shared_award_id", candidate.source.shared_award_id).eq("worker_metadata->>epoch", candidate.epoch);
      if (local) {
        // Full metadata/time CAS prevents overwriting a concurrent paid claim,
        // reservation or deferral between cold verification and persistence.
        query = query.eq("status", "pending").eq("updated_at", deterministicCandidate.updated_at)
          .eq("worker_metadata", JSON.stringify(deterministicCandidate.worker_metadata)).eq("actual_usage", "{}");
        for (const field of PROGRAM_TEXT_UNPAID_NULL_FIELDS) query = query.is(field, null);
      } else query = query.in("status", ["pending", "submitted", "succeeded"]);
      const rows = await result(query.select("id"), "persist validation");
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
      if (source_ids.length <= 100) {
        const found = await result(supabase.from(table).select("*").eq("candidate_scope", "program_text_change")
        .in("shared_award_source_id", source_ids).eq("worker_metadata->>epoch", epoch)
        .is("worker_metadata->>admin_alert_review_id", null)
        .in("status", statuses).order("created_at").limit(limit), "list text reviews");
        if (!Array.isArray(found) || found.some(row => row.worker_metadata?.admin_alert_review_id != null)) throw new Error("Invalid selected text reviews");
        return found;
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !uuid(epoch) || !source_ids.every(uuid) ||
          new Set(source_ids).size !== source_ids.length) throw new Error("Invalid bounded text review scope");
      const metadata = new Map();
      for (let start = 0; start < source_ids.length; start += 100) {
        const ids = source_ids.slice(start, start + 100);
        const { data: page, count, error } = await supabase.from(table).select("id,created_at,shared_award_source_id", { count: "exact" }).eq("candidate_scope", "program_text_change")
          .in("shared_award_source_id", ids).eq("worker_metadata->>epoch", epoch)
          .is("worker_metadata->>admin_alert_review_id", null)
          .in("status", statuses).order("created_at").order("id").limit(limit);
        if (error) throw new Error(`Program text repository: list bounded text review metadata failed (${error.code || "database"})`);
        if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(page) || page.length !== Math.min(limit, count)) throw new Error("Incomplete bounded text review metadata");
        let previous;
        for (const row of page) {
          if (!uuid(row?.id) || !ids.includes(row.shared_award_source_id) || metadata.has(row.id) ||
              previous && compareCandidates(previous, row) >= 0) throw new Error("Invalid bounded text review identity");
          candidateMicros(row.created_at); metadata.set(row.id, row); previous = row;
        }
      }
      const chosen = [...metadata.values()].sort(compareCandidates).slice(0, limit);
      if (!chosen.length) return [];
      const found = await result(supabase.from(table).select("*").eq("candidate_scope", "program_text_change")
        .in("id", chosen.map(row => row.id)).eq("worker_metadata->>epoch", epoch)
        .is("worker_metadata->>admin_alert_review_id", null)
        .in("status", statuses).order("created_at").order("id").limit(limit), "read selected text reviews");
      const seen = new Set();
      if (!Array.isArray(found) || found.length > chosen.length) throw new Error("Invalid selected text reviews");
      for (const row of found) {
        const original = metadata.get(row?.id);
        if (!original || !chosen.some(chosenRow => chosenRow.id === row.id) || seen.has(row.id) || row.candidate_scope !== "program_text_change" ||
            row.worker_metadata?.epoch !== epoch || row.worker_metadata?.admin_alert_review_id != null || !statuses.includes(row.status) || row.shared_award_source_id !== original.shared_award_source_id ||
            candidateMicros(row.created_at) !== candidateMicros(original.created_at)) throw new Error("Selected text review identity changed");
        seen.add(row.id);
      }
      // A concurrently claimed row may disappear; never expand/retry the paid
      // work set to fill that vacancy. Each returned row still gets cold CAS verification.
      return found.sort(compareCandidates);
    },
  };
  return repository;
}
