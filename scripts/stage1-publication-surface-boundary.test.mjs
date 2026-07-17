import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const eventSurfaces = [
  "src/lib/public-award-pages.ts",
  "src/lib/live-updates.ts",
  "src/lib/public-updates.ts",
  "src/app/award-directory/page.tsx",
  "src/app/api/shared-awards/[id]/route.ts",
  "src/app/api/shared-award-change-reads/route.ts",
  "src/app/api/change-events/[eventId]/visual-evidence/route.ts",
];

describe("Stage 1 public-surface boundary", () => {
  it("uses the central immutable-event predicate on every event surface", () => {
    expect(read("src/lib/public-change-events.ts")).toContain("isPublicChangeEvent");
    for (const path of eventSurfaces) {
      const source = read(path);
      expect(
        source.includes("isPublicChangeEvent") ||
          source.includes("loadEligiblePublicChangeEvents"),
        path,
      ).toBe(true);
    }
  });

  it("requires reviewed manifest source IDs on every source publication or tracking surface", () => {
    for (const path of [
      "src/lib/public-award-pages.ts",
      "src/app/api/shared-awards/[id]/route.ts",
      "src/app/api/shared-awards/[id]/track/route.ts",
      "src/app/api/shared-awards/[id]/sources/[sourceId]/track/route.ts",
      "src/lib/public-change-event.ts",
    ]) {
      expect(read(path), path).toContain("allowedSourceIdSet");
    }
  });

  it("renders registry identity and ledger facts instead of mutable catalog identity", () => {
    for (const path of [
      "src/lib/public-award-pages.ts",
      "src/lib/live-updates.ts",
      "src/lib/public-updates.ts",
      "src/app/award-directory/page.tsx",
      "src/app/api/shared-awards/[id]/route.ts",
    ]) {
      const source = read(path);
      expect(source, path).toContain("registry.canonical_name");
    }
    expect(read("src/lib/public-award-pages.ts")).toContain(
      "public_facts: publication.publishedFacts",
    );
    expect(read("src/app/award-directory/page.tsx")).toContain(
      "public_facts: publication.publishedFacts",
    );
  });

  it("keeps unverified pages honest and out of discovery", () => {
    const awardPage = read("src/app/[slug]/page.tsx");
    const sitemap = read("src/lib/public-award-pages.ts");
    expect(awardPage).toContain('resolution.kind === "under_verification"');
    expect(awardPage).toContain("robots: { index: false, follow: false }");
    expect(sitemap).toContain("publicationIndex.verifiedEntries");
  });

  it("never fabricates or substitutes an unreviewed official homepage", () => {
    const pageLoader = read("src/lib/public-award-pages.ts");
    const api = read("src/app/api/shared-awards/[id]/route.ts");
    for (const source of [pageLoader, api]) {
      expect(source).toContain("publication.officialHomepageSourceId");
      expect(source).toContain(
        "source.url === publication.registry.official_homepage",
      );
      expect(source).not.toContain("displayHomepageForAward(");
    }
    expect(pageLoader).not.toContain("withHomepageFallbackSource");
    expect(pageLoader).not.toContain("official-homepage-${award.id}");
  });

  it("keeps authenticated operator routes functional after raw catalog grants are revoked", () => {
    const opsPage = read("src/app/dashboard/ops/page.tsx");
    const pipelineRedirect = read("src/app/dashboard/pipeline/[id]/page.tsx");

    expect(opsPage.indexOf("if (!isSiteAdminEmail(user.email))")).toBeLessThan(
      opsPage.indexOf("const admin = createSupabaseAdminClient()"),
    );
    expect(opsPage).toContain("const userSupabase = await createSupabaseServerClient()");
    expect(opsPage).toContain("const admin = createSupabaseAdminClient()");
    expect(opsPage).toMatch(/userSupabase\s*\.from\("alert_deliveries"\)/);
    expect(opsPage).toMatch(/admin\s*\.from\("shared_award_sources"\)/);
    expect(pipelineRedirect).toMatch(/supabase\s*\.from\("awards"\)/);
    expect(pipelineRedirect).toContain("const admin = createSupabaseAdminClient()");
    expect(pipelineRedirect).toMatch(/admin\s*\.from\("shared_awards"\)/);
  });

  it("authorizes raw snapshot operators before querying mutable evidence", () => {
    const route = read("src/app/api/source-snapshots/[sourceId]/route.ts");
    const authorization = route.indexOf("if (!canViewSnapshot(user))");
    const lookup = route.indexOf('.from("shared_award_source_visual_snapshots")');

    expect(authorization).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(authorization);
    expect(route).not.toContain("{ error: error.message }");
  });
});
