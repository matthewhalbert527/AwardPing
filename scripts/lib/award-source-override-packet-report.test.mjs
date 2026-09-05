import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { awardSeeds } from "../../src/lib/award-seeds.ts";
import { awardSourceOverrides } from "../../src/lib/award-source-overrides.ts";
import {
  AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION,
  buildAwardSourceOverridePacketReport,
} from "./award-source-override-packet-report.mjs";

const FINESST = "Future Investigators in NASA Earth and Space Science and Technology";
const UDALL = "Udall Scholarship";
const MITCHELL = "Mitchell Scholarship";
const UNRESOLVED = "unresolved_pending_human_review";
const ALL_FALSE = { candidateEligible: false, onboardingEligible: false, monitoringEligible: false, publicationEligible: false };
const PREFIX = "award source override packet report: ";
// Test-only projection: every `trace` object removed. This is a review aid
// pinned here, not an exported digest and not an integrity claim.
const MATERIAL_DIGEST = "42e33e1ccdc615ed9306ecc48907e363dbc15f92d06eb5aa08e6e65efe4906b8";

const build = (input) => buildAwardSourceOverridePacketReport(input);
const real = () => build({ overrides: awardSourceOverrides, seeds: awardSeeds });
const stripTrace = (value) =>
  Array.isArray(value)
    ? value.map(stripTrace)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "trace")
            .map(([key, inner]) => [key, stripTrace(inner)]),
        )
      : value;
const material = (report) => JSON.stringify(stripTrace(report));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const byName = (report, name) => report.packets.find((packet) => packet.awardName === name);
const codes = (packet) => packet.warnings.map((warning) => warning.code);

// Fixture builders (test-side spreads only; the module never spreads input).
const source = (url, patch = {}) => ({ url, title: "Page title", pageType: "homepage", confidence: 0.9, reason: "Official page.", ...patch });
const packet = (awardName, sources) => ({ awardName, sources });
const seed = (name, starterUrl = "https://seed.example.org/") => ({ name, starterUrl });
const messageOf = (run) => {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a rejection");
};
const rotate = (array, by) => [...array.slice(by % array.length), ...array.slice(0, by % array.length)];
const shuffle = (array, seedValue) => {
  const out = [...array];
  let state = seedValue;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
};
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

