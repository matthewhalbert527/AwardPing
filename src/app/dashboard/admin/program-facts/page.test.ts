import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), adminConfig: vi.fn(), user: vi.fn(), admin: vi.fn(), batch: vi.fn(), board: vi.fn() }));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: mocks.config, hasSupabaseAdminConfig: mocks.adminConfig }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.user, isSiteAdminEmail: mocks.admin }));
vi.mock("@/lib/program-fact-review.server", () => ({ loadProgramFactBatch: mocks.batch }));
vi.mock("@/components/program-fact-review-board", () => ({ ProgramFactReviewBoard: mocks.board }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => "Setup required" }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children) }));
import AdminProgramFactsPage from "@/app/dashboard/admin/program-facts/page";

const data = { awards: [{ cohort_key: "synthetic" }], publication: { revision: "reviewed-version" } };
beforeEach(() => {
  vi.resetAllMocks(); mocks.config.mockReturnValue(true); mocks.adminConfig.mockReturnValue(true);
  mocks.user.mockResolvedValue({ email: "admin@example.org" }); mocks.admin.mockReturnValue(true);
  mocks.batch.mockResolvedValue(data); mocks.board.mockReturnValue("Private review board");
});
describe("current award details admin page", () => {
  it("is linked once from the existing authenticated admin hub, not a new public navigation", () => {
    const hub = readFileSync(new URL("../issues/page.tsx", import.meta.url), "utf8");
    expect(hub.match(/href="\/dashboard\/admin\/program-facts"/g)).toHaveLength(1);
    expect(hub).toMatch(/href="\/dashboard\/admin\/program-facts">[\s\S]*?Current award details[\s\S]*?<\/Link>/);
    expect(hub.indexOf("const user = await requireUser()")).toBeLessThan(hub.indexOf('href="/dashboard/admin/program-facts"'));
  });
  it("loads only after genuine authentication and admin authorization", async () => {
    const html = renderToStaticMarkup(await AdminProgramFactsPage());
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith("admin@example.org");
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.board.mock.calls[0][0]).toEqual({ initialAwards: data.awards, initialPublication: data.publication });
    expect(html).toContain("Private review board"); expect(html).toContain("/dashboard/admin/issues");
    expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]);
    expect(mocks.admin.mock.invocationCallOrder[0]).toBeLessThan(mocks.batch.mock.invocationCallOrder[0]);
  });
  it("does not load private data when client configuration is absent", async () => {
    mocks.config.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminProgramFactsPage())).toContain("Setup required");
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("preserves sign-in redirects before private data access", async () => {
    const redirect = new Error("sign_in_redirect"); mocks.user.mockRejectedValue(redirect);
    await expect(AdminProgramFactsPage()).rejects.toBe(redirect);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("denies non-admins without loading private batch or service configuration", async () => {
    mocks.admin.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminProgramFactsPage())).toContain("limited to AwardPing site admins");
    expect(mocks.adminConfig).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled(); expect(mocks.board).not.toHaveBeenCalled();
  });
  it("does not create false review data when service configuration is unavailable", async () => {
    mocks.adminConfig.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminProgramFactsPage())).toContain("service-role access is not configured");
    expect(mocks.batch).not.toHaveBeenCalled(); expect(mocks.board).not.toHaveBeenCalled();
  });
  it("fails closed without leaking internal details or rendering fake approvals", async () => {
    mocks.batch.mockRejectedValue(new Error("private database credential and internal exception"));
    const html = renderToStaticMarkup(await AdminProgramFactsPage());
    expect(html).toContain('role="alert"'); expect(html).toContain("No approvals or public details were changed");
    expect(html).not.toContain("private database"); expect(mocks.board).not.toHaveBeenCalled();
  });
});
