import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { awardSeeds } from "../../src/lib/award-seeds.ts";
import { canonicalSourceUrlKey } from "../../src/lib/source-url-policy.ts";
import { normalizeSharedAwardKey } from "../../src/lib/shared-awards-core.ts";
import { STAGE1_COHORT_DEFINITION } from "./stage1-cohort-readiness.mjs";
import {
  AWARD_SEED_EXPANSION_DISPOSITIONS,
  AWARD_SEED_EXPANSION_INVENTORY_VERSION,
  buildAwardSeedExpansionInventory,
  normalizeAwardSeedNameKey,
} from "./award-seed-expansion-inventory.mjs";

// Every test drives the real production builder over real production inputs.
// There is no second implementation here to agree with - an oracle that
// reimplements the classification would pass while the shipped module drifts.
function buildProductionInventory() {
  return buildAwardSeedExpansionInventory({
    seeds: awardSeeds,
    stage1Cohort: STAGE1_COHORT_DEFINITION,
  });
}

function rowForSeedName(inventory, name) {
  const row = inventory.rows.find((candidate) => candidate.name === name);
  if (!row) throw new Error(`No seed row named ${JSON.stringify(name)}`);
  return row;
}

function stage1Entry(cohortKey) {
  const entry = STAGE1_COHORT_DEFINITION.find((candidate) => candidate.cohortKey === cohortKey);
  if (!entry) throw new Error(`No Stage 1 cohort ${cohortKey}`);
  return entry;
}

const SYNTHETIC_STAGE1 = [
  {
    cohortKey: "example_cohort",
    canonicalSearchKey: "example scholarship",
    officialHomepage: "https://www.example-scholarship.org/",
    aliasSearchKeys: ["example scholarship program"],
  },
];

