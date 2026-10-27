import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: {rpc:vi.fn()}, createDb: vi.fn(), createR2: vi.fn(), bucket: vi.fn(), loadCapture: vi.fn(),
  receipt: vi.fn(), bundle: vi.fn(), prepare: vi.fn(), approve: vi.fn(), revoke: vi.fn(), inspectPappg:vi.fn(), preparePappg:vi.fn(), loadDisposition:vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createDb }));
vi.mock("@/lib/r2", () => ({ createR2Client: mocks.createR2, getR2Bucket: mocks.bucket }));
vi.mock("../../scripts/lib/program-text-artifacts.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../../scripts/lib/program-text-artifacts.mjs")>(), loadProgramTextCapture: mocks.loadCapture,
}));
vi.mock("../../scripts/lib/program-text-source-approval.mjs", () => ({
  prepareProgramTextSourceOperation: mocks.prepare, approveProgramTextSourceOperation: mocks.approve,
  revokeProgramTextSourceOperation: mocks.revoke, loadProgramTextSourcePendingBundle: mocks.bundle,
  loadProgramTextSourceApprovalReceipt: mocks.receipt,
}));
vi.mock("../../scripts/lib/program-text-pappg-canonical-operations.mjs",()=>({
  inspectProgramTextPappgCanonicalOperation:mocks.inspectPappg,prepareProgramTextPappgCanonicalOperation:mocks.preparePappg,
  loadProgramTextPappgCanonicalDisposition:mocks.loadDisposition,
}));

import monitoring from "../../config/program-text-monitoring.json";
import { loadProgramTextSourcePending, inspectProgramTextPappgCanonical, prepareProgramTextPappgCanonical } from "./program-text-source-approval.server";

const pendingId = "5575918e-9c11-4fb6-b11d-836fdc06ce8a";
const source = { id: "10000000-0000-4000-8000-000000000001", shared_award_id: "20000000-0000-4000-8000-000000000001",
  url: "https://provider.example/recommenders", title: "Recommender guidance", page_type: "requirements", create: false,
  expected_member_kind: "canonical", expected_admin_review_status: "review_later", expected_text_monitoring_state: {} };
const providerLink = { source_id: "30000000-0000-4000-8000-000000000001", capture_id: "a".repeat(64),
  block_id: "source-link-000003", start_utf16: 100, end_utf16: 113, text: "/recommenders", resolved_url: source.url };
const rawLink = { kind: "retained_raw_html_anchor.v1", source_id: providerLink.source_id, capture_id: providerLink.capture_id,
  raw_artifact: { sha256: "b".repeat(64), byte_length: 128 }, parser_profile: "retained-raw-anchor-v1",
  anchor: { literal_href: "/recommenders", start_tag: '<a href="/recommenders">' }, resolved_url: source.url,
  raw_base64: "UFJJVkFURSBPUklHSU5BTCBCWVRFUw==" };

function approvedReceipt(current: boolean, provider_link: unknown = providerLink) {
  // This is the actual completed-operation DTO shape: source_id and immutable
  // proposal.source, with no top-level source. The browser requires source.
  return { id: pendingId, source_id: source.id, content_hash: "c".repeat(64), pending_hash: "d".repeat(64),
    roles: [{ source_role: "application_materials", revision: "40000000-0000-4000-8000-000000000001" }],
    idempotent: true, approved: true, already_approved: true, current,
    proposal: { id: pendingId, source: structuredClone(source) }, provider_link,
    target_text: "Complete saved official recommender guidance.", url_alias_boundary: [] };
}

function expectClientLoadShape(value: unknown) {
  // Exercise the JSON response the real panel consumes, including the fields
  // that caused the approved-record load to fail before this facade fix.
  const json = JSON.parse(JSON.stringify(value));
  expect(json.id).toBe(pendingId);
  expect(json.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(json.source).toMatchObject({ id: source.id, url: source.url, title: source.title });
  expect(json.target_text === null || typeof json.target_text === "string").toBe(true);
  return json;
}

function expectReadOnlyLoad() {
  expect(mocks.loadCapture).not.toHaveBeenCalled();
  expect(mocks.createR2).not.toHaveBeenCalled();
  expect(mocks.bucket).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.db.rpc).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createDb.mockReturnValue(mocks.db);
  mocks.receipt.mockResolvedValue(null);
  mocks.bundle.mockRejectedValue(new Error("Unexpected pending fallback"));
  mocks.loadDisposition.mockResolvedValue(null);
});

