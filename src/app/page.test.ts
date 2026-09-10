import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdateItem } from "@/lib/live-updates";
import { describeDetectedAt, formatCentralDateTime } from "@/lib/time-zone";

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
import UpdatesPage from "@/app/updates/page";

// Sep 5, 2026, 9:00 AM CDT: the page reads the clock once per render.
const FIXED_NOW = new Date("2026-09-05T14:00:00.000Z");

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

type FeedSeed = Omit<LiveUpdateItem, "detectedDateTime" | "detectedLabel" | "detectedTitle">;

function makeSeed(overrides: Partial<FeedSeed> = {}): FeedSeed {
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
    changeTypeLabel: "Deadline",
    ...overrides,
  };
}

// Six eligible items: the preview shows the first five.
const feedSeeds: FeedSeed[] = [
  makeSeed(),
  makeSeed({
    id: CHANGE_IDS[1],
    awardId: "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
    awardName: "Truman Scholarship",
    awardSlug: "truman-scholarship",
    sourceId: null,
    sourceTitle: "Eligibility",
    sourceUrl: "https://truman.example/eligibility",
    summary: "Eligibility language changed.",
    detectedAt: "2026-09-05T13:59:30.000Z",
  }),
  makeSeed({
    id: CHANGE_IDS[2],
    awardId: "12345678-abcd-4ef0-9876-543210fedcba",
    awardName: "Example Award",
    awardSlug: null,
    sourceId: SOURCE_IDS[1],
    sourceTitle: "Overview",
    sourceUrl: "https://example.example/overview",
    summary: "The overview changed.",
    detectedAt: "2026-09-02T14:00:00.000Z",
  }),
  makeSeed({
    id: CHANGE_IDS[3],
    awardId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    awardName: "Rhodes Scholarship",
    awardSlug: "rhodes-scholarship",
    sourceId: SOURCE_IDS[2],
    sourceTitle: "Deadlines",
    sourceUrl: "https://rhodes.example/deadlines",
    summary: "The deadline list changed.",
    detectedAt: "2026-08-01T15:00:00.000Z",
  }),
  makeSeed({
    id: CHANGE_IDS[4],
    awardId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
    awardName: "Marshall Scholarship",
    awardSlug: "marshall-scholarship",
    sourceId: SOURCE_IDS[3],
    sourceTitle: "Application",
    sourceUrl: "https://marshall.example/apply",
    summary: "The application portal changed.",
    detectedAt: "2025-12-20T15:00:00.000Z",
  }),
  makeSeed({
    id: CHANGE_IDS[5],
    awardId: "8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e",
    awardName: "Sixth Award Not Previewed",
    awardSlug: "sixth-award",
    sourceId: SOURCE_IDS[0],
    summary: "A sixth change.",
  }),
];

// Stands in for the real loader: labels come from the shared helper and the
// `now` the page hands over, exactly as the production loader computes them.
function loaderResult(seeds: FeedSeed[], now: Date): LiveUpdateItem[] {
  return seeds.map((seed) => {
    const detected = describeDetectedAt(seed.detectedAt, now);
    return {
      ...seed,
      detectedDateTime: detected.dateTime,
      detectedLabel: detected.compact,
      detectedTitle: detected.full,
    };
  });
}

async function renderHome() {
  return renderToStaticMarkup(await Home());
}

function previewLinks(html: string) {
  const $ = load(html);
  return $(".public-live-update-title-row a").map((_index, link) => $(link).attr("href")!).get();
}

function previewTimes(html: string) {
  return [...html.matchAll(/<time dateTime="([^"]*)" title="([^"]*)">([^<]*)<span class="sr-only"> \(([^)]*)\)<\/span><\/time>/g)].map(
    (match) => ({ dateTime: match[1], title: match[2], label: match[3], hidden: match[4] }),
  );
}

const EMPTY_NOTICE = "No award page changes have been recorded yet.";
const UNAVAILABLE_NOTICE = "Live updates are unavailable right now. Please check back soon.";

