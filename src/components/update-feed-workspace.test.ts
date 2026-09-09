import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UpdateFeedWorkspace, type UpdateFeedRow } from "@/components/update-feed-workspace";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/updates",
  useSearchParams: () => searchParams,
}));

function row(id: string, detectedAt: string): UpdateFeedRow {
  return {
    id,
    changeId: id,
    awardId: `award-${id}`,
    awardSlug: `award-${id}`,
    sourceId: `source-${id}`,
    title: `Award ${id}`,
    sourceTitle: "Eligibility",
    sourceUrl: "https://example.edu/eligibility",
    sourcePageType: "eligibility",
    summary: `Update ${id}`,
    detectedAt,
    kind: "shared",
    inWatchlist: true,
  };
}

// Central Time is UTC-5 in September, so these two instants are the same UTC
// day but different days for the reader, which is what the range must honour.
const rows = [
  row("aug-31-late", "2026-09-01T02:00:00.000Z"), // Aug 31, 9:00 PM Central
  row("sep-01", "2026-09-01T18:00:00.000Z"),
  row("sep-04", "2026-09-04T18:00:00.000Z"),
  row("sep-07-late", "2026-09-08T02:00:00.000Z"), // Sep 7, 9:00 PM Central
  row("sep-09", "2026-09-09T18:00:00.000Z"),
];

function render(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
  return renderToStaticMarkup(createElement(UpdateFeedWorkspace, { rows, scope: "all" }));
}

function shownIds(html: string) {
  return rows.map((r) => r.id).filter((id) => html.includes(`Award ${id}`));
}

describe("UpdateFeedWorkspace custom date range", () => {
  it("offers a custom range beside the fixed windows", () => {
    const html = render({});
    expect(html).toContain('<option value="custom">Custom range</option>');
    expect(html).toContain('<option value="30d" selected="">Last 30 days</option>');
    expect(html).not.toContain('type="date"');
  });

  it("reveals the from and to inputs only for a custom range", () => {
    const html = render({ time: "custom", from: "2026-09-01", to: "2026-09-07" });
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-09-01"');
    expect(html).toContain('value="2026-09-07"');
    expect(html).toContain("<span>From</span>");
    expect(html).toContain("<span>To</span>");
  });

  it("keeps both bounds inclusive using the reader's calendar day", () => {
    const html = render({ time: "custom", from: "2026-09-01", to: "2026-09-07" });
    // Aug 31 9 PM Central falls outside despite its Sep 1 UTC timestamp, and
    // Sep 7 9 PM Central falls inside despite its Sep 8 UTC timestamp.
    expect(shownIds(html)).toEqual(["sep-01", "sep-04", "sep-07-late"]);
  });

  it("supports an open-ended range on either side", () => {
    expect(shownIds(render({ time: "custom", from: "2026-09-04" }))).toEqual([
      "sep-04",
      "sep-07-late",
      "sep-09",
    ]);
    expect(shownIds(render({ time: "custom", to: "2026-09-01" }))).toEqual(["aug-31-late", "sep-01"]);
  });

  it("reads a backwards range as the range the reader meant", () => {
    const html = render({ time: "custom", from: "2026-09-07", to: "2026-09-01" });
    expect(shownIds(html)).toEqual(["sep-01", "sep-04", "sep-07-late"]);
  });

  it("shows every update until a bound is chosen", () => {
    expect(shownIds(render({ time: "custom" }))).toEqual(rows.map((r) => r.id));
  });

  it("ignores a malformed bound instead of emptying the feed", () => {
    expect(shownIds(render({ time: "custom", from: "not-a-date" }))).toEqual(rows.map((r) => r.id));
    expect(shownIds(render({ time: "custom", from: "2026-13-45" }))).toEqual(rows.map((r) => r.id));
  });

  it("names the range in the applied-filter chip", () => {
    expect(render({ time: "custom", from: "2026-09-01", to: "2026-09-07" })).toContain(
      "Sep 1, 2026 – Sep 7, 2026",
    );
    expect(render({ time: "custom", from: "2026-09-01" })).toContain("From Sep 1, 2026");
    expect(render({ time: "custom", to: "2026-09-07" })).toContain("Through Sep 7, 2026");
    expect(render({ time: "custom" })).toContain("Custom range");
  });

  it("leaves the fixed windows working", () => {
    expect(shownIds(render({ time: "all" }))).toEqual(rows.map((r) => r.id));
    expect(render({ time: "90d" })).toContain('<option value="90d"');
  });
});
