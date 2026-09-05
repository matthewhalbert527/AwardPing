// Builds a deterministic, review-only dossier of the collision evidence
// around one ambiguous award identity.
//
// This module ANSWERS NOTHING. It does not decide whether two records name
// the same award, does not alias, merge, or pick a canonical name, and does
// not make anything eligible for anything. It gathers the records that
// already exist in the catalog, records the mechanical links between them
// exactly as observed, and states - as data - which question a human still
// has to answer. Every relationship it reports is "unresolved", and both
// eligibility flags are pinned false.
//
// It is deliberately generic. Nothing here knows about any particular award
// family: the caller supplies lexical terms and the module reports what the
// catalog contains. The Rangel family is the proving regression, not a
// hardcoded answer.
//
// Three evidence classes, and the difference between them is the point:
//
//   exact name  - two records carry the SAME normalized award name. Strong
//                 mechanical evidence, still not proof: two programs can
//                 share a name in a catalog that was never de-duplicated.
//   URL link    - two records point at the SAME canonical URL. When those
//                 records carry different names, that is an identity
//                 collision by definition: one page cannot be the official
//                 page of two different awards, so either the names are
//                 aliases or one of the URLs is wrong.
//   lexical     - a record merely mentions the probe's terms. This is the
//                 weakest class and carries NO implied relationship at all.
//                 A record that appears only here is nearby text and nothing
//                 more; it is neither a sibling nor an alias until a human
//                 says so.
//
// Two deliberate conservatism choices, both of which cost recall:
//
//   - name equality is LITERAL text equality (trim/lowercase/collapse
//     whitespace only). The app's alias-aware normalizer is not used here,
//     because its alias table encodes identity decisions this module exists
//     to leave open.
//   - evidence URLs must be absolute, credential-free http(s) URLs with a
//     hostname, and a non-default port is kept in the identity key. Unsafe
//     or unparseable URLs fail closed instead of being given a key.
//
// A record lands in a link group only through an observed identical value.
// Nothing is grouped by resemblance, shared prefix, or shared host, so a
// record whose name and URL are both unique stays on its own - which is how
// a possible sibling program stays separated from the family without this
// module having to guess that it is one.
//
// Pure: explicit-input builder. No env, filesystem, Supabase, fetch/network,
// clock, randomness, worker, report/log, or seed/apply/publish path.
// node:crypto's createHash produces a deterministic digest over already
// supplied strings; node:util's types.isProxy only inspects a value's kind.
//
// ACCEPTED INPUT TYPES (exact - everything else fails closed)
//
// Plain objects (prototype exactly Object.prototype or null), plain dense
// arrays (prototype exactly Array.prototype or null, every index an own
// property, own keys exactly `length` plus the canonical indices), and
// primitives. Every accessed field or index must be an OWN, ENUMERABLE DATA
// property: accessors are rejected rather than invoked, inherited properties
// are invisible, hidden fields are rejected because JSON would omit them, and
// Proxies are rejected before any other inspection. A rejected value is never
// executed to describe it.
//
// NOTE ON THE INPUT BOUNDARY: the structural boundary - Proxy-first
// rejection, plain prototypes only, own enumerable data descriptors read
// exactly once, dense arrays with an exact own-key set, inert diagnostics -
// is shared with post-stage1-expansion-plan.mjs through
// plain-data-input-boundary.mjs. This module keeps only its own failure
// prefix; every message after the prefix is produced by the shared
// implementation, and the parity test in this module's suite drives the same
// adversarial inputs through both consumers so they cannot drift.
import { createHash } from "node:crypto";

import { canonicalSourceUrlKey, isInstitutionalDiscoveryUrl } from "../../src/lib/source-url-policy.ts";
import { createPlainDataInputBoundary, describeValue } from "./plain-data-input-boundary.mjs";

export const AWARD_IDENTITY_COLLISION_DOSSIER_VERSION = "award-identity-collision-dossier-v1";

// The only relationship verdict this module can ever emit.
export const IDENTITY_RELATIONSHIP_UNRESOLVED = "unresolved_pending_human_review";