function previewNotices(html: string) {
  return [...html.matchAll(/<div class="public-live-feed-empty">([^<]*)<\/div>/g)].map((match) => match[1]);
}

function feedNotices(html: string) {
  return [...html.matchAll(/<div class="public-live-feed-empty">([^<]*)<\/div>/g)].map((match) => match[1]);
}

async function renderUpdatesPage() {
  return renderToStaticMarkup(await UpdatesPage({ searchParams: Promise.resolve({}) }));
}

describe("homepage live update preview", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getLiveUpdateItems.mockImplementation(async (_limit: number, now: Date) => loaderResult(feedSeeds, now));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("links each of the five preview rows to the canonical award path with the exact source and change", async () => {
    const html = await renderHome();

    expect(mocks.getLiveUpdateItems).toHaveBeenCalledTimes(1);
    expect(mocks.getLiveUpdateItems).toHaveBeenCalledWith(8, expect.any(Date));
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
    expect(load(html)(".public-live-update-title-row").first().text()).toBe("Barry Goldwater Scholarship");
    expect(html).toContain('aria-label="Live award update preview"');
    expect(html).toContain('<a class="public-live-update-detail-link" href="/updates">View all updates');
    // A loaded preview shows rows and no notice.
    expect(previewNotices(html)).toEqual([]);
  });

  it("renders each detected time semantically from one clock reading, with the full Central time for context", async () => {
    const html = await renderHome();

    // The loader received the page's single clock reading.
    const [, now] = mocks.getLiveUpdateItems.mock.calls[0] as [number, Date];
    expect(now.getTime()).toBe(FIXED_NOW.getTime());

    const times = previewTimes(html);
    expect(times.map((time) => time.label)).toEqual(["2h ago", "Just now", "3d ago", "Aug 1", "Dec 20, 2025"]);
    expect(times.map((time) => time.dateTime)).toEqual([
      "2026-09-05T12:00:00.000Z",
      "2026-09-05T13:59:30.000Z",
      "2026-09-02T14:00:00.000Z",
      "2026-08-01T15:00:00.000Z",
      "2025-12-20T15:00:00.000Z",
    ]);
    for (const [index, time] of times.entries()) {
      const full = formatCentralDateTime(time.dateTime);
      expect(time.title, `row ${index}`).toBe(full);
      expect(time.hidden, `row ${index}`).toBe(full);
    }
    expect(times[0].title).toMatch(/^Sep 5, 2026, 7:00.AM CDT$/);
    // Compact layout is kept: the time sits inside the row's existing span.
    expect(html).toContain('<span><time dateTime="2026-09-05T12:00:00.000Z"');
  });

  it("renders one plain notice, and no <time>, for an update whose timestamp is not a date", async () => {
    const seeds = [...feedSeeds];
    seeds[2] = makeSeed({ ...seeds[2], detectedAt: "not-a-date" });
    mocks.getLiveUpdateItems.mockImplementation(async (_limit: number, now: Date) => loaderResult(seeds, now));

    const html = await renderHome();

    const $ = load(html);
    const rows = $(".public-live-update-row");
    expect(rows).toHaveLength(5);
    expect(rows.eq(2).find(".public-live-update-time").text()).toContain("Date unavailable");
    expect(rows.eq(2).find(".public-live-update-title-row").text()).toBe("Example Award");
    expect(rows.eq(2).find("time")).toHaveLength(0);
    expect(html.split("Date unavailable")).toHaveLength(2);
    // Every remaining time element carries a datetime; none is emitted bare.
    expect(previewTimes(html)).toHaveLength(4);
    expect(html.split("<time")).toHaveLength(5);
    expect(html).not.toMatch(/<time(?![^>]*dateTime=)/);
  });

  it("keeps the same useful public actions for anonymous and signed-in readers", async () => {
    const anonymous = await renderHome();
    const $ = load(anonymous);
    expect($("main h1").text()).toBe("Keep up with award changes.");
    expect($(".public-page-actions a").map((_index, el) => ({text:$(el).text(), href:$(el).attr("href")})).get()).toEqual([
      {text:"Browse awards", href:"/award-directory"},
      {text:"Get daily emails", href:"/updates/subscribe"},
    ]);
    expect($("main a[href='/updates']")).toHaveLength(1);
    expect($("main a[href='/updates']").text()).toBe("View all updates");
    expect($(".home-journey-band, .home-matrix-grid, .home-terminal-hero")).toHaveLength(0);
    expect($("a[href='/contact']").text()).toBe("Contact");
    mocks.getCurrentUser.mockResolvedValue({id:"user-1", email:"person@example.edu"});
    expect(await renderHome()).toBe(anonymous);
  });

  it("renders the same complete update cards as the full Updates page", async () => {
    const home = load(await renderHome());
    const updates = load(await renderUpdatesPage());
    home(".public-live-update-row").each((_index, node) => {
      const card = home(node);
      const href = card.find(".public-live-update-title-row a").attr("href");
      const match = updates(".public-live-update-row").filter((_i, element) =>
        updates(element).find(".public-live-update-title-row a").attr("href") === href,
      );
      expect(match).toHaveLength(1);
      expect(card.html()).toBe(match.html());
    });
  });

  it("shows the empty notice, and no promise of a next scan, when nothing has been recorded", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([]);

    const html = await renderHome();

    expect(previewNotices(html)).toEqual([EMPTY_NOTICE]);
    expect(html).not.toContain(UNAVAILABLE_NOTICE);
    expect(html).not.toContain("next scan");
    expect(previewLinks(html)).toEqual([]);
  });

  it("stays up and shows one unavailable notice when the feed fails to load", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getLiveUpdateItems.mockRejectedValue(new Error("connection refused"));

    const html = await renderHome();

    expect(previewNotices(html)).toEqual([UNAVAILABLE_NOTICE]);
    expect(html).not.toContain(EMPTY_NOTICE);
    expect(html).not.toContain("connection refused");
    expect(previewLinks(html)).toEqual([]);
    // The hero and its actions render as usual around the notice.
    expect(html).toContain('<a class="button-primary" href="/award-directory">Browse awards');
    expect(load(html)(".public-page-actions a[href='/updates/subscribe']").text()).toBe("Get daily emails");
    expect(html).toContain('<a class="public-live-update-detail-link" href="/updates">View all updates');
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("shows the unavailable notice and never loads updates without configuration", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const html = await renderHome();

    expect(mocks.getLiveUpdateItems).not.toHaveBeenCalled();
    expect(previewNotices(html)).toEqual([UNAVAILABLE_NOTICE]);
    expect(html).not.toContain(EMPTY_NOTICE);
    expect(previewLinks(html)).toEqual([]);
  });

  it("uses the same feed wording as the live feed page in every state", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.getLiveUpdateItems.mockResolvedValue([]);
    const emptyHome = previewNotices(await renderHome());
    expect(emptyHome).toHaveLength(1);
    expect(feedNotices(await renderUpdatesPage())).toEqual(emptyHome);

    mocks.getLiveUpdateItems.mockRejectedValue(new Error("connection refused"));
    const failedHome = previewNotices(await renderHome());
    expect(failedHome).toHaveLength(1);
    expect(failedHome).not.toEqual(emptyHome);
    expect(feedNotices(await renderUpdatesPage())).toEqual(failedHome);

    mocks.hasSupabaseAdminConfig.mockReturnValue(false);
    expect(previewNotices(await renderHome())).toEqual(failedHome);
    expect(feedNotices(await renderUpdatesPage())).toEqual(failedHome);

    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getLiveUpdateItems.mockImplementation(async (_limit: number, now: Date) => loaderResult(feedSeeds, now));
    expect(previewNotices(await renderHome())).toEqual([]);
    expect(feedNotices(await renderUpdatesPage())).toEqual([]);
    consoleError.mockRestore();
  });
});
