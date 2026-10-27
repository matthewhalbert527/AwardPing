import { describe, expect, it } from "vitest";
import { hasProgramTextSourceAccess, attachProgramTextSourceApprovals } from "./program-text-source-access.mjs";
const id = "10000000-0000-4000-8000-000000000001", owner = "20000000-0000-4000-8000-000000000001";
const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec", other = "30000000-0000-4000-8000-000000000001";
const source = () => ({ id, shared_award_id: owner, url: "https://example.org/award", admin_review_status: "review_later", text_monitoring_state: {} });
const proof = () => ({ schema: "awardping.program-text-source-approval.v1", id: other, source_id: id, shared_award_id: owner,
  source_url: "https://example.org/award", cohort_key: "udall_undergraduate", epoch, content_hash: "a".repeat(64), current: true });

describe("separate scoped text authority", () => {
  it("keeps legacy open authority compatible and does not treat review_later as approval", () => {
    expect(hasProgramTextSourceAccess({ ...source(), admin_review_status: "open" })).toBe(true);
    expect(hasProgramTextSourceAccess(source(), { cohort: "udall_undergraduate", epoch })).toBe(false);
    expect(hasProgramTextSourceAccess({ ...source(), text_source_approvals: [proof()] }, { cohort: "udall_undergraduate", epoch })).toBe(true);
  });
  it.each([
    p => { p.source_id = other; }, p => { p.shared_award_id = other; }, p => { p.source_url += "/"; },
    p => { p.cohort_key = "other_award"; }, p => { p.epoch = other; }, p => { p.current = false; },
    p => { p.schema = "legacy_visual_approval"; }, p => { p.content_hash = "unverified"; }, p => { p.extra_permission = true; },
  ])("fails closed on wrong identity, alias, epoch, revocation or forged flags %#", mutate => {
    const approval = proof(); mutate(approval);
    expect(hasProgramTextSourceAccess({ ...source(), text_source_approvals: [approval] }, { cohort: "udall_undergraduate", epoch })).toBe(false);
  });
  it("requires an explicit current epoch and cannot reopen another legacy status", () => {
    expect(hasProgramTextSourceAccess({ ...source(), text_source_approvals: [proof()] })).toBe(false);
    expect(hasProgramTextSourceAccess({ ...source(), admin_review_status: "disabled", text_source_approvals: [proof()] }, { epoch })).toBe(false);
  });
  it("hydrates fresh proofs without mutating legacy status or saved source history", async () => {
    const original = source(), before = structuredClone(original), calls = [];
    const db = { rpc: async (name, params) => { calls.push({ name, params }); return { data: {
      schema: "awardping.program-text-source-approval-page.v1", epoch, source_ids: [id], approvals: [proof()] } }; } };
    const [hydrated] = await attachProgramTextSourceApprovals(db, [original], { epoch });
    expect(original).toEqual(before); expect(hydrated.admin_review_status).toBe("review_later"); expect(hydrated.text_monitoring_state).toEqual({});
    expect(hasProgramTextSourceAccess(hydrated, { epoch })).toBe(true);
    expect(calls).toEqual([{ name: "get_program_text_source_approvals", params: { p_source_ids: [id], p_epoch: epoch } }]);
  });
  it("keeps an absent or revoked approval held instead of fabricating permission", async () => {
    const db = { rpc: async () => ({ data: { schema: "awardping.program-text-source-approval-page.v1", epoch, source_ids: [id], approvals: [] } }) };
    const [hydrated] = await attachProgramTextSourceApprovals(db, [source()], { epoch });
    expect(hasProgramTextSourceAccess(hydrated, { epoch })).toBe(false);
  });
  it.each([
    data => { data.source_ids = []; }, data => { data.epoch = other; }, data => { data.approvals[0].source_url += "/wrong"; },
    data => { data.approvals.push(proof()); }, data => { data.approvals[0].source_id = other; },
  ])("rejects truncated or mismatched database proof pages %#", async mutate => {
    const data = { schema: "awardping.program-text-source-approval-page.v1", epoch, source_ids: [id], approvals: [proof()] }; mutate(data);
    await expect(attachProgramTextSourceApprovals({ rpc: async () => ({ data }) }, [source()], { epoch })).rejects.toThrow();
  });
  it("bounds proof requests to100 sources and makes no RPC for legacy open-only inputs", async () => {
    const values = Array.from({ length: 201 }, (_, index) => ({ ...source(), id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    const sizes = [], db = { rpc: async (_name, p) => { sizes.push(p.p_source_ids.length); return { data: {
      schema: "awardping.program-text-source-approval-page.v1", epoch, source_ids: p.p_source_ids, approvals: [] } }; } };
    await attachProgramTextSourceApprovals(db, values, { epoch }); expect(sizes).toEqual([100, 100, 1]);
    await attachProgramTextSourceApprovals({ rpc: () => { throw Error("Unexpected legacy RPC"); } }, [{ ...source(), admin_review_status: "open" }], { epoch });
  });
});
