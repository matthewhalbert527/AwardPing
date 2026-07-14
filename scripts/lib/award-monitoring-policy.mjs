import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const policyPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "award-monitoring-policy.json",
);
const decisionMemoryPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config",
  "award-decision-memory.json",
);

export const awardMonitoringPolicy = JSON.parse(readFileSync(policyPath, "utf8"));
export const awardDecisionMemory = JSON.parse(readFileSync(decisionMemoryPath, "utf8"));

export const VISUAL_REVIEW_BATCH_POLICY_SCOPE = "visual_review_batch";

const UPDATE_REVIEW_PROMPT_SCOPES = new Set([
  "change_details_ai",
  "visual_snapshot_ai",
  "visual_snapshot_gemini_cli",
  VISUAL_REVIEW_BATCH_POLICY_SCOPE,
]);
const UPDATE_REVIEW_DECISION_TYPES = new Set([
  "change_interpretation",
  "screenshot_localization",
]);

const policyFlags = Array.isArray(awardMonitoringPolicy.policy_flags)
  ? awardMonitoringPolicy.policy_flags
  : [];
const decisionMemoryEntries = Array.isArray(awardDecisionMemory.entries)
  ? awardDecisionMemory.entries
  : [];

const policyFlagIdByAlias = new Map();
const policyFlagAliasConflicts = [];
for (const flag of policyFlags) {
  if (!flag || flag.active === false) continue;
  const canonicalId = cleanPolicyFlag(flag.id);
  if (!canonicalId) continue;
  for (const rawAlias of [canonicalId, ...stringArray(flag.aliases)]) {
    const alias = cleanPolicyFlag(rawAlias);
    if (!alias) continue;
    const existing = policyFlagIdByAlias.get(alias);
    if (existing && existing !== canonicalId) {
      policyFlagAliasConflicts.push({ alias, ids: [existing, canonicalId] });
      continue;
    }
    policyFlagIdByAlias.set(alias, canonicalId);
  }
}

export const alertBlockingMonitoringPolicyFlagIds = Object.freeze(
  [
    ...new Set(
      policyFlags
        .filter((flag) => flag?.active !== false && flag?.alert_blocking === true)
        .map((flag) => cleanPolicyFlag(flag.id))
        .filter(Boolean),
    ),
  ],
);
export const awardMonitoringPolicyVersion = monitoringPolicyBundleVersion(
  awardMonitoringPolicy,
  awardDecisionMemory,
);
export const awardMonitoringPolicyHash = monitoringPolicyBundleHash({
  monitoring_policy: awardMonitoringPolicy,
  decision_memory: awardDecisionMemory,
});
export const awardMonitoringPolicyIdentity = Object.freeze({
  id: `awardping-monitoring-policy@${awardMonitoringPolicyVersion}+${awardMonitoringPolicyHash}`,
  version: awardMonitoringPolicyVersion,
  hash: awardMonitoringPolicyHash,
  policyVersion: awardMonitoringPolicy.version ?? null,
  decisionMemoryVersion: awardDecisionMemory.version ?? null,
});

export const visualReviewBatchPolicyVersion = "visual-review-batch-1";
export const visualReviewBatchPolicyHash = monitoringPolicyBundleHash(
  effectiveVisualReviewBatchPolicy(),
);
export const visualReviewBatchPolicyIdentity = Object.freeze({
  id: `awardping-visual-review-batch@${visualReviewBatchPolicyHash}`,
  version: visualReviewBatchPolicyVersion,
  hash: visualReviewBatchPolicyHash,
});

export const changeEventSuppressionBehaviorVersion = "change-event-suppression-3";
export const changeEventSuppressionPolicyHash = monitoringPolicyBundleHash({
  monitoring_policy: awardMonitoringPolicyIdentity,
  visual_review_batch_policy: visualReviewBatchPolicyIdentity,
  suppression_behavior_version: changeEventSuppressionBehaviorVersion,
});
export const changeEventSuppressionPolicyIdentity = Object.freeze({
  id: `awardping-change-event-suppression@${changeEventSuppressionPolicyHash}`,
  version: changeEventSuppressionBehaviorVersion,
  hash: changeEventSuppressionPolicyHash,
});

export function monitoringPolicyPromptLinesForScope(scope) {
  return [
    ...policyPromptLinesForScope(scope),
    ...decisionMemoryPromptLinesForScope(scope),
  ];
}

export function decisionMemoryPromptLinesForScope(scope) {
  return decisionMemoryEntries
    .filter(
      (entry) =>
        entry?.active !== false &&
        entry?.prompt &&
        Array.isArray(entry.prompt_scopes) &&
        entry.prompt_scopes.includes(scope),
    )
    .map((entry) => `Decision memory (${entry.scope || "global"}:${entry.id || "unnamed"}): ${String(entry.prompt)}`);
}

