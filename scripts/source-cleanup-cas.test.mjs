import { describe, expect, it } from "vitest";
import {
  applyAwardSourceCleanupPlanWithCas,
  buildAwardSourceCleanupPlan,
  buildExpectedSourceRetirementState,
} from "./lib/source-cleanup-cas.mjs";

describe("award-scoped source cleanup compare-and-swap", () => {
  it("rejects a sibling-source mutation and applies none of the award plan", async () => {
    const database = fixtureDatabase();
    const plan = cleanupPlan(database);
    const supabase = atomicCleanupSupabase(database, () => {
      database.sources[1].admin_review_status = "review_later";
      database.sources[1].updated_at = "2026-07-17T12:05:00.000Z";
    });

    await expect(applyAwardSourceCleanupPlanWithCas({
      supabase,
      plan,
      reason: "Retire stale source",
      actor: "test-cleanup",
    })).rejects.toThrow("source set changed after cleanup planning; requeue cleanup");

    expect(database.sources[0].admin_review_status).toBe("open");
    expect(database.award.official_homepage).toBe("https://example.org/stale");
    expect(supabase.calls).toHaveLength(1);
    expect(supabase.calls[0].parameters.p_plan.expected_sources).toHaveLength(2);
  });

  it("rejects an award mutation and applies no source retirement or homepage rewrite", async () => {
    const database = fixtureDatabase();
    const plan = cleanupPlan(database);
    const supabase = atomicCleanupSupabase(database, () => {
      database.award.official_homepage = "https://example.org/concurrent";
      database.award.updated_at = "2026-07-17T12:06:00.000Z";
    });

    await expect(applyAwardSourceCleanupPlanWithCas({
      supabase,
      plan,
      reason: "Retire stale source",
      actor: "test-cleanup",
    })).rejects.toThrow("award changed after cleanup planning; requeue cleanup");

    expect(database.sources[0].admin_review_status).toBe("open");
    expect(database.award.official_homepage).toBe("https://example.org/concurrent");
  });

  it("applies all source retirements and the homepage rewrite as one award result", async () => {
    const database = fixtureDatabase();
    const secondStale = sourceRow({
      id: "00000000-0000-4000-8000-000000000103",
      url: "https://example.org/other-stale",
      title: "Other stale source",
    });
    database.sources.splice(1, 0, secondStale);
    const plan = buildAwardSourceCleanupPlan({
      award: database.award,
      allSources: database.sources,
      retireSources: [database.sources[0], secondStale],
      usefulRemainingSourceIds: [database.sources[2].id],
      homepageAfter: database.sources[2].url,
      homepageReplacementSourceId: database.sources[2].id,
    });
    const supabase = atomicCleanupSupabase(database);

    await expect(applyAwardSourceCleanupPlanWithCas({
      supabase,
      plan,
      reason: "Retire stale sources",
      actor: "test-cleanup",
    })).resolves.toMatchObject({
      shared_award_id: database.award.id,
      retired_source_count: 2,
      homepage_changed: true,
    });

    expect(database.sources.slice(0, 2).map((source) => source.admin_review_status))
      .toEqual(["review_later", "review_later"]);
    expect(database.award.official_homepage).toBe("https://example.org/useful");
  });

  it("rejects a zero-row RPC result instead of reporting success", async () => {
    const database = fixtureDatabase();
    const plan = cleanupPlan(database);
    const supabase = {
      async rpc() {
        return { data: [], error: null };
      },
    };

    await expect(applyAwardSourceCleanupPlanWithCas({
      supabase,
      plan,
      reason: "Retire stale source",
      actor: "test-cleanup",
    })).rejects.toThrow("no atomic compare-and-swap result");
  });

  it("requires the complete cleanup-relevant source state", () => {
    const source = sourceRow();
    delete source.last_error;
    expect(() => buildExpectedSourceRetirementState(source)).toThrow(
      "observed source failure state",
    );
  });
});

function cleanupPlan(database) {
  return buildAwardSourceCleanupPlan({
    award: database.award,
    allSources: database.sources,
    retireSources: [database.sources[0]],
    usefulRemainingSourceIds: [database.sources[1].id],
    homepageAfter: database.sources[1].url,
    homepageReplacementSourceId: database.sources[1].id,
  });
}

function fixtureDatabase() {
  const award = {
    id: "00000000-0000-4000-8000-000000000201",
    name: "Example Award",
    official_homepage: "https://example.org/stale",
    status: "active",
    updated_at: "2026-07-17T12:00:00.000Z",
  };
  return {
    award,
    sources: [
      sourceRow(),
      sourceRow({
        id: "00000000-0000-4000-8000-000000000102",
        url: "https://example.org/useful",
        title: "Useful source",
      }),
    ],
  };
}

function sourceRow(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    shared_award_id: "00000000-0000-4000-8000-000000000201",
    url: "https://example.org/stale",
    title: "Stale source",
    page_type: "other",
    confidence: 0.5,
    source: "admin",
    last_error: "HTTP 404",
    admin_review_status: "open",
    updated_at: "2026-07-17T12:00:00.000Z",
    ...overrides,
  };
}

function atomicCleanupSupabase(database, mutateBeforeCompare = null) {
  const calls = [];
  return {
    calls,
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      if (mutateBeforeCompare) mutateBeforeCompare();
      const plan = parameters.p_plan;
      const currentAward = {
        id: database.award.id,
        name: database.award.name,
        official_homepage: database.award.official_homepage,
        status: database.award.status,
        updated_at: database.award.updated_at,
      };
      if (JSON.stringify(currentAward) !== JSON.stringify(plan.expected_award)) {
        return conflict("Shared award changed after cleanup planning; requeue cleanup.");
      }
      const currentSources = [...database.sources]
        .map(buildExpectedSourceRetirementState)
        .sort((left, right) => left.id.localeCompare(right.id));
      if (JSON.stringify(currentSources) !== JSON.stringify(plan.expected_sources)) {
        return conflict("Award source set changed after cleanup planning; requeue cleanup.");
      }

      for (const source of database.sources) {
        if (plan.retire_source_ids.includes(source.id)) {
          source.admin_review_status = "review_later";
          source.updated_at = "2026-07-17T12:10:00.000Z";
        }
      }
      database.award.official_homepage = plan.homepage.new_url;
      database.award.updated_at = "2026-07-17T12:10:00.000Z";
      return {
        data: [{
          shared_award_id: database.award.id,
          retired_source_count: plan.retire_source_ids.length,
          matched_event_count: 0,
          newly_suppressed_event_count: 0,
          homepage_changed: plan.homepage.old_url !== plan.homepage.new_url,
        }],
        error: null,
      };
    },
  };
}

function conflict(message) {
  return { data: null, error: { code: "40001", message } };
}
