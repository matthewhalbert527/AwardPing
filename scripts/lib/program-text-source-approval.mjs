import { validateProgramTextCapture, programTextCaptureInternals } from "./program-text-capture-contract.mjs";
import { programTextReference, validateProgramTextReference } from "./program-text-artifacts.mjs";
import { programTextPublicDrivePdfIdentity, isProgramTextPublicDrivePdfMetadata } from "./program-text-public-drive-pdf.mjs";
import { hasProgramTextSourceAccess } from "./program-text-source-access.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = reason => { throw new Error(`Text source approval: ${reason}`); };
export const PROGRAM_TEXT_SOURCE_APPROVAL_REQUEST = "awardping.program-text-source-approval-request.v1";
export const PROGRAM_TEXT_SOURCE_PENDING_REQUEST = "awardping.program-text-source-pending-request.v1";

/** Database-recorded collision identities are audit data, never alias permission. */
export function validateProgramTextURLAliasBoundary(value, proposal) {
  const boundary = value ?? [];
  if (!Array.isArray(boundary) || !object(proposal?.source)) fail("invalid_url_alias_boundary");
  if (boundary.length && (proposal.source.create || proposal.source.expected_member_kind !== "canonical" ||
      proposal.source.shared_award_id !== proposal.expected_canonical_shared_award_id)) fail("canonical_url_alias_reuse_required");
  let previous = "";
  for (const row of boundary) {
    if (!exact(row, ["source_id", "shared_award_id", "source_url", "memberships"]) ||
        !uuid(row.source_id) || !uuid(row.shared_award_id) || row.source_id === proposal.source.id || row.source_id <= previous ||
        typeof row.source_url !== "string" || !row.source_url || !Array.isArray(row.memberships) || row.memberships.length !== 1 ||
        !exact(row.memberships[0], ["cohort_key", "member_kind"]) || row.memberships[0].cohort_key !== proposal.cohort_key ||
        !["canonical", "alias"].includes(row.memberships[0].member_kind)) fail("invalid_url_alias_boundary");
    const normalized = value => value.split("#")[0].replace(/\/+$/, "").toLowerCase();
    if (typeof proposal.source.url !== "string" || normalized(row.source_url) !== normalized(proposal.source.url)) fail("invalid_url_alias_boundary");
    previous = row.source_id;
  }
  return boundary;
}

