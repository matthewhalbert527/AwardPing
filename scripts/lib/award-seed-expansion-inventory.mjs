// Offline quality inventory over the award seed catalog.
//
// This module answers exactly one question: for each seed already sitting in
// the catalog, what would have to be true before a human could even consider
// looking at it? It is a triage sheet, not a promotion path.
//
// What it deliberately is NOT:
//   - It never says a seed is ready, official, verified, active, monitorable,
//     or publishable. Those are Stage 1 concepts and Stage 1 stays frozen at
//     its exact 25 awards. Seed presence is discovery inventory and nothing
//     more: every disposition below describes a REASON TO WAIT, or, at best,
//     the absence of any known reason to reject.
//   - It never activates, crawls, seeds, publishes, or migrates anything. The
//     API is pure: arrays in, a plain report out. No env, no Supabase, no
//     filesystem, no network, no worker, no CLI side effects.
//   - It never merges or de-duplicates awards. Where several seeds resolve to
//     one canonical URL, all of them are quarantined and reported together;
//     picking a winner is a human judgement about award identity, and guessing
//     wrong silently welds two different awards into one.
//
// Classification reuses the SAME production normalization the rest of the app
// uses for source URLs and award names, rather than a private copy that could
// drift from it.
import {
  canonicalSourceUrlKey,
  isClearlyNonAwardSourceUrl,
  isInstitutionalDiscoveryUrl,
} from "../../src/lib/source-url-policy.ts";
import { normalizeSharedAwardKey } from "../../src/lib/shared-awards-core.ts";

export const AWARD_SEED_EXPANSION_INVENTORY_VERSION = "award-seed-expansion-inventory-v1";

// The complete, closed set. Every input index gets exactly one of these.
export const AWARD_SEED_EXPANSION_DISPOSITIONS = Object.freeze([
  // Already one of the frozen Stage 1 awards, reached by its canonical or
  // alias name key. Nothing to consider: it is not an expansion candidate.
  "stage1_existing",
  // The starter link points at an institutional discovery host - a
  // university's fellowship directory - so it locates a listing, not the
  // award's own page. The award may well be real; this row simply carries no
  // usable link to it.
  "directory_only",
  // Several seeds collapse onto one canonical URL, or the URL is a frozen
  // Stage 1 award's homepage. Either way the link does not identify one
  // distinct award, so the whole group is quarantined for a human.
  "identity_collision",
  // Not HTTPS.
  "needs_https",
  // The URL shape is one the existing source policy already rejects for award
  // sources (careers pages, search listings, assets, and so on).
  "url_shape_rejected",
  // No known reason to reject - and no evidence of anything either. This is
  // the weakest possible statement: an HTTPS link, distinct from other seeds,
  // that a human has not looked at. It is a queue, not an endorsement.
  "unverified_https_candidate",
]);

const DISPOSITION_SET = new Set(AWARD_SEED_EXPANSION_DISPOSITIONS);

/**
 * The catalog's own name-matching rule. This directly delegates to the real
 * production normalizer (src/lib/shared-awards-core.ts) rather than keeping a
 * second, driftable copy of it - a seed named with an alias production
 * already canonicalizes (e.g. "NSF Graduate Research Fellowship") is
 * recognized here exactly because this IS that normalizer, not a lookalike.
 */
export function normalizeAwardSeedNameKey(name) {
  return normalizeSharedAwardKey(String(name));
}

