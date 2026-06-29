import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AwardDiscoveryWorkspace, type SharedAwardCard } from "@/components/award-discovery-workspace";

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
  tracked: true,
  detailsLoaded: false,
  sources: [],
  changes: [],
};

describe("AwardDiscoveryWorkspace", () => {
  it("shows a canonical public page link for signed-in award directory rows", () => {
    const html = renderToStaticMarkup(
      createElement(AwardDiscoveryWorkspace, {
        canManage: false,
        isAuthenticated: true,
        sharedAwards: [goldwater],
      }),
    );

    expect(html).toContain("href=\"/dashboard/awards/goldwater-scholarship\"");
    expect(html).toContain("href=\"/goldwater-scholarship\"");
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
});
