// Builds a deterministic, review-only, in-memory plan for one explicitly
// allowlisted post-Stage1 candidate award, from the seed catalog and the
// existing source override packet.
//
// This is NOT activation, verification, monitoring, or publication. It never
// says a candidate is ready, official, verified, or active - every lifecycle
// field in the output is pinned to an unresolved/false state; the strongest
// claim the plan makes is that a human hasn't looked at it yet. It never
// widens Stage 1 - the frozen cohort/identity arrives as an explicit input,
// is validated as the EXACT anchored 25 (never an arbitrary subset or
// superset), and is used only to REJECT a candidate that overlaps it, never
// to accept or extend it.
//
// Pure: explicit-input builder/validator. No env, filesystem, Supabase,
// fetch/network, clock, randomness, worker, report/log, or seed/apply/
// publish path. node:crypto's createHash is used only for a deterministic
// digest over already-supplied strings (the same technique
// src/lib/stage1-cohort-identity.ts uses for its own frozen hash), and
// node:util's types.isProxy only inspects a value's kind - neither performs
// I/O nor reads an entropy source.
//
// ACCEPTED INPUT TYPES (exact - everything else fails closed)
//
// Every value reachable from `input` must be one of:
//   - a plain object: an ordinary object whose prototype is exactly
//     Object.prototype or null. Not a class instance, not an exotic object,
//     not a Proxy.
//   - a plain array: an ordinary Array whose prototype is exactly
//     Array.prototype or null, dense (every index in [0, length) is an own
//     property), and not a Proxy.
//   - a primitive: string, finite number, or (for optional fields) absent.
//
// Every field of every object must be an OWN DATA property. Accessors are
// rejected rather than invoked, and inherited properties are invisible: a
// required field supplied only via the prototype chain reads as missing.
//
// Candidates are distinct all the way down. candidateId, normalized
// awardName and slug are each unique across the allowlist, and no
// canonical-equivalent URL - seed/discovery link, homepage, or monitorable
// source - may belong to two candidates. Within a single candidate the same
// URL may legitimately fill several roles.
//
// A rejected value is never executed to describe it. Error messages quote
// primitives exactly (a primitive cannot carry user code) and collapse
// everything else to a fixed type-only phrase, so no toJSON, toString,
// valueOf, Symbol.toPrimitive or Symbol.toStringTag - own, inherited, or
// trapped - ever runs on input this module has decided to reject.
//
// Proxies are rejected everywhere, before any other inspection. A Proxy can
// trap `length`, `getOwnPropertyDescriptor` and `getPrototypeOf`, so it can
// answer every structural question this module asks with a different value
// than it later yields - which defeats the dense-array and exact-count
// guarantees outright (a 26-row Stage 1 array reporting length 25, or a
// two-candidate array reporting length 1, both reproduced against a previous
// revision). No legitimate caller of an offline, pure planner needs one.
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  canonicalSourceUrlKey,
  isInstitutionalDiscoveryUrl,
  isTrackableOfficialSourceUrl,
} from "../../src/lib/source-url-policy.ts";
import { normalizeSharedAwardKey } from "../../src/lib/shared-awards-core.ts";

export const POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA = "post-stage1-expansion-candidates-v1";
export const POST_STAGE1_EXPANSION_PLAN_VERSION = "post-stage1-expansion-plan-v2";

const ALLOWED_CANDIDATE_STATUSES = Object.freeze(["provisional"]);

// Anchors the frozen Stage 1 cohort by cohortKey. This mirrors the same
// technique src/lib/stage1-cohort-identity.ts uses for its own frozen
// snapshot: Stage 1 is closed by policy, so the expected membership is
// pinned here rather than inferred from whatever array a caller happens to
// pass. A caller-supplied stage1Identity missing one of these, or carrying
// an extra one, is a caller defect (a stale copy, a widened/narrowed test
// fixture, an integration bug) and must fail closed rather than be silently
// treated as "the current Stage 1".
const FROZEN_STAGE1_COHORT_KEYS = Object.freeze([
  "rhodes_us", "marshall", "fulbright_us_student", "gates_cambridge", "churchill",
  "schwarzman", "knight_hennessy", "yenching", "luce", "truman",
  "goldwater", "udall_undergraduate", "beinecke", "gilman", "boren",
  "cls", "nsf_grfp", "hertz", "ndseg", "smart",
  "gem", "noaa_hollings", "soros", "samvid", "gaither",
]);

// The cohort keys above pin only WHICH awards are frozen. This digest pins
// WHAT each of them is: the complete canonical identity content every safety
// comparison in this module reads - name, search key, aliases, slug and
// homepage. Without it, a caller could hand over all 25 correct keys while
// silently rewriting Boren's name, aliases, slug or homepage, and every
// overlap check would then dutifully protect the rewritten values instead of
// the real ones (reproduced against the previous revision).
//
// Only semantically empty ordering is normalized away: rows are sorted by
// cohortKey and each row's aliases are sorted, so re-ordering the array or
// the alias list is accepted. Every other difference - any character of any
// field - changes the digest and is rejected.
//
// To regenerate after an intentional, reviewed Stage 1 change:
//   node -e 'import("./scripts/lib/post-stage1-expansion-plan.mjs").then(async (m) => {
//     const { STAGE1_COHORT_DEFINITION } = await import("./scripts/lib/stage1-cohort-readiness.mjs");
//     const { stage1CohortIdentity } = await import("./src/lib/stage1-cohort-identity.ts");
//     const slug = new Map(stage1CohortIdentity.map((r) => [r[1], r[4]]));
//     console.log(m.stage1IdentityContentDigest(STAGE1_COHORT_DEFINITION.map((c) => ({
//       ...c, canonicalSlug: slug.get(c.cohortKey) }))));
//   })'
const FROZEN_STAGE1_IDENTITY_DIGEST = "a6493d81606bd408d6291ef8dc193866168f155de10ee268ccca0efc6d387363";

