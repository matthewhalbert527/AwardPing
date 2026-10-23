import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.auth }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
import { POST } from "./route";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("retired PDF-discovery review boundary", () => {
  it.each(["{}", "not JSON"])( "returns an invariant no-store 410 without authentication, queue or network I/O: %s", async body => {
    const network = vi.fn(() => { throw new Error("Unexpected network"); });
    vi.stubGlobal("fetch", network);
    const request = new Request("https://awardping.test/retired", { method: "POST", body });
    const response = await Reflect.apply(POST, undefined, [request, { params: Promise.resolve({ candidateId: "private-id" }) }]);
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    const result = await response.json();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("Existing");
    expect(result.error).toContain("no new review was queued");
    expect(result.error).not.toContain("private-id");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