/** Only retained originals are read here; no network acquisition or approval occurs. */
async function validate(proposal, { epoch, loadCapture }, pending) {
  const names = ["schema", "id", "cohort_key", "epoch", "expected_canonical_shared_award_id", "source", "authority_ref", "link_block_id", "roles", "registration_scope"];
  if (!pending) names.push("target_ref");
  if (!exact(proposal, names) ||
      proposal.schema !== (pending ? PROGRAM_TEXT_SOURCE_PENDING_REQUEST : PROGRAM_TEXT_SOURCE_APPROVAL_REQUEST) || !uuid(proposal.id) || !uuid(epoch) || proposal.epoch !== epoch ||
      !uuid(proposal.expected_canonical_shared_award_id) || !/^[a-z0-9_-]{1,80}$/.test(proposal.cohort_key || "") ||
      !exact(proposal.source, ["id", "shared_award_id", "url", "title", "page_type", "create", "expected_member_kind", "expected_admin_review_status", "expected_text_monitoring_state"]) ||
      !uuid(proposal.source.id) || !uuid(proposal.source.shared_award_id) || typeof proposal.source.create !== "boolean" ||
      !["canonical", "alias"].includes(proposal.source.expected_member_kind) || !object(proposal.source.expected_text_monitoring_state) ||
      !["homepage", "deadline", "eligibility", "application", "requirements", "faq", "pdf", "other"].includes(proposal.source.page_type) ||
      typeof proposal.source.title !== "string" || !proposal.source.title.trim() || proposal.source.title.length > 1000 ||
      !Array.isArray(proposal.roles) || proposal.roles.length > 50 ||
      new Set(proposal.roles.map(role => role?.source_role)).size !== proposal.roles.length || Buffer.byteLength(JSON.stringify(proposal)) > 256 * 1024) fail("invalid_request");
  const scope = proposal.registration_scope;
  if (!(exact(scope, ["kind"]) && scope.kind === "legacy_roles" && proposal.roles.length ||
      exact(scope, ["kind", "inventory_id", "revision"]) && scope.kind === "variation_inventory" && uuid(scope.inventory_id) && uuid(scope.revision) && !proposal.roles.length)) fail("invalid_registration_scope");
  const source = proposal.source, url = programTextCaptureInternals.publicUrl(source.url);
  const driveDocument = source.page_type === "pdf" && programTextPublicDrivePdfIdentity(source.url);
  if (url.protocol !== "https:" || url.search && !driveDocument || source.create && (source.expected_member_kind !== "canonical" ||
      source.shared_award_id !== proposal.expected_canonical_shared_award_id || source.expected_admin_review_status !== null ||
      Object.keys(source.expected_text_monitoring_state).length) || !source.create && !["open", "review_later"].includes(source.expected_admin_review_status)) fail("source_identity_or_history");
  for (const role of proposal.roles) {
    if (!exact(role, ["source_role", "expected_revision", "expected_source_ids", "next_source_ids"]) ||
        !/^[a-z][a-z0-9_]{0,79}$/.test(role.source_role || "") || !uuid(role.expected_revision) ||
        ![role.expected_source_ids, role.next_source_ids].every(ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 50 && ids.every(uuid) && new Set(ids).size === ids.length) ||
        !role.next_source_ids.includes(source.id) || role.expected_source_ids.some(id => !role.next_source_ids.includes(id)) ||
        role.next_source_ids.some(id => id !== source.id && !role.expected_source_ids.includes(id))) fail("role_cas_or_add_only_boundary");
  }
  const references = pending ? [proposal.authority_ref] : [proposal.authority_ref, proposal.target_ref];
  for (const ref of references) validateProgramTextReference(ref);
  if (proposal.authority_ref.source.id === source.id || !pending && (source.create || proposal.target_ref.source.id !== source.id ||
      proposal.target_ref.source.shared_award_id !== source.shared_award_id || proposal.target_ref.source.url !== source.url ||
      proposal.target_ref.source.title !== source.title || proposal.target_ref.source.page_type !== source.page_type ||
      proposal.target_ref.final_url !== source.url && !isProgramTextPublicDrivePdfMetadata(proposal.target_ref))) fail("source_or_alias_identity");
  const documents = [];
  for (const ref of references) {
    const capture = await loadCapture(ref);
    validateProgramTextCapture(capture);
    if (capture.completeness.status !== "complete" || capture.completeness.reasons.length) fail("incomplete_original");
    if (!equal(programTextReference(capture), ref)) fail("retained_original_changed");
    documents.push({ reference: ref, text: capture.text, blocks: capture.blocks, blocks_json: JSON.stringify(canonical(capture.blocks)) });
  }
  const authority = documents[0], block = authority.blocks.find(row => row.id === proposal.link_block_id);
  if (!block || block.kind !== "source_link" || block.context?.source_attribute !== "href" ||
      !Array.isArray(block.context.base_hrefs) || block.context.base_hrefs.length || !block.text ||
      authority.text.slice(block.start_utf16, block.end_utf16) !== block.text) fail("literal_provider_link_missing");
  const linked = new URL(block.text, proposal.authority_ref.final_url);
  if (linked.href !== source.url || linked.username || linked.password || linked.protocol !== "https:" || linked.hash || linked.search && !driveDocument) fail("literal_provider_link_mismatch");
  return { schema: pending ? "awardping.program-text-source-pending-proof.v1" : "awardping.program-text-source-approval-proof.v1", proposal, source_text: documents,
    provider_link: { source_id: proposal.authority_ref.source.id, capture_id: proposal.authority_ref.capture_id,
      block_id: block.id, start_utf16: block.start_utf16, end_utf16: block.end_utf16, text: block.text, resolved_url: linked.href } };
}

export const validateProgramTextSourceApproval = (proposal, context) => validate(proposal, context, false);
export const validateProgramTextSourcePending = (proposal, context) => validate(proposal, context, true);

async function dbValue(query) {
  const { data, error } = await query;
  if (error || data == null) fail("current_private_record_unavailable");
  return data;
}
export async function loadProgramTextSourcePendingBundle(db, id) {
  if (!uuid(id)) fail("invalid_pending_identity");
  const descriptor = await dbValue(db.rpc("get_program_text_source_pending_capture", { p_id: id }));
  const pending = await dbValue(db.from("program_text_source_pending_requests").select("validation,content_hash,url_alias_boundary").eq("id", id).single());
  if (descriptor.schema !== "awardping.program-text-source-pending-capture.v1" || descriptor.id !== id ||
      descriptor.content_hash !== pending.content_hash || !object(pending.validation?.proposal)) fail("pending_identity_changed");
  validateProgramTextURLAliasBoundary(pending.url_alias_boundary, pending.validation.proposal);
  let proof = null;
  if (descriptor.proof !== null) {
    proof = await dbValue(db.from("program_text_source_probe_receipts").select("document,content_hash").eq("pending_id", id).single());
    if (proof.content_hash !== descriptor.proof.content_hash || !equal(proof.document.reference, descriptor.proof.reference)) fail("pending_proof_changed");
  }
  return { descriptor, pending, proof };
}