describe("text-source server facade browser load contract", () => {
  it.each([true, false])("returns the immutable approved source identity and preserves current=%s", async current => {
    const approved = approvedReceipt(current), before = structuredClone(approved);
    expect(approved).not.toHaveProperty("source");
    mocks.receipt.mockResolvedValue(approved);

    const value = await loadProgramTextSourcePending(pendingId), json = expectClientLoadShape(value);

    expect(value.source).toBe(approved.proposal.source);
    expect(json).toMatchObject({ status: "approved_record", approved: true, already_approved: true, idempotent: true, current,
      source_id: source.id, proposal: approved.proposal, roles: approved.roles, url_alias_boundary: approved.url_alias_boundary });
    expect(json.source).toEqual(approved.proposal.source);
    expect(json.provider_link).toEqual(providerLink);
    expect(json.catalogue_disposition).toBeNull();
    expect(mocks.loadDisposition).toHaveBeenCalledExactlyOnceWith(mocks.db,pendingId,{epoch:monitoring.epoch,source:approved.proposal.source});
    expect(approved).toEqual(before);
    expect(mocks.receipt).toHaveBeenCalledExactlyOnceWith(mocks.db, pendingId, { epoch: monitoring.epoch });
    expect(mocks.bundle).not.toHaveBeenCalled();
    expectReadOnlyLoad();
  });

  it.each([true, false])("keeps approved raw-anchor bytes private and source identity exact (current=%s)", async current => {
    const approved = approvedReceipt(current, rawLink);
    mocks.receipt.mockResolvedValue(approved);

    const value = await loadProgramTextSourcePending(pendingId), json = expectClientLoadShape(value);

    expect(json.current).toBe(current);
    expect(json.source).toEqual(approved.proposal.source);
    expect(json.provider_link).toEqual({ kind: rawLink.kind, source_id: rawLink.source_id, capture_id: rawLink.capture_id,
      raw_artifact: rawLink.raw_artifact, parser_profile: rawLink.parser_profile, anchor: rawLink.anchor,
      resolved_url: source.url, raw_bytes_retained_privately: true });
    expect(JSON.stringify(json)).not.toContain(rawLink.raw_base64);
    expect(rawLink.raw_base64).toBeTruthy();
    expect(mocks.bundle).not.toHaveBeenCalled();
    expectReadOnlyLoad();
  });

  it.each([true, false])("preserves pending source identity and stored proof availability=%s", async hasProof => {
    const descriptor = { schema: "awardping.program-text-source-pending-capture.v1", id: pendingId, content_hash: "d".repeat(64),
      epoch: monitoring.epoch, source: structuredClone(source), proof: hasProof ? { reference: { capture_id: "e".repeat(64) } } : null };
    const proposal = { id: pendingId, source: structuredClone(source) };
    mocks.bundle.mockResolvedValue({ descriptor, pending: { validation: { proposal, provider_link: providerLink }, url_alias_boundary: [] },
      proof: hasProof ? { document: { text: "Complete saved official recommender guidance." } } : null });

    const value = await loadProgramTextSourcePending(pendingId), json = expectClientLoadShape(value);

    expect(value.source).toBe(descriptor.source);
    expect(json).toMatchObject({ approved: false, current: false, already_approved: false, proposal, provider_link: providerLink });
    expect(json.proof).toEqual(descriptor.proof);
    expect(json.target_text).toBe(hasProof ? "Complete saved official recommender guidance." : null);
    expect(json.catalogue_disposition).toBeNull();
    expect(mocks.bundle).toHaveBeenCalledExactlyOnceWith(mocks.db, pendingId);
    expectReadOnlyLoad();
  });

  it("retains raw-anchor redaction on the unapproved pending path", async () => {
    mocks.bundle.mockResolvedValue({ descriptor: { id: pendingId, content_hash: "d".repeat(64), source, proof: null },
      pending: { validation: { proposal: { id: pendingId, source }, provider_link: rawLink } }, proof: null });

    const json = expectClientLoadShape(await loadProgramTextSourcePending(pendingId));

    expect(json.approved).toBe(false);
    expect(json.provider_link.raw_bytes_retained_privately).toBe(true);
    expect(json.provider_link).not.toHaveProperty("raw_base64");
    expect(json.url_alias_boundary).toEqual([]);
    expectReadOnlyLoad();
  });

  it("propagates an unconfirmed approval identity instead of synthesizing a pending source", async () => {
    mocks.receipt.mockRejectedValue(new Error("approval_receipt_identity_changed"));

    await expect(loadProgramTextSourcePending(pendingId)).rejects.toThrow("approval_receipt_identity_changed");

    expect(mocks.bundle).not.toHaveBeenCalled();
    expectReadOnlyLoad();
  });
});

