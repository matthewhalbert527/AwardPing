import { describe, expect, it } from "vitest";
import {
  liveUpdateAwardHref,
  publicAwardHref,
  publicAwardQueryId,
} from "@/lib/public-award-links";

const SOURCE_ID = "3f1d3a2e-9d3b-4c5e-8a7f-1b2c3d4e5f60";
const CHANGE_ID = "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21";

function makeUpdate(overrides: Partial<Parameters<typeof liveUpdateAwardHref>[0]> = {}) {
  return {
    id: CHANGE_ID,
    awardId: "63298584-f2f8-41b7-87a8-7892af8b642a",
    awardName: "Barry Goldwater Scholarship",
    awardSlug: "goldwater-scholarship",
    sourceId: SOURCE_ID,
    ...overrides,
  };
}

describe("public award links", () => {
  it("links a live update to the canonical award path with source then change", () => {
    expect(liveUpdateAwardHref(makeUpdate())).toBe(
      `/goldwater-scholarship?source=${SOURCE_ID}&change=${CHANGE_ID}`,
    );
  });

  it("is deterministic for the same update", () => {
    const first = liveUpdateAwardHref(makeUpdate());
    const second = liveUpdateAwardHref({ ...makeUpdate() });
    expect(second).toBe(first);
  });

  it("omits the source parameter when the update has no source id", () => {
    expect(liveUpdateAwardHref(makeUpdate({ sourceId: null }))).toBe(
      `/goldwater-scholarship?change=${CHANGE_ID}`,
    );
  });

  it("uses the stable id-suffixed fallback slug when the stored slug is missing", () => {
    expect(liveUpdateAwardHref(makeUpdate({ awardSlug: null }))).toBe(
      `/barry-goldwater-scholarship-63298584?source=${SOURCE_ID}&change=${CHANGE_ID}`,
    );
  });

  it("encodes query values with URLSearchParams rules", () => {
    expect(publicAwardHref("/goldwater-scholarship", { sourceId: "a b&c=d", changeId: "e/f?g#h" })).toBe(
      "/goldwater-scholarship?source=a+b%26c%3Dd&change=e%2Ff%3Fg%23h",
    );
  });

  it("returns the bare path when no context is requested", () => {
    expect(publicAwardHref("/goldwater-scholarship")).toBe("/goldwater-scholarship");
    expect(publicAwardHref("/goldwater-scholarship", { sourceId: null, changeId: "" })).toBe(
      "/goldwater-scholarship",
    );
  });

  it("never produces an external or scheme-relative destination from a hostile slug", () => {
    const hostileSlugs = [
      "//evil.example",
      "\\\\evil.example",
      "\\evil.example",
      "/\\evil.example",
      "https://evil.example/path",
      "javascript:alert(1)",
      "goldwater?redirect=https://evil.example",
      "goldwater#https://evil.example",
      "goldwater scholarship",
    ];
    for (const slug of hostileSlugs) {
      const href = liveUpdateAwardHref(makeUpdate({ awardSlug: slug }));
      const resolved = new URL(href, "https://awardping.example/updates");
      expect(resolved.origin, slug).toBe("https://awardping.example");
      expect(href, slug).toMatch(/^\/[^/\\]/);
      expect(href, slug).not.toContain("\\");
      expect(resolved.searchParams.get("source"), slug).toBe(SOURCE_ID);
      expect(resolved.searchParams.get("change"), slug).toBe(CHANGE_ID);
      expect(resolved.hash, slug).toBe("");
    }
  });

  it("leaves canonical slugs untouched by the encoding", () => {
    expect(publicAwardHref("/goldwater-scholarship-2026")).toBe("/goldwater-scholarship-2026");
    expect(publicAwardHref("/barry-goldwater-scholarship-63298584")).toBe(
      "/barry-goldwater-scholarship-63298584",
    );
  });

  it("accepts only single well-formed query ids", () => {
    expect(publicAwardQueryId(SOURCE_ID)).toBe(SOURCE_ID);
    expect(publicAwardQueryId(`  ${CHANGE_ID}  `)).toBe(CHANGE_ID);
    expect(publicAwardQueryId("source-apply")).toBe("source-apply");
    expect(publicAwardQueryId([SOURCE_ID, CHANGE_ID])).toBeUndefined();
    expect(publicAwardQueryId(undefined)).toBeUndefined();
    expect(publicAwardQueryId(null)).toBeUndefined();
    expect(publicAwardQueryId("")).toBeUndefined();
    expect(publicAwardQueryId("   ")).toBeUndefined();
    expect(publicAwardQueryId("a".repeat(129))).toBeUndefined();
    expect(publicAwardQueryId("https://evil.example")).toBeUndefined();
    expect(publicAwardQueryId("<script>")).toBeUndefined();
    expect(publicAwardQueryId("id%20with%20escapes")).toBeUndefined();
    expect(publicAwardQueryId({ toString: () => SOURCE_ID })).toBeUndefined();
  });
});