// The evidence classes, weakest last. Exported so a consumer can branch on
// them without re-deriving the vocabulary.
export const IDENTITY_EVIDENCE_CLASSES = Object.freeze([
  "exact_name_link",
  "url_link",
  "lexical_nearby_only",
]);

const PROBE_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

// Deliberately NOT the app's normalizeSharedAwardKey. That function carries
// an alias table - a set of identity decisions somebody already made - and
// this module exists precisely because such decisions have not been made
// for the family under review. Folding two literally different names into
// one key would manufacture an `exact_name_link` out of a prior judgement
// rather than observed text, and would also erase probe matches: a record
// literally named "National Science Foundation ..." can be rewritten to an
// "nsf ..." key, so a probe for the spelled-out term stops finding it. Both
// were reproduced against the previous revision.
//
// So the only normalization here is the mechanical, reversible-in-meaning
// kind: trim, lowercase, collapse internal whitespace. Two names are "the
// same" only when their literal text is the same. If alias-derived
// information is ever surfaced by this module, it must arrive as its own
// separately labeled unresolved signal - never as exact-name evidence.
function literalNameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function fail(message) {
  throw new Error(`award identity collision dossier: ${message}`);
}

// --------------------------------------------------------------------------
// Input boundary (shared)
// --------------------------------------------------------------------------
//
// The structural boundary lives in plain-data-input-boundary.mjs and is
// shared with post-stage1-expansion-plan.mjs; see that module's header for
// the exact accepted-input contract. This module supplies only `fail`, so
// every message keeps this module's prefix while the text after it is
// produced once, for both consumers.
const {
  requirePlainDataRecord,
  snapshotOwnField,
  snapshotDenseArray,
  snapshotStringArray,
  requireNonEmptyString,
} = createPlainDataInputBoundary(fail);

// --------------------------------------------------------------------------
// Probe / catalog validation
// --------------------------------------------------------------------------
function validateProbe(probe) {
  requirePlainDataRecord(probe, "probe");
  const rawProbeId = snapshotOwnField(probe, "probeId", "probe");
  if (typeof rawProbeId !== "string" || !PROBE_ID_PATTERN.test(rawProbeId)) {
    fail(`probe.probeId must be a canonical identifier matching ${PROBE_ID_PATTERN}; got ${describeValue(rawProbeId)}.`);
  }

  const rawTerms = snapshotDenseArray(snapshotOwnField(probe, "lexicalTerms", "probe"), "probe.lexicalTerms");
  if (rawTerms.length === 0) fail("probe.lexicalTerms must not be empty.");

  const seen = new Set();
  const lexicalTerms = [];
  for (let index = 0; index < rawTerms.length; index += 1) {
    const term = requireNonEmptyString(rawTerms[index], `probe.lexicalTerms[${index}]`);
    // Terms are matched against normalized (lowercased) names, so a term
    // carrying uppercase would silently never match. Reject rather than
    // quietly lowercase it.
    if (term !== term.toLowerCase() || term !== term.trim()) {
      fail(`probe.lexicalTerms[${index}] must already be lowercase and trimmed; got ${describeValue(term)}.`);
    }
    if (seen.has(term)) fail(`probe.lexicalTerms has a duplicate term ${describeValue(term)}.`);
    seen.add(term);
    lexicalTerms.push(term);
  }
  // Sorted so the probe's own term order cannot change the dossier.
  lexicalTerms.sort();
  return { probeId: rawProbeId, lexicalTerms };
}

function snapshotSeeds(seeds) {
  const rows = snapshotDenseArray(seeds, "seeds");
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const label = `seeds[${index}]`;
    const seed = requirePlainDataRecord(rows[index], label);
    result.push({
      seedIndex: index,
      name: requireNonEmptyString(snapshotOwnField(seed, "name", label), `${label}.name`),
      starterUrl: requireNonEmptyString(snapshotOwnField(seed, "starterUrl", label), `${label}.starterUrl`),
    });
  }
  return result;
}

