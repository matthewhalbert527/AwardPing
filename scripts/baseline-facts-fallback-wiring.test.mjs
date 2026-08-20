import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

// Matches the previous-baseline fallback reads. The \b after baseline_facts
// cannot match baseline_facts_metadata because underscore is a word character.
const FACTS_SUMMARY_FALLBACK = /summary_metadata\??\.baseline_facts\b/;
const METADATA_SUMMARY_FALLBACK = /summary_metadata\??\.baseline_facts_metadata\b/;
const FACTS_KEY = /\bbaseline_facts\s*:/;
const METADATA_KEY = /\bbaseline_facts_metadata\s*:/;

function writeBaselineCallSites(source) {
  const marker = "writeBaseline(source, capture, {";
  const sites = [];
  let cursor = source.indexOf(marker);
  while (cursor >= 0) {
    const objectStart = cursor + marker.length - 1;
    let depth = 0;
    let end = source.length;
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
    sites.push(source.slice(objectStart, end));
    cursor = source.indexOf(marker, end);
  }
  return sites;
}

const sites = writeBaselineCallSites(worker);

describe("writeBaseline baseline-facts fallback wiring", () => {
  it("finds the writeBaseline call sites", () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(sites.filter((site) => FACTS_KEY.test(site)).length).toBeGreaterThanOrEqual(4);
  });

  it("never falls back to previous-baseline facts without the matching facts metadata", () => {
    // baseline_facts and baseline_facts_metadata are a pair: the metadata carries
    // the model/provider that page_metadata_model is stamped from. A call site
    // that revives old facts while leaving the metadata null makes AI-off runs
    // (AWARDPING_EXTRACT_BASELINE_INFO=false) publish page_metadata with
    // model=null, which explainSourceAiReviewStatus rejects, permanently
    // skipping the source in every later capture lane.
    for (const site of sites) {
      const fallsBackFacts = FACTS_SUMMARY_FALLBACK.test(site);
      const fallsBackMetadata = METADATA_SUMMARY_FALLBACK.test(site);
      expect(
        fallsBackFacts,
        `asymmetric previous-baseline fallback in writeBaseline call site:\n${site}`,
      ).toBe(fallsBackMetadata);
    }
  });

  it("keeps facts and metadata keys paired at every call site", () => {
    for (const site of sites) {
      expect(
        FACTS_KEY.test(site),
        `baseline_facts and baseline_facts_metadata must be passed together:\n${site}`,
      ).toBe(METADATA_KEY.test(site));
    }
  });

  it("carries previous facts and their metadata through capture-behavior refreshes", () => {
    const refreshSite = sites.find((site) => site.includes('reason: "capture_behavior_refresh"'));
    expect(refreshSite).toBeTruthy();
    expect(refreshSite).toMatch(/baseline_facts:\s*capture\.baseline_facts\s*\|\|/);
    expect(refreshSite).toMatch(FACTS_SUMMARY_FALLBACK);
    expect(refreshSite).toMatch(METADATA_SUMMARY_FALLBACK);
  });
});
