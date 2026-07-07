import { describe, expect, it } from "vitest";
import {
  awardSourceSlugBase,
  awardSlugFromName,
  canonicalAwardPath,
  dashboardAwardPath,
  normalizeAwardSlug,
  withUniqueAwardSourceSlugs,
} from "@/lib/award-slugs";

describe("award slugs", () => {
  it("creates lowercase SEO slugs from award names", () => {
    expect(awardSlugFromName("Barry Goldwater Scholarship & Excellence in Education")).toBe(
      "barry-goldwater-scholarship-and-excellence-in-education",
    );
  });

  it("normalizes aliases before lookup", () => {
    expect(normalizeAwardSlug("/Goldwater Scholarship/")).toBe("goldwater scholarship");
    expect(normalizeAwardSlug("Goldwater-Scholarship")).toBe("goldwater-scholarship");
  });

  it("uses stored canonical slugs before fallback slugs", () => {
    expect(
      canonicalAwardPath(
        "goldwater-scholarship",
        "Barry Goldwater Scholarship",
        "63298584-f2f8-41b7-87a8-7892af8b642a",
      ),
    ).toBe("/goldwater-scholarship");
  });

  it("falls back to a stable id-suffixed slug when a stored slug is missing", () => {
    expect(
      canonicalAwardPath(
        null,
        "Barry Goldwater Scholarship",
        "63298584-f2f8-41b7-87a8-7892af8b642a",
      ),
    ).toBe("/barry-goldwater-scholarship-63298584");
  });

  it("uses canonical public slugs for authenticated award paths", () => {
    expect(
      dashboardAwardPath(
        "goldwater-scholarship",
        "Barry Goldwater Scholarship",
        "63298584-f2f8-41b7-87a8-7892af8b642a",
      ),
    ).toBe("/goldwater-scholarship");
  });

  it("creates clean source subpage slugs", () => {
    expect(
      awardSourceSlugBase({
        id: "source-1",
        display_title: "FAQ",
        page_type: "faq",
      }),
    ).toBe("faq");

    expect(
      awardSourceSlugBase({
        id: "source-2",
        display_title: "Official page",
        page_type: "eligibility",
      }),
    ).toBe("eligibility");

    expect(
      awardSourceSlugBase({
        id: "source-3",
        display_title: "Goldwater Scholarship Application Materials",
        page_type: "application",
      }),
    ).toBe("goldwater-scholarship-application-materials");
  });

  it("keeps duplicate source slugs unique without adding IDs", () => {
    expect(
      withUniqueAwardSourceSlugs([
        { id: "a", display_title: "FAQ", page_type: "faq" },
        { id: "b", display_title: "FAQ", page_type: "faq" },
      ]).map((source) => source.sourceSlug),
    ).toEqual(["faq", "faq-2"]);
  });
});
