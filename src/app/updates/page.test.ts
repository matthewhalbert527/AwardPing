import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { LiveUpdateItem } from "@/lib/live-updates";

const mocks = vi.hoisted(() => ({
  getLiveUpdateItems: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
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

import UpdatesPage from "@/app/updates/page";

const SOURCE_ID = "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60";
const CHANGE_ID = "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21";
const SECOND_CHANGE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const THIRD_CHANGE_ID = "9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b";

function makeUpdate(overrides: Partial<LiveUpdateItem> = {}): LiveUpdateItem {
  return {
    id: CHANGE_ID,
    awardId: "63298584-f2f8-41b7-87a8-7892af8b642a",
    awardName: "Barry Goldwater Scholarship",
    awardSlug: "goldwater-scholarship",
    sourceId: SOURCE_ID,
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

async function renderUpdatesPage(searchParams: { confirmed?: string; unsubscribed?: string } = {}) {
  return renderToStaticMarkup(await UpdatesPage({ searchParams: Promise.resolve(searchParams) }));
}

function awardLinks(html: string) {
  return [...html.matchAll(/<div class="public-live-update-title-row"><a href="([^"]*)">([^<]*)<\/a>/g)].map(
    (match) => ({ href: match[1].replace(/&amp;/g, "&"), label: match[2] }),
  );
}

describe("public updates page", () => {
  beforeEach(() => {
    mocks.getLiveUpdateItems.mockReset();
    mocks.hasSupabaseAdminConfig.mockReset();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
  });

  it("links every update to its canonical award page with the exact source and change", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([
      makeUpdate(),
      makeUpdate({
        id: SECOND_CHANGE_ID,
        awardId: "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
        awardName: "Truman Scholarship",
        awardSlug: "truman-scholarship",
        sourceId: null,
        sourceTitle: "Eligibility",
        sourceUrl: "https://truman.example/eligibility",
        sourcePageType: "eligibility",
        summary: "Eligibility language changed.",
        detectedAt: "2026-09-05T11:00:00.000Z",
      }),
      makeUpdate({
        id: THIRD_CHANGE_ID,
        awardId: "12345678-abcd-4ef0-9876-543210fedcba",
        awardName: "Example Award",
        awardSlug: null,
        sourceTitle: "Overview",
        sourceUrl: "https://example.example/overview",
        sourcePageType: "homepage",
        summary: "The overview changed.",
        detectedAt: "2026-09-04T11:00:00.000Z",
      }),
    ]);

    const html = await renderUpdatesPage();

    expect(mocks.getLiveUpdateItems).toHaveBeenCalledTimes(1);
    expect(mocks.getLiveUpdateItems).toHaveBeenCalledWith(80);
    expect(awardLinks(html)).toEqual([
      {
        href: `/goldwater-scholarship?source=${SOURCE_ID}&change=${CHANGE_ID}`,
        label: "Barry Goldwater Scholarship",
      },
      { href: `/truman-scholarship?change=${SECOND_CHANGE_ID}`, label: "Truman Scholarship" },
      {
        href: `/example-award-12345678?source=${SOURCE_ID}&change=${THIRD_CHANGE_ID}`,
        label: "Example Award",
      },
    ]);
    // Only the items the gated loader returned are rendered.
    expect(html.split('class="public-live-update-row"')).toHaveLength(4);
    // Every internal award link stays on this origin.
    for (const link of awardLinks(html)) {
      expect(new URL(link.href, "https://awardping.example/updates").origin).toBe(
        "https://awardping.example",
      );
    }
  });

  it("preserves the external official-source link and its accessible label", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([makeUpdate()]);

    const html = await renderUpdatesPage();

    expect(html).toContain(
      '<a class="public-live-update-source-link" href="https://goldwater.example/apply" rel="noreferrer" target="_blank" aria-label="Open Application Instructions">',
    );
    expect(html).toContain('aria-label="Live award updates"');
    expect(html).toContain("<h2>Latest source-page changes</h2>");
    expect(html).toContain(`<span class="badge">${pageTypeLabel("application")}</span>`);
  });

  it("keeps the subscription status messages", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([]);

    expect(await renderUpdatesPage({ confirmed: "1" })).toContain(
      "Your daily AwardPing updates are confirmed.",
    );
    expect(await renderUpdatesPage({ unsubscribed: "invalid" })).toContain(
      "That unsubscribe link is no longer valid.",
    );
  });

  it("shows the empty state and never loads updates without admin configuration", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const html = await renderUpdatesPage();

    expect(mocks.getLiveUpdateItems).not.toHaveBeenCalled();
    expect(html).toContain("No public changes are ready to show yet.");
    expect(html).not.toContain('class="public-live-update-row"');
  });
});
