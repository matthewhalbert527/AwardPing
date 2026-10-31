import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), adminConfig: vi.fn(), user: vi.fn(), admin: vi.fn(), load: vi.fn(), board: vi.fn() }));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: mocks.config, hasSupabaseAdminConfig: mocks.adminConfig }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.user, isSiteAdminEmail: mocks.admin }));
vi.mock("@/lib/alert-review.server", () => ({ loadAlertReviews: mocks.load }));
vi.mock("@/lib/alert-reviews.server", () => ({ loadAlertReviews: mocks.load }));
vi.mock("@/lib/alert-groups.server", () => ({ loadAlertReviewBoard: mocks.load }));
vi.mock("@/components/admin-alert-review-board", () => ({ AdminAlertReviewBoard: mocks.board }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => "Setup required" }));
import AdminAlertReviewsPage from "@/app/dashboard/admin/issues/page";

const alerts = [{ id: "synthetic-proposed-change" }];
beforeEach(() => {
  vi.resetAllMocks(); mocks.config.mockReturnValue(true); mocks.adminConfig.mockReturnValue(true);
  mocks.user.mockResolvedValue({ email: "admin@example.org" }); mocks.admin.mockReturnValue(true);
  mocks.load.mockResolvedValue({ alerts, mergeOptions: [] }); mocks.board.mockReturnValue("Proposed alert review board");
});

describe("minimal outgoing alert review page", () => {
  it("loads only pending alerts after authenticating and authorizing the owner", async () => {
    const html = renderToStaticMarkup(await AdminAlertReviewsPage());
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith("admin@example.org");
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("pending");
    expect(mocks.board.mock.calls[0][0]).toEqual({ initialAlerts: alerts, initialMergeOptions: [], initialStatus: "pending" });
    expect(html).toContain("Proposed alert review board");
    expect(mocks.user.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]);
    expect(mocks.admin.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
  });
  it("renders setup without loading private data when client configuration is absent", async () => {
    mocks.config.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminAlertReviewsPage())).toContain("Setup required");
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("preserves a genuine sign-in redirect before any service access", async () => {
    const redirect = Error("sign_in_redirect"); mocks.user.mockRejectedValue(redirect);
    await expect(AdminAlertReviewsPage()).rejects.toBe(redirect);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.adminConfig).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("does not load private alerts or inspect service config for non-admins", async () => {
    mocks.admin.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminAlertReviewsPage())).toContain("limited to AwardPing site admins");
    expect(mocks.adminConfig).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.board).not.toHaveBeenCalled();
  });
  it("does not invent an empty queue when the admin service is not configured", async () => {
    mocks.adminConfig.mockReturnValue(false);
    expect(renderToStaticMarkup(await AdminAlertReviewsPage())).toContain("Alert review is unavailable");
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.board).not.toHaveBeenCalled();
  });
  it("shows a clear load error without leaking internals or claiming all alerts are reviewed", async () => {
    mocks.load.mockRejectedValue(Error("private object key and database credential"));
    const html = renderToStaticMarkup(await AdminAlertReviewsPage());
    expect(html).toContain('role="alert"'); expect(html).toContain("No decisions changed");
    expect(html).not.toContain("private object"); expect(html).not.toContain("No alerts waiting"); expect(mocks.board).not.toHaveBeenCalled();
  });
  it("keeps operations, provider inventories and retired factual approval boards out of the page dependency tree", () => {
    const source = readFileSync(new URL("../app/dashboard/admin/issues/page.tsx", import.meta.url), "utf8");
    for (const retired of ["loadAdminRegressionAuditFailures", "loadProgramFactBatch", "ProgramFactReviewBoard", "AdminOperationsBoard", "loadQuarantine", "Promise.all", "source-intake", "program-facts", "createSupabaseAdminClient"]) {
      expect(source).not.toContain(retired);
    }
    expect(source).toContain('loadAlertReviewBoard("pending")'); expect(source).toContain('initialStatus="pending"');
  });
});