function snapshotOverrides(overrides) {
  const rows = snapshotDenseArray(overrides, "overrides");
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const overrideLabel = `overrides[${index}]`;
    const override = requirePlainDataRecord(rows[index], overrideLabel);
    const awardName = requireNonEmptyString(
      snapshotOwnField(override, "awardName", overrideLabel),
      `${overrideLabel}.awardName`,
    );
    const rawSources = snapshotDenseArray(
      snapshotOwnField(override, "sources", overrideLabel),
      `${overrideLabel}.sources`,
    );
    const sources = [];
    for (let sourceIndex = 0; sourceIndex < rawSources.length; sourceIndex += 1) {
      const label = `${overrideLabel}.sources[${sourceIndex}]`;
      const source = requirePlainDataRecord(rawSources[sourceIndex], label);
      sources.push({
        sourceIndex,
        url: requireNonEmptyString(snapshotOwnField(source, "url", label), `${label}.url`),
        pageType: requireNonEmptyString(snapshotOwnField(source, "pageType", label), `${label}.pageType`),
      });
    }
    result.push({ overrideIndex: index, awardName, sources });
  }
  return result;
}

// --------------------------------------------------------------------------
// Evidence URL identity
// --------------------------------------------------------------------------
//
// An evidence URL is only allowed to be an absolute, credential-free http(s)
// URL with a hostname. Anything else fails closed rather than being given an
// identity key, because the app's canonical key falls back to raw lowercased
// text when a value will not parse - which silently turned
// "javascript:alert(1)" and "data:alert(1)" into the SAME key "alert(1)" and
// grouped them as one shared URL, across two different schemes (reproduced
// against the previous revision).
//
// A non-default port is preserved in the key. Two services on one host are
// two endpoints, and collapsing :8443 into the default origin invents an
// equivalence the catalog never asserted (also reproduced).
//
// Within that safe set the conservative canonical equivalence of the rest of
// the app is retained, so ordinary spelling variants of one page still land
// on one key. That is an EQUIVALENCE OF SPELLING, not a claim that the page
// is correct, current, or eligible for anything.
function evidenceUrlKey(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(`${label} must be an absolute http(s) URL; got ${describeValue(rawUrl)}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(`${label} must use the http or https scheme; got ${describeValue(url.protocol)}.`);
  }
  if (url.hostname === "") {
    return fail(`${label} must have a hostname; got ${describeValue(rawUrl)}.`);
  }
  if (url.username !== "" || url.password !== "") {
    return fail(`${label} must not carry credentials.`);
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const canonical = canonicalSourceUrlKey(url.toString());
  // The app's canonical key begins with the www-stripped lowercased host.
  // If that ever stops being true the port cannot be reinserted safely, so
  // fail rather than emit a key that might mean something else.
  if (!canonical.startsWith(host)) {
    return fail(`${label} could not be canonicalized safely for evidence comparison.`);
  }
  // WHATWG URL already drops a default port, so a surviving port is
  // genuinely non-default.
  return url.port === "" ? canonical : `${host}:${url.port}${canonical.slice(host.length)}`;
}

// --------------------------------------------------------------------------
// Dossier
// --------------------------------------------------------------------------
function matchesAnyTerm(nameKey, lexicalTerms) {
  for (const term of lexicalTerms) {
    if (nameKey.includes(term)) return true;
  }
  return false;
}

// Stable, content-derived ordering.
//
// Compared field by field rather than by joining fields into one string. A
// delimiter-joined key is ambiguous whenever an accepted value can contain
// the delimiter, so two different records can produce one key; and the
// previous key omitted pageType entirely, so two sources differing only in
// page type tied, and reversing them swapped their record ids and changed
// the content hash (reproduced against the previous revision).
//
// The tuple therefore carries every returned field that the content hash
// binds, and nothing else: trace-only catalog positions and the derived
// recordId are excluded, because those are what re-ordering the input is
// expected to move.
function recordSemanticTuple(record) {
  return [
    record.recordKind,
    record.name,
    record.nameKey,
    record.url,
    record.urlKey,
    record.institutionalDiscoveryUrl ? "1" : "0",
    // Presence is compared before value so an absent pageType can never be
    // confused with any present one, whatever it contains.
    record.pageType === undefined ? "0" : "1",
    record.pageType === undefined ? "" : record.pageType,
  ];
}

// Trace positions, used ONLY to break a tie between records whose semantic
// content is byte-for-byte identical. Such records are interchangeable by
// construction - swapping them changes no evidence and no hash - but the
// ordering still has to be total, so it falls back to where they sit.
function recordTraceTuple(record) {
  return [
    record.seedIndex === undefined ? -1 : record.seedIndex,
    record.overrideIndex === undefined ? -1 : record.overrideIndex,
    record.sourceIndex === undefined ? -1 : record.sourceIndex,
  ];
}

function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function compareRecords(left, right) {
  const semantic = compareTuples(recordSemanticTuple(left), recordSemanticTuple(right));
  if (semantic !== 0) return semantic;
  return compareTuples(recordTraceTuple(left), recordTraceTuple(right));
}

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

/**
 * @param {{ probe: {probeId: string, lexicalTerms: string[]},
 *           seeds: Array, overrides: Array }} input
 * @returns a deterministic, review-only dossier. Every relationship is
 *          unresolved and both eligibility flags are false.
 */
export function buildAwardIdentityCollisionDossier(input) {
  requirePlainDataRecord(input, "input");
  const probe = validateProbe(snapshotOwnField(input, "probe", "input"));
  const seeds = snapshotSeeds(snapshotOwnField(input, "seeds", "input"));
  const overrides = snapshotOverrides(snapshotOwnField(input, "overrides", "input"));

  const records = [];

  for (const seed of seeds) {
    const nameKey = literalNameKey(seed.name);
    if (!matchesAnyTerm(nameKey, probe.lexicalTerms)) continue;
    records.push({
      recordKind: "seed",
      // The exact record as it stands in the catalog, so a reviewer can go
      // straight to it. Positions are traceability, not identity - they are
      // deliberately excluded from the content hash below.
      seedIndex: seed.seedIndex,
      name: seed.name,
      nameKey,
      url: seed.starterUrl,
      urlKey: evidenceUrlKey(seed.starterUrl, `seeds[${seed.seedIndex}].starterUrl`),
      // Recorded because a discovery link locates a listing rather than an
      // award page, which changes how much weight a human should give it.
      institutionalDiscoveryUrl: isInstitutionalDiscoveryUrl(seed.starterUrl),
    });
  }

  for (const override of overrides) {
    const nameKey = literalNameKey(override.awardName);
    if (!matchesAnyTerm(nameKey, probe.lexicalTerms)) continue;
    for (const source of override.sources) {
      records.push({
        recordKind: "override_source",
        overrideIndex: override.overrideIndex,
        sourceIndex: source.sourceIndex,
        name: override.awardName,
        nameKey,
        url: source.url,
        urlKey: evidenceUrlKey(source.url, `overrides[${override.overrideIndex}].sources[${source.sourceIndex}].url`),
        pageType: source.pageType,
        institutionalDiscoveryUrl: isInstitutionalDiscoveryUrl(source.url),
      });
    }
  }

  records.sort(compareRecords);
  // recordId is assigned from the sorted, content-derived order, so it is
  // stable regardless of how the catalog arrays were ordered.
  records.forEach((record, index) => {
    record.recordId = `${probe.probeId}-${String(index + 1).padStart(3, "0")}`;
  });

  const linkedRecordIds = new Set();

  // Exact-name links: two or more records carrying one normalized name.
  const exactNameLinks = [];
  for (const [nameKey, members] of groupBy(records, (record) => record.nameKey)) {
    if (members.length < 2) continue;
    for (const member of members) linkedRecordIds.add(member.recordId);
    exactNameLinks.push({
      evidenceClass: "exact_name_link",
      nameKey,
      recordIds: members.map((member) => member.recordId).sort(),
      recordKinds: [...new Set(members.map((member) => member.recordKind))].sort(),
      relationship: IDENTITY_RELATIONSHIP_UNRESOLVED,
    });
  }
  exactNameLinks.sort((left, right) => (left.nameKey < right.nameKey ? -1 : left.nameKey > right.nameKey ? 1 : 0));

  // URL links: two or more records pointing at one canonical URL. The count
  // of DISTINCT names on that URL is reported rather than interpreted: one
  // name is a duplicate declaration, several is an identity collision.
  const urlLinks = [];
  for (const [urlKey, members] of groupBy(records, (record) => record.urlKey)) {
    if (members.length < 2) continue;
    for (const member of members) linkedRecordIds.add(member.recordId);
    const distinctNameKeys = [...new Set(members.map((member) => member.nameKey))].sort();
    urlLinks.push({
      evidenceClass: "url_link",
      urlKey,
      recordIds: members.map((member) => member.recordId).sort(),
      distinctNameKeys,
      distinctNameKeyCount: distinctNameKeys.length,
      relationship: IDENTITY_RELATIONSHIP_UNRESOLVED,
    });
  }
  urlLinks.sort((left, right) => (left.urlKey < right.urlKey ? -1 : left.urlKey > right.urlKey ? 1 : 0));

  // Everything the terms caught that no observed link connects to anything.
  // Membership here asserts nothing beyond "the words appear".
  const lexicalNearbyOnly = records
    .filter((record) => !linkedRecordIds.has(record.recordId))
    .map((record) => ({
      evidenceClass: "lexical_nearby_only",
      recordId: record.recordId,
      nameKey: record.nameKey,
      urlKey: record.urlKey,
      relationship: IDENTITY_RELATIONSHIP_UNRESOLVED,
    }));

  // Derived, then re-checked against the collections they summarize, so a
  // total can never drift from the evidence it claims to count. They are
  // bound into the content hash below as well.
  const totals = {
    records: records.length,
    exactNameLinks: exactNameLinks.length,
    urlLinks: urlLinks.length,
    lexicalNearbyOnly: lexicalNearbyOnly.length,
  };
  if (
    totals.records !== records.length ||
    totals.exactNameLinks !== exactNameLinks.length ||
    totals.urlLinks !== urlLinks.length ||
    totals.lexicalNearbyOnly !== lexicalNearbyOnly.length
  ) {
    fail("totals do not match the collections they summarize.");
  }

  const dossier = {
    version: AWARD_IDENTITY_COLLISION_DOSSIER_VERSION,
    probeId: probe.probeId,
    lexicalTerms: probe.lexicalTerms,
    totals,
    records,
    exactNameLinks,
    urlLinks,
    lexicalNearbyOnly,
    // The single verdict, and the single question. Both are constants: no
    // input can move them, so no caller can read this dossier as a decision.
    relationship: IDENTITY_RELATIONSHIP_UNRESOLVED,
    humanDecisionRequired:
      "A human must decide, for each linked group below, whether the records name one award under " +
      "different names, separate sibling awards of one program, or unrelated awards; and if one award, " +
      "which name and URL are canonical. Until that decision is recorded, no record here may be aliased, " +
      "merged, renamed, onboarded, or monitored.",
    // Pinned, never derived. A dossier is evidence for a decision, not the
    // decision, so nothing it contains can make anything eligible.
    eligibility: Object.freeze({
      candidateEligible: false,
      onboardingEligible: false,
      monitoringEligible: false,
      publicationEligible: false,
    }),
    dossierHash: null,
  };
  dossier.dossierHash = computeDossierHash(dossier);
  return dossier;
}

// --------------------------------------------------------------------------
// The exported digest, and its own input boundary
// --------------------------------------------------------------------------
//
// computeDossierHash is exported, so it must survive a caller who hands it a
// graph built specifically to make a tampered dossier digest as an untampered
// one. The previous revision read the caller's graph directly and passed the
// caller's own link arrays to JSON.stringify, which was enough to forge a
// hash: clone a valid dossier, set urlLinks[0].relationship to "resolved",
// give that group an own toJSON returning the original group, and the digest
// came back byte-identical to the original. Direct getters, Proxy traps,
// overridden sort/map and custom iterators all executed too, and a revoked
// Proxy escaped as a raw TypeError rather than a fail-closed rejection.
//
// The helper therefore treats its argument exactly the way the builder treats
// catalog input: Proxy rejected before any reflective operation, own data
// descriptors only, accessors rejected rather than invoked, dense arrays, and
// inert diagnostics. It also refuses any own field outside the known dossier
// shape - an unrecognized property is precisely where a toJSON, a valueOf or
// a Symbol.toPrimitive would sit, and it would otherwise ride along unhashed.
//
// Nothing the caller supplied is ever serialized. Every value below is copied
// out through a descriptor, checked to be the primitive the shape calls for,
// and placed into a fresh graph this function owns, so by the time
// JSON.stringify runs there is no caller object left for it to call a hook on.
//
// The result: a changed material field either changes the digest or fails
// closed on an invariant. It is never masked.

// The complete known shape. Anything else is a hook, not a field.
const DOSSIER_OWN_FIELDS = new Set([
  "version",
  "probeId",
  "lexicalTerms",
  "totals",
  "records",
  "exactNameLinks",
  "urlLinks",
  "lexicalNearbyOnly",
  "relationship",
  "humanDecisionRequired",
  "eligibility",
  "dossierHash",
]);
const TOTALS_OWN_FIELDS = new Set(["records", "exactNameLinks", "urlLinks", "lexicalNearbyOnly"]);
const ELIGIBILITY_OWN_FIELDS = new Set([
  "candidateEligible",
  "onboardingEligible",
  "monitoringEligible",
  "publicationEligible",
]);
const RECORD_OWN_FIELDS = new Set([
  "recordId",
  "recordKind",
  "seedIndex",
  "overrideIndex",
  "sourceIndex",
  "name",
  "nameKey",
  "url",
  "urlKey",
  "pageType",
  "institutionalDiscoveryUrl",
]);
const EXACT_NAME_LINK_OWN_FIELDS = new Set([
  "evidenceClass",
  "nameKey",
  "recordIds",
  "recordKinds",
  "relationship",
]);
const URL_LINK_OWN_FIELDS = new Set([
  "evidenceClass",
  "urlKey",
  "recordIds",
  "distinctNameKeys",
  "distinctNameKeyCount",
  "relationship",
]);
const LEXICAL_GROUP_OWN_FIELDS = new Set([
  "evidenceClass",
  "recordId",
  "nameKey",
  "urlKey",
  "relationship",
]);

// The value is already known not to be a Proxy, so neither call below can
// reach a trap. Symbols are reported by count rather than rendered, because
// rendering one would run Symbol.prototype.toString.
function requireKnownOwnFields(record, label, known) {
  if (Object.getOwnPropertySymbols(record).length > 0) {
    fail(`${label} must not carry symbol-keyed own properties; the digest cannot cover them.`);
  }
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!known.has(key)) {
      fail(
        `${label} carries an unrecognized own field ${JSON.stringify(key)}; the digest must account for the whole ` +
          `dossier, so an unknown property fails closed rather than going unhashed.`,
      );
    }
  }
  return record;
}

function snapshotShape(value, label, known) {
  return requireKnownOwnFields(requirePlainDataRecord(value, label), label, known);
}

function requireBooleanField(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean; got ${describeValue(value)}.`);
  }
  return value;
}

