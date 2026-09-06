import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { LiveUpdateItem } from "@/lib/live-updates";
import { describeDetectedAt, formatCentralDateTime } from "@/lib/time-zone";

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

// November 1, 2026, 11:30 PM CST: the evening after the fall-back transition,
// where subtracting 24 hours from "now" still lands on November 1 in Central.
const FIXED_NOW = new Date("2026-11-02T05:30:00.000Z");

const SOURCE_ID = "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60";
const CHANGE_ID = "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21";
const SECOND_CHANGE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const THIRD_CHANGE_ID = "9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b";
const FOURTH_CHANGE_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const FIFTH_CHANGE_ID = "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a";

type FeedSeed = Omit<LiveUpdateItem, "detectedDateTime" | "detectedLabel" | "detectedTitle">;

function makeSeed(overrides: Partial<FeedSeed> = {}): FeedSeed {
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
    detectedAt: "2026-11-02T04:00:00.000Z",
    changeTypeLabel: "Deadline",
    ...overrides,
  };
}

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

function useFeed(seeds: FeedSeed[]) {
  mocks.getLiveUpdateItems.mockImplementation(async (_limit: number, now: Date) => loaderResult(seeds, now));
}

async function renderUpdatesPage(searchParams: { confirmed?: string; unsubscribed?: string } = {}) {
  return renderToStaticMarkup(await UpdatesPage({ searchParams: Promise.resolve(searchParams) }));
}

function awardLinks(html: string) {
  return [...html.matchAll(/<div class="public-live-update-title-row"><a href="([^"]*)">([^<]*)<\/a>/g)].map(
    (match) => ({ href: match[1].replace(/&amp;/g, "&"), label: match[2] }),
  );
}

function dayHeadings(html: string) {
  return [...html.matchAll(/<h3 class="public-live-day-label">([^<]*)<\/h3>/g)].map((match) => match[1]);
}

function rowTimes(html: string) {
  return [...html.matchAll(/<time dateTime="([^"]*)" title="([^"]*)">([^<]*)<span class="sr-only"> \(([^)]*)\)<\/span><\/time>/g)].map(
    (match) => ({ dateTime: match[1], title: match[2], label: match[3], hidden: match[4] }),
  );
}