// Canonical, injective representation of one Stage 1 identity row. JSON
// encoding keeps field boundaries unambiguous, so no field value can be
// crafted to imitate a different field split.
function stage1IdentityRowPayload(row) {
  return JSON.stringify([
    row.cohortKey,
    row.canonicalName,
    row.canonicalSearchKey,
    [...(row.aliasSearchKeys ?? [])].sort(),
    row.canonicalSlug,
    row.officialHomepage,
  ]);
}

export function stage1IdentityContentDigest(rows) {
  const payloads = rows.map(stage1IdentityRowPayload).sort();
  return createHash("sha256").update(payloads.join("\n"), "utf8").digest("hex");
}

// candidateId and cohortKey are identifiers, not free text: TRUE canonical
// lowercase snake_case, matching every real Stage 1 cohortKey (e.g. "boren",
// "nsf_grfp"). Anchored full-string match - a leading/trailing space or any
// uppercase character fails to match at all, so validation and
// normalization are the same step: there is no separate "trim it and
// proceed" path that a whitespace- or case-based bypass could exploit.
//
// Underscores must SEPARATE segments, never lead, trail, or repeat:
// "mitchell_", "_mitchell" and "mitchell__copy" are all non-canonical
// spellings of "mitchell"/"mitchell_copy". Admitting them would let two
// spellings of one identity coexist, so a second entry could sit beside a
// frozen or already-claimed id without ever comparing equal to it.
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
// Slugs are lowercase kebab-case, matching every real Stage 1 canonicalSlug
// (e.g. "james-c-gaither-junior-fellows-program").
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;

function fail(message) {
  throw new Error(`post-stage1 expansion plan: ${message}`);
}

// Describes a REJECTED value for an error message without ever executing it.
//
// Formatting a rejected value is the one place validation hands control back
// to the caller: JSON.stringify looks up `toJSON`, template interpolation and
// String() reach for Symbol.toPrimitive/valueOf/toString, and
// Object.prototype.toString reads Symbol.toStringTag - each of which runs
// caller code on a value this module has just decided it does not trust.
// Against a previous revision a Proxy scalar had its get("toJSON") trap
// invoked, and a plain object with an own toJSON GETTER had that getter read,
// at every scalar validator (canonical identifiers, config schema and status,
// confidence, URLs).
//
// Classification here uses only trap-free operations - `typeof`, a null
// comparison, and util.types.isProxy - and the Proxy check runs before any
// other inspection. Primitives still produce a useful, exact description
// because a primitive cannot carry user code; everything else collapses to a
// fixed type-only phrase and is never touched again.
function describeValue(value) {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string") {
    // Safe: JSON.stringify only consults toJSON for Objects, and a primitive
    // string is not one.
    return JSON.stringify(value);
  }
  if (valueType === "number" || valueType === "boolean" || valueType === "undefined" || valueType === "bigint") {
    return String(value);
  }
  if (valueType === "symbol") return "a symbol";
  if (valueType === "function") return "a function";

  // Object-like from here on: never inspected further, never coerced.
  if (nodeTypes.isProxy(value)) return "a Proxy";
  if (Array.isArray(value)) return "an array";
  return "an object";
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

// Fails closed on anything but an already-canonical identifier: wrong type,
// empty, surrounding whitespace, or any character (including uppercase)
// outside the anchored pattern. There is no silent trim/lowercase fallback -
// a caller must supply the canonical form directly, so a value that only
// LOOKS like a match after normalization (" mitchell ", "MITCHELL") is
// rejected rather than quietly accepted as if it were the canonical value.
function requireCanonicalIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} must be a canonical identifier matching ${pattern}; got ${describeValue(value)}.`);
  }
  return value;
}

// Rejects a Proxy before anything else touches the value. Every structural
// question this module asks - length, own-property descriptors, prototype -
// is trappable, so a Proxy can report one shape while yielding another. This
// runs FIRST, ahead of any reflective or read operation, because by the time
// a trap has answered once the answer can no longer be trusted.
function requireNotProxy(value, label) {
  if (value !== null && (typeof value === "object" || typeof value === "function") && nodeTypes.isProxy(value)) {
    fail(`${label} must not be a Proxy; its traps could report a different shape than it yields.`);
  }
  return value;
}

function requirePlainObject(value, label) {
  requireNotProxy(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  requireNotProxy(value, label);
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

// ---------------------------------------------------------------------------
// Input snapshotting
// ---------------------------------------------------------------------------
//
// Everything below exists because a caller-supplied object is not a value: it
// is code. Reading `record.field` twice can yield two different answers, so a
// field validated on the first read and USED on a later one is a read/read
// TOCTOU. Two such holes were reproduced against the previous revision:
//
//   - a stateful accessor inherited by one stage1Identity row returned decoy
//     identity values while the overlap Sets were being built, then the real
//     frozen values when the content digest re-read them. The digest matched,
//     the Sets were poisoned, and a Boren candidate was admitted.
//   - a candidate `status` getter returned "provisional" while being
//     validated and "ready" when the plan was assembled.
//
// The fix is structural rather than another check: every externally supplied
// field is read EXACTLY ONCE, through its own property descriptor (which
// never invokes an accessor), into an inert plain value. Validation and
// output then both read that snapshot, so there is no second read for an
// accessor to answer differently. Accessors and non-plain prototypes are
// rejected outright rather than snapshotted, since a caller with a legitimate
// reason to hand this module a getter does not exist.

// Rejects anything but a plain record: no accessors can be inherited, because
// there is nothing to inherit from but Object.prototype (or nothing at all).
function requirePlainDataRecord(value, label) {
  requirePlainObject(value, label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object; its prototype is neither Object.prototype nor null, so an inherited accessor could answer for its fields.`);
  }
  return value;
}