describe("the real catalog, as a reviewer sees it", () => {
  it("reads as a compact summary of the three multi-source packets", () => {
    const report = real();
    const line = (name) => {
      const p = byName(report, name);
      const counts = (object) =>
        Object.entries(object)
          .map(([key, count]) => `${key}x${count}`)
          .join(" ");
      return `${p.awardName}: ${p.sourceCount} sources, ${p.homepageCount} homepage, hosts ${counts(p.hostnameCounts)}, page types ${counts(p.pageTypeCounts)}, ${p.comparisonUrlKeyCount} comparison keys, ${p.literalSeedMatches.length} literal seed match(es), warnings [${codes(p).join(", ")}], relationship ${p.relationship}`;
    };
    expect(line(FINESST)).toBe(
      `${FINESST}: 6 sources, 1 homepage, hosts nspires.nasaprs.comx5 science.nasa.govx1, page types applicationx2 deadlinex1 faqx1 homepagex1 pdfx1, 6 comparison keys, 0 literal seed match(es), warnings [no_literal_seed_match], relationship ${UNRESOLVED}`,
    );
    expect(line(UDALL)).toBe(
      `${UDALL}: 13 sources, 1 homepage, hosts www.udall.govx13, page types applicationx5 deadlinex1 eligibilityx1 faqx1 homepagex1 otherx3 pdfx1, 13 comparison keys, 1 literal seed match(es), warnings [], relationship ${UNRESOLVED}`,
    );
    expect(line(MITCHELL)).toBe(
      `${MITCHELL}: 12 sources, 1 homepage, hosts mitchell.us-irelandalliance.orgx1 us-irelandalliance.orgx11, page types applicationx6 eligibilityx1 faqx1 homepagex1 otherx2 requirementsx1, 12 comparison keys, 1 literal seed match(es), warnings [], relationship ${UNRESOLVED}`,
    );
  });

  it("pins the exact catalog facts", () => {
    const report = real();
    expect(report.version).toBe(AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION);
    expect(report.totals).toEqual({
      packets: 31,
      sources: 59,
      comparisonUrlKeys: 52,
      seeds: 1157,
      singleSourcePackets: 28,
      multiSourcePackets: 3,
      packetsWithWarnings: 14,
      warnings: 14,
      sharedComparisonUrlGroups: 7,
    });
    const multi = report.packets.filter((p) => p.sourceCount > 1).map((p) => [p.awardName, p.sourceCount]);
    expect(multi).toEqual([
      [FINESST, 6],
      [MITCHELL, 12],
      [UDALL, 13],
    ]);
    expect(report.packets.reduce((total, p) => total + p.homepageCount, 0)).toBe(31);
    expect(report.packets.every((p) => p.homepageCount === 1)).toBe(true);
    expect(report.packets.reduce((total, p) => total + p.duplicateComparisonUrlGroups.length, 0)).toBe(0);
    expect(report.packets.every((p) => p.comparisonUrlKeyCount === p.sourceCount)).toBe(true);

    const matchCounts = report.packets.map((p) => p.literalSeedMatches.length);
    expect(matchCounts.filter((n) => n === 1)).toHaveLength(17);
    expect(matchCounts.filter((n) => n === 0)).toHaveLength(14);
    expect(matchCounts.filter((n) => n > 1)).toHaveLength(0);
    // Every warning in the real catalog is the identity-join one; no packet
    // has a structural warning.
    expect(report.packets.flatMap(codes).every((code) => code === "no_literal_seed_match")).toBe(true);

    // FINESST: structurally complete, unjoined, unresolved. Not eligible.
    const finesst = byName(report, FINESST);
    expect(finesst.literalSeedMatches).toEqual([]);
    expect(finesst.trace.literalSeedIndexes).toEqual([]);
    expect(codes(finesst)).toEqual(["no_literal_seed_match"]);
    expect(finesst.hostnameCounts).toEqual({ "nspires.nasaprs.com": 5, "science.nasa.gov": 1 });
    expect(finesst.pageTypeCounts).toEqual({ application: 2, deadline: 1, faq: 1, homepage: 1, pdf: 1 });
    // Udall and Mitchell: one literal seed match each, no warnings, and the
    // repeated page types and (for Mitchell) two hosts stay descriptive.
    const udall = byName(report, UDALL);
    expect(udall.literalSeedMatches).toEqual([{ name: UDALL, starterUrl: awardSeeds[97].starterUrl }]);
    expect(udall.trace.literalSeedIndexes).toEqual([97]);
    expect(codes(udall)).toEqual([]);
    expect(udall.pageTypeCounts.application).toBe(5);
    const mitchell = byName(report, MITCHELL);
    expect(mitchell.literalSeedMatches).toEqual([{ name: MITCHELL, starterUrl: awardSeeds[141].starterUrl }]);
    expect(mitchell.trace.literalSeedIndexes).toEqual([141]);
    expect(codes(mitchell)).toEqual([]);
    expect(Object.keys(mitchell.hostnameCounts)).toEqual(["mitchell.us-irelandalliance.org", "us-irelandalliance.org"]);

    // Seven cross-packet shared keys: the alias pairs, descriptive only.
    expect(report.sharedComparisonUrlGroups.map((g) => [g.comparisonUrlKey, g.packetCount, g.members.map((m) => m.awardName)])).toEqual([
      ["borenawards.org/", 2, ["Boren Awards", "Boren Awards for International Study"]],
      ["clscholarship.org/", 2, ["Critical Language Scholarship", "Critical Languages Scholarship"]],
      ["knight-hennessy.stanford.edu/", 2, ["Knight-Hennessy Scholars", "Knight-Hennessy Scholars Program"]],
      ["noaa.gov/office-education/hollings-scholarship", 2, ["Hollings Scholarship", "NOAA Hollings Scholarship"]],
      ["pdsoros.org/", 2, ["Soros Fellowship for New Americans", "Soros Fellowships for New Americans"]],
      ["rangelprogram.org/graduate-fellowship-program", 2, ["Charles B. Rangel International Affairs Fellowship", "Rangel Fellowship"]],
      ["schwarzmanscholars.org/", 2, ["Schwarzman Scholars", "Schwarzman Scholarship"]],
    ]);
    for (const group of report.sharedComparisonUrlGroups) {
      for (const member of group.members) {
        const owner = report.packets.find((p) => p.packetId === member.packetId);
        expect(owner.awardName).toBe(member.awardName);
        expect(owner.sources.some((s) => s.sourceId === member.sourceId && s.url === member.url)).toBe(true);
      }
    }
    // Every source is exact-text, https, non-discovery and policy-accepted.
    const sources = report.packets.flatMap((p) => p.sources);
    expect(sources).toHaveLength(59);
    expect(sources.every((s) => s.https && !s.institutionalDiscoveryUrl && !s.sourceUrlPolicyRejected)).toBe(true);
    expect(sources.every((s) => typeof s.confidence === "number" && s.title.length > 0 && s.reason.length > 0)).toBe(true);
    // Packets and sources are in content order, not authoring order.
    expect(report.packets.map((p) => p.literalNameKey)).toEqual([...report.packets.map((p) => p.literalNameKey)].sort());
    expect(report.packets[0].packetId).toBe("packet-0001");
    expect(report.packets[30].packetId).toBe("packet-0031");
    expect(byName(report, UDALL).trace.overrideIndex).toBe(29);
  });

  it("pins every relationship and every eligibility flag, on warning-free packets too", () => {
    const report = real();
    expect(report.relationship).toBe(UNRESOLVED);
    expect(report.eligibility).toEqual(ALL_FALSE);
    for (const p of report.packets) {
      expect(p.relationship).toBe(UNRESOLVED);
      expect(p.eligibility).toEqual(ALL_FALSE);
    }
    expect(report.packets.filter((p) => p.warnings.length === 0).length).toBe(17);
  });

  it("pins the test-only material digest and full-output repeatability", () => {
    const first = real();
    const second = real();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
    expect(sha256(material(first))).toBe(MATERIAL_DIGEST);
  });

  it("is materially invariant under reversal, rotation and seeded permutation of overrides, sources and seeds, while traces move", () => {
    const base = real();
    const expected = material(base);
    const variants = [
      ["reversed", (a) => [...a].reverse()],
      ["rotated by 7", (a) => rotate(a, 7)],
      ["rotated by 101", (a) => rotate(a, 101)],
      ["shuffled (seed 11)", (a) => shuffle(a, 11)],
      ["shuffled (seed 20260903)", (a) => shuffle(a, 20260903)],
    ];
    for (const [label, permute] of variants) {
      const overrides = permute(awardSourceOverrides.map((o) => ({ awardName: o.awardName, sources: permute(o.sources) })));
      const seeds = permute(awardSeeds);
      const report = build({ overrides, seeds });
      expect(material(report), label).toBe(expected);
      expect(report.packets.map((p) => p.packetId), label).toEqual(base.packets.map((p) => p.packetId));
    }
    // Traces really are input positions: reversal moves them.
    const reversed = build({
      overrides: [...awardSourceOverrides].reverse().map((o) => ({ awardName: o.awardName, sources: [...o.sources].reverse() })),
      seeds: [...awardSeeds].reverse(),
    });
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(base));
    expect(byName(reversed, UDALL).trace.overrideIndex).toBe(1);
    expect(byName(reversed, UDALL).trace.literalSeedIndexes).toEqual([awardSeeds.length - 1 - 97]);
    expect(byName(reversed, UDALL).sources.map((s) => s.trace.sourceIndex)).not.toEqual(byName(base, UDALL).sources.map((s) => s.trace.sourceIndex));
  });

  it("round-trips through JSON and never references or mutates its input", () => {
    const overrides = deepFreeze(JSON.parse(JSON.stringify(awardSourceOverrides)));
    const seeds = deepFreeze(JSON.parse(JSON.stringify(awardSeeds)));
    const before = JSON.stringify({ overrides, seeds });
    const report = build({ overrides, seeds });
    expect(JSON.stringify({ overrides, seeds })).toBe(before);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    const inputObjects = new Set([overrides, seeds, ...overrides, ...overrides.flatMap((o) => [o.sources, ...o.sources]), ...seeds]);
    const walk = (value) => {
      if (value === null || typeof value !== "object") return;
      expect(inputObjects.has(value)).toBe(false);
      for (const inner of Object.values(value)) walk(inner);
    };
    walk(report);
  });

  it("changes the material output when a title, reason, page type or confidence changes, even when counts do not", () => {
    const baseline = material(real());
    const edited = (patch) => {
      const overrides = awardSourceOverrides.map((o) =>
        o.awardName === UDALL ? { awardName: o.awardName, sources: o.sources.map((s, i) => (i === 0 ? { ...s, ...patch } : s)) } : o,
      );
      return build({ overrides, seeds: awardSeeds });
    };
    for (const patch of [{ title: "Retitled" }, { reason: "Different reason." }, { confidence: 0.42 }]) {
      const report = edited(patch);
      expect(material(report), JSON.stringify(patch)).not.toBe(baseline);
      expect(report.totals).toEqual(real().totals);
      expect(byName(report, UDALL).pageTypeCounts).toEqual(byName(real(), UDALL).pageTypeCounts);
    }
    const retyped = edited({ pageType: "renamed-type" });
    expect(material(retyped)).not.toBe(baseline);
    expect(byName(retyped, UDALL).pageTypeCounts["renamed-type"]).toBe(1);
  });
});

