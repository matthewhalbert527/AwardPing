import { describe, expect, it } from "vitest";
import { upsertWatchlistSource, type MergeableWatchlistSource } from "@/lib/watchlist-source-merge";

function source(input: Partial<MergeableWatchlistSource>): MergeableWatchlistSource {
  return {
    id: input.id || "source",
    sharedAwardSourceId: input.sharedAwardSourceId ?? null,
    monitorId: input.monitorId ?? null,
    monitorSharedAwardSourceId: input.monitorSharedAwardSourceId ?? null,
    title: input.title || "Source page",
    url: input.url || "https://example.org/scholarship",
    pageType: input.pageType ?? "other",
    status: input.status || "untracked",
    cadence: input.cadence ?? null,
    lastCheckedAt: input.lastCheckedAt ?? null,
    lastError: input.lastError ?? null,
  };
}

describe("watchlist source merge", () => {
  it("collapses matching shared and monitored URLs into one display row", () => {
    const sources = new Map<string, MergeableWatchlistSource>();

    upsertWatchlistSource(
      sources,
      source({
        id: "shared-source",
        sharedAwardSourceId: "shared-source",
        title: "Insight and Tips from the Scholars",
        url: "https://goldwaterscholarship.gov/wp-content/uploads/2020/07/InsightsAndTipsFromGoldwaterScholars.pdf",
        pageType: "pdf",
      }),
    );
    upsertWatchlistSource(
      sources,
      source({
        id: "monitor",
        monitorId: "monitor",
        title: "Insight and Tips from the Scholars",
        url: "https://goldwaterscholarship.gov/wp-content/uploads/2020/07/InsightsAndTipsFromGoldwaterScholars.pdf",
        pageType: "pdf",
        status: "error",
        cadence: "daily",
        lastCheckedAt: "2026-05-24T12:08:07.000Z",
        lastError: "Fetch failed.",
      }),
    );

    const merged = [...sources.values()];
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sharedAwardSourceId: "shared-source",
      monitorId: "monitor",
      monitorSharedAwardSourceId: null,
      status: "error",
      cadence: "daily",
      lastError: "Fetch failed.",
    });
  });

  it("dedupes equivalent URLs even when protocol or trailing slash differs", () => {
    const sources = new Map<string, MergeableWatchlistSource>();

    upsertWatchlistSource(
      sources,
      source({
        id: "shared",
        sharedAwardSourceId: "shared",
        url: "http://www.pickeringfellowship.org/faq/",
      }),
    );
    upsertWatchlistSource(
      sources,
      source({
        id: "monitor",
        monitorId: "monitor",
        url: "https://pickeringfellowship.org/faq",
        status: "active",
      }),
    );

    const merged = [...sources.values()];
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe("https://pickeringfellowship.org/faq");
    expect(merged[0].sharedAwardSourceId).toBe("shared");
    expect(merged[0].monitorId).toBe("monitor");
  });
});
