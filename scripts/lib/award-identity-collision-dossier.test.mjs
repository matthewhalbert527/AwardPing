import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { awardSeeds } from "../../src/lib/award-seeds.ts";
import { awardSourceOverrides } from "../../src/lib/award-source-overrides.ts";
import { stage1CohortIdentity } from "../../src/lib/stage1-cohort-identity.ts";
import { STAGE1_COHORT_DEFINITION } from "./stage1-cohort-readiness.mjs";
import { buildPostStage1ExpansionPlan, stage1IdentityContentDigest } from "./post-stage1-expansion-plan.mjs";
import {
  AWARD_IDENTITY_COLLISION_DOSSIER_VERSION,
  IDENTITY_RELATIONSHIP_UNRESOLVED,
  buildAwardIdentityCollisionDossier,
  computeDossierHash,
} from "./award-identity-collision-dossier.mjs";

const RANGEL_PROBE = Object.freeze({ probeId: "rangel", lexicalTerms: ["rangel"] });

function buildRangelDossier(patch = {}) {
  return buildAwardIdentityCollisionDossier({
    probe: patch.probe ?? RANGEL_PROBE,
    seeds: patch.seeds ?? awardSeeds,
    overrides: patch.overrides ?? awardSourceOverrides,
  });
}

function recordById(dossier, recordId) {
  const record = dossier.records.find((candidate) => candidate.recordId === recordId);
  if (!record) throw new Error(`No record ${recordId}`);
  return record;
}

function recordByNameKey(dossier, nameKey, recordKind) {
  const matches = dossier.records.filter(
    (record) => record.nameKey === nameKey && (recordKind === undefined || record.recordKind === recordKind),
  );
  if (matches.length !== 1) throw new Error(`Expected exactly 1 record for ${nameKey}/${recordKind}, got ${matches.length}`);
  return matches[0];
}

// Structural clone that keeps plain prototypes, so the only difference
// between a clone and the original is whatever the case under test changes.
const clone = (value) =>
  Array.isArray(value)
    ? value.map(clone)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)]))
      : value;

function replaceAt(root, path, make) {
  if (path.length === 0) return make(root);
  let parent = root;
  for (let index = 0; index < path.length - 1; index += 1) parent = parent[path[index]];
  const key = path[path.length - 1];
  parent[key] = make(parent[key]);
  return root;
}

// Records EVERY trap by name, so "zero hooks" is a measurement rather than
// a guess about which traps the helper might have used.
const countingProxy = (target, hooks) =>
  new Proxy(
    target,
    new Proxy(
      {},
      {
        get:
          (_handler, trap) =>
          (...args) => {
            hooks.push(`trap:${String(trap)}`);
            return Reflect[trap](...args);
          },
      },
    ),
  );

const OBJECT_LAYERS = [
  ["dossier root", []],
  ["totals", ["totals"]],
  ["eligibility", ["eligibility"]],
  ["a record", ["records", 0]],
  ["an exact-name link group", ["exactNameLinks", 0]],
  ["a URL link group", ["urlLinks", 0]],
  ["a lexical group", ["lexicalNearbyOnly", 0]],
];

const ARRAY_LAYERS = [
  ["lexicalTerms", ["lexicalTerms"]],
  ["records", ["records"]],
  ["exactNameLinks", ["exactNameLinks"]],
  ["urlLinks", ["urlLinks"]],
  ["lexicalNearbyOnly", ["lexicalNearbyOnly"]],
  ["an exact-name link's recordIds", ["exactNameLinks", 0, "recordIds"]],
  ["an exact-name link's recordKinds", ["exactNameLinks", 0, "recordKinds"]],
  ["a URL link's recordIds", ["urlLinks", 0, "recordIds"]],
  ["a URL link's distinctNameKeys", ["urlLinks", 0, "distinctNameKeys"]],
];

