import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { awardSeeds } from "../../src/lib/award-seeds.ts";
import { awardSourceOverrides } from "../../src/lib/award-source-overrides.ts";
import { isTrackableOfficialSourceUrl } from "../../src/lib/source-url-policy.ts";
import { normalizeSharedAwardKey } from "../../src/lib/shared-awards-core.ts";
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

function planFor(result, candidateId) {
  const plan = result.plans.find((candidate) => candidate.candidateId === candidateId);
  if (!plan) throw new Error(`No plan for ${candidateId}`);
  return plan;
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
  it("builds the provisional Mitchell plan from real production data: 12 monitorable sources, one homepage, ASU discovery URL excluded", () => {
    const result = buildProductionPlan();

    expect(result.version).toBe(POST_STAGE1_EXPANSION_PLAN_VERSION);

    // Addressed by candidateId rather than by position: adding a second
    // candidate must not be able to silently re-point this test at a
    // different award.
    const plan = planFor(result, "mitchell");
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

  it("builds the provisional Tillman plan from real production data: one monitorable official source, ASU discovery URL excluded", () => {
    const result = buildProductionPlan();
    const plan = planFor(result, "tillman");

    expect(plan.awardName).toBe("Tillman Scholars Program");
    expect(plan.normalizedAwardKey).toBe("tillman scholars program");
    expect(plan.slug).toBe("tillman-scholars-program");
    expect(plan.status).toBe("provisional");

    // Exact seed join, at the catalog position the evidence records.
    expect(plan.seed.seedIndex).toBe(166);
    expect(plan.seed.name).toBe("Tillman Scholars Program");
    expect(plan.seed.starterUrl).toBe("https://onsa.asu.edu/scholarship/tillman-scholars-program");

    // The seed link is an institutional discovery URL: recorded as excluded
    // evidence, never carried into the monitorable set.
    expect(plan.excludedDiscoveryUrls).toEqual(["https://onsa.asu.edu/scholarship/tillman-scholars-program"]);
    expect(plan.monitorableSources.some((source) => source.url === plan.seed.starterUrl)).toBe(false);
    expect(plan.monitorableSources.every((source) => !source.url.includes("onsa.asu.edu"))).toBe(true);

    // Exactly one monitorable official source, which is also the homepage.
    expect(plan.monitorableSources).toHaveLength(1);
    expect(plan.monitorableSources[0].url).toBe("https://pattillmanfoundation.org/apply-to-be-a-scholar/");
    expect(plan.monitorableSources[0].pageType).toBe("homepage");
    expect(plan.monitorableSources[0].confidence).toBe(0.92);
    expect(plan.monitorableSources.filter((source) => source.pageType === "homepage")).toHaveLength(1);
    expect(plan.homepage.url).toBe("https://pattillmanfoundation.org/apply-to-be-a-scholar/");
    expect(new URL(plan.monitorableSources[0].url).protocol).toBe("https:");

    // One official homepage is EVIDENCE, not proof of anything current.
    // Every lifecycle gate stays exactly as unresolved as Mitchell's.
    expect(plan.lifecycle).toEqual({
      currentCycleAuthority: "unresolved",
      humanSourceReview: "unresolved",
      remoteIdentityCollisionCheck: "unresolved",
      monitoringReadiness: false,
      publicationEligibility: false,
    });
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves the nearby Pat Tillman Foundation seed unjoined and quarantined pending human identity review", () => {
    // The catalog also holds "Pat Tillman Foundation - Tillman Military
    // Scholarship for Military Service Members, Veterans, and Spouses".
    //
    // Whether that is the same program under a fuller name, a sibling award
    // of the same foundation, or something else entirely is an OPEN QUESTION
    // that only a human reviewing the two identities can answer. A different
    // normalized name is not evidence of a different award - it is only
    // evidence that the two spellings differ.
    //
    // So this test does not claim the two are distinct. It pins the
    // conservative behaviour: the exact-name join reaches exactly one seed
    // and one override declaration, the nearby seed is neither aliased nor
    // ingested, and it therefore stays quarantined - visible in the catalog,
    // absent from this plan - until someone decides what it is.
    const nearby = awardSeeds.filter(
      (seed) => /tillman/i.test(seed.name) && seed.name !== "Tillman Scholars Program",
    );
    expect(nearby.length).toBeGreaterThan(0);

    // The allowlisted name resolves to exactly one seed and one override.
    expect(awardSeeds.filter((seed) => normalizeSharedAwardKey(seed.name) === "tillman scholars program")).toHaveLength(1);
    expect(
      awardSourceOverrides.filter((override) => normalizeSharedAwardKey(override.awardName) === "tillman scholars program"),
    ).toHaveLength(1);

    // Nothing about the nearby seed is aliased into the candidate: it is not
    // the joined seed, and none of its evidence appears in the plan.
    const plan = planFor(buildProductionPlan(), "tillman");
    for (const seed of nearby) {
      expect(plan.seed.name).not.toBe(seed.name);
      expect(plan.seed.starterUrl).not.toBe(seed.starterUrl);
      expect(plan.monitorableSources.some((source) => source.url === seed.starterUrl)).toBe(false);
      expect(plan.excludedDiscoveryUrls).not.toContain(seed.starterUrl);
    }

    // And the plan makes no claim that could be read as having settled the
    // question: every identity/lifecycle gate is still open.
    expect(plan.lifecycle.remoteIdentityCollisionCheck).toBe("unresolved");
    expect(plan.lifecycle.humanSourceReview).toBe("unresolved");
    expect(plan.lifecycle.currentCycleAuthority).toBe("unresolved");
    expect(plan.lifecycle.monitoringReadiness).toBe(false);
    expect(plan.lifecycle.publicationEligibility).toBe(false);

    // Ingesting it would require an allowlist entry naming it, which does not
    // exist - and adding one is a human decision, not an automatic alias.
    const config = loadRealConfig();
    for (const seed of nearby) {
      expect(config.candidates.some((candidate) => candidate.awardName === seed.name)).toBe(false);
    }
  });

  it("keeps the two candidates isolated: each plan is identical alone or alongside the other", () => {
    const stage1Identity = realStage1Identity();
    const mitchell = { candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship", status: "provisional" };
    const tillman = { candidateId: "tillman", awardName: "Tillman Scholars Program", slug: "tillman-scholars-program", status: "provisional" };
    const build = (candidates) =>
      buildPostStage1ExpansionPlan({
        config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates },
        seeds: awardSeeds,
        overrides: awardSourceOverrides,
        stage1Identity,
      });

    const mitchellAlone = build([mitchell]).plans[0];
    const tillmanAlone = build([tillman]).plans[0];
    const together = build([mitchell, tillman]);

    // Neither candidate's plan - or hash - depends on the other's presence.
    expect(planFor(together, "mitchell")).toEqual(mitchellAlone);
    expect(planFor(together, "tillman")).toEqual(tillmanAlone);
    expect(planFor(together, "mitchell").planHash).toBe(mitchellAlone.planHash);
    expect(planFor(together, "tillman").planHash).toBe(tillmanAlone.planHash);

    // Two genuinely different awards hash differently.
    expect(mitchellAlone.planHash).not.toBe(tillmanAlone.planHash);

    // Neither borrows the other's evidence.
    const mitchellUrls = new Set(planFor(together, "mitchell").monitorableSources.map((source) => source.url));
    const tillmanUrls = new Set(planFor(together, "tillman").monitorableSources.map((source) => source.url));
    for (const url of tillmanUrls) expect(mitchellUrls.has(url)).toBe(false);
    expect(planFor(together, "mitchell").seed.starterUrl).not.toBe(planFor(together, "tillman").seed.starterUrl);
  });

  it("orders the two production candidates deterministically regardless of config order", () => {
    const stage1Identity = realStage1Identity();
    const mitchell = { candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship", status: "provisional" };
    const tillman = { candidateId: "tillman", awardName: "Tillman Scholars Program", slug: "tillman-scholars-program", status: "provisional" };
    const build = (candidates) =>
      buildPostStage1ExpansionPlan({
        config: { schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates },
        seeds: awardSeeds,
        overrides: awardSourceOverrides,
        stage1Identity,
      });

    const forward = build([mitchell, tillman]);
    const backward = build([tillman, mitchell]);

    expect(forward.totals.candidates).toBe(2);
    expect(forward.plans.map((plan) => plan.candidateId)).toEqual(["mitchell", "tillman"]);
    expect(backward.plans.map((plan) => plan.candidateId)).toEqual(["mitchell", "tillman"]);
    expect(backward).toEqual(forward);

    // The shipped config is one of those orders, and repeated builds of it
    // are byte-identical.
    const production = buildProductionPlan();
    expect(production.plans.map((plan) => plan.candidateId)).toEqual(["mitchell", "tillman"]);
    expect(buildProductionPlan()).toEqual(production);
  });

  it("ships exactly the two reviewed provisional candidates in the real config", () => {
    const config = loadRealConfig();
    expect(config.schema).toBe(POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA);
    expect(config.candidates).toHaveLength(2);
    expect(config.candidates.map((candidate) => candidate.candidateId).sort()).toEqual(["mitchell", "tillman"]);
    // Every allowlisted candidate is provisional; nothing has been promoted.
    for (const candidate of config.candidates) {
      expect(candidate.status, candidate.candidateId).toBe("provisional");
    }
  });

  it("pins the production result byte-for-byte: both plan hashes and the whole-result digest", () => {
    // Captured from the frozen parent of the input-boundary consolidation
    // (c73283577b18b585ff49f7cbd1f5372febcb1dcb), so sharing the boundary is
    // provably a no-op for valid production input. Any change to a value
    // here is a behavioural change that has to be explained on its own
    // merits, never re-pinned in passing.
    const result = buildProductionPlan();
    expect(result.version).toBe(POST_STAGE1_EXPANSION_PLAN_VERSION);
    expect(result.totals).toEqual({ candidates: 2 });
    expect(result.plans.map((plan) => [plan.candidateId, plan.status])).toEqual([
      ["mitchell", "provisional"],
      ["tillman", "provisional"],
    ]);
    expect(planFor(result, "mitchell").planHash).toBe("c64098d958e6ab8bdbda82764ab8c2890c76e343d328e5e0d4e0fac670c1f3b1");
    expect(planFor(result, "tillman").planHash).toBe("53d845215b34d21a90afaa0c0b92324e4edc8bb35d0cf62b5694055f8c58e44b");
    expect(createHash("sha256").update(JSON.stringify(result), "utf8").digest("hex")).toBe(
      "aaa0dbc04f95fd1a3ada8d08b2f6c48fa4c2b83a85e1d685f8f41a9679d5f18e",
    );
  });

  describe("candidates must be distinct from each other", () => {
    const twoCandidateInput = (patch = {}) => ({
      config: {
        schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
        candidates: patch.candidates ?? [
          { candidateId: "alpha", awardName: "Alpha Award", slug: "alpha-award", status: "provisional" },
          { candidateId: "beta", awardName: "Beta Award", slug: "beta-award", status: "provisional" },
        ],
      },
      seeds: patch.seeds ?? [
        { name: "Alpha Award", starterUrl: "https://alpha.example.org/seed" },
        { name: "Beta Award", starterUrl: "https://beta.example.org/seed" },
      ],
      overrides: patch.overrides ?? [
        { awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
        { awardName: "Beta Award", sources: [{ url: "https://beta.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
      ],
      stage1Identity: patch.stage1Identity ?? realStage1Identity(),
    });

    it("accepts the distinct baseline the collision cases are built from", () => {
      const result = buildPostStage1ExpansionPlan(twoCandidateInput());
      expect(result.plans.map((plan) => plan.candidateId)).toEqual(["alpha", "beta"]);
    });

    it("rejects two candidates claiming the same slug", () => {
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            candidates: [
              { candidateId: "alpha", awardName: "Alpha Award", slug: "shared-slug", status: "provisional" },
              { candidateId: "beta", awardName: "Beta Award", slug: "shared-slug", status: "provisional" },
            ],
          }),
        ),
      ).toThrow(/config\.candidates has a duplicate slug "shared-slug"/);

      // Order-independent: whichever entry comes second is the one caught.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            candidates: [
              { candidateId: "beta", awardName: "Beta Award", slug: "shared-slug", status: "provisional" },
              { candidateId: "alpha", awardName: "Alpha Award", slug: "shared-slug", status: "provisional" },
            ],
          }),
        ),
      ).toThrow(/config\.candidates has a duplicate slug "shared-slug"/);

      // An absent slug is not an identity, so several candidates may omit it.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            candidates: [
              { candidateId: "alpha", awardName: "Alpha Award", status: "provisional" },
              { candidateId: "beta", awardName: "Beta Award", status: "provisional" },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it("rejects two candidates sharing one program URL, in any role and any equivalent spelling", () => {
      const shared = "https://shared-program.example.org/apply";
      const equivalents = [
        ["identical", shared],
        ["trailing DNS dot", "https://shared-program.example.org./apply"],
        ["percent-encoded unreserved character", "https://shared-program.example.org/%61pply"],
        ["appended query", "https://shared-program.example.org/apply?ref=x"],
        ["uppercase host", "https://SHARED-PROGRAM.EXAMPLE.ORG/apply"],
      ];
      for (const [label, betaSpelling] of equivalents) {
        expect(() =>
          buildPostStage1ExpansionPlan(
            twoCandidateInput({
              overrides: [
                { awardName: "Alpha Award", sources: [{ url: shared, title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
                { awardName: "Beta Award", sources: [{ url: betaSpelling, title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              ],
            }),
          ),
          label,
        ).toThrow(/URL identity ".*" is claimed by both candidate "alpha" and candidate "beta"/);
      }

      // A non-homepage role counts exactly the same: beta claiming alpha's
      // homepage as a mere "other" source is still two candidates on one URL.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            overrides: [
              { awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              { awardName: "Beta Award", sources: [
                { url: "https://beta.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" },
                { url: "https://alpha.example.org/", title: "Alpha's homepage", pageType: "other", confidence: 0.5, reason: "x" },
              ] },
            ],
          }),
        ),
      ).toThrow(/URL identity "alpha\.example\.org\/" is claimed by both candidate "alpha" and candidate "beta"/);

      // The seed/discovery link is a candidate-related URL too.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            seeds: [
              { name: "Alpha Award", starterUrl: "https://shared-seed.example.org/listing" },
              { name: "Beta Award", starterUrl: "https://shared-seed.example.org/listing" },
            ],
          }),
        ),
      ).toThrow(/URL identity "shared-seed\.example\.org\/listing" is claimed by both candidate "alpha" and candidate "beta"/);

      // One candidate's seed reappearing as ANOTHER candidate's source is the
      // same collision seen from the other side.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            overrides: [
              { awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              { awardName: "Beta Award", sources: [
                { url: "https://beta.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" },
                { url: "https://alpha.example.org/seed", title: "Alpha's seed", pageType: "other", confidence: 0.5, reason: "x" },
              ] },
            ],
          }),
        ),
      ).toThrow(/URL identity "alpha\.example\.org\/seed" is claimed by both candidate "alpha" and candidate "beta"/);
    });

    it("still allows one candidate to use the same URL in several of its own roles", () => {
      // The real Tillman shape: the single official source IS the homepage.
      const production = planFor(buildProductionPlan(), "tillman");
      expect(production.homepage.url).toBe(production.monitorableSources[0].url);

      // And a seed link that also appears among that same candidate's own
      // sources is not a cross-candidate collision either.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            overrides: [
              { awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              { awardName: "Beta Award", sources: [
                { url: "https://beta.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" },
                { url: "https://beta.example.org/seed", title: "Beta's own seed", pageType: "other", confidence: 0.5, reason: "x" },
              ] },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it("preserves the Stage 1 URL collision checks alongside the new cross-candidate rule", () => {
      // Cross-candidate uniqueness is an ADDITIONAL constraint: a candidate
      // colliding with a frozen Stage 1 homepage is still rejected by the
      // Stage 1 rule, with its own distinct message.
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            overrides: [
              { awardName: "Alpha Award", sources: [{ url: "https://www.truman.gov/apply", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              { awardName: "Beta Award", sources: [{ url: "https://beta.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
            ],
          }),
        ),
      ).toThrow(/overlaps a frozen Stage 1 homepage/);
    });

    it("keeps the scalar, accessor, Proxy and TOCTOU boundaries intact for the peer-uniqueness fields", () => {
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

      // A slug accessor that shows a unique value while being checked and a
      // colliding one afterwards is rejected as an accessor, before either
      // value is trusted.
      const accessorCandidate = { candidateId: "beta", awardName: "Beta Award", status: "provisional" };
      Object.defineProperty(accessorCandidate, "slug", statefulAccessor("beta-award", "alpha-award"));
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            candidates: [
              { candidateId: "alpha", awardName: "Alpha Award", slug: "alpha-award", status: "provisional" },
              accessorCandidate,
            ],
          }),
        ),
      ).toThrow(/config\.candidates\[1\]\.slug must be a plain data property, not an accessor/);

      // A proxied slug is rejected without any trap being consulted.
      const trapCalls = [];
      const proxiedSlug = new Proxy({}, {
        get(target, prop, receiver) {
          trapCalls.push(typeof prop === "symbol" ? prop.toString() : prop);
          return Reflect.get(target, prop, receiver);
        },
      });
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            candidates: [
              { candidateId: "alpha", awardName: "Alpha Award", slug: "alpha-award", status: "provisional" },
              { candidateId: "beta", awardName: "Beta Award", slug: proxiedSlug, status: "provisional" },
            ],
          }),
        ),
      ).toThrow(/slug must be a canonical identifier/);
      expect(trapCalls).toEqual([]);

      // A proxied source url is likewise rejected before the cross-candidate
      // comparison can be fed a value that changes underneath it.
      const urlTrapCalls = [];
      const proxiedUrl = new Proxy({}, {
        get(target, prop, receiver) {
          urlTrapCalls.push(typeof prop === "symbol" ? prop.toString() : prop);
          return Reflect.get(target, prop, receiver);
        },
      });
      expect(() =>
        buildPostStage1ExpansionPlan(
          twoCandidateInput({
            overrides: [
              { awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
              { awardName: "Beta Award", sources: [{ url: proxiedUrl, title: "H", pageType: "homepage", confidence: 0.9, reason: "x" }] },
            ],
          }),
        ),
      ).toThrow(/must be a non-empty string/);
      expect(urlTrapCalls).toEqual([]);

      // A proxied candidates array cannot hide a colliding second candidate
      // behind a lying length.
      const colliding = [
        { candidateId: "alpha", awardName: "Alpha Award", slug: "shared-slug", status: "provisional" },
        { candidateId: "beta", awardName: "Beta Award", slug: "shared-slug", status: "provisional" },
      ];
      const lyingLength = new Proxy(colliding, {
        get(target, prop, receiver) {
          if (prop === "length") return 1;
          return Reflect.get(target, prop, receiver);
        },
      });
      expect(() => buildPostStage1ExpansionPlan(twoCandidateInput({ candidates: lyingLength }))).toThrow(
        /config\.candidates must not be a Proxy/,
      );
    });
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
      expect(result.totals.candidates).toBe(2);
      expect(planFor(result, "mitchell").monitorableSources).toHaveLength(12);
      expect(planFor(result, "tillman").monitorableSources).toHaveLength(1);
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

  describe("exact plain-data shape at every input layer", () => {
    // The structural boundary is shared with the identity-collision dossier
    // (plain-data-input-boundary.mjs). These regressions pin the two rules
    // the planner's former private copy lacked - an array may own nothing
    // but its length and canonical indices, and every accessed field or
    // index must be enumerable - at every array and record layer of the
    // input graph. Nothing valid changes (the production result is pinned
    // byte-for-byte above); a hostile graph that used to slip through now
    // fails closed on its specific defect, with no hook of its own run.
    const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hidden = (object, key) =>
      Object.defineProperty(object, key, { ...Object.getOwnPropertyDescriptor(object, key), enumerable: false });
    const configWith = (candidates) => ({ schema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA, candidates });
    const aliasRowIndex = realStage1Identity().findIndex((row) => row.aliasSearchKeys.length > 0);
    const hookRecorder = (calls, key) => ({
      value: () => {
        calls.push(key);
        return [];
      },
      configurable: true,
      writable: true,
    });

    // Each array layer, rebuilt from a fresh valid copy so the installed
    // defect is the only difference from an accepted input.
    const arrayLayers = [
      ["config.candidates", (make) => baseInput({ config: configWith(make([...VALID_CONFIG.candidates])) })],
      ["seeds", (make) => baseInput({ seeds: make([...SYNTHETIC_SEEDS]) })],
      ["overrides", (make) => baseInput({ overrides: make([...SYNTHETIC_OVERRIDES]) })],
      [
        "overrides[0].sources",
        (make) => baseInput({ overrides: [{ ...SYNTHETIC_OVERRIDES[0], sources: make([...SYNTHETIC_OVERRIDES[0].sources]) }] }),
      ],
      ["stage1Identity", (make) => baseInput({ stage1Identity: make(realStage1Identity()) })],
      [
        `stage1Identity[${aliasRowIndex}].aliasSearchKeys`,
        (make) =>
          baseInput({
            stage1Identity: realStage1Identity().map((row, index) =>
              index === aliasRowIndex ? { ...row, aliasSearchKeys: make([...row.aliasSearchKeys]) } : row,
            ),
          }),
      ],
    ];

    const unexpected = (label, key) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "${key}"`);
    const symbolKeyed = (label) => new RegExp(`${escapeRegExp(label)} must not carry symbol-keyed own properties`);
    const arrayDefects = [
      ["an extra own name", (array) => Object.assign(array, { smuggled: "unhashed" }), (label) => unexpected(label, "smuggled")],
      ["an own toJSON", (array, calls) => Object.defineProperty(array, "toJSON", hookRecorder(calls, "toJSON")), (label) => unexpected(label, "toJSON")],
      ["an own map", (array, calls) => Object.defineProperty(array, "map", hookRecorder(calls, "map")), (label) => unexpected(label, "map")],
      ["an own sort", (array, calls) => Object.defineProperty(array, "sort", hookRecorder(calls, "sort")), (label) => unexpected(label, "sort")],
      [
        "an own Symbol.iterator",
        (array, calls) =>
          Object.defineProperty(array, Symbol.iterator, {
            value: function* iterate() {
              calls.push("iterator");
            },
            configurable: true,
            writable: true,
          }),
        symbolKeyed,
      ],
      ["a symbol-keyed own property", (array) => Object.assign(array, { [Symbol("hidden")]: "unhashed" }), symbolKeyed],
      ['a noncanonical index name "01"', (array) => Object.assign(array, { "01": "unhashed" }), (label) => unexpected(label, "01")],
      [
        "an extra accessor",
        (array, calls) =>
          Object.defineProperty(array, "shadow", {
            get() {
              calls.push("shadow");
              return "unhashed";
            },
            configurable: true,
          }),
        (label) => unexpected(label, "shadow"),
      ],
      ["a hidden index", (array) => hidden(array, 0), (label) => new RegExp(`${escapeRegExp(label)}\\[0\\] must be an enumerable own property`)],
    ];

    it("accepts the valid baselines the hostile cases are built from, frozen and JSON round-tripped included", () => {
      expect(() => buildPostStage1ExpansionPlan(baseInput())).not.toThrow();
      expect(aliasRowIndex).toBeGreaterThanOrEqual(0);
      for (const [label, build] of arrayLayers) {
        expect(() => buildPostStage1ExpansionPlan(build((array) => array)), label).not.toThrow();
        expect(() => buildPostStage1ExpansionPlan(build((array) => Object.freeze([...array]))), `${label} (frozen)`).not.toThrow();
        expect(() => buildPostStage1ExpansionPlan(build((array) => JSON.parse(JSON.stringify(array)))), `${label} (JSON)`).not.toThrow();
      }
    });

    it("rejects every hostile array shape at every array layer, running none of its hooks", () => {
      for (const [label, build] of arrayLayers) {
        for (const [defectLabel, install, pattern] of arrayDefects) {
          const calls = [];
          const input = build((array) => {
            install(array, calls);
            return array;
          });
          const where = `${label} with ${defectLabel}`;
          expect(() => buildPostStage1ExpansionPlan(input), where).toThrow(pattern(label));
          expect(calls, where).toEqual([]);
        }
        const subclassed = build((array) => {
          class Hooked extends Array {
            map() {
              throw new Error("subclass map ran");
            }
            sort() {
              throw new Error("subclass sort ran");
            }
          }
          return Hooked.from(array);
        });
        expect(() => buildPostStage1ExpansionPlan(subclassed), `${label} as an Array subclass`).toThrow(
          new RegExp(`${escapeRegExp(label)} must be a plain array; its prototype is neither Array\\.prototype nor null`),
        );
      }
    });

    const recordLayers = [
      ["input.seeds", () => hidden({ ...baseInput() }, "seeds")],
      ["config.schema", () => baseInput({ config: hidden({ ...VALID_CONFIG }, "schema") })],
      ["config.candidates[0].status", () => baseInput({ config: configWith([hidden({ ...VALID_CONFIG.candidates[0] }, "status")]) })],
      ["config.candidates[0].slug", () => baseInput({ config: configWith([hidden({ ...VALID_CONFIG.candidates[0] }, "slug")]) })],
      ["seeds[0].name", () => baseInput({ seeds: [hidden({ ...SYNTHETIC_SEEDS[0] }, "name")] })],
      ["overrides[0].awardName", () => baseInput({ overrides: [hidden({ ...SYNTHETIC_OVERRIDES[0] }, "awardName")] })],
      [
        "overrides[0].sources[0].confidence",
        () =>
          baseInput({
            overrides: [
              {
                ...SYNTHETIC_OVERRIDES[0],
                sources: [hidden({ ...SYNTHETIC_OVERRIDES[0].sources[0] }, "confidence"), SYNTHETIC_OVERRIDES[0].sources[1]],
              },
            ],
          }),
      ],
      [
        "stage1Identity[0].officialHomepage",
        () =>
          baseInput({
            stage1Identity: realStage1Identity().map((row, index) => (index === 0 ? hidden({ ...row }, "officialHomepage") : row)),
          }),
      ],
    ];

    it("rejects a hidden field at every record layer, reading nothing to decide", () => {
      for (const [label, build] of recordLayers) {
        expect(() => buildPostStage1ExpansionPlan(build()), label).toThrow(
          new RegExp(`${escapeRegExp(label)} must be an enumerable own property; JSON omits a hidden field`),
        );
      }
      // Deciding on the descriptor means the hidden VALUE is never touched.
      const calls = [];
      const hostile = {};
      for (const key of ["toJSON", "toString", "valueOf"]) {
        Object.defineProperty(hostile, key, {
          get() {
            calls.push(key);
            return () => "<x>";
          },
          configurable: true,
        });
      }
      const seed = { starterUrl: SYNTHETIC_SEEDS[0].starterUrl };
      Object.defineProperty(seed, "name", { value: hostile, enumerable: false, configurable: true, writable: true });
      expect(() => buildPostStage1ExpansionPlan(baseInput({ seeds: [seed] }))).toThrow(/seeds\[0\]\.name must be an enumerable own property/);
      expect(calls).toEqual([]);
    });

    it("describes a rejected non-string awardName inertly, like every other scalar site", () => {
      // requireNonEmptyString is the shared one now, so its message carries
      // the inert description too - by type for objects, exactly for
      // primitives - and nothing on the value is consulted to produce it.
      const calls = [];
      const hostile = {};
      for (const key of ["toJSON", "toString", "valueOf"]) {
        Object.defineProperty(hostile, key, {
          get() {
            calls.push(key);
            return () => "<x>";
          },
          configurable: true,
        });
      }
      const reject = (awardName) => {
        try {
          buildPostStage1ExpansionPlan(baseInput({ config: configWith([{ ...VALID_CONFIG.candidates[0], awardName }]) }));
        } catch (error) {
          return error.message;
        }
        throw new Error("expected a rejection");
      };
      expect(reject(hostile)).toMatch(/config\.candidates\[0\]\.awardName must be a non-empty string; got an object\.$/);
      expect(reject("")).toMatch(/awardName must be a non-empty string; got ""\.$/);
      expect(reject(42)).toMatch(/awardName must be a non-empty string; got 42\.$/);
      expect(calls).toEqual([]);
    });
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

// ---------------------------------------------------------------------------
// computePlanHash is exported, so its argument is untrusted input too.
// ---------------------------------------------------------------------------
describe("computePlanHash treats its argument as untrusted input", () => {
  const PLAN_PREFIX = "post-stage1 expansion plan: ";
  // A structural clone of a builder plan: plain, unfrozen, enumerable, with
  // planHash kept as the string the builder stored.
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const productionPlan = () => buildProductionPlan().plans[0];

  const hidden = (object, key) =>
    Object.defineProperty(object, key, { ...Object.getOwnPropertyDescriptor(object, key), enumerable: false });

  function replaceAt(root, path, make) {
    if (path.length === 0) return make(root);
    let parent = root;
    for (let index = 0; index < path.length - 1; index += 1) parent = parent[path[index]];
    const key = path[path.length - 1];
    parent[key] = make(parent[key]);
    return root;
  }

  // Records EVERY trap by name, so "zero traps" is a measurement.
  const countingProxy = (target, calls) =>
    new Proxy(
      target,
      new Proxy(
        {},
        {
          get:
            (_handler, trap) =>
            (...args) => {
              calls.push(`trap:${String(trap)}`);
              return Reflect[trap](...args);
            },
        },
      ),
    );

  const hookRecorder = (calls, key, result) => ({
    value: () => {
      calls.push(key);
      return result;
    },
    configurable: true,
    writable: true,
  });

  const messageOf = (run) => {
    try {
      run();
    } catch (error) {
      return error.message;
    }
    throw new Error("expected a rejection");
  };

  it("reproduces and closes the reported defect classes, running none of the hooks", () => {
    const plan = productionPlan();

    // 1. A changed source title hidden behind an own map returning originals.
    {
      const hooks = [];
      const p = clone(plan);
      p.monitorableSources[1].title = "Tampered Title";
      Object.defineProperty(p.monitorableSources, "map", {
        value: (fn) => {
          hooks.push("map");
          return plan.monitorableSources.map(fn);
        },
        configurable: true,
        writable: true,
      });
      expect(() => computePlanHash(p)).toThrow(/plan\.monitorableSources carries an unexpected own property "map"/);
      expect(hooks).toEqual([]);
    }

    // 2. An object-valued lifecycle flag whose toJSON returns false.
    {
      const hooks = [];
      const p = clone(plan);
      p.lifecycle.publicationEligibility = {
        toJSON() {
          hooks.push("toJSON");
          return false;
        },
      };
      expect(() => computePlanHash(p)).toThrow(/plan\.lifecycle\.publicationEligibility must be a boolean; got an object\./);
      expect(hooks).toEqual([]);
    }

    // 3. candidateId and an excludedDiscoveryUrls element masquerading as
    //    the strings they imitate.
    {
      const hooks = [];
      const p = clone(plan);
      p.candidateId = {
        toJSON() {
          hooks.push("toJSON");
          return plan.candidateId;
        },
      };
      expect(() => computePlanHash(p)).toThrow(/plan\.candidateId must be a non-empty string; got an object\./);
      const q = clone(plan);
      q.excludedDiscoveryUrls = plan.excludedDiscoveryUrls.map((url) => ({
        toJSON() {
          hooks.push("toJSON");
          return url;
        },
      }));
      expect(q.excludedDiscoveryUrls.length).toBeGreaterThan(0);
      expect(() => computePlanHash(q)).toThrow(/plan\.excludedDiscoveryUrls\[0\] must be a non-empty string; got an object\./);
      expect(hooks).toEqual([]);
    }

    // 4. A live Proxy plan reaches no trap; a revoked one is refused as a
    //    Proxy rather than escaping as a raw TypeError.
    {
      const traps = [];
      const live = countingProxy(clone(plan), traps);
      expect(messageOf(() => computePlanHash(live))).toBe(
        `${PLAN_PREFIX}plan must not be a Proxy; its traps could report a different shape than it yields.`,
      );
      expect(traps).toEqual([]);
      const { proxy, revoke } = Proxy.revocable(clone(plan), {});
      revoke();
      let caught;
      try {
        computePlanHash(proxy);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TypeError);
      expect(caught.message).toMatch(/^post-stage1 expansion plan: plan must not be a Proxy/);
    }

    // 5a. A hidden slug: previously the same hash while JSON dropped it.
    {
      const p = clone(plan);
      hidden(p, "slug");
      expect("slug" in JSON.parse(JSON.stringify(p))).toBe(false);
      expect(() => computePlanHash(p)).toThrow(/plan\.slug must be an enumerable own property/);
    }
    // 5b. An extra unknown root field.
    {
      const p = clone(plan);
      p.smuggled = "unhashed";
      expect(() => computePlanHash(p)).toThrow(/plan carries an unrecognized own field "smuggled"/);
    }
    // 5c. An own toJSON on the source array: previously exported 0 sources
    //     under the unchanged hash.
    {
      const hooks = [];
      const p = clone(plan);
      Object.defineProperty(p.monitorableSources, "toJSON", hookRecorder(hooks, "toJSON", []));
      expect(() => computePlanHash(p)).toThrow(/plan\.monitorableSources carries an unexpected own property "toJSON"/);
      expect(hooks).toEqual([]);
    }
    // 5d. An Array subclass whose map runs.
    {
      const hooks = [];
      class Hooked extends Array {
        map(...args) {
          hooks.push("subclass.map");
          return super.map(...args);
        }
      }
      const p = clone(plan);
      p.monitorableSources = Hooked.from(plan.monitorableSources);
      expect(() => computePlanHash(p)).toThrow(
        /plan\.monitorableSources must be a plain array; its prototype is neither Array\.prototype nor null/,
      );
      expect(hooks).toEqual([]);
    }
    // 5e. A getter leaf.
    {
      const hooks = [];
      const p = clone(plan);
      Object.defineProperty(p.homepage, "confidence", {
        get() {
          hooks.push("get");
          return 0.95;
        },
        enumerable: true,
        configurable: true,
      });
      expect(() => computePlanHash(p)).toThrow(/plan\.homepage\.confidence must be a plain data property, not an accessor/);
      expect(hooks).toEqual([]);
    }
    // 5f. Default-sort toString hooks on excludedDiscoveryUrls elements.
    {
      const hooks = [];
      const p = clone(plan);
      p.excludedDiscoveryUrls = ["https://b.example.org/", "https://a.example.org/"].map((url) => ({
        toString() {
          hooks.push("toString");
          return url;
        },
        toJSON: () => url,
      }));
      expect(() => computePlanHash(p)).toThrow(/plan\.excludedDiscoveryUrls\[0\] must be a non-empty string; got an object\./);
      expect(hooks).toEqual([]);
    }
  });

  const OBJECT_LAYERS = [
    ["plan", []],
    ["plan.seed", ["seed"]],
    ["plan.homepage", ["homepage"]],
    ["plan.lifecycle", ["lifecycle"]],
    ["plan.monitorableSources[0]", ["monitorableSources", 0]],
  ];
  const ARRAY_LAYERS = [
    ["plan.excludedDiscoveryUrls", ["excludedDiscoveryUrls"]],
    ["plan.monitorableSources", ["monitorableSources"]],
  ];
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("rejects a Proxy - live or revoked - at every layer, with no trap reached", () => {
    const plan = productionPlan();
    for (const [label, path] of [...OBJECT_LAYERS, ...ARRAY_LAYERS]) {
      const liveTraps = [];
      const live = replaceAt(clone(plan), path, (value) => countingProxy(value, liveTraps));
      expect(() => computePlanHash(live), `${label} (live)`).toThrow(new RegExp(`${escapeRegExp(label)} must not be a Proxy`));
      expect(liveTraps, `${label} (live)`).toEqual([]);

      const revokedTraps = [];
      const revoked = replaceAt(clone(plan), path, (value) => {
        const { proxy, revoke } = Proxy.revocable(value, {
          get(target, key, receiver) {
            revokedTraps.push(`get:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        });
        revoke();
        return proxy;
      });
      expect(() => computePlanHash(revoked), `${label} (revoked)`).toThrow(
        new RegExp(`^post-stage1 expansion plan: ${escapeRegExp(label)} must not be a Proxy`),
      );
      expect(revokedTraps, `${label} (revoked)`).toEqual([]);
    }
  });

  it("rejects accessors, exotic prototypes, unknown string keys and symbol keys at every object layer", () => {
    const plan = productionPlan();
    for (const [label, path] of OBJECT_LAYERS) {
      const getterCalls = [];
      const withGetter = replaceAt(clone(plan), path, (value) => {
        const key = Object.keys(value)[0];
        Object.defineProperty(value, key, {
          get() {
            getterCalls.push(key);
            return "hostile";
          },
          enumerable: true,
          configurable: true,
        });
        return value;
      });
      expect(() => computePlanHash(withGetter), `${label} (accessor)`).toThrow(/must be a plain data property, not an accessor/);
      expect(getterCalls, `${label} (accessor)`).toEqual([]);

      const protoCalls = [];
      const withProto = replaceAt(clone(plan), path, (value) =>
        Object.setPrototypeOf(value, {
          get status() {
            protoCalls.push("proto:status");
            return "ready";
          },
          toJSON() {
            protoCalls.push("proto:toJSON");
            return {};
          },
        }),
      );
      expect(() => computePlanHash(withProto), `${label} (exotic prototype)`).toThrow(
        new RegExp(`${escapeRegExp(label)} must be a plain object; its prototype is neither Object\\.prototype nor null`),
      );
      expect(protoCalls, `${label} (exotic prototype)`).toEqual([]);

      const unknown = replaceAt(clone(plan), path, (value) => {
        value.smuggled = "unhashed";
        return value;
      });
      expect(() => computePlanHash(unknown), `${label} (unknown field)`).toThrow(
        new RegExp(`${escapeRegExp(label)} carries an unrecognized own field "smuggled"`),
      );

      const symbolKeyed = replaceAt(clone(plan), path, (value) => {
        value[Symbol("hidden")] = "unhashed";
        return value;
      });
      expect(() => computePlanHash(symbolKeyed), `${label} (symbol key)`).toThrow(
        new RegExp(`${escapeRegExp(label)} must not carry symbol-keyed own properties`),
      );

      const notPlain = replaceAt(clone(plan), path, () => "not an object");
      expect(() => computePlanHash(notPlain), `${label} (non-object)`).toThrow(
        new RegExp(`${escapeRegExp(label)} must be an object\\.`),
      );
    }
  });

  it("requires exact dense plain arrays at both array layers, running none of their hooks", () => {
    const plan = productionPlan();
    const defects = [
      ["an extra own name", (array) => Object.assign(array, { smuggled: "x" }), (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "smuggled"`)],
      ["an own toJSON", (array, calls) => Object.defineProperty(array, "toJSON", hookRecorder(calls, "toJSON", [])), (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "toJSON"`)],
      ["an own map", (array, calls) => Object.defineProperty(array, "map", hookRecorder(calls, "map", [])), (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "map"`)],
      ["an own sort", (array, calls) => Object.defineProperty(array, "sort", hookRecorder(calls, "sort", [])), (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "sort"`)],
      [
        "an own Symbol.iterator",
        (array, calls) =>
          Object.defineProperty(array, Symbol.iterator, {
            value: function* iterate() {
              calls.push("iterator");
            },
            configurable: true,
            writable: true,
          }),
        (label) => new RegExp(`${escapeRegExp(label)} must not carry symbol-keyed own properties`),
      ],
      ["a symbol key", (array) => Object.assign(array, { [Symbol("hidden")]: "x" }), (label) => new RegExp(`${escapeRegExp(label)} must not carry symbol-keyed own properties`)],
      ['a noncanonical index "01"', (array) => Object.assign(array, { "01": "x" }), (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "01"`)],
      [
        "an extra accessor",
        (array, calls) =>
          Object.defineProperty(array, "shadow", {
            get() {
              calls.push("shadow");
              return "x";
            },
            configurable: true,
          }),
        (label) => new RegExp(`${escapeRegExp(label)} carries an unexpected own property "shadow"`),
      ],
      ["a hidden index", (array) => hidden(array, 0), (label) => new RegExp(`${escapeRegExp(label)}\\[0\\] must be an enumerable own property`)],
      [
        "a hole",
        (array) => {
          delete array[0];
          return array;
        },
        (label) => new RegExp(`${escapeRegExp(label)}\\[0\\] is a hole`),
      ],
      [
        "an indexed accessor",
        (array, calls) =>
          Object.defineProperty(array, 0, {
            get() {
              calls.push("index0");
              return "x";
            },
            enumerable: true,
            configurable: true,
          }),
        (label) => new RegExp(`${escapeRegExp(label)}\\[0\\] must be a plain data property, not an accessor`),
      ],
    ];
    for (const [label, path] of ARRAY_LAYERS) {
      expect(replaceAt(clone(plan), path, (array) => array)[path[0]].length, label).toBeGreaterThan(0);
      for (const [defectLabel, install, pattern] of defects) {
        const calls = [];
        const tampered = replaceAt(clone(plan), path, (array) => {
          install(array, calls);
          return array;
        });
        const where = `${label} with ${defectLabel}`;
        expect(() => computePlanHash(tampered), where).toThrow(pattern(label));
        expect(calls, where).toEqual([]);
      }
      const subclassed = replaceAt(clone(plan), path, (array) => {
        class Hooked extends Array {
          sort() {
            throw new Error("subclass sort ran");
          }
        }
        return Hooked.from(array);
      });
      expect(() => computePlanHash(subclassed), `${label} (subclass)`).toThrow(new RegExp(`${escapeRegExp(label)} must be a plain array`));
      const notAnArray = replaceAt(clone(plan), path, (array) => ({ ...array, length: array.length }));
      expect(() => computePlanHash(notAnArray), `${label} (not an array)`).toThrow(new RegExp(`${escapeRegExp(label)} must be an array`));
    }
  });

  it("rejects a hidden field on every accepted field of every layer", () => {
    const plan = productionPlan();
    const checked = [];
    for (const [label, path] of OBJECT_LAYERS) {
      const fields = Object.keys(path.reduce((node, key) => node[key], clone(plan)));
      expect(fields.length, label).toBeGreaterThan(0);
      for (const key of fields) {
        const tampered = replaceAt(clone(plan), path, (value) => {
          hidden(value, key);
          return value;
        });
        const where = `${label}.${key}`;
        expect(() => computePlanHash(tampered), where).toThrow(
          new RegExp(`${escapeRegExp(where)} must be an enumerable own property`),
        );
        checked.push(where);
      }
    }
    // 11 root (planHash included) + 3 seed + 3 homepage + 5 lifecycle + 5 source.
    expect(checked).toHaveLength(27);
    expect(checked).toContain("plan.planHash");
    expect(checked).toContain("plan.seed.seedIndex");
    expect(checked).toContain("plan.monitorableSources[0].canonicalUrlKey");
  });

  it("rejects representative wrong-type leaves without executing them", () => {
    const plan = productionPlan();
    const calls = [];
    const hostile = {};
    for (const key of ["toJSON", "toString", "valueOf"]) {
      Object.defineProperty(hostile, key, {
        get() {
          calls.push(key);
          return () => "<x>";
        },
        configurable: true,
      });
    }
    const cases = [
      ["plan.candidateId", ["candidateId"], 7, /plan\.candidateId must be a non-empty string; got 7\./],
      ["plan.awardName", ["awardName"], "", /plan\.awardName must be a non-empty string; got ""\./],
      ["plan.slug (not string or null)", ["slug"], 7, /plan\.slug must be a non-empty string; got 7\./],
      ["plan.slug (absent)", ["slug"], undefined, /plan\.slug must be a non-empty string; got undefined\./],
      ["plan.seed.seedIndex negative", ["seed", "seedIndex"], -1, /plan\.seed\.seedIndex must be a non-negative integer; got -1\./],
      ["plan.seed.seedIndex string", ["seed", "seedIndex"], "3", /plan\.seed\.seedIndex must be a non-negative integer; got "3"\./],
      ["plan.seed.seedIndex fraction", ["seed", "seedIndex"], 1.5, /plan\.seed\.seedIndex must be a non-negative integer; got 1\.5\./],
      ["plan.homepage.confidence string", ["homepage", "confidence"], "0.9", /plan\.homepage\.confidence must be a finite number; got "0\.9"\./],
      ["plan.homepage.confidence NaN", ["homepage", "confidence"], Number.NaN, /plan\.homepage\.confidence must be a finite number; got NaN\./],
      ["plan.homepage.confidence Infinity", ["homepage", "confidence"], Number.POSITIVE_INFINITY, /plan\.homepage\.confidence must be a finite number; got Infinity\./],
      ["source pageType number", ["monitorableSources", 0, "pageType"], 1, /plan\.monitorableSources\[0\]\.pageType must be a non-empty string; got 1\./],
      ["source confidence null", ["monitorableSources", 0, "confidence"], null, /plan\.monitorableSources\[0\]\.confidence must be a finite number; got null\./],
      ["lifecycle flag string", ["lifecycle", "monitoringReadiness"], "false", /plan\.lifecycle\.monitoringReadiness must be a boolean; got "false"\./],
      ["lifecycle flag number", ["lifecycle", "publicationEligibility"], 0, /plan\.lifecycle\.publicationEligibility must be a boolean; got 0\./],
      ["lifecycle string null", ["lifecycle", "currentCycleAuthority"], null, /plan\.lifecycle\.currentCycleAuthority must be a non-empty string; got null\./],
      ["excluded URL element number", ["excludedDiscoveryUrls", 0], 1, /plan\.excludedDiscoveryUrls\[0\] must be a non-empty string; got 1\./],
      ["planHash number", ["planHash"], 12345, /plan\.planHash must be null or a string; got 12345\./],
      ["hostile object leaf", ["seed", "name"], hostile, /plan\.seed\.name must be a non-empty string; got an object\./],
    ];
    for (const [label, path, value, pattern] of cases) {
      const tampered = replaceAt(clone(plan), path, () => value);
      expect(() => computePlanHash(tampered), label).toThrow(pattern);
    }
    expect(calls).toEqual([]);
  });

  it("binds every material leaf and excludes exactly seedIndex and planHash", () => {
    const plan = productionPlan();
    const mutations = [
      ["candidateId", ["candidateId"], "someone_else"],
      ["awardName", ["awardName"], "Renamed"],
      ["normalizedAwardKey", ["normalizedAwardKey"], "renamed"],
      ["status", ["status"], "some-other-status"],
      ["slug string", ["slug"], "different-slug"],
      ["slug to null", ["slug"], null],
      ["seed.name", ["seed", "name"], "Renamed Seed"],
      ["seed.starterUrl", ["seed", "starterUrl"], "https://elsewhere.example.org/"],
      ["excludedDiscoveryUrls element", ["excludedDiscoveryUrls", 0], "https://elsewhere.example.org/"],
      ["excludedDiscoveryUrls emptied", ["excludedDiscoveryUrls"], []],
      ["excludedDiscoveryUrls extended", ["excludedDiscoveryUrls"], [...plan.excludedDiscoveryUrls, "https://another.example.org/"]],
      ["homepage.url", ["homepage", "url"], "https://elsewhere.example.org/"],
      ["homepage.title", ["homepage", "title"], "Different Title"],
      ["homepage.confidence", ["homepage", "confidence"], 0.42],
      ["source url", ["monitorableSources", 1, "url"], "https://elsewhere.example.org/tampered"],
      ["source title", ["monitorableSources", 1, "title"], "Tampered Title"],
      ["source pageType", ["monitorableSources", 1, "pageType"], "eligibility"],
      ["source confidence", ["monitorableSources", 1, "confidence"], 0.01],
      ["source canonicalUrlKey", ["monitorableSources", 1, "canonicalUrlKey"], "tampered/key"],
      ["source removed", ["monitorableSources"], plan.monitorableSources.slice(1)],
      ["lifecycle.currentCycleAuthority", ["lifecycle", "currentCycleAuthority"], "resolved"],
      ["lifecycle.humanSourceReview", ["lifecycle", "humanSourceReview"], "resolved"],
      ["lifecycle.remoteIdentityCollisionCheck", ["lifecycle", "remoteIdentityCollisionCheck"], "resolved"],
      // A flipped gate is a MATERIAL change that must move the digest - it is
      // not the hasher's job to refuse or reset it.
      ["lifecycle.monitoringReadiness", ["lifecycle", "monitoringReadiness"], true],
      ["lifecycle.publicationEligibility", ["lifecycle", "publicationEligibility"], true],
    ];
    for (const [label, path, value] of mutations) {
      const tampered = replaceAt(clone(plan), path, () => value);
      expect(computePlanHash(tampered), label).not.toBe(plan.planHash);
    }
    // A null slug is bound as null, distinct from any string.
    const nullSlug = clone(plan);
    nullSlug.slug = null;
    const stringSlug = clone(plan);
    stringSlug.slug = "x";
    expect(computePlanHash(nullSlug)).not.toBe(computePlanHash(stringSlug));

    // Documented exclusions stay stable.
    const movedSeed = clone(plan);
    movedSeed.seed.seedIndex += 500;
    expect(computePlanHash(movedSeed)).toBe(plan.planHash);
    const forged = clone(plan);
    forged.planHash = "0".repeat(64);
    expect(computePlanHash(forged)).toBe(plan.planHash);
    const nullHash = clone(plan);
    nullHash.planHash = null;
    expect(computePlanHash(nullHash)).toBe(plan.planHash);
    const absentHash = clone(plan);
    delete absentHash.planHash;
    expect(computePlanHash(absentHash)).toBe(plan.planHash);
  });

  it("accepts builder output, frozen copies, JSON round-trips and null-prototype equivalents with identical hashes", () => {
    const deepFreeze = (value) => {
      if (Array.isArray(value)) value.forEach(deepFreeze);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    };
    const nullProto = (value) =>
      Array.isArray(value)
        ? value.map(nullProto)
        : value !== null && typeof value === "object"
          ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, nullProto(inner)])))
          : value;
    const keyShape = (value) =>
      Array.isArray(value)
        ? value.map(keyShape)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, keyShape(value[key])]))
          : typeof value;

    const result = buildProductionPlan();
    expect(result.plans).toHaveLength(2);
    for (const plan of result.plans) {
      expect(computePlanHash(plan), plan.candidateId).toBe(plan.planHash);
      expect(computePlanHash(deepFreeze(clone(plan))), `${plan.candidateId} (frozen)`).toBe(plan.planHash);
      const exported = JSON.parse(JSON.stringify(plan));
      expect(computePlanHash(exported), `${plan.candidateId} (JSON round trip)`).toBe(plan.planHash);
      expect(keyShape(exported), `${plan.candidateId} (JSON key shape)`).toEqual(keyShape(plan));
      expect(computePlanHash(nullProto(clone(plan))), `${plan.candidateId} (null prototype)`).toBe(plan.planHash);
    }
    expect(planFor(result, "mitchell").planHash).toBe("c64098d958e6ab8bdbda82764ab8c2890c76e343d328e5e0d4e0fac670c1f3b1");
    expect(planFor(result, "tillman").planHash).toBe("53d845215b34d21a90afaa0c0b92324e4edc8bb35d0cf62b5694055f8c58e44b");
  });

  it("serializes only a graph it built itself, sorting only its own fresh copies", () => {
    const plan = productionPlan();
    const pristine = clone(plan);
    const map = vi.spyOn(Array.prototype, "map");
    const sort = vi.spyOn(Array.prototype, "sort");
    const forEach = vi.spyOn(Array.prototype, "forEach");
    try {
      expect(computePlanHash(pristine)).toBe(plan.planHash);
      // Exactly the two sorts of the helper's own fresh copies, and no map.
      expect(sort.mock.calls.length).toBe(2);
      expect(sort.mock.contexts).toHaveLength(2);
      expect(sort.mock.contexts.every((context) => context !== pristine.monitorableSources && context !== pristine.excludedDiscoveryUrls)).toBe(true);
      expect(map.mock.calls.length).toBe(0);
      expect(forEach.mock.calls.length).toBe(0);
    } finally {
      map.mockRestore();
      sort.mockRestore();
      forEach.mockRestore();
    }
  });

  it("rejects prototype-laundered boxed primitives at every record layer, consulting no slot value and no hook", () => {
    // A Boolean, Number, String, BigInt or Symbol wrapper whose prototype has
    // been reset to Object.prototype or null passes a prototype check - and,
    // for the four kinds that own no properties, an exact-field check too -
    // yet it keeps its primitive in an internal slot, so JSON.stringify emits
    // that primitive (or throws) instead of the fields the digest bound. The
    // reviewer's root reproduction: a Boolean(false) wearing a valid plan
    // hashed identically to the plan and serialized as "false".
    const plan = productionPlan();
    const wrapped = Object.assign(Object.setPrototypeOf(new Boolean(false), Object.prototype), clone(plan));
    expect(JSON.stringify(wrapped)).toBe("false");
    expect(() => computePlanHash(wrapped)).toThrow(
      /^post-stage1 expansion plan: plan must be a plain object, not a boxed primitive; a Boolean, Number, String, BigInt or Symbol wrapper keeps its primitive in an internal slot/,
    );

    const kinds = [
      ["Boolean", () => new Boolean(false)],
      ["Number", () => new Number(0)],
      ["String (empty, no index)", () => new String("")],
      ["String (indexed)", () => new String("x")],
      ["BigInt", () => Object(1n)],
      ["Symbol", () => Object(Symbol("s"))],
    ];
    const boxedMessage = (label) =>
      new RegExp(`^post-stage1 expansion plan: ${escapeRegExp(label)} must be a plain object, not a boxed primitive; `);

    let checked = 0;
    for (const [label, path] of OBJECT_LAYERS) {
      for (const proto of [Object.prototype, null]) {
        for (const [kind, make] of kinds) {
          const hooks = [];
          const tampered = replaceAt(clone(plan), path, (value) => {
            const laundered = Object.assign(Object.setPrototypeOf(make(), proto), value);
            // Own coercion hooks as ACCESSORS, so merely looking for one is
            // observable. The boxed check must fire on the internal slot
            // alone - before any own field, hook or symbol key is consulted,
            // which is also why these extra keys are not what gets reported.
            for (const key of ["toJSON", "toString", "valueOf"]) {
              Object.defineProperty(laundered, key, {
                get() {
                  hooks.push(key);
                  return () => "<x>";
                },
                configurable: true,
              });
            }
            Object.defineProperty(laundered, Symbol.toPrimitive, {
              get() {
                hooks.push("Symbol.toPrimitive");
                return () => "<x>";
              },
              configurable: true,
            });
            return laundered;
          });
          const where = `${label} as a laundered ${kind} on ${proto === null ? "null" : "Object.prototype"}`;
          expect(() => computePlanHash(tampered), where).toThrow(boxedMessage(label));
          expect(hooks, where).toEqual([]);
          checked += 1;
        }
      }
    }
    // 5 record layers x 2 prototypes x 6 wrapper shapes.
    expect(checked).toBe(60);

    // Proxy-first still holds ahead of the boxed check: a Proxy around a
    // laundered wrapper is refused as a Proxy, with no trap reached.
    const traps = [];
    const proxied = countingProxy(Object.assign(Object.setPrototypeOf(new Number(0), Object.prototype), clone(plan)), traps);
    expect(() => computePlanHash(proxied)).toThrow(/^post-stage1 expansion plan: plan must not be a Proxy/);
    expect(traps).toEqual([]);

    // The guard reads internal slots, not shape: ordinary records, including
    // null-prototype ones, are untouched and still hash to the stored value.
    expect(computePlanHash(clone(plan))).toBe(plan.planHash);
    expect(computePlanHash(Object.assign(Object.create(null), clone(plan)))).toBe(plan.planHash);
  });
});

// ---------------------------------------------------------------------------
// stage1IdentityContentDigest is exported, so its rows are untrusted input.
// ---------------------------------------------------------------------------
describe("stage1IdentityContentDigest treats its rows as untrusted input", () => {
  const FROZEN = "a6493d81606bd408d6291ef8dc193866168f155de10ee268ccca0efc6d387363";
  const PREFIX = "post-stage1 expansion plan: ";
  const FIELDS = ["cohortKey", "canonicalName", "canonicalSearchKey", "aliasSearchKeys", "canonicalSlug", "officialHomepage"];
  const messageOf = (run) => {
    try {
      run();
    } catch (error) {
      return error.message;
    }
    throw new Error("expected a rejection");
  };
  // Records EVERY trap by name, so "zero traps" is a measurement.
  const countingProxy = (target, calls) =>
    new Proxy(
      target,
      new Proxy(
        {},
        {
          get:
            (_handler, trap) =>
            (...args) => {
              calls.push(`trap:${String(trap)}`);
              return Reflect[trap](...args);
            },
        },
      ),
    );
  const hidden = (object, key) =>
    Object.defineProperty(object, key, { ...Object.getOwnPropertyDescriptor(object, key), enumerable: false });
  // Own coercion hooks as ACCESSORS, so merely looking for one is observable.
  const accessorHooks = (object, calls) => {
    for (const key of ["toJSON", "toString", "valueOf"]) {
      Object.defineProperty(object, key, {
        get() {
          calls.push(key);
          return () => "<x>";
        },
        configurable: true,
      });
    }
    Object.defineProperty(object, Symbol.toPrimitive, {
      get() {
        calls.push("Symbol.toPrimitive");
        return () => "<x>";
      },
      configurable: true,
    });
    Object.defineProperty(object, Symbol.toStringTag, {
      get() {
        calls.push("Symbol.toStringTag");
        return "Plain";
      },
      configurable: true,
    });
    return object;
  };
  // The regeneration snippet's exact shape: whole cohort definition entries
  // plus the slug, carrying launchRank, identityRules, preferredPaths and
  // delegatedAuthorities alongside the six projected fields.
  const snippetRows = () => {
    const slugByKey = new Map(stage1CohortIdentity.map((row) => [row[1], row[4]]));
    return STAGE1_COHORT_DEFINITION.map((cohort) => ({ ...cohort, canonicalSlug: slugByKey.get(cohort.cohortKey) }));
  };
  // A fresh real cohort with row `index` replaced by make(row).
  const withRow = (index, make) => {
    const rows = realStage1Identity();
    rows[index] = make(rows[index]);
    return rows;
  };

  it("pins the frozen digest from every valid shape and keeps row and alias order immaterial", () => {
    const real = realStage1Identity();
    expect(real).toHaveLength(25);
    expect(stage1IdentityContentDigest(real)).toBe(FROZEN);
    expect(stage1IdentityContentDigest([...real].reverse())).toBe(FROZEN);
    expect(stage1IdentityContentDigest(real.map((row) => ({ ...row, aliasSearchKeys: [...row.aliasSearchKeys].reverse() })))).toBe(FROZEN);

    const snippet = snippetRows();
    expect(Object.keys(snippet[0])).toEqual(
      expect.arrayContaining(["launchRank", "identityRules", "preferredPaths", "delegatedAuthorities"]),
    );
    expect(stage1IdentityContentDigest(snippet)).toBe(FROZEN);

    const deepFreeze = (value) => {
      if (Array.isArray(value)) value.forEach(deepFreeze);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    };
    expect(stage1IdentityContentDigest(deepFreeze(realStage1Identity()))).toBe(FROZEN);
    expect(stage1IdentityContentDigest(JSON.parse(JSON.stringify(real)))).toBe(FROZEN);
    const nullProto = (value) =>
      Array.isArray(value)
        ? value.map(nullProto)
        : value !== null && typeof value === "object"
          ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, nullProto(inner)])))
          : value;
    expect(stage1IdentityContentDigest(nullProto(real))).toBe(FROZEN);
    expect(stage1IdentityContentDigest(Object.setPrototypeOf([...real], null))).toBe(FROZEN);

    // Absent aliases mean none, identically to an explicit empty array.
    const withoutAliases = realStage1Identity().map((row) => {
      const copy = { ...row };
      if (copy.aliasSearchKeys.length === 0) delete copy.aliasSearchKeys;
      return copy;
    });
    expect(withoutAliases.some((row) => !Object.hasOwn(row, "aliasSearchKeys"))).toBe(true);
    expect(stage1IdentityContentDigest(withoutAliases)).toBe(FROZEN);

    // The planner's internal path still anchors on the same constant.
    expect(planFor(buildProductionPlan(), "mitchell").planHash).toBe("c64098d958e6ab8bdbda82764ab8c2890c76e343d328e5e0d4e0fac670c1f3b1");

    // Inputs are never mutated: reversed alias order and row order survive.
    const input = realStage1Identity().map((row) => ({ ...row, aliasSearchKeys: [...row.aliasSearchKeys].reverse() })).reverse();
    const before = JSON.stringify(input);
    expect(stage1IdentityContentDigest(input)).toBe(FROZEN);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("refuses a hostile outer array before reading any row, with no trap or hook", () => {
    const real = realStage1Identity();
    const traps = [];
    expect(messageOf(() => stage1IdentityContentDigest(countingProxy([...real], traps)))).toBe(
      `${PREFIX}rows must not be a Proxy; its traps could report a different shape than it yields.`,
    );
    const { proxy, revoke } = Proxy.revocable([...real], {});
    revoke();
    let caught;
    try {
      stage1IdentityContentDigest(proxy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.message).toMatch(/^post-stage1 expansion plan: rows must not be a Proxy/);
    expect(traps).toEqual([]);

    const hooks = [];
    class Hooked extends Array {
      map() {
        hooks.push("subclass.map");
        return [];
      }
      sort() {
        hooks.push("subclass.sort");
        return this;
      }
    }
    expect(() => stage1IdentityContentDigest(Hooked.from(real))).toThrow(
      /^post-stage1 expansion plan: rows must be a plain array; its prototype is neither Array\.prototype nor null/,
    );
    const cases = [
      ["own map", (a) => Object.defineProperty(a, "map", { value: () => { hooks.push("own map"); return []; }, configurable: true, writable: true }), /rows carries an unexpected own property "map"/],
      ["own sort", (a) => Object.defineProperty(a, "sort", { value: () => { hooks.push("own sort"); return a; }, configurable: true, writable: true }), /rows carries an unexpected own property "sort"/],
      ["own toJSON", (a) => Object.defineProperty(a, "toJSON", { value: () => { hooks.push("toJSON"); return []; }, configurable: true, writable: true }), /rows carries an unexpected own property "toJSON"/],
      ["extra name", (a) => { a.smuggled = "x"; }, /rows carries an unexpected own property "smuggled"/],
      ["symbol key", (a) => { a[Symbol("s")] = "x"; }, /rows must not carry symbol-keyed own properties/],
      ['noncanonical "01"', (a) => { a["01"] = "x"; }, /rows carries an unexpected own property "01"/],
      ["hidden index", (a) => hidden(a, 0), /rows\[0\] must be an enumerable own property/],
      ["hole", (a) => { delete a[0]; }, /rows\[0\] is a hole/],
      ["indexed accessor", (a) => Object.defineProperty(a, 0, { get() { hooks.push("index0"); return real[0]; }, enumerable: true, configurable: true }), /rows\[0\] must be a plain data property, not an accessor/],
    ];
    for (const [label, install, pattern] of cases) {
      const copy = [...real];
      install(copy);
      expect(() => stage1IdentityContentDigest(copy), label).toThrow(pattern);
    }
    expect(() => stage1IdentityContentDigest({ ...real, length: real.length })).toThrow(/^post-stage1 expansion plan: rows must be an array\./);
    expect(hooks).toEqual([]);
  });

  it("refuses every hostile row shape and every hostile projected field, reading each field exactly once", () => {
    const real = realStage1Identity();
    const calls = [];
    // Proxy record, live and revoked; exotic prototype; laundered wrappers.
    expect(() => stage1IdentityContentDigest(withRow(0, (row) => countingProxy(row, calls)))).toThrow(
      /^post-stage1 expansion plan: rows\[0\] must not be a Proxy/,
    );
    const { proxy, revoke } = Proxy.revocable({ ...real[0] }, {});
    revoke();
    let caught;
    try {
      stage1IdentityContentDigest(withRow(0, () => proxy));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.message).toMatch(/^post-stage1 expansion plan: rows\[0\] must not be a Proxy/);
    expect(() => stage1IdentityContentDigest(withRow(3, (row) => Object.assign(Object.create({ canonicalName: "inherited" }), row)))).toThrow(
      /^post-stage1 expansion plan: rows\[3\] must be a plain object; its prototype is neither Object\.prototype nor null/,
    );
    const wrappers = [
      ["Boolean", () => new Boolean(false)],
      ["Number", () => new Number(0)],
      ["empty String", () => new String("")],
      ["indexed String", () => new String("ab")],
      ["BigInt", () => Object(1n)],
      ["Symbol", () => Object(Symbol("s"))],
    ];
    let boxed = 0;
    for (const [kind, make] of wrappers) {
      for (const proto of [Object.prototype, null]) {
        const rows = withRow(7, (row) => accessorHooks(Object.assign(Object.setPrototypeOf(make(), proto), row), calls));
        expect(() => stage1IdentityContentDigest(rows), `${kind} on ${proto === null ? "null" : "Object.prototype"}`).toThrow(
          /^post-stage1 expansion plan: rows\[7\] must be a plain object, not a boxed primitive; /,
        );
        boxed += 1;
      }
    }
    expect(boxed).toBe(12);
    expect(calls).toEqual([]);

    // Every projected field: missing (aliases excepted - absent is legitimate
    // and pinned above), hidden, accessor, object/coercion leaf, wrong type.
    const missing = {
      cohortKey: /^post-stage1 expansion plan: rows\[0\]\.cohortKey must be a canonical identifier matching .*; got undefined\./,
      canonicalName: /rows\[0\]\.canonicalName must be a non-empty string; got undefined\./,
      canonicalSearchKey: /rows\[0\]\.canonicalSearchKey must be a non-empty string; got undefined\./,
      canonicalSlug: /rows\[0\]\.canonicalSlug must be a canonical identifier matching .*; got undefined\./,
      officialHomepage: /rows\[0\]\.officialHomepage must be a non-empty string; got undefined\./,
    };
    for (const field of FIELDS) {
      if (field !== "aliasSearchKeys") {
        expect(
          () =>
            stage1IdentityContentDigest(
              withRow(0, (row) => {
                const copy = { ...row };
                delete copy[field];
                return copy;
              }),
            ),
          `${field} missing`,
        ).toThrow(missing[field]);
      }
      expect(() => stage1IdentityContentDigest(withRow(0, (row) => hidden({ ...row }, field))), `${field} hidden`).toThrow(
        new RegExp(`rows\\[0\\]\\.${field} must be an enumerable own property`),
      );
      const accessorCalls = [];
      expect(
        () =>
          stage1IdentityContentDigest(
            withRow(0, (row) => {
              const copy = { ...row };
              const value = copy[field];
              Object.defineProperty(copy, field, {
                get() {
                  accessorCalls.push(field);
                  return value;
                },
                enumerable: true,
                configurable: true,
              });
              return copy;
            }),
          ),
        `${field} accessor`,
      ).toThrow(new RegExp(`rows\\[0\\]\\.${field} must be a plain data property, not an accessor`));
      expect(accessorCalls, `${field} accessor`).toEqual([]);
      const leaf = accessorHooks({}, calls);
      expect(() => stage1IdentityContentDigest(withRow(0, (row) => ({ ...row, [field]: leaf }))), `${field} object leaf`).toThrow(
        field === "aliasSearchKeys" ? /rows\[0\]\.aliasSearchKeys must be an array\./ : new RegExp(`rows\\[0\\]\\.${field} must .*; got an object\\.`),
      );
    }
    expect(calls).toEqual([]);
    const wrongTypes = [
      ["cohortKey", 7, /rows\[0\]\.cohortKey must be a canonical identifier matching .*; got 7\./],
      ["cohortKey", "Boren", /rows\[0\]\.cohortKey must be a canonical identifier matching .*; got "Boren"\./],
      ["canonicalName", "", /rows\[0\]\.canonicalName must be a non-empty string; got ""\./],
      ["canonicalSearchKey", 1n, /rows\[0\]\.canonicalSearchKey must be a non-empty string; got 1\./],
      ["canonicalSlug", "Not A Slug", /rows\[0\]\.canonicalSlug must be a canonical identifier matching .*; got "Not A Slug"\./],
      ["officialHomepage", "http://insecure.example.org/", /rows\[0\]\.officialHomepage must be an absolute HTTPS URL; got "http:\/\/insecure\.example\.org\/"\./],
      ["officialHomepage", true, /rows\[0\]\.officialHomepage must be a non-empty string; got true\./],
    ];
    for (const [field, value, pattern] of wrongTypes) {
      expect(() => stage1IdentityContentDigest(withRow(0, (row) => ({ ...row, [field]: value }))), `${field} = ${String(value)}`).toThrow(pattern);
    }

    // Each projected field's descriptor is read exactly once per row, and
    // nothing else on the row is read at all.
    const spy = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      const rows = realStage1Identity();
      const target = rows[0];
      expect(stage1IdentityContentDigest(rows)).toBe(FROZEN);
      const readsOnTarget = spy.mock.calls.filter(([object]) => object === target).map(([, key]) => key);
      expect([...readsOnTarget].sort()).toEqual([...FIELDS].sort());
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshots aliases fresh: absent means none, null is refused, hostile arrays and elements are refused with no hook", () => {
    const withAliases = (make) => {
      const rows = realStage1Identity();
      const index = rows.findIndex((row) => row.aliasSearchKeys.length > 1);
      rows[index] = { ...rows[index], aliasSearchKeys: make(rows[index].aliasSearchKeys) };
      return [rows, index];
    };
    const hooks = [];
    const [nullRows, nullIndex] = withAliases(() => null);
    expect(() => stage1IdentityContentDigest(nullRows)).toThrow(
      new RegExp(`^post-stage1 expansion plan: rows\\[${nullIndex}\\]\\.aliasSearchKeys must be an array\\.`),
    );
    const [proxyRows, proxyIndex] = withAliases((aliases) => countingProxy([...aliases], hooks));
    expect(() => stage1IdentityContentDigest(proxyRows)).toThrow(new RegExp(`rows\\[${proxyIndex}\\]\\.aliasSearchKeys must not be a Proxy`));
    const [revokedRows] = withAliases((aliases) => {
      const { proxy, revoke } = Proxy.revocable([...aliases], {});
      revoke();
      return proxy;
    });
    let caught;
    try {
      stage1IdentityContentDigest(revokedRows);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.message).toMatch(/aliasSearchKeys must not be a Proxy/);
    class Hooked extends Array {
      sort() {
        hooks.push("subclass.sort");
        return this;
      }
    }
    const [subclassRows] = withAliases((aliases) => Hooked.from(aliases));
    expect(() => stage1IdentityContentDigest(subclassRows)).toThrow(/aliasSearchKeys must be a plain array/);
    const arrayDefects = [
      ["hole", (a) => { delete a[0]; }, /aliasSearchKeys\[0\] is a hole/],
      ["extra name", (a) => { a.smuggled = "x"; }, /aliasSearchKeys carries an unexpected own property "smuggled"/],
      ["own sort", (a) => Object.defineProperty(a, "sort", { value: () => { hooks.push("own sort"); return a; }, configurable: true, writable: true }), /aliasSearchKeys carries an unexpected own property "sort"/],
      ["own toJSON", (a) => Object.defineProperty(a, "toJSON", { value: () => { hooks.push("toJSON"); return []; }, configurable: true, writable: true }), /aliasSearchKeys carries an unexpected own property "toJSON"/],
      ["symbol key", (a) => { a[Symbol("s")] = "x"; }, /aliasSearchKeys must not carry symbol-keyed own properties/],
      ["indexed accessor", (a) => Object.defineProperty(a, 0, { get() { hooks.push("index0"); return "x"; }, enumerable: true, configurable: true }), /aliasSearchKeys\[0\] must be a plain data property, not an accessor/],
      ["hidden index", (a) => hidden(a, 0), /aliasSearchKeys\[0\] must be an enumerable own property/],
    ];
    for (const [label, install, pattern] of arrayDefects) {
      const [rows] = withAliases((aliases) => {
        const copy = [...aliases];
        install(copy);
        return copy;
      });
      expect(() => stage1IdentityContentDigest(rows), label).toThrow(pattern);
    }
    const [objectElement] = withAliases((aliases) => [accessorHooks({}, hooks), ...aliases.slice(1)]);
    expect(() => stage1IdentityContentDigest(objectElement)).toThrow(/aliasSearchKeys\[0\] must be a non-empty string; got an object\./);
    const [numberElement] = withAliases((aliases) => [7, ...aliases.slice(1)]);
    expect(() => stage1IdentityContentDigest(numberElement)).toThrow(/aliasSearchKeys\[0\] must be a non-empty string; got 7\./);
    const [emptyElement] = withAliases((aliases) => ["", ...aliases.slice(1)]);
    expect(() => stage1IdentityContentDigest(emptyElement)).toThrow(/aliasSearchKeys\[0\] must be a non-empty string; got ""\./);
    expect(hooks).toEqual([]);

    // Sorting happens only on fresh copies: one sort per row plus one for
    // the payloads, none of them on a caller array, and no map at all.
    const input = realStage1Identity();
    const callerArrays = new Set([input, ...input.map((row) => row.aliasSearchKeys)]);
    const sort = vi.spyOn(Array.prototype, "sort");
    const map = vi.spyOn(Array.prototype, "map");
    try {
      expect(stage1IdentityContentDigest(input)).toBe(FROZEN);
      expect(sort.mock.calls.length).toBe(input.length + 1);
      expect(sort.mock.contexts.every((context) => !callerArrays.has(context))).toBe(true);
      expect(map.mock.calls.length).toBe(0);
    } finally {
      sort.mockRestore();
      map.mockRestore();
    }
  });

  it("ignores every unknown row field without reading it, and binds every projected one", () => {
    const calls = [];
    const decorated = realStage1Identity().map((row) => {
      const copy = { ...row, launchRank: 3, identityRules: ["x"], preferredPaths: { a: 1 }, delegatedAuthorities: [] };
      accessorHooks(copy, calls);
      Object.defineProperty(copy, "launchRankAccessor", {
        get() {
          calls.push("launchRankAccessor");
          return 1;
        },
        enumerable: true,
        configurable: true,
      });
      return copy;
    });
    expect(stage1IdentityContentDigest(decorated)).toBe(FROZEN);
    expect(calls).toEqual([]);

    const mutations = [
      ["cohortKey", "boren_x"],
      ["canonicalName", "Renamed"],
      ["canonicalSearchKey", "renamed"],
      ["aliasSearchKeys", ["added-alias"]],
      ["canonicalSlug", "renamed-slug"],
      ["officialHomepage", "https://elsewhere.example.org/"],
    ];
    for (const [field, value] of mutations) {
      expect(stage1IdentityContentDigest(withRow(0, (row) => ({ ...row, [field]: value }))), field).not.toBe(FROZEN);
    }
  });
});
