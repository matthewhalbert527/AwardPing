import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ redirect: vi.fn(() => { throw Error("next_redirect"); }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import AdminProgramFactsPage from "./page";

describe("retired manual award-details workflow", () => {
  it("redirects the existing bookmark to the authenticated alert review page", () => {
    expect(() => AdminProgramFactsPage()).toThrow("next_redirect");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/dashboard/admin/issues");
  });
});