describe("determinism on synthetic packets", () => {
  it("keeps duplicate occurrences, orders fully identical packets by input position, and names them unambiguously", () => {
    const twin = () => packet("Twin Award", [source("https://twin.example.org/"), source("https://twin.example.org/apply", { pageType: "application" })]);
    const other = packet("Another Award", [source("https://another.example.org/")]);
    const forward = build({ overrides: [twin(), twin(), other], seeds: [] });
    const backward = build({ overrides: [other, twin(), twin()], seeds: [] });
    expect(forward.totals.packets).toBe(3);
    expect(forward.packets.map((p) => [p.packetId, p.awardName])).toEqual([
      ["packet-0001", "Another Award"],
      ["packet-0002", "Twin Award"],
      ["packet-0003", "Twin Award"],
    ]);
    expect(forward.packets[1].trace.overrideIndex).toBe(0);
    expect(forward.packets[2].trace.overrideIndex).toBe(1);
    expect(material(backward)).toBe(material(forward));
    expect(backward.packets[1].trace.overrideIndex).toBe(1);
    expect(backward.packets[2].trace.overrideIndex).toBe(2);
    // The twins share both keys across two distinct packets, named by id.
    expect(forward.sharedComparisonUrlGroups.map((g) => [g.comparisonUrlKey, g.packetCount, g.members.map((m) => `${m.packetId}/${m.sourceId}`)])).toEqual([
      ["twin.example.org/", 2, ["packet-0002/packet-0002-source-0001", "packet-0003/packet-0003-source-0001"]],
      ["twin.example.org/apply", 2, ["packet-0002/packet-0002-source-0002", "packet-0003/packet-0003-source-0002"]],
    ]);
    // Duplicate packet names are warned on both occurrences.
    expect(codes(forward.packets[1])).toEqual(["duplicate_override_literal_name", "no_literal_seed_match"]);
    expect(forward.packets[1].warnings[0]).toEqual({ code: "duplicate_override_literal_name", literalNameKey: "twin award", count: 2 });
  });

  it("keeps fully identical sources inside one packet, ordered by input position", () => {
    const same = () => source("https://same.example.org/page", { pageType: "application" });
    const report = build({ overrides: [packet("Same Source Award", [source("https://same.example.org/"), same(), same()])], seeds: [] });
    const p = report.packets[0];
    expect(p.sourceCount).toBe(3);
    expect(p.comparisonUrlKeyCount).toBe(2);
    expect(p.sources.slice(1).map((s) => [s.sourceId, s.trace.sourceIndex])).toEqual([
      ["packet-0001-source-0002", 1],
      ["packet-0001-source-0003", 2],
    ]);
    expect(p.duplicateComparisonUrlGroups).toEqual([
      { comparisonUrlKey: "same.example.org/page", count: 2, sourceIds: ["packet-0001-source-0002", "packet-0001-source-0003"] },
    ]);
    expect(codes(p)).toEqual(["duplicate_source_comparison_url", "no_literal_seed_match"]);
    expect(p.warnings[0]).toEqual({ code: "duplicate_source_comparison_url", comparisonUrlKey: "same.example.org/page", count: 2 });
  });

  it("orders by complete tuples, so delimiter-bearing text cannot collide or reorder", () => {
    // Two sources whose fields, joined with any single delimiter, spell the
    // same string ("t" + "|" + "p|q" equals "t|p" + "|" + "q"). As tuples
    // they differ at the title, so their order is fixed by content, never
    // by input position.
    const collideA = source("https://delim.example.org/p", { title: "t", pageType: "p|q" });
    const collideB = source("https://delim.example.org/p", { title: "t|p", pageType: "q" });
    for (const sources of [[collideA, collideB], [collideB, collideA]]) {
      const p = build({ overrides: [packet("Collision Award", sources)], seeds: [] }).packets[0];
      expect(p.sources.map((s) => [s.title, s.pageType])).toEqual([["t", "p|q"], ["t|p", "q"]]);
      expect(p.sources.map((s) => s.trace.sourceIndex)).toEqual(sources[0] === collideA ? [0, 1] : [1, 0]);
    }
    expect(material(build({ overrides: [packet("Collision Award", [collideB, collideA])], seeds: [] }))).toBe(
      material(build({ overrides: [packet("Collision Award", [collideA, collideB])], seeds: [] })),
    );
    // The same at the packet level: two same-named packets are ordered by
    // their source tuples, so the collideA packet comes first even when it
    // is authored second.
    const samePair = build({ overrides: [packet("Same Name", [collideB]), packet("Same Name", [collideA])], seeds: [] });
    expect(samePair.packets.map((p) => p.sources[0].title)).toEqual(["t", "t|p"]);
    expect(samePair.packets.map((p) => p.trace.overrideIndex)).toEqual([1, 0]);
    // Names that differ only by a delimiter suffix are two packets with a
    // fixed order.
    const a = packet("x|y", [source("https://delim.example.org/", { title: "t" })]);
    const b = packet("x", [source("https://delim.example.org/", { title: "y|t" })]);
    const forward = build({ overrides: [a, b], seeds: [] });
    const backward = build({ overrides: [b, a], seeds: [] });
    expect(forward.packets.map((p) => p.awardName)).toEqual(["x", "x|y"]);
    expect(material(backward)).toBe(material(forward));
    // Element-wise comparison: "xa" sorts before "x|y" because "a" < "|",
    // and after "x" because "x" is its prefix. A delimiter join would put
    // "x" after "xa" (the delimiter outranks "a").
    const c = packet("xa", [source("https://delim.example.org/", { title: "t" })]);
    expect(build({ overrides: [c, a, b], seeds: [] }).packets.map((p) => p.awardName)).toEqual(["x", "xa", "x|y"]);
    expect(material(build({ overrides: [c, a, b], seeds: [] }))).toBe(material(build({ overrides: [b, c, a], seeds: [] })));
    // A title carrying newlines, commas and pipes is preserved verbatim.
    const odd = build({ overrides: [packet("Odd Title", [source("https://odd.example.org/", { title: "a,b|c\nd" })])], seeds: [] });
    expect(odd.packets[0].sources[0].title).toBe("a,b|c\nd");
    expect(JSON.parse(JSON.stringify(odd))).toEqual(odd);
  });

  it("is unaffected by the key order of input records", () => {
    const ordered = packet("Key Order Award", [{ url: "https://order.example.org/", title: "T", pageType: "homepage", confidence: 0.5, reason: "R" }]);
    const shuffled = { sources: [{ reason: "R", confidence: 0.5, pageType: "homepage", title: "T", url: "https://order.example.org/" }], awardName: "Key Order Award" };
    const seeds = [{ starterUrl: "https://s.example.org/", name: "Key Order Award" }];
    expect(JSON.stringify(build({ overrides: [shuffled], seeds }))).toBe(JSON.stringify(build({ overrides: [ordered], seeds: [seed("Key Order Award", "https://s.example.org/")] })));
  });
});

