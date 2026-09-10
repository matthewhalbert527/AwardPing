import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseConfig: vi.fn(),
  requireUser: vi.fn(),
  getOnboardingStatus: vi.fn(),
  canManageOffice: vi.fn(),
  redirect: vi.fn(),
  profileForm: vi.fn(),
  officeForm: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ hasSupabaseConfig: mocks.hasSupabaseConfig }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/onboarding", () => ({ getOnboardingStatus: mocks.getOnboardingStatus }));
vi.mock("@/lib/offices", () => ({ canManageOffice: mocks.canManageOffice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => createElement("p", null, "Setup unavailable") }));
vi.mock("@/components/office-forms", () => ({
  ProfileSettingsForm: (props: unknown) => {
    mocks.profileForm(props);
    return createElement("section", { id: "profile-settings" }, createElement("h2", null, "Profile"));
  },
  OfficeNameForm: (props: unknown) => {
    mocks.officeForm(props);
    return createElement("section", { id: "office-settings" }, createElement("h2", null, "Office name"));
  },
}));

import OnboardingPage from "./page";

const profile = {
  full_name: "Test Advisor", organization: "Test University",
  personal_data_reentry_required: true, personal_data_legacy_recovery_available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasSupabaseConfig.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ id: "test-user" });
  mocks.canManageOffice.mockReturnValue(true);
  mocks.getOnboardingStatus.mockResolvedValue({
    isComplete: false, needsProfile: true, needsOffice: true, profile,
    officeContext: { current: { role: "owner", officeName: "Fellowships" } },
  });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe("simple account setup", () => {
  it("shows the incomplete forms directly without duplicate progress cards", async () => {
    const $ = load(renderToStaticMarkup(await OnboardingPage()));
    expect($("h1").text()).toBe("Finish setup");
    expect($("h1").attr("class")).toBe("dashboard-page-title");
    expect($("h2").map((_, el) => $(el).text()).get()).toEqual(["Profile", "Office name"]);
    expect($("body").text()).not.toContain("Watchlist");
    expect(mocks.profileForm).toHaveBeenCalledWith({
      initialFullName: profile.full_name, initialOrganization: profile.organization,
      reentryRequired: true, legacyRecoveryAvailable: true,
    });
    expect(mocks.officeForm).toHaveBeenCalledWith({ initialName: "Fellowships" });
  });

  it("keeps owner action guidance when a member cannot name the office", async () => {
    mocks.canManageOffice.mockReturnValue(false);
    const $ = load(renderToStaticMarkup(await OnboardingPage()));
    expect($("body").text()).toContain("Ask an office owner or admin to name this workspace before continuing.");
    expect(mocks.officeForm).not.toHaveBeenCalled();
    expect(mocks.profileForm).toHaveBeenCalledOnce();
  });

  it("does not repeat completed profile or office forms", async () => {
    mocks.getOnboardingStatus.mockResolvedValue({
      isComplete: false, needsProfile: false, needsOffice: false, profile,
      officeContext: { current: { role: "owner", officeName: "Fellowships" } },
    });
    const $ = load(renderToStaticMarkup(await OnboardingPage()));
    expect($('a[href="/updates"]').text()).toBe("Open updates");
    expect(mocks.profileForm).not.toHaveBeenCalled();
    expect(mocks.officeForm).not.toHaveBeenCalled();
  });

  it("still redirects completed setup to the updates feed", async () => {
    mocks.getOnboardingStatus.mockResolvedValue({ isComplete: true });
    await expect(OnboardingPage()).rejects.toThrow("redirect:/updates");
  });

  it("still requires authentication before loading setup status", async () => {
    mocks.requireUser.mockRejectedValue(new Error("authentication required"));
    await expect(OnboardingPage()).rejects.toThrow("authentication required");
    expect(mocks.getOnboardingStatus).not.toHaveBeenCalled();
  });

  it("keeps the deployment setup notice without querying account information", async () => {
    mocks.hasSupabaseConfig.mockReturnValue(false);
    expect(renderToStaticMarkup(await OnboardingPage())).toContain("Setup unavailable");
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStatus).not.toHaveBeenCalled();
  });
});
