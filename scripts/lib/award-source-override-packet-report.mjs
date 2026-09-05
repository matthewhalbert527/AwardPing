// Builds a deterministic, review-only inventory of every award source
// override packet: what each packet declares, how its sources compare to one
// another and to other packets by URL identity, and which catalog seeds share
// its name literally.
//
// This module DECIDES NOTHING. It never activates, onboards, monitors or
// publishes anything; it never infers an alias or an identity; and it never
// confers eligibility. Every packet is reported with the constant
// relationship "unresolved_pending_human_review" and with all four
// eligibility flags pinned false, including packets that carry no warning at
// all - structural consistency is not identity, and identity is not
// eligibility. A packet whose award name joins no seed literally (the NASA
// FINESST packet is the standing example) stays unjoined here; it is a human
// identity decision, not a report finding.
//
// Structure is described; only a few evidence-backed shapes are warned about,
// each with a stable code. Multiple hosts in one packet, repeated page types
// and comparison keys shared across packets are all DESCRIPTIVE: real,
// reviewed packets legitimately span hosts and repeat page types, and shared
// keys across packets are the alias-pair evidence the identity dossier
// exists to surface, so none of them is a warning.
//
// To print the report for the real catalog:
//
//   node --input-type=module -e 'import("./scripts/lib/award-source-override-packet-report.mjs").then(async (m) => {
//     const { awardSourceOverrides } = await import("./src/lib/award-source-overrides.ts");
//     const { awardSeeds } = await import("./src/lib/award-seeds.ts");
//     console.log(JSON.stringify(m.buildAwardSourceOverridePacketReport({ overrides: awardSourceOverrides, seeds: awardSeeds }), null, 2));
//   })'
//
// DETERMINISM
//
// Two calls on identical input return identical output. Every collection -
// packets, sources, seed matches, duplicate groups, shared groups, warnings -
// is sorted by its complete semantic tuple with explicit code-unit
// comparison, never by input order, never by a delimiter-joined key, and
// never by a name-only or URL-only comparator. Duplicate occurrences are
// preserved; only occurrences that are identical in every semantic field fall
// back to their input positions to break the tie. Input positions appear
// ONLY inside `trace` objects (overrideIndex, sourceIndex, literalSeedIndexes)
// and mean positions in the arrays the caller supplied; strip every `trace`
// and the remaining material output is identical under any reordering of
// overrides, of the sources within an override, and of seeds. The report's
// packetId/sourceId values are positions in the SORTED report, so they are
// material and stable under input reordering too, and they let a shared
// group name a packet/source occurrence unambiguously even when two packets
// share an award name.
//
// URL SAFETY
//
// Every source URL is a validated primitive string before any URL API,
// policy predicate, sort or serialization sees it. It must parse as an
// absolute http(s) URL with a hostname and no credentials; anything else
// fails closed with this module's prefix, because the production
// canonicalizer falls back to raw text for unparseable input (turning
// "javascript:alert(1)" and "data:alert(1)" into the same key) and drops
// ports and credentials. Within that safe set the production canonical key
// is used for comparison, with a non-default port re-attached so two
// services on one host stay two endpoints. http is accepted as a structural
// fact and warned about, never silently upgraded. The policy predicates
// describe the current source policy and nothing more: they do not prove
// ownership, authority, safety, monitorability or eligibility.
//
// NAME JOINS
//
// A seed matches a packet only when the two names are the same text after
// trim, lowercase and internal-whitespace collapse. No alias table, no
// punctuation stripping, no acronym expansion, no fuzzy or Unicode-equivalent
// matching, and no URL-based join. Original names are reported verbatim.
//
// INPUT BOUNDARY
//
// The root, every array, every record and every consumed field crosses the
// shared plain-data boundary once: Proxies (live or revoked) are refused
// without reaching a trap, accessors without being called, exotic prototypes
// and boxed primitives, sparse or augmented arrays, and hidden consumed
// fields all fail closed. Consumed fields are exactly: overrides[i].awardName
// and .sources; sources[j].url/.title/.pageType/.confidence/.reason;
// seeds[k].name/.starterUrl. Any other field on those records is never read
// or copied - the real seed catalog carries many - so it cannot influence the
// output or run code. The output is built entirely from validated primitives
// and fresh containers: nothing references, mutates, spreads or serializes
// an input object.
//
// Pure: explicit-input builder. No env, filesystem, network, clock,
// randomness, worker, database, report/log, or activation path; no exported
// digest and no integrity claim.
import {
  canonicalSourceUrlKey,
  isInstitutionalDiscoveryUrl,
  isTrackableOfficialSourceUrl,
} from "../../src/lib/source-url-policy.ts";
import { createPlainDataInputBoundary, describeValue } from "./plain-data-input-boundary.mjs";