describe("warnings are stable, evidence-backed, and never verdicts", () => {
  it("emits every code in one stable combined order while retaining every source", () => {
    const sources = [
      source("http://combo.example.org/", { pageType: "homepage" }),
      source("https://onsa.asu.edu/scholarship/combo", { pageType: "other" }),
      source("https://combo.example.org/careers", { pageType: "homepage" }),
      source("https://combo.example.org/apply?b=2&a=1", { pageType: "application" }),
      source("https://www.combo.example.org/apply?a=1&b=2", { pageType: "application" }),
    ];
    const report = build({
      overrides: [packet("Combo Award", sources), packet("combo   AWARD", [source("https://combo.example.org/other", { pageType: "other" })])],
      seeds: [seed("Combo Award", "https://s1.example.org/"), seed("COMBO award", "https://s2.example.org/")],
    });
    const p = byName(report, "Combo Award");
    expect(p.sources).toHaveLength(5);
    expect(codes(p)).toEqual([
      "duplicate_override_literal_name",
      "duplicate_source_comparison_url",
      "homepage_count_not_one",
      "multiple_literal_seed_matches",
      "source_institutional_discovery_url",
      "source_not_https",
      "source_url_policy_rejected",
      "source_url_policy_rejected",
    ]);
    // The production policy rejects discovery hosts too, so the discovery
    // URL carries both of its descriptive flags; same-code warnings sort by
    // their url.
    expect(p.warnings).toEqual([
      { code: "duplicate_override_literal_name", literalNameKey: "combo award", count: 2 },
      { code: "duplicate_source_comparison_url", comparisonUrlKey: "combo.example.org/apply?a=1&b=2", count: 2 },
      { code: "homepage_count_not_one", homepageCount: 2 },
      { code: "multiple_literal_seed_matches", count: 2 },
      { code: "source_institutional_discovery_url", url: "https://onsa.asu.edu/scholarship/combo" },
      { code: "source_not_https", url: "http://combo.example.org/" },
      { code: "source_url_policy_rejected", url: "https://combo.example.org/careers" },
      { code: "source_url_policy_rejected", url: "https://onsa.asu.edu/scholarship/combo" },
    ]);
    expect(p.literalSeedMatches).toEqual([
      { name: "COMBO award", starterUrl: "https://s2.example.org/" },
      { name: "Combo Award", starterUrl: "https://s1.example.org/" },
    ]);
    expect(p.trace.literalSeedIndexes).toEqual([1, 0]);
    expect(p.relationship).toBe(UNRESOLVED);
    expect(p.eligibility).toEqual(ALL_FALSE);
    expect(report.totals.packetsWithWarnings).toBe(2);
  });

  it("describes an empty packet without inventing sources", () => {
    const report = build({ overrides: [packet("Empty Award", [])], seeds: [seed("Empty Award")] });
    const p = report.packets[0];
    expect(p.sourceCount).toBe(0);
    expect(p.homepageCount).toBe(0);
    expect(p.hostnameCounts).toEqual({});
    expect(p.pageTypeCounts).toEqual({});
    expect(codes(p)).toEqual(["empty_source_packet", "homepage_count_not_one"]);
    expect(p.warnings[1]).toEqual({ code: "homepage_count_not_one", homepageCount: 0 });
  });

  it("treats multiple hosts, repeated page types and cross-packet shared keys as descriptive only", () => {
    const report = build({
      overrides: [
        packet("Wide Award", [source("https://a.example.org/"), source("https://b.example.org/x", { pageType: "application" }), source("https://c.example.org/y", { pageType: "application" })]),
        packet("Wide Award Sibling", [source("https://a.example.org/")]),
      ],
      seeds: [seed("Wide Award"), seed("Wide Award Sibling")],
    });
    const wide = byName(report, "Wide Award");
    expect(Object.keys(wide.hostnameCounts)).toHaveLength(3);
    expect(wide.pageTypeCounts.application).toBe(2);
    expect(codes(wide)).toEqual([]);
    expect(codes(byName(report, "Wide Award Sibling"))).toEqual([]);
    expect(report.sharedComparisonUrlGroups).toHaveLength(1);
    expect(report.sharedComparisonUrlGroups[0].comparisonUrlKey).toBe("a.example.org/");
    expect(report.totals.warnings).toBe(0);
  });
});

