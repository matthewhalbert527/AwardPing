const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
import { hasProgramTextCanonicalUrlAdmission, attachProgramTextCanonicalUrlAdmissions } from "./program-text-canonical-url-admission.mjs";
const schema = "awardping.program-text-source-approval.v1";
const keys = ["schema", "id", "source_id", "shared_award_id", "source_url", "cohort_key", "epoch", "content_hash", "current"];
const valid = proof => proof && typeof proof === "object" && !Array.isArray(proof) && Object.keys(proof).length === keys.length &&
  keys.every(key => Object.hasOwn(proof, key)) && proof.schema === schema && uuid(proof.id) && uuid(proof.source_id) &&
  uuid(proof.shared_award_id) && uuid(proof.epoch) && typeof proof.source_url === "string" &&
  /^[a-z0-9_-]{1,80}$/.test(proof.cohort_key || "") && /^[a-f0-9]{64}$/.test(proof.content_hash || "") && proof.current === true;

/** Text-only DTO admission. Every mutation still rechecks database authority. */
export function hasProgramTextSourceAccess(source, { cohort, epoch } = {}) {
  if (!source) return false;
  if (!hasProgramTextCanonicalUrlAdmission(source, { cohort, epoch })) return false;
  if (source.admin_review_status === "open") return true;
  if (source.admin_review_status !== "review_later" || !uuid(epoch) || !Array.isArray(source.text_source_approvals)) return false;
  return source.text_source_approvals.some(proof => valid(proof) && proof.source_id === source.id &&
    proof.shared_award_id === source.shared_award_id && proof.source_url === source.url && proof.epoch === epoch &&
    (cohort === undefined || proof.cohort_key === cohort));
}

/** Fetch current proofs; never treat a client-supplied permission flag as authority. */
export async function attachProgramTextSourceApprovals(supabase, sources, { epoch } = {}) {
  if (!uuid(epoch) || !Array.isArray(sources) || sources.some(source => !uuid(source?.id)) ||
      new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Invalid text source authorization scope");
  const needed = sources.filter(source => source.admin_review_status !== "open"), proofs = new Map();
  for (let start = 0; start < needed.length; start += 100) {
    const ids = needed.slice(start, start + 100).map(source => source.id);
    const { data, error } = await supabase.rpc("get_program_text_source_approvals", { p_source_ids: ids, p_epoch: epoch });
    if (error || !data || data.schema !== "awardping.program-text-source-approval-page.v1" || data.epoch !== epoch ||
        !Array.isArray(data.source_ids) || data.source_ids.length !== ids.length || new Set(data.source_ids).size !== ids.length ||
        data.source_ids.some(id => !ids.includes(id)) || !Array.isArray(data.approvals)) throw new Error("Current text source approvals are unavailable");
    const seen = new Set();
    for (const proof of data.approvals) {
      const key = `${proof?.source_id}:${proof?.cohort_key}`;
      const source = needed.find(row => row.id === proof?.source_id);
      if (!valid(proof) || proof.epoch !== epoch || !ids.includes(proof.source_id) || seen.has(key) ||
          source.shared_award_id !== proof.shared_award_id || source.url !== proof.source_url) throw new Error("Text source approval identity changed");
      seen.add(key);
      if (!proofs.has(proof.source_id)) proofs.set(proof.source_id, []);
      proofs.get(proof.source_id).push(proof);
    }
  }
  return attachProgramTextCanonicalUrlAdmissions(supabase,
    sources.map(source => ({ ...source, text_source_approvals: proofs.get(source.id) || [] })), { epoch });
}
