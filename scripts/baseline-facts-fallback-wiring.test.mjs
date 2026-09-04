import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

// Every direct baseline write passes an object literal to
// writeBaseline(source, capture, {...}). The wrapper near the bottom of the
// worker forwards a `details` variable instead and is deliberately not a
// call site here.
const CALL_SITE_MARKER = "writeBaseline(source, capture, {";

// Structural floors for the current worker. They catch a marker rename or an
// extraction failure that would otherwise make the pairing checks vacuous.
const MIN_CALL_SITES = 11;
const MIN_FACTS_BEARING_CALL_SITES = 8;

// Previous-baseline fallback reads. The \b after baseline_facts cannot match
// baseline_facts_metadata because underscore is a word character.
const FACTS_SUMMARY_FALLBACK = /summary_metadata\??\.baseline_facts\b/;
const METADATA_SUMMARY_FALLBACK = /summary_metadata\??\.baseline_facts_metadata\b/;
const FACTS_KEY = /\bbaseline_facts\s*:/;
const METADATA_KEY = /\bbaseline_facts_metadata\s*:/;

// Exact precedence for the capture-behavior refresh: the fresh capture wins,
// then the retained baseline's copy, then null. Facts and their metadata
// must follow the same order so a revived fact set never loses its model.
const REFRESH_FACTS_PRECEDENCE =
  /\bbaseline_facts:\s*capture\.baseline_facts\s*\|\|\s*baseline\.summary_metadata\?\.baseline_facts\s*\|\|\s*null\b/;
const REFRESH_METADATA_PRECEDENCE =
  /\bbaseline_facts_metadata:\s*capture\.baseline_facts_metadata\s*\|\|\s*baseline\.summary_metadata\?\.baseline_facts_metadata\s*\|\|\s*null\b/;

function writeBaselineCallSites(source) {
  const sites = [];
  let cursor = source.indexOf(CALL_SITE_MARKER);
  while (cursor >= 0) {
    const objectStart = cursor + CALL_SITE_MARKER.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = objectStart; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error("Unterminated writeBaseline details object.");
    sites.push({
      line: source.slice(0, cursor).split("\n").length,
      text: source.slice(objectStart, end),
    });
    cursor = source.indexOf(CALL_SITE_MARKER, end);
  }
  return sites;
}

const sites = writeBaselineCallSites(worker);

function describeSite(site) {
  return `writeBaseline call site at line ${site.line}:\n${site.text}`;
}

describe("writeBaseline baseline-facts fallback wiring", () => {
  it("enumerates the current direct writeBaseline call sites", () => {
    expect(sites.length).toBeGreaterThanOrEqual(MIN_CALL_SITES);
    const factsBearing = sites.filter((site) => FACTS_KEY.test(site.text));
    expect(factsBearing.length).toBeGreaterThanOrEqual(MIN_FACTS_BEARING_CALL_SITES);
    for (const site of sites) {
      expect(site.text.startsWith("{"), describeSite(site)).toBe(true);
      expect(site.text.endsWith("}"), describeSite(site)).toBe(true);
    }
  });

  it("never falls back to previous-baseline facts without the matching facts metadata", () => {
    // baseline_facts and baseline_facts_metadata are a pair: the metadata carries
    // the model/provider that page_metadata_model is stamped from. A call site
    // that revives old facts while leaving the metadata null makes AI-off runs
    // (AWARDPING_EXTRACT_BASELINE_INFO=false) publish page_metadata with
    // model=null, which explainSourceAiReviewStatus rejects, permanently
    // skipping the source in every later capture lane.
    for (const site of sites) {
      expect(
        FACTS_SUMMARY_FALLBACK.test(site.text),
        `asymmetric previous-baseline fallback in ${describeSite(site)}`,
      ).toBe(METADATA_SUMMARY_FALLBACK.test(site.text));
    }
  });

  it("keeps facts and metadata keys paired at every call site", () => {
    for (const site of sites) {
      expect(
        FACTS_KEY.test(site.text),
        `baseline_facts and baseline_facts_metadata must be passed together in ${describeSite(site)}`,
      ).toBe(METADATA_KEY.test(site.text));
    }
  });

  it("carries previous facts and their metadata through capture-behavior refreshes", () => {
    const refreshSites = sites.filter((site) => (
      site.text.includes('reason: "capture_behavior_refresh"')
    ));
    expect(refreshSites.length).toBeGreaterThanOrEqual(1);
    for (const site of refreshSites) {
      expect(site.text, describeSite(site)).toMatch(REFRESH_FACTS_PRECEDENCE);
      expect(site.text, describeSite(site)).toMatch(REFRESH_METADATA_PRECEDENCE);
    }
  });
});