describe("literal name joins", () => {
  it("matches only literal text after trim, lowercase and whitespace collapse", () => {
    const seeds = [
      seed("  Udall   Scholarship ", "https://s1.example.org/"),
      seed("UDALL SCHOLARSHIP", "https://s2.example.org/"),
      seed("Udall Scholarship.", "https://no1.example.org/"),
      seed("Udall", "https://no2.example.org/"),
      seed("Udall Scholarships", "https://no3.example.org/"),
      seed("Udall Schölarship", "https://no4.example.org/"),
      seed("Morris K. Udall Scholarship", "https://no5.example.org/"),
    ];
    const report = build({ overrides: [packet("Udall Scholarship", [source("https://udall.example.org/")])], seeds });
    const p = report.packets[0];
    expect(p.literalNameKey).toBe("udall scholarship");
    expect(p.literalSeedMatches).toEqual([
      { name: "  Udall   Scholarship ", starterUrl: "https://s1.example.org/" },
      { name: "UDALL SCHOLARSHIP", starterUrl: "https://s2.example.org/" },
    ]);
    expect(p.trace.literalSeedIndexes).toEqual([0, 1]);
    expect(codes(p)).toEqual(["multiple_literal_seed_matches"]);
    expect(p.warnings[0]).toEqual({ code: "multiple_literal_seed_matches", count: 2 });
    expect(p.awardName).toBe("Udall Scholarship");
  });

  it("never joins by URL", () => {
    const report = build({
      overrides: [packet("Named Differently", [source("https://shared.example.org/")])],
      seeds: [seed("Something Else", "https://shared.example.org/")],
    });
    expect(report.packets[0].literalSeedMatches).toEqual([]);
    expect(codes(report.packets[0])).toEqual(["no_literal_seed_match"]);
  });
});

