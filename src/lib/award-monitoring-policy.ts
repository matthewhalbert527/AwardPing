import awardMonitoringPolicyData from "../../config/award-monitoring-policy.json";
import awardDecisionMemoryData from "../../config/award-decision-memory.json";

type PolicyFlag = {
  id: string;
  active?: boolean;
  alert_blocking?: boolean;
  persistent?: boolean;
  aliases?: string[];
  prompt?: string;
  prompt_scopes?: string[];
};

type DecisionMemoryEntry = {
  id?: string;
  active?: boolean;
  scope?: string;
  decision_type?: string;
  prompt?: string;
  prompt_scopes?: string[];
};

type BatchPromptEntry = {
  prompt?: string;
  prompt_scopes?: string[];
};

export type VisualReviewBatchPolicyCoverageGap = {
  source: "policy_flag" | "decision_memory";
  id: string;
  missing: string[];
};

type RelativeAgePolicyInput = {
  readerSummary?: string | null;
  section?: string | null;
  before?: string | null;
  after?: string | null;
  addedText?: string[] | null;
  removedText?: string[] | null;
  dateChanges?: string[] | null;
  amountChanges?: string[] | null;
};

export const awardMonitoringPolicy = awardMonitoringPolicyData;
export const awardDecisionMemory = awardDecisionMemoryData;
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

const policyFlags = (awardMonitoringPolicy.policy_flags || []) as PolicyFlag[];
const decisionMemoryEntries = (awardDecisionMemory.entries || []) as DecisionMemoryEntry[];