// Reads one field exactly once, from an own DATA descriptor. Returns undefined
// for an absent field (callers decide whether that is fatal); throws for an
// accessor, which can never be read a second time safely.
function snapshotOwnField(record, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    fail(`${label}.${key} must be a plain data property, not an accessor.`);
  }
  return descriptor.value;
}

// Snapshots an array element-by-element through own data descriptors. Every
// index in [0, length) must be an own data property: a hole resolves through
// the prototype chain (so an inherited numeric index invisibly supplies an
// element the caller never wrote), and an own accessor could answer
// differently on a later read.
function snapshotDenseArray(value, label) {
  const array = requireArray(value, label);
  const prototype = Object.getPrototypeOf(array);
  if (prototype !== Array.prototype && prototype !== null) {
    fail(`${label} must be a plain array; its prototype is neither Array.prototype nor null.`);
  }
  const elements = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.hasOwn(array, index)) {
      fail(`${label}[${index}] is a hole; ${label} must be a dense array with no inherited or missing indices.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(array, index);
    if (!("value" in descriptor)) {
      fail(`${label}[${index}] must be a plain data property, not an accessor.`);
    }
    elements.push(descriptor.value);
  }
  return elements;
}

// Snapshots a dense array of strings into a fresh array of primitives, which
// is inert by construction.
function snapshotStringArray(value, label) {
  const elements = snapshotDenseArray(value, label);
  return elements.map((element, index) => requireNonEmptyString(element, `${label}[${index}]`));
}

function requireAbsoluteHttpsUrl(value, label) {
  requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail(`${label} must be an absolute HTTPS URL; got ${describeValue(value)}.`);
  }
  if (url.protocol !== "https:") {
    fail(`${label} must be an absolute HTTPS URL; got ${describeValue(value)}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Safety URL equivalence
// ---------------------------------------------------------------------------
//
// The production canonicalizer (canonicalSourceUrlKey) is built for source
// DEDUPLICATION, where preserving a meaningful query is correct. A SAFETY
// comparison - "is this the same page as a frozen Stage 1 homepage?", "is
// this a discovery directory?" - has the opposite bias: it must over-match
// rather than under-match, because every miss silently admits the very URL
// the check exists to reject. Each normalization below closes a bypass
// reproduced against the previous revision:
//
//   www.truman.gov./apply   - a trailing DNS root dot is the same host
//   www.truman.gov/%61pply  - %61 is just "a" (RFC 3986 unreserved)
//   www.truman.gov/apply?ref=x - a query cannot make it a different page
//
// Port and userinfo are dropped for the same reason: neither can turn a
// colliding page into a safe one, and both are trivial to append.
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;

// Decodes ONLY percent-escapes whose character is RFC 3986 "unreserved" (and
// therefore always safe to represent literally), leaving every reserved or
// non-ASCII escape encoded so that decoding can never invent a new path
// separator. Remaining escapes are upper-cased, the RFC's canonical form.
function decodeUnreservedPercentEncoding(text) {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED_CHARACTER.test(character) ? character : escape.toUpperCase();
  });
}

// Rebuilds a URL down to just scheme + host + path, with the normalizations
// above applied. Returns null when the value cannot be parsed at all, which
// every caller treats as fail-closed.
function normalizeSafetyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  return `${url.protocol}//${host}${decodeUnreservedPercentEncoding(url.pathname)}`;
}

// The key two URLs must share to be treated as the same page for safety
// purposes. Layered on top of the production canonicalizer so host/path
// canonicalization (www, index.html, .aspx, trailing slashes) stays
// identical to the rest of the app, with the safety-specific normalizations
// applied first.
function safetyUrlKey(value, label) {
  const normalized = normalizeSafetyUrl(value);
  if (normalized === null) {
    return fail(`${label} ${describeValue(value)} could not be parsed for a safety comparison.`);
  }
  return canonicalSourceUrlKey(normalized);
}

// Institutional-discovery detection with the same normalization applied, so
// "onsa.asu.edu." cannot slip past the production host list. The production
// policy remains the sole authority on WHICH hosts are discovery hosts; both
// the raw and normalized spellings are offered to it.
function isInstitutionalDiscoverySafetyUrl(value) {
  if (isInstitutionalDiscoveryUrl(value)) return true;
  const normalized = normalizeSafetyUrl(value);
  return normalized !== null && isInstitutionalDiscoveryUrl(normalized);
}

