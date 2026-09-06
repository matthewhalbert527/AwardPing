import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdateItem } from "@/lib/live-updates";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getLiveUpdateItems: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/live-updates", () => ({
  getLiveUpdateItems: mocks.getLiveUpdateItems,
}));
// The config module imports "server-only", which cannot load under vitest,
// so the page tree gets exactly the export it uses.
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: () => null,
}));

import Home from "@/app/page";

const SOURCE_IDS = [
  "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60",
  "5d7c9b1a-3e2f-4a6b-9c8d-7e6f5a4b3c2d",
  "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
  "9c8d7e6f-5a4b-4c3d-9e2f-1a0b9c8d7e6f",
];
const CHANGE_IDS = [
  "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21",
  "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b",
  "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a",
  "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
];

function makeUpdate(overrides: Partial<LiveUpdateItem> = {}): LiveUpdateItem {
  return {
    id: CHANGE_IDS[0],
    awardId: "63298584-f2f8-41b7-87a8-7892af8b642a",
    awardName: "Barry Goldwater Scholarship",
    awardSlug: "goldwater-scholarship",
    sourceId: SOURCE_IDS[0],
    sourceTitle: "Application Instructions",
    sourceUrl: "https://goldwater.example/apply",
    sourcePageType: "application",
    summary: "The application deadline moved to January 30.",
    changeDetails: {},
    detectedAt: "2026-09-05T12:00:00.000Z",
    detectedLabel: "2h ago",
    changeTypeLabel: "Deadline",
    ...overrides,
  };
}

// Six eligible items: the preview shows the first five.
const feedItems: LiveUpdateItem[] = [
  makeUpdate(),
  makeUpdate({
    id: CHANGE_IDS[1],
    awardId: "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
    awardName: "Truman Scholarship",
    awardSlug: "truman-scholarship",
    sourceId: null,
    sourceTitle: "Eligibility",
    sourceUrl: "https://truman.example/eligibility",
    summary: "Eligibility language changed.",
  }),
  makeUpdate({
    id: CHANGE_IDS[2],
    awardId: "12345678-abcd-4ef0-9876-543210fedcba",
    awardName: "Example Award",
    awardSlug: null,
    sourceId: SOURCE_IDS[1],
    sourceTitle: "Overview",
    sourceUrl: "https://example.example/overview",
    summary: "The overview changed.",
  }),
  makeUpdate({
    id: CHANGE_IDS[3],
    awardId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    awardName: "Rhodes Scholarship",
    awardSlug: "rhodes-scholarship",
    sourceId: SOURCE_IDS[2],
    sourceTitle: "Deadlines",
    sourceUrl: "https://rhodes.example/deadlines",
    summary: "The deadline list changed.",
  }),
  makeUpdate({
    id: CHANGE_IDS[4],
    awardId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
    awardName: "Marshall Scholarship",
    awardSlug: "marshall-scholarship",
    sourceId: SOURCE_IDS[3],
    sourceTitle: "Application",
    sourceUrl: "https://marshall.example/apply",
    summary: "The application portal changed.",
  }),
  makeUpdate({
    id: CHANGE_IDS[5],
    awardId: "8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
    awardName: "Sixth Award Not Previewed",
    awardSlug: "sixth-award",
    sourceId: SOURCE_IDS[0],
    summary: "A sixth change.",
  }),
];

async function renderHome() {
  return renderToStaticMarkup(await Home());
}

function previewLinks(html: string) {
  return [...html.matchAll(/<a class="home-live-terminal-row" href="([^"]*)">/g)].map((match) =>
    match[1].replace(/&amp;/g, "&"),
  );
}

describe("homepage live update preview", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getLiveUpdateItems.mockResolvedValue(feedItems);
  });

  it("links each of the five preview rows to the canonical award path with the exact source and change", async () => {
    const html = await renderHome();

    expect(mocks.getLiveUpdateItems).toHaveBeenCalledTimes(1);
    expect(mocks.getLiveUpdateItems).toHaveBeenCalledWith(8);
    expect(previewLinks(html)).toEqual([
      `/goldwater-scholarship?source=${SOURCE_IDS[0]}&change=${CHANGE_IDS[0]}`,
      `/truman-scholarship?change=${CHANGE_IDS[1]}`,
      `/example-award-12345678?source=${SOURCE_IDS[1]}&change=${CHANGE_IDS[2]}`,
      `/rhodes-scholarship?source=${SOURCE_IDS[2]}&change=${CHANGE_IDS[3]}`,
      `/marshall-scholarship?source=${SOURCE_IDS[3]}&change=${CHANGE_IDS[4]}`,
    ]);
    // A bare award path (the previous behavior) is never emitted for a row.
    for (const href of previewLinks(html)) {
      expect(href).toMatch(/\?(source=[^&]+&)?change=[0-9a-f-]{36}$/);
      expect(new URL(href, "https://awardping.example/").origin).toBe("https://awardping.example");
    }
    expect(html).not.toContain('href="/goldwater-scholarship"');
    expect(html).not.toContain("Sixth Award Not Previewed");
    expect(html).toContain("<strong>Barry Goldwater Scholarship</strong>");
    expect(html).toContain('aria-label="Live award update preview"');
    expect(html).toContain('<a class="home-live-terminal-footer" href="/updates">');
  });

  it("keeps the anonymous and signed-in calls to action", async () => {
    const anonymous = await renderHome();
    expect(anonymous).toContain('<a class="button-primary" href="/contact">Get in touch');

    mocks.getCurrentUser.mockResolvedValue({ id: "user-1", email: "person@example.edu" });
    const signedIn = await renderHome();
    expect(signedIn).toContain('<a class="button-primary" href="/updates">Updates');
    expect(previewLinks(signedIn)).toEqual(previewLinks(anonymous));
  });

  it("shows the empty preview and never loads updates without admin configuration", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const html = await renderHome();

    expect(mocks.getLiveUpdateItems).not.toHaveBeenCalled();
    expect(html).toContain("Live update data will appear after the next scan.");
    expect(previewLinks(html)).toEqual([]);
  });
});
