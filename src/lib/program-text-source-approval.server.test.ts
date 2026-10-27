import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: {}, createDb: vi.fn(), createR2: vi.fn(), bucket: vi.fn(), loadCapture: vi.fn(),
  receipt: vi.fn(), bundle: vi.fn(), prepare: vi.fn(), approve: vi.fn(), revoke: vi.fn() }));
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

import monitoring from "../../config/program-text-monitoring.json";
import { loadProgramTextSourcePending } from "./program-text-source-approval.server";

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
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createDb.mockReturnValue(mocks.db);
  mocks.receipt.mockResolvedValue(null);
  mocks.bundle.mockRejectedValue(new Error("Unexpected pending fallback"));
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
