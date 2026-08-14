import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const V7_POLICY_PREIMAGE =
  "legacy-r2-pointer-v7:exact-selector-and-bucket:case-sensitive-url:head-get-verify:all-artifact-raw-bindings:layout-and-expansion-binding:canonical-retained-projection:legacy-raw-meta-projection-provenance:conservative-legacy-v0-expansion-coverage:nested-v1-required-for-complete:captures-only:immutable-copy:destination-if-absent:cas-keys-plus-narrow-derived-metadata:preserve-legacy:no-live-fetch:no-events:no-paid-api";

export const legacyRetainedProjectionProvenanceSchema =
  "awardping.legacy-retained-artifact-projection-provenance.v1";

// This identity is immutable recovery authority for v7-produced provenance.
// A future migration policy must add a separately accepted identity rather
// than changing this object and stranding already repaired generations.
export const legacyR2PointerV7Policy = Object.freeze({
  id: "awardping-legacy-r2-snapshot-pointer-migration",
  version: "7",
  hash: sha256Text(V7_POLICY_PREIMAGE),
});

export function buildLegacyRetainedProjectionProvenance({
  rawMetaSha256,
  projectionSha256,
} = {}) {
  const rawHash = exactSha256(rawMetaSha256, "raw metadata");
  const projectionHash = exactSha256(projectionSha256, "retained projection");
  return {
    schema: legacyRetainedProjectionProvenanceSchema,
    policy_id: legacyR2PointerV7Policy.id,
    policy_version: legacyR2PointerV7Policy.version,
    policy_hash: legacyR2PointerV7Policy.hash,
    derived_from: "verified_immutable_r2_manifest",
    raw_meta_projection_present: false,
    raw_meta_sha256: rawHash,
    projection_sha256: projectionHash,
  };
}

export function isExactLegacyRetainedProjectionProvenance({
  value,
  rawMetaSha256,
  projectionSha256,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let expected;
  try {
    expected = buildLegacyRetainedProjectionProvenance({
      rawMetaSha256,
      projectionSha256,
    });
  } catch {
    return false;
  }
  return stableJson(value) === stableJson(expected);
}

function exactSha256(value, label) {
  const hash = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`The ${label} SHA-256 is invalid.`);
  }
  return hash;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}
