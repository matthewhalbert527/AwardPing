import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), prepare: vi.fn(), approve: vi.fn(), revoke: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user, isSiteAdminEmail: mocks.admin }));
vi.mock("@/lib/program-text-source-approval.server", () => ({ prepareProgramTextSource: mocks.prepare, approveProgramTextSource: mocks.approve, revokeProgramTextSource: mocks.revoke, loadProgramTextSourcePending: mocks.load }));
import { GET, POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111", hash = "a".repeat(64);
function request(body: unknown, origin: string | null = "https://awardping.com") { return new Request("https://awardping.com/api/admin/program-text-sources", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }); }
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.user.mockResolvedValue({ id, email: "admin@example.test" }); mocks.admin.mockReturnValue(true); });
describe("separate authenticated text-source approval", () => {
  it("denies anonymous reads and authenticated non-admin mutations", async () => {
    mocks.user.mockResolvedValue(null); expect((await GET(new Request(`https://awardping.com/api/admin/program-text-sources?id=${id}`))).status).toBe(401);
    mocks.user.mockResolvedValue({ id }); mocks.admin.mockReturnValue(false); expect((await POST(request({ action: "prepare", proposal: {} }))).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each([null, "https://attacker.test"])("denies a mutation with origin %s", async origin => {
    expect((await POST(request({ action: "approve", id, expected_hash: hash }, origin))).status).toBe(403); expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("approves only the stored pending identity/hash using the signed-in reviewer", async () => {
    mocks.approve.mockResolvedValue({ id }); const result = await POST(request({ action: "approve", id, expected_hash: hash }));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.approve).toHaveBeenCalledExactlyOnceWith(id, hash, id);
  });
  it("rejects client-supplied target evidence, actors and repeated pending keys", async () => {
    expect((await POST(request({ action: "approve", id, expected_hash: hash, target_ref: {} }))).status).toBe(400);
    expect((await POST(request({ action: "prepare", proposal: {}, actor: "forged" }))).status).toBe(400);
    expect((await GET(new Request(`https://awardping.com/api/admin/program-text-sources?id=${id}&id=${id}`))).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("bounds streamed bodies and redacts private validation failures", async () => {
    expect((await POST(request({ action: "prepare", proposal: { text: "x".repeat(256 * 1024) } }))).status).toBe(413);
    mocks.approve.mockRejectedValue(new Error("private storage secret")); const result = await POST(request({ action: "approve", id, expected_hash: hash }));
    expect(result.status).toBe(409); expect(await result.text()).not.toContain("secret");
  });
});
