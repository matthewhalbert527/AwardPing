import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PublicDigestStatusParams } from "@/lib/public-digest-copy";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
vi.mock("@/lib/public-update-feed", () => ({
  loadPublicUpdateFeed: async () => ({ status: "empty" }),
  publicUpdateFeedNotice: () => "No public updates in this fixture.",
}));

import Home from "@/app/page";
import UpdatesPage from "@/app/updates/page";
import UpdatesSubscribePage, { metadata } from "@/app/updates/subscribe/page";

async function renderSubscribe(params: PublicDigestStatusParams = {}) {
  return renderToStaticMarkup(await UpdatesSubscribePage({ searchParams: Promise.resolve(params) }));
}

describe("public daily digest pages", () => {
  it("names the same feature on home, feed, signup and metadata", async () => {
    const home = renderToStaticMarkup(await Home());
    const feed = renderToStaticMarkup(await UpdatesPage({ searchParams: Promise.resolve({}) }));
    const signup = await renderSubscribe();
    expect(metadata.title).toBe("Daily digest | AwardPing");
    for (const html of [home, feed, signup]) expect(html).toContain("Daily digest");
    for (const html of [home, feed]) expect(html).toContain('href="/updates/subscribe"');
    for (const html of [feed, signup]) {
      expect(html).toContain("Get a daily email when useful changes appear on official award pages. Quiet days stay quiet.");
    }
    expect(signup).toContain("Confirm your email before the digest starts");
    expect(signup).not.toContain("Double opt-in");
  });

  it.each<PublicDigestStatusParams>([
    { confirmed: "1" }, { confirmed: "invalid" }, { unsubscribed: "1" },
    { unsubscribed: "retry" }, { unsubscribed: "invalid" },
  ])("shows the same single accessible redirect notice on both pages for %j", async (params) => {
    const feed = renderToStaticMarkup(await UpdatesPage({ searchParams: Promise.resolve(params) }));
    const signup = await renderSubscribe(params);
    const notices = (html: string) => [...html.matchAll(/<div role="status"[^>]*>([^<]+)<\/div>/g)].map((match) => match[1]);
    expect(notices(feed)).toHaveLength(1);
    expect(notices(signup)).toEqual(notices(feed));
  });

  it("does not add a success notice for unknown status and preserves the real form and consent", async () => {
    const html = await renderSubscribe({ confirmed: "unexpected" });
    expect(html).not.toContain('<div role="status"');
    expect(html).toContain('id="public-updates-email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("I agree to receive AwardPing public update emails");
    expect(html).toContain('id="public-updates-website"');
    expect(html).toContain("Subscribe");
  });
});
