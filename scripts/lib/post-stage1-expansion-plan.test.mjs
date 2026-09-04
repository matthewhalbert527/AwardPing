import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { awardSeeds } from "../../src/lib/award-seeds.ts";
import { awardSourceOverrides } from "../../src/lib/award-source-overrides.ts";
import { isTrackableOfficialSourceUrl } from "../../src/lib/source-url-policy.ts";
import { stage1CohortIdentity } from "../../src/lib/stage1-cohort-identity.ts";
import { STAGE1_COHORT_DEFINITION } from "./stage1-cohort-readiness.mjs";
import {
  POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
  POST_STAGE1_EXPANSION_PLAN_VERSION,
  buildPostStage1ExpansionPlan,
  computePlanHash,
  stage1IdentityContentDigest,
} from "./post-stage1-expansion-plan.mjs";

const CONFIG_PATH = resolve(import.meta.dirname, "..", "..", "config", "post-stage1-expansion-candidates.json");

function loadRealConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

// Real Stage 1 identity, assembled from the two real sources: readiness
// (name/aliases/homepage) and identity (slug) - the same real cohortKey
// joins both, so this is not a third, drifting copy of Stage 1 data. This is
// the exact, unmodified, real 25-entry cohort - the only shape the builder's
// exact-anchoring check accepts.
function realStage1Identity() {
  const identityByCohortKey = new Map(stage1CohortIdentity.map((row) => [row[1], row]));
  return STAGE1_COHORT_DEFINITION.map((cohort) => {
    const identityRow = identityByCohortKey.get(cohort.cohortKey);
    return {
      cohortKey: cohort.cohortKey,
      canonicalName: cohort.canonicalName,
      canonicalSearchKey: cohort.canonicalSearchKey,
      aliasSearchKeys: cohort.aliasSearchKeys,
      canonicalSlug: identityRow[4],
      officialHomepage: cohort.officialHomepage,
    };
  });
}

function buildProductionPlan() {
  return buildPostStage1ExpansionPlan({
    config: loadRealConfig(),
    seeds: awardSeeds,
    overrides: awardSourceOverrides,
    stage1Identity: realStage1Identity(),
  });
}

