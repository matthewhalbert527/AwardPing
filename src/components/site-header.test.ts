import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserProfile: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  profileMenu: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getUserProfile: mocks.getUserProfile,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
// Client-only pieces: the primary navigation reads the pathname and the
// profile menu manages its own open state; the header's own markup is what is
// under test here.
vi.mock("@/components/site-header-nav", () => ({
  SiteHeaderNav: () => createElement("nav", { "data-site-header-nav": "" }),
}));
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
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.getUserProfile.mockResolvedValue(null);
    mocks.isSiteAdminEmail.mockReturnValue(false);
  });

  it("offers anonymous visitors Log in and Find awards, with no contact action", async () => {
    const html = await renderHeader();

    expect(html.startsWith(COMPACT_SHELL)).toBe(true);
    expect(html).toContain('<nav data-site-header-nav=""></nav>');
    expect(html).toContain(
      '<div class="app-header-actions"><a class="button-secondary" href="/login">Log in</a><a class="button-primary" href="/award-directory">Find awards</a></div>',
    );
    expect(html).not.toContain("/contact");
    expect(html).not.toContain("Get in touch");
    expect(html).not.toContain("data-profile-menu");
    expect(mocks.getUserProfile).not.toHaveBeenCalled();
    expect(mocks.profileMenu).not.toHaveBeenCalled();
  });

  it("offers signed-in visitors their updates and the profile menu, unchanged", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    mocks.getUserProfile.mockResolvedValue({ full_name: "Pat Example" });

    const html = await renderHeader();

    expect(html.startsWith(COMPACT_SHELL)).toBe(true);
    expect(html).toContain('<div class="app-header-actions"><a class="button-secondary" href="/updates">');
    expect(html).toContain("Updates</a>");
    expect(html).toContain('<div data-profile-menu=""></div></div>');
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