// A THIRD URL form, distinct from both the raw spelling and the queryless
// safety key. The safety key deliberately drops the query, so it cannot see a
// tracking parameter at all; the raw spelling carries the query but only in
// whatever encoding the caller chose, so "?%75tm_source=x" walked past the
// literal /utm_/ rule that exists to reject it (reproduced against a previous
// revision, along with encoded fbclid, gclid, replytocom and redirect_to).
//
// This form keeps query semantics intact - delimiters (?, &, =) are reserved
// characters and are never decoded, so parameter structure cannot be forged -
// while decoding RFC 3986 unreserved escapes inside names and values, so a
// parameter spelled in escapes reads as the parameter it actually is. It
// ADDS coverage rather than replacing anything: the literal tracking and
// open-data restrictions still run against the raw spelling as well.
function policyNormalizedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  const rebuilt = `${url.protocol}//${host}` +
    `${decodeUnreservedPercentEncoding(url.pathname)}` +
    `${decodeUnreservedPercentEncoding(url.search)}` +
    `${decodeUnreservedPercentEncoding(url.hash)}`;
  try {
    // Decoding only ever yields unreserved characters, but re-parse anyway so
    // an unparseable result fails closed instead of being handed to policy.
    new URL(rebuilt);
  } catch {
    return null;
  }
  return rebuilt;
}

// The general trackability policy has the same normalization blind spot the
// discovery host list had: it matches hosts and paths literally, so
// "get.adobe.com./reader" or "/%63areers/apply" walked straight past rules
// that exist precisely to reject them (all reproduced against the previous
// revision). The raw check is kept AS A PRECONDITION rather than replaced,
// because the policy also carries query-sensitive rules (tracking parameters,
// open-data listing facets) and the safety normalization deliberately drops
// the query - so the raw form must clear the policy too, and a URL is
// trackable only when BOTH spellings are.
// A URL is trackable only when ALL THREE spellings clear the production
// policy: the raw one (which alone carries the caller's exact query, and so
// alone can be judged by the literal tracking and open-data rules), the
// policy-normalized one (same query semantics, unreserved escapes decoded),
// and the queryless safety one (host/path normalization). Each covers a blind
// spot in the others, and the union of their rejections is what this returns.
function isTrackableOfficialSourceSafetyUrl(value) {
  if (!isTrackableOfficialSourceUrl(value)) return false;

  const policyNormalized = policyNormalizedUrl(value);
  if (policyNormalized === null) return false;
  if (!isTrackableOfficialSourceUrl(policyNormalized)) return false;

  const safetyNormalized = normalizeSafetyUrl(value);
  if (safetyNormalized === null) return false;
  return isTrackableOfficialSourceUrl(safetyNormalized);
}