function requireCountField(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer; got ${describeValue(value)}.`);
  }
  return value;
}

function snapshotShapeList(value, label, snapshotOne) {
  const rows = snapshotDenseArray(value, label);
  const list = [];
  for (let index = 0; index < rows.length; index += 1) {
    list.push(snapshotOne(rows[index], `${label}[${index}]`));
  }
  return list;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Key insertion order below is the digest's field order; it is part of the
// serialization, so it is fixed deliberately rather than incidentally.
function snapshotMaterialRecord(value, label) {
  const record = snapshotShape(value, label, RECORD_OWN_FIELDS);
  const recordKind = requireNonEmptyString(snapshotOwnField(record, "recordKind", label), `${label}.recordKind`);
  if (recordKind !== "seed" && recordKind !== "override_source") {
    fail(`${label}.recordKind must be "seed" or "override_source"; got ${describeValue(recordKind)}.`);
  }
  // Catalog positions are validated when present and then dropped. They are
  // where a record currently sits, not what it is, so re-ordering an
  // unrelated part of the catalog must not look like the evidence changed.
  for (const positionKey of ["seedIndex", "overrideIndex", "sourceIndex"]) {
    const position = snapshotOwnField(record, positionKey, label);
    if (position !== undefined) requireCountField(position, `${label}.${positionKey}`);
  }
  const pageType = snapshotOwnField(record, "pageType", label);
  return {
    recordId: requireNonEmptyString(snapshotOwnField(record, "recordId", label), `${label}.recordId`),
    recordKind,
    name: requireNonEmptyString(snapshotOwnField(record, "name", label), `${label}.name`),
    nameKey: requireNonEmptyString(snapshotOwnField(record, "nameKey", label), `${label}.nameKey`),
    url: requireNonEmptyString(snapshotOwnField(record, "url", label), `${label}.url`),
    urlKey: requireNonEmptyString(snapshotOwnField(record, "urlKey", label), `${label}.urlKey`),
    institutionalDiscoveryUrl: requireBooleanField(
      snapshotOwnField(record, "institutionalDiscoveryUrl", label),
      `${label}.institutionalDiscoveryUrl`,
    ),
    pageType: pageType === undefined ? null : requireNonEmptyString(pageType, `${label}.pageType`),
  };
}

function snapshotExactNameLink(value, label) {
  const group = snapshotShape(value, label, EXACT_NAME_LINK_OWN_FIELDS);
  return {
    evidenceClass: requireNonEmptyString(snapshotOwnField(group, "evidenceClass", label), `${label}.evidenceClass`),
    nameKey: requireNonEmptyString(snapshotOwnField(group, "nameKey", label), `${label}.nameKey`),
    recordIds: snapshotStringArray(snapshotOwnField(group, "recordIds", label), `${label}.recordIds`),
    recordKinds: snapshotStringArray(snapshotOwnField(group, "recordKinds", label), `${label}.recordKinds`),
    relationship: requireNonEmptyString(snapshotOwnField(group, "relationship", label), `${label}.relationship`),
  };
}

function snapshotUrlLink(value, label) {
  const group = snapshotShape(value, label, URL_LINK_OWN_FIELDS);
  return {
    evidenceClass: requireNonEmptyString(snapshotOwnField(group, "evidenceClass", label), `${label}.evidenceClass`),
    urlKey: requireNonEmptyString(snapshotOwnField(group, "urlKey", label), `${label}.urlKey`),
    recordIds: snapshotStringArray(snapshotOwnField(group, "recordIds", label), `${label}.recordIds`),
    distinctNameKeys: snapshotStringArray(
      snapshotOwnField(group, "distinctNameKeys", label),
      `${label}.distinctNameKeys`,
    ),
    distinctNameKeyCount: requireCountField(
      snapshotOwnField(group, "distinctNameKeyCount", label),
      `${label}.distinctNameKeyCount`,
    ),
    relationship: requireNonEmptyString(snapshotOwnField(group, "relationship", label), `${label}.relationship`),
  };
}

function snapshotLexicalGroup(value, label) {
  const group = snapshotShape(value, label, LEXICAL_GROUP_OWN_FIELDS);
  return {
    evidenceClass: requireNonEmptyString(snapshotOwnField(group, "evidenceClass", label), `${label}.evidenceClass`),
    recordId: requireNonEmptyString(snapshotOwnField(group, "recordId", label), `${label}.recordId`),
    nameKey: requireNonEmptyString(snapshotOwnField(group, "nameKey", label), `${label}.nameKey`),
    urlKey: requireNonEmptyString(snapshotOwnField(group, "urlKey", label), `${label}.urlKey`),
    relationship: requireNonEmptyString(snapshotOwnField(group, "relationship", label), `${label}.relationship`),
  };
}

// A canonical digest over the complete material dossier, excluding only the
// hash itself. Catalog POSITIONS (seedIndex/overrideIndex/sourceIndex) are
// excluded deliberately, for the reason given in snapshotMaterialRecord.
// Everything that carries meaning - names, normalized keys, URLs, canonical
// URL keys, discovery flags, page types, every total, every link group, the
// verdict, the question, and the eligibility flags - is bound.
export function computeDossierHash(dossier) {
  const source = snapshotShape(dossier, "dossier", DOSSIER_OWN_FIELDS);

  // Checked but not hashed: this field is the digest's own output, so binding
  // it would make the digest depend on itself. Absent is accepted because the
  // builder hashes a dossier before the field is filled in.
  const presentedHash = snapshotOwnField(source, "dossierHash", "dossier");
  if (presentedHash !== undefined && presentedHash !== null && typeof presentedHash !== "string") {
    fail(`dossier.dossierHash must be null or a string; got ${describeValue(presentedHash)}.`);
  }

  const totals = snapshotShape(snapshotOwnField(source, "totals", "dossier"), "dossier.totals", TOTALS_OWN_FIELDS);
  const eligibility = snapshotShape(
    snapshotOwnField(source, "eligibility", "dossier"),
    "dossier.eligibility",
    ELIGIBILITY_OWN_FIELDS,
  );

  const material = {
    version: requireNonEmptyString(snapshotOwnField(source, "version", "dossier"), "dossier.version"),
    probeId: requireNonEmptyString(snapshotOwnField(source, "probeId", "dossier"), "dossier.probeId"),
    // Sorted on a list this function owns. Probe term order is how the caller
    // happened to write the query, not evidence, so it must not move the
    // digest - and the sort must not be the caller's.
    lexicalTerms: snapshotStringArray(
      snapshotOwnField(source, "lexicalTerms", "dossier"),
      "dossier.lexicalTerms",
    ).sort(compareStrings),
    totals: {
      records: requireCountField(snapshotOwnField(totals, "records", "dossier.totals"), "dossier.totals.records"),
      exactNameLinks: requireCountField(
        snapshotOwnField(totals, "exactNameLinks", "dossier.totals"),
        "dossier.totals.exactNameLinks",
      ),
      urlLinks: requireCountField(snapshotOwnField(totals, "urlLinks", "dossier.totals"), "dossier.totals.urlLinks"),
      lexicalNearbyOnly: requireCountField(
        snapshotOwnField(totals, "lexicalNearbyOnly", "dossier.totals"),
        "dossier.totals.lexicalNearbyOnly",
      ),
    },
    // Hashed in the order given rather than re-sorted here: the builder
    // already emits records in its own content-derived order, so re-sorting
    // would only serve to hide a caller's re-ordering.
    records: snapshotShapeList(snapshotOwnField(source, "records", "dossier"), "dossier.records", snapshotMaterialRecord),
    exactNameLinks: snapshotShapeList(
      snapshotOwnField(source, "exactNameLinks", "dossier"),
      "dossier.exactNameLinks",
      snapshotExactNameLink,
    ),
    urlLinks: snapshotShapeList(snapshotOwnField(source, "urlLinks", "dossier"), "dossier.urlLinks", snapshotUrlLink),
    lexicalNearbyOnly: snapshotShapeList(
      snapshotOwnField(source, "lexicalNearbyOnly", "dossier"),
      "dossier.lexicalNearbyOnly",
      snapshotLexicalGroup,
    ),
    relationship: requireNonEmptyString(snapshotOwnField(source, "relationship", "dossier"), "dossier.relationship"),
    humanDecisionRequired: requireNonEmptyString(
      snapshotOwnField(source, "humanDecisionRequired", "dossier"),
      "dossier.humanDecisionRequired",
    ),
    eligibility: {
      candidateEligible: requireBooleanField(
        snapshotOwnField(eligibility, "candidateEligible", "dossier.eligibility"),
        "dossier.eligibility.candidateEligible",
      ),
      onboardingEligible: requireBooleanField(
        snapshotOwnField(eligibility, "onboardingEligible", "dossier.eligibility"),
        "dossier.eligibility.onboardingEligible",
      ),
      monitoringEligible: requireBooleanField(
        snapshotOwnField(eligibility, "monitoringEligible", "dossier.eligibility"),
        "dossier.eligibility.monitoringEligible",
      ),
      publicationEligible: requireBooleanField(
        snapshotOwnField(eligibility, "publicationEligible", "dossier.eligibility"),
        "dossier.eligibility.publicationEligible",
      ),
    },
  };
  // Every leaf above is a string, number, boolean or null, and every
  // container is one this function built, so JSON.stringify has no caller
  // object to invoke a replacer hook on.
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}