/** A completed operation stays inspectable even after its successful role CAS. */
export async function loadProgramTextSourceApprovalReceipt(db, id, { epoch } = {}) {
  if (!uuid(id) || !uuid(epoch)) fail("invalid_approval_receipt_scope");
  const { data: approval, error } = await db.from("program_text_source_approvals")
    .select("id,source_id,cohort_key,epoch,content_hash,validation,role_receipts,url_alias_boundary").eq("id", id).maybeSingle();
  if (error) fail("approval_receipt_unavailable");
  if (!approval) return null;
  const pending = await dbValue(db.from("program_text_source_pending_requests").select("content_hash,validation,source_snapshot,url_alias_boundary").eq("id", id).single());
  if (approval.id !== id || approval.validation?.proposal?.id !== id || pending.validation?.proposal?.id !== id ||
      approval.source_id !== pending.validation.proposal.source.id) fail("approval_receipt_identity_changed");
  const aliasBoundary = validateProgramTextURLAliasBoundary(approval.url_alias_boundary, pending.validation.proposal);
  if (!equal(aliasBoundary, validateProgramTextURLAliasBoundary(pending.url_alias_boundary, pending.validation.proposal))) fail("approval_url_alias_boundary_changed");
  let current = false;
  if (approval.epoch === epoch) {
    const proofs = await dbValue(db.rpc("get_program_text_source_approvals", { p_source_ids: [approval.source_id], p_epoch: epoch }));
    if (proofs.schema !== "awardping.program-text-source-approval-page.v1" || proofs.epoch !== epoch || !Array.isArray(proofs.approvals) ||
        !Array.isArray(proofs.source_ids) || proofs.source_ids.length !== 1 || proofs.source_ids[0] !== approval.source_id) fail("approval_receipt_authority_unavailable");
    const matching = proofs.approvals.filter(proof => proof.id === id && proof.content_hash === approval.content_hash);
    current = hasProgramTextSourceAccess({ ...approval.validation.proposal.source, admin_review_status: "review_later", text_source_approvals: matching },
      { cohort: approval.cohort_key, epoch });
    if (current) current = await dbValue(db.rpc("program_text_source_is_approved", { p_source_id: approval.source_id })) === true;
  }
  return { id, source_id: approval.source_id, content_hash: approval.content_hash, pending_hash: pending.content_hash,
    roles: approval.role_receipts, idempotent: true, approved: true, already_approved: true, current, proposal: pending.validation.proposal,
    provider_link: approval.validation.provider_link, target_text: approval.validation.source_text?.[1]?.text ?? null, url_alias_boundary: aliasBoundary };
}

export async function prepareProgramTextSourceOperation(db, proposal, actor, context) {
  if (!uuid(actor)) fail("administrator_identity_required");
  const validation = await validateProgramTextSourcePending(proposal, context);
  return dbValue(db.rpc("prepare_program_text_source", { p_proposal: proposal, p_validation: validation, p_actor: actor }));
}

export async function approveProgramTextSourceOperation(db, id, expectedHash, actor, context) {
  if (!uuid(actor) || !/^[a-f0-9]{64}$/.test(expectedHash || "")) fail("exact_administrator_approval_required");
  const prior = await loadProgramTextSourceApprovalReceipt(db, id, context);
  if (prior) {
    if (prior.pending_hash !== expectedHash) fail("pending_identity_changed");
    // This is a historical/read-only receipt, never a new permission decision.
    return prior;
  }
  const { descriptor, pending, proof } = await loadProgramTextSourcePendingBundle(db, id);
  if (descriptor.content_hash !== expectedHash || descriptor.epoch !== context.epoch || !proof) fail("complete_pending_probe_required");
  const request = pending.validation.proposal;
  const proposal = { ...request, schema: PROGRAM_TEXT_SOURCE_APPROVAL_REQUEST, target_ref: descriptor.proof.reference,
    source: { ...request.source, create: false, expected_admin_review_status: descriptor.source.admin_review_status,
      expected_text_monitoring_state: descriptor.source.text_monitoring_state } };
  const validation = await validateProgramTextSourceApproval(proposal, context);
  if (!equal(validation.source_text[0], pending.validation.source_text[0]) || !equal(validation.source_text[1], proof.document) ||
      !equal(validation.provider_link, pending.validation.provider_link)) fail("saved_original_or_link_changed");
  const committed = await dbValue(db.rpc("approve_program_text_source", { p_proposal: proposal, p_validation: validation, p_actor: actor }));
  const receipt = await loadProgramTextSourceApprovalReceipt(db, id, context);
  if (!receipt || committed.id !== id || receipt.content_hash !== committed.content_hash || receipt.source_id !== proposal.source.id) fail("committed_receipt_unavailable");
  return { ...receipt, idempotent: committed.idempotent === true, already_approved: committed.idempotent === true };
}

export async function revokeProgramTextSourceOperation(db, id, expectedHash, reason, actor) {
  if (!uuid(id) || !uuid(actor) || !/^[a-f0-9]{64}$/.test(expectedHash || "") || typeof reason !== "string" ||
      reason.trim().length < 20 || reason.length > 2000) fail("exact_revocation_required");
  return dbValue(db.rpc("revoke_program_text_source_approval", { p_id: id, p_expected_hash: expectedHash, p_reason: reason, p_actor: actor }));
}