function fail(message) {
  throw new Error(`award seed expansion inventory: ${message}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Parses a seed URL, failing closed rather than guessing. A seed whose link
 * cannot even be parsed is a data defect that must be seen, not silently
 * bucketed into a disposition that reads like a considered verdict.
 */
function parseSeedUrl(rawUrl, seedIndex) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return fail(`seed ${seedIndex} has an unparseable starterUrl.`);
  }
  return parsed;
}

function validateSeeds(seeds) {
  if (!Array.isArray(seeds)) fail("seeds must be an array.");

  return seeds.map((seed, index) => {
    if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
      fail(`seed ${index} must be an object.`);
    }
    // Callers may pass rows that already carry their catalog position. When
    // they do, it has to agree with the array - a duplicated, missing, or
    // reordered index means the caller's view of the catalog and this
    // inventory's view have diverged, and every downstream index would be
    // quietly wrong.
    if (seed.seedIndex !== undefined) {
      if (!Number.isInteger(seed.seedIndex)) {
        fail(`seed ${index} has a non-integer seedIndex.`);
      }
      if (seed.seedIndex !== index) {
        fail(`seed ${index} declares seedIndex ${seed.seedIndex}; indices must match array position exactly.`);
      }
    }
    requireNonEmptyString(seed.name, `seed ${index} name`);
    requireNonEmptyString(seed.starterUrl, `seed ${index} starterUrl`);

    return {
      seedIndex: index,
      name: seed.name,
      starterUrl: seed.starterUrl,
      url: parseSeedUrl(seed.starterUrl, index),
    };
  });
}

/**
 * Parses a Stage 1 homepage as an absolute http(s) URL, failing closed rather
 * than letting canonicalSourceUrlKey's own parse-failure fallback (a plain
 * lowercased string, not a real canonical key) silently stand in for one. A
 * malformed or unsupported-scheme Stage 1 homepage is a data defect in the
 * frozen cohort itself and must never be treated as ordinary URL noise.
 */
function requireAbsoluteHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail(`${label} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${label} must be an absolute http(s) URL.`);
  }
  return url;
}

function validateStage1Cohort(stage1Cohort) {
  if (!Array.isArray(stage1Cohort) || stage1Cohort.length === 0) {
    fail("stage1Cohort must be a non-empty array.");
  }

  const nameKeyToCohortKey = new Map();
  const homepageKeyToCohortKey = new Map();
  const seenCohortKeys = new Set();

  // Indexed by position rather than .forEach: forEach silently SKIPS holes in
  // a sparse array, which would let a missing cohort entry through unnoticed
  // instead of failing closed. Direct indexing reads a hole as `undefined`,
  // which the object check below correctly rejects.
  for (let index = 0; index < stage1Cohort.length; index += 1) {
    const entry = stage1Cohort[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`stage1Cohort ${index} must be an object.`);
    }
    const cohortKey = requireNonEmptyString(entry.cohortKey, `stage1Cohort ${index} cohortKey`);
    // Two entries sharing one cohortKey would make every "which frozen award
    // is this" question order-dependent (whichever is processed last wins).
    if (seenCohortKeys.has(cohortKey)) {
      fail(`stage1Cohort cohortKey "${cohortKey}" is declared more than once.`);
    }
    seenCohortKeys.add(cohortKey);

    const canonicalSearchKey = requireNonEmptyString(
      entry.canonicalSearchKey,
      `stage1Cohort ${index} canonicalSearchKey`,
    );
    const homepage = requireNonEmptyString(
      entry.officialHomepage,
      `stage1Cohort ${index} officialHomepage`,
    );
    requireAbsoluteHttpUrl(homepage, `stage1Cohort ${index} officialHomepage`);

    const aliasSearchKeys = entry.aliasSearchKeys === undefined ? [] : entry.aliasSearchKeys;
    if (!Array.isArray(aliasSearchKeys)) {
      fail(`stage1Cohort ${index} aliasSearchKeys must be an array when present.`);
    }

    // Spreading aliasSearchKeys (rather than iterating the raw array with
    // for-of or forEach) turns any hole into an explicit `undefined` element,
    // so a sparse alias array fails the non-empty-string check below instead
    // of silently contributing fewer keys than it appears to declare.
    const allNameKeys = [canonicalSearchKey, ...aliasSearchKeys];
    for (let keyIndex = 0; keyIndex < allNameKeys.length; keyIndex += 1) {
      const key = normalizeAwardSeedNameKey(
        requireNonEmptyString(allNameKeys[keyIndex], `stage1Cohort ${index} alias key ${keyIndex}`),
      );
      const existingCohortKey = nameKeyToCohortKey.get(key);
      // Two frozen awards claiming one name key would make the match order
      // decide identity. Refuse rather than pick.
      if (existingCohortKey && existingCohortKey !== cohortKey) {
        fail(`stage1Cohort name key "${key}" is claimed by both ${existingCohortKey} and ${cohortKey}.`);
      }
      nameKeyToCohortKey.set(key, cohortKey);
    }

    const homepageKey = canonicalSourceUrlKey(homepage);
    const existingHomepageCohortKey = homepageKeyToCohortKey.get(homepageKey);
    // A canonical-equivalent homepage shared by two DIFFERENT frozen cohorts
    // would otherwise silently let whichever entry is processed last own the
    // attribution (last-write-wins) - making a real seed's reported
    // collision cohort depend on stage1Cohort's own input order. Refusing
    // here throws regardless of which of the two entries happens to be
    // processed second, so no reordering of stage1Cohort can ever change, or
    // even silently choose, which cohort a shared homepage is attributed to.
    if (existingHomepageCohortKey && existingHomepageCohortKey !== cohortKey) {
      fail(
        `stage1Cohort officialHomepage canonical key "${homepageKey}" is claimed by both ${existingHomepageCohortKey} and ${cohortKey}.`,
      );
    }
    homepageKeyToCohortKey.set(homepageKey, cohortKey);
  }

  return { nameKeyToCohortKey, homepageKeyToCohortKey };
}

/**
 * Builds the inventory.
 *
 * @param {{ seeds: Array<{name: string, starterUrl: string, seedIndex?: number}>,
 *           stage1Cohort: Array<{cohortKey: string, canonicalSearchKey: string,
 *                                officialHomepage: string, aliasSearchKeys?: string[]}> }} input
 * @returns a report whose `rows` hold exactly one disposition per input index,
 *          ordered by seedIndex, plus quarantined collision groups and totals.
 */
export function buildAwardSeedExpansionInventory(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object with seeds and stage1Cohort.");
  }

  const seeds = validateSeeds(input.seeds);
  const { nameKeyToCohortKey, homepageKeyToCohortKey } = validateStage1Cohort(input.stage1Cohort);

  const rows = seeds.map((seed) => ({
    seedIndex: seed.seedIndex,
    name: seed.name,
    starterUrl: seed.starterUrl,
    canonicalUrlKey: canonicalSourceUrlKey(seed.starterUrl),
    disposition: null,
    reason: null,
    stage1CohortKey: null,
    collisionGroupKey: null,
    collisionSeedIndexes: [],
  }));

  const assign = (row, disposition, reason) => {
    if (!DISPOSITION_SET.has(disposition)) fail(`unknown disposition "${disposition}".`);
    if (row.disposition !== null) fail(`seed ${row.seedIndex} was classified twice.`);
    row.disposition = disposition;
    row.reason = reason;
  };

  // Precedence runs strictly most-conservative first. Each pass only looks at
  // rows no earlier pass has claimed, so the order below IS the contract: a
  // frozen Stage 1 alias stays stage1_existing even when its link is HTTP, and
  // a directory link stays directory_only even when hundreds of seeds share
  // its host - that is expected of a directory, not an identity collision.

  // 1. Already frozen into Stage 1, by canonical or alias name key.
  for (const row of rows) {
    const cohortKey = nameKeyToCohortKey.get(normalizeAwardSeedNameKey(row.name));
    if (!cohortKey) continue;
    row.stage1CohortKey = cohortKey;
    assign(row, "stage1_existing", `Name key matches frozen Stage 1 cohort "${cohortKey}".`);
  }

  // 2. Institutional discovery hosts: the link locates a directory listing.
  for (const row of rows) {
    if (row.disposition) continue;
    if (!isInstitutionalDiscoveryUrl(row.starterUrl)) continue;
    assign(row, "directory_only", "Starter link resolves to an institutional discovery directory host.");
  }

  // 3. Canonical-URL collisions, grouped and quarantined whole. Two shapes
  //    count: several remaining seeds sharing one canonical URL, and a seed
  //    landing on a frozen Stage 1 homepage (a cross-identity collision, which
  //    is a collision even at group size one).
  const byCanonicalUrl = new Map();
  for (const row of rows) {
    if (row.disposition) continue;
    const members = byCanonicalUrl.get(row.canonicalUrlKey);
    if (members) members.push(row);
    else byCanonicalUrl.set(row.canonicalUrlKey, [row]);
  }

  const collisionGroups = [];
  for (const [canonicalUrlKey, members] of byCanonicalUrl) {
    const stage1CohortKey = homepageKeyToCohortKey.get(canonicalUrlKey) || null;
    if (members.length < 2 && !stage1CohortKey) continue;

    const seedIndexes = members.map((row) => row.seedIndex);
    for (const row of members) {
      row.collisionGroupKey = canonicalUrlKey;
      row.collisionSeedIndexes = [...seedIndexes];
      row.stage1CohortKey = stage1CohortKey;
      assign(
        row,
        "identity_collision",
        stage1CohortKey
          ? `Canonical URL is the frozen Stage 1 homepage for cohort "${stage1CohortKey}".`
          : `Canonical URL is shared by ${members.length} seeds; the link does not identify one distinct award.`,
      );
    }
    collisionGroups.push({
      canonicalUrlKey,
      seedIndexes,
      stage1CohortKey,
      // Quarantine only. Nothing here is merged, de-duplicated, or ranked.
      resolution: "quarantined_for_human_review",
    });
  }

  // 4. Not HTTPS.
  for (const row of rows) {
    if (row.disposition) continue;
    if (new URL(row.starterUrl).protocol === "https:") continue;
    assign(row, "needs_https", "Starter link is not HTTPS.");
  }

  // 5. Shapes the existing source policy already rejects for award sources.
  for (const row of rows) {
    if (row.disposition) continue;
    if (!isClearlyNonAwardSourceUrl(row.starterUrl)) continue;
    assign(row, "url_shape_rejected", "Starter link shape is rejected by the existing source URL policy.");
  }

  // 6. Everything left. No known reason to reject, and nothing examined.
  for (const row of rows) {
    if (row.disposition) continue;
    assign(row, "unverified_https_candidate", "No known rejection reason; no human has examined this seed.");
  }

  const byDisposition = {};
  for (const disposition of AWARD_SEED_EXPANSION_DISPOSITIONS) byDisposition[disposition] = 0;
  for (const row of rows) {
    if (row.disposition === null) fail(`seed ${row.seedIndex} was left unclassified.`);
    byDisposition[row.disposition] += 1;
  }

  const accountedFor = Object.values(byDisposition).reduce((sum, count) => sum + count, 0);
  if (accountedFor !== rows.length) {
    fail(`accounting mismatch: ${accountedFor} dispositions for ${rows.length} seeds.`);
  }

  collisionGroups.sort((left, right) => left.seedIndexes[0] - right.seedIndexes[0]);

  return {
    version: AWARD_SEED_EXPANSION_INVENTORY_VERSION,
    totals: { seeds: rows.length, byDisposition },
    // Ordered by seedIndex, which is the input's own position - grouping never
    // reorders the report.
    rows,
    collisionGroups,
  };
}
