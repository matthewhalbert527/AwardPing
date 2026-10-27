import { describe, expect, it, vi } from "vitest";
import { buildProgramTextCapture } from "./program-text-capture-contract.mjs";
import { programTextReference } from "./program-text-artifacts.mjs";
import { validateProgramTextSourceApproval, validateProgramTextSourcePending, prepareProgramTextSourceOperation,
  approveProgramTextSourceOperation, revokeProgramTextSourceOperation } from "./program-text-source-approval.mjs";

const targetId = "10000000-0000-4000-8000-000000000001", authorityId = "10000000-0000-4000-8000-000000000002";
const owner = "20000000-0000-4000-8000-000000000001", id = "30000000-0000-4000-8000-000000000001", actor = "40000000-0000-4000-8000-000000000001";
const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec", other = "50000000-0000-4000-8000-000000000001";
function fixture({ href = "/award/requirements", base = [], linkKind = "source_link", incomplete = false } = {}) {
  const source = { id: targetId, shared_award_id: owner, url: "https://example.org/award/requirements", title: "Award requirements", page_type: "eligibility" };
  const index = { id: authorityId, shared_award_id: owner, url: "https://example.org/award/", title: "Official award index", page_type: "homepage" };
  const body = "The official program provides complete applicant guidance and funding information for the upcoming competition.";
  const make = (who, text, blocks, completeness) => buildProgramTextCapture({ source: who, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`),
    content_type: "text/html", text, blocks, extractor: { name: "fixture", version: "1" }, captured_at: "2026-10-26T21:00:00.000Z", ...(completeness ? { completeness } : {}) });
  const text = body + "\n\n" + href;
  const provider = make(index, text, [{ id: "program", text: body, start_utf16: 0, end_utf16: body.length },
    { id: "link", kind: linkKind, text: href, start_utf16: body.length + 2, end_utf16: text.length,
      context: { source_attribute: "href", link_text: "Applicant requirements", base_hrefs: base, heading_path: [], list_path: [] } }]);
  const target = make(source, body, [{ id: "details", text: body, start_utf16: 0, end_utf16: body.length }], incomplete ? { status: "incomplete", reasons: ["incomplete_page"] } : null);
  const captures = new Map([[provider.capture_id, provider], [target.capture_id, target]]);
  const pending = { schema: "awardping.program-text-source-pending-request.v1", id, cohort_key: "example", epoch, expected_canonical_shared_award_id: owner,
    registration_scope: { kind: "legacy_roles" },
    source: { ...source, create: false, expected_member_kind: "canonical", expected_admin_review_status: "review_later", expected_text_monitoring_state: {} },
    authority_ref: programTextReference(provider), link_block_id: "link",
    roles: [{ source_role: "eligibility", expected_revision: epoch, expected_source_ids: [authorityId], next_source_ids: [authorityId, targetId] }] };
  const request = { ...pending, schema: "awardping.program-text-source-approval-request.v1", target_ref: programTextReference(target) };
  const context = { epoch, loadCapture: vi.fn(async ref => captures.get(ref.capture_id)) };
  return { pending, request, context, provider, target };
}

describe("retained provider-index proof before text-only approval", () => {
  it("prepares only the official link; it does not invent a target capture or baseline", async () => {
    const f = fixture(), proof = await validateProgramTextSourcePending(f.pending, f.context);
    expect(proof.schema).toBe("awardping.program-text-source-pending-proof.v1"); expect(proof.source_text).toHaveLength(1);
    expect(f.context.loadCapture).toHaveBeenCalledExactlyOnceWith(f.pending.authority_ref);
    expect(proof.provider_link.resolved_url).toBe(f.pending.source.url);
  });
  it("cold-restores full provider and target originals, including the literal href", async () => {
    const f = fixture(), proof = await validateProgramTextSourceApproval(f.request, f.context);
    expect(proof.source_text).toHaveLength(2); expect(proof.source_text[1].text).toBe(f.target.text);
    expect(proof.provider_link.text).toBe("/award/requirements"); expect(f.context.loadCapture).toHaveBeenCalledTimes(2);
  });
  it("supports a separately approved draft-inventory source without adding global legacy roles", async () => {
    const f = fixture(); f.pending.registration_scope = { kind: "variation_inventory", inventory_id: other, revision: epoch }; f.pending.roles = [];
    expect((await validateProgramTextSourcePending(f.pending, f.context)).proposal.roles).toEqual([]);
    f.pending.registration_scope.revision = "unversioned";
    await expect(validateProgramTextSourcePending(f.pending, f.context)).rejects.toThrow("registration_scope");
  });
  it.each([
    f => { f.request.epoch = other; }, f => { f.request.source.shared_award_id = other; },
    f => { f.request.source.url += "/"; }, f => { f.request.link_block_id = "program"; },
    f => { f.request.roles[0].next_source_ids.push(other); }, f => { f.request.roles[0].next_source_ids = [targetId]; },
    f => { f.request.roles[0].expected_source_ids.push(authorityId); }, f => { f.request.source.create = true; },
  ])("rejects stale epoch/owner/alias and unauthorized role expansion %#", async mutate => {
    const f = fixture(); mutate(f); await expect(validateProgramTextSourceApproval(f.request, f.context)).rejects.toThrow();
  });
  it.each([{ href: "https://other.example/award/requirements" }, { base: ["https://other.example/"] }, { linkKind: "paragraph" }])("rejects ambiguous or unsupported literal provider links %j", async options => {
    const f = fixture(options); await expect(validateProgramTextSourcePending(f.pending, f.context)).rejects.toThrow();
  });
  it("accepts new pending canonical identities only with empty history and null legacy status", async () => {
    const f = fixture(); f.pending.source.create = true; f.pending.source.expected_admin_review_status = null;
    expect((await validateProgramTextSourcePending(f.pending, f.context)).source_text).toHaveLength(1);
    f.pending.source.expected_member_kind = "alias";
    await expect(validateProgramTextSourcePending(f.pending, f.context)).rejects.toThrow("source_identity_or_history");
  });
  it("rejects changed cold originals before any authority mutation", async () => {
    const f = fixture(); f.target.text += " forged";
    await expect(validateProgramTextSourceApproval(f.request, f.context)).rejects.toThrow();
  });
  it("sends a prepared request through the one scoped RPC without touching source state", async () => {
    const f = fixture(), before = structuredClone(f.pending), calls = [];
    const db = { rpc: async (name, p) => { calls.push({ name, p }); return { data: { id } }; } };
    await prepareProgramTextSourceOperation(db, f.pending, actor, f.context);
    expect(calls.map(call => call.name)).toEqual(["prepare_program_text_source"]);
    expect(f.pending).toEqual(before); expect(calls[0].p.p_validation.source_text).toHaveLength(1);
  });
  it("cold-verifies the stored immutable target proof before final approval", async () => {
    const f = fixture(), pendingProof = await validateProgramTextSourcePending(f.pending, f.context);
    const approval = await validateProgramTextSourceApproval(f.request, f.context), hash = "a".repeat(64), calls = [];
    const descriptor = { schema: "awardping.program-text-source-pending-capture.v1", id, epoch, content_hash: hash,
      source: { admin_review_status: "review_later", text_monitoring_state: {} }, proof: { reference: f.request.target_ref, content_hash: "b".repeat(64) } };
    let committedRecord = null;
    const db = { rpc: async (name, params) => {
      calls.push({ name, params });
      if (name === "get_program_text_source_pending_capture") return { data: descriptor };
      if (name === "approve_program_text_source") {
        committedRecord = { id, source_id: targetId, cohort_key: "example", epoch, content_hash: "c".repeat(64), validation: params.p_validation, role_receipts: [] };
        return { data: { id, source_id: targetId, content_hash: committedRecord.content_hash, idempotent: false } };
      }
      if (name === "program_text_source_is_approved") return { data: true };
      if (name === "get_program_text_source_approvals") return { data: { schema: "awardping.program-text-source-approval-page.v1", epoch, source_ids: [targetId],
        approvals: [{ schema: "awardping.program-text-source-approval.v1", id, source_id: targetId, shared_award_id: owner, source_url: f.request.source.url,
          cohort_key: "example", epoch, content_hash: committedRecord.content_hash, current: true }] } };
      throw Error("Unexpected source operation");
    }, from: table => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: committedRecord }), single: async () => ({ data: table === "program_text_source_pending_requests" ?
        { validation: pendingProof, content_hash: hash } : { document: approval.source_text[1], content_hash: "b".repeat(64) } }) }; return q; } };
    expect(await approveProgramTextSourceOperation(db, id, hash, actor, f.context)).toMatchObject({ approved: true, current: true, already_approved: false });
    expect(calls.map(call => call.name)).toEqual(["get_program_text_source_pending_capture", "approve_program_text_source", "get_program_text_source_approvals", "program_text_source_is_approved"]);
    expect(calls[1].params.p_proposal.source.create).toBe(false);
    expect(calls[1].params.p_proposal.source.expected_admin_review_status).toBe("review_later");
    descriptor.proof = null; calls.length = 0; committedRecord = null;
    await expect(approveProgramTextSourceOperation(db, id, hash, actor, f.context)).rejects.toThrow("complete_pending_probe_required");
    expect(calls.map(call => call.name)).toEqual(["get_program_text_source_pending_capture"]);
  });
  it("requires an exact actor/hash and meaningful reason for revocation", async () => {
    const calls = [], db = { rpc: async (name, params) => { calls.push({ name, params }); return { data: { id, revoked: true } }; } };
    await revokeProgramTextSourceOperation(db, id, "a".repeat(64), "The official provider removed this program source.", actor);
    expect(calls.map(call => call.name)).toEqual(["revoke_program_text_source_approval"]);
    await expect(revokeProgramTextSourceOperation(db, id, "bad", "short", actor)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("returns a historical idempotent receipt after successful CAS, with fresh currentness and no reapproval", async () => {
    const f = fixture(), pendingProof = await validateProgramTextSourcePending(f.pending, f.context);
    const validated = await validateProgramTextSourceApproval(f.request, f.context), pendingHash = "a".repeat(64), approvalHash = "b".repeat(64), calls = [];
    const record = { id, source_id: targetId, cohort_key: "example", epoch, content_hash: approvalHash, validation: validated, role_receipts: [] };
    let current = true;
    const db = { from: table => { const q = { select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: record }), single: async () => ({ data: table === "program_text_source_pending_requests" ?
        { content_hash: pendingHash, validation: pendingProof, source_snapshot: {} } : null }) };return q; },
    rpc: async (name, params) => { calls.push({ name, params });if (name === "program_text_source_is_approved") return { data: true };return { data: { schema: "awardping.program-text-source-approval-page.v1", epoch,
      source_ids: [targetId], approvals: current ? [{ schema: "awardping.program-text-source-approval.v1", id, source_id: targetId,
        shared_award_id: owner, source_url: f.request.source.url, cohort_key: "example", epoch, content_hash: approvalHash, current: true }] : [] } }; } };
    f.context.loadCapture.mockClear();
    expect(await approveProgramTextSourceOperation(db, id, pendingHash, actor, f.context)).toMatchObject({ approved: true, already_approved: true, idempotent: true, current: true });
    current = false;
    expect(await approveProgramTextSourceOperation(db, id, pendingHash, actor, f.context)).toMatchObject({ idempotent: true, current: false });
    expect(calls.every(call => ["get_program_text_source_approvals", "program_text_source_is_approved"].includes(call.name))).toBe(true);
    expect(f.context.loadCapture).not.toHaveBeenCalled();
    await expect(approveProgramTextSourceOperation(db, id, "c".repeat(64), actor, f.context)).rejects.toThrow("pending_identity_changed");
    expect(calls.every(call => ["get_program_text_source_approvals", "program_text_source_is_approved"].includes(call.name))).toBe(true);
  });
});
