import awardMonitoringPolicyData from "../../config/award-monitoring-policy.json";
import awardDecisionMemoryData from "../../config/award-decision-memory.json";

type PolicyFlag = {
  id: string;
  alert_blocking?: boolean;
  persistent?: boolean;
  prompt?: string;
  prompt_scopes?: string[];
};

type DecisionMemoryEntry = {
  id?: string;
  scope?: string;
  prompt?: string;
  prompt_scopes?: string[];
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

const policyFlags = (awardMonitoringPolicy.policy_flags || []) as PolicyFlag[];
const decisionMemoryEntries = (awardDecisionMemory.entries || []) as DecisionMemoryEntry[];

export function monitoringPolicyPromptLinesForScope(scope: string) {
  return [
    ...policyPromptLinesForScope(scope),
    ...decisionMemoryPromptLinesForScope(scope),
  ];
}

export function decisionMemoryPromptLinesForScope(scope: string) {
  return decisionMemoryEntries
    .filter((entry) => entry.prompt && entry.prompt_scopes?.includes(scope))
    .map(
      (entry) =>
        `Decision memory (${entry.scope || "global"}:${entry.id || "unnamed"}): ${entry.prompt as string}`,
    );
}

function policyPromptLinesForScope(scope: string) {
  return policyFlags
    .filter((flag) => flag.prompt && flag.prompt_scopes?.includes(scope))
    .map((flag) => flag.prompt as string);
}

export function isAlertBlockingMonitoringPolicyFlag(flag: string) {
  const clean = cleanPolicyFlag(flag);
  return policyFlags.some((policyFlag) => policyFlag.id === clean && policyFlag.alert_blocking);
}

export function isPersistentMonitoringPolicyFlag(flag: string) {
  const clean = cleanPolicyFlag(flag);
  return policyFlags.some((policyFlag) => policyFlag.id === clean && policyFlag.persistent);
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
  return /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|material|portal|opens?|closes?)|award amount|stipend|tuition|funding)\b/i.test(
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

function cleanPolicyFlag(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
