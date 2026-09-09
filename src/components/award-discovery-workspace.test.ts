import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AwardDiscoveryWorkspace,
  hasUpdateInRange,
  normalizeRange,
  type SharedAwardCard,
} from "@/components/award-discovery-workspace";

const goldwater: SharedAwardCard = {
  id: "award-1",
  name: "Goldwater Scholarship",
  slug: "goldwater-scholarship",
  publicPath: "/goldwater-scholarship",
  officialHomepage: "https://goldwaterscholarship.gov",
  summary: "Supports undergraduate STEM researchers.",
  deadline: "January 29, 2026",
  academicLevels: ["Undergraduate"],
  disciplines: ["STEM"],
  citizenship: ["U.S. citizens"],
  lastCheckedAt: "2026-06-24T12:00:00.000Z",
  recentlyUpdated: true,
  sourceCount: 4,
  sourceIssueCount: null,
  changeCount: 2,
  updateDays: ["2026-06-24", "2026-05-02"],
  tracked: true,
  detailsLoaded: false,
  sources: [],
  changes: [],
};

const marshall: SharedAwardCard = {
  ...goldwater,
  id: "award-2",
  name: "Marshall Scholarship",
  slug: "marshall-scholarship",
  publicPath: "/marshall-scholarship",
  updateDays: ["2026-09-07"],
};

const churchill: SharedAwardCard = {
  ...goldwater,
  id: "award-3",
  name: "Churchill Scholarship",
  slug: "churchill-scholarship",
  publicPath: "/churchill-scholarship",
  recentlyUpdated: false,
  changeCount: 0,
  updateDays: [],
};

function render(awards: SharedAwardCard[]) {
  return renderToStaticMarkup(
    createElement(AwardDiscoveryWorkspace, {
      canManage: false,
      isAuthenticated: false,
      sharedAwards: awards,
    }),
  );
}

describe("AwardDiscoveryWorkspace", () => {
  it("uses the canonical public page as the signed-in award directory row destination", () => {
    const html = renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: false,
        isAuthenticated: true,
        sharedAwards: [goldwater],
      }),
    );

    expect(html).toContain("href=\"/goldwater-scholarship\"");
    expect(html).not.toContain("href=\"/dashboard/awards/goldwater-scholarship\"");
    expect(html).toContain("Public page");
  });

  it("uses public slug pages as the primary destination for logged-out users", () => {
    const html = renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: false,
        isAuthenticated: false,
        sharedAwards: [goldwater],
      }),
    );

    expect(html).toContain("href=\"/goldwater-scholarship\"");
    expect(html).not.toContain("href=\"/dashboard/awards/goldwater-scholarship\"");
  });

  it("offers a date range beside the other update filters", () => {
    const html = render([goldwater]);
    expect(html).toContain('<option value="custom">Updated in date range</option>');
    expect(html).toContain('<option value="recent">Recently updated</option>');
    // The date inputs stay hidden until the range is chosen.
    expect(html).not.toContain('type="date"');
  });
});

describe("award update date range", () => {
  it("needs at least one bound before it filters anything", () => {
    expect(normalizeRange("", "")).toBeNull();
    expect(normalizeRange("not-a-date", "")).toBeNull();
    expect(normalizeRange("2026-09-01", "")).toEqual({ from: "2026-09-01", to: "" });
    expect(normalizeRange("", "2026-09-07")).toEqual({ from: "", to: "2026-09-07" });
  });

  it("reads a backwards pick as the range the reader meant", () => {
    expect(normalizeRange("2026-09-07", "2026-09-01")).toEqual({
      from: "2026-09-01",
      to: "2026-09-07",
    });
  });

  it("keeps an award whose update falls on either boundary", () => {
    const range = { from: "2026-09-01", to: "2026-09-07" };
    expect(hasUpdateInRange({ updateDays: ["2026-09-01"] }, range)).toBe(true);
    expect(hasUpdateInRange({ updateDays: ["2026-09-07"] }, range)).toBe(true);
    expect(hasUpdateInRange({ updateDays: ["2026-09-04"] }, range)).toBe(true);
  });

  it("drops an award whose updates all fall outside the range", () => {
    const range = { from: "2026-09-01", to: "2026-09-07" };
    expect(hasUpdateInRange({ updateDays: ["2026-08-31", "2026-09-08"] }, range)).toBe(false);
    expect(hasUpdateInRange({ updateDays: [] }, range)).toBe(false);
  });

  it("keeps an award when any one of its updates lands in the range", () => {
    const range = { from: "2026-09-01", to: "2026-09-07" };
    expect(
      hasUpdateInRange({ updateDays: ["2026-09-09", "2026-09-04", "2026-01-02"] }, range),
    ).toBe(true);
  });

  it("supports an open-ended range on either side", () => {
    expect(hasUpdateInRange({ updateDays: ["2026-09-09"] }, { from: "2026-09-01", to: "" })).toBe(true);
    expect(hasUpdateInRange({ updateDays: ["2026-08-31"] }, { from: "2026-09-01", to: "" })).toBe(false);
    expect(hasUpdateInRange({ updateDays: ["2026-08-31"] }, { from: "", to: "2026-09-01" })).toBe(true);
    expect(hasUpdateInRange({ updateDays: ["2026-09-09"] }, { from: "", to: "2026-09-01" })).toBe(false);
  });

  it("selects exactly the awards updated in the window", () => {
    const range = normalizeRange("2026-09-01", "2026-09-07");
    const matching = [goldwater, marshall, churchill].filter(
      (award) => range && hasUpdateInRange(award, range),
    );
    expect(matching.map((award) => award.name)).toEqual(["Marshall Scholarship"]);
  });
});
