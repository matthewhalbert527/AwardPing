import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), isAdmin: vi.fn(), load: vi.fn(), decide: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user, isSiteAdminEmail: mocks.isAdmin }));
vi.mock("@/lib/alert-review.server", () => ({ loadAlertReviews: mocks.load, decideAlertReview: mocks.decide }));
import { GET, POST } from "./route";

const actor = "10000000-0000-4000-8000-000000000001";
const input = { id: "20000000-0000-4000-8000-000000000002", expected_hash: "a".repeat(64), action: "approve" };
function post(value: unknown = input, origin: string | null = "https://awardping.com", extra: Record<string, string> = {}) {
  return new Request("https://awardping.com/api/admin/alert-reviews", { method: "POST", headers: {
    "content-type": "application/json", ...(origin === null ? {} : { origin }), ...extra,
  }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: actor, email: "admin@example.com" }); mocks.isAdmin.mockReturnValue(true);
  mocks.load.mockResolvedValue([]); mocks.decide.mockResolvedValue({ ok: true });
});
describe("minimal authenticated alert review endpoint", () => {
  it("returns only one requested status with private noncacheable responses", async () => {
    const response = await GET(new Request("https://awardping.com/api/admin/alert-reviews?status=dismissed"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ alerts: [] });
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("dismissed");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["?status=pending&status=approved", "?status=all", "?status=", "?actor=someone"])("rejects unsupported query %s", async query => {
    expect((await GET(new Request(`https://awardping.com/api/admin/alert-reviews${query}`))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([401, 403])("enforces administrator auth for list and decisions (%s)", async status => {
    if (status === 401) mocks.user.mockResolvedValue(null); else mocks.isAdmin.mockReturnValue(false);
    expect((await GET(new Request("https://awardping.com/api/admin/alert-reviews"))).status).toBe(status);
    expect((await POST(post())).status).toBe(status); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.decide).not.toHaveBeenCalled();
  });
  it.each([null, "null", "https://elsewhere.example", "https://awardping.com/"])("rejects invalid mutation origin %s", async origin => {
    const response = await POST(post(input, origin)); expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("passes exact preview hash and the authenticated actor, then confirms only the server result", async () => {
    const response = await POST(post()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(input, actor);
  });
  it.each([{ ...input, actor }, { ...input, details: {} }, { ...input, action: "publish" }, { ...input, expected_hash: "bad" }, { ...input, id: "bad" }])("rejects forged fields or invalid versions", async value => {
    expect((await POST(post(value))).status).toBe(400); expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("bounds actual body bytes even without content-length", async () => {
    expect((await POST(post(" ".repeat(4097)))).status).toBe(413);
    expect((await POST(post(input, "https://awardping.com", { "content-length": "4097" }))).status).toBe(413);
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("rejects non-JSON input and does not leak internal evidence errors", async () => {
    expect((await POST(post(input, "https://awardping.com", { "content-type": "text/plain" }))).status).toBe(400);
    mocks.decide.mockRejectedValue(Error("private-secret-object-key"));
    const response = await POST(post()); expect(response.status).toBe(409); expect(await response.text()).not.toContain("private-secret-object-key");
    mocks.load.mockRejectedValue(Error("private-secret-object-key"));
    const list = await GET(new Request("https://awardping.com/api/admin/alert-reviews")); expect(list.status).toBe(409); expect(await list.text()).not.toContain("private-secret-object-key");
  });
});
