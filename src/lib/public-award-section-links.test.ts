import { describe, expect, it } from "vitest";
import { publicAwardHref, publicAwardQueryId, publicAwardSection } from "@/lib/public-award-links";

const sourceId = "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60";
const changeId = "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21";
const sections = ["overview", "updates", "applying", "sources"];

describe("validated public award section links", () => {
  it.each(sections)("preserves the validated %s section and source/change attribution", (section) => {
    const href = publicAwardHref("/example-award", {
      section: publicAwardSection(section),
      sourceId: publicAwardQueryId(sourceId),
      changeId: publicAwardQueryId(changeId),
    });
    expect(href).toBe(`/example-award?source=${sourceId}&change=${changeId}&section=${section}`);
    const url = new URL(href, "https://awardping.example/");
    expect(url.origin).toBe("https://awardping.example");
    expect(url.searchParams.get("section")).toBe(section);
    expect(url.searchParams.get("source")).toBe(sourceId);
    expect(url.searchParams.get("change")).toBe(changeId);
    expect(url.hash).toBe("");
  });

  it.each([
    undefined, null, "", " ", "Updates", " updates", "updates ", "eligibility", "dates", "application",
    "unknown", "https://evil.example/", "updates&source=other", "updates#sources", ["updates"], ["overview", "updates"],
    1, true, { toString: () => "updates" },
  ].map((value) => ({ value })))("drops invalid or repeated section input: $value", ({ value }) => {
    const section = publicAwardSection(value);
    expect(section).toBeUndefined();
    expect(publicAwardHref("/example-award", { section, sourceId, changeId }))
      .toBe(`/example-award?source=${sourceId}&change=${changeId}`);
  });

  it.each(["//evil.example", "\\\\evil.example", "/\\evil.example", "https://evil.example/path", "example?section=sources#outside"])(
    "keeps a section link on this origin despite a hostile path: %s", (path) => {
      const url = new URL(publicAwardHref(path, { section: "applying", sourceId, changeId }), "https://awardping.example/");
      expect(url.origin).toBe("https://awardping.example");
      expect(url.searchParams.get("section")).toBe("applying");
      expect(url.searchParams.get("source")).toBe(sourceId);
      expect(url.searchParams.get("change")).toBe(changeId);
      expect(url.hash).toBe("");
    },
  );

  it("omits an unrecognized section without dropping valid source/change attribution", () => {
    const href = publicAwardHref("/example-award", { section: "not-a-section", sourceId, changeId });
    expect(href).toBe(`/example-award?source=${sourceId}&change=${changeId}`);
  });
});
