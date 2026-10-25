import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), isSiteAdminEmail: vi.fn(),
  loadProgramFactBatch: vi.fn(), loadProgramFactProposal: vi.fn(), saveProgramFactProposal: vi.fn(),
  prepareProgramFactProposal: vi.fn(), approveProgramFactProposal: vi.fn(), publishProgramFactBatch: vi.fn() }));
vi.mock("@/lib/auth", () => mocks);
vi.mock("@/lib/program-fact-review.server", () => mocks);
import { GET, POST } from "./route";
const id = "10000000-0000-4000-8000-000000000001", hash = "a".repeat(64);
const request = (body: unknown, origin: string | null = "https://awardping.com") => new Request("https://awardping.com/api/admin/program-facts", {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id, email: "admin@example.test" }); mocks.isSiteAdminEmail.mockReturnValue(true); });
describe("private 25-award fact review route", () => {
  it.each([GET, POST])("authenticates before any private service operation", async method => {
    mocks.getCurrentUser.mockResolvedValue(null);
    const response = await method(request({ action: "approve", id, expected_hash: hash }));
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.approveProgramFactProposal).not.toHaveBeenCalled(); expect(mocks.loadProgramFactBatch).not.toHaveBeenCalled();
  });
  it("denies a signed-in non-admin", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);
    expect((await POST(request({ action: "approve", id, expected_hash: hash }))).status).toBe(403);
    expect(mocks.approveProgramFactProposal).not.toHaveBeenCalled();
  });
  it.each([null, "https://attacker.test"])("denies mutations without exact same origin (%s)", async origin => {
    const response = await POST(request({ action: "approve", id, expected_hash: hash }, origin));
    expect(response.status).toBe(403); expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("returns one private saved review, not a bulk evidence dump", async () => {
    mocks.loadProgramFactProposal.mockResolvedValue({ id, review: {}, sources: [] });
    const response = await GET(new Request(`https://awardping.com/api/admin/program-facts?review=${id}`));
    expect(response.status).toBe(200); expect(mocks.loadProgramFactProposal).toHaveBeenCalledWith(id);
    expect(mocks.loadProgramFactBatch).not.toHaveBeenCalled();
  });
  it("rejects a malformed review identity before loading evidence", async () => {
    expect((await GET(new Request("https://awardping.com/api/admin/program-facts?review=any"))).status).toBe(400);
    expect(mocks.loadProgramFactProposal).not.toHaveBeenCalled();
  });
  it("approves only the exact hash with the authenticated reviewer identity", async () => {
    mocks.approveProgramFactProposal.mockResolvedValue({ id, status: "approved" });
    expect((await POST(request({ action: "approve", id, expected_hash: hash }))).status).toBe(200);
    expect(mocks.approveProgramFactProposal).toHaveBeenCalledWith(id, hash, id);
    expect(mocks.publishProgramFactBatch).not.toHaveBeenCalled();
  });
  it("saves or prepares a draft without approving it", async () => {
    expect((await POST(request({ action: "prepare", cohort: "gates_cambridge", cycle: "2027 entry" }))).status).toBe(200);
    expect(mocks.prepareProgramFactProposal).toHaveBeenCalledWith("gates_cambridge", "2027 entry", id);
    expect((await POST(request({ action: "save", review: { cohort_key: "gates_cambridge" } }))).status).toBe(200);
    expect(mocks.approveProgramFactProposal).not.toHaveBeenCalled(); expect(mocks.publishProgramFactBatch).not.toHaveBeenCalled();
  });
  it.each([{ action: "approve", id, expected_hash: hash, actor: "forged" }, { action: "publish", expected_revision: id, review_ids: {} },
    { action: "recover_all" }, { action: "approve", id }, { action: "prepare", cohort: "test", cycle: "" }])("rejects an incomplete/expanded action %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.approveProgramFactProposal).not.toHaveBeenCalled(); expect(mocks.publishProgramFactBatch).not.toHaveBeenCalled();
  });
  it("passes one exact 25-award version to atomic publication", async () => {
    const review_ids = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`award_${i}`, id]));
    expect((await POST(request({ action: "publish", expected_revision: id, review_ids }))).status).toBe(200);
    expect(mocks.publishProgramFactBatch).toHaveBeenCalledWith(id, review_ids, id);
  });
  it("returns a safe stale-validation error and does not hide it as success", async () => {
    mocks.approveProgramFactProposal.mockRejectedValue(new Error("private storage credentials"));
    const response = await POST(request({ action: "approve", id, expected_hash: hash }));
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("credentials");
  });
  it("bounds a streamed body even without Content-Length", async () => {
    const response = await POST(request({ action: "save", review: { text: "a".repeat(4 * 1024 * 1024) } }));
    expect(response.status).toBe(413); expect(mocks.saveProgramFactProposal).not.toHaveBeenCalled();
  });
  it("rejects non-JSON input before service work", async () => {
    const req = new Request("https://awardping.com/api/admin/program-facts", { method: "POST", headers: { origin: "https://awardping.com", "content-type": "text/plain" }, body: "{}" });
    expect((await POST(req)).status).toBe(400); expect(mocks.saveProgramFactProposal).not.toHaveBeenCalled();
  });
});