function requireConfidence(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < CONFIDENCE_MIN || value > CONFIDENCE_MAX) {
    fail(`${label} must be a finite number between ${CONFIDENCE_MIN} and ${CONFIDENCE_MAX}; got ${describeValue(value)}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig(config) {
  requirePlainDataRecord(config, "config");
  // Every field below is snapshotted exactly once before it is examined, and
  // only the snapshot is validated and used afterwards.
  const schema = snapshotOwnField(config, "schema", "config");
  if (schema !== POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA) {
    fail(`config.schema must be "${POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA}"; got ${describeValue(schema)}.`);
  }
  const candidatesRaw = snapshotDenseArray(snapshotOwnField(config, "candidates", "config"), "config.candidates");
  if (candidatesRaw.length === 0) fail("config.candidates must not be empty.");

  const seenCandidateIds = new Set();
  const seenAwardNameKeys = new Set();
  const seenSlugs = new Set();
  const candidates = [];

  for (let index = 0; index < candidatesRaw.length; index += 1) {
    const label = `config.candidates[${index}]`;
    const raw = requirePlainDataRecord(candidatesRaw[index], label);
    const rawCandidateId = snapshotOwnField(raw, "candidateId", label);
    const rawAwardName = snapshotOwnField(raw, "awardName", label);
    const rawStatus = snapshotOwnField(raw, "status", label);
    const rawSlug = snapshotOwnField(raw, "slug", label);

    const candidateId = requireCanonicalIdentifier(rawCandidateId, IDENTIFIER_PATTERN, `${label}.candidateId`);
    const awardName = requireNonEmptyString(rawAwardName, `${label}.awardName`);
    if (!ALLOWED_CANDIDATE_STATUSES.includes(rawStatus)) {
      fail(
        `${label}.status must be one of ${JSON.stringify(ALLOWED_CANDIDATE_STATUSES)}; got ${describeValue(rawStatus)}.`,
      );
    }
    const status = rawStatus;
    const slug = rawSlug === undefined
      ? null
      : requireCanonicalIdentifier(rawSlug, SLUG_PATTERN, `${label}.slug`);

    if (seenCandidateIds.has(candidateId)) {
      fail(`config.candidates has a duplicate candidateId "${candidateId}".`);
    }
    seenCandidateIds.add(candidateId);

    const nameKey = normalizeSharedAwardKey(awardName);
    if (seenAwardNameKeys.has(nameKey)) {
      fail(`config.candidates has a duplicate awardName (normalized key "${nameKey}").`);
    }
    seenAwardNameKeys.add(nameKey);

    // candidateId and normalized awardName were already unique; the slug was
    // not. A slug is a public-facing identity, so two candidates sharing one
    // is the same defect as two sharing an id - it just surfaces later, in
    // whatever consumes the slug. Checked after the safe scalar snapshot and
    // canonical-identifier validation above, so the comparison is between two
    // inert, already-canonical strings. Absent slugs stay absent: null is not
    // an identity and several candidates may legitimately have none.
    if (slug !== null) {
      if (seenSlugs.has(slug)) {
        fail(`config.candidates has a duplicate slug "${slug}".`);
      }
      seenSlugs.add(slug);
    }

    candidates.push({ candidateId, awardName, awardNameKey: nameKey, status, slug });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Stage 1 overlap
// ---------------------------------------------------------------------------

// Snapshots every Stage 1 row into inert plain values, reading each field
// exactly once. Both the overlap Sets and the content digest are then built
// from THIS array, so no accessor can show one identity to the digest and a
// different one to the Sets.
function snapshotStage1Rows(stage1Identity) {
  const rawRows = snapshotDenseArray(stage1Identity, "stage1Identity");
  const rows = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const label = `stage1Identity[${index}]`;
    const raw = requirePlainDataRecord(rawRows[index], label);
    const rawAliases = snapshotOwnField(raw, "aliasSearchKeys", label);
    rows.push({
      cohortKey: snapshotOwnField(raw, "cohortKey", label),
      canonicalName: snapshotOwnField(raw, "canonicalName", label),
      canonicalSearchKey: snapshotOwnField(raw, "canonicalSearchKey", label),
      aliasSearchKeys: rawAliases === undefined ? [] : snapshotStringArray(rawAliases, `${label}.aliasSearchKeys`),
      canonicalSlug: snapshotOwnField(raw, "canonicalSlug", label),
      officialHomepage: snapshotOwnField(raw, "officialHomepage", label),
    });
  }
  return rows;
}

function validateStage1Identity(stage1Identity) {
  const rows = snapshotStage1Rows(stage1Identity);

  // Stage 1 is closed by policy at exactly 25 awards. Anchoring the COUNT
  // first, before any per-row detail, gives the clearest possible failure
  // for the common defect shapes: a caller passing a subset (a filtered or
  // truncated copy) or a superset (a locally widened test fixture, or a
  // future award mistakenly added to the "frozen" list).
  if (rows.length !== FROZEN_STAGE1_COHORT_KEYS.length) {
    fail(
      `stage1Identity must contain exactly the ${FROZEN_STAGE1_COHORT_KEYS.length} frozen Stage 1 cohort entries; got ${rows.length}.`,
    );
  }

  const nameKeys = new Set();
  const cohortKeys = new Set();
  const slugs = new Set();
  const homepageKeys = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cohortKey = requireCanonicalIdentifier(
      row.cohortKey,
      IDENTIFIER_PATTERN,
      `stage1Identity[${index}].cohortKey`,
    );
    const canonicalName = requireNonEmptyString(row.canonicalName, `stage1Identity[${index}].canonicalName`);
    const canonicalSearchKey = requireNonEmptyString(
      row.canonicalSearchKey,
      `stage1Identity[${index}].canonicalSearchKey`,
    );
    const canonicalSlug = requireCanonicalIdentifier(
      row.canonicalSlug,
      SLUG_PATTERN,
      `stage1Identity[${index}].canonicalSlug`,
    );
    const officialHomepage = requireAbsoluteHttpsUrl(
      row.officialHomepage,
      `stage1Identity[${index}].officialHomepage`,
    );
    const aliasSearchKeys = row.aliasSearchKeys;

    if (cohortKeys.has(cohortKey)) {
      fail(`stage1Identity has a duplicate cohortKey "${cohortKey}".`);
    }
    cohortKeys.add(cohortKey);

    nameKeys.add(normalizeSharedAwardKey(canonicalName));
    nameKeys.add(normalizeSharedAwardKey(canonicalSearchKey));
    for (let aliasIndex = 0; aliasIndex < aliasSearchKeys.length; aliasIndex += 1) {
      nameKeys.add(normalizeSharedAwardKey(aliasSearchKeys[aliasIndex]));
    }
    slugs.add(canonicalSlug);
    homepageKeys.add(safetyUrlKey(officialHomepage, `stage1Identity[${index}].officialHomepage`));
  }

  // Not merely the right COUNT: the right MEMBERS. 25 entries where one
  // expected cohortKey is missing and one unexpected one stands in for it
  // would already have passed the count check above.
  for (const expectedCohortKey of FROZEN_STAGE1_COHORT_KEYS) {
    if (!cohortKeys.has(expectedCohortKey)) {
      fail(`stage1Identity is missing the frozen Stage 1 cohort key "${expectedCohortKey}".`);
    }
  }
  for (const actualCohortKey of cohortKeys) {
    if (!FROZEN_STAGE1_COHORT_KEYS.includes(actualCohortKey)) {
      fail(`stage1Identity contains an unrecognized cohort key "${actualCohortKey}" outside the frozen 25.`);
    }
  }

  // Right keys, right count - and now the right CONTENT. Everything above
  // would still pass for 25 correctly-named rows whose names, aliases, slugs
  // or homepages had been rewritten, which is precisely the input that would
  // make every overlap check below protect the wrong values.
  const actualDigest = stage1IdentityContentDigest(rows);
  if (actualDigest !== FROZEN_STAGE1_IDENTITY_DIGEST) {
    fail(
      `stage1Identity content does not match the frozen Stage 1 identity digest ` +
      `(expected ${FROZEN_STAGE1_IDENTITY_DIGEST}, got ${actualDigest}); ` +
      `a canonicalName, canonicalSearchKey, aliasSearchKeys, canonicalSlug or officialHomepage has been altered.`,
    );
  }

  return { nameKeys, cohortKeys, slugs, homepageKeys };
}

function rejectStage1NameOverlap(candidate, stage1) {
  if (stage1.nameKeys.has(candidate.awardNameKey)) {
    fail(`candidate "${candidate.candidateId}" overlaps a frozen Stage 1 canonical/alias name key.`);
  }
  if (stage1.cohortKeys.has(candidate.candidateId)) {
    fail(`candidate "${candidate.candidateId}" overlaps a frozen Stage 1 cohort key.`);
  }
  if (candidate.slug && stage1.slugs.has(candidate.slug)) {
    fail(`candidate "${candidate.candidateId}" overlaps a frozen Stage 1 slug.`);
  }
}

// Every candidate-related URL - the joined seed/discovery URL and every
// declared override source, regardless of the caller-supplied pageType -
// must be independent of every frozen Stage 1 homepage. A source mislabeled
// (or maliciously labeled) as "application" or "other" is exactly as much a
// collision as one labeled "homepage": the pageType is caller-controlled
// data, not evidence, and must never gate which URLs get checked.
function rejectStage1HomepageOverlapForAllUrls(candidate, urls, stage1) {
  for (const url of urls) {
    if (stage1.homepageKeys.has(safetyUrlKey(url, `candidate "${candidate.candidateId}" URL`))) {
      fail(`candidate "${candidate.candidateId}" URL "${url}" overlaps a frozen Stage 1 homepage.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exact seed / override join
// ---------------------------------------------------------------------------

// Shape-validates the WHOLE seed catalog, which in production is all 1,157
// award seeds - almost none of which belong to this build's candidate(s).
// Deliberately does not require HTTPS here: the catalog legitimately
// contains a mix of HTTP and HTTPS starterUrls for OTHER, unrelated awards,
// and this module has no business rejecting the entire input over a row it
// will never join to. HTTPS is required specifically of the JOINED seed,
// once it is known which one that is (see requireAbsoluteHttpsUrl below,
// applied right after the join).
function validateSeeds(seeds) {
  const rows = snapshotDenseArray(seeds, "seeds");
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const label = `seeds[${index}]`;
    const seed = requirePlainDataRecord(rows[index], label);
    const name = requireNonEmptyString(snapshotOwnField(seed, "name", label), `${label}.name`);
    const starterUrl = requireNonEmptyString(snapshotOwnField(seed, "starterUrl", label), `${label}.starterUrl`);
    result.push({ seedIndex: index, name, starterUrl, nameKey: normalizeSharedAwardKey(name) });
  }
  return result;
}

function validateOverrides(overrides) {
  const rows = snapshotDenseArray(overrides, "overrides");
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const overrideLabel = `overrides[${index}]`;
    const override = requirePlainDataRecord(rows[index], overrideLabel);
    const awardName = requireNonEmptyString(snapshotOwnField(override, "awardName", overrideLabel), `${overrideLabel}.awardName`);
    const sourcesRaw = snapshotDenseArray(snapshotOwnField(override, "sources", overrideLabel), `${overrideLabel}.sources`);
    if (sourcesRaw.length === 0) fail(`${overrideLabel}.sources must not be empty.`);

    const sources = [];
    for (let sourceIndex = 0; sourceIndex < sourcesRaw.length; sourceIndex += 1) {
      const label = `${overrideLabel}.sources[${sourceIndex}]`;
      const source = requirePlainDataRecord(sourcesRaw[sourceIndex], label);
      const url = requireNonEmptyString(snapshotOwnField(source, "url", label), `${label}.url`);
      const title = requireNonEmptyString(snapshotOwnField(source, "title", label), `${label}.title`);
      const pageType = requireNonEmptyString(snapshotOwnField(source, "pageType", label), `${label}.pageType`);
      const confidence = requireConfidence(snapshotOwnField(source, "confidence", label), `${label}.confidence`);
      sources.push({ url, title, pageType, confidence });
    }

    result.push({ overrideIndex: index, awardName, nameKey: normalizeSharedAwardKey(awardName), sources });
  }
  return result;
}