describe("URL identity is guarded", () => {
  const one = (url) => build({ overrides: [packet("Url Award", [source(url)])], seeds: [seed("Url Award")] }).packets[0].sources[0];
  const pair = (left, right) =>
    build({ overrides: [packet("Pair Award", [source(left), source(right, { pageType: "other" })])], seeds: [seed("Pair Award")] }).packets[0];

  it("keeps production canonical equivalence for safe spelling variants and query normalization", () => {
    expect(pair("https://x.example.org/p?b=2&a=1", "https://x.example.org/p?a=1&b=2").comparisonUrlKeyCount).toBe(1);
    expect(pair("https://x.example.org/p?utm_source=a", "https://x.example.org/p").comparisonUrlKeyCount).toBe(1);
    expect(pair("https://WWW.X.example.org/P/", "https://x.example.org/P").comparisonUrlKeyCount).toBe(1);
    expect(pair("https://x.example.org/p?a=1", "https://x.example.org/p?a=2").comparisonUrlKeyCount).toBe(2);
    expect(pair("https://x.example.org/a%2Fb", "https://x.example.org/a/b").comparisonUrlKeyCount).toBe(2);
    expect(pair("https://x.example.org/a%3Fb", "https://x.example.org/a?b").comparisonUrlKeyCount).toBe(2);
    expect(one("https://x.example.org/a%2Fb").comparisonUrlKey).toBe("x.example.org/a%2fb");
  });

  it("preserves a non-default port, equates an explicit default port, and accepts http structurally with a warning", () => {
    expect(one("https://x.example.org:8443/p").comparisonUrlKey).toBe("x.example.org:8443/p");
    expect(pair("https://x.example.org:8443/p", "https://x.example.org/p").comparisonUrlKeyCount).toBe(2);
    expect(pair("https://x.example.org:443/p", "https://x.example.org/p").comparisonUrlKeyCount).toBe(1);
    const insecure = one("http://x.example.org/p");
    expect(insecure.https).toBe(false);
    expect(insecure.comparisonUrlKey).toBe("x.example.org/p");
    const mixed = pair("http://x.example.org/p", "https://x.example.org/p");
    expect(mixed.comparisonUrlKeyCount).toBe(1);
    expect(codes(mixed)).toEqual(["duplicate_source_comparison_url", "source_not_https"]);
  });

  it("fails closed on unsupported schemes, malformed URLs, missing hosts and credentials", () => {
    const cases = [
      ["javascript:alert(1)", /overrides\[0\]\.sources\[0\]\.url must use the http or https scheme; got "javascript:"\./],
      ["data:alert(1)", /must use the http or https scheme; got "data:"\./],
      ["mailto:x@example.org", /must use the http or https scheme; got "mailto:"\./],
      ["file:///etc/hosts", /must use the http or https scheme; got "file:"\./],
      ["not a url", /overrides\[0\]\.sources\[0\]\.url must be an absolute http\(s\) URL; got "not a url"\./],
      ["/relative/path", /must be an absolute http\(s\) URL; got "\/relative\/path"\./],
      ["https://user:pw@x.example.org/", /overrides\[0\]\.sources\[0\]\.url must not carry credentials\./],
      ["https://token@x.example.org/", /must not carry credentials\./],
    ];
    for (const [url, pattern] of cases) {
      const message = messageOf(() => one(url));
      expect(message, url).toMatch(pattern);
      expect(message.startsWith(PREFIX), url).toBe(true);
    }
  });

  it("describes discovery hosts and policy-rejected shapes without deciding anything", () => {
    const discovery = one("https://onsa.asu.edu/scholarship/award");
    expect(discovery.institutionalDiscoveryUrl).toBe(true);
    // The production policy refuses discovery hosts as official sources, so
    // both flags are reported; each is a fact, neither is a verdict.
    expect(discovery.sourceUrlPolicyRejected).toBe(true);
    for (const url of ["https://x.example.org/careers", "https://x.example.org/jobs", "https://x.example.org/assets/logo.png"]) {
      const rejected = one(url);
      expect(rejected.sourceUrlPolicyRejected, url).toBe(true);
      expect(rejected.institutionalDiscoveryUrl, url).toBe(false);
    }
    const accepted = one("https://x.example.org/apply");
    expect(accepted.sourceUrlPolicyRejected).toBe(false);
    expect(accepted.hostname).toBe("x.example.org");
  });
});

