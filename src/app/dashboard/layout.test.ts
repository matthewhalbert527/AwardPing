import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), profile: vi.fn(), office: vi.fn(), admin: vi.fn(), menu: vi.fn(), switcher: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.user, getUserProfile: mocks.profile, isSiteAdminEmail: mocks.admin,
}));
vi.mock("@/lib/offices", () => ({ getOfficeContext: mocks.office }));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => createElement("nav", { "aria-label": "Dashboard navigation" }) }));
vi.mock("@/components/profile-menu", () => ({ ProfileMenu: (props: unknown) => {
  mocks.menu(props); return createElement("div", { "data-profile-menu": "" });
} }));
vi.mock("@/components/office-switcher", () => ({ OfficeSwitcher: (props: unknown) => {
  mocks.switcher(props); return createElement("div", { "data-office-switcher": "" });
} }));

import DashboardLayout from "./layout";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const child = createElement("p", null, "Authorized page content");

describe("dashboard account loading", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.user.mockResolvedValue(null);
    mocks.profile.mockResolvedValue(null);
    mocks.office.mockResolvedValue(null);
    mocks.admin.mockReturnValue(false);
  });

  it("starts both account lookups after authentication without waiting for the profile first", async () => {
    const user = deferred<{ id: string; email: string } | null>();
    const profile = deferred<{ full_name: string } | null>();
    const office = deferred<null>();
    mocks.user.mockReturnValue(user.promise);
    mocks.profile.mockReturnValue(profile.promise);
    mocks.office.mockReturnValue(office.promise);

    const pending = DashboardLayout({ children: child });
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.office).not.toHaveBeenCalled();
    const account = { id: "owner-1", email: "owner@example.edu" };
    user.resolve(account);
    await Promise.resolve();
    expect(mocks.profile).toHaveBeenCalledExactlyOnceWith("owner-1");
    expect(mocks.office).toHaveBeenCalledExactlyOnceWith(account);

    let rendered = false;
    void pending.then(() => { rendered = true; });
    office.resolve(null);
    await Promise.resolve();
    expect(rendered).toBe(false);
    profile.resolve({ full_name: "Current Owner" });
    renderToStaticMarkup(await pending);
    expect(mocks.menu).toHaveBeenCalledWith({ email: "owner@example.edu", fullName: "Current Owner", showAdminLink: false });
  });

  it("does not load or show another account when there is no authenticated user", async () => {
    const $ = load(renderToStaticMarkup(await DashboardLayout({ children: child })));
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.office).not.toHaveBeenCalled();
    expect(mocks.menu).not.toHaveBeenCalled();
    expect(mocks.switcher).not.toHaveBeenCalled();
    expect($("[data-profile-menu], [data-office-switcher]")).toHaveLength(0);
  });

  it("preserves the current profile recovery warning, administrator menu and selected office", async () => {
    const account = { id: "owner-1", email: "owner@example.edu" };
    mocks.user.mockResolvedValue(account);
    mocks.profile.mockResolvedValue({ full_name: null, personal_data_reentry_required: true, personal_data_legacy_recovery_available: false });
    mocks.admin.mockReturnValue(true);
    mocks.office.mockResolvedValue({ current: { officeId: "office-b" }, memberships: [
      { officeId: "office-a", officeName: "Office A" }, { officeId: "office-b", officeName: "Office B" },
    ] });
    const $ = load(renderToStaticMarkup(await DashboardLayout({ children: child })));
    expect($("[role='status']").text()).toContain("Your saved profile could not be decrypted.");
    expect($("a[href='/dashboard/office#profile-settings']").text()).toBe("Restore profile");
    expect(mocks.menu).toHaveBeenCalledWith({ email: account.email, fullName: null, showAdminLink: true });
    expect(mocks.switcher).toHaveBeenCalledWith({ currentOfficeId: "office-b", offices: [
      { officeId: "office-a", officeName: "Office A" }, { officeId: "office-b", officeName: "Office B" },
    ] });
    expect($("main").text()).toContain("Authorized page content");
  });

  it("does not replace a failed fresh account lookup with stale account information", async () => {
    mocks.user.mockResolvedValue({ id: "owner-1" });
    mocks.profile.mockRejectedValue(new Error("Profile lookup unavailable"));
    await expect(DashboardLayout({ children: child })).rejects.toThrow("Profile lookup unavailable");
    expect(mocks.office).toHaveBeenCalledExactlyOnceWith({ id: "owner-1" });
    expect(mocks.menu).not.toHaveBeenCalled();
  });
});