function joinExactlyOne(candidate, rows, label) {
  const matches = rows.filter((row) => row.nameKey === candidate.awardNameKey);
  if (matches.length === 0) {
    fail(`candidate "${candidate.candidateId}" matched no ${label} (orphan candidate).`);
  }
  if (matches.length > 1) {
    fail(`candidate "${candidate.candidateId}" matched ${matches.length} ${label} entries (ambiguous join).`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Override source validation
// ---------------------------------------------------------------------------

function validateOverrideSources(candidate, override, joinedSeed) {
  const canonicalKeys = new Set();
  // Dedup uses the production canonicalizer (a meaningful query really does
  // make a different page to track); the seed-leak check below uses the
  // stricter safety key, which ignores query/fragment entirely.
  const safetyKeys = new Set();
  for (const source of override.sources) {
    let url;
    try {
      url = new URL(source.url);
    } catch {
      return fail(`candidate "${candidate.candidateId}" source "${source.url}" is not a parseable URL.`);
    }
    if (url.protocol !== "https:") {
      fail(`candidate "${candidate.candidateId}" source "${source.url}" is not HTTPS.`);
    }
    // A discovery-only URL (a university fellowship directory, say) must
    // never be declared as a monitorable source - it locates a listing, not
    // the award's own page, regardless of what page type it is labeled.
    // Checked before the general trackability test below (which would also
    // reject it, but with a less specific reason) so the actual defect is
    // named precisely.
    if (isInstitutionalDiscoverySafetyUrl(source.url)) {
      fail(`candidate "${candidate.candidateId}" source "${source.url}" is an institutional discovery URL and cannot be monitorable.`);
    }
    if (!isTrackableOfficialSourceSafetyUrl(source.url)) {
      fail(`candidate "${candidate.candidateId}" source "${source.url}" is not a trackable official source URL.`);
    }

    const canonicalKey = canonicalSourceUrlKey(source.url);
    if (canonicalKeys.has(canonicalKey)) {
      fail(`candidate "${candidate.candidateId}" has duplicate canonical source URL "${canonicalKey}".`);
    }
    canonicalKeys.add(canonicalKey);
    safetyKeys.add(safetyUrlKey(source.url, `candidate "${candidate.candidateId}" source`));
  }

  // The joined seed's own starter link, if it happens to be (or coincide
  // with) an institutional discovery URL, must never leak into the
  // monitorable set - checked independently of the per-source check above so
  // a future change to override data cannot silently reintroduce it.
  if (isInstitutionalDiscoverySafetyUrl(joinedSeed.starterUrl)) {
    const seedSafetyKey = safetyUrlKey(joinedSeed.starterUrl, `candidate "${candidate.candidateId}" joined seed starterUrl`);
    if (safetyKeys.has(seedSafetyKey)) {
      fail(`candidate "${candidate.candidateId}" discovery seed URL leaked into monitorable sources.`);
    }
  }

  const homepageSources = override.sources.filter((source) => source.pageType === "homepage");
  if (homepageSources.length === 0) {
    fail(`candidate "${candidate.candidateId}" has no homepage-role source.`);
  }
  if (homepageSources.length > 1) {
    fail(`candidate "${candidate.candidateId}" has ${homepageSources.length} homepage-role sources (must be exactly one).`);
  }
  return homepageSources[0];
}

// No canonical-equivalent URL may identify two different candidates. Within
// ONE candidate the same URL legitimately fills several roles at once - a
// candidate whose single official source IS its homepage is the normal shape,
// and a seed link may also appear among its sources - so identities are
// collapsed per candidate first and only then compared across candidates.
//
// Equivalence is the planner's existing safety semantics rather than raw
// string equality, so the two candidates cannot be separated by spelling: a
// trailing DNS dot, a percent-encoded unreserved character or an appended
// query all resolve to the same identity here, exactly as they do for the
// Stage 1 collision checks (which this leaves entirely intact - it is an
// additional constraint, not a replacement).
//
// Runs over the SORTED plans so the candidate named as the first claimant is
// the lower candidateId regardless of the order the config happened to list
// them in.
function rejectCrossCandidateUrlReuse(plans) {
  const claimedBy = new Map();
  for (const plan of plans) {
    const label = `candidate "${plan.candidateId}"`;
    const identities = new Set();
    // Every candidate-related URL role: the joined seed/discovery link
    // (whether or not it was excluded from monitoring), the resolved
    // homepage, and every monitorable source.
    identities.add(safetyUrlKey(plan.seed.starterUrl, `${label} seed starterUrl`));
    identities.add(safetyUrlKey(plan.homepage.url, `${label} homepage`));
    for (const source of plan.monitorableSources) {
      identities.add(safetyUrlKey(source.url, `${label} monitorable source`));
    }

    for (const identity of identities) {
      const owner = claimedBy.get(identity);
      if (owner !== undefined && owner !== plan.candidateId) {
        fail(
          `URL identity "${identity}" is claimed by both candidate "${owner}" and candidate "${plan.candidateId}"; ` +
          `one URL cannot identify two candidates.`,
        );
      }
      claimedBy.set(identity, plan.candidateId);
    }
  }
}

// ---------------------------------------------------------------------------
// Plan hash
// ---------------------------------------------------------------------------

// A canonical SHA-256 digest of the COMPLETE material returned plan payload,
// excluding only planHash itself. "Material" means every field a change to
// which should be detectable: identity (candidateId/awardName/
// normalizedAwardKey/status/slug), the resolved seed/discovery evidence and
// exclusions, every field of every monitorable source (url/title/pageType/
// confidence/canonicalUrlKey - not just url), and every lifecycle/gate field, plus the
// schema/plan version that governed how all of the above was derived.
// seedIndex is deliberately excluded: it is the seed's position in whatever
// array the caller happened to pass, not a property of the award itself, so
// two builds that differ only in unrelated seeds elsewhere in that array
// must not appear to describe a different plan.
//
// monitorableSources and excludedDiscoveryUrls are semantically unordered
// sets; both are sorted here by a value intrinsic to their own content
// (never by input position) so the hash is invariant to how the caller's
// override.sources array happened to be ordered.
export function computePlanHash(plan) {
  const sortedSources = plan.monitorableSources
    .map((source) => ({
      url: source.url,
      title: source.title,
      pageType: source.pageType,
      confidence: source.confidence,
      // Bound explicitly rather than treated as derivable: canonicalUrlKey is
      // RETURNED material that downstream readers compare on, so a plan whose
      // returned key differs must not present the same identity hash.
      canonicalUrlKey: source.canonicalUrlKey,
    }))
    .sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0));
  const sortedExcludedDiscoveryUrls = [...plan.excludedDiscoveryUrls].sort();

  const material = {
    planVersion: POST_STAGE1_EXPANSION_PLAN_VERSION,
    configSchema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
    candidateId: plan.candidateId,
    awardName: plan.awardName,
    normalizedAwardKey: plan.normalizedAwardKey,
    status: plan.status,
    slug: plan.slug,
    seed: { name: plan.seed.name, starterUrl: plan.seed.starterUrl },
    excludedDiscoveryUrls: sortedExcludedDiscoveryUrls,
    homepage: { url: plan.homepage.url, title: plan.homepage.title, confidence: plan.homepage.confidence },
    monitorableSources: sortedSources,
    lifecycle: {
      currentCycleAuthority: plan.lifecycle.currentCycleAuthority,
      humanSourceReview: plan.lifecycle.humanSourceReview,
      remoteIdentityCollisionCheck: plan.lifecycle.remoteIdentityCollisionCheck,
      monitoringReadiness: plan.lifecycle.monitoringReadiness,
      publicationEligibility: plan.lifecycle.publicationEligibility,
    },
  };
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * @param {{ config: object, seeds: Array, overrides: Array, stage1Identity: Array }} input
 * @returns a deterministic, review-only plan report. Every lifecycle field is
 *          pinned to an unresolved/false state - this never claims a
 *          candidate is ready, official, verified, active, monitorable, or
 *          publishable.
 */
export function buildPostStage1ExpansionPlan(input) {
  // The root object is external input like any other, and was the last place
  // still read directly: `input.config` invokes an own or inherited accessor
  // exactly as a nested field would. It goes through the same boundary, so
  // each root field is read once from an own data descriptor and everything
  // nested is snapshotted from that inert value.
  requirePlainDataRecord(input, "input");
  const rootConfig = snapshotOwnField(input, "config", "input");
  const rootSeeds = snapshotOwnField(input, "seeds", "input");
  const rootOverrides = snapshotOwnField(input, "overrides", "input");
  const rootStage1Identity = snapshotOwnField(input, "stage1Identity", "input");

  const candidates = validateConfig(rootConfig);
  const seeds = validateSeeds(rootSeeds);
  const overrides = validateOverrides(rootOverrides);
  const stage1 = validateStage1Identity(rootStage1Identity);

  const plans = candidates.map((candidate) => {
    rejectStage1NameOverlap(candidate, stage1);

    const joinedSeed = joinExactlyOne(candidate, seeds, "seed");
    // Required of the JOINED seed specifically, not the whole catalog (see
    // validateSeeds above) - this candidate's own evidence must be a real,
    // absolute HTTPS URL regardless of what unrelated seeds elsewhere in the
    // catalog happen to look like.
    requireAbsoluteHttpsUrl(joinedSeed.starterUrl, `candidate "${candidate.candidateId}" joined seed starterUrl`);
    const joinedOverride = joinExactlyOne(candidate, overrides, "override declaration");
    const homepageSource = validateOverrideSources(candidate, joinedOverride, joinedSeed);

    rejectStage1HomepageOverlapForAllUrls(
      candidate,
      [joinedSeed.starterUrl, ...joinedOverride.sources.map((source) => source.url)],
      stage1,
    );

    const monitorableSources = [...joinedOverride.sources]
      .map((source) => ({ ...source, canonicalUrlKey: canonicalSourceUrlKey(source.url) }))
      .sort((left, right) => (left.canonicalUrlKey < right.canonicalUrlKey ? -1 : left.canonicalUrlKey > right.canonicalUrlKey ? 1 : 0));

    const plan = {
      candidateId: candidate.candidateId,
      awardName: candidate.awardName,
      normalizedAwardKey: candidate.awardNameKey,
      status: candidate.status,
      slug: candidate.slug,
      seed: { seedIndex: joinedSeed.seedIndex, name: joinedSeed.name, starterUrl: joinedSeed.starterUrl },
      excludedDiscoveryUrls: isInstitutionalDiscoverySafetyUrl(joinedSeed.starterUrl) ? [joinedSeed.starterUrl] : [],
      homepage: { url: homepageSource.url, title: homepageSource.title, confidence: homepageSource.confidence },
      monitorableSources,
      // Every field below is deliberately pinned, never derived from config
      // or from anything the join produced - this plan is a triage sheet,
      // not a promotion path, and cannot accidentally assert otherwise.
      lifecycle: Object.freeze({
        currentCycleAuthority: "unresolved",
        humanSourceReview: "unresolved",
        remoteIdentityCollisionCheck: "unresolved",
        monitoringReadiness: false,
        publicationEligibility: false,
      }),
      planHash: null,
    };
    plan.planHash = computePlanHash(plan);
    return plan;
  });

  plans.sort((left, right) => (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));

  rejectCrossCandidateUrlReuse(plans);

  return {
    version: POST_STAGE1_EXPANSION_PLAN_VERSION,
    totals: { candidates: plans.length },
    plans,
  };
}
