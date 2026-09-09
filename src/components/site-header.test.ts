import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserProfile: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  profileMenu: vi.fn(),
}));
const route = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getUserProfile: mocks.getUserProfile,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
// Render the real primary navigation so removing the duplicate shortcut cannot
// accidentally remove the only Updates destination. Profile-menu interactions
// are covered separately; here its auth-derived props remain under test.
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/components/profile-menu", () => ({
  ProfileMenu: (props: Record<string, unknown>) => {
    mocks.profileMenu(props);
    return createElement("div", { "data-profile-menu": "" });
  },
}));

import { SiteHeader } from "@/components/site-header";

async function renderHeader() {
  return renderToStaticMarkup(await SiteHeader());
}

const COMPACT_SHELL =
  '<header class="app-header"><div class="app-header-shell"><div class="app-header-bar"><a class="brand-link app-header-brand" aria-label="AwardPing home" href="/">';

describe("SiteHeader", () => {
  beforeEach(() => {
    route.pathname = "/";
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getUserProfile.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
  });

  it("offers anonymous visitors Log in and Find awards, with no contact action", async () => {
    const html = await renderHeader();

    expect(html.startsWith(COMPACT_SHELL)).toBe(true);
    const $ = load(html);
    expect($('nav[aria-label="Primary navigation"] a[href="/updates"]')).toHaveLength(1);
    expect($('a[href="/updates"]')).toHaveLength(1);
    expect(html).toContain(
      '<div class="app-header-actions"><a class="button-secondary" href="/login">Log in</a><a class="button-primary" href="/award-directory">Find awards</a></div>',
    );
    expect(html).not.toContain("/contact");
    expect(html).not.toContain("Get in touch");
    expect(html).not.toContain("data-profile-menu");
    expect(mocks.getUserProfile).not.toHaveBeenCalled();
    expect(mocks.profileMenu).not.toHaveBeenCalled();
  });

  it("keeps the profile menu without a second signed-in Updates shortcut", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getUserProfile.mockResolvedValue({ full_name: "Pat Example" });

    const html = await renderHeader();

    expect(html.startsWith(COMPACT_SHELL)).toBe(true);
    const $ = load(html);
    expect($('a[href="/updates"]')).toHaveLength(1);
    expect($('nav[aria-label="Primary navigation"] a[href="/updates"]').text()).toBe("Updates");
    expect($(".app-header-actions").children()).toHaveLength(1);
    expect($(".app-header-actions > [data-profile-menu]")).toHaveLength(1);
    expect($(".app-header-actions a")).toHaveLength(0);
    expect(html).not.toContain("Find awards");
    expect(html).not.toContain("Log in");
    expect(html).not.toContain("/contact");
    expect(mocks.getUserProfile).toHaveBeenCalledWith("user-1");
    expect(mocks.isSiteAdminEmail).toHaveBeenCalledWith("person@example.edu");
    expect(mocks.profileMenu).toHaveBeenCalledTimes(1);
    expect(mocks.profileMenu.mock.calls[0][0]).toEqual({
      email: "person@example.edu",
      fullName: "Pat Example",
      showAdminLink: false,
    });
  });

  it.each(["/updates", "/updates/example", "/award-directory", "/beinecke-scholarship"])(
    "retains one primary Updates destination on %s for signed-in visitors",
    async (pathname) => {
      route.pathname = pathname;
      mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });

      const $ = load(await renderHeader());
      const updates = $('nav[aria-label="Primary navigation"] a[href="/updates"]');

      expect($('a[href="/updates"]')).toHaveLength(1);
      expect(updates).toHaveLength(1);
      expect(updates.text()).toBe("Updates");
      expect(updates.attr("aria-current")).toBe(pathname.startsWith("/updates") ? "page" : undefined);
      expect($('nav[aria-label="Primary navigation"] a[href="/award-directory"]')).toHaveLength(1);
      expect($(".app-header-actions a")).toHaveLength(0);
      expect($('button[aria-controls="site-header-menu"]').attr("aria-expanded")).toBe("false");
      expect($('[data-profile-menu]')).toHaveLength(1);
    },
  );

  it("passes the admin flag through for site admins", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-2", email: "admin@example.edu" });
    mocks.isSiteAdminEmail.mockReturnValue(true);

    await renderHeader();

    expect(mocks.profileMenu.mock.calls[0][0]).toMatchObject({ showAdminLink: true });
  });

  it("keeps exactly one actions group and the same compact structure in both states", async () => {
    const anonymous = await renderHeader();
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    const signedIn = await renderHeader();

    for (const html of [anonymous, signedIn]) {
      expect(html.split('class="app-header-actions"')).toHaveLength(2);
      expect(html.split("<header ")).toHaveLength(2);
      expect(html.endsWith("</div></div></div></header>")).toBe(true);
    }
  });
});