function policyPromptLinesForScope(scope) {
  return policyFlags
    .filter(
      (flag) =>
        flag?.active !== false &&
        flag?.prompt &&
        Array.isArray(flag.prompt_scopes) &&
        flag.prompt_scopes.includes(scope),
    )
    .map((flag) => {
      const id = cleanPolicyFlag(flag.id) || "unnamed";
      return `Monitoring policy (${id}): ${String(flag.prompt)} When this rule causes rejection, include "${id}" in noise_flags.`;
    });
}

export function visualReviewBatchPolicyCoverageGaps() {
  const gaps = [];

  for (const flag of policyFlags) {
    if (flag?.active === false || flag?.alert_blocking !== true) continue;
    const missing = missingBatchPromptParts(flag);
    if (missing.length) {
      gaps.push({ source: "policy_flag", id: cleanPolicyFlag(flag.id) || "unnamed", missing });
    }
  }

  for (const entry of decisionMemoryEntries) {
    if (!isActiveUpdateDecisionMemoryEntry(entry)) continue;
    const missing = missingBatchPromptParts(entry);
    if (missing.length) {
      gaps.push({ source: "decision_memory", id: cleanPolicyFlag(entry.id) || "unnamed", missing });
    }
  }

  return gaps;
}

export function assertVisualReviewBatchPolicyCoverage() {
  const gaps = visualReviewBatchPolicyCoverageGaps();
  const aliasConflicts = monitoringPolicyAliasConflicts();
  if (!gaps.length && !aliasConflicts.length) return;

  const summary = [
    ...gaps.map((gap) => `${gap.source}:${gap.id} (${gap.missing.join(", ")})`),
    ...aliasConflicts.map((conflict) => `alias:${conflict.alias} (${conflict.ids.join(", ")})`),
  ].join("; ");
  throw new Error(`Visual review batch policy coverage is incomplete: ${summary}`);
}

export function monitoringPolicyAliasConflicts() {
  return policyFlagAliasConflicts.map((conflict) => ({
    alias: conflict.alias,
    ids: [...new Set(conflict.ids)],
  }));
}

export function monitoringPolicyFlagIdForAlias(flag) {
  return policyFlagIdByAlias.get(cleanPolicyFlag(flag)) || null;
}

export function isAlertBlockingMonitoringPolicyFlag(flag) {
  const canonicalId = monitoringPolicyFlagIdForAlias(flag);
  if (!canonicalId) return false;
  return policyFlags.some(
    (policyFlag) =>
      policyFlag?.active !== false &&
      cleanPolicyFlag(policyFlag.id) === canonicalId &&
      policyFlag.alert_blocking === true,
  );
}

export function isPersistentMonitoringPolicyFlag(flag) {
  const canonicalId = monitoringPolicyFlagIdForAlias(flag);
  if (!canonicalId) return false;
  return policyFlags.some(
    (policyFlag) =>
      policyFlag?.active !== false &&
      cleanPolicyFlag(policyFlag.id) === canonicalId &&
      policyFlag.persistent === true,
  );
}

export function hasRelativeAgeOnlyPolicyChange(input = {}) {
  if (stringArray(input.dateChanges).length || stringArray(input.amountChanges).length) return false;

  const addedText = stringArray(input.addedText);
  const removedText = stringArray(input.removedText);
  const evidence = [
    input.before,
    input.after,
    ...addedText,
    ...removedText,
  ].filter(Boolean);
  const evidenceText = normalizePolicyText(evidence.join(" "));
  const summaryText = normalizePolicyText([input.readerSummary, input.section, evidenceText].join(" "));

  if (!containsRelativeAgePhrase(summaryText)) return false;
  if (hasApplicantFacingMonitoringPolicySignal(stripRelativeAgePhrases(evidenceText || summaryText))) {
    return false;
  }
  if (input.before && input.after && hasOnlyRelativeAgeDifference(input.before, input.after)) {
    return true;
  }
  if (hasRelativeAgeOnlyTextDiff(removedText, addedText)) {
    return true;
  }

  return looksLikeRelativeAgeUpdateSummary(summaryText);
}

export function hasRelativeAgeOnlyTextDiff(removedText, addedText) {
  const removed = stringArray(removedText);
  const added = stringArray(addedText);
  if (!removed.length || removed.length !== added.length) return false;
  const removedKeys = removed.map(relativeAgeComparisonKey).filter(Boolean).sort();
  const addedKeys = added.map(relativeAgeComparisonKey).filter(Boolean).sort();
  if (removedKeys.length !== removed.length || addedKeys.length !== added.length) return false;
  if (![...removed, ...added].every(containsRelativeAgePhrase)) return false;
  return removedKeys.every((key, index) => key === addedKeys[index]);
}

export function aiReviewLooksLikeRelativeAgeOnlyChange(aiReview) {
  const result = aiReview?.result || {};
  const details = jsonObject(result.change_details);
  const structuredDiff = jsonObject(details.structured_diff);

  return hasRelativeAgeOnlyPolicyChange({
    readerSummary: [result.reader_summary, details.reader_summary].filter(Boolean).join(" "),
    section: [result.changed_section, details.section].filter(Boolean).join(" "),
    before: result.before || details.before || null,
    after: result.after || details.after || null,
    addedText: structuredDiff.added_text,
    removedText: structuredDiff.removed_text,
    dateChanges: structuredDiff.date_changes,
    amountChanges: structuredDiff.amount_changes,
  });
}