describe("public updates page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
    mocks.getLiveUpdateItems.mockReset();
    mocks.hasSupabaseAdminConfig.mockReset();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("links every update to its canonical award page with the exact source and change", async () => {
    useFeed([
      makeSeed(),
      makeSeed({
        id: SECOND_CHANGE_ID,
        awardId: "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e",
        awardName: "Truman Scholarship",
        awardSlug: "truman-scholarship",
        sourceId: null,
        sourceTitle: "Eligibility",
        sourceUrl: "https://truman.example/eligibility",
        sourcePageType: "eligibility",
        summary: "Eligibility language changed.",
        detectedAt: "2026-11-02T03:00:00.000Z",
      }),
      makeSeed({
        id: THIRD_CHANGE_ID,
        awardId: "12345678-abcd-4ef0-9876-543210fedcba",
        awardName: "Example Award",
        awardSlug: null,
        sourceTitle: "Overview",
        sourceUrl: "https://example.example/overview",
        sourcePageType: "homepage",
        summary: "The overview changed.",
        detectedAt: "2026-11-01T02:00:00.000Z",
      }),
    ]);

    const html = await renderUpdatesPage();

    expect(mocks.getLiveUpdateItems).toHaveBeenCalledTimes(1);
    expect(mocks.getLiveUpdateItems).toHaveBeenCalledWith(80, expect.any(Date));
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

  it("labels and groups detected times from one clock reading, in Central calendar days", async () => {
    useFeed([
      makeSeed(),
      makeSeed({ id: SECOND_CHANGE_ID, detectedAt: "2026-11-01T02:00:00.000Z" }),
      makeSeed({ id: THIRD_CHANGE_ID, detectedAt: "2026-10-20T15:00:00.000Z" }),
      makeSeed({ id: FOURTH_CHANGE_ID, detectedAt: "2026-08-01T15:00:00.000Z" }),
      makeSeed({ id: FIFTH_CHANGE_ID, detectedAt: "2025-12-20T15:00:00.000Z" }),
    ]);

    const html = await renderUpdatesPage();

    const [, now] = mocks.getLiveUpdateItems.mock.calls[0] as [number, Date];
    expect(now.getTime()).toBe(FIXED_NOW.getTime());
    expect(dayHeadings(html)).toEqual([
      "Today",
      "Yesterday",
      "October 20, 2026",
      "August 1, 2026",
      "December 20, 2025",
    ]);
    const times = rowTimes(html);
    expect(times.map((time) => time.label)).toEqual(["1h ago", "1d ago", "12d ago", "Aug 1", "Dec 20, 2025"]);
    expect(times.map((time) => time.dateTime)).toEqual([
      "2026-11-02T04:00:00.000Z",
      "2026-11-01T02:00:00.000Z",
      "2026-10-20T15:00:00.000Z",
      "2026-08-01T15:00:00.000Z",
      "2025-12-20T15:00:00.000Z",
    ]);
    for (const [index, time] of times.entries()) {
      const full = formatCentralDateTime(time.dateTime);
      expect(time.title, `row ${index}`).toBe(full);
      expect(time.hidden, `row ${index}`).toBe(full);
    }
    expect(times[0].title).toMatch(/^Nov 1, 2026, 10:00.PM CST$/);
    expect(times[1].title).toMatch(/^Oct 31, 2026, 9:00.PM CDT$/);
    // Compact layout is kept: the time sits inside the row's existing span.
    expect(html).toContain('<div class="public-live-update-time"><span><time dateTime="2026-11-02T04:00:00.000Z"');
    expect(html).toContain("Dates use Central Time.");
  });

  it("names yesterday by the Central calendar across the spring-forward transition", async () => {
    // 00:30 CDT on March 9: subtracting 24 hours would point at March 7.
    vi.setSystemTime(new Date("2026-03-09T05:30:00.000Z"));
    useFeed([
      makeSeed({ detectedAt: "2026-03-09T05:15:00.000Z" }),
      makeSeed({ id: SECOND_CHANGE_ID, detectedAt: "2026-03-08T20:00:00.000Z" }),
      makeSeed({ id: THIRD_CHANGE_ID, detectedAt: "2026-03-07T20:00:00.000Z" }),
    ]);

    const html = await renderUpdatesPage();

    expect(dayHeadings(html)).toEqual(["Today", "Yesterday", "March 7, 2026"]);
    expect(rowTimes(html).map((time) => time.label)).toEqual(["15m ago", "9h ago", "1d ago"]);
  });

  it("renders one plain notice under an Undated heading, and no <time>, for an unreadable timestamp", async () => {
    useFeed([
      makeSeed(),
      makeSeed({ id: SECOND_CHANGE_ID, detectedAt: "not-a-date" }),
      makeSeed({ id: THIRD_CHANGE_ID, detectedAt: "2026-11-01T02:00:00.000Z" }),
    ]);

    const html = await renderUpdatesPage();

    expect(dayHeadings(html)).toEqual(["Today", "Yesterday", "Undated"]);
    const rows = html.split('<article class="public-live-update-row">').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('<div class="public-live-update-time"><span>Date unavailable</span><strong>Deadline</strong></div>');
    expect(rows[2]).not.toContain("<time");
    expect(html.split("Date unavailable")).toHaveLength(2);
    expect(rowTimes(html)).toHaveLength(2);
    expect(html.split("<time")).toHaveLength(3);
    expect(html).not.toMatch(/<time(?![^>]*dateTime=)/);
  });

  it("preserves the external official-source link and its accessible label", async () => {
    useFeed([makeSeed()]);

    const html = await renderUpdatesPage();

    expect(html).toContain(
      '<a class="public-live-update-source-link" href="https://goldwater.example/apply" rel="noreferrer" target="_blank" aria-label="Open Application Instructions">',
    );
    expect(html).toContain('aria-label="Live award updates"');
    expect(html).toContain("<h2>Latest source-page changes</h2>");
    expect(html).toContain(`<span class="badge">${pageTypeLabel("application")}</span>`);
  });

  it("keeps the subscription status messages", async () => {
    useFeed([]);

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