describe("the input boundary", () => {
  const valid = () => ({
    overrides: [packet("Boundary Award", [source("https://boundary.example.org/")])],
    seeds: [seed("Boundary Award")],
  });

  it("accepts ordinary, frozen and null-prototype inputs identically", () => {
    const plain = JSON.stringify(build(valid()));
    expect(JSON.stringify(build(deepFreeze(valid())))).toBe(plain);
    expect(JSON.stringify(build(nullProto(valid())))).toBe(plain);
    expect(JSON.stringify(build(JSON.parse(JSON.stringify(valid()))))).toBe(plain);
  });

  it("ignores every unconsumed field without reading it", () => {
    const calls = [];
    const input = valid();
    for (const record of [input.overrides[0], input.overrides[0].sources[0], input.seeds[0]]) {
      record.extraData = { nested: true };
      accessorHooks(record, calls);
      Object.defineProperty(record, "extraAccessor", {
        get() {
          calls.push("extraAccessor");
          return 1;
        },
        enumerable: true,
        configurable: true,
      });
    }
    expect(JSON.stringify(build(input))).toBe(JSON.stringify(build(valid())));
    expect(calls).toEqual([]);
  });

  it("rejects live and revoked Proxies at every layer with no trap reached", () => {
    const layers = [
      ["input", (v) => [v, (proxy) => proxy]],
      ["overrides", (v) => [v.overrides, (proxy) => ({ ...v, overrides: proxy })]],
      ["overrides[0]", (v) => [v.overrides[0], (proxy) => ({ ...v, overrides: [proxy] })]],
      ["overrides[0].sources", (v) => [v.overrides[0].sources, (proxy) => ({ ...v, overrides: [{ ...v.overrides[0], sources: proxy }] })]],
      ["overrides[0].sources[0]", (v) => [v.overrides[0].sources[0], (proxy) => ({ ...v, overrides: [{ ...v.overrides[0], sources: [proxy] }] })]],
      ["seeds", (v) => [v.seeds, (proxy) => ({ ...v, seeds: proxy })]],
      ["seeds[0]", (v) => [v.seeds[0], (proxy) => ({ ...v, seeds: [proxy] })]],
    ];
    for (const [label, locate] of layers) {
      const traps = [];
      const [target, place] = locate(valid());
      expect(messageOf(() => build(place(countingProxy(target, traps)))), label).toBe(`${PREFIX}${label} must not be a Proxy; its traps could report a different shape than it yields.`);
      const [revokedTarget, placeRevoked] = locate(valid());
      const { proxy, revoke } = Proxy.revocable(revokedTarget, {});
      revoke();
      let caught;
      try {
        build(placeRevoked(proxy));
      } catch (error) {
        caught = error;
      }
      expect(caught, `${label} revoked`).toBeInstanceOf(Error);
      expect(caught, `${label} revoked`).not.toBeInstanceOf(TypeError);
      expect(caught.message, `${label} revoked`).toMatch(new RegExp(`^${PREFIX}${label.replace(/[.[\]]/g, "\\$&")} must not be a Proxy`));
      expect(traps, label).toEqual([]);
    }
  });

  it("rejects accessors, hidden fields, exotic prototypes, boxed records and hostile arrays without reading anything", () => {
    const calls = [];
    const withAccessor = (record, key) => {
      const value = record[key];
      Object.defineProperty(record, key, {
        get() {
          calls.push(key);
          return value;
        },
        enumerable: true,
        configurable: true,
      });
      return record;
    };
    const cases = [
      ["overrides[0].awardName accessor", (v) => withAccessor(v.overrides[0], "awardName"), /overrides\[0\]\.awardName must be a plain data property, not an accessor/],
      ["sources[0].url accessor", (v) => withAccessor(v.overrides[0].sources[0], "url"), /overrides\[0\]\.sources\[0\]\.url must be a plain data property, not an accessor/],
      ["sources[0].confidence accessor", (v) => withAccessor(v.overrides[0].sources[0], "confidence"), /sources\[0\]\.confidence must be a plain data property, not an accessor/],
      ["seeds[0].name accessor", (v) => withAccessor(v.seeds[0], "name"), /seeds\[0\]\.name must be a plain data property, not an accessor/],
      ["hidden awardName", (v) => hidden(v.overrides[0], "awardName"), /overrides\[0\]\.awardName must be an enumerable own property/],
      ["hidden source reason", (v) => hidden(v.overrides[0].sources[0], "reason"), /sources\[0\]\.reason must be an enumerable own property/],
      ["hidden seed starterUrl", (v) => hidden(v.seeds[0], "starterUrl"), /seeds\[0\]\.starterUrl must be an enumerable own property/],
      ["exotic prototype override", (v) => Object.setPrototypeOf(v.overrides[0], { awardName: "inherited" }), /overrides\[0\] must be a plain object; its prototype is neither Object\.prototype nor null/],
      ["boxed source record", (v) => (v.overrides[0].sources[0] = accessorHooks(Object.assign(Object.setPrototypeOf(new Boolean(false), Object.prototype), v.overrides[0].sources[0]), calls)), /overrides\[0\]\.sources\[0\] must be a plain object, not a boxed primitive; /],
      ["boxed seed on null", (v) => (v.seeds[0] = Object.assign(Object.setPrototypeOf(new Number(0), null), v.seeds[0])), /seeds\[0\] must be a plain object, not a boxed primitive; /],
      ["sparse sources", (v) => { v.overrides[0].sources.length = 2; }, /overrides\[0\]\.sources\[1\] is a hole/],
      ["augmented sources array", (v) => Object.defineProperty(v.overrides[0].sources, "toJSON", { value: () => { calls.push("toJSON"); return []; }, configurable: true, writable: true }), /overrides\[0\]\.sources carries an unexpected own property "toJSON"/],
      ["symbol-keyed overrides array", (v) => { v.overrides[Symbol("s")] = 1; }, /overrides must not carry symbol-keyed own properties/],
      ["subclassed seeds", (v) => { class Hooked extends Array { map() { calls.push("map"); return []; } } v.seeds = Hooked.from(v.seeds); }, /seeds must be a plain array; its prototype is neither Array\.prototype nor null/],
      ["hidden source index", (v) => hidden(v.overrides[0].sources, 0), /overrides\[0\]\.sources\[0\] must be an enumerable own property/],
      ["non-array overrides", (v) => { v.overrides = { length: 1, 0: v.overrides[0] }; }, /overrides must be an array\./],
      ["non-object input", () => "not an input", /input must be an object\./],
    ];
    for (const [label, install, pattern] of cases) {
      const input = valid();
      const replaced = install(input);
      const target = label === "non-object input" ? replaced : input;
      const message = messageOf(() => build(target));
      expect(message, label).toMatch(pattern);
      expect(message.startsWith(PREFIX), label).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("rejects missing and wrong-typed consumed fields with inert diagnostics", () => {
    const calls = [];
    const hostile = accessorHooks({}, calls);
    const cases = [
      ["missing awardName", (v) => delete v.overrides[0].awardName, /overrides\[0\]\.awardName must be a non-empty string; got undefined\./],
      ["missing sources", (v) => delete v.overrides[0].sources, /overrides\[0\]\.sources must be an array\./],
      ["null sources", (v) => (v.overrides[0].sources = null), /overrides\[0\]\.sources must be an array\./],
      ["missing url", (v) => delete v.overrides[0].sources[0].url, /overrides\[0\]\.sources\[0\]\.url must be a non-empty string; got undefined\./],
      ["blank title", (v) => (v.overrides[0].sources[0].title = "  "), /sources\[0\]\.title must be a non-empty string; got "  "\./],
      ["numeric pageType", (v) => (v.overrides[0].sources[0].pageType = 7), /sources\[0\]\.pageType must be a non-empty string; got 7\./],
      ["missing reason", (v) => delete v.overrides[0].sources[0].reason, /sources\[0\]\.reason must be a non-empty string; got undefined\./],
      ["string confidence", (v) => (v.overrides[0].sources[0].confidence = "0.9"), /sources\[0\]\.confidence must be a finite number; got "0\.9"\./],
      ["NaN confidence", (v) => (v.overrides[0].sources[0].confidence = Number.NaN), /sources\[0\]\.confidence must be a finite number; got NaN\./],
      ["Infinity confidence", (v) => (v.overrides[0].sources[0].confidence = Number.POSITIVE_INFINITY), /sources\[0\]\.confidence must be a finite number; got Infinity\./],
      ["object url", (v) => (v.overrides[0].sources[0].url = hostile), /sources\[0\]\.url must be a non-empty string; got an object\./],
      ["missing seed name", (v) => delete v.seeds[0].name, /seeds\[0\]\.name must be a non-empty string; got undefined\./],
      ["object seed starterUrl", (v) => (v.seeds[0].starterUrl = hostile), /seeds\[0\]\.starterUrl must be a non-empty string; got an object\./],
      ["missing overrides", (v) => delete v.overrides, /overrides must be an array\./],
      ["missing seeds", (v) => delete v.seeds, /seeds must be an array\./],
    ];
    for (const [label, install, pattern] of cases) {
      const input = valid();
      install(input);
      expect(messageOf(() => build(input)), label).toMatch(pattern);
    }
    expect(calls).toEqual([]);
  });
});

describe("the module itself", () => {
  it("imports only the shared boundary and the source URL policy, and names no award family in code", () => {
    const source = readFileSync(resolve(import.meta.dirname, "award-source-override-packet-report.mjs"), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["../../src/lib/source-url-policy.ts", "./plain-data-input-boundary.mjs"]);
    expect(source).toContain("export function buildAwardSourceOverridePacketReport");
    expect(source).toContain("export const AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION");
    for (const forbidden of [/shared-awards-core/, /createHash/, /from\s+["'](?:node:)?(?:fs|http|https|net|dns|child_process|worker_threads|tls)["']/, /\bprocess\.env\b/, /\bfetch\s*\(/, /\bnew Date\s*\(/, /\bMath\.random\s*\(/, /localeCompare/]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [/finesst/i, /udall/i, /mitchell/i, /rangel/i, /nasa/i, /pickering/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // Exactly two exports: the builder and its version.
    expect([...source.matchAll(/^export (?:const|function) ([A-Za-z_]+)/gm)].map((match) => match[1]).sort()).toEqual([
      "AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION",
      "buildAwardSourceOverridePacketReport",
    ]);
  });
});