export function stripRelativeAgePhrases(value) {
  return normalizePolicyText(value).replace(relativeAgePhrasePattern(), " ").trim();
}

export function containsRelativeAgePhrase(value) {
  return relativeAgePhrasePattern().test(value);
}

export function hasApplicantFacingMonitoringPolicySignal(value) {
  return /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|materials?|portal)|applications?(?: period| cycle| status)? (?:is |are |has |have |will )?(?:now )?(?:open|opened|close|closed|closing|due)|award amount|stipend|tuition|funding)\b/i.test(
    String(value || ""),
  );
}

function hasOnlyRelativeAgeDifference(before, after) {
  if (!containsRelativeAgePhrase(before) || !containsRelativeAgePhrase(after)) return false;
  const beforeKey = relativeAgeComparisonKey(before);
  const afterKey = relativeAgeComparisonKey(after);
  return Boolean(beforeKey && beforeKey === afterKey && sentencePolicyKey(before) !== sentencePolicyKey(after));
}

function looksLikeRelativeAgeUpdateSummary(value) {
  const clean = normalizePolicyText(value).toLowerCase();
  return (
    relativeAgePhrases(clean).length >= 2 &&
    /\b(?:instead of|rather than|from|to|now shows?|now displays?|updated|changed)\b/.test(clean) &&
    /\b(?:news|posts?|articles?|items?|listings?|feed|recent|chapter|blog|press|stories?|published|shared)\b/.test(
      clean,
    )
  );
}

function relativeAgeComparisonKey(value) {
  return normalizePolicyText(value)
    .toLowerCase()
    .replace(relativeAgePhrasePattern(), " relative_age ")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

function relativeAgePhrases(value) {
  return normalizePolicyText(value).match(relativeAgePhrasePattern()) || [];
}

function relativeAgePhrasePattern() {
  return /\b(?:just now|today|yesterday|(?:a|an|one|\d+)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b/gi;
}

function sentencePolicyKey(value) {
  return normalizePolicyText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePolicyText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanPolicyFlag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizePolicyText(item)).filter(Boolean);
  const clean = normalizePolicyText(value);
  return clean ? [clean] : [];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isActiveUpdateDecisionMemoryEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.active === false) return false;
  if (UPDATE_REVIEW_DECISION_TYPES.has(String(entry.decision_type || ""))) return true;
  return stringArray(entry.prompt_scopes).some((scope) => UPDATE_REVIEW_PROMPT_SCOPES.has(scope));
}

function missingBatchPromptParts(entry) {
  const missing = [];
  if (!normalizePolicyText(entry?.prompt)) missing.push("prompt");
  if (!stringArray(entry?.prompt_scopes).includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE)) {
    missing.push("visual_review_batch scope");
  }
  return missing;
}

function monitoringPolicyBundleVersion(policy, decisionMemory) {
  return `policy-${policyBundleVersionPart(policy?.version)}.memory-${policyBundleVersionPart(decisionMemory?.version)}`;
}

function effectiveVisualReviewBatchPolicy() {
  return {
    schema_version: visualReviewBatchPolicyVersion,
    scope: VISUAL_REVIEW_BATCH_POLICY_SCOPE,
    policy_flags: policyFlags
      .filter(
        (flag) =>
          flag?.active !== false &&
          Array.isArray(flag.prompt_scopes) &&
          flag.prompt_scopes.includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE),
      )
      .map((flag) => ({
        id: cleanPolicyFlag(flag.id),
        alert_blocking: flag.alert_blocking === true,
        persistent: flag.persistent === true,
        aliases: [
          ...new Set(stringArray(flag.aliases).map(cleanPolicyFlag).filter(Boolean)),
        ].sort(),
        prompt: normalizePolicyText(flag.prompt),
      })),
    decision_memory: decisionMemoryEntries
      .filter(
        (entry) =>
          entry?.active !== false &&
          Array.isArray(entry.prompt_scopes) &&
          entry.prompt_scopes.includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE),
      )
      .map((entry) => ({
        id: cleanPolicyFlag(entry.id),
        scope: normalizePolicyText(entry.scope || "global"),
        prompt: normalizePolicyText(entry.prompt),
      })),
  };
}

function policyBundleVersionPart(value) {
  const clean = String(value ?? "unknown").trim();
  return clean || "unknown";
}

function monitoringPolicyBundleHash(value) {
  const canonical = canonicalPolicyJson(value);
  const primary = fnv1a32Utf16(canonical, 0x811c9dc5);
  const secondary = fnv1a32Utf16(canonical, 0x9e3779b9);
  return `fnv1a32x2-utf16:${hex32(primary)}${hex32(secondary)}`;
}

function canonicalPolicyJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPolicyJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPolicyJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fnv1a32Utf16(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hex32(value) {
  return value.toString(16).padStart(8, "0");
}

assertVisualReviewBatchPolicyCoverage();