export const AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION = "award-source-override-packet-report-v1";

const RELATIONSHIP_UNRESOLVED = "unresolved_pending_human_review";

function fail(message) {
  throw new Error(`award source override packet report: ${message}`);
}

const { requirePlainDataRecord, snapshotOwnField, snapshotDenseArray, requireNonEmptyString } =
  createPlainDataInputBoundary(fail);

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number; got ${describeValue(value)}.`);
  }
  return value;
}

// Literal text equality only: trim, lowercase, collapse internal whitespace.
function literalNameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function pinnedEligibility() {
  return Object.freeze({
    candidateEligible: false,
    onboardingEligible: false,
    monitoringEligible: false,
    publicationEligible: false,
  });
}

// --------------------------------------------------------------------------
// Ordering: explicit code-unit comparison over complete semantic tuples.
// --------------------------------------------------------------------------
function comparePrimitive(left, right) {
  // Tuple positions always hold one type; strings compare by UTF-16 code
  // unit (the < and > operators), numbers numerically, booleans false first.
  if (typeof left === "string") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "boolean") return left === right ? 0 : left ? 1 : -1;
  return fail(`internal: unsupported tuple element ${describeValue(left)}.`);
}

function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const order = comparePrimitive(left[index], right[index]);
    if (order !== 0) return order;
  }
  return 0;
}

// Element-wise comparison of two lists of tuples, shorter list first on a
// shared prefix.
function compareTupleLists(left, right) {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareTuples(left[index], right[index]);
    if (order !== 0) return order;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function sourceTuple(source) {
  return [
    source.comparisonUrlKey,
    source.url,
    source.title,
    source.pageType,
    source.confidence,
    source.reason,
    source.hostname,
    source.https,
    source.institutionalDiscoveryUrl,
    source.sourceUrlPolicyRejected,
  ];
}

function seedMatchTuple(match) {
  return [match.name, match.starterUrl];
}

function warningTuple(warning) {
  return [
    warning.code,
    warning.url === undefined ? "" : warning.url,
    warning.comparisonUrlKey === undefined ? "" : warning.comparisonUrlKey,
    warning.literalNameKey === undefined ? "" : warning.literalNameKey,
    warning.count === undefined ? -1 : warning.count,
    warning.homepageCount === undefined ? -1 : warning.homepageCount,
  ];
}

function compareSources(left, right) {
  const order = compareTuples(sourceTuple(left), sourceTuple(right));
  if (order !== 0) return order;
  // Fully identical occurrences: input position, trace-only.
  return comparePrimitive(left.trace.sourceIndex, right.trace.sourceIndex);
}

function compareSeedMatches(left, right) {
  const order = compareTuples(seedMatchTuple(left), seedMatchTuple(right));
  if (order !== 0) return order;
  return comparePrimitive(left.seedIndex, right.seedIndex);
}

function comparePackets(left, right) {
  let order = compareTuples([left.literalNameKey, left.awardName], [right.literalNameKey, right.awardName]);
  if (order !== 0) return order;
  order = compareTupleLists(left.sources.map(sourceTuple), right.sources.map(sourceTuple));
  if (order !== 0) return order;
  order = compareTupleLists(left.literalSeedMatches.map(seedMatchTuple), right.literalSeedMatches.map(seedMatchTuple));
  if (order !== 0) return order;
  // Fully identical packets: input position, trace-only.
  return comparePrimitive(left.trace.overrideIndex, right.trace.overrideIndex);
}

function compareWarnings(left, right) {
  return compareTuples(warningTuple(left), warningTuple(right));
}

function countsObject(values) {
  // Keys inserted in code-unit order so the object's own order is content
  // derived; Object.fromEntries defines own data properties only, so a key
  // named __proto__ cannot reach the prototype.
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const entries = [...counts.entries()].sort((left, right) => comparePrimitive(left[0], right[0]));
  return Object.fromEntries(entries);
}

function reportId(prefix, position) {
  return `${prefix}-${String(position + 1).padStart(4, "0")}`;
}

// --------------------------------------------------------------------------
// URL identity (guarded; mirrors the approved dossier's evidence key)
// --------------------------------------------------------------------------
function analyzeSourceUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(`${label} must be an absolute http(s) URL; got ${describeValue(rawUrl)}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`${label} must use the http or https scheme; got ${describeValue(url.protocol)}.`);
  }
  if (url.hostname === "") {
    fail(`${label} must have a hostname; got ${describeValue(rawUrl)}.`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(`${label} must not carry credentials.`);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const canonical = canonicalSourceUrlKey(url.toString());
  // The production key begins with the www-stripped host; if that ever stops
  // being true the port cannot be re-attached safely, so fail rather than
  // emit a key that might mean something else.
  if (typeof canonical !== "string" || !canonical.startsWith(host)) {
    fail(`${label} could not be canonicalized safely for comparison.`);
  }
  // WHATWG URL already drops a default port, so a surviving port is
  // genuinely non-default and is kept in the comparison key.
  const comparisonUrlKey = url.port === "" ? canonical : `${host}:${url.port}${canonical.slice(host.length)}`;
  return {
    hostname: url.hostname,
    https: url.protocol === "https:",
    comparisonUrlKey,
    // Descriptive of the current source policy only.
    institutionalDiscoveryUrl: isInstitutionalDiscoveryUrl(rawUrl) === true,
    sourceUrlPolicyRejected: isTrackableOfficialSourceUrl(rawUrl) !== true,
  };
}

// --------------------------------------------------------------------------
// Snapshots (each consumed field read once through the shared boundary)
// --------------------------------------------------------------------------
function snapshotSource(value, label, sourceIndex) {
  const source = requirePlainDataRecord(value, label);
  const url = requireNonEmptyString(snapshotOwnField(source, "url", label), `${label}.url`);
  const title = requireNonEmptyString(snapshotOwnField(source, "title", label), `${label}.title`);
  const pageType = requireNonEmptyString(snapshotOwnField(source, "pageType", label), `${label}.pageType`);
  const confidence = requireFiniteNumber(snapshotOwnField(source, "confidence", label), `${label}.confidence`);
  const reason = requireNonEmptyString(snapshotOwnField(source, "reason", label), `${label}.reason`);
  const identity = analyzeSourceUrl(url, `${label}.url`);
  return {
    url,
    title,
    pageType,
    confidence,
    reason,
    hostname: identity.hostname,
    comparisonUrlKey: identity.comparisonUrlKey,
    https: identity.https,
    institutionalDiscoveryUrl: identity.institutionalDiscoveryUrl,
    sourceUrlPolicyRejected: identity.sourceUrlPolicyRejected,
    trace: { sourceIndex },
  };
}

function snapshotOverrides(value) {
  const rows = snapshotDenseArray(value, "overrides");
  const overrides = [];
  for (let index = 0; index < rows.length; index += 1) {
    const label = `overrides[${index}]`;
    const record = requirePlainDataRecord(rows[index], label);
    const awardName = requireNonEmptyString(snapshotOwnField(record, "awardName", label), `${label}.awardName`);
    const sourceRows = snapshotDenseArray(snapshotOwnField(record, "sources", label), `${label}.sources`);
    const sources = [];
    for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex += 1) {
      sources.push(snapshotSource(sourceRows[sourceIndex], `${label}.sources[${sourceIndex}]`, sourceIndex));
    }
    sources.sort(compareSources);
    overrides.push({ overrideIndex: index, awardName, literalNameKey: literalNameKey(awardName), sources });
  }
  return overrides;
}

