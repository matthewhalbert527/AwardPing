import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertReview } from "./alert-group-review";
const m = vi.hoisted(() => ({ rpc: vi.fn(), load: vi.fn(), members: vi.fn(), pending: vi.fn(), approved: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/alert-review.server", () => ({ loadAlertReviews: m.load, loadAlertReviewMembers: m.members, verifyPendingAlertReview: m.pending, verifyApprovedAlertReview: m.approved }));
import { loadAlertReviewBoard, previewAlertGroup, saveAlertGroup, decideAlertGroup } from "./alert-groups.server";
const id = (n: number) => `${n.toString().padStart(8, "0")}-0000-4000-8000-000000000001`;
const actor = id(1), award = id(2), groupId = id(3), h = "a".repeat(64), gh = "b".repeat(64);
let leaves: AlertReview[], group: Record<string, unknown>;
const memberRefs = () => leaves.map(l => ({ id: l.id, content_hash: l.contentHash }));
beforeEach(() => {
  vi.resetAllMocks();
  leaves = [
    { id: id(4), contentHash: h, awardId: award, awardName: "Knight-Hennessy Scholars", summary: "The page added a processing restriction for people located in or ordinarily living in Iran.", sourceUrl: "https://knight-hennessy.stanford.edu/admission/planning-apply/eligibility", detectedAt: new Date(Date.now() - 86400000).toISOString(), status: "approved", details: [{ category: "Eligibility", summary: "New processing restriction.", current: "Individuals currently located in Iran." }] },
    { id: id(5), contentHash: h, awardId: award, awardName: "Knight-Hennessy Scholars", summary: "The official page no longer states: all countries are encouraged to apply.", sourceUrl: "https://knight-hennessy.stanford.edu/admission/planning-apply/eligibility", detectedAt: new Date().toISOString(), status: "pending", details: [{ category: "Citizenship", summary: "General encouragement wording removed.", previous: "We encourage citizens and residents of all countries to apply." }] },
  ];
  group = { id: groupId, shared_award_id: award, retired: false, head: { id: id(6), revision: 1, operation: "draft", member_refs: memberRefs(), event_refs: null, content_hash: gh, created_at: new Date().toISOString() }, published: null };
  m.load.mockImplementation(async status => leaves.filter(l => l.status === status));
  m.members.mockImplementation(async ids => leaves.filter(l => ids.includes(l.id)));
  m.rpc.mockImplementation(async name => ({ data: name === "get_program_text_alert_groups" ? [] : { ok: true }, error: null }));
  m.pending.mockResolvedValue(undefined); m.approved.mockResolvedValue(undefined);
});
describe("related updates are drafts over original verified alerts", () => {
  it("suggests the actual same-page eligibility pair without claiming causality or changing evidence", async () => {
    const before = structuredClone(leaves); const board = await loadAlertReviewBoard();
    expect(board.alerts).toHaveLength(1); expect(board.alerts[0].id).toBe(leaves[1].id);
    expect(board.mergeOptions.find(x => x.id === leaves[0].id)?.relatedToIds).toContain(leaves[1].id);
    expect(leaves).toEqual(before); expect(m.pending).not.toHaveBeenCalled(); expect(m.approved).not.toHaveBeenCalled();
  });
  it("does not suggest foreign awards merely because names or prose match", async () => {
    leaves[0].awardId = id(9); const board = await loadAlertReviewBoard();
    expect(board.mergeOptions.every(o => !o.relatedToIds?.length)).toBe(true);
    await expect(previewAlertGroup(leaves[0].id, leaves[1].id)).rejects.toThrow("same award");
  });
  it("previews pending plus approved with both original links/quotes and no approval", async () => {
    const preview = await previewAlertGroup(leaves[1].id, leaves[0].id);
    expect(preview.members).toEqual(leaves); expect(preview.memberRefs).toEqual(memberRefs());
    expect(preview.publishedMemberIds).toEqual([leaves[0].id]); expect(preview.message).toContain("stays live");
    expect(preview.summary).toContain(leaves[0].summary); expect(preview.summary).toContain(leaves[1].summary);
    expect(m.rpc.mock.calls.every(c => c[0] === "get_program_text_alert_groups")).toBe(true);
  });
  it("shows a mixed draft only once and keeps its already approved member identified", async () => {
    m.rpc.mockResolvedValue({ data: [group], error: null }); const board = await loadAlertReviewBoard();
    expect(board.alerts).toHaveLength(1); expect(board.alerts[0].id).toBe(groupId);
    expect(board.alerts[0].group?.members).toHaveLength(2); expect(board.alerts[0].group?.publishedMemberIds).toEqual([leaves[0].id]);
    expect(board.mergeOptions).toHaveLength(1);
  });
  it("discovers all-approved combined drafts without manufacturing pending source reviews", async () => {
    leaves[1].status = "approved"; m.rpc.mockResolvedValue({ data: [group], error: null });
    const board = await loadAlertReviewBoard("pending"); expect(board.alerts).toHaveLength(1);
    expect(board.alerts[0].status).toBe("pending"); expect(board.alerts[0].group?.members.every(l => l.status === "approved")).toBe(true);
  });
  it("saves only member/hash references and never publishes or obtains a model response", async () => {
    await saveAlertGroup({ group_id: null, expected_hash: null, members: memberRefs() }, actor);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("save_program_text_alert_group", { p_group_id: null, p_expected_hash: null, p_members: memberRefs(), p_actor: actor });
    expect(m.pending).not.toHaveBeenCalled(); expect(m.approved).not.toHaveBeenCalled();
  });
  it("rejects a changed preview hash before making any mutating RPC", async () => {
    const input = { group_id: null, expected_hash: null, members: memberRefs() }; leaves[1].contentHash = gh;
    await expect(saveAlertGroup(input, actor)).rejects.toThrow("changed"); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("cold verifies every pending/historical member before ONE atomic group approval", async () => {
    m.rpc.mockImplementation(async name => ({ data: name === "get_program_text_alert_groups" ? [group] : { ok: true }, error: null }));
    await decideAlertGroup({ id: groupId, expected_hash: gh, action: "approve" }, actor);
    expect(m.pending).toHaveBeenCalledExactlyOnceWith(leaves[1].id, h, expect.anything());
    expect(m.approved).toHaveBeenCalledExactlyOnceWith(leaves[0].id, h, expect.anything());
    const mutations = m.rpc.mock.calls.filter(c => c[0] !== "get_program_text_alert_groups");
    expect(mutations).toEqual([["decide_program_text_alert_group", { p_id: groupId, p_expected_hash: gh, p_action: "approve", p_actor: actor }]]);
    expect(m.pending.mock.invocationCallOrder[0]).toBeLessThan(m.rpc.mock.invocationCallOrder.at(-1)!);
  });
  it("does not submit any approval when one original evidence check fails", async () => {
    m.rpc.mockResolvedValue({ data: [group], error: null }); m.pending.mockRejectedValue(Error("original unavailable"));
    await expect(decideAlertGroup({ id: groupId, expected_hash: gh, action: "approve" }, actor)).rejects.toThrow("original unavailable");
    expect(m.rpc.mock.calls.every(c => c[0] === "get_program_text_alert_groups")).toBe(true);
  });
  it("rejects stale group revisions and preserves individual source status on undo", async () => {
    m.rpc.mockImplementation(async name => ({ data: name === "get_program_text_alert_groups" ? [group] : { ok: true }, error: null }));
    await expect(decideAlertGroup({ id: groupId, expected_hash: h, action: "approve" }, actor)).rejects.toThrow("changed");
    const before = structuredClone(leaves); await decideAlertGroup({ id: groupId, expected_hash: gh, action: "undo" }, actor);
    expect(m.pending).not.toHaveBeenCalled(); expect(m.approved).not.toHaveBeenCalled(); expect(leaves).toEqual(before);
  });
  it("fails closed on unavailable group metadata instead of showing duplicate raw updates", async () => {
    m.rpc.mockResolvedValue({ error: { code: "unavailable" }, data: null });
    await expect(loadAlertReviewBoard()).rejects.toThrow("could not be confirmed");
  });
});
