import { describe, expect, it } from "vitest";
import {
  activeChangeSourceFilter,
  changeBelongsToOpenSource,
} from "@/lib/source-change-events";

describe("source change event filtering", () => {
  it("keeps changes whose source id is still open", () => {
    const isActiveChange = activeChangeSourceFilter([
      { id: "source-open", url: "https://example.edu/award" },
    ]);

    expect(
      isActiveChange({
        shared_award_source_id: "source-open",
        source_url: "https://example.edu/other-page",
      }),
    ).toBe(true);
  });

  it("rejects changes whose source id is no longer open even when the URL is present", () => {
    const activeSources = {
      openSourceIds: new Set(["source-open"]),
      openSourceUrlKeys: new Set(["example.edu/award"]),
    };

    expect(
      changeBelongsToOpenSource(
        {
          shared_award_source_id: "source-review-later",
          source_url: "https://example.edu/award",
        },
        activeSources,
      ),
    ).toBe(false);
  });

  it("falls back to canonical source URL when older changes do not have a source id", () => {
    const isActiveChange = activeChangeSourceFilter([
      { id: "source-open", url: "https://www.example.edu/award/?utm_source=newsletter" },
    ]);

    expect(
      isActiveChange({
        shared_award_source_id: null,
        source_url: "https://example.edu/award/",
      }),
    ).toBe(true);
  });

  it("rejects source-less changes when the URL is not one of the open source pages", () => {
    const isActiveChange = activeChangeSourceFilter([
      { id: "source-open", url: "https://example.edu/award" },
    ]);

    expect(
      isActiveChange({
        shared_award_source_id: null,
        source_url: "https://example.edu/news",
      }),
    ).toBe(false);
  });
});