const policyFlagIdByAlias = new Map<string, string>();
const policyFlagAliasConflicts: Array<{ alias: string; ids: string[] }> = [];
for (const flag of policyFlags) {
  if (flag.active === false) continue;
  const canonicalId = cleanPolicyFlag(flag.id);
  if (!canonicalId) continue;
  for (const rawAlias of [canonicalId, ...(flag.aliases || [])]) {
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
        .filter((flag) => flag.active !== false && flag.alert_blocking === true)
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

export function monitoringPolicyPromptLinesForScope(scope: string) {
  return [
    ...policyPromptLinesForScope(scope),
    ...decisionMemoryPromptLinesForScope(scope),
  ];
}

export function decisionMemoryPromptLinesForScope(scope: string) {
  return decisionMemoryEntries
    .filter(
      (entry) => entry.active !== false && entry.prompt && entry.prompt_scopes?.includes(scope),
    )
    .map(
      (entry) =>
        `Decision memory (${entry.scope || "global"}:${entry.id || "unnamed"}): ${entry.prompt as string}`,
    );
}

function policyPromptLinesForScope(scope: string) {
  return policyFlags
    .filter(
      (flag) => flag.active !== false && flag.prompt && flag.prompt_scopes?.includes(scope),
    )
    .map((flag) => {
      const id = cleanPolicyFlag(flag.id) || "unnamed";
      return `Monitoring policy (${id}): ${flag.prompt as string} When this rule causes rejection, include "${id}" in noise_flags.`;
    });
}

export function visualReviewBatchPolicyCoverageGaps(): VisualReviewBatchPolicyCoverageGap[] {
  const gaps: VisualReviewBatchPolicyCoverageGap[] = [];

  for (const flag of policyFlags) {
    if (flag.active === false || flag.alert_blocking !== true) continue;
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

export function monitoringPolicyFlagIdForAlias(flag: unknown) {
  return policyFlagIdByAlias.get(cleanPolicyFlag(flag)) || null;
}

export function isAlertBlockingMonitoringPolicyFlag(flag: string) {
  const canonicalId = monitoringPolicyFlagIdForAlias(flag);
  if (!canonicalId) return false;
  return policyFlags.some(
    (policyFlag) =>
      policyFlag.active !== false &&
      cleanPolicyFlag(policyFlag.id) === canonicalId &&
      policyFlag.alert_blocking === true,
  );
}

export function isPersistentMonitoringPolicyFlag(flag: string) {
  const canonicalId = monitoringPolicyFlagIdForAlias(flag);
  if (!canonicalId) return false;
  return policyFlags.some(
    (policyFlag) =>
      policyFlag.active !== false &&
      cleanPolicyFlag(policyFlag.id) === canonicalId &&
      policyFlag.persistent,
  );
}

export function hasRelativeAgeOnlyPolicyChange(input: RelativeAgePolicyInput) {
  if (input.dateChanges?.length || input.amountChanges?.length) return false;

  const addedText = input.addedText || [];
  const removedText = input.removedText || [];
  const evidence = [
    input.before,
    input.after,
    ...addedText,
    ...removedText,
  ].filter((value): value is string => Boolean(value));
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

export function hasRelativeAgeOnlyTextDiff(removedText: string[], addedText: string[]) {
  if (!removedText.length || removedText.length !== addedText.length) return false;
  const removedKeys = removedText.map(relativeAgeComparisonKey).filter(Boolean).sort();
  const addedKeys = addedText.map(relativeAgeComparisonKey).filter(Boolean).sort();
  if (removedKeys.length !== removedText.length || addedKeys.length !== addedText.length) {
    return false;
  }
  if (![...removedText, ...addedText].every(containsRelativeAgePhrase)) return false;
  return removedKeys.every((key, index) => key === addedKeys[index]);
}

export function stripRelativeAgePhrases(value: string) {
  return normalizePolicyText(value).replace(relativeAgePhrasePattern(), " ").trim();
}

export function containsRelativeAgePhrase(value: string) {
  return relativeAgePhrasePattern().test(value);
}

export function hasApplicantFacingMonitoringPolicySignal(value: string) {
  return /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|materials?|portal)|applications?(?: period| cycle| status)? (?:is |are |has |have |will )?(?:now )?(?:open|opened|close|closed|closing|due)|award amount|stipend|tuition|funding)\b/i.test(
    value,
  );
}

function hasOnlyRelativeAgeDifference(before: string, after: string) {
  if (!containsRelativeAgePhrase(before) || !containsRelativeAgePhrase(after)) return false;
  const beforeKey = relativeAgeComparisonKey(before);
  const afterKey = relativeAgeComparisonKey(after);
  return Boolean(beforeKey && beforeKey === afterKey && sentencePolicyKey(before) !== sentencePolicyKey(after));
}

function looksLikeRelativeAgeUpdateSummary(value: string) {
  const clean = normalizePolicyText(value).toLowerCase();
  return (
    relativeAgePhrases(clean).length >= 2 &&
    /\b(?:instead of|rather than|from|to|now shows?|now displays?|updated|changed)\b/.test(clean) &&
    /\b(?:news|posts?|articles?|items?|listings?|feed|recent|chapter|blog|press|stories?|published|shared)\b/.test(
      clean,
    )
  );
}

function relativeAgeComparisonKey(value: string) {
  return normalizePolicyText(value)
    .toLowerCase()
    .replace(relativeAgePhrasePattern(), " relative_age ")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

function relativeAgePhrases(value: string) {
  return normalizePolicyText(value).match(relativeAgePhrasePattern()) || [];
}

function relativeAgePhrasePattern() {
  return /\b(?:just now|today|yesterday|(?:a|an|one|\d+)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b/gi;
}

function sentencePolicyKey(value: string) {
  return normalizePolicyText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePolicyText(value: string) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanPolicyFlag(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isActiveUpdateDecisionMemoryEntry(entry: DecisionMemoryEntry) {
  if (entry.active === false) return false;
  if (UPDATE_REVIEW_DECISION_TYPES.has(entry.decision_type || "")) return true;
  return (entry.prompt_scopes || []).some((scope) => UPDATE_REVIEW_PROMPT_SCOPES.has(scope));
}

function missingBatchPromptParts(entry: BatchPromptEntry) {
  const missing: string[] = [];
  if (!normalizePolicyText(entry.prompt || "")) missing.push("prompt");
  if (!entry.prompt_scopes?.includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE)) {
    missing.push("visual_review_batch scope");
  }
  return missing;
}

function monitoringPolicyBundleVersion(
  policy: { version?: unknown },
  decisionMemory: { version?: unknown },
) {
  return `policy-${policyBundleVersionPart(policy.version)}.memory-${policyBundleVersionPart(decisionMemory.version)}`;
}

function effectiveVisualReviewBatchPolicy() {
  return {
    schema_version: visualReviewBatchPolicyVersion,
    scope: VISUAL_REVIEW_BATCH_POLICY_SCOPE,
    policy_flags: policyFlags
      .filter(
        (flag) =>
          flag.active !== false &&
          flag.prompt_scopes?.includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE),
      )
      .map((flag) => ({
        id: cleanPolicyFlag(flag.id),
        alert_blocking: flag.alert_blocking === true,
        persistent: flag.persistent === true,
        aliases: [
          ...new Set((flag.aliases || []).map(cleanPolicyFlag).filter(Boolean)),
        ].sort(),
        prompt: normalizePolicyText(flag.prompt || ""),
      })),
    decision_memory: decisionMemoryEntries
      .filter(
        (entry) =>
          entry.active !== false &&
          entry.prompt_scopes?.includes(VISUAL_REVIEW_BATCH_POLICY_SCOPE),
      )
      .map((entry) => ({
        id: cleanPolicyFlag(entry.id),
        scope: normalizePolicyText(entry.scope || "global"),
        prompt: normalizePolicyText(entry.prompt || ""),
      })),
  };
}

function policyBundleVersionPart(value: unknown) {
  const clean = String(value ?? "unknown").trim();
  return clean || "unknown";
}

function monitoringPolicyBundleHash(value: unknown) {
  const canonical = canonicalPolicyJson(value);
  const primary = fnv1a32Utf16(canonical, 0x811c9dc5);
  const secondary = fnv1a32Utf16(canonical, 0x9e3779b9);
  return `fnv1a32x2-utf16:${hex32(primary)}${hex32(secondary)}`;
}

function canonicalPolicyJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPolicyJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPolicyJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fnv1a32Utf16(value: string, seed: number) {
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

function hex32(value: number) {
  return value.toString(16).padStart(8, "0");
}

assertVisualReviewBatchPolicyCoverage();