describe("finite canonical disposition remains separate from ordinary source approval",()=>{
  const selectedSource={...source,id:"de868fe8-54ba-4fa0-8210-b27c8f182112",shared_award_id:"d955a846-cee1-4c01-932e-e3cb7215f3fb",url:"https://www.nsf.gov/policies/pappg",title:"PAPPG"};
  const disposition={schema:"awardping.program-text-pappg-canonical-disposition-record.v1",pending_id:pendingId,epoch:monitoring.epoch,
    selected_source_id:selectedSource.id,source_url:selectedSource.url,shared_award_id:selectedSource.shared_award_id,cohort_key:"nsf_grfp",
    revision:"88888888-8888-4888-8888-888888888888",content_hash:"f".repeat(64),current:false,context:{preserved_records:[{id:"19204933-2b56-42ac-96ee-b54213a2785a",owner_id:"c9b26239-8177-445b-ab39-473bc0c14d8f",history:"preserved"}]},reason:"Explicit finite duplicate disposition; foreign owners and original histories remain unchanged.",approval_id:null};
  it.each([false,true])("returns the finite disposition beside pending/approved source data, never as an alias (%s)",async approved=>{
    mocks.loadDisposition.mockResolvedValue(disposition);
    if(approved){const receipt=approvedReceipt(false,rawLink);receipt.proposal.source=selectedSource;mocks.receipt.mockResolvedValue(receipt);}
    else mocks.bundle.mockResolvedValue({descriptor:{id:pendingId,content_hash:"d".repeat(64),source:selectedSource,proof:null},
      pending:{validation:{proposal:{id:pendingId,source:selectedSource},provider_link:rawLink},url_alias_boundary:[]},proof:null});
    const value=await loadProgramTextSourcePending(pendingId),json=JSON.parse(JSON.stringify(value));
    expect(json.source).toEqual(selectedSource);expect(json.catalogue_disposition).toEqual(disposition);expect(json.url_alias_boundary).toEqual([]);
    expect(json.catalogue_disposition.context.preserved_records).toHaveLength(1);expect(json.url_alias_boundary).not.toEqual(json.catalogue_disposition.context.preserved_records);
    expect(json.provider_link).not.toHaveProperty("raw_base64");expect(JSON.stringify(json)).not.toContain(rawLink.raw_base64);
    expect(mocks.loadDisposition).toHaveBeenCalledExactlyOnceWith(mocks.db,pendingId,{epoch:monitoring.epoch,source:selectedSource});expectReadOnlyLoad();
  });
  it("delegates explicit inspection without opening retained raw storage",async()=>{
    const inspection={schema:"awardping.program-text-pappg-canonical-inspection.v1",context:{},context_hash:"f".repeat(64)};mocks.inspectPappg.mockResolvedValue(inspection);
    expect(await inspectProgramTextPappgCanonical()).toBe(inspection);expect(mocks.inspectPappg).toHaveBeenCalledExactlyOnceWith(mocks.db,{epoch:monitoring.epoch});expectReadOnlyLoad();
  });
  it("passes a finite preparation actor and cold-loader context to its own operation",async()=>{
    mocks.createR2.mockReturnValue({privateClient:true});mocks.bucket.mockReturnValue("private-test-bucket");mocks.preparePappg.mockResolvedValue({id:pendingId});
    const proposal={id:pendingId,source:selectedSource};expect(await prepareProgramTextPappgCanonical(proposal,disposition,source.id)).toEqual({id:pendingId});
    expect(mocks.preparePappg).toHaveBeenCalledExactlyOnceWith(mocks.db,proposal,disposition,source.id,{epoch:monitoring.epoch,loadCapture:expect.any(Function)});
    expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.approve).not.toHaveBeenCalled();expect(mocks.loadCapture).not.toHaveBeenCalled();
  });
});
