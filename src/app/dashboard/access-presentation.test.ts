import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: vi.fn(), hasSupabaseAdminConfig: vi.fn(),
  requireUser: vi.fn(), isSiteAdminEmail: vi.fn(),
  requireOfficeContext: vi.fn(), canManageOffice: vi.fn(),
  createAdmin: vi.fn(), createServer: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  appConfig: { adminEmails: ["admin@example.test"] },
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, isSiteAdminEmail: mocks.isSiteAdminEmail }));
vi.mock("@/lib/offices", () => ({ requireOfficeContext: mocks.requireOfficeContext, canManageOffice: mocks.canManageOffice }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createServer }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => createElement("p", null, "Setup unavailable") }));
vi.mock("@/components/admin-source-intake-panel", () => ({ AdminSourceIntakePanel: () => createElement("p", null, "Private source controls") }));

import OpsPage from "./ops/page";
import AdminSourceIntakePage from "./admin/source-intake/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasSupabaseConfig.mockReturnValue(true);
  mocks.hasSupabaseAdminConfig.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ id: "test-user", email: "test@example.test" });
  mocks.isSiteAdminEmail.mockReturnValue(false);
  mocks.canManageOffice.mockReturnValue(true);
  mocks.requireOfficeContext.mockResolvedValue({ current: { officeId: "test-office", role: "owner" } });
  mocks.createAdmin.mockImplementation(() => { throw new Error("Unexpected database access"); });
  mocks.createServer.mockImplementation(() => { throw new Error("Unexpected database access"); });
});

describe.each([
  { name: "monitoring", page: OpsPage, title: "Monitoring health", titleClass: "dashboard-page-title" },
  { name: "source intake", page: AdminSourceIntakePage, title: "Source intake", titleClass: "admin-page-title" },
])("compact $name access states", ({ page, title, titleClass }) => {
  it("keeps one clear heading and blocks non-admins before any data access", async () => {
    const $ = load(renderToStaticMarkup(await page()));
    expect($("h1")).toHaveLength(1);
    expect($("h1").text()).toBe(title);
    expect($("h1").attr("class")).toBe(titleClass);
    expect($(".badge")).toHaveLength(0);
    expect($("body").text()).toMatch(/site admin/);
    expect($("body").text()).not.toContain("Private source controls");
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.requireOfficeContext).not.toHaveBeenCalled();
  });

  it("keeps the missing server-configuration warning for authorized admins", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);
    const $ = load(renderToStaticMarkup(await page()));
    expect($("h1").text()).toBe(title);
    expect($("body").text()).toContain("not configured");
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it("still requires sign-in before showing operational data", async () => {
    mocks.requireUser.mockRejectedValue(new Error("authentication required"));
    await expect(page()).rejects.toThrow("authentication required");
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});

it("keeps the separate office-owner/admin requirement for monitoring", async () => {
  mocks.isSiteAdminEmail.mockReturnValue(true);
  mocks.canManageOffice.mockReturnValue(false);
  const $ = load(renderToStaticMarkup(await OpsPage()));
  expect($("h1").text()).toBe("Monitoring health");
  expect($("body").text()).toContain("office owners and admins");
  expect(mocks.createAdmin).not.toHaveBeenCalled();
  expect(mocks.createServer).not.toHaveBeenCalled();
});