function snapshotSeeds(value) {
  const rows = snapshotDenseArray(value, "seeds");
  const seeds = [];
  for (let index = 0; index < rows.length; index += 1) {
    const label = `seeds[${index}]`;
    const record = requirePlainDataRecord(rows[index], label);
    const name = requireNonEmptyString(snapshotOwnField(record, "name", label), `${label}.name`);
    const starterUrl = requireNonEmptyString(snapshotOwnField(record, "starterUrl", label), `${label}.starterUrl`);
    seeds.push({ seedIndex: index, name, starterUrl, literalNameKey: literalNameKey(name) });
  }
  return seeds;
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------
function buildPacket(override, seedsByLiteralName, literalNameOccurrences) {
  const { sources } = override;
  const matches = (seedsByLiteralName.get(override.literalNameKey) ?? []).slice().sort(compareSeedMatches);
  const literalSeedMatches = matches.map((seed) => ({ name: seed.name, starterUrl: seed.starterUrl }));
  const literalSeedIndexes = matches.map((seed) => seed.seedIndex);

  const homepageCount = sources.filter((source) => source.pageType === "homepage").length;
  const keyCounts = new Map();
  for (const source of sources) keyCounts.set(source.comparisonUrlKey, (keyCounts.get(source.comparisonUrlKey) ?? 0) + 1);

  const warnings = [];
  if (sources.length === 0) warnings.push({ code: "empty_source_packet" });
  if (homepageCount !== 1) warnings.push({ code: "homepage_count_not_one", homepageCount });
  for (const source of sources) {
    if (!source.https) warnings.push({ code: "source_not_https", url: source.url });
    if (source.institutionalDiscoveryUrl) warnings.push({ code: "source_institutional_discovery_url", url: source.url });
    if (source.sourceUrlPolicyRejected) warnings.push({ code: "source_url_policy_rejected", url: source.url });
  }
  for (const [comparisonUrlKey, count] of keyCounts) {
    if (count > 1) warnings.push({ code: "duplicate_source_comparison_url", comparisonUrlKey, count });
  }
  if (matches.length === 0) warnings.push({ code: "no_literal_seed_match" });
  if (matches.length > 1) warnings.push({ code: "multiple_literal_seed_matches", count: matches.length });
  const nameOccurrences = literalNameOccurrences.get(override.literalNameKey);
  if (nameOccurrences > 1) {
    warnings.push({ code: "duplicate_override_literal_name", literalNameKey: override.literalNameKey, count: nameOccurrences });
  }
  warnings.sort(compareWarnings);

  return {
    packetId: null,
    awardName: override.awardName,
    literalNameKey: override.literalNameKey,
    sourceCount: sources.length,
    hostnameCounts: countsObject(sources.map((source) => source.hostname)),
    pageTypeCounts: countsObject(sources.map((source) => source.pageType)),
    homepageCount,
    comparisonUrlKeyCount: keyCounts.size,
    duplicateComparisonUrlGroups: [],
    literalSeedMatches,
    sources,
    warnings,
    relationship: RELATIONSHIP_UNRESOLVED,
    eligibility: pinnedEligibility(),
    trace: { overrideIndex: override.overrideIndex, literalSeedIndexes },
  };
}

/**
 * @param {{ overrides: Array, seeds: Array }} input
 * @returns a deterministic, review-only inventory of every override packet.
 *          Every relationship is "unresolved_pending_human_review" and every
 *          eligibility flag is false; nothing here activates, joins by alias,
 *          or confers eligibility.
 */
export function buildAwardSourceOverridePacketReport(input) {
  requirePlainDataRecord(input, "input");
  const overrides = snapshotOverrides(snapshotOwnField(input, "overrides", "input"));
  const seeds = snapshotSeeds(snapshotOwnField(input, "seeds", "input"));

  const seedsByLiteralName = new Map();
  for (const seed of seeds) {
    if (!seedsByLiteralName.has(seed.literalNameKey)) seedsByLiteralName.set(seed.literalNameKey, []);
    seedsByLiteralName.get(seed.literalNameKey).push(seed);
  }
  const literalNameOccurrences = new Map();
  for (const override of overrides) {
    literalNameOccurrences.set(override.literalNameKey, (literalNameOccurrences.get(override.literalNameKey) ?? 0) + 1);
  }

  const packets = overrides.map((override) => buildPacket(override, seedsByLiteralName, literalNameOccurrences));
  packets.sort(comparePackets);

  // Report ids are positions in the sorted report: content-derived, so they
  // are material and let shared groups name occurrences unambiguously.
  const occurrencesByKey = new Map();
  const allKeys = new Set();
  packets.forEach((packet, packetPosition) => {
    packet.packetId = reportId("packet", packetPosition);
    const sourceIdsByKey = new Map();
    packet.sources.forEach((source, sourcePosition) => {
      source.sourceId = `${packet.packetId}-source-${String(sourcePosition + 1).padStart(4, "0")}`;
      allKeys.add(source.comparisonUrlKey);
      if (!sourceIdsByKey.has(source.comparisonUrlKey)) sourceIdsByKey.set(source.comparisonUrlKey, []);
      sourceIdsByKey.get(source.comparisonUrlKey).push(source.sourceId);
      if (!occurrencesByKey.has(source.comparisonUrlKey)) occurrencesByKey.set(source.comparisonUrlKey, []);
      occurrencesByKey.get(source.comparisonUrlKey).push({
        packetId: packet.packetId,
        awardName: packet.awardName,
        sourceId: source.sourceId,
        url: source.url,
      });
    });
    packet.duplicateComparisonUrlGroups = [...sourceIdsByKey.entries()]
      .filter(([, sourceIds]) => sourceIds.length > 1)
      .map(([comparisonUrlKey, sourceIds]) => ({ comparisonUrlKey, count: sourceIds.length, sourceIds }))
      .sort((left, right) => comparePrimitive(left.comparisonUrlKey, right.comparisonUrlKey));
  });

  const sharedComparisonUrlGroups = [...occurrencesByKey.entries()]
    .filter(([, members]) => new Set(members.map((member) => member.packetId)).size > 1)
    .map(([comparisonUrlKey, members]) => ({
      comparisonUrlKey,
      packetCount: new Set(members.map((member) => member.packetId)).size,
      sourceCount: members.length,
      members: members
        .slice()
        .sort((left, right) => compareTuples([left.packetId, left.sourceId], [right.packetId, right.sourceId])),
    }))
    .sort((left, right) => comparePrimitive(left.comparisonUrlKey, right.comparisonUrlKey));

  // Sources are emitted with sourceId first, then the declared fields.
  for (const packet of packets) {
    packet.sources = packet.sources.map((source) => ({
      sourceId: source.sourceId,
      url: source.url,
      title: source.title,
      pageType: source.pageType,
      confidence: source.confidence,
      reason: source.reason,
      hostname: source.hostname,
      comparisonUrlKey: source.comparisonUrlKey,
      https: source.https,
      institutionalDiscoveryUrl: source.institutionalDiscoveryUrl,
      sourceUrlPolicyRejected: source.sourceUrlPolicyRejected,
      trace: { sourceIndex: source.trace.sourceIndex },
    }));
  }

  const sourceTotal = packets.reduce((total, packet) => total + packet.sourceCount, 0);
  const warningTotal = packets.reduce((total, packet) => total + packet.warnings.length, 0);
  return {
    version: AWARD_SOURCE_OVERRIDE_PACKET_REPORT_VERSION,
    totals: {
      packets: packets.length,
      sources: sourceTotal,
      comparisonUrlKeys: allKeys.size,
      seeds: seeds.length,
      singleSourcePackets: packets.filter((packet) => packet.sourceCount === 1).length,
      multiSourcePackets: packets.filter((packet) => packet.sourceCount > 1).length,
      packetsWithWarnings: packets.filter((packet) => packet.warnings.length > 0).length,
      warnings: warningTotal,
      sharedComparisonUrlGroups: sharedComparisonUrlGroups.length,
    },
    packets,
    sharedComparisonUrlGroups,
    relationship: RELATIONSHIP_UNRESOLVED,
    eligibility: pinnedEligibility(),
  };
}
