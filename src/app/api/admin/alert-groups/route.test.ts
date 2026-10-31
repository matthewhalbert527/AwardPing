import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), preview: vi.fn(), save: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: m.user, isSiteAdminEmail: m.admin }));
vi.mock("@/lib/alert-groups.server", () => ({ previewAlertGroup: m.preview, saveAlertGroup: m.save, decideAlertGroup: m.decide }));
import { GET, POST } from "./route";
const actor = "10000000-0000-4000-8000-000000000001", one = "20000000-0000-4000-8000-000000000002", two = "30000000-0000-4000-8000-000000000003", h = "a".repeat(64);
const save = { action: "save", group_id: null, expected_hash: null, members: [{ id: one, content_hash: h }, { id: two, content_hash: h }] };
const request = (body: unknown, origin: string | null = "https://awardping.com", headers = {}) => new Request("https://awardping.com/api/admin/alert-groups", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); m.user.mockResolvedValue({ id: actor, email: "admin@example.org" }); m.admin.mockReturnValue(true); m.save.mockResolvedValue({ ok: true }); m.decide.mockResolvedValue({ ok: true }); m.preview.mockResolvedValue({ members: [] }); });
describe("authenticated bounded combined-update workflow", () => {
  it("loads a private read-only preview without making a decision", async () => {
    const response = await GET(new Request(`https://awardping.com/api/admin/alert-groups?source=${one}&target=${two}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(m.preview).toHaveBeenCalledExactlyOnceWith(one, two); expect(m.save).not.toHaveBeenCalled(); expect(m.decide).not.toHaveBeenCalled();
  });
  it.each([401, 403])("requires genuine administrator access for every action (%s)", async status => {
    if (status === 401) m.user.mockResolvedValue(null); else m.admin.mockReturnValue(false);
    expect((await GET(new Request(`https://awardping.com/api/admin/alert-groups?source=${one}&target=${two}`))).status).toBe(status);
    expect((await POST(request(save))).status).toBe(status); expect(m.preview).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
  it.each([null, "null", "https://elsewhere.example", "https://awardping.com/"])("rejects cross-origin mutation %s", async origin => {
    expect((await POST(request(save, origin))).status).toBe(403); expect(m.save).not.toHaveBeenCalled();
  });
  it("saves only the explicitly previewed original hashes; does not approve", async () => {
    expect((await POST(request(save))).status).toBe(200);
    expect(m.save).toHaveBeenCalledExactlyOnceWith({ group_id: null, expected_hash: null, members: save.members }, actor);
    expect(m.decide).not.toHaveBeenCalled();
  });
  it.each(["approve", "undo"])("binds explicit %s to the group revision and authenticated actor", async action => {
    expect((await POST(request({ action, id: one, expected_hash: h }))).status).toBe(200);
    expect(m.decide).toHaveBeenCalledExactlyOnceWith({ action, id: one, expected_hash: h }, actor);
  });
  it.each([{ ...save, actor }, { ...save, expected_hash: h }, { ...save, members: [save.members[0], save.members[0]] }, { ...save, members: [...save.members, { id: actor, content_hash: "bad" }] }, { ...save, summary: "unverified wording" }, { action: "approve", id: one, expected_hash: h, members: [] }])("rejects forged, duplicate or incomplete proposals", async body => {
    expect((await POST(request(body))).status).toBe(400); expect(m.save).not.toHaveBeenCalled(); expect(m.decide).not.toHaveBeenCalled();
  });
  it("bounds real body bytes and does not expose private verification failures", async () => {
    expect((await POST(request(" ".repeat(4097)))).status).toBe(413);
    m.decide.mockRejectedValue(Error("private-bucket-secret"));
    const response = await POST(request({ action: "approve", id: one, expected_hash: h }));
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("private-bucket-secret");
  });
  it.each([`?source=${one}&target=${two}&actor=${actor}`, `?source=${one}&source=${two}&target=${two}`, "?source=bad&target=bad"])("rejects ambiguous previews %s", async query => {
    expect((await GET(new Request(`https://awardping.com/api/admin/alert-groups${query}`))).status).toBe(400); expect(m.preview).not.toHaveBeenCalled();
  });
});
