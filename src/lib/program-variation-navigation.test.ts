import { describe, expect, it } from "vitest";
import { matchingVariationOptions, variationFilter, variationHref, variationRequestUrl } from "./program-variation-navigation";
import { publicAwardVariantId } from "./public-award-links";

const option = (scope_key: string, country: string, course: string) => ({ scope_key, label: scope_key,
  attributes: { country, course, track: "Research", applicant_group: null } });

describe("approved variation navigation", () => {
  it("preserves existing update context through a selected route", () => {
    expect(variationHref("/example", "us-research", { sourceId: "source", changeId: "change", section: "updates" }))
      .toBe("/example?source=source&change=change&section=updates&variant=us-research");
    expect(variationHref("/example", "common", { changeId: "change" })).toBe("/example?change=change");
  });
  it("rejects repeated keys, route injection and unbounded inventory IDs", () => {
    for (const value of [["us", "uk"], "../us", "US", "https://other.test", "x".repeat(129), "legacy_common", "", null]) {
      expect(publicAwardVariantId(value)).toBeUndefined();
      expect(variationHref("/example", value)).toBeNull();
    }
  });
  it("filters only actual provider combinations without inventing a cross product", () => {
    const options = [option("us-a", "United States", "Course A"), option("uk-b", "United Kingdom", "Course B")];
    expect(matchingVariationOptions(options, { country: "United States", course: "Course B" })).toEqual([]);
    expect(matchingVariationOptions(options, { country: "United States" })).toEqual([options[0]]);
  });
  it("encodes filter text and bounds page cursors", () => {
    expect(variationRequestUrl("example", { course: "Arts & Sciences" }, "uk-b"))
      .toBe("/api/public/program-variations?cohort=example&course=Arts+%26+Sciences&cursor=uk-b");
    expect(() => variationRequestUrl("../example")).toThrow();
    expect(() => variationRequestUrl("example", {}, "../bad")).toThrow();
    expect(variationFilter(["US"])).toBeUndefined();
    expect(variationFilter("US\nUK")).toBeUndefined();
    expect(variationFilter("x".repeat(201))).toBeUndefined();
  });
});
