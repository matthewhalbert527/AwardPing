import { createHash } from "node:crypto";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_ACCOUNTING_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-mutation-accounting.v1";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS = Object.freeze([
  "database_writes",
  "r2_writes",
  "local_baseline_writes",
  "candidate_writes",
  "quarantine_writes",
  "source_state_writes",
]);

export function sealStage1EvidenceSchemaUpgradeMutationAccounting({
  operation,
  lowerBoundCounts,
  unknownWriteCategories = [],
  evidence = null,
} = {}) {
  const content = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_ACCOUNTING_SCHEMA,
    operation: requiredText(operation, "operation"),
    count_semantics: "confirmed_lower_bounds",
    exact: normalizedUnknownCategories(unknownWriteCategories).length === 0,
    lower_bound_counts: normalizeCounts(lowerBoundCounts),
    unknown_write_categories: normalizedUnknownCategories(unknownWriteCategories),
    evidence: cloneJson(evidence),
  };
  return Object.freeze({
    ...content,
    accounting_sha256: sha256(stableJson(content)),
  });
}

export function assertStage1EvidenceSchemaUpgradeMutationAccounting(value, {
  operation = null,
} = {}) {
  if (!isPlainObject(value)) throw new Error("Stage 1 mutation accounting is missing.");
  const seal = value.accounting_sha256;
  const content = cloneJson(value);
  delete content.accounting_sha256;
  const unknown = normalizedUnknownCategories(content.unknown_write_categories);
  if (
    content.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_ACCOUNTING_SCHEMA
    || content.count_semantics !== "confirmed_lower_bounds"
    || content.operation !== requiredText(content.operation, "operation")
    || (operation !== null && content.operation !== operation)
    || content.exact !== (unknown.length === 0)
    || stableJson(content.lower_bound_counts) !== stableJson(normalizeCounts(content.lower_bound_counts))
    || stableJson(content.unknown_write_categories) !== stableJson(unknown)
    || !/^[0-9a-f]{64}$/u.test(String(seal || ""))
    || seal !== sha256(stableJson(content))
  ) {
    throw new Error("Stage 1 mutation accounting seal or content is invalid.");
  }
  return Object.freeze({
    ...content,
    lower_bound_counts: Object.freeze(content.lower_bound_counts),
    unknown_write_categories: Object.freeze(unknown),
    accounting_sha256: seal,
  });
}

export function zeroStage1EvidenceSchemaUpgradeMutationCounts() {
  return Object.fromEntries(
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS.map((key) => [key, 0]),
  );
}

function normalizeCounts(value) {
  if (!isPlainObject(value)) throw new Error("Stage 1 mutation lower-bound counts are invalid.");
  const keys = Object.keys(value).sort();
  const expected = [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS].sort();
  if (
    stableJson(keys) !== stableJson(expected)
    || expected.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
  ) {
    throw new Error("Stage 1 mutation lower-bound counts are invalid.");
  }
  return Object.fromEntries(expected.map((key) => [key, value[key]]));
}

function normalizedUnknownCategories(value) {
  if (!Array.isArray(value)) {
    throw new Error("Stage 1 unknown mutation categories must be an array.");
  }
  const allowed = new Set(STAGE1_EVIDENCE_SCHEMA_UPGRADE_MUTATION_COUNT_KEYS);
  const categories = [...new Set(value.map((item) => requiredText(item, "unknown category")))]
    .sort();
  if (categories.some((item) => !allowed.has(item))) {
    throw new Error("Stage 1 unknown mutation category is unsupported.");
  }
  return categories;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Stage 1 mutation accounting ${label} is required.`);
  return text;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
