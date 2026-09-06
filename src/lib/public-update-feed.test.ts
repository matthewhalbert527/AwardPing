import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdateItem } from "@/lib/live-updates";

const mocks = vi.hoisted(() => ({
  getLiveUpdateItems: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
}));

vi.mock("@/lib/live-updates", () => ({
  getLiveUpdateItems: mocks.getLiveUpdateItems,
}));
// The config module imports "server-only", which cannot load under vitest,
// so the loader gets exactly the export it uses.
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));

import {
  PUBLIC_UPDATE_FEED_EMPTY_NOTICE,
  PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE,
  loadPublicUpdateFeed,
  publicUpdateFeedNotice,
} from "@/lib/public-update-feed";

const NOW = new Date("2026-09-05T14:00:00.000Z");
const item = { id: "8c2b1a0f-6e5d-4c3b-9a8f-7e6d5c4b3a21" } as unknown as LiveUpdateItem;

describe("loadPublicUpdateFeed", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.getLiveUpdateItems.mockReset();
    mocks.hasSupabaseAdminConfig.mockReset();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("passes each page's own limit and clock through and reports a loaded feed", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([item]);

    expect(await loadPublicUpdateFeed(8, NOW)).toEqual({ status: "ready", updates: [item] });
    expect(await loadPublicUpdateFeed(80, NOW)).toEqual({ status: "ready", updates: [item] });

    expect(mocks.getLiveUpdateItems.mock.calls).toEqual([
      [8, NOW],
      [80, NOW],
    ]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports an empty feed when nothing has been recorded", async () => {
    mocks.getLiveUpdateItems.mockResolvedValue([]);

    expect(await loadPublicUpdateFeed(80, NOW)).toEqual({ status: "empty" });
  });

  it("reports unavailable without calling the loader when nothing is configured", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    expect(await loadPublicUpdateFeed(80, NOW)).toEqual({ status: "unavailable" });
    expect(mocks.getLiveUpdateItems).not.toHaveBeenCalled();
  });

  it("reports unavailable, logs once, and never throws when the load fails", async () => {
    mocks.getLiveUpdateItems.mockRejectedValueOnce(new Error("connection refused"));
    expect(await loadPublicUpdateFeed(80, NOW)).toEqual({ status: "unavailable" });
    expect(consoleError).toHaveBeenCalledWith("connection refused");

    mocks.getLiveUpdateItems.mockRejectedValueOnce("not an error object");
    expect(await loadPublicUpdateFeed(8, NOW)).toEqual({ status: "unavailable" });
    expect(consoleError).toHaveBeenLastCalledWith("Live updates could not be loaded.");
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});

describe("publicUpdateFeedNotice", () => {
  it("gives one plain, distinct notice per state that lists nothing, and none for a loaded feed", () => {
    expect(publicUpdateFeedNotice({ status: "ready", updates: [item] })).toBeNull();
    expect(publicUpdateFeedNotice({ status: "empty" })).toBe(PUBLIC_UPDATE_FEED_EMPTY_NOTICE);
    expect(publicUpdateFeedNotice({ status: "unavailable" })).toBe(PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE);

    expect(PUBLIC_UPDATE_FEED_EMPTY_NOTICE).not.toBe(PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE);
    // Unavailable never reads as "nothing changed", and neither notice leaks
    // implementation words to a visitor.
    expect(PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE).not.toMatch(/no .*changes|nothing/i);
    for (const notice of [PUBLIC_UPDATE_FEED_EMPTY_NOTICE, PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE]) {
      expect(notice).not.toMatch(/supabase|database|error|exception|null/i);
    }
  });
});
