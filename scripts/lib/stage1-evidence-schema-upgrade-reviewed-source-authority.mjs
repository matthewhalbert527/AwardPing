import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS,
  assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS =
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_PRECOMMIT_SOURCE_AUTHORITY_PROJECTION_KEYS;

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_MUTABLE_COLUMNS =
  Object.freeze([
    "consecutive_failures",
    "last_checked_at",
    "last_error",
    "last_hash",
    "next_check_at",
    "updated_at",
  ]);

export function projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(source) {
  const value = requiredObject(source, "source-health authority row");
  const projection = {};
  for (const column of STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS) {
    if (!Object.hasOwn(value, column) || value[column] === undefined) {
      throw new Error(`Source-health authority row is missing ${column}.`);
    }
    projection[column] = cloneJson(value[column]);
  }
  if (stableJson(Object.keys(value).sort()) !== stableJson(
    [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_AUTHORITY_COLUMNS].sort(),
  )) {
    throw new Error("Source-health authority row has unexpected fields.");
  }
  requiredUuid(projection.id, "source-health authority source ID");
  requiredUuid(projection.shared_award_id, "source-health authority award ID");
  const award = requiredObject(projection.shared_awards, "source-health award projection");
  if (
    award.id !== projection.shared_award_id
    || award.status !== "active"
  ) {
    throw new Error("Source-health award projection is not the exact active award.");
  }
  return Object.freeze(projection);
}

export function buildStage1EvidenceSchemaUpgradeSourceHealthAuthority(source) {
  const projection = projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(source);
  return buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
    sourceId: projection.id,
    sourceProjection: projection,
  });
}

export function classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
  precommitSourceAuthority,
  currentSource,
  candidateBaselineBytes,
} = {}) {
  const precommit = assertStage1EvidenceSchemaUpgradePrecommitSourceAuthority(
    precommitSourceAuthority,
  );
  const currentProjection = projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(
    currentSource,
  );
  const current = buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
    sourceId: currentProjection.id,
    sourceProjection: currentProjection,
  });
  if (current.source_authority_sha256 === precommit.source_authority_sha256) {
    return Object.freeze({
      classification: "exact_precommit",
      source_id: current.source_id,
      current_source_authority_sha256: current.source_authority_sha256,
      expected_last_hash: expectedVisualHash(candidateBaselineBytes),
      mutation_performed: false,
    });
  }
  const stableBefore = omitKeys(
    precommit.projection,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_MUTABLE_COLUMNS,
  );
  const stableCurrent = omitKeys(
    current.projection,
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_HEALTH_MUTABLE_COLUMNS,
  );
  const expectedLastHash = expectedVisualHash(candidateBaselineBytes);
  const lastCheckedMs = Date.parse(current.projection.last_checked_at);
  const nextCheckMs = Date.parse(current.projection.next_check_at);
  const updatedMs = Date.parse(current.projection.updated_at);
  const baseline = parseBaseline(candidateBaselineBytes);
  const capturedAtMs = Date.parse(requiredText(
    baseline.captured_at,
    "candidate baseline captured_at",
  ));
  const exactHealthTransition = sameJson(stableBefore, stableCurrent)
    && current.projection.last_hash === expectedLastHash
    && current.projection.consecutive_failures === 0
    && current.projection.last_error === null
    && Number.isFinite(lastCheckedMs)
    && Number.isFinite(nextCheckMs)
    && Number.isFinite(updatedMs)
    && Number.isFinite(capturedAtMs)
    && updatedMs === lastCheckedMs
    && lastCheckedMs >= capturedAtMs
    && nextCheckMs > lastCheckedMs;
  return Object.freeze({
    classification: exactHealthTransition ? "exact_already_current" : "mismatch",
    source_id: current.source_id,
    current_source_authority_sha256: current.source_authority_sha256,
    expected_last_hash: expectedLastHash,
    mutation_performed: false,
  });
}

function expectedVisualHash(candidateBaselineBytes) {
  const baseline = parseBaseline(candidateBaselineBytes);
  const hash = [
    baseline.file_hash,
    baseline.main_content_hash,
    baseline.image_hash,
    baseline.text_hash,
  ].find((value) => typeof value === "string" && value.trim());
  if (!hash) throw new Error("Candidate baseline has no source-health visual hash.");
  return `visual:${hash.trim()}`;
}

function parseBaseline(value) {
  const bytes = exactBytes(value, "candidate baseline bytes");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Candidate baseline bytes are not valid UTF-8 JSON.");
  }
  return requiredObject(parsed, "candidate baseline");
}

function omitKeys(value, keys) {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new TypeError(`${label} must be exact bytes.`);
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}