describe("award identity collision dossier", () => {
  it("gathers the exact Rangel evidence, preserving every source record and index", () => {
    const dossier = buildRangelDossier();

    expect(dossier.version).toBe(AWARD_IDENTITY_COLLISION_DOSSIER_VERSION);
    expect(dossier.probeId).toBe("rangel");
    expect(dossier.totals.records).toBe(6);

    // Every record is reported with the exact catalog string, the exact
    // position it occupies, and both normalized keys.
    const expected = [
      {
        recordKind: "seed",
        seedIndex: 84,
        name: "Rangel International Affairs Fellowship",
        nameKey: "rangel international affairs fellowship",
        url: "https://rangelprogram.org/",
        urlKey: "rangelprogram.org/",
        institutionalDiscoveryUrl: false,
      },
      {
        recordKind: "seed",
        seedIndex: 112,
        name: "Charles B. Rangel International Affairs Fellowship",
        nameKey: "charles b. rangel international affairs fellowship",
        url: "https://onsa.asu.edu/scholarship/charles-b-rangel-international-affairs-fellowship",
        urlKey: "onsa.asu.edu/scholarship/charles-b-rangel-international-affairs-fellowship",
        institutionalDiscoveryUrl: true,
      },
      {
        recordKind: "seed",
        seedIndex: 113,
        name: "Charles B. Rangel International Affairs Summer Enrichment Program",
        nameKey: "charles b. rangel international affairs summer enrichment program",
        url: "https://onsa.asu.edu/scholarship/charles-b-rangel-international-affairs-summer-enrichment-program",
        urlKey: "onsa.asu.edu/scholarship/charles-b-rangel-international-affairs-summer-enrichment-program",
        institutionalDiscoveryUrl: true,
      },
      {
        recordKind: "seed",
        seedIndex: 975,
        name: "U.S. Department of State - Charles B. Rangel International Affairs Program - Graduate Fellowship",
        nameKey: "u.s. department of state - charles b. rangel international affairs program - graduate fellowship",
        url: "https://fellowship-finder.grad.illinois.edu/SearchResult/Fellowship/3751",
        urlKey: "fellowship-finder.grad.illinois.edu/searchresult/fellowship/3751",
        institutionalDiscoveryUrl: true,
      },
    ];
    for (const want of expected) {
      const record = recordByNameKey(dossier, want.nameKey, "seed");
      for (const [field, value] of Object.entries(want)) {
        expect(record[field], `${want.nameKey}.${field}`).toEqual(value);
      }
    }

    // Both override sources, with their own positions and page types.
    const rangelFellowship = recordByNameKey(dossier, "rangel fellowship", "override_source");
    expect(rangelFellowship.overrideIndex).toBe(18);
    expect(rangelFellowship.sourceIndex).toBe(0);
    expect(rangelFellowship.url).toBe("https://rangelprogram.org/graduate-fellowship-program/");
    expect(rangelFellowship.urlKey).toBe("rangelprogram.org/graduate-fellowship-program");
    expect(rangelFellowship.pageType).toBe("homepage");

    const charlesOverride = recordByNameKey(dossier, "charles b. rangel international affairs fellowship", "override_source");
    expect(charlesOverride.overrideIndex).toBe(19);
    expect(charlesOverride.sourceIndex).toBe(0);
    expect(charlesOverride.urlKey).toBe("rangelprogram.org/graduate-fellowship-program");
  });

  it("reports the shared-URL collision as two distinct names on one canonical URL", () => {
    const dossier = buildRangelDossier();

    expect(dossier.urlLinks).toHaveLength(1);
    const link = dossier.urlLinks[0];
    expect(link.evidenceClass).toBe("url_link");
    expect(link.urlKey).toBe("rangelprogram.org/graduate-fellowship-program");
    expect(link.distinctNameKeyCount).toBe(2);
    expect(link.distinctNameKeys).toEqual([
      "charles b. rangel international affairs fellowship",
      "rangel fellowship",
    ]);
    expect(link.relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);

    // Both members are the two override sources - and the dossier says only
    // that they collide, never which name wins.
    const members = link.recordIds.map((recordId) => recordById(dossier, recordId));
    expect(members.map((member) => member.recordKind)).toEqual(["override_source", "override_source"]);
    expect(members.map((member) => member.overrideIndex).sort()).toEqual([18, 19]);
    // No field anywhere nominates a winner. Checked structurally, because
    // the dossier's own prose legitimately contains "canonical" and
    // "aliased" - in a sentence forbidding both.
    const verdictField = /^(canonicalName|canonicalRecordId|preferredName|preferredRecordId|winner|resolvedName|aliasOf|mergedInto|selected.*)$/i;
    const assertNoVerdictFields = (object, path) => {
      for (const key of Object.keys(object)) {
        expect(key, `${path}.${key}`).not.toMatch(verdictField);
      }
    };
    for (const record of dossier.records) assertNoVerdictFields(record, "record");
    for (const group of [...dossier.exactNameLinks, ...dossier.urlLinks, ...dossier.lexicalNearbyOnly]) {
      assertNoVerdictFields(group, "group");
    }
    assertNoVerdictFields(dossier, "dossier");
  });

  it("reports the exact-name link that spans a seed and an override", () => {
    const dossier = buildRangelDossier();

    expect(dossier.exactNameLinks).toHaveLength(1);
    const link = dossier.exactNameLinks[0];
    expect(link.evidenceClass).toBe("exact_name_link");
    expect(link.nameKey).toBe("charles b. rangel international affairs fellowship");
    expect(link.recordKinds).toEqual(["override_source", "seed"]);
    expect(link.relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);

    const members = link.recordIds.map((recordId) => recordById(dossier, recordId));
    expect(members.find((member) => member.recordKind === "seed").seedIndex).toBe(112);
    expect(members.find((member) => member.recordKind === "override_source").overrideIndex).toBe(19);
  });

  it("keeps the Summer Enrichment record separate, by mechanism rather than by special case", () => {
    const dossier = buildRangelDossier();
    const summer = recordByNameKey(
      dossier,
      "charles b. rangel international affairs summer enrichment program",
      "seed",
    );

    // It is present as its own record ...
    expect(summer.seedIndex).toBe(113);

    // ... it is in no link group at all ...
    for (const link of [...dossier.exactNameLinks, ...dossier.urlLinks]) {
      expect(link.recordIds, `${link.evidenceClass} must not contain the Summer Enrichment record`).not.toContain(summer.recordId);
    }

    // ... and it appears only as lexically nearby, which asserts nothing
    // beyond "the probe's words appear in the name".
    const lexical = dossier.lexicalNearbyOnly.find((entry) => entry.recordId === summer.recordId);
    expect(lexical).toBeDefined();
    expect(lexical.evidenceClass).toBe("lexical_nearby_only");
    expect(lexical.relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);

    // The separation is mechanical: it shares neither a normalized name nor
    // a canonical URL with any other record, so no rule could have grouped
    // it. Nothing in the module names this award.
    const others = dossier.records.filter((record) => record.recordId !== summer.recordId);
    expect(others.some((record) => record.nameKey === summer.nameKey)).toBe(false);
    expect(others.some((record) => record.urlKey === summer.urlKey)).toBe(false);
    // No family-specific logic exists: the module's CODE (comments stripped -
    // the header names the proving regression in prose, which is
    // documentation, not behaviour) mentions no award, host, or family.
    const source = readFileSync(resolve(import.meta.dirname, "award-identity-collision-dossier.mjs"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("export function buildAwardIdentityCollisionDossier");
    for (const forbidden of [/rangel/i, /summer.?enrichment/i, /pattillman/i, /onsa\.asu/i, /mitchell/i, /tillman/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("states the unresolved relationship and the exact human decision, and makes nothing eligible", () => {
    const dossier = buildRangelDossier();

    expect(dossier.relationship).toBe("unresolved_pending_human_review");
    for (const link of [...dossier.exactNameLinks, ...dossier.urlLinks, ...dossier.lexicalNearbyOnly]) {
      expect(link.relationship).toBe("unresolved_pending_human_review");
    }

    expect(dossier.humanDecisionRequired).toMatch(/A human must decide/);
    expect(dossier.humanDecisionRequired).toMatch(/one award under different names, separate sibling awards/);
    expect(dossier.humanDecisionRequired).toMatch(/which name and URL are canonical/);
    expect(dossier.humanDecisionRequired).toMatch(/no record here may be aliased, merged, renamed, onboarded, or monitored/);

    expect(dossier.eligibility).toEqual({
      candidateEligible: false,
      onboardingEligible: false,
      monitoringEligible: false,
      publicationEligible: false,
    });

    // No input can flip an eligibility flag or the verdict: they are pinned.
    const synthetic = buildAwardIdentityCollisionDossier({
      probe: { probeId: "probe_x", lexicalTerms: ["alpha"] },
      seeds: [{ name: "Alpha Award", starterUrl: "https://alpha.example.org/" }],
      overrides: [{ awardName: "Alpha Award", sources: [{ url: "https://alpha.example.org/", pageType: "homepage" }] }],
    });
    expect(synthetic.eligibility).toEqual(dossier.eligibility);
    expect(synthetic.relationship).toBe(dossier.relationship);
  });

  it("is deterministic across repeated calls and invariant to input ordering", () => {
    const first = buildRangelDossier();
    const second = buildRangelDossier();
    expect(second).toEqual(first);
    expect(second.dossierHash).toBe(first.dossierHash);

    // Probe term order cannot change anything.
    const reorderedTerms = buildRangelDossier({ probe: { probeId: "rangel", lexicalTerms: ["rangel", "international"] } });
    const otherOrder = buildRangelDossier({ probe: { probeId: "rangel", lexicalTerms: ["international", "rangel"] } });
    expect(otherOrder).toEqual(reorderedTerms);

    // Re-ordering the catalog arrays changes only the recorded POSITIONS -
    // never the evidence, the link structure, or the content hash.
    const reversed = buildRangelDossier({
      seeds: [...awardSeeds].reverse(),
      overrides: [...awardSourceOverrides].reverse(),
    });
    // Compares the identity-bearing fields only, explicitly - the catalog
    // POSITIONS are exactly what re-ordering is expected to move.
    const withoutPositions = (dossier) =>
      dossier.records.map((record) => ({
        recordId: record.recordId,
        recordKind: record.recordKind,
        name: record.name,
        nameKey: record.nameKey,
        url: record.url,
        urlKey: record.urlKey,
        institutionalDiscoveryUrl: record.institutionalDiscoveryUrl,
        pageType: record.pageType ?? null,
      }));
    expect(withoutPositions(reversed)).toEqual(withoutPositions(first));
    expect(reversed.exactNameLinks).toEqual(first.exactNameLinks);
    expect(reversed.urlLinks).toEqual(first.urlLinks);
    expect(reversed.lexicalNearbyOnly).toEqual(first.lexicalNearbyOnly);
    expect(reversed.dossierHash).toBe(first.dossierHash);

    // The positions really did move, so the assertion above is not vacuous.
    expect(reversed.records.map((record) => record.seedIndex)).not.toEqual(first.records.map((record) => record.seedIndex));
  });

  it("binds every material field in the dossier hash", () => {
    const base = buildRangelDossier();
    const mutate = (patch) => computeDossierHash({ ...base, ...patch });

    const mutations = [
      ["version", { version: "other-version" }],
      ["probeId", { probeId: "other_probe" }],
      ["lexicalTerms", { lexicalTerms: ["other"] }],
      ["relationship", { relationship: "resolved" }],
      ["humanDecisionRequired", { humanDecisionRequired: "nothing required" }],
      ["eligibility.candidateEligible", { eligibility: { ...base.eligibility, candidateEligible: true } }],
      ["eligibility.onboardingEligible", { eligibility: { ...base.eligibility, onboardingEligible: true } }],
      ["eligibility.monitoringEligible", { eligibility: { ...base.eligibility, monitoringEligible: true } }],
      ["eligibility.publicationEligible", { eligibility: { ...base.eligibility, publicationEligible: true } }],
      ["totals.records", { totals: { ...base.totals, records: base.totals.records + 1 } }],
      ["totals.exactNameLinks", { totals: { ...base.totals, exactNameLinks: base.totals.exactNameLinks + 1 } }],
      ["totals.urlLinks", { totals: { ...base.totals, urlLinks: base.totals.urlLinks + 1 } }],
      ["totals.lexicalNearbyOnly", { totals: { ...base.totals, lexicalNearbyOnly: base.totals.lexicalNearbyOnly + 1 } }],
      ["exactNameLinks", { exactNameLinks: [] }],
      ["urlLinks", { urlLinks: [] }],
      ["lexicalNearbyOnly", { lexicalNearbyOnly: [] }],
      ["record name", { records: base.records.map((r, i) => (i === 0 ? { ...r, name: "Renamed" } : r)) }],
      ["record nameKey", { records: base.records.map((r, i) => (i === 0 ? { ...r, nameKey: "renamed" } : r)) }],
      ["record url", { records: base.records.map((r, i) => (i === 0 ? { ...r, url: "https://elsewhere.example.org/" } : r)) }],
      ["record urlKey", { records: base.records.map((r, i) => (i === 0 ? { ...r, urlKey: "elsewhere.example.org/" } : r)) }],
      ["record recordKind", { records: base.records.map((r, i) => (i === 0 ? { ...r, recordKind: "seed" } : r)) }],
      ["record pageType", { records: base.records.map((r, i) => (i === 0 ? { ...r, pageType: "other" } : r)) }],
      ["record discovery flag", { records: base.records.map((r, i) => (i === 0 ? { ...r, institutionalDiscoveryUrl: !r.institutionalDiscoveryUrl } : r)) }],
    ];
    for (const [label, patch] of mutations) {
      expect(mutate(patch), label).not.toBe(base.dossierHash);
    }

    // Not a constant, and stable for an untouched rebuild.
    expect(base.dossierHash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeDossierHash({ ...base })).toBe(base.dossierHash);
    const otherProbe = buildAwardIdentityCollisionDossier({
      probe: { probeId: "pickering", lexicalTerms: ["pickering"] },
      seeds: awardSeeds,
      overrides: awardSourceOverrides,
    });
    expect(otherProbe.dossierHash).not.toBe(base.dossierHash);
  });

  it("never aliases, merges, selects a canonical name, or reaches the approved candidate config and plans", () => {
    // The dossier is not wired into the approved slice in any direction.
    const plannerSource = readFileSync(resolve(import.meta.dirname, "post-stage1-expansion-plan.mjs"), "utf8");
    expect(plannerSource).not.toMatch(/award-identity-collision-dossier/);

    const configPath = resolve(import.meta.dirname, "..", "..", "config", "post-stage1-expansion-candidates.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.candidates).toHaveLength(2);
    expect(config.candidates.map((candidate) => candidate.candidateId).sort()).toEqual(["mitchell", "tillman"]);
    expect(JSON.stringify(config)).not.toMatch(/rangel/i);

    // The approved two-candidate plan is byte-identical whether or not a
    // dossier has been built in the same process.
    const slugByKey = new Map(stage1CohortIdentity.map((row) => [row[1], row[4]]));
    const stage1Identity = STAGE1_COHORT_DEFINITION.map((cohort) => ({
      cohortKey: cohort.cohortKey,
      canonicalName: cohort.canonicalName,
      canonicalSearchKey: cohort.canonicalSearchKey,
      aliasSearchKeys: cohort.aliasSearchKeys,
      canonicalSlug: slugByKey.get(cohort.cohortKey),
      officialHomepage: cohort.officialHomepage,
    }));
    const buildPlan = () =>
      buildPostStage1ExpansionPlan({ config, seeds: awardSeeds, overrides: awardSourceOverrides, stage1Identity });

    const before = buildPlan();
    buildRangelDossier();
    const after = buildPlan();
    expect(after).toEqual(before);
    expect(after.plans.map((plan) => plan.candidateId)).toEqual(["mitchell", "tillman"]);
    expect(after.plans.map((plan) => plan.planHash)).toEqual(before.plans.map((plan) => plan.planHash));

    // No Rangel record leaked into either approved plan.
    for (const plan of after.plans) {
      expect(plan.awardName).not.toMatch(/rangel/i);
      expect(plan.seed.starterUrl).not.toMatch(/rangel/i);
      for (const source of plan.monitorableSources) expect(source.url).not.toMatch(/rangel/i);
    }
  });

  it("performs no network, filesystem, clock, or randomness side effects", () => {
    const poison = (label) => () => {
      throw new Error(`award identity collision dossier attempted ${label}`);
    };
    vi.stubGlobal("fetch", poison("fetch"));
    vi.stubGlobal("XMLHttpRequest", poison("XMLHttpRequest"));
    vi.stubGlobal("WebSocket", poison("WebSocket"));
    vi.stubGlobal("Worker", poison("Worker"));
    vi.stubGlobal("setTimeout", poison("setTimeout"));
    vi.stubGlobal("setInterval", poison("setInterval"));
    vi.stubGlobal("Date", class extends Date {
      constructor(...args) {
        if (args.length === 0) throw new Error("clock access");
        super(...args);
      }
      static now() {
        throw new Error("clock access");
      }
    });
    vi.stubGlobal("Math", { ...Math, random: poison("Math.random") });
    try {
      expect(buildRangelDossier().totals.records).toBe(6);
    } finally {
      vi.unstubAllGlobals();
    }

    const source = readFileSync(resolve(import.meta.dirname, "award-identity-collision-dossier.mjs"), "utf8");
    expect(source).toContain("export function buildAwardIdentityCollisionDossier");
    for (const builtin of ["fs", "http", "https", "net", "dns", "dgram", "child_process", "worker_threads", "tls"]) {
      expect(source, `node:${builtin}`).not.toMatch(new RegExp(`from\\s+["'](?:node:)?${builtin}["']`));
    }
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew Date\s*\(/);
    expect(source).not.toMatch(/\bMath\.random\s*\(/);
  });

  describe("fail-closed input boundary", () => {
    const validInput = () => ({
      probe: { probeId: "rangel", lexicalTerms: ["rangel"] },
      seeds: [{ name: "Rangel Thing", starterUrl: "https://rangelprogram.org/" }],
      overrides: [{ awardName: "Rangel Thing", sources: [{ url: "https://rangelprogram.org/", pageType: "homepage" }] }],
    });

    it("accepts the valid baseline the adversarial cases are built from", () => {
      expect(() => buildAwardIdentityCollisionDossier(validInput())).not.toThrow();
    });

    it("rejects malformed probes", () => {
      const cases = [
        [{ probeId: "Rangel", lexicalTerms: ["rangel"] }, /probeId must be a canonical identifier/],
        [{ probeId: "rangel_", lexicalTerms: ["rangel"] }, /probeId must be a canonical identifier/],
        [{ probeId: "rangel", lexicalTerms: [] }, /lexicalTerms must not be empty/],
        [{ probeId: "rangel", lexicalTerms: ["Rangel"] }, /must already be lowercase and trimmed/],
        [{ probeId: "rangel", lexicalTerms: [" rangel"] }, /must already be lowercase and trimmed/],
        [{ probeId: "rangel", lexicalTerms: ["rangel", "rangel"] }, /duplicate term/],
        [{ probeId: "rangel", lexicalTerms: [""] }, /must be a non-empty string/],
      ];
      for (const [probe, pattern] of cases) {
        expect(() => buildAwardIdentityCollisionDossier({ ...validInput(), probe }), String(pattern)).toThrow(pattern);
      }
    });

    it("rejects Proxies anywhere in the input graph", () => {
      const proxied = (target) => new Proxy(target, {});
      const valid = validInput();
      const cases = [
        ["input", () => proxied(valid), /input must not be a Proxy/],
        ["probe", () => ({ ...valid, probe: proxied(valid.probe) }), /probe must not be a Proxy/],
        ["probe.lexicalTerms", () => ({ ...valid, probe: { ...valid.probe, lexicalTerms: proxied(valid.probe.lexicalTerms) } }), /probe\.lexicalTerms must not be a Proxy/],
        ["seeds", () => ({ ...valid, seeds: proxied(valid.seeds) }), /seeds must not be a Proxy/],
        ["seeds[0]", () => ({ ...valid, seeds: [proxied(valid.seeds[0])] }), /seeds\[0\] must not be a Proxy/],
        ["overrides", () => ({ ...valid, overrides: proxied(valid.overrides) }), /overrides must not be a Proxy/],
        ["overrides[0]", () => ({ ...valid, overrides: [proxied(valid.overrides[0])] }), /overrides\[0\] must not be a Proxy/],
        ["overrides[0].sources", () => ({ ...valid, overrides: [{ ...valid.overrides[0], sources: proxied(valid.overrides[0].sources) }] }), /overrides\[0\]\.sources must not be a Proxy/],
        ["overrides[0].sources[0]", () => ({ ...valid, overrides: [{ ...valid.overrides[0], sources: [proxied(valid.overrides[0].sources[0])] }] }), /overrides\[0\]\.sources\[0\] must not be a Proxy/],
      ];
      for (const [label, makeInput, pattern] of cases) {
        expect(() => buildAwardIdentityCollisionDossier(makeInput()), label).toThrow(pattern);
      }

      // A proxied array cannot hide members behind a lying length either.
      const twoSeeds = [
        { name: "Rangel Thing", starterUrl: "https://rangelprogram.org/" },
        { name: "Rangel Other", starterUrl: "https://rangelprogram.org/other" },
      ];
      const lyingLength = new Proxy(twoSeeds, {
        get(target, prop, receiver) {
          if (prop === "length") return 1;
          return Reflect.get(target, prop, receiver);
        },
      });
      expect(() => buildAwardIdentityCollisionDossier({ ...valid, seeds: lyingLength })).toThrow(/seeds must not be a Proxy/);
    });

    it("rejects accessors and exotic prototypes rather than invoking them", () => {
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
      const valid = validInput();

      const seedWithAccessor = { starterUrl: "https://rangelprogram.org/" };
      Object.defineProperty(seedWithAccessor, "name", statefulAccessor("Rangel Thing", "Something Else"));
      expect(() => buildAwardIdentityCollisionDossier({ ...valid, seeds: [seedWithAccessor] })).toThrow(
        /seeds\[0\]\.name must be a plain data property, not an accessor/,
      );

      const sourceWithAccessor = { pageType: "homepage" };
      Object.defineProperty(sourceWithAccessor, "url", statefulAccessor("https://rangelprogram.org/", "https://elsewhere.example.org/"));
      expect(() =>
        buildAwardIdentityCollisionDossier({ ...valid, overrides: [{ awardName: "Rangel Thing", sources: [sourceWithAccessor] }] }),
      ).toThrow(/overrides\[0\]\.sources\[0\]\.url must be a plain data property, not an accessor/);

      // An inherited field is invisible rather than trusted.
      const inheritedSeed = Object.create({ name: "Rangel Thing" });
      inheritedSeed.starterUrl = "https://rangelprogram.org/";
      expect(() => buildAwardIdentityCollisionDossier({ ...valid, seeds: [inheritedSeed] })).toThrow(
        /seeds\[0\] must be a plain object; its prototype is neither Object\.prototype nor null/,
      );

      // Holes, including ones a polluted prototype would fill.
      const sparse = [valid.seeds[0]];
      sparse.length = 2;
      Object.defineProperty(Array.prototype, 1, { value: { name: "Injected", starterUrl: "https://x.example.org/" }, configurable: true, writable: true });
      try {
        expect(() => buildAwardIdentityCollisionDossier({ ...valid, seeds: sparse })).toThrow(/seeds\[1\] is a hole/);
      } finally {
        delete Array.prototype[1];
      }
    });

    it("never executes a rejected value to describe it", () => {
      const valid = validInput();
      const trapCalls = [];
      const proxyScalar = new Proxy({}, {
        get(target, prop, receiver) {
          trapCalls.push(typeof prop === "symbol" ? prop.toString() : prop);
          return Reflect.get(target, prop, receiver);
        },
      });
      const accessorCalls = [];
      const coercionObject = {};
      for (const key of ["toJSON", "toString", "valueOf"]) {
        Object.defineProperty(coercionObject, key, {
          get() {
            accessorCalls.push(key);
            return () => "<hook>";
          },
          configurable: true,
        });
      }
      Object.defineProperty(coercionObject, Symbol.toPrimitive, {
        get() {
          accessorCalls.push("Symbol.toPrimitive");
          return () => "<toPrimitive>";
        },
        configurable: true,
      });

      const sites = [
        ["probe.probeId", (value) => ({ ...valid, probe: { probeId: value, lexicalTerms: ["rangel"] } })],
        ["probe.lexicalTerms[0]", (value) => ({ ...valid, probe: { probeId: "rangel", lexicalTerms: [value] } })],
        ["seeds[0].name", (value) => ({ ...valid, seeds: [{ name: value, starterUrl: "https://rangelprogram.org/" }] })],
        ["overrides[0].sources[0].url", (value) => ({ ...valid, overrides: [{ awardName: "Rangel Thing", sources: [{ url: value, pageType: "homepage" }] }] })],
      ];
      for (const [label, makeInput] of sites) {
        expect(() => buildAwardIdentityCollisionDossier(makeInput(proxyScalar)), label).toThrow();
        expect(trapCalls, `${label} invoked Proxy traps`).toEqual([]);
        expect(() => buildAwardIdentityCollisionDossier(makeInput(coercionObject)), label).toThrow();
        expect(accessorCalls, `${label} read coercion accessors`).toEqual([]);
      }
    });

    it("matches the approved planner's boundary, mutating one thing at a time from a fixture both accept", () => {
      // The previous version of this test was vacuous on the planner side:
      // its "hostile" seeds contained no award the planner's config named,
      // so the planner rejected them as an orphan candidate no matter what
      // the boundary did. This starts from a fixture BOTH modules accept,
      // then breaks exactly one boundary property per case, so a rejection
      // can only come from the boundary under test.
      const slugByKey = new Map(stage1CohortIdentity.map((row) => [row[1], row[4]]));
      const stage1Identity = STAGE1_COHORT_DEFINITION.map((cohort) => ({
        cohortKey: cohort.cohortKey,
        canonicalName: cohort.canonicalName,
        canonicalSearchKey: cohort.canonicalSearchKey,
        aliasSearchKeys: cohort.aliasSearchKeys,
        canonicalSlug: slugByKey.get(cohort.cohortKey),
        officialHomepage: cohort.officialHomepage,
      }));
      const plannerConfig = {
        schema: "post-stage1-expansion-candidates-v1",
        candidates: [{ candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship", status: "provisional" }],
      };
      const dossierProbe = { probeId: "mitchell", lexicalTerms: ["mitchell"] };

      const runPlanner = (seeds) =>
        buildPostStage1ExpansionPlan({ config: plannerConfig, seeds, overrides: awardSourceOverrides, stage1Identity });
      const runDossier = (seeds) =>
        buildAwardIdentityCollisionDossier({ probe: dossierProbe, seeds, overrides: awardSourceOverrides });

      // Baseline: the unmodified catalog succeeds in BOTH. Without this the
      // mutation cases below would prove nothing.
      expect(() => runPlanner(awardSeeds)).not.toThrow();
      expect(() => runDossier(awardSeeds)).not.toThrow();
      expect(runDossier(awardSeeds).totals.records).toBeGreaterThan(0);

      // Each case replaces the seeds array (or one element of it) with an
      // otherwise-identical value that violates exactly one boundary rule.
      const trapCalls = [];
      const countingProxy = (target) =>
        new Proxy(target, {
          get(object, prop, receiver) {
            trapCalls.push(typeof prop === "symbol" ? prop.toString() : prop);
            return Reflect.get(object, prop, receiver);
          },
        });
      const accessorCalls = [];
      // Own hooks installed by the cases below. Every one of them must be
      // refused on its NAME, so none may ever run - in either module.
      const hookCalls = [];
      const withAccessorName = (seed) => {
        const copy = { starterUrl: seed.starterUrl };
        Object.defineProperty(copy, "name", {
          get() {
            accessorCalls.push("name");
            return seed.name;
          },
          configurable: true,
          enumerable: true,
        });
        return copy;
      };
      const replaceFirst = (replacement) => [replacement, ...awardSeeds.slice(1)];

      const cases = [
        ["proxied seeds array", () => countingProxy([...awardSeeds]), /seeds must not be a Proxy/],
        ["proxied seed record", () => replaceFirst(countingProxy({ ...awardSeeds[0] })), /seeds\[0\] must not be a Proxy/],
        [
          "exotic prototype on a seed",
          () => replaceFirst(Object.assign(Object.create({ inheritedMarker: true }), { ...awardSeeds[0] })),
          /seeds\[0\] must be a plain object; its prototype is neither Object\.prototype nor null/,
        ],
        ["accessor on a seed field", () => replaceFirst(withAccessorName(awardSeeds[0])), /seeds\[0\]\.name must be a plain data property, not an accessor/],
        ["non-object seed element", () => replaceFirst("not an object"), /seeds\[0\] must be an object/],
        [
          "hole in the seeds array",
          () => {
            const sparse = [...awardSeeds];
            delete sparse[0];
            return sparse;
          },
          /seeds\[0\] is a hole/,
        ],
        // The rules below were once this module's alone; the shared boundary
        // carries them to the planner, so they belong here now.
        [
          "extra own name on the seeds array",
          () => Object.assign([...awardSeeds], { smuggled: "unhashed" }),
          /seeds carries an unexpected own property "smuggled"/,
        ],
        [
          "own toJSON on the seeds array",
          () =>
            Object.defineProperty([...awardSeeds], "toJSON", {
              value: () => {
                hookCalls.push("toJSON");
                return [];
              },
              configurable: true,
              writable: true,
            }),
          /seeds carries an unexpected own property "toJSON"/,
        ],
        [
          "own map and sort on the seeds array",
          () =>
            Object.defineProperties([...awardSeeds], {
              map: {
                value: () => {
                  hookCalls.push("map");
                  return [];
                },
                configurable: true,
                writable: true,
              },
              sort: {
                value: () => {
                  hookCalls.push("sort");
                  return [];
                },
                configurable: true,
                writable: true,
              },
            }),
          /seeds carries an unexpected own property "(map|sort)"/,
        ],
        [
          "own Symbol.iterator on the seeds array",
          () =>
            Object.defineProperty([...awardSeeds], Symbol.iterator, {
              value: function* iterate() {
                hookCalls.push("iterator");
              },
              configurable: true,
              writable: true,
            }),
          /seeds must not carry symbol-keyed own properties/,
        ],
        [
          "symbol-keyed own property on the seeds array",
          () => Object.assign([...awardSeeds], { [Symbol("hidden")]: "unhashed" }),
          /seeds must not carry symbol-keyed own properties/,
        ],
        [
          'noncanonical index name "01" on the seeds array',
          () => Object.assign([...awardSeeds], { "01": "unhashed" }),
          /seeds carries an unexpected own property "01"/,
        ],
        [
          "extra accessor on the seeds array",
          () =>
            Object.defineProperty([...awardSeeds], "shadow", {
              get() {
                hookCalls.push("shadow");
                return "unhashed";
              },
              configurable: true,
            }),
          /seeds carries an unexpected own property "shadow"/,
        ],
        [
          "hidden (non-enumerable) seed index",
          () => {
            const copy = [...awardSeeds];
            Object.defineProperty(copy, 0, { ...Object.getOwnPropertyDescriptor(copy, 0), enumerable: false });
            return copy;
          },
          /seeds\[0\] must be an enumerable own property/,
        ],
        [
          "hidden (non-enumerable) seed field",
          () =>
            replaceFirst(
              Object.defineProperty({ ...awardSeeds[0] }, "name", {
                value: awardSeeds[0].name,
                enumerable: false,
                configurable: true,
                writable: true,
              }),
            ),
          /seeds\[0\]\.name must be an enumerable own property/,
        ],
        [
          "Array subclass with overridden hooks as the seeds array",
          () => {
            class Hooked extends Array {
              map() {
                hookCalls.push("subclass.map");
                return [];
              }
              sort() {
                hookCalls.push("subclass.sort");
                return this;
              }
            }
            return Hooked.from(awardSeeds);
          },
          /seeds must be a plain array; its prototype is neither Array\.prototype nor null/,
        ],
      ];

      for (const [label, makeSeeds, pattern] of cases) {
        const plannerSeeds = makeSeeds();
        const dossierSeeds = makeSeeds();
        // Both modules must reject, and with the boundary-specific reason -
        // not merely "something went wrong".
        expect(() => runPlanner(plannerSeeds), `planner: ${label}`).toThrow(pattern);
        expect(() => runDossier(dossierSeeds), `dossier: ${label}`).toThrow(pattern);
      }

      // Nothing was ever asked to describe itself: no trap and no accessor
      // ran in either module, for any case.
      expect(trapCalls).toEqual([]);
      expect(accessorCalls).toEqual([]);
      expect(hookCalls).toEqual([]);
    });

    it("shares one input boundary with the approved planner, with no private copy left in either", () => {
      // The boundary used to be duplicated, module-private, in both files,
      // with the parity test above as the only thing keeping the copies
      // aligned - and they did drift, in this module's favour, twice. It now
      // lives once in plain-data-input-boundary.mjs and each consumer keeps
      // only its own failure prefix. Both facts are pinned at the source
      // level so a private copy cannot quietly reappear.
      const read = (name) => readFileSync(resolve(import.meta.dirname, name), "utf8");
      const dossierSource = read("award-identity-collision-dossier.mjs");
      const plannerSource = read("post-stage1-expansion-plan.mjs");
      const sharedSource = read("plain-data-input-boundary.mjs");

      const importLine = /from "\.\/plain-data-input-boundary\.mjs"/;
      expect(dossierSource).toMatch(importLine);
      expect(plannerSource).toMatch(importLine);
      for (const helper of [
        "describeValue",
        "requireNotProxy",
        "requirePlainObject",
        "requireArray",
        "requirePlainDataRecord",
        "snapshotOwnField",
        "snapshotDenseArray",
        "snapshotStringArray",
        "requireNonEmptyString",
      ]) {
        expect(sharedSource, `${helper} in the shared module`).toContain(`function ${helper}(`);
        expect(dossierSource, `private ${helper} in the dossier`).not.toContain(`function ${helper}(`);
        expect(plannerSource, `private ${helper} in the planner`).not.toContain(`function ${helper}(`);
      }
      // Each consumer still owns its prefix, and the shared module knows
      // neither of them.
      expect(dossierSource).toContain("function fail(");
      expect(plannerSource).toContain("function fail(");
      expect(sharedSource).not.toMatch(/award identity collision dossier|post-stage1 expansion plan/);
      // The planner is not modified by this module in any direction.
      expect(plannerSource).not.toMatch(/award-identity-collision-dossier/);
    });
  });

  describe("record ordering is an unambiguous semantic tuple", () => {
    const buildFrom = (seeds, overrides, terms = ["probe"]) =>
      buildAwardIdentityCollisionDossier({ probe: { probeId: "p", lexicalTerms: terms }, seeds, overrides });
    const identityView = (dossier) =>
      dossier.records.map((record) => `${record.recordId}=${record.recordKind}/${record.name}/${record.pageType ?? "-"}/${record.urlKey}`);

    it("orders sources that differ only by pageType stably in both directions", () => {
      const sources = [
        { url: "https://probe.example.org/a", pageType: "homepage" },
        { url: "https://probe.example.org/a", pageType: "deadline" },
      ];
      const forward = buildFrom([], [{ awardName: "Probe Award", sources }]);
      const backward = buildFrom([], [{ awardName: "Probe Award", sources: [...sources].reverse() }]);

      // The previous key omitted pageType, so these tied and reversing them
      // swapped record ids and changed the hash.
      expect(identityView(backward)).toEqual(identityView(forward));
      expect(backward.dossierHash).toBe(forward.dossierHash);
      expect(new Set(forward.records.map((record) => record.pageType))).toEqual(new Set(["homepage", "deadline"]));
    });

    it("is unaffected by delimiter characters inside accepted names and URLs", () => {
      // A joined sort key is ambiguous whenever an accepted value can carry
      // the delimiter. Field-by-field comparison removes the whole class, so
      // these stay stable however they are ordered.
      const seeds = [
        { name: "probe a|b", starterUrl: "https://probe.example.org/x" },
        { name: "probe a", starterUrl: "https://probe.example.org/b%7Cx" },
        { name: "probe|a|b|c", starterUrl: "https://probe.example.org/y" },
        { name: "probe zero", starterUrl: "https://probe.example.org/z" },
      ];
      const forward = buildFrom(seeds, []);
      const backward = buildFrom([...seeds].reverse(), []);
      expect(identityView(backward)).toEqual(identityView(forward));
      expect(backward.dossierHash).toBe(forward.dossierHash);
      expect(forward.totals.records).toBe(4);
    });

    it("stays deterministic when records are wholly indistinguishable", () => {
      // Same kind, same name, same URL, same page type: nothing but the
      // catalog position tells them apart. They are interchangeable by
      // construction, so the evidence and the hash must not depend on which
      // is which.
      const seed = { name: "probe twin", starterUrl: "https://probe.example.org/twin" };
      const forward = buildFrom([seed, { ...seed }], []);
      const backward = buildFrom([{ ...seed }, seed], []);

      expect(forward.totals.records).toBe(2);
      expect(backward.dossierHash).toBe(forward.dossierHash);
      expect(identityView(backward)).toEqual(identityView(forward));
      // They are an exact-name AND a URL link with a single distinct name.
      expect(forward.exactNameLinks).toHaveLength(1);
      expect(forward.urlLinks).toHaveLength(1);
      expect(forward.urlLinks[0].distinctNameKeyCount).toBe(1);
    });

    it("is invariant to reordering seeds, overrides, and sources together", () => {
      const seeds = [
        { name: "probe alpha", starterUrl: "https://probe.example.org/alpha" },
        { name: "probe beta", starterUrl: "https://probe.example.org/beta" },
      ];
      const overrides = [
        { awardName: "probe alpha", sources: [
          { url: "https://probe.example.org/alpha", pageType: "homepage" },
          { url: "https://probe.example.org/alpha-2", pageType: "deadline" },
        ] },
        { awardName: "probe gamma", sources: [{ url: "https://probe.example.org/gamma", pageType: "homepage" }] },
      ];
      const forward = buildFrom(seeds, overrides);
      const backward = buildFrom(
        [...seeds].reverse(),
        [...overrides].reverse().map((override) => ({ ...override, sources: [...override.sources].reverse() })),
      );

      expect(identityView(backward)).toEqual(identityView(forward));
      expect(backward.exactNameLinks).toEqual(forward.exactNameLinks);
      expect(backward.urlLinks).toEqual(forward.urlLinks);
      expect(backward.lexicalNearbyOnly).toEqual(forward.lexicalNearbyOnly);
      expect(backward.totals).toEqual(forward.totals);
      expect(backward.dossierHash).toBe(forward.dossierHash);
    });
  });

  describe("name equality is literal text, never an alias decision", () => {
    const buildFrom = (seeds, terms) =>
      buildAwardIdentityCollisionDossier({ probe: { probeId: "nsf", lexicalTerms: terms }, seeds, overrides: [] });

    it("does not fabricate an exact_name_link between the NSF alias spellings", () => {
      // The app's normalizeSharedAwardKey folds these three literal names
      // onto one key. Using it here manufactured an exact_name_link out of a
      // prior identity decision (reproduced against the previous revision).
      const seeds = [
        { name: "NSF Graduate Research Fellowship", starterUrl: "https://nsf-a.example.org/" },
        { name: "National Science Foundation Graduate Research Fellowship", starterUrl: "https://nsf-b.example.org/" },
        { name: "NSF Graduate Research Fellowship Program", starterUrl: "https://nsf-c.example.org/" },
      ];
      const dossier = buildFrom(seeds, ["nsf", "national science foundation"]);

      expect(dossier.totals.records).toBe(3);
      expect(dossier.records.map((record) => record.nameKey).sort()).toEqual([
        "national science foundation graduate research fellowship",
        "nsf graduate research fellowship",
        "nsf graduate research fellowship program",
      ]);
      // Three literally different names, so no exact-name evidence at all.
      expect(dossier.exactNameLinks).toEqual([]);
      expect(dossier.totals.exactNameLinks).toBe(0);
      expect(dossier.totals.lexicalNearbyOnly).toBe(3);
    });

    it("does not erase a lexical probe match by rewriting the name key", () => {
      // Under the alias normalizer this record's key became "nsf ...", so a
      // probe for the spelled-out term found nothing.
      const spelledOut = [{ name: "National Science Foundation Graduate Research Fellowship", starterUrl: "https://nsf-b.example.org/" }];
      expect(buildFrom(spelledOut, ["national science foundation"]).totals.records).toBe(1);
      expect(buildFrom(spelledOut, ["nsf"]).totals.records).toBe(0);

      const abbreviated = [{ name: "NSF Graduate Research Fellowship", starterUrl: "https://nsf-a.example.org/" }];
      expect(buildFrom(abbreviated, ["nsf"]).totals.records).toBe(1);
      expect(buildFrom(abbreviated, ["national science foundation"]).totals.records).toBe(0);
    });

    it("still links names that are literally identical apart from case and whitespace", () => {
      const seeds = [
        { name: "  NSF   Graduate Research Fellowship ", starterUrl: "https://nsf-a.example.org/" },
        { name: "nsf graduate research fellowship", starterUrl: "https://nsf-b.example.org/" },
      ];
      const dossier = buildFrom(seeds, ["nsf"]);
      expect(dossier.exactNameLinks).toHaveLength(1);
      expect(dossier.exactNameLinks[0].nameKey).toBe("nsf graduate research fellowship");
    });

    it("does not import the alias-bearing normalizer at all", () => {
      const source = readFileSync(resolve(import.meta.dirname, "award-identity-collision-dossier.mjs"), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/shared-awards-core/);
      expect(code).not.toMatch(/normalizeSharedAwardKey/);
    });
  });

  describe("evidence URLs fail closed", () => {
    const buildFrom = (seeds) =>
      buildAwardIdentityCollisionDossier({ probe: { probeId: "p", lexicalTerms: ["probe"] }, seeds, overrides: [] });

    it("rejects unsafe and unparseable URLs instead of giving them an identity", () => {
      // Each of these was accepted before, and the two script-ish schemes
      // even collapsed onto ONE key ("alert(1)"), grouping them as a shared
      // URL across two different schemes.
      const cases = [
        ["javascript:", "javascript:alert(1)", /must use the http or https scheme/],
        ["data:", "data:alert(1)", /must use the http or https scheme/],
        ["file:", "file:///etc/passwd", /must use the http or https scheme/],
        ["ftp:", "ftp://host/x", /must use the http or https scheme/],
        ["unparseable", "not a url at all", /must be an absolute http\(s\) URL/],
        ["relative", "/apply", /must be an absolute http\(s\) URL/],
        ["credentials", "https://user:pass@probe.example.org/apply", /must not carry credentials/],
      ];
      for (const [label, starterUrl, pattern] of cases) {
        expect(() => buildFrom([{ name: "probe x", starterUrl }]), label).toThrow(pattern);
      }
    });

    it("never collapses a non-default port into the default origin", () => {
      const dossier = buildFrom([
        { name: "probe default", starterUrl: "https://probe.example.org/apply" },
        { name: "probe port", starterUrl: "https://probe.example.org:8443/apply" },
      ]);
      expect(dossier.records.map((record) => record.urlKey).sort()).toEqual([
        "probe.example.org/apply",
        "probe.example.org:8443/apply",
      ]);
      expect(dossier.urlLinks).toEqual([]);
      expect(dossier.totals.urlLinks).toBe(0);

      // An explicitly written default port IS the default origin, so those
      // two really are one endpoint.
      const explicitDefault = buildFrom([
        { name: "probe a", starterUrl: "https://probe.example.org/apply" },
        { name: "probe b", starterUrl: "https://probe.example.org:443/apply" },
      ]);
      expect(explicitDefault.urlLinks).toHaveLength(1);
      expect(explicitDefault.urlLinks[0].urlKey).toBe("probe.example.org/apply");
    });

    it("keeps conservative equivalence for safe http(s) spelling variants", () => {
      const dossier = buildFrom([
        { name: "probe one", starterUrl: "https://WWW.Probe.example.org/Apply/" },
        { name: "probe two", starterUrl: "https://probe.example.org/Apply" },
      ]);
      expect(dossier.urlLinks).toHaveLength(1);
      expect(dossier.urlLinks[0].distinctNameKeyCount).toBe(2);
      // Equivalence of SPELLING only - it carries no eligibility claim.
      expect(dossier.eligibility.candidateEligible).toBe(false);
      expect(dossier.urlLinks[0].relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);
    });

    it("applies the same rule to override source URLs", () => {
      expect(() =>
        buildAwardIdentityCollisionDossier({
          probe: { probeId: "p", lexicalTerms: ["probe"] },
          seeds: [],
          overrides: [{ awardName: "probe award", sources: [{ url: "javascript:alert(1)", pageType: "homepage" }] }],
        }),
      ).toThrow(/overrides\[0\]\.sources\[0\]\.url must use the http or https scheme/);
    });
  });

  it("is generic: the same builder produces a dossier for an unrelated probe", () => {
    // Nothing about Rangel is special-cased, so a different probe over the
    // same catalog yields its own dossier with the same shape and the same
    // pinned verdict.
    const pickering = buildAwardIdentityCollisionDossier({
      probe: { probeId: "pickering", lexicalTerms: ["pickering"] },
      seeds: awardSeeds,
      overrides: awardSourceOverrides,
    });
    expect(pickering.probeId).toBe("pickering");
    expect(pickering.totals.records).toBeGreaterThan(0);
    expect(pickering.relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);
    expect(pickering.eligibility.candidateEligible).toBe(false);
    for (const record of pickering.records) {
      expect(record.nameKey).toMatch(/pickering/);
      expect(record.recordId.startsWith("pickering-")).toBe(true);
    }

    // A probe matching nothing is an empty dossier, not an error.
    const empty = buildAwardIdentityCollisionDossier({
      probe: { probeId: "no_such_award", lexicalTerms: ["zzzz-no-such-award-zzzz"] },
      seeds: awardSeeds,
      overrides: awardSourceOverrides,
    });
    expect(empty.totals).toEqual({ records: 0, exactNameLinks: 0, urlLinks: 0, lexicalNearbyOnly: 0 });
    expect(empty.relationship).toBe(IDENTITY_RELATIONSHIP_UNRESOLVED);
  });
});

// ---------------------------------------------------------------------------
// computeDossierHash is exported, so its argument is untrusted input too.
// ---------------------------------------------------------------------------
describe("the exported digest helper treats its argument as untrusted input", () => {

  it("reproduces and closes the reported toJSON masking attack", () => {
    const original = buildRangelDossier();
    const originalGroup = clone(original.urlLinks[0]);

    const tampered = clone(original);
    tampered.urlLinks[0].relationship = "resolved";
    tampered.urlLinks[0].distinctNameKeyCount = 1;
    // Non-enumerable, exactly as an attacker would hide it.
    Object.defineProperty(tampered.urlLinks[0], "toJSON", {
      value: () => originalGroup,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => computeDossierHash(tampered)).toThrow(/unrecognized own field "toJSON"/);

    // And the same change WITHOUT the masking hook is plainly visible: the
    // fix is a different digest, not a refusal to hash changed dossiers.
    const honest = clone(original);
    honest.urlLinks[0].relationship = "resolved";
    honest.urlLinks[0].distinctNameKeyCount = 1;
    expect(computeDossierHash(honest)).not.toBe(original.dossierHash);
  });

  it("rejects a Proxy - live or revoked - at every input layer, with no trap reached", () => {
    for (const [label, path] of [...OBJECT_LAYERS, ...ARRAY_LAYERS]) {
      const liveHooks = [];
      const live = replaceAt(clone(buildRangelDossier()), path, (value) => countingProxy(value, liveHooks));
      expect(() => computeDossierHash(live), `${label} (live Proxy)`).toThrow(/must not be a Proxy/);
      expect(liveHooks, `${label} (live Proxy)`).toEqual([]);

      const revokedHooks = [];
      const revoked = replaceAt(clone(buildRangelDossier()), path, (value) => {
        const { proxy, revoke } = Proxy.revocable(value, {
          get(target, key, receiver) {
            revokedHooks.push(`trap:get:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        });
        revoke();
        return proxy;
      });
      // A revoked Proxy must fail closed as a Proxy, not escape as a raw
      // TypeError from whatever operation happened to touch it first.
      expect(() => computeDossierHash(revoked), `${label} (revoked Proxy)`).toThrow(
        /award identity collision dossier: .* must not be a Proxy/,
      );
      expect(revokedHooks, `${label} (revoked Proxy)`).toEqual([]);
    }
  });

  it("rejects accessors and exotic prototypes at every object layer, without invoking them", () => {
    for (const [label, path] of OBJECT_LAYERS) {
      const getterHooks = [];
      const withGetter = replaceAt(clone(buildRangelDossier()), path, (value) => {
        const key = Object.keys(value)[0];
        Object.defineProperty(value, key, {
          get() {
            getterHooks.push(`get:${key}`);
            return "hostile";
          },
          enumerable: true,
          configurable: true,
        });
        return value;
      });
      expect(() => computeDossierHash(withGetter), `${label} (accessor)`).toThrow(
        /must be a plain data property, not an accessor/,
      );
      expect(getterHooks, `${label} (accessor)`).toEqual([]);

      const protoHooks = [];
      const withProto = replaceAt(clone(buildRangelDossier()), path, (value) =>
        Object.setPrototypeOf(value, {
          get relationship() {
            protoHooks.push("proto:relationship");
            return "resolved";
          },
          toJSON() {
            protoHooks.push("proto:toJSON");
            return {};
          },
        }),
      );
      expect(() => computeDossierHash(withProto), `${label} (exotic prototype)`).toThrow(
        /prototype is neither Object\.prototype nor null/,
      );
      expect(protoHooks, `${label} (exotic prototype)`).toEqual([]);

      const unknown = replaceAt(clone(buildRangelDossier()), path, (value) => {
        value.smuggled = "unhashed";
        return value;
      });
      expect(() => computeDossierHash(unknown), `${label} (unknown field)`).toThrow(
        /unrecognized own field "smuggled"/,
      );

      const symbolKeyed = replaceAt(clone(buildRangelDossier()), path, (value) => {
        value[Symbol("hidden")] = "unhashed";
        return value;
      });
      expect(() => computeDossierHash(symbolKeyed), `${label} (symbol-keyed field)`).toThrow(
        /must not carry symbol-keyed own properties/,
      );
    }
  });

  it("rejects hostile arrays at every array layer, without running their hooks", () => {
    for (const [label, path] of ARRAY_LAYERS) {
      const subclassHooks = [];
      class HookedArray extends Array {
        sort(...args) {
          subclassHooks.push("sort");
          return super.sort(...args);
        }
        map(...args) {
          subclassHooks.push("map");
          return super.map(...args);
        }
        [Symbol.iterator]() {
          subclassHooks.push("iterator");
          return Array.prototype[Symbol.iterator].call(this);
        }
      }
      const subclassed = replaceAt(clone(buildRangelDossier()), path, (value) => {
        const hostile = new HookedArray();
        for (const element of value) Array.prototype.push.call(hostile, element);
        return hostile;
      });
      expect(() => computeDossierHash(subclassed), `${label} (array subclass)`).toThrow(/must be a plain array/);
      expect(subclassHooks, `${label} (array subclass)`).toEqual([]);

      const holed = replaceAt(clone(buildRangelDossier()), path, (value) => {
        const copy = [...value];
        delete copy[0];
        return copy;
      });
      expect(() => computeDossierHash(holed), `${label} (hole)`).toThrow(/is a hole/);

      const indexGetterHooks = [];
      const indexGetter = replaceAt(clone(buildRangelDossier()), path, (value) => {
        const copy = [...value];
        Object.defineProperty(copy, 0, {
          get() {
            indexGetterHooks.push("index0");
            return "hostile";
          },
          enumerable: true,
          configurable: true,
        });
        return copy;
      });
      expect(() => computeDossierHash(indexGetter), `${label} (indexed accessor)`).toThrow(
        /must be a plain data property, not an accessor/,
      );
      expect(indexGetterHooks, `${label} (indexed accessor)`).toEqual([]);

      const notAnArray = replaceAt(clone(buildRangelDossier()), path, (value) => ({ ...value, length: value.length }));
      expect(() => computeDossierHash(notAnArray), `${label} (not an array)`).toThrow(/must be an array/);
    }
  });

  it("rejects a material leaf that is not the primitive its slot calls for", () => {
    const cases = [
      ["version", ["version"], 7],
      ["probeId", ["probeId"], null],
      ["relationship", ["relationship"], ""],
      ["humanDecisionRequired", ["humanDecisionRequired"], undefined],
      ["totals.records", ["totals", "records"], "6"],
      ["totals.urlLinks", ["totals", "urlLinks"], -1],
      ["totals.exactNameLinks", ["totals", "exactNameLinks"], 1.5],
      ["eligibility.candidateEligible", ["eligibility", "candidateEligible"], "false"],
      ["a record name", ["records", 0, "name"], { toJSON: () => "looks like a string" }],
      ["a record discovery flag", ["records", 0, "institutionalDiscoveryUrl"], "false"],
      ["a record kind", ["records", 0, "recordKind"], "seed_or_something"],
      ["a record position", ["records", 0, "overrideIndex"], -3],
      ["a link recordId", ["urlLinks", 0, "recordIds", 0], 1],
      ["a link count", ["urlLinks", 0, "distinctNameKeyCount"], "2"],
      ["a lexical group nameKey", ["lexicalNearbyOnly", 0, "nameKey"], []],
      ["dossierHash", ["dossierHash"], 12345],
    ];
    for (const [label, path, value] of cases) {
      const tampered = replaceAt(clone(buildRangelDossier()), path, () => value);
      expect(() => computeDossierHash(tampered), label).toThrow(/award identity collision dossier: /);
    }
  });

  it("never lets a rejected value be executed to describe it", () => {
    const hooks = [];
    const hostileLeaf = {
      toJSON() {
        hooks.push("toJSON");
        return "x";
      },
      toString() {
        hooks.push("toString");
        return "x";
      },
      valueOf() {
        hooks.push("valueOf");
        return "x";
      },
      [Symbol.toPrimitive]() {
        hooks.push("Symbol.toPrimitive");
        return "x";
      },
    };
    const tampered = clone(buildRangelDossier());
    tampered.records[0].name = hostileLeaf;
    expect(() => computeDossierHash(tampered)).toThrow(/dossier\.records\[0\]\.name must be a non-empty string; got an object\./);
    expect(hooks).toEqual([]);
  });

  it("binds every leaf inside every record and link group", () => {
    const base = buildRangelDossier();
    const mutations = [
      ["record recordId", ["records", 0, "recordId"], "rangel-999"],
      ["record pageType added to a seed", ["records", base.records.findIndex((r) => r.recordKind === "seed"), "pageType"], "homepage"],
      ["exact-name link evidenceClass", ["exactNameLinks", 0, "evidenceClass"], "url_link"],
      ["exact-name link nameKey", ["exactNameLinks", 0, "nameKey"], "renamed"],
      ["exact-name link recordIds element", ["exactNameLinks", 0, "recordIds", 0], "rangel-999"],
      ["exact-name link recordKinds element", ["exactNameLinks", 0, "recordKinds", 0], "seed"],
      ["exact-name link relationship", ["exactNameLinks", 0, "relationship"], "resolved"],
      ["url link evidenceClass", ["urlLinks", 0, "evidenceClass"], "exact_name_link"],
      ["url link urlKey", ["urlLinks", 0, "urlKey"], "elsewhere.example.org/"],
      ["url link recordIds element", ["urlLinks", 0, "recordIds", 0], "rangel-999"],
      ["url link distinctNameKeys element", ["urlLinks", 0, "distinctNameKeys", 0], "renamed"],
      ["url link distinctNameKeyCount", ["urlLinks", 0, "distinctNameKeyCount"], 9],
      ["url link relationship", ["urlLinks", 0, "relationship"], "resolved"],
      ["lexical group evidenceClass", ["lexicalNearbyOnly", 0, "evidenceClass"], "url_link"],
      ["lexical group recordId", ["lexicalNearbyOnly", 0, "recordId"], "rangel-999"],
      ["lexical group nameKey", ["lexicalNearbyOnly", 0, "nameKey"], "renamed"],
      ["lexical group urlKey", ["lexicalNearbyOnly", 0, "urlKey"], "elsewhere.example.org/"],
      ["lexical group relationship", ["lexicalNearbyOnly", 0, "relationship"], "resolved"],
    ];
    for (const [label, path, value] of mutations) {
      const tampered = replaceAt(clone(base), path, () => value);
      expect(computeDossierHash(tampered), label).not.toBe(base.dossierHash);
    }

    // Dropping a member from a group is material too.
    const shortened = clone(base);
    shortened.urlLinks[0].recordIds = shortened.urlLinks[0].recordIds.slice(1);
    expect(computeDossierHash(shortened)).not.toBe(base.dossierHash);

    // Re-ordering the records is a change the digest must show, not absorb:
    // the helper hashes them in the order given rather than re-sorting.
    const reordered = clone(base);
    reordered.records = [...reordered.records].reverse();
    expect(computeDossierHash(reordered)).not.toBe(base.dossierHash);

    // A clean round-trip through the clone is still the same dossier.
    expect(computeDossierHash(clone(base))).toBe(base.dossierHash);
  });

  it("keeps catalog positions out of the digest while still validating them", () => {
    const base = buildRangelDossier();
    const overrideIndex = base.records.findIndex((record) => record.recordKind === "override_source");
    const seedIndex = base.records.findIndex((record) => record.recordKind === "seed");
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeGreaterThanOrEqual(0);

    // Positions move under an unrelated catalog edit; the evidence does not.
    const movedPositions = clone(base);
    movedPositions.records[overrideIndex].overrideIndex += 500;
    movedPositions.records[overrideIndex].sourceIndex += 500;
    movedPositions.records[seedIndex].seedIndex += 500;
    expect(computeDossierHash(movedPositions)).toBe(base.dossierHash);

    // Still validated rather than ignored.
    const badPosition = clone(base);
    badPosition.records[seedIndex].seedIndex = "84";
    expect(() => computeDossierHash(badPosition)).toThrow(/seedIndex must be a non-negative integer/);
  });

  it("sorts probe terms on a list it owns, so term order is not evidence", () => {
    const base = buildRangelDossier();
    const reordered = clone(base);
    reordered.lexicalTerms = [...reordered.lexicalTerms].reverse();
    expect(computeDossierHash(reordered)).toBe(base.dossierHash);

    const multi = buildRangelDossier({ probe: { probeId: "rangel", lexicalTerms: ["rangel", "aardvark"] } });
    const flipped = clone(multi);
    flipped.lexicalTerms = [...flipped.lexicalTerms].reverse();
    expect(computeDossierHash(flipped)).toBe(multi.dossierHash);
    expect(multi.lexicalTerms).not.toEqual(base.lexicalTerms);
  });

  it("serializes only a graph it built itself", () => {
    // JSON.stringify is reached with no caller object in the material graph,
    // so a replacer hook installed anywhere in the input can never run.
    const hooks = [];
    const base = buildRangelDossier();
    const observed = clone(base);
    for (const container of [observed, observed.totals, observed.eligibility, ...observed.records, ...observed.urlLinks]) {
      Object.defineProperty(container, "toJSON", {
        value: () => {
          hooks.push("toJSON");
          return {};
        },
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    expect(() => computeDossierHash(observed)).toThrow(/unrecognized own field "toJSON"/);
    expect(hooks).toEqual([]);

    // And the untampered dossier hashes without touching any caller hook,
    // because Array.prototype and Object.prototype are never consulted for
    // the material graph either.
    const pristine = clone(base);
    const arraySort = vi.spyOn(Array.prototype, "sort");
    const arrayMap = vi.spyOn(Array.prototype, "map");
    try {
      expect(computeDossierHash(pristine)).toBe(base.dossierHash);
      // The only sort is the helper's own, on its own lexicalTerms copy.
      expect(arraySort.mock.calls.length).toBe(1);
      expect(arrayMap.mock.calls.length).toBe(0);
    } finally {
      arraySort.mockRestore();
      arrayMap.mockRestore();
    }
  });

  it("stays a public recomputation helper with an unchanged digest", () => {
    const base = buildRangelDossier();
    // The published Rangel digest is unchanged by this hardening: the fix is
    // about what the helper will READ, not about what it means.
    expect(base.dossierHash).toBe("b2277dd78e4b9156a224bf0082b0000548f1dd7eb4a344c1323190444757a252");
    expect(typeof computeDossierHash).toBe("function");
    expect(computeDossierHash(base)).toBe(base.dossierHash);
    // A dossier that has not been hashed yet is still hashable, which is how
    // the builder itself calls in.
    const unhashed = clone(base);
    unhashed.dossierHash = null;
    expect(computeDossierHash(unhashed)).toBe(base.dossierHash);
    delete unhashed.dossierHash;
    expect(computeDossierHash(unhashed)).toBe(base.dossierHash);
  });
});

// ---------------------------------------------------------------------------
// An array's own key set is part of its shape. Validating only the indexed
// slots leaves room for a property that nothing reads but everything else
// serializes.
// ---------------------------------------------------------------------------
describe("arrays may own nothing but their length and canonical indices", () => {
  // Each entry installs one hostile own property and records, via `hooks`,
  // whether anything on it was ever executed. Every kind must be rejected on
  // its NAME alone, so `hooks` must stay empty in all of them.
  const HOSTILE_OWN_PROPERTIES = [
    [
      "an unknown name",
      (array) => {
        array.smuggled = "unhashed";
      },
      /unexpected own property "smuggled"/,
    ],
    [
      "a symbol key",
      (array) => {
        array[Symbol("hidden")] = "unhashed";
      },
      /must not carry symbol-keyed own properties/,
    ],
    [
      'a noncanonical index name "01"',
      (array) => {
        array["01"] = "unhashed";
      },
      /unexpected own property "01"/,
    ],
    [
      'a noncanonical index name "1.0"',
      (array) => {
        array["1.0"] = "unhashed";
      },
      /unexpected own property "1\.0"/,
    ],
    [
      "an own toJSON",
      (array, hooks) =>
        Object.defineProperty(array, "toJSON", {
          value: () => {
            hooks.push("toJSON");
            return [];
          },
          enumerable: false,
          configurable: true,
          writable: true,
        }),
      /unexpected own property "toJSON"/,
    ],
    [
      "an own map",
      (array, hooks) =>
        Object.defineProperty(array, "map", {
          value: () => {
            hooks.push("map");
            return [];
          },
          enumerable: false,
          configurable: true,
          writable: true,
        }),
      /unexpected own property "map"/,
    ],
    [
      "an own sort",
      (array, hooks) =>
        Object.defineProperty(array, "sort", {
          value: () => {
            hooks.push("sort");
            return [];
          },
          enumerable: false,
          configurable: true,
          writable: true,
        }),
      /unexpected own property "sort"/,
    ],
    [
      "an own Symbol.iterator",
      (array, hooks) =>
        Object.defineProperty(array, Symbol.iterator, {
          value: function* iterate() {
            hooks.push("iterator");
          },
          enumerable: false,
          configurable: true,
          writable: true,
        }),
      /must not carry symbol-keyed own properties/,
    ],
    [
      "an extra accessor",
      (array, hooks) =>
        Object.defineProperty(array, "shadow", {
          get() {
            hooks.push("shadow");
            return "unhashed";
          },
          enumerable: false,
          configurable: true,
        }),
      /unexpected own property "shadow"/,
    ],
  ];

  it("closes the reported export forgery: an own toJSON on the real dossier's urlLinks", () => {
    const dossier = buildRangelDossier();
    const hooks = [];
    Object.defineProperty(dossier.urlLinks, "toJSON", {
      value: () => {
        hooks.push("urlLinks.toJSON");
        return [];
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });

    // Before the fix this recomputed to exactly the stored hash while
    // JSON.stringify exported urlLinks as [] - a dossier whose digest said
    // one URL collision and whose exported JSON said none.
    expect(() => computeDossierHash(dossier)).toThrow(
      /dossier\.urlLinks carries an unexpected own property "toJSON"/,
    );
    expect(hooks).toEqual([]);
  });

  it("rejects every hostile own property at every array layer, executing none of them", () => {
    for (const [layerLabel, path] of ARRAY_LAYERS) {
      for (const [propertyLabel, install, expected] of HOSTILE_OWN_PROPERTIES) {
        const hooks = [];
        const tampered = replaceAt(clone(buildRangelDossier()), path, (array) => {
          install(array, hooks);
          return array;
        });
        const where = `${layerLabel} with ${propertyLabel}`;
        expect(() => computeDossierHash(tampered), where).toThrow(expected);
        // Inert: rejected on the key name, never by consulting the value.
        expect(hooks, where).toEqual([]);
      }
    }
  });

  it("keeps rejecting holes and indexed accessors, and still accepts ordinary arrays", () => {
    const base = buildRangelDossier();
    for (const [layerLabel, path] of ARRAY_LAYERS) {
      const holed = replaceAt(clone(base), path, (array) => {
        const copy = [...array];
        delete copy[0];
        return copy;
      });
      expect(() => computeDossierHash(holed), `${layerLabel} (hole)`).toThrow(/is a hole/);

      // An index beyond length extends length, so the gap it leaves is a hole
      // rather than an unexpected key - still fail-closed, just differently.
      const beyond = replaceAt(clone(base), path, (array) => {
        const copy = [...array];
        Object.defineProperty(copy, String(copy.length + 3), {
          value: "unhashed",
          enumerable: true,
          configurable: true,
          writable: true,
        });
        return copy;
      });
      expect(() => computeDossierHash(beyond), `${layerLabel} (out-of-range index)`).toThrow(/is a hole/);

      // Rebuilding the same layer as an ordinary array changes nothing.
      const plain = replaceAt(clone(base), path, (array) => [...array]);
      expect(computeDossierHash(plain), `${layerLabel} (ordinary array)`).toBe(base.dossierHash);
    }
  });

  it("applies the same rule to the builder's catalog input arrays", () => {
    const seeds = [{ name: "probe one", starterUrl: "https://probe.example.org/1" }];
    const overrides = [
      { awardName: "probe one", sources: [{ url: "https://probe.example.org/o", pageType: "homepage" }] },
    ];
    const build = (input) =>
      buildAwardIdentityCollisionDossier({
        probe: input.probe ?? { probeId: "probe", lexicalTerms: ["probe"] },
        seeds: input.seeds ?? seeds,
        overrides: input.overrides ?? overrides,
      });

    // The baseline the hostile cases are built from is genuinely accepted.
    expect(build({}).totals.records).toBe(2);

    const hostileSeeds = [...seeds];
    const seedHooks = [];
    Object.defineProperty(hostileSeeds, "toJSON", {
      value: () => {
        seedHooks.push("seeds.toJSON");
        return [];
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(() => build({ seeds: hostileSeeds })).toThrow(/seeds carries an unexpected own property "toJSON"/);
    expect(seedHooks).toEqual([]);

    const hostileOverrides = [...overrides];
    hostileOverrides.smuggled = "unhashed";
    expect(() => build({ overrides: hostileOverrides })).toThrow(
      /overrides carries an unexpected own property "smuggled"/,
    );

    const hostileSources = [...overrides[0].sources];
    hostileSources["01"] = "unhashed";
    expect(() => build({ overrides: [{ awardName: "probe one", sources: hostileSources }] })).toThrow(
      /overrides\[0\]\.sources carries an unexpected own property "01"/,
    );

    const hostileTerms = ["probe"];
    hostileTerms[Symbol("hidden")] = "unhashed";
    expect(() => build({ probe: { probeId: "probe", lexicalTerms: hostileTerms } })).toThrow(
      /must not carry symbol-keyed own properties/,
    );
  });

  it("cannot serialize evidence the digest did not bind", () => {
    // The positive half of the contract: for a graph the helper ACCEPTS,
    // what JSON.stringify exports is exactly what the digest covered - so
    // re-hashing the exported document reproduces the stored hash.
    const base = buildRangelDossier();
    const exported = JSON.parse(JSON.stringify(base));
    expect(computeDossierHash(exported)).toBe(base.dossierHash);
    expect(exported.urlLinks).toHaveLength(base.urlLinks.length);
    expect(exported.records).toHaveLength(base.totals.records);

    // And the exported document is itself a plain graph: every array in it
    // owns only its indices, so the round trip cannot smuggle anything back.
    const arraysIn = (value, path = "dossier") => {
      if (Array.isArray(value)) {
        return [[path, value], ...value.flatMap((element, index) => arraysIn(element, `${path}[${index}]`))];
      }
      if (value !== null && typeof value === "object") {
        return Object.entries(value).flatMap(([key, inner]) => arraysIn(inner, `${path}.${key}`));
      }
      return [];
    };
    // Derived, not guessed: the five top-level collections, plus the two
    // string lists each exact-name link carries and the two each URL link
    // carries. Every one of them is checked below.
    const found = arraysIn(exported);
    expect(found.length).toBe(5 + 2 * base.totals.exactNameLinks + 2 * base.totals.urlLinks);
    for (const [path, array] of found) {
      expect(Object.getOwnPropertySymbols(array), path).toEqual([]);
      expect(Object.getOwnPropertyNames(array).filter((key) => key !== "length"), path).toEqual(
        array.map((_element, index) => String(index)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Enumerability is shape: JSON omits a hidden object property, so a field
// that is read here but dropped there breaks the accepted-graph guarantee.
// ---------------------------------------------------------------------------
describe("an accepted graph exports exactly what the digest bound", () => {
  const hideField = (object, key) =>
    Object.defineProperty(object, key, {
      ...Object.getOwnPropertyDescriptor(object, key),
      enumerable: false,
    });

  // Every object layer the module accepts, located from a fresh graph.
  const OBJECT_LOCATORS = [
    ["dossier", (dossier) => dossier],
    ["totals", (dossier) => dossier.totals],
    ["eligibility", (dossier) => dossier.eligibility],
    ["an override_source record", (dossier) => dossier.records.find((r) => r.recordKind === "override_source")],
    ["a seed record", (dossier) => dossier.records.find((r) => r.recordKind === "seed")],
    ["an exact-name link", (dossier) => dossier.exactNameLinks[0]],
    ["a URL link", (dossier) => dossier.urlLinks[0]],
    ["a lexical group", (dossier) => dossier.lexicalNearbyOnly[0]],
  ];

  it("closes the reported pageType reproduction", () => {
    const dossier = buildRangelDossier();
    const record = dossier.records.find((candidate) => candidate.recordKind === "override_source");
    hideField(record, "pageType");

    // What the previous revision allowed: the field is still readable here,
    // so the digest was recomputed unchanged...
    expect(record.pageType).toBe("homepage");
    // ...while JSON drops it, and the parsed export hashes differently.
    const exported = JSON.parse(JSON.stringify(dossier));
    const exportedRecord = exported.records.find((candidate) => candidate.recordId === record.recordId);
    expect("pageType" in exportedRecord).toBe(false);

    expect(() => computeDossierHash(dossier)).toThrow(
      /dossier\.records\[\d+\]\.pageType must be an enumerable own property/,
    );
  });

  it("closes the reported root urlLinks reproduction", () => {
    const dossier = buildRangelDossier();
    hideField(dossier, "urlLinks");

    const exported = JSON.parse(JSON.stringify(dossier));
    // A whole evidence class disappears while totals still counts it.
    expect("urlLinks" in exported).toBe(false);
    expect(exported.totals.urlLinks).toBe(1);
    expect(() => computeDossierHash(exported)).toThrow(/dossier\.urlLinks must be an array/);

    expect(() => computeDossierHash(dossier)).toThrow(/dossier\.urlLinks must be an enumerable own property/);
  });

  it("rejects a hidden field on every accepted field of every object layer", () => {
    const reference = buildRangelDossier();
    const checked = [];
    for (const [layerLabel, locate] of OBJECT_LOCATORS) {
      const fields = Object.keys(locate(reference));
      expect(fields.length, layerLabel).toBeGreaterThan(0);
      for (const key of fields) {
        const tampered = clone(reference);
        hideField(locate(tampered), key);
        const where = `${layerLabel}.${key}`;
        expect(() => computeDossierHash(tampered), where).toThrow(/must be an enumerable own property/);
        checked.push(where);
      }
    }

    // The two the review reproduced, plus the trace and digest fields that
    // are not bound into the hash but must still survive an export.
    expect(checked).toContain("an override_source record.pageType");
    expect(checked).toContain("dossier.urlLinks");
    expect(checked).toContain("dossier.dossierHash");
    expect(checked).toContain("a seed record.seedIndex");
    expect(checked).toContain("an override_source record.overrideIndex");
    expect(checked).toContain("an override_source record.sourceIndex");
    // 12 dossier + 4 totals + 4 eligibility + 10 override_source record
    // + 8 seed record + 5 exact-name + 6 URL + 5 lexical. If the dossier
    // shape ever changes, this number must be revisited deliberately.
    expect(checked).toHaveLength(54);
  });

  it("decides enumerability from the descriptor, never from the value", () => {
    const hooks = [];
    const hostile = {
      toJSON() {
        hooks.push("toJSON");
        return "x";
      },
      toString() {
        hooks.push("toString");
        return "x";
      },
      valueOf() {
        hooks.push("valueOf");
        return "x";
      },
      [Symbol.toPrimitive]() {
        hooks.push("toPrimitive");
        return "x";
      },
    };
    const tampered = clone(buildRangelDossier());
    Object.defineProperty(tampered.records[0], "name", {
      value: hostile,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(() => computeDossierHash(tampered)).toThrow(/\.name must be an enumerable own property/);
    expect(hooks).toEqual([]);
  });

  it("states one array policy: indices enumerable too, length the sole exemption", () => {
    // Arrays are the one place enumerability does NOT change what JSON emits:
    // stringify walks 0..length-1 and serializes a hidden element anyway.
    const probe = [1, 2, 3];
    Object.defineProperty(probe, 1, { ...Object.getOwnPropertyDescriptor(probe, 1), enumerable: false });
    expect(Object.getOwnPropertyDescriptor(probe, 1).enumerable).toBe(false);
    expect(JSON.stringify(probe)).toBe("[1,2,3]");

    // So this rule buys uniformity rather than export safety, and is applied
    // anyway so one sentence covers the module. It refuses nothing ordinary:
    // literals, spreads, .map results, JSON.parse output and frozen arrays
    // all have enumerable indices.
    expect(Object.getOwnPropertyDescriptor(Object.freeze([1]), 0).enumerable).toBe(true);
    expect(Object.getOwnPropertyDescriptor(JSON.parse("[1]"), 0).enumerable).toBe(true);

    for (const [label, path] of ARRAY_LAYERS) {
      const tampered = replaceAt(clone(buildRangelDossier()), path, (array) => {
        const copy = [...array];
        Object.defineProperty(copy, 0, { ...Object.getOwnPropertyDescriptor(copy, 0), enumerable: false });
        return copy;
      });
      expect(() => computeDossierHash(tampered), label).toThrow(/must be an enumerable own property/);
    }

    // length is exempt, and has to be: it is non-enumerable on every array
    // and JSON never serializes it as content.
    const base = buildRangelDossier();
    expect(Object.getOwnPropertyDescriptor(base.records, "length").enumerable).toBe(false);
    expect(computeDossierHash(base)).toBe(base.dossierHash);
  });

  it("applies the rule to the builder's probe, seed, override and source records", () => {
    const seeds = [{ name: "probe one", starterUrl: "https://probe.example.org/1" }];
    const overrides = [
      { awardName: "probe one", sources: [{ url: "https://probe.example.org/o", pageType: "homepage" }] },
    ];
    const probe = { probeId: "probe", lexicalTerms: ["probe"] };
    const build = (input) =>
      buildAwardIdentityCollisionDossier({
        probe: input.probe ?? probe,
        seeds: input.seeds ?? seeds,
        overrides: input.overrides ?? overrides,
      });

    // The baseline the hostile cases are built from is genuinely accepted.
    expect(build({}).totals.records).toBe(2);

    const hiddenSeedName = [{ ...seeds[0] }];
    hideField(hiddenSeedName[0], "name");
    expect(() => build({ seeds: hiddenSeedName })).toThrow(
      /seeds\[0\]\.name must be an enumerable own property/,
    );

    const hiddenSeedUrl = [{ ...seeds[0] }];
    hideField(hiddenSeedUrl[0], "starterUrl");
    expect(() => build({ seeds: hiddenSeedUrl })).toThrow(
      /seeds\[0\]\.starterUrl must be an enumerable own property/,
    );

    const hiddenAwardName = [{ ...overrides[0], sources: [...overrides[0].sources] }];
    hideField(hiddenAwardName[0], "awardName");
    expect(() => build({ overrides: hiddenAwardName })).toThrow(
      /overrides\[0\]\.awardName must be an enumerable own property/,
    );

    const hiddenSources = [{ ...overrides[0], sources: [...overrides[0].sources] }];
    hideField(hiddenSources[0], "sources");
    expect(() => build({ overrides: hiddenSources })).toThrow(
      /overrides\[0\]\.sources must be an enumerable own property/,
    );

    const hiddenSourcePageType = [{ ...overrides[0], sources: [{ ...overrides[0].sources[0] }] }];
    hideField(hiddenSourcePageType[0].sources[0], "pageType");
    expect(() => build({ overrides: hiddenSourcePageType })).toThrow(
      /overrides\[0\]\.sources\[0\]\.pageType must be an enumerable own property/,
    );

    const hiddenProbeTerms = { ...probe };
    hideField(hiddenProbeTerms, "lexicalTerms");
    expect(() => build({ probe: hiddenProbeTerms })).toThrow(
      /probe\.lexicalTerms must be an enumerable own property/,
    );

    const hiddenProbeId = { ...probe };
    hideField(hiddenProbeId, "probeId");
    expect(() => build({ probe: hiddenProbeId })).toThrow(/probe\.probeId must be an enumerable own property/);
  });

  it("round-trips every accepted graph through JSON with the same digest and no field lost", () => {
    // Structural key shape including leaf types, so a dropped field, an
    // added one, or a changed type all show up.
    const keyShape = (value) =>
      Array.isArray(value)
        ? value.map(keyShape)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, keyShape(value[key])]),
            )
          : typeof value;

    const graphs = [
      ["rangel", buildRangelDossier()],
      ["a multi-term probe", buildRangelDossier({ probe: { probeId: "rangel", lexicalTerms: ["rangel", "aardvark"] } })],
      [
        "an unrelated probe",
        buildAwardIdentityCollisionDossier({
          probe: { probeId: "pickering", lexicalTerms: ["pickering"] },
          seeds: awardSeeds,
          overrides: awardSourceOverrides,
        }),
      ],
      [
        "a probe that matches nothing",
        buildAwardIdentityCollisionDossier({
          probe: { probeId: "no_such_award", lexicalTerms: ["zzzz-no-such-award-zzzz"] },
          seeds: awardSeeds,
          overrides: awardSourceOverrides,
        }),
      ],
      [
        "a synthetic catalog with every evidence class",
        buildAwardIdentityCollisionDossier({
          probe: { probeId: "probe", lexicalTerms: ["probe"] },
          seeds: [
            { name: "probe alpha", starterUrl: "https://probe.example.org/alpha" },
            { name: "probe beta", starterUrl: "https://probe.example.org/shared" },
            { name: "probe gamma", starterUrl: "https://probe.example.org/shared" },
          ],
          overrides: [
            { awardName: "probe alpha", sources: [{ url: "https://probe.example.org/o", pageType: "homepage" }] },
          ],
        }),
      ],
    ];

    for (const [label, graph] of graphs) {
      const exported = JSON.parse(JSON.stringify(graph));
      // Still valid, and still the same evidence.
      expect(computeDossierHash(exported), label).toBe(graph.dossierHash);
      // Nothing silently disappeared or appeared, material or trace.
      expect(keyShape(exported), label).toEqual(keyShape(graph));
    }
  });

  it("documents exactly how dossierHash itself is treated", () => {
    const base = buildRangelDossier();

    // Required enumerable like everything else, so it survives an export.
    expect(Object.getOwnPropertyDescriptor(base, "dossierHash").enumerable).toBe(true);
    expect(JSON.parse(JSON.stringify(base)).dossierHash).toBe(base.dossierHash);
    const hidden = clone(base);
    hideField(hidden, "dossierHash");
    expect(() => computeDossierHash(hidden)).toThrow(/dossierHash must be an enumerable own property/);

    // The one intentional asymmetry: it is NOT bound into the digest, because
    // it is the digest's own output and binding it would make the value
    // depend on itself. That is precisely what lets a reviewer detect a
    // forged digest - recomputing ignores the stored value and disagrees.
    const forged = clone(base);
    forged.dossierHash = "0".repeat(64);
    expect(computeDossierHash(forged)).toBe(base.dossierHash);
    expect(computeDossierHash(forged)).not.toBe(forged.dossierHash);

    // Absent is accepted, because the builder hashes before filling it in.
    const unhashed = clone(base);
    delete unhashed.dossierHash;
    expect(computeDossierHash(unhashed)).toBe(base.dossierHash);
  });
});

// ---------------------------------------------------------------------------
// Boxed primitives: a prototype check cannot see an internal slot.
// ---------------------------------------------------------------------------
describe("laundered boxed primitives are refused at every shared-boundary layer", () => {
  const WRAPPERS = [
    ["Boolean", () => new Boolean(false)],
    ["Number", () => new Number(0)],
    ["empty String", () => new String("")],
    ["indexed String", () => new String("ab")],
    ["BigInt", () => Object(1n)],
    ["Symbol", () => Object(Symbol("s"))],
  ];
  const PROTOTYPES = [
    ["Object.prototype", Object.prototype],
    ["null", null],
  ];
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boxed = (prefix, label) =>
    new RegExp(
      `^${escapeRegExp(prefix)}${escapeRegExp(label)} must be a plain object, not a boxed primitive; a Boolean, Number, String, BigInt or Symbol wrapper keeps its primitive in an internal slot`,
    );
  const DOSSIER = "award identity collision dossier: ";
  const PLANNER = "post-stage1 expansion plan: ";
  // Laundered: the wrapper's prototype reset to an allowed one, the record's
  // own fields copied on, and own coercion accessors that must never be read
  // - the slot is decided before any key is consulted.
  const launder = (make, proto, fields, calls) => {
    const wrapper = Object.assign(Object.setPrototypeOf(make(), proto), fields);
    for (const key of ["toJSON", "toString", "valueOf"]) {
      Object.defineProperty(wrapper, key, {
        get() {
          calls.push(key);
          return () => "<x>";
        },
        configurable: true,
      });
    }
    Object.defineProperty(wrapper, Symbol.toPrimitive, {
      get() {
        calls.push("Symbol.toPrimitive");
        return () => "<x>";
      },
      configurable: true,
    });
    Object.defineProperty(wrapper, Symbol.toStringTag, {
      get() {
        calls.push("Symbol.toStringTag");
        return "Plain";
      },
      configurable: true,
    });
    return wrapper;
  };
  const exportOf = (value) => {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return `THROWS ${error.constructor.name}`;
    }
  };

  it("pins the reported reproduction: the dossier's own fields, a different export, now refused", () => {
    const base = buildRangelDossier();
    const wrapped = Object.assign(Object.setPrototypeOf(new Boolean(false), Object.prototype), clone(base));
    // Its own enumerable data is exactly the dossier's - which is why the
    // digest used to recompute the stored hash for it - while its export is
    // not the dossier at all.
    expect(Object.fromEntries(Object.entries(wrapped))).toEqual(clone(base));
    expect(JSON.stringify(wrapped)).toBe("false");
    expect(() => computeDossierHash(wrapped)).toThrow(boxed(DOSSIER, "dossier"));

    // The proven export behaviour of each kind, so the diagnostic's claim
    // stays honest: only a Symbol wrapper serializes its fields normally.
    const facts = [
      ["Boolean", Object.prototype, "false"],
      ["Boolean", null, "false"],
      ["Number", Object.prototype, "null"],
      ["Number", null, "THROWS TypeError"],
      ["BigInt", Object.prototype, "THROWS TypeError"],
      ["BigInt", null, "THROWS TypeError"],
      ["empty String", Object.prototype, '"[object String]"'],
      ["empty String", null, "THROWS TypeError"],
    ];
    for (const [kind, proto, expected] of facts) {
      const make = WRAPPERS.find(([name]) => name === kind)[1];
      const laundered = Object.assign(Object.setPrototypeOf(make(), proto), clone(base));
      expect(exportOf(laundered), `${kind} on ${proto === null ? "null" : "Object.prototype"}`).toBe(expected);
    }
    const symbolWrapped = Object.assign(Object.setPrototypeOf(Object(Symbol("s")), Object.prototype), clone(base));
    expect(JSON.parse(JSON.stringify(symbolWrapped))).toEqual(clone(base));
    expect(() => computeDossierHash(symbolWrapped)).toThrow(boxed(DOSSIER, "dossier"));
  });

  it("refuses every wrapper kind on both prototypes at all seven dossier-hash layers (84), and at the seed record (12)", () => {
    const base = buildRangelDossier();
    const seedIndex = base.records.findIndex((record) => record.recordKind === "seed");
    const overrideIndex = base.records.findIndex((record) => record.recordKind === "override_source");
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    const layers = [
      ["dossier", []],
      ["dossier.totals", ["totals"]],
      ["dossier.eligibility", ["eligibility"]],
      [`dossier.records[${overrideIndex}]`, ["records", overrideIndex]],
      ["dossier.exactNameLinks[0]", ["exactNameLinks", 0]],
      ["dossier.urlLinks[0]", ["urlLinks", 0]],
      ["dossier.lexicalNearbyOnly[0]", ["lexicalNearbyOnly", 0]],
    ];
    const calls = [];
    let checked = 0;
    const run = (label, path) => {
      for (const [kind, make] of WRAPPERS) {
        for (const [protoName, proto] of PROTOTYPES) {
          const tampered = replaceAt(clone(base), path, (value) => launder(make, proto, value, calls));
          expect(() => computeDossierHash(tampered), `${label} as ${kind} on ${protoName}`).toThrow(boxed(DOSSIER, label));
          checked += 1;
        }
      }
    };
    for (const [label, path] of layers) run(label, path);
    expect(checked).toBe(84);
    run(`dossier.records[${seedIndex}]`, ["records", seedIndex]);
    expect(checked).toBe(96);
    expect(calls).toEqual([]);
    // Nothing plain changed: the stored hash still reproduces from a clone.
    expect(computeDossierHash(clone(base))).toBe("b2277dd78e4b9156a224bf0082b0000548f1dd7eb4a344c1323190444757a252");
  });

  it("orders the diagnostics: prototype for an unlaundered wrapper, the slot before any consumer key check, Proxy before both", () => {
    const base = buildRangelDossier();
    // An unlaundered wrapper keeps the existing prototype diagnostic.
    const unlaundered = Object.assign(new Boolean(false), clone(base));
    expect(() => computeDossierHash(unlaundered)).toThrow(
      /^award identity collision dossier: dossier must be a plain object; its prototype is neither Object\.prototype nor null/,
    );
    // An indexed String wrapper owns intrinsic "0", "1" and length keys,
    // which the dossier's exact-field check used to be the only thing
    // refusing. The slot is now reported first.
    const indexed = Object.assign(Object.setPrototypeOf(new String("ab"), Object.prototype), clone(base));
    expect(() => computeDossierHash(indexed)).toThrow(boxed(DOSSIER, "dossier"));
    // A laundered record carrying a real field accessor and an unknown key:
    // still the slot, still nothing read.
    const calls = [];
    const record = replaceAt(clone(base), ["records", 0], (value) => {
      const wrapper = launder(() => new Number(0), null, value, calls);
      Object.defineProperty(wrapper, "name", {
        get() {
          calls.push("name");
          return "x";
        },
        enumerable: true,
        configurable: true,
      });
      wrapper.smuggled = "unhashed";
      return wrapper;
    });
    expect(() => computeDossierHash(record)).toThrow(boxed(DOSSIER, "dossier.records[0]"));
    expect(calls).toEqual([]);
    // Proxy first, live or revoked, no trap, no raw TypeError.
    const traps = [];
    const live = countingProxy(Object.assign(Object.setPrototypeOf(new Boolean(false), Object.prototype), clone(base)), traps);
    expect(() => computeDossierHash(live)).toThrow(/^award identity collision dossier: dossier must not be a Proxy/);
    const { proxy, revoke } = Proxy.revocable(Object.assign(Object.setPrototypeOf(Object(1n), null), clone(base)), {});
    revoke();
    let caught;
    try {
      computeDossierHash(proxy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.message).toMatch(/^award identity collision dossier: dossier must not be a Proxy/);
    expect(traps).toEqual([]);
  });

  it("refuses laundered records on every dossier builder input layer (60), and accepts every ordinary equivalent", () => {
    const fixture = () => ({
      probe: { probeId: "rangel", lexicalTerms: ["rangel"] },
      seeds: [{ name: "Rangel Thing", starterUrl: "https://rangelprogram.org/" }],
      overrides: [{ awardName: "Rangel Thing", sources: [{ url: "https://rangelprogram.org/", pageType: "homepage" }] }],
    });
    const plainHash = buildAwardIdentityCollisionDossier(fixture()).dossierHash;
    const layers = [
      ["input", []],
      ["probe", ["probe"]],
      ["seeds[0]", ["seeds", 0]],
      ["overrides[0]", ["overrides", 0]],
      ["overrides[0].sources[0]", ["overrides", 0, "sources", 0]],
    ];
    const calls = [];
    let checked = 0;
    for (const [label, path] of layers) {
      for (const [kind, make] of WRAPPERS) {
        for (const [protoName, proto] of PROTOTYPES) {
          const input = replaceAt(fixture(), path, (value) => launder(make, proto, value, calls));
          expect(() => buildAwardIdentityCollisionDossier(input), `${label} as ${kind} on ${protoName}`).toThrow(boxed(DOSSIER, label));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(60);
    expect(calls).toEqual([]);

    const nullProto = (value) =>
      Array.isArray(value)
        ? value.map(nullProto)
        : value !== null && typeof value === "object"
          ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, nullProto(inner)])))
          : value;
    const deepFreeze = (value) => {
      if (Array.isArray(value)) value.forEach(deepFreeze);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
      return Object.freeze(value);
    };
    expect(buildAwardIdentityCollisionDossier(deepFreeze(fixture())).dossierHash).toBe(plainHash);
    expect(buildAwardIdentityCollisionDossier(JSON.parse(JSON.stringify(fixture()))).dossierHash).toBe(plainHash);
    expect(buildAwardIdentityCollisionDossier({ ...fixture() }).dossierHash).toBe(plainHash);
    expect(buildAwardIdentityCollisionDossier(nullProto(fixture())).dossierHash).toBe(plainHash);
  });

  it("refuses laundered records on every planner builder input layer through the same boundary (84), with the pinned plan intact", () => {
    const slugByKey = new Map(stage1CohortIdentity.map((row) => [row[1], row[4]]));
    const stage1Identity = () =>
      STAGE1_COHORT_DEFINITION.map((cohort) => ({
        cohortKey: cohort.cohortKey,
        canonicalName: cohort.canonicalName,
        canonicalSearchKey: cohort.canonicalSearchKey,
        aliasSearchKeys: [...cohort.aliasSearchKeys],
        canonicalSlug: slugByKey.get(cohort.cohortKey),
        officialHomepage: cohort.officialHomepage,
      }));
    // Fresh arrays at every layer, so a replaced element never touches the
    // imported catalogs.
    const fixture = () => ({
      config: {
        schema: "post-stage1-expansion-candidates-v1",
        candidates: [{ candidateId: "mitchell", awardName: "Mitchell Scholarship", slug: "mitchell-scholarship", status: "provisional" }],
      },
      seeds: [...awardSeeds],
      overrides: awardSourceOverrides.map((override) => ({ ...override, sources: [...override.sources] })),
      stage1Identity: stage1Identity(),
    });
    const plain = buildPostStage1ExpansionPlan(fixture());
    expect(plain.plans.map((plan) => plan.planHash)).toEqual(["c64098d958e6ab8bdbda82764ab8c2890c76e343d328e5e0d4e0fac670c1f3b1"]);
    expect(stage1IdentityContentDigest(stage1Identity())).toBe("a6493d81606bd408d6291ef8dc193866168f155de10ee268ccca0efc6d387363");
    expect(STAGE1_COHORT_DEFINITION).toHaveLength(25);

    const layers = [
      ["input", []],
      ["config", ["config"]],
      ["config.candidates[0]", ["config", "candidates", 0]],
      ["seeds[0]", ["seeds", 0]],
      ["overrides[0]", ["overrides", 0]],
      ["overrides[0].sources[0]", ["overrides", 0, "sources", 0]],
      ["stage1Identity[0]", ["stage1Identity", 0]],
    ];
    const calls = [];
    let checked = 0;
    for (const [label, path] of layers) {
      for (const [kind, make] of WRAPPERS) {
        for (const [protoName, proto] of PROTOTYPES) {
          const input = replaceAt(fixture(), path, (value) => launder(make, proto, value, calls));
          expect(() => buildPostStage1ExpansionPlan(input), `${label} as ${kind} on ${protoName}`).toThrow(boxed(PLANNER, label));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(84);
    expect(calls).toEqual([]);
  });
});
