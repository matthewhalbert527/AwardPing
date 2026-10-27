import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/program-variation-review.server", () => ({ loadPublishedVariationContext: mocks.load }));
import { GET } from "./route";

describe("public approved application routes", () => {
  beforeEach(() => { mocks.load.mockReset(); });
  const request = (query: string) => GET(new Request(`https://awardping.com/api/public/program-variations?${query}`));
  it("returns no draft inventory before the complete public release exists", async () => {
    mocks.load.mockResolvedValue(null);
    const response = await request("cohort=example");
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("passes one selected route and bounded filters to the pinned resolver", async () => {
    mocks.load.mockResolvedValue({ inventory_id: "approved", options: [], selected_scope_key: "uk", current: false });
    const response = await request("cohort=example&scope=uk&country=United+Kingdom&cursor=revision:uk");
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith("example", { scopeKey: "uk", country: "United Kingdom", cursor: "revision:uk", course: undefined, track: undefined });
    expect((await response.json()).current).toBe(false);
  });
  it.each(["cohort=example&scope=uk&scope=us", "cohort=example&country=x%0ay", "cohort=example&secret=x", "cohort=example&scope=../x", "cohort=example&country="])("rejects ambiguous input %s", async query => {
    expect((await request(query)).status).toBe(400); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("does not leak private resolver errors or fall back to a different scope", async () => {
    mocks.load.mockRejectedValue(new Error("private source evidence storage credential"));
    const response = await request("cohort=example&scope=unknown");
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("credential");
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
});
