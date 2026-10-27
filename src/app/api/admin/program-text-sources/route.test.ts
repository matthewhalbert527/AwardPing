import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), admin: vi.fn(), prepare: vi.fn(), approve: vi.fn(), revoke: vi.fn(), load: vi.fn(), inspectPappg: vi.fn(), preparePappg: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user, isSiteAdminEmail: mocks.admin }));
vi.mock("@/lib/program-text-source-approval.server", () => ({ prepareProgramTextSource: mocks.prepare, approveProgramTextSource: mocks.approve, revokeProgramTextSource: mocks.revoke, loadProgramTextSourcePending: mocks.load,
  inspectProgramTextPappgCanonical: mocks.inspectPappg, prepareProgramTextPappgCanonical: mocks.preparePappg }));
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

describe("finite PAPPG catalogue route", () => {
  const inspectionUrl="https://awardping.com/api/admin/program-text-sources?inspection=pappg";
  const proposal={id,source:{id:"de868fe8-54ba-4fa0-8210-b27c8f182112",shared_award_id:"d955a846-cee1-4c01-932e-e3cb7215f3fb",url:"https://www.nsf.gov/policies/pappg"}};
  const catalogue_disposition={schema:"awardping.program-text-pappg-canonical-disposition.v1",context_hash:hash,context:{preserved_records:[]},reason:"Explicitly reviewed finite catalogue disposition for the selected NSF source."};
  it("denies anonymous inspection before any helper and preserves private no-store headers",async()=>{
    mocks.user.mockResolvedValue(null);const result=await GET(new Request(inspectionUrl));
    expect(result.status).toBe(401);expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.inspectPappg).not.toHaveBeenCalled();expect(mocks.load).not.toHaveBeenCalled();
  });
  it("returns admin inspection only for the explicit finite query without mutation",async()=>{
    const value={schema:"awardping.program-text-pappg-canonical-inspection.v1",context:{preserved_records:[]},context_hash:hash};
    mocks.inspectPappg.mockResolvedValue(value);const result=await GET(new Request(inspectionUrl));
    expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");expect(await result.json()).toEqual(value);
    expect(mocks.inspectPappg).toHaveBeenCalledExactlyOnceWith();expect(mocks.preparePappg).not.toHaveBeenCalled();expect(mocks.approve).not.toHaveBeenCalled();
  });
  it.each(["?inspection=pappg&inspection=pappg",`?inspection=pappg&id=${id}`,"?inspection=other","?inspection=pappg&actor=forged"])("rejects ambiguous/arbitrary inspection %s",async query=>{
    expect((await GET(new Request("https://awardping.com/api/admin/program-text-sources"+query))).status).toBe(400);
    expect(mocks.inspectPappg).not.toHaveBeenCalled();
  });
  it.each([null,"https://attacker.test"])("keeps finite preparation same-origin with origin %s",async origin=>{
    const result=await POST(request({action:"prepare_pappg_canonical",proposal,catalogue_disposition},origin));
    expect(result.status).toBe(403);expect(mocks.preparePappg).not.toHaveBeenCalled();
  });
  it("binds the exact finite preparation body to the authenticated actor",async()=>{
    mocks.preparePappg.mockResolvedValue({id});const result=await POST(request({action:"prepare_pappg_canonical",proposal,catalogue_disposition}));
    expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true,result:{id}});
    expect(mocks.preparePappg).toHaveBeenCalledExactlyOnceWith(proposal,catalogue_disposition,id);expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each([
    {action:"prepare_pappg_canonical",proposal,catalogue_disposition,actor:"forged"},
    {action:"prepare_pappg_canonical",proposal,catalogue_disposition,target_ref:{}},
    {action:"prepare_pappg_canonical",proposal},
    {action:"prepare_pappg_canonical",proposal,catalogue_disposition:[]},
    {action:"prepare_pappg_canonical",proposal:[],catalogue_disposition},
  ])("rejects missing evidence or client-supplied authority %#",async value=>{
    expect((await POST(request(value))).status).toBe(400);expect(mocks.preparePappg).not.toHaveBeenCalled();
  });
  it("redacts private inspection failures",async()=>{
    mocks.inspectPappg.mockRejectedValue(new Error("private database proof/raw secret"));const result=await GET(new Request(inspectionUrl));
    expect(result.status).toBe(409);expect(await result.text()).not.toMatch(/database|raw secret/);
  });
});