describe("award seed expansion inventory", () => {
  it("accounts for every production seed index exactly once, with the current disposition totals", () => {
    const inventory = buildProductionInventory();

    expect(inventory.version).toBe(AWARD_SEED_EXPANSION_INVENTORY_VERSION);
    expect(awardSeeds.length).toBe(1157);
    expect(inventory.rows).toHaveLength(awardSeeds.length);
    expect(inventory.totals.seeds).toBe(awardSeeds.length);

    // Exhaustive accounting: one row per input index, no gaps, no repeats, in
    // input order.
    expect(inventory.rows.map((row) => row.seedIndex)).toEqual(
      awardSeeds.map((_seed, index) => index),
    );
    for (const [index, row] of inventory.rows.entries()) {
      expect(row.name).toBe(awardSeeds[index].name);
      expect(row.starterUrl).toBe(awardSeeds[index].starterUrl);
      expect(AWARD_SEED_EXPANSION_DISPOSITIONS).toContain(row.disposition);
    }

    // The dispositions sum to the catalog, so nothing is dropped or counted
    // twice on the way to the totals.
    const totalled = Object.values(inventory.totals.byDisposition).reduce((sum, n) => sum + n, 0);
    expect(totalled).toBe(awardSeeds.length);

    expect(inventory.totals.byDisposition).toEqual({
      stage1_existing: 37,
      directory_only: 997,
      identity_collision: 10,
      needs_https: 18,
      url_shape_rejected: 4,
      unverified_https_candidate: 91,
    });
  });

  it("runs the production snapshot with fetch and other side-effect APIs poisoned", () => {
    const poison = (label) => () => {
      throw new Error(`award seed expansion inventory attempted ${label}`);
    };

    // If the builder ever reaches for the network, a browser, a worker, or a
    // timer-driven retry, these throw instead of quietly succeeding.
    vi.stubGlobal("fetch", poison("fetch"));
    vi.stubGlobal("XMLHttpRequest", poison("XMLHttpRequest"));
    vi.stubGlobal("WebSocket", poison("WebSocket"));
    vi.stubGlobal("EventSource", poison("EventSource"));
    vi.stubGlobal("navigator", { get userAgent() { throw new Error("navigator access"); } });
    vi.stubGlobal("Worker", poison("Worker"));
    vi.stubGlobal("setTimeout", poison("setTimeout"));
    vi.stubGlobal("setInterval", poison("setInterval"));

    try {
      const inventory = buildProductionInventory();
      expect(inventory.totals.seeds).toBe(1157);
      expect(inventory.totals.byDisposition.stage1_existing).toBe(37);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Boren and Carnegie/Gaither Stage 1 aliases inside Stage 1 instead of proposing them", () => {
    const inventory = buildProductionInventory();

    // Three separately-named Boren seeds, all resolving to the frozen cohort
    // through its alias keys rather than through any URL guess.
    for (const name of [
      "Boren Scholarship/Fellowship URGD/GRAD",
      "Boren Awards for International Study",
      "US National Security Education Program (NSEP) - Boren Fellowships",
    ]) {
      const row = rowForSeedName(inventory, name);
      expect(row.disposition, name).toBe("stage1_existing");
      expect(row.stage1CohortKey, name).toBe("boren");
    }

    // Carnegie/Gaither: one seed on the canonical name, one on the alias.
    for (const name of ["James C. Gaither Junior Fellows Program", "Carnegie Junior Fellowship"]) {
      const row = rowForSeedName(inventory, name);
      expect(row.disposition, name).toBe("stage1_existing");
      expect(row.stage1CohortKey, name).toBe("gaither");
    }

    // The alias keys really are the frozen ones, not a copy living here.
    expect(stage1Entry("boren").aliasSearchKeys).toContain("boren scholarship/fellowship urgd/grad");
    expect(stage1Entry("gaither").aliasSearchKeys).toContain("carnegie junior fellowship");
  });

  it("takes Stage 1 precedence over every other signal, including a non-HTTPS Stage 1 link", () => {
    const inventory = buildProductionInventory();

    // Stage 1 wins over needs_https ...
    const marshall = rowForSeedName(inventory, "Marshall Scholarship");
    expect(marshall.starterUrl.startsWith("http://")).toBe(true);
    expect(marshall.disposition).toBe("stage1_existing");

    // ... and over directory_only, for a Stage 1 alias parked on a directory
    // host.
    const asuBoren = rowForSeedName(inventory, "Boren Awards for International Study");
    expect(asuBoren.starterUrl).toContain("onsa.asu.edu");
    expect(asuBoren.disposition).toBe("stage1_existing");
  });

  it("marks ASU and UIUC institutional directory hosts as directory-only", () => {
    const inventory = buildProductionInventory();

    const uiuc = inventory.rows.filter((row) =>
      row.starterUrl.includes("fellowship-finder.grad.illinois.edu"),
    );
    const asu = inventory.rows.filter((row) => row.starterUrl.includes("onsa.asu.edu"));
    expect(uiuc.length).toBeGreaterThan(900);
    expect(asu.length).toBeGreaterThan(50);

    // Every one of them is either directory_only or already frozen into
    // Stage 1 - never a candidate, and never an identity collision, even
    // though hundreds of seeds share the host. A directory host serving many
    // awards is expected, not a collision.
    for (const row of [...uiuc, ...asu]) {
      expect(["directory_only", "stage1_existing"], row.name).toContain(row.disposition);
    }
    expect(uiuc.some((row) => row.disposition === "directory_only")).toBe(true);
    expect(asu.some((row) => row.disposition === "directory_only")).toBe(true);
  });

  it("collapses the three Blakemore scheme/www variants into one quarantined collision group", () => {
    const inventory = buildProductionInventory();

    const blakemore = [
      "Blakemore Freeman Fellowship for Asian Language Study", // http://www.blakemorefoundation.org/
      "Blakemore Fellowships", //                                 https://blakemorefoundation.org
      "Blakemore Kingfisher Art History Language Fellowships", // https://blakemorefoundation.org
    ].map((name) => rowForSeedName(inventory, name));

    // http vs https, www vs bare, trailing slash vs none - all one canonical
    // key, so the group is found despite three different literal URLs.
    expect(new Set(blakemore.map((row) => row.starterUrl)).size).toBeGreaterThan(1);
    expect(new Set(blakemore.map((row) => row.canonicalUrlKey))).toEqual(
      new Set(["blakemorefoundation.org/"]),
    );

    const seedIndexes = blakemore.map((row) => row.seedIndex).sort((a, b) => a - b);
    for (const row of blakemore) {
      expect(row.disposition, row.name).toBe("identity_collision");
      // Grouped and reported whole - never merged, never de-duplicated: all
      // three keep their own row.
      expect([...row.collisionSeedIndexes].sort((a, b) => a - b)).toEqual(seedIndexes);
    }

    const group = inventory.collisionGroups.find(
      (candidate) => candidate.canonicalUrlKey === "blakemorefoundation.org/",
    );
    expect(group.seedIndexes.sort((a, b) => a - b)).toEqual(seedIndexes);
    expect(group.resolution).toBe("quarantined_for_human_review");
  });

  it("quarantines a seed that lands on a frozen Stage 1 homepage as a cross-identity collision", () => {
    const inventory = buildProductionInventory();

    // Gilman-DAAD is a different award whose starter link is the frozen Gilman
    // homepage. Even alone, that is an identity collision: the link cannot
    // distinguish the two.
    const row = rowForSeedName(inventory, "Gilman-DAAD Germany Scholarships");
    expect(row.disposition).toBe("identity_collision");
    expect(row.stage1CohortKey).toBe("gilman");
    expect(row.canonicalUrlKey).toBe(canonicalSourceUrlKey(stage1Entry("gilman").officialHomepage));
    expect(row.collisionSeedIndexes).toEqual([row.seedIndex]);
  });

  it("quarantines the NIH, ORAU, and Whitaker seed pairs that share one canonical URL", () => {
    const inventory = buildProductionInventory();

    const pairs = [
      ["National Institutes of Health Fellowships", "National Institutes of Health Undergraduate Scholarship"],
      ["Oak Ridge Institute for Science and Education", "Oak Ridge Institute Global Change Education Program"],
      ["Whitaker International Fellowship", "Whitaker International Scholarship"],
    ];

    for (const [firstName, secondName] of pairs) {
      const first = rowForSeedName(inventory, firstName);
      const second = rowForSeedName(inventory, secondName);

      expect(first.disposition, firstName).toBe("identity_collision");
      expect(second.disposition, secondName).toBe("identity_collision");
      expect(first.canonicalUrlKey).toBe(second.canonicalUrlKey);
      // Two genuinely different awards behind one link: both survive as
      // separate rows in one group.
      expect(new Set(first.collisionSeedIndexes)).toEqual(
        new Set([first.seedIndex, second.seedIndex]),
      );
    }
  });

  it("flags plain HTTP seeds as needing HTTPS", () => {
    const inventory = buildProductionInventory();

    const needsHttps = inventory.rows.filter((row) => row.disposition === "needs_https");
    expect(needsHttps).toHaveLength(18);
    for (const row of needsHttps) {
      expect(new URL(row.starterUrl).protocol, row.name).toBe("http:");
    }
    expect(needsHttps.map((row) => row.name)).toContain("Brower Youth Award");

    // Every remaining candidate really is HTTPS.
    for (const row of inventory.rows) {
      if (row.disposition !== "unverified_https_candidate") continue;
      expect(new URL(row.starterUrl).protocol, row.name).toBe("https:");
    }
  });

  it("rejects the Tylenol and Pfizer starter link shapes through the existing source policy", () => {
    const inventory = buildProductionInventory();

    const rejected = inventory.rows.filter((row) => row.disposition === "url_shape_rejected");
    expect(rejected.map((row) => row.name).sort()).toEqual([
      "Air Force Residency Financial Assistance Program",
      "John L. Carey Scholarship",
      "Pfizer Undergraduate Summer Research Fellowship",
      "Tylenol Scholarship",
    ]);

    // These are rejected because the shared policy already rejects the shape -
    // a careers path and a news path - not because of a list kept here.
    expect(rowForSeedName(inventory, "Pfizer Undergraduate Summer Research Fellowship").starterUrl)
      .toContain("/careers/");
    expect(rowForSeedName(inventory, "Tylenol Scholarship").starterUrl).toContain("/news/");
  });

  it("strips fragments and noise from canonical URLs while preserving meaningful query pairs", () => {
    const inventory = buildAwardSeedExpansionInventory({
      seeds: [
        { name: "Fragment Award", starterUrl: "https://example.org/award#:~:text=Some%20Quote" },
        { name: "Bare Award", starterUrl: "https://example.org/award" },
        { name: "Tracking Award", starterUrl: "https://other.org/a?utm_source=news&utm_medium=x" },
        { name: "Plain Award", starterUrl: "https://other.org/a" },
        { name: "Meaningful Query Award", starterUrl: "https://third.org/a?id=7" },
        { name: "Other Query Award", starterUrl: "https://third.org/a?id=8" },
      ],
      stage1Cohort: SYNTHETIC_STAGE1,
    });

    const byName = Object.fromEntries(inventory.rows.map((row) => [row.name, row]));

    // A fragment never changes identity, so these two collide ...
    expect(byName["Fragment Award"].canonicalUrlKey).toBe(byName["Bare Award"].canonicalUrlKey);
    expect(byName["Fragment Award"].disposition).toBe("identity_collision");
    // ... as do tracking-only query differences ...
    expect(byName["Tracking Award"].canonicalUrlKey).toBe(byName["Plain Award"].canonicalUrlKey);
    expect(byName["Tracking Award"].disposition).toBe("identity_collision");

    // ... but a meaningful query pair is preserved, so id=7 and id=8 stay two
    // distinct awards rather than being welded together.
    expect(byName["Meaningful Query Award"].canonicalUrlKey).toBe("third.org/a?id=7");
    expect(byName["Other Query Award"].canonicalUrlKey).toBe("third.org/a?id=8");
    expect(byName["Meaningful Query Award"].disposition).toBe("unverified_https_candidate");
    expect(byName["Other Query Award"].disposition).toBe("unverified_https_candidate");

    // The production catalog exercises the fragment path for real.
    const production = buildProductionInventory();
    const bridging = rowForSeedName(production, "Bridging Scholarship for Study in Japan");
    expect(bridging.starterUrl).toContain("#:~:text=");
    expect(bridging.canonicalUrlKey).not.toContain("#");
  });

  it("is deterministic across repeated calls and keys rows to input position", () => {
    const first = buildProductionInventory();
    const second = buildProductionInventory();
    expect(second).toEqual(first);

    // The ordering contract: rows come back in input order, so a seed's index
    // is its catalog position. Re-ordering the input re-indexes the report
    // rather than silently keeping stale positions.
    const reversedSeeds = [...awardSeeds].reverse();
    const reversed = buildAwardSeedExpansionInventory({
      seeds: reversedSeeds,
      stage1Cohort: STAGE1_COHORT_DEFINITION,
    });
    expect(reversed.rows.map((row) => row.seedIndex)).toEqual(
      reversedSeeds.map((_seed, index) => index),
    );
    expect(reversed.rows.map((row) => row.name)).toEqual(reversedSeeds.map((seed) => seed.name));
    // Order changes positions but not verdicts.
    expect(reversed.totals.byDisposition).toEqual(first.totals.byDisposition);

    // Collision groups are reported in a stable order too.
    expect(second.collisionGroups.map((group) => group.canonicalUrlKey)).toEqual(
      first.collisionGroups.map((group) => group.canonicalUrlKey),
    );
    const firstIndexes = first.collisionGroups.map((group) => group.seedIndexes[0]);
    expect([...firstIndexes].sort((a, b) => a - b)).toEqual(firstIndexes);
  });

  it("fails closed on malformed input rather than guessing a disposition", () => {
    const cases = [
      [{ seeds: null, stage1Cohort: SYNTHETIC_STAGE1 }, /seeds must be an array/],
      [{ seeds: [{ name: "", starterUrl: "https://x.org/" }], stage1Cohort: SYNTHETIC_STAGE1 }, /name must be a non-empty string/],
      [{ seeds: [{ name: "A", starterUrl: "   " }], stage1Cohort: SYNTHETIC_STAGE1 }, /starterUrl must be a non-empty string/],
      [{ seeds: [{ name: "A", starterUrl: "not a url" }], stage1Cohort: SYNTHETIC_STAGE1 }, /unparseable starterUrl/],
      [{ seeds: ["nope"], stage1Cohort: SYNTHETIC_STAGE1 }, /must be an object/],
      [{ seeds: [], stage1Cohort: [] }, /stage1Cohort must be a non-empty array/],
      [{ seeds: [], stage1Cohort: [{ cohortKey: "k", canonicalSearchKey: "n" }] }, /officialHomepage must be a non-empty string/],
      // A malformed homepage must never fall back to canonicalSourceUrlKey's
      // own parse-failure fallback (a plain lowercased string standing in for
      // a real canonical key) - it must be rejected outright.
      [
        { seeds: [], stage1Cohort: [{ cohortKey: "k", canonicalSearchKey: "n", officialHomepage: "not-a-url-at-all" }] },
        /officialHomepage must be an absolute http\(s\) URL/,
      ],
      // Same for a syntactically valid URL in an unsupported scheme.
      [
        { seeds: [], stage1Cohort: [{ cohortKey: "k", canonicalSearchKey: "n", officialHomepage: "ftp://example.org/" }] },
        /officialHomepage must be an absolute http\(s\) URL/,
      ],
      // A sparse stage1Cohort array (a real hole, not an explicit undefined
      // entry) must fail closed rather than being silently skipped the way
      // Array.prototype.forEach skips holes.
      [
        { seeds: [], stage1Cohort: (() => { const arr = [SYNTHETIC_STAGE1[0]]; arr.length = 2; return arr; })() },
        /stage1Cohort 1 must be an object/,
      ],
      // A sparse aliasSearchKeys array must fail the same way.
      [
        {
          seeds: [],
          stage1Cohort: [{
            cohortKey: "k",
            canonicalSearchKey: "n",
            officialHomepage: "https://n.example.org/",
            aliasSearchKeys: (() => { const arr = ["a"]; arr.length = 2; return arr; })(),
          }],
        },
        /alias key 2 must be a non-empty string/,
      ],
      // Two entries declaring the same cohortKey would make "which frozen
      // award is this" depend on which one is processed last.
      [
        {
          seeds: [],
          stage1Cohort: [
            { cohortKey: "dup", canonicalSearchKey: "a", officialHomepage: "https://a.example.org/" },
            { cohortKey: "dup", canonicalSearchKey: "b", officialHomepage: "https://b.example.org/" },
          ],
        },
        /cohortKey "dup" is declared more than once/,
      ],
    ];
    for (const [input, pattern] of cases) {
      expect(() => buildAwardSeedExpansionInventory(input), String(pattern)).toThrow(pattern);
    }

    // A caller-supplied index that disagrees with array position means the
    // caller's catalog view has drifted; every index downstream would be wrong.
    expect(() =>
      buildAwardSeedExpansionInventory({
        seeds: [
          { seedIndex: 0, name: "A", starterUrl: "https://a.org/" },
          { seedIndex: 0, name: "B", starterUrl: "https://b.org/" },
        ],
        stage1Cohort: SYNTHETIC_STAGE1,
      }),
    ).toThrow(/indices must match array position/);

    // Two frozen awards claiming one name key would let match order decide
    // identity.
    expect(() =>
      buildAwardSeedExpansionInventory({
        seeds: [],
        stage1Cohort: [
          ...SYNTHETIC_STAGE1,
          {
            cohortKey: "other_cohort",
            canonicalSearchKey: "Example Scholarship",
            officialHomepage: "https://other.example.org/",
          },
        ],
      }),
    ).toThrow(/claimed by both/);

    // Two DIFFERENT frozen cohorts sharing one canonical-equivalent homepage
    // must be rejected rather than resolved by last-write-wins - proved by
    // showing BOTH input orders throw, so no reordering of stage1Cohort can
    // ever silently change (or even choose) which cohort a shared homepage
    // is attributed to.
    const sharedHomepageA = { cohortKey: "cohort_a", canonicalSearchKey: "award a", officialHomepage: "https://www.shared.org/" };
    const sharedHomepageB = { cohortKey: "cohort_b", canonicalSearchKey: "award b", officialHomepage: "https://shared.org" };
    expect(() =>
      buildAwardSeedExpansionInventory({ seeds: [], stage1Cohort: [sharedHomepageA, sharedHomepageB] }),
    ).toThrow(/officialHomepage canonical key .* claimed by both/);
    expect(() =>
      buildAwardSeedExpansionInventory({ seeds: [], stage1Cohort: [sharedHomepageB, sharedHomepageA] }),
    ).toThrow(/officialHomepage canonical key .* claimed by both/);

    // Matching indices are accepted.
    expect(() =>
      buildAwardSeedExpansionInventory({
        seeds: [{ seedIndex: 0, name: "A", starterUrl: "https://a.org/" }],
        stage1Cohort: SYNTHETIC_STAGE1,
      }),
    ).not.toThrow();
  });

  it("never claims a seed is ready, official, verified, active, monitorable, or publishable", () => {
    const inventory = buildProductionInventory();

    // No row carries a readiness-shaped field at all.
    for (const row of inventory.rows.slice(0, 200)) {
      for (const key of Object.keys(row)) {
        expect(key, `${row.name} field ${key}`).not.toMatch(
          /(^|_)(ready|readiness|official|verified|active|monitorable|monitoring|publishable|publication|publish|approved|launch)(_|$)/i,
        );
      }
    }

    // No human-facing string asserts one either. "unverified_https_candidate"
    // is deliberately not matched by \bverified\b - the point of the whole
    // vocabulary is that it only ever names a reason to wait.
    const claimWord = /\b(ready|readiness|official|verified|active|monitorable|publishable|publication[- _]?ready|monitoring[- _]?ready|approved)\b/i;
    for (const row of inventory.rows) {
      expect(row.reason, `${row.name} reason`).not.toMatch(claimWord);
    }
    for (const group of inventory.collisionGroups) {
      expect(group.resolution).not.toMatch(claimWord);
    }
    for (const disposition of AWARD_SEED_EXPANSION_DISPOSITIONS) {
      expect(disposition).not.toMatch(claimWord);
    }

    // The strongest thing the inventory ever says about a seed is that nobody
    // has looked at it yet.
    const candidate = inventory.rows.find((row) => row.disposition === "unverified_https_candidate");
    expect(candidate.reason).toBe("No known rejection reason; no human has examined this seed.");
  });

  it("leaves the frozen Stage 1 cohort untouched: it is read, never widened", () => {
    const inventory = buildProductionInventory();

    // Stage 1 is still exactly 25, and the inventory never introduces a
    // twenty-sixth cohort key.
    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);
    const frozenKeys = new Set(STAGE1_COHORT_DEFINITION.map((entry) => entry.cohortKey));
    for (const row of inventory.rows) {
      if (row.stage1CohortKey === null) continue;
      expect(frozenKeys, row.name).toContain(row.stage1CohortKey);
    }

    // Only rows that Stage 1 already owns, or that collide with a Stage 1
    // homepage, are ever associated with a cohort at all.
    for (const row of inventory.rows) {
      if (row.stage1CohortKey === null) continue;
      expect(["stage1_existing", "identity_collision"], row.name).toContain(row.disposition);
    }

    // The 37 Stage 1 seed rows map onto a subset of the frozen 25 - many seed
    // names per award, never a new award.
    const stage1Rows = inventory.rows.filter((row) => row.disposition === "stage1_existing");
    const coveredCohorts = new Set(stage1Rows.map((row) => row.stage1CohortKey));
    expect(stage1Rows.length).toBeGreaterThan(coveredCohorts.size);
    expect(coveredCohorts.size).toBeLessThanOrEqual(25);
  });

  it("normalizes seed name keys by direct delegation to the real production normalizer, not a lookalike", () => {
    // A behavioral comparison against the actual normalizer, not an assertion
    // of the inventory's own helper against itself: every probe agrees with
    // normalizeSharedAwardKey exactly, including its NSF GRFP alias
    // canonicalization, which a hand-rolled trim/lowercase copy would not.
    const probes = [
      "  Boren   Scholarship/Fellowship URGD/GRAD ",
      "Carnegie\tJunior\nFellowship",
      "NSF Graduate Research Fellowship",
      "National Science Foundation Graduate Research Fellowship",
      "National Science Foundation Graduate Research Fellowship Program",
      "NSF Graduate Research Fellowship Program",
      "Some Unrelated Award Name",
    ];
    for (const probe of probes) {
      expect(normalizeAwardSeedNameKey(probe), probe).toBe(normalizeSharedAwardKey(probe));
    }

    // Every one of the three production alias variants collapses onto the
    // same key as the canonical name - this is what "direct delegation"
    // means in practice, not merely two functions that happen to agree on
    // simple inputs.
    const canonicalKey = normalizeAwardSeedNameKey("NSF Graduate Research Fellowship Program");
    expect(normalizeAwardSeedNameKey("NSF Graduate Research Fellowship")).toBe(canonicalKey);
    expect(normalizeAwardSeedNameKey("National Science Foundation Graduate Research Fellowship")).toBe(canonicalKey);
    expect(normalizeAwardSeedNameKey("National Science Foundation Graduate Research Fellowship Program")).toBe(canonicalKey);
  });

  it("classifies a synthetic NSF GRFP alias seed as stage1_existing via the real production normalizer", () => {
    // The production catalog only ever spells this award out in full ("NSF
    // Graduate Research Fellowship Program"), so this alias path is not
    // exercised by the production snapshot at all - a private, drifted
    // normalizer could pass every other test here and still misclassify a
    // seed that used the shorter alias production already recognizes
    // elsewhere. This seed is synthetic specifically so the test exercises
    // the alias path independent of what today's catalog happens to contain.
    for (const aliasName of [
      "NSF Graduate Research Fellowship",
      "National Science Foundation Graduate Research Fellowship",
      "national science foundation graduate research fellowship program",
    ]) {
      const inventory = buildAwardSeedExpansionInventory({
        seeds: [{ name: aliasName, starterUrl: "https://example.org/some-award-page" }],
        stage1Cohort: STAGE1_COHORT_DEFINITION,
      });
      expect(inventory.rows[0].disposition, aliasName).toBe("stage1_existing");
      expect(inventory.rows[0].stage1CohortKey, aliasName).toBe("nsf_grfp");
    }
  });

  it("accepts the real, unmodified Stage 1 cohort definition without throwing", () => {
    // The stricter validation added for sparse arrays, duplicate cohortKeys,
    // and homepage well-formedness must not reject the actual frozen cohort
    // it exists to protect.
    expect(() => buildProductionInventory()).not.toThrow();
    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);
  });

  it("keeps the module free of network, filesystem, and environment access at the source level", () => {
    // A runtime poison test can only catch what actually executes; a future
    // top-level `import ... from "node:fs"` or a `process.env` read would
    // resolve or execute before any poisoned global mattered. This is a
    // static, textual guard instead - the only kind that can catch an import
    // statement, which is inherently static.
    const source = readFileSync(
      resolve(import.meta.dirname, "award-seed-expansion-inventory.mjs"),
      "utf8",
    );

    // Non-tautological: prove the check is really reading the real module
    // (a positive control) before trusting its negative results.
    expect(source).toContain("export function buildAwardSeedExpansionInventory");
    expect(source).toContain("normalizeSharedAwardKey");

    const forbiddenBuiltins = ["fs", "http", "https", "net", "dns", "dgram", "child_process", "worker_threads", "tls"];
    for (const builtin of forbiddenBuiltins) {
      expect(source, `node:${builtin} import`).not.toMatch(
        new RegExp(`from\\s+["'](?:node:)?${builtin}["']`),
      );
      expect(source, `require("${builtin}")`).not.toMatch(
        new RegExp(`require\\(\\s*["'](?:node:)?${builtin}["']\\s*\\)`),
      );
    }
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bWorker\s*\(/);
  });
});