const VALID_CONFIG = Object.freeze({
  schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
  candidates: [{ candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship", status: "provisional" }],
});

const SYNTHETIC_SEEDS = Object.freeze([{ name: "Mitchell Scholarship", starterUrl: "https://onsa.asu.edu/scholarship/mitchell-scholarship" }]);

const SYNTHETIC_OVERRIDES = Object.freeze([
  {
    awardName: "Mitchell Scholarship",
    sources: [
      { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
      { url: "https://us-irelandalliance.org/mitchellscholarship/applicants", title: "Applicants", pageType: "application", confidence: 0.9, reason: "x" },
    ],
  },
]);

// The default Stage1 fixture for every test that isn't itself testing Stage1
// identity shape/anchoring: the real, exact, unmodified 25-entry cohort.
// Anything smaller or larger now fails the exact-anchoring check before any
// other code path runs, so tests exercising a DIFFERENT failure must still
// supply this real, valid 25.
function baseInput(overrides = {}) {
  return {
    config: overrides.config ?? VALID_CONFIG,
    seeds: overrides.seeds ?? SYNTHETIC_SEEDS,
    overrides: overrides.overrides ?? SYNTHETIC_OVERRIDES,
    stage1Identity: overrides.stage1Identity ?? realStage1Identity(),
  };
}

// A minimal, fully-formed plan object for direct computePlanHash unit tests -
// used to prove mutation-sensitivity for fields (lifecycle in particular)
// that are never actually reachable as *different* values through the public
// builder API, since the builder always pins them to the same constants.
function samplePlan(overrides = {}) {
  return {
    candidateId: "mitchell",
    awardName: "Mitchell Scholarship",
    normalizedAwardKey: "mitchell scholarship",
    status: "provisional",
    slug: "mitchell-scholarship",
    seed: { seedIndex: 141, name: "Mitchell Scholarship", starterUrl: "https://onsa.asu.edu/scholarship/mitchell-scholarship" },
    excludedDiscoveryUrls: ["https://onsa.asu.edu/scholarship/mitchell-scholarship"],
    homepage: { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", confidence: 0.95 },
    monitorableSources: [
      { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, canonicalUrlKey: "us-irelandalliance.org/mitchellscholarship" },
      { url: "https://us-irelandalliance.org/mitchellscholarship/applicants", title: "Applicants", pageType: "application", confidence: 0.9, canonicalUrlKey: "us-irelandalliance.org/mitchellscholarship/applicants" },
    ],
    lifecycle: {
      currentCycleAuthority: "unresolved",
      humanSourceReview: "unresolved",
      remoteIdentityCollisionCheck: "unresolved",
      monitoringReadiness: false,
      publicationEligibility: false,
    },
    ...overrides,
  };
}

describe("post-Stage1 expansion plan", () => {
  it("builds exactly one provisional Mitchell plan from real production data: 12 monitorable sources, one homepage, ASU discovery URL excluded", () => {
    const result = buildProductionPlan();

    expect(result.version).toBe(POST_STAGE1_EXPANSION_PLAN_VERSION);
    expect(result.totals.candidates).toBe(1);
    expect(result.plans).toHaveLength(1);

    const plan = result.plans[0];
    expect(plan.candidateId).toBe("mitchell");
    expect(plan.awardName).toBe("Mitchell Scholarship");
    expect(plan.slug).toBe("mitchell-scholarship");
    expect(plan.status).toBe("provisional");

    expect(plan.monitorableSources).toHaveLength(12);
    expect(new Set(plan.monitorableSources.map((s) => s.canonicalUrlKey)).size).toBe(12);
    expect(plan.monitorableSources.filter((s) => s.pageType === "homepage")).toHaveLength(1);
    expect(plan.homepage.url).toBe("https://us-irelandalliance.org/mitchellscholarship");

    // The ASU seed URL never appears as a monitorable source, and is
    // explicitly recorded as excluded rather than silently dropped.
    expect(plan.seed.starterUrl).toBe("https://onsa.asu.edu/scholarship/mitchell-scholarship");
    expect(plan.excludedDiscoveryUrls).toEqual(["https://onsa.asu.edu/scholarship/mitchell-scholarship"]);
    expect(plan.monitorableSources.some((s) => s.url === plan.seed.starterUrl)).toBe(false);
    expect(plan.monitorableSources.every((s) => !s.url.includes("onsa.asu.edu"))).toBe(true);

    // Every source is HTTPS.
    for (const source of plan.monitorableSources) {
      expect(new URL(source.url).protocol, source.url).toBe("https:");
    }

    // Lifecycle is pinned unresolved/false - never an affirmative claim.
    expect(plan.lifecycle).toEqual({
      currentCycleAuthority: "unresolved",
      humanSourceReview: "unresolved",
      remoteIdentityCollisionCheck: "unresolved",
      monitoringReadiness: false,
      publicationEligibility: false,
    });

    expect(typeof plan.planHash).toBe("string");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs the production build with fetch and other side-effect APIs poisoned", () => {
    const poison = (label) => () => {
      throw new Error(`post-stage1 expansion plan attempted ${label}`);
    };
    vi.stubGlobal("fetch", poison("fetch"));
    vi.stubGlobal("XMLHttpRequest", poison("XMLHttpRequest"));
    vi.stubGlobal("WebSocket", poison("WebSocket"));
    vi.stubGlobal("EventSource", poison("EventSource"));
    vi.stubGlobal("Worker", poison("Worker"));
    vi.stubGlobal("setTimeout", poison("setTimeout"));
    vi.stubGlobal("setInterval", poison("setInterval"));
    vi.stubGlobal("Date", class extends Date {
      constructor(...args) {
        if (args.length === 0) throw new Error("post-stage1 expansion plan attempted clock access");
        super(...args);
      }
      static now() {
        throw new Error("post-stage1 expansion plan attempted clock access");
      }
    });
    vi.stubGlobal("Math", { ...Math, random: poison("Math.random") });

    try {
      const result = buildProductionPlan();
      expect(result.totals.candidates).toBe(1);
      expect(result.plans[0].monitorableSources).toHaveLength(12);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the module free of network, filesystem, clock, randomness, and environment access at the source level", () => {
    const source = readFileSync(resolve(import.meta.dirname, "post-stage1-expansion-plan.mjs"), "utf8");

    // Positive control: prove this really is the module's own source.
    expect(source).toContain("export function buildPostStage1ExpansionPlan");
    expect(source).toContain("normalizeSharedAwardKey");

    const forbiddenBuiltins = ["fs", "http", "https", "net", "dns", "dgram", "child_process", "worker_threads", "tls"];
    for (const builtin of forbiddenBuiltins) {
      expect(source, `node:${builtin} import`).not.toMatch(new RegExp(`from\\s+["'](?:node:)?${builtin}["']`));
    }
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew Date\s*\(/);
    expect(source).not.toMatch(/\bMath\.random\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
  });

  it("is deterministic across repeated calls and stable under candidate re-ordering", () => {
    const first = buildProductionPlan();
    const second = buildProductionPlan();
    expect(second).toEqual(first);
    expect(second.plans[0].planHash).toBe(first.plans[0].planHash);
  });

  it("performs an exact join: rejects an orphan candidate with no matching seed", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "ghost", awardName: "Ghost Scholarship", status: "provisional" }] } }),
      ),
    ).toThrow(/matched no seed \(orphan candidate\)/);
  });

  it("rejects an ambiguous seed join when more than one seed matches", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({ seeds: [...SYNTHETIC_SEEDS, { name: "Mitchell Scholarship", starterUrl: "https://other.example.org/mitchell" }] }),
      ),
    ).toThrow(/matched 2 seed entries \(ambiguous join\)/);
  });

  it("rejects an orphan candidate with no matching override declaration", () => {
    expect(() => buildPostStage1ExpansionPlan(baseInput({ overrides: [] }))).toThrow(
      /matched no override declaration \(orphan candidate\)/,
    );
  });

  it("rejects an ambiguous override join when more than one override declaration matches", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ overrides: [...SYNTHETIC_OVERRIDES, { awardName: "Mitchell Scholarship", sources: SYNTHETIC_OVERRIDES[0].sources }] })),
    ).toThrow(/matched 2 override declaration entries \(ambiguous join\)/);
  });

  it("never selects a candidate implicitly or broadly: a near-miss award name does not join", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({ seeds: [{ name: "Mitchell Scholarship Program", starterUrl: "https://onsa.asu.edu/scholarship/mitchell-scholarship" }] }),
      ),
    ).toThrow(/matched no seed \(orphan candidate\)/);
  });

  it("fails closed on a candidate overlapping Stage 1's real canonical name, alias, cohort key, or slug", () => {
    // Canonical name overlap, against the real frozen Boren entry.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "boren_copy", awardName: "Boren Scholarships and Fellowships", status: "provisional" }] },
          seeds: [{ name: "Boren Scholarships and Fellowships", starterUrl: "https://example.org/x" }],
          overrides: [{ awardName: "Boren Scholarships and Fellowships", sources: [{ url: "https://example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/overlaps a frozen Stage 1 canonical\/alias name key/);

    // Alias overlap, against the real frozen Boren entry's real alias.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "boren_alias_copy", awardName: "Boren Awards for International Study", status: "provisional" }] },
          seeds: [{ name: "Boren Awards for International Study", starterUrl: "https://example.org/x" }],
          overrides: [{ awardName: "Boren Awards for International Study", sources: [{ url: "https://example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/overlaps a frozen Stage 1 canonical\/alias name key/);

    // Cohort key overlap: candidateId literally equals a real Stage 1
    // cohortKey ("boren"), for a totally different award name.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "boren", awardName: "Totally Different Award", status: "provisional" }] },
          seeds: [{ name: "Totally Different Award", starterUrl: "https://different.example.org/x" }],
          overrides: [{ awardName: "Totally Different Award", sources: [{ url: "https://different.example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/overlaps a frozen Stage 1 cohort key/);

    // Slug overlap: candidate's slug equals the real Boren canonicalSlug.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "slug_hit", awardName: "Totally Different Award", slug: "boren-awards", status: "provisional" }] },
          seeds: [{ name: "Totally Different Award", starterUrl: "https://different.example.org/x" }],
          overrides: [{ awardName: "Totally Different Award", sources: [{ url: "https://different.example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/overlaps a frozen Stage 1 slug/);
  });

  it("rejects overlap with a frozen Stage 1 homepage for EVERY candidate-related URL, independent of pageType: an application-labeled override source", () => {
    // Adversarial: the URL is the real Marshall Scholarship homepage, but
    // labeled "application" rather than "homepage". A pageType-gated check
    // would miss this entirely - the candidate still needs its own genuine
    // homepage-role source to pass the earlier "has no homepage-role source"
    // check, so this fixture supplies one too.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "homepage_app_hit", awardName: "Totally Different Award", status: "provisional" }] },
          seeds: [{ name: "Totally Different Award", starterUrl: "https://different.example.org/x" }],
          overrides: [{
            awardName: "Totally Different Award",
            sources: [
              { url: "https://different.example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://www.marshallscholarship.org/", title: "Apply", pageType: "application", confidence: 0.9, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/URL "https:\/\/www\.marshallscholarship\.org\/" overlaps a frozen Stage 1 homepage/);

    // Same again labeled "other", proving it is not merely "application"
    // that is checked but every source regardless of its declared role.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "homepage_other_hit", awardName: "Another Different Award", status: "provisional" }] },
          seeds: [{ name: "Another Different Award", starterUrl: "https://different2.example.org/x" }],
          overrides: [{
            awardName: "Another Different Award",
            sources: [
              { url: "https://different2.example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://www.marshallscholarship.org/", title: "Misc", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/URL "https:\/\/www\.marshallscholarship\.org\/" overlaps a frozen Stage 1 homepage/);
  });

  it("rejects overlap with a frozen Stage 1 homepage for the joined seed's own URL", () => {
    // The seed URL itself (not any override source) is the real Truman
    // Scholarship homepage.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "seed_homepage_hit", awardName: "Yet Another Award", status: "provisional" }] },
          seeds: [{ name: "Yet Another Award", starterUrl: "https://www.truman.gov/apply" }],
          overrides: [{ awardName: "Yet Another Award", sources: [{ url: "https://different3.example.org/x", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/URL "https:\/\/www\.truman\.gov\/apply" overlaps a frozen Stage 1 homepage/);
  });

  it("cannot be bypassed by DNS trailing dots, percent-encoded unreserved characters, query, fragment, or port", () => {
    // Each of these resolves to the frozen Truman homepage but was accepted
    // by the previous revision, because the dedup canonicalizer preserves
    // exactly the differences an attacker controls.
    const bypasses = [
      ["trailing DNS dot", "https://www.truman.gov./apply"],
      ["percent-encoded unreserved char", "https://www.truman.gov/%61pply"],
      ["appended query", "https://www.truman.gov/apply?ref=x"],
      ["appended fragment", "https://www.truman.gov/apply#section"],
      ["non-default port", "https://www.truman.gov:8443/apply"],
      ["userinfo prefix", "https://user:pass@www.truman.gov/apply"],
      ["uppercase host", "https://WWW.TRUMAN.GOV/apply"],
    ];
    for (const [label, starterUrl] of bypasses) {
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "bypass_probe", awardName: "Bypass Probe Award", status: "provisional" }] },
            seeds: [{ name: "Bypass Probe Award", starterUrl }],
            overrides: [{ awardName: "Bypass Probe Award", sources: [{ url: "https://bypass-probe.example.org/", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
          }),
        ),
        label,
      ).toThrow(/overlaps a frozen Stage 1 homepage/);
    }

    // The same normalization applies to an override source, whatever its
    // caller-supplied pageType claims.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "bypass_source", awardName: "Bypass Source Award", status: "provisional" }] },
          seeds: [{ name: "Bypass Source Award", starterUrl: "https://bypass-source.example.org/seed" }],
          overrides: [{
            awardName: "Bypass Source Award",
            sources: [
              { url: "https://bypass-source.example.org/", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://www.truman.gov./%61pply?ref=x", title: "Misc", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/overlaps a frozen Stage 1 homepage/);

    // A genuinely different path on the same host is still allowed - this is
    // a normalization fix, not a blanket host ban.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "same_host_ok", awardName: "Same Host Award", status: "provisional" }] },
          seeds: [{ name: "Same Host Award", starterUrl: "https://www.truman.gov/some-other-page" }],
          overrides: [{ awardName: "Same Host Award", sources: [{ url: "https://same-host.example.org/", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).not.toThrow();
  });

  it("detects an institutional discovery host spelled with a trailing DNS dot", () => {
    // isInstitutionalDiscoveryUrl matches on exact hostname, so "onsa.asu.edu."
    // slipped past it in the previous revision and became a monitorable source.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
              { url: "https://onsa.asu.edu./scholarship/mitchell-scholarship", title: "ASU listing", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/is an institutional discovery URL and cannot be monitorable/);

    // And the seed's own discovery URL is still recognized (and excluded)
    // when spelled the same way.
    const plan = buildPostStage1ExpansionPlan(
      baseInput({ seeds: [{ name: "Mitchell Scholarship", starterUrl: "https://onsa.asu.edu./scholarship/mitchell-scholarship" }] }),
    ).plans[0];
    expect(plan.excludedDiscoveryUrls).toEqual(["https://onsa.asu.edu./scholarship/mitchell-scholarship"]);
  });

  it("normalizes and validates candidateId and slug as canonical identifiers, rejecting uppercase and whitespace bypasses", () => {
    const cases = [
      [" mitchell", /candidateId must be a canonical identifier/],
      ["mitchell ", /candidateId must be a canonical identifier/],
      ["Mitchell", /candidateId must be a canonical identifier/],
      ["MITCHELL", /candidateId must be a canonical identifier/],
      ["mitchell-scholarship", /candidateId must be a canonical identifier/], // hyphen not allowed in an id
      ["2mitchell", /candidateId must be a canonical identifier/], // must start with a letter
      // True canonical snake_case: underscores separate segments, and can
      // never lead, trail, or repeat. Each of these is a second spelling of
      // an existing identity that would never compare equal to it.
      ["mitchell_", /candidateId must be a canonical identifier/],
      ["mitchell__copy", /candidateId must be a canonical identifier/],
      ["_mitchell", /candidateId must be a canonical identifier/],
      ["mitchell___", /candidateId must be a canonical identifier/],
    ];
    for (const [candidateId, pattern] of cases) {
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId, awardName: "Mitchell Scholarship", status: "provisional" }] } }),
        ),
        candidateId,
      ).toThrow(pattern);
    }

    const slugCases = [
      [" mitchell-scholarship", /slug must be a canonical identifier/],
      ["mitchell-scholarship ", /slug must be a canonical identifier/],
      ["Mitchell-Scholarship", /slug must be a canonical identifier/],
      ["MITCHELL-SCHOLARSHIP", /slug must be a canonical identifier/],
      ["mitchell_scholarship", /slug must be a canonical identifier/], // underscore not allowed in a slug
    ];
    for (const [slug, pattern] of slugCases) {
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "mitchell", awardName: "Mitchell Scholarship", slug, status: "provisional" }] } }),
        ),
        slug,
      ).toThrow(pattern);
    }

    // The canonical forms are still accepted - this is a rejection of
    // non-canonical bypasses, not of the identifiers themselves.
    expect(() => buildPostStage1ExpansionPlan(baseInput())).not.toThrow();

    // A single separating underscore is canonical and still accepted, as are
    // all 25 real Stage 1 cohort keys (several of which use one).
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "mitchell_copy", awardName: "Mitchell Scholarship", status: "provisional" }] } }),
      ),
    ).not.toThrow();
    for (const row of realStage1Identity()) {
      expect(row.cohortKey, row.cohortKey).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
  });

  it("fails closed on malformed candidate config", () => {
    const cases = [
      [{ ...VALID_CONFIG, schema: "wrong-schema" }, /config\.schema must be/],
      [{ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [] }, /config\.candidates must not be empty/],
      [{ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "", awardName: "A", status: "provisional" }] }, /candidateId must be a canonical identifier/],
      [{ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "a", awardName: "", status: "provisional" }] }, /awardName must be a non-empty string/],
      [{ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "a", awardName: "A", status: "ready" }] }, /status must be one of/],
      [{ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [{ candidateId: "a", awardName: "A", status: "provisional", slug: "" }] }, /slug must be a canonical identifier/],
    ];
    for (const [config, pattern] of cases) {
      expect(() => buildPostStage1ExpansionPlan(baseInput({ config })), String(pattern)).toThrow(pattern);
    }
  });

  it("fails closed on a sparse candidates array and a sparse override sources array", () => {
    // A genuine hole (not an explicit undefined element) at index 1 of a
    // 2-length candidates array - Array.prototype.map/forEach would skip it
    // silently; direct indexing must not.
    const sparseCandidates = [{ candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" }];
    sparseCandidates.length = 2;
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: sparseCandidates } })),
    ).toThrow(/config\.candidates\[1\] is a hole/);

    const sparseSources = [SYNTHETIC_OVERRIDES[0].sources[0]];
    sparseSources.length = 2;
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: sparseSources }] })),
    ).toThrow(/overrides\[0\]\.sources\[1\] is a hole/);
  });

  it("rejects a hole that a prototype-inherited numeric index would otherwise fill", () => {
    // Reading array[index] is not enough to detect a hole: it resolves
    // through the prototype chain, so an inherited numeric index silently
    // supplies an element the caller never wrote. Against the previous
    // revision this injected source was accepted and became a monitorable
    // source in the returned plan.
    const injected = { url: "https://us-irelandalliance.org/injected-by-prototype", title: "Injected", pageType: "other", confidence: 0.5 };
    const sparseSources = [SYNTHETIC_OVERRIDES[0].sources[0]];
    sparseSources.length = 2;
    expect(Object.hasOwn(sparseSources, 1)).toBe(false);

    Object.defineProperty(Array.prototype, 1, { value: injected, configurable: true, writable: true });
    try {
      // The hole still reads as the injected object ...
      expect(sparseSources[1]).toBe(injected);
      expect(Object.hasOwn(sparseSources, 1)).toBe(false);
      // ... but is rejected as the hole it actually is.
      expect(() =>
        buildPostStage1ExpansionPlan(baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: sparseSources }] })),
      ).toThrow(/overrides\[0\]\.sources\[1\] is a hole/);
    } finally {
      delete Array.prototype[1];
    }
    expect(Object.hasOwn(Array.prototype, 1)).toBe(false);
  });

  it("requires the joined seed's URL to be a valid, absolute HTTPS URL, without rejecting unrelated non-HTTPS seeds elsewhere in the catalog", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ seeds: [{ name: "Mitchell Scholarship", starterUrl: "http://onsa.asu.edu/scholarship/mitchell-scholarship" }] })),
    ).toThrow(/joined seed starterUrl must be an absolute HTTPS URL/);

    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ seeds: [{ name: "Mitchell Scholarship", starterUrl: "not a url at all" }] })),
    ).toThrow(/joined seed starterUrl must be an absolute HTTPS URL/);

    // An unrelated seed elsewhere in the catalog being non-HTTPS (the real
    // production shape: 18 such seeds exist among 1,157) must not itself
    // reject the whole seeds array - only the JOINED seed is required to be
    // HTTPS. The full production build already proves this by using the
    // real, unfiltered awardSeeds array successfully elsewhere in this file;
    // this constructs the same shape explicitly.
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ seeds: [...SYNTHETIC_SEEDS, { name: "Unrelated Award", starterUrl: "http://unrelated.example.org/" }] })),
    ).not.toThrow();
  });

  it("requires override source confidence to be finite and within [0, 1]", () => {
    const cases = [Infinity, -Infinity, NaN, 1.5, -0.1, "0.9"];
    for (const confidence of cases) {
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            overrides: [{
              awardName: "Mitchell Scholarship",
              sources: [
                { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
                { url: "https://us-irelandalliance.org/mitchellscholarship/applicants", title: "Applicants", pageType: "application", confidence, reason: "x" },
              ],
            }],
          }),
        ),
        String(confidence),
      ).toThrow(/confidence must be a finite number between 0 and 1/);
    }
    // Boundary values are accepted.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0, reason: "x" },
              { url: "https://us-irelandalliance.org/mitchellscholarship/applicants", title: "Applicants", pageType: "application", confidence: 1, reason: "x" },
            ],
          }],
        }),
      ),
    ).not.toThrow();
  });

  it("fails closed on duplicate candidate ids and duplicate candidate award names", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: {
            schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
            candidates: [
              { candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" },
              { candidateId: "mitchell", awardName: "Some Other Award", status: "provisional" },
            ],
          },
        }),
      ),
    ).toThrow(/duplicate candidateId "mitchell"/);

    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          config: {
            schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
            candidates: [
              { candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" },
              { candidateId: "mitchell2", awardName: "mitchell   scholarship", status: "provisional" },
            ],
          },
        }),
      ),
    ).toThrow(/duplicate awardName/);
  });

  it("rejects non-HTTPS and non-trackable override sources", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{ awardName: "Mitchell Scholarship", sources: [{ url: "http://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/is not HTTPS/);

    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://us-irelandalliance.org/mitchellscholarship/careers/apply", title: "Careers", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/is not a trackable official source URL/);
  });

  it("rejects duplicate canonical source URLs within one candidate's override sources", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://us-irelandalliance.org/mitchellscholarship/", title: "Home dup", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/duplicate canonical source URL/);
  });

  it("rejects a missing homepage-role source and a plan with more than one", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{ awardName: "Mitchell Scholarship", sources: [{ url: "https://us-irelandalliance.org/mitchellscholarship/applicants", title: "Applicants", pageType: "application", confidence: 0.9, reason: "x" }] }],
        }),
      ),
    ).toThrow(/has no homepage-role source/);

    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://mitchell.us-irelandalliance.org/", title: "Home 2", pageType: "homepage", confidence: 0.9, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/has 2 homepage-role sources \(must be exactly one\)/);
  });

  it("rejects an institutional discovery URL declared as a monitorable override source", () => {
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
              { url: "https://onsa.asu.edu/scholarship/mitchell-scholarship", title: "ASU listing", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/is an institutional discovery URL and cannot be monitorable/);
  });

  it("binds the complete canonical Stage 1 identity content, not merely the 25 cohort keys", () => {
    const real = realStage1Identity();

    // Every mutation below keeps all 25 correct cohort keys, so the count and
    // membership checks all still pass - and the previous revision accepted
    // each of them, then went on to protect the rewritten values instead of
    // the real ones.
    const mutateBoren = (patch) => real.map((row) => (row.cohortKey === "boren" ? { ...row, ...patch } : row));

    const contentMutations = [
      ["canonicalName", mutateBoren({ canonicalName: "Totally Fake Award" })],
      ["canonicalSearchKey", mutateBoren({ canonicalSearchKey: "totally fake award" })],
      ["aliasSearchKeys emptied", mutateBoren({ aliasSearchKeys: [] })],
      ["aliasSearchKeys rewritten", mutateBoren({ aliasSearchKeys: ["something else entirely"] })],
      ["canonicalSlug", mutateBoren({ canonicalSlug: "totally-fake-slug" })],
      [
        "names, aliases and slug together",
        mutateBoren({
          canonicalName: "Totally Fake Award",
          canonicalSearchKey: "totally fake award",
          aliasSearchKeys: [],
          canonicalSlug: "totally-fake-slug",
        }),
      ],
    ];
    for (const [label, stage1Identity] of contentMutations) {
      expect(stage1Identity).toHaveLength(25);
      expect(new Set(stage1Identity.map((row) => row.cohortKey)).size).toBe(25);
      expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity })), label).toThrow(
        /stage1Identity content does not match the frozen Stage 1 identity digest/,
      );
    }

    // The homepage is bound separately, because it is the value every URL
    // collision check compares against: rewriting it would quietly retire the
    // protection for the real Boren homepage.
    expect(() =>
      buildPostStage1ExpansionPlan(baseInput({ stage1Identity: mutateBoren({ officialHomepage: "https://attacker.example.org/" }) })),
    ).toThrow(/stage1Identity content does not match the frozen Stage 1 identity digest/);

    // Semantically empty ordering IS accepted, deliberately: the row array and
    // each row's alias list are both sets, so re-ordering either must not be
    // treated as tampering.
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: [...real].reverse() }))).not.toThrow();
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          stage1Identity: real.map((row) => ({ ...row, aliasSearchKeys: [...row.aliasSearchKeys].reverse() })),
        }),
      ),
    ).not.toThrow();

    // And the digest helper itself is order-insensitive but content-sensitive.
    expect(stage1IdentityContentDigest([...real].reverse())).toBe(stage1IdentityContentDigest(real));
    expect(stage1IdentityContentDigest(mutateBoren({ canonicalName: "x" }))).not.toBe(stage1IdentityContentDigest(real));
    expect(stage1IdentityContentDigest(real)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces the exact frozen Stage 1 cohort of 25 identities, not an arbitrary subset or superset", () => {
    const real = realStage1Identity();
    expect(real).toHaveLength(25);

    // The real, exact 25 is accepted.
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: real }))).not.toThrow();

    // A subset (24 - one real cohort removed) is rejected on count alone.
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: real.slice(0, 24) }))).toThrow(
      /stage1Identity must contain exactly the 25 frozen Stage 1 cohort entries; got 24/,
    );

    // A superset (26 - a real 25 plus one extra, otherwise well-formed and
    // not overlapping any candidate by name) is rejected on count alone,
    // before the extra entry's content is ever considered.
    const superset = [...real, {
      cohortKey: "intruder",
      canonicalName: "Intruder Award",
      canonicalSearchKey: "intruder award",
      aliasSearchKeys: [],
      canonicalSlug: "intruder-award",
      officialHomepage: "https://intruder.example.org/",
    }];
    expect(superset).toHaveLength(26);
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: superset }))).toThrow(
      /stage1Identity must contain exactly the 25 frozen Stage 1 cohort entries; got 26/,
    );

    // Exactly 25 rows, but one real cohortKey substituted for an unexpected
    // one - the right COUNT is not the same as the right MEMBERS.
    const substituted = [...real.slice(0, 24), {
      cohortKey: "impostor",
      canonicalName: "Impostor Award",
      canonicalSearchKey: "impostor award",
      aliasSearchKeys: [],
      canonicalSlug: "impostor-award",
      officialHomepage: "https://impostor.example.org/",
    }];
    expect(substituted).toHaveLength(25);
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: substituted }))).toThrow(
      /stage1Identity is missing the frozen Stage 1 cohort key/,
    );

    // Exactly 25 rows, but one real cohortKey duplicated (crowding out
    // another) - still 25 rows, still fails.
    const duplicated = [...real.slice(0, 24), { ...real[0] }];
    expect(duplicated).toHaveLength(25);
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: duplicated }))).toThrow(
      /stage1Identity has a duplicate cohortKey/,
    );

    // A whitespace/case bypass on a Stage 1 cohortKey or slug is rejected the
    // same way a candidate's would be.
    const badCohortKey = real.map((row, index) => (index === 0 ? { ...row, cohortKey: `${row.cohortKey} ` } : row));
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: badCohortKey }))).toThrow(
      /cohortKey must be a canonical identifier/,
    );
    const badSlug = real.map((row, index) => (index === 0 ? { ...row, canonicalSlug: row.canonicalSlug.toUpperCase() } : row));
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: badSlug }))).toThrow(
      /canonicalSlug must be a canonical identifier/,
    );
  });

  it("leaves the existing Stage 1 readiness cohort builder untouched: its own frozen array still rejects a push", () => {
    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);
    expect(() => {
      STAGE1_COHORT_DEFINITION.push({ cohortKey: "intruder" });
    }).toThrow();
    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);
  });

  describe("caller-object read/read TOCTOUs", () => {
    // A stateful accessor that answers differently on each read: the classic
    // shape of a validate-once/use-later hole.
    function statefulAccessor(firstRead, laterReads) {
      let reads = 0;
      return {
        get() {
          reads += 1;
          return reads === 1 ? firstRead : laterReads;
        },
        configurable: true,
        enumerable: true,
      };
    }

    it("rejects a stage1Identity row whose identity fields are answered by a stateful INHERITED accessor", () => {
      const real = realStage1Identity();
      const borenIndex = real.findIndex((row) => row.cohortKey === "boren");
      const boren = real[borenIndex];

      // The decoy values are what the overlap Sets used to be built from; the
      // genuine frozen values are what the content digest used to re-read. In
      // the previous revision that combination passed the digest with poisoned
      // Sets, and a Boren candidate was admitted.
      const poisonedPrototype = Object.defineProperties({}, {
        canonicalName: statefulAccessor("Decoy Award", boren.canonicalName),
        canonicalSearchKey: statefulAccessor("decoy award", boren.canonicalSearchKey),
        aliasSearchKeys: statefulAccessor([], boren.aliasSearchKeys),
        canonicalSlug: statefulAccessor("decoy-slug", boren.canonicalSlug),
        officialHomepage: statefulAccessor("https://decoy.example.org/", boren.officialHomepage),
      });
      const poisonedRow = Object.create(poisonedPrototype);
      poisonedRow.cohortKey = "boren";

      const stage1Identity = real.map((row, index) => (index === borenIndex ? poisonedRow : row));

      // The candidate IS Boren. It must never be admitted, whatever the row
      // chooses to report on any given read.
      expect(() =>
        buildPostStage1ExpansionPlan({
          config: {
            schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
            candidates: [{ candidateId: "boren_copy", awardName: "Boren Scholarships and Fellowships", slug: "boren-awards", status: "provisional" }],
          },
          seeds: [{ name: "Boren Scholarships and Fellowships", starterUrl: "https://www.borenawards.org/" }],
          overrides: [{ awardName: "Boren Scholarships and Fellowships", sources: [{ url: "https://www.borenawards.org/", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" }] }],
          stage1Identity,
        }),
      ).toThrow(/stage1Identity\[14\] must be a plain object; its prototype is neither Object\.prototype nor null/);
    });

    it("rejects a stage1Identity row whose identity fields are OWN accessors", () => {
      const real = realStage1Identity();
      const borenIndex = real.findIndex((row) => row.cohortKey === "boren");
      const boren = real[borenIndex];
      const poisonedRow = { cohortKey: "boren", canonicalSearchKey: boren.canonicalSearchKey, aliasSearchKeys: boren.aliasSearchKeys, canonicalSlug: boren.canonicalSlug, officialHomepage: boren.officialHomepage };
      Object.defineProperty(poisonedRow, "canonicalName", statefulAccessor("Decoy Award", boren.canonicalName));

      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({ stage1Identity: real.map((row, index) => (index === borenIndex ? poisonedRow : row)) }),
        ),
      ).toThrow(/stage1Identity\[14\]\.canonicalName must be a plain data property, not an accessor/);
    });

    it("rejects a candidate whose status is an accessor that reports one value while validated and another when emitted", () => {
      const candidate = { candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship" };
      Object.defineProperty(candidate, "status", statefulAccessor("provisional", "ready"));

      expect(() =>
        buildPostStage1ExpansionPlan(baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidate] } })),
      ).toThrow(/config\.candidates\[0\]\.status must be a plain data property, not an accessor/);
    });

    it("rejects an accessor on every other externally supplied field of the same class", () => {
      // The status hole was not special: any field read during validation and
      // again during output has the same exposure, so every one of them is
      // snapshotted through an own data descriptor.
      const cases = [
        [
          "config.candidates[0].candidateId",
          () => {
            const candidate = { awardName: "Mitchell Scholarship", status: "provisional" };
            Object.defineProperty(candidate, "candidateId", statefulAccessor("mitchell", "boren"));
            return baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidate] } });
          },
        ],
        [
          "config.candidates[0].awardName",
          () => {
            const candidate = { candidateId: "mitchell", status: "provisional" };
            Object.defineProperty(candidate, "awardName", statefulAccessor("Mitchell Scholarship", "Boren Scholarships and Fellowships"));
            return baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidate] } });
          },
        ],
        [
          "config.candidates[0].slug",
          () => {
            const candidate = { candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" };
            Object.defineProperty(candidate, "slug", statefulAccessor("mitchell-scholarship", "boren-awards"));
            return baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidate] } });
          },
        ],
        [
          "seeds[0].starterUrl",
          () => {
            const seed = { name: "Mitchell Scholarship" };
            Object.defineProperty(seed, "starterUrl", statefulAccessor("https://onsa.asu.edu/scholarship/mitchell-scholarship", "https://www.truman.gov/apply"));
            return baseInput({ seeds: [seed] });
          },
        ],
        [
          "overrides[0].sources[0].url",
          () => {
            const source = { title: "Home", pageType: "homepage", confidence: 0.95 };
            Object.defineProperty(source, "url", statefulAccessor("https://us-irelandalliance.org/mitchellscholarship", "https://www.truman.gov/apply"));
            return baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: [source] }] });
          },
        ],
        [
          "overrides[0].sources[0].confidence",
          () => {
            const source = { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage" };
            Object.defineProperty(source, "confidence", statefulAccessor(0.95, 42));
            return baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: [source] }] });
          },
        ],
        [
          "config.candidates array element",
          () => {
            const candidates = [];
            Object.defineProperty(candidates, 0, statefulAccessor(
              { candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" },
              { candidateId: "boren", awardName: "Boren Scholarships and Fellowships", status: "provisional" },
            ));
            Object.defineProperty(candidates, "length", { value: 1, writable: true });
            return baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates } });
          },
        ],
      ];

      for (const [label, makeInput] of cases) {
        expect(() => buildPostStage1ExpansionPlan(makeInput()), label).toThrow(
          /must be a plain data property, not an accessor/,
        );
      }
    });

    it("rejects an externally supplied record with an exotic prototype", () => {
      const candidate = Object.create({ status: "provisional" });
      candidate.candidateId = "mitchell";
      candidate.awardName = "Mitchell Scholarship";
      expect(() =>
        buildPostStage1ExpansionPlan(baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidate] } })),
      ).toThrow(/config\.candidates\[0\] must be a plain object; its prototype is neither Object\.prototype nor null/);

      // A null-prototype record has nothing to inherit from, so it is fine.
      const nullProtoCandidate = Object.assign(Object.create(null), {
        candidateId: "mitchell",
        awardName: "Mitchell Scholarship",
        status: "provisional",
      });
      expect(() =>
        buildPostStage1ExpansionPlan(baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [nullProtoCandidate] } })),
      ).not.toThrow();
    });
  });

  it("applies the trackability policy to the safety-normalized URL as well as the raw one", () => {
    // Every one of these clears the policy in its raw spelling and is rejected
    // only once normalized - all were accepted as monitorable sources by the
    // previous revision.
    const bypasses = [
      ["software download host, trailing dot", "https://get.adobe.com./reader"],
      ["CMS admin host, trailing dot", "https://a.cms.omniupdate.com./11"],
      ["national academies projects, trailing dot", "https://nationalacademies.org./projects"],
      ["open data listing, trailing dot", "https://open.alberta.ca./opendata"],
      ["percent-encoded careers path", "https://us-irelandalliance.org/%63areers/apply"],
      ["percent-encoded jobs path", "https://us-irelandalliance.org/%6Aobs/listing"],
    ];
    for (const [label, url] of bypasses) {
      // Precondition: the raw spelling really does clear the production policy,
      // so these tests are exercising the normalization and nothing else.
      expect(isTrackableOfficialSourceUrl(url), `${label} (raw policy verdict)`).toBe(true);
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            overrides: [{
              awardName: "Mitchell Scholarship",
              sources: [
                { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
                { url, title: "Probe", pageType: "other", confidence: 0.5, reason: "x" },
              ],
            }],
          }),
        ),
        label,
      ).toThrow(/is not a trackable official source URL/);
    }

    // Raw query restrictions are preserved rather than normalized away: the
    // safety normalization drops the query, so the raw form must still clear
    // the policy on its own.
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({
          overrides: [{
            awardName: "Mitchell Scholarship",
            sources: [
              { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
              { url: "https://us-irelandalliance.org/applicants?utm_source=news", title: "Tracked", pageType: "other", confidence: 0.5, reason: "x" },
            ],
          }],
        }),
      ),
    ).toThrow(/is not a trackable official source URL/);

    // And an ordinary source is still accepted - this is a normalization fix,
    // not a broad tightening.
    expect(() => buildPostStage1ExpansionPlan(baseInput())).not.toThrow();
  });

  it("applies the trackability policy to percent-encoded tracking query keys", () => {
    // The raw spelling carries the query but in the caller's chosen encoding,
    // so the literal rules never matched; the queryless safety key cannot see
    // a query at all. Each of these was accepted by the previous revision.
    const encodedTrackingKeys = [
      ["utm_source", "https://us-irelandalliance.org/applicants?%75tm_source=x"],
      ["fbclid", "https://us-irelandalliance.org/applicants?%66bclid=x"],
      ["gclid", "https://us-irelandalliance.org/applicants?%67clid=x"],
      ["replytocom", "https://us-irelandalliance.org/applicants?%72eplytocom=x"],
      ["redirect_to", "https://us-irelandalliance.org/applicants?%72edirect_to=x"],
    ];
    for (const [label, url] of encodedTrackingKeys) {
      // Precondition: the raw spelling really does clear the production
      // policy, so this exercises the added normalization and nothing else.
      expect(isTrackableOfficialSourceUrl(url), `${label} (raw policy verdict)`).toBe(true);
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            overrides: [{
              awardName: "Mitchell Scholarship",
              sources: [
                { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
                { url, title: "Probe", pageType: "other", confidence: 0.5, reason: "x" },
              ],
            }],
          }),
        ),
        label,
      ).toThrow(/is not a trackable official source URL/);
    }

    // The literal spellings are rejected by the production policy directly -
    // this fix ADDS the encoded coverage without weakening that.
    for (const [, url] of [
      ["utm_source", "https://us-irelandalliance.org/applicants?utm_source=x"],
      ["fbclid", "https://us-irelandalliance.org/applicants?fbclid=x"],
      ["gclid", "https://us-irelandalliance.org/applicants?gclid=x"],
      ["replytocom", "https://us-irelandalliance.org/applicants?replytocom=x"],
      ["redirect_to", "https://us-irelandalliance.org/applicants?redirect_to=x"],
    ]) {
      expect(isTrackableOfficialSourceUrl(url), url).toBe(false);
    }

    // A benign query is still handled by the intended policy: it is neither a
    // tracking parameter nor an open-data listing facet, so it stays
    // acceptable in both its literal and percent-encoded spellings.
    for (const url of [
      "https://us-irelandalliance.org/applicants?id=7",
      "https://us-irelandalliance.org/applicants?%69d=7",
    ]) {
      expect(isTrackableOfficialSourceUrl(url), `${url} (raw policy verdict)`).toBe(true);
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            overrides: [{
              awardName: "Mitchell Scholarship",
              sources: [
                { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
                { url, title: "Benign", pageType: "other", confidence: 0.5, reason: "x" },
              ],
            }],
          }),
        ),
        url,
      ).not.toThrow();
    }

    // The open-data listing restriction is likewise reached through the
    // encoded spelling rather than weakened: a percent-encoded facet key on
    // the real open-data host is rejected exactly as the literal one is.
    for (const url of [
      "https://open.alberta.ca/publications?q=x",
      "https://open.alberta.ca/publications?%71=x",
    ]) {
      expect(() =>
        buildPostStage1ExpansionPlan(
          baseInput({
            overrides: [{
              awardName: "Mitchell Scholarship",
              sources: [
                { url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" },
                { url, title: "Listing", pageType: "other", confidence: 0.5, reason: "x" },
              ],
            }],
          }),
        ),
        url,
      ).toThrow(/is not a trackable official source URL/);
    }
  });

  it("extends the inert snapshot boundary to the root input object", () => {
    const statefulAccessor = (firstRead, laterReads) => {
      let reads = 0;
      return {
        get() {
          reads += 1;
          return reads === 1 ? firstRead : laterReads;
        },
        configurable: true,
        enumerable: true,
      };
    };
    const valid = baseInput();

    // An OWN stateful accessor on the root: the previous revision read
    // input.config directly, invoking it.
    for (const field of ["config", "seeds", "overrides", "stage1Identity"]) {
      const root = { ...valid };
      delete root[field];
      Object.defineProperty(root, field, statefulAccessor(valid[field], valid[field]));
      expect(() => buildPostStage1ExpansionPlan(root), `own accessor on input.${field}`).toThrow(
        new RegExp(`input\\.${field} must be a plain data property, not an accessor`),
      );
    }

    // An INHERITED property on the root - whether an accessor or plain data -
    // is invisible to the boundary, so a required field supplied only via the
    // prototype chain reads as missing rather than being trusted.
    const rootProto = Object.defineProperty({}, "seeds", statefulAccessor(valid.seeds, valid.seeds));
    const inheritedRoot = Object.create(rootProto);
    inheritedRoot.config = valid.config;
    inheritedRoot.overrides = valid.overrides;
    inheritedRoot.stage1Identity = valid.stage1Identity;
    expect(() => buildPostStage1ExpansionPlan(inheritedRoot)).toThrow(
      /input must be a plain object; its prototype is neither Object\.prototype nor null/,
    );

    // A plain root record still works, and so does a null-prototype one.
    expect(() => buildPostStage1ExpansionPlan(valid)).not.toThrow();
    expect(() => buildPostStage1ExpansionPlan(Object.assign(Object.create(null), valid))).not.toThrow();
  });

  it("fails closed on Proxy objects and arrays anywhere in the external input graph", () => {
    const valid = baseInput();

    // A Proxy can trap `length`, so the dense-array and exact-count
    // guarantees are only as honest as the object answering them. Both of
    // these were accepted by the previous revision.
    const lyingLength = (target, reportedLength) =>
      new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === "length") return reportedLength;
          return Reflect.get(t, prop, receiver);
        },
      });

    // 26 Stage 1 rows reporting length 25 - the exact-25 anchor was defeated.
    const twentySix = [...realStage1Identity(), {
      cohortKey: "intruder",
      canonicalName: "Intruder Award",
      canonicalSearchKey: "intruder award",
      aliasSearchKeys: [],
      canonicalSlug: "intruder-award",
      officialHomepage: "https://intruder.example.org/",
    }];
    expect(twentySix).toHaveLength(26);
    expect(lyingLength(twentySix, 25).length).toBe(25);
    expect(() => buildPostStage1ExpansionPlan(baseInput({ stage1Identity: lyingLength(twentySix, 25) }))).toThrow(
      /stage1Identity must not be a Proxy/,
    );

    // Two candidates reporting length 1 - the second was smuggled past every
    // per-candidate check.
    const twoCandidates = [
      { candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" },
      { candidateId: "smuggled", awardName: "Smuggled Award", status: "provisional" },
    ];
    expect(lyingLength(twoCandidates, 1).length).toBe(1);
    expect(() =>
      buildPostStage1ExpansionPlan(
        baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: lyingLength(twoCandidates, 1) } }),
      ),
    ).toThrow(/config\.candidates must not be a Proxy/);

    // Every other collection and record in the graph is covered too, so no
    // single unproxied entry point remains.
    const proxied = (target) => new Proxy(target, {});
    const cases = [
      ["input", () => proxied(valid), /input must not be a Proxy/],
      ["config", () => baseInput({ config: proxied(valid.config) }), /config must not be a Proxy/],
      ["config.candidates[0]", () => baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [proxied({ candidateId: "mitchell", awardName: "Mitchell Scholarship", status: "provisional" })] } }), /config\.candidates\[0\] must not be a Proxy/],
      ["seeds", () => baseInput({ seeds: proxied(valid.seeds) }), /seeds must not be a Proxy/],
      ["seeds[0]", () => baseInput({ seeds: [proxied(valid.seeds[0])] }), /seeds\[0\] must not be a Proxy/],
      ["overrides", () => baseInput({ overrides: proxied(valid.overrides) }), /overrides must not be a Proxy/],
      ["overrides[0]", () => baseInput({ overrides: [proxied(valid.overrides[0])] }), /overrides\[0\] must not be a Proxy/],
      ["overrides[0].sources", () => baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: proxied(valid.overrides[0].sources) }] }), /overrides\[0\]\.sources must not be a Proxy/],
      ["overrides[0].sources[0]", () => baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: [proxied(valid.overrides[0].sources[0])] }] }), /overrides\[0\]\.sources\[0\] must not be a Proxy/],
      ["stage1Identity[0]", () => baseInput({ stage1Identity: realStage1Identity().map((row, index) => (index === 0 ? proxied(row) : row)) }), /stage1Identity\[0\] must not be a Proxy/],
      ["stage1Identity[14].aliasSearchKeys", () => baseInput({ stage1Identity: realStage1Identity().map((row) => (row.cohortKey === "boren" ? { ...row, aliasSearchKeys: proxied(row.aliasSearchKeys) } : row)) }), /stage1Identity\[14\]\.aliasSearchKeys must not be a Proxy/],
    ];
    for (const [label, makeInput, pattern] of cases) {
      expect(() => buildPostStage1ExpansionPlan(makeInput()), label).toThrow(pattern);
    }

    // Unproxied equivalents of the same shapes are still accepted, so this is
    // a rejection of Proxies specifically and not of the structures.
    expect(() => buildPostStage1ExpansionPlan(baseInput())).not.toThrow();
  });

  describe("rejected values are never executed to describe them", () => {
    // A Proxy scalar that records every property lookup its traps see.
    function trapCountingProxy() {
      const calls = [];
      const proxy = new Proxy({}, {
        get(target, prop, receiver) {
          calls.push(typeof prop === "symbol" ? prop.toString() : prop);
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          calls.push(`has:${typeof prop === "symbol" ? prop.toString() : prop}`);
          return Reflect.has(target, prop);
        },
      });
      return { value: proxy, calls };
    }

    // A plain object whose own toJSON / toString / valueOf /
    // Symbol.toPrimitive / Symbol.toStringTag are ACCESSORS, so merely
    // LOOKING for a coercion hook is observable - not just calling one.
    function accessorCountingObject() {
      const calls = [];
      const object = {};
      for (const key of ["toJSON", "toString", "valueOf"]) {
        Object.defineProperty(object, key, {
          get() {
            calls.push(key);
            return () => `<${key}>`;
          },
          configurable: true,
        });
      }
      Object.defineProperty(object, Symbol.toPrimitive, {
        get() {
          calls.push("Symbol.toPrimitive");
          return () => "<toPrimitive>";
        },
        configurable: true,
      });
      Object.defineProperty(object, Symbol.toStringTag, {
        get() {
          calls.push("Symbol.toStringTag");
          return "Tagged";
        },
        configurable: true,
      });
      return { value: object, calls };
    }

    const candidateWith = (patch) => ({
      candidateId: "mitchell",
      awardName: "Mitchell Scholarship",
      slug: "mitchell-scholarship",
      status: "provisional",
      ...patch,
    });

    // One entry per scalar validator that formats a rejected value.
    const sites = [
      ["config.candidates[0].candidateId", (value) => baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidateWith({ candidateId: value })] } })],
      ["config.candidates[0].slug", (value) => baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidateWith({ slug: value })] } })],
      ["config.candidates[0].awardName", (value) => baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidateWith({ awardName: value })] } })],
      ["config.candidates[0].status", (value) => baseInput({ config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [candidateWith({ status: value })] } })],
      ["config.schema", (value) => baseInput({ config: { schema: value, candidates: [candidateWith({})] } })],
      ["seeds[0].starterUrl", (value) => baseInput({ seeds: [{ name: "Mitchell Scholarship", starterUrl: value }] })],
      ["overrides[0].sources[0].url", (value) => baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: [{ url: value, title: "Home", pageType: "homepage", confidence: 0.95, reason: "x" }] }] })],
      ["overrides[0].sources[0].confidence", (value) => baseInput({ overrides: [{ awardName: "Mitchell Scholarship", sources: [{ url: "https://us-irelandalliance.org/mitchellscholarship", title: "Home", pageType: "homepage", confidence: value, reason: "x" }] }] })],
      ["stage1Identity[0].cohortKey", (value) => baseInput({ stage1Identity: realStage1Identity().map((row, index) => (index === 0 ? { ...row, cohortKey: value } : row)) })],
      ["stage1Identity[0].canonicalSlug", (value) => baseInput({ stage1Identity: realStage1Identity().map((row, index) => (index === 0 ? { ...row, canonicalSlug: value } : row)) })],
      ["stage1Identity[0].officialHomepage", (value) => baseInput({ stage1Identity: realStage1Identity().map((row, index) => (index === 0 ? { ...row, officialHomepage: value } : row)) })],
    ];

    it("invokes no Proxy trap when rejecting a proxied scalar at any validator", () => {
      for (const [label, makeInput] of sites) {
        const probe = trapCountingProxy();
        expect(() => buildPostStage1ExpansionPlan(makeInput(probe.value)), label).toThrow();
        // Formatting the rejection must not have asked the value anything -
        // the previous revision's JSON.stringify triggered get("toJSON").
        expect(probe.calls, `${label} invoked Proxy traps`).toEqual([]);
      }
    });

    it("reads no own toJSON/toString/valueOf/Symbol.toPrimitive/Symbol.toStringTag accessor when rejecting an object", () => {
      for (const [label, makeInput] of sites) {
        const probe = accessorCountingObject();
        expect(() => buildPostStage1ExpansionPlan(makeInput(probe.value)), label).toThrow();
        expect(probe.calls, `${label} read coercion accessors`).toEqual([]);
      }
    });

    it("still describes rejected values usefully, by type for objects and exactly for primitives", () => {
      const describeRejection = (makeInput, value) => {
        try {
          buildPostStage1ExpansionPlan(makeInput(value));
        } catch (error) {
          return error.message;
        }
        throw new Error("expected a rejection");
      };
      const candidateIdSite = sites[0][1];
      const confidenceSite = sites[7][1];

      // Non-primitives collapse to a fixed, inert phrase.
      expect(describeRejection(candidateIdSite, {})).toMatch(/got an object\.$/);
      expect(describeRejection(candidateIdSite, [])).toMatch(/got an array\.$/);
      expect(describeRejection(candidateIdSite, new Proxy({}, {}))).toMatch(/got a Proxy\.$/);
      expect(describeRejection(candidateIdSite, () => {})).toMatch(/got a function\.$/);
      expect(describeRejection(candidateIdSite, Symbol("s"))).toMatch(/got a symbol\.$/);
      expect(describeRejection(candidateIdSite, null)).toMatch(/got null\.$/);

      // Primitives keep their exact, useful description - a primitive cannot
      // carry user code, so quoting it executes nothing.
      expect(describeRejection(candidateIdSite, "Mitchell")).toMatch(/got "Mitchell"\.$/);
      expect(describeRejection(candidateIdSite, undefined)).toMatch(/got undefined\.$/);
      expect(describeRejection(confidenceSite, 42)).toMatch(/got 42\.$/);
      expect(describeRejection(confidenceSite, Number.NaN)).toMatch(/got NaN\.$/);
      expect(describeRejection(confidenceSite, Number.POSITIVE_INFINITY)).toMatch(/got Infinity\.$/);
      expect(describeRejection(confidenceSite, true)).toMatch(/got true\.$/);
    });
  });

  it("never uses ready/official/verified/active as an affirmative state anywhere in the plan", () => {
    const result = buildProductionPlan();
    const claimWord = /\b(ready|official|verified|active|monitorable|publishable)\b/i;

    for (const plan of result.plans) {
      expect(JSON.stringify(plan.status)).not.toMatch(claimWord);
      expect(plan.lifecycle.monitoringReadiness).toBe(false);
      expect(plan.lifecycle.publicationEligibility).toBe(false);
      expect(plan.lifecycle.currentCycleAuthority).toBe("unresolved");
      expect(plan.lifecycle.humanSourceReview).toBe("unresolved");
      expect(plan.lifecycle.remoteIdentityCollisionCheck).toBe("unresolved");
    }
  });

  describe("planHash: complete material payload", () => {
    it("changes when any formerly-omitted field class changes: source title, pageType, confidence, and every lifecycle/gate field", () => {
      const base = samplePlan();
      const baseHash = computePlanHash(base);

      const mutations = [
        { label: "source title", plan: samplePlan({ monitorableSources: [base.monitorableSources[0], { ...base.monitorableSources[1], title: "Different Title" }] }) },
        { label: "source pageType", plan: samplePlan({ monitorableSources: [base.monitorableSources[0], { ...base.monitorableSources[1], pageType: "eligibility" }] }) },
        { label: "source confidence", plan: samplePlan({ monitorableSources: [base.monitorableSources[0], { ...base.monitorableSources[1], confidence: 0.42 }] }) },
        // canonicalUrlKey is RETURNED material that downstream readers compare
        // on, so it must be bound too - the previous revision omitted it, and
        // a plan whose returned key had been rewritten still hashed identically.
        { label: "source canonicalUrlKey", plan: samplePlan({ monitorableSources: [base.monitorableSources[0], { ...base.monitorableSources[1], canonicalUrlKey: "tampered/key" }] }) },
        { label: "status", plan: samplePlan({ status: "some-other-status" }) },
        { label: "slug", plan: samplePlan({ slug: "different-slug" }) },
        { label: "excludedDiscoveryUrls", plan: samplePlan({ excludedDiscoveryUrls: [] }) },
        { label: "homepage title", plan: samplePlan({ homepage: { ...base.homepage, title: "Different Homepage Title" } }) },
        { label: "homepage confidence", plan: samplePlan({ homepage: { ...base.homepage, confidence: 0.42 } }) },
        { label: "lifecycle.currentCycleAuthority", plan: samplePlan({ lifecycle: { ...base.lifecycle, currentCycleAuthority: "resolved" } }) },
        { label: "lifecycle.humanSourceReview", plan: samplePlan({ lifecycle: { ...base.lifecycle, humanSourceReview: "resolved" } }) },
        { label: "lifecycle.remoteIdentityCollisionCheck", plan: samplePlan({ lifecycle: { ...base.lifecycle, remoteIdentityCollisionCheck: "resolved" } }) },
        { label: "lifecycle.monitoringReadiness", plan: samplePlan({ lifecycle: { ...base.lifecycle, monitoringReadiness: true } }) },
        { label: "lifecycle.publicationEligibility", plan: samplePlan({ lifecycle: { ...base.lifecycle, publicationEligibility: true } }) },
      ];

      for (const { label, plan } of mutations) {
        expect(computePlanHash(plan), label).not.toBe(baseHash);
      }
    });

    it("binds every returned material source field, including canonicalUrlKey, for a real production plan", () => {
      const plan = buildProductionPlan().plans[0];

      // Every field the builder actually returns on a source is bound: change
      // any one of them and the hash must move.
      const fieldMutations = [
        ["url", (source) => ({ ...source, url: "https://us-irelandalliance.org/tampered" })],
        ["title", (source) => ({ ...source, title: "Tampered Title" })],
        ["pageType", (source) => ({ ...source, pageType: "eligibility" })],
        ["confidence", (source) => ({ ...source, confidence: 0.01 })],
        ["canonicalUrlKey", (source) => ({ ...source, canonicalUrlKey: "tampered/key" })],
      ];
      for (const [label, mutate] of fieldMutations) {
        const tampered = {
          ...plan,
          monitorableSources: plan.monitorableSources.map((source, index) => (index === 1 ? mutate(source) : source)),
        };
        expect(computePlanHash(tampered), label).not.toBe(plan.planHash);
      }

      // Sanity: an untouched copy still hashes to the value the builder
      // returned, so the assertions above are detecting the mutation and not
      // merely the act of rebuilding the object.
      expect(computePlanHash({ ...plan, monitorableSources: plan.monitorableSources.map((source) => ({ ...source })) })).toBe(plan.planHash);
    });

    it("is invariant to the order of a candidate's monitorableSources and excludedDiscoveryUrls (canonical sort)", () => {
      const base = samplePlan();
      const reorderedSources = samplePlan({ monitorableSources: [...base.monitorableSources].reverse() });
      expect(computePlanHash(reorderedSources)).toBe(computePlanHash(base));

      const withTwoExcluded = samplePlan({ excludedDiscoveryUrls: ["https://b.example.org/", "https://a.example.org/"] });
      const withTwoExcludedReversed = samplePlan({ excludedDiscoveryUrls: ["https://a.example.org/", "https://b.example.org/"] });
      expect(computePlanHash(withTwoExcluded)).toBe(computePlanHash(withTwoExcludedReversed));
    });

    it("is invariant to multi-candidate config order and multi-source override order through the real builder", () => {
      const stage1Identity = realStage1Identity();
      const secondSeeds = [{ name: "Second Award", starterUrl: "https://second.example.org/apply" }];
      const secondOverrides = [{
        awardName: "Second Award",
        sources: [
          { url: "https://second.example.org/eligibility", title: "Eligibility", pageType: "eligibility", confidence: 0.8, reason: "x" },
          { url: "https://second.example.org/apply", title: "Home", pageType: "homepage", confidence: 0.9, reason: "x" },
          { url: "https://second.example.org/faq", title: "FAQ", pageType: "faq", confidence: 0.7, reason: "x" },
        ],
      }];
      const secondCandidate = { candidateId: "second_award", awardName: "Second Award", status: "provisional" };
      const mitchellCandidate = VALID_CONFIG.candidates[0];

      const forward = buildPostStage1ExpansionPlan({
        config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [mitchellCandidate, secondCandidate] },
        seeds: [...SYNTHETIC_SEEDS, ...secondSeeds],
        overrides: [SYNTHETIC_OVERRIDES[0], secondOverrides[0]],
        stage1Identity,
      });

      // Candidates reordered, AND the second candidate's own sources array
      // reordered - a genuine multi-candidate, multi-source reorder.
      const reorderedOverrides = [{ ...secondOverrides[0], sources: [...secondOverrides[0].sources].reverse() }, SYNTHETIC_OVERRIDES[0]];
      const backward = buildPostStage1ExpansionPlan({
        config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates: [secondCandidate, mitchellCandidate] },
        seeds: [...secondSeeds, ...SYNTHETIC_SEEDS],
        overrides: reorderedOverrides,
        stage1Identity,
      });

      expect(forward.totals.candidates).toBe(2);

      // seed.seedIndex is the seed's position in whichever seeds array the
      // caller passed - it legitimately differs here, since the forward and
      // backward calls pass the two seeds in opposite array order. Every
      // OTHER field, and critically planHash itself, must be identical
      // regardless: seedIndex is bookkeeping, not material identity.
      const stripSeedIndex = (result) =>
        result.plans.map((plan) => ({ ...plan, seed: { name: plan.seed.name, starterUrl: plan.seed.starterUrl } }));
      expect(stripSeedIndex(backward)).toEqual(stripSeedIndex(forward));

      const hashByCandidateId = (result) => Object.fromEntries(result.plans.map((p) => [p.candidateId, p.planHash]));
      expect(hashByCandidateId(backward)).toEqual(hashByCandidateId(forward));
    });

    it("is not a constant: two genuinely different plans hash differently", () => {
      const plan = samplePlan();
      const differentPlan = samplePlan({ candidateId: "someone_else", awardName: "Someone Else Award", normalizedAwardKey: "someone else award" });
      const hash1 = computePlanHash(plan);
      const hash2 = computePlanHash(differentPlan);
      expect(hash1).not.toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash2).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
