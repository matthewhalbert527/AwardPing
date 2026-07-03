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

export const awardMonitoringPolicy = JSON.parse(readFileSync(policyPath, "utf8"));

const policyFlags = Array.isArray(awardMonitoringPolicy.policy_flags)
  ? awardMonitoringPolicy.policy_flags
  : [];

export function monitoringPolicyPromptLinesForScope(scope) {
  return policyFlags
    .filter((flag) => flag.prompt && Array.isArray(flag.prompt_scopes) && flag.prompt_scopes.includes(scope))
    .map((flag) => String(flag.prompt));
}

export function isAlertBlockingMonitoringPolicyFlag(flag) {
  const clean = cleanPolicyFlag(flag);
  return policyFlags.some((policyFlag) => policyFlag.id === clean && policyFlag.alert_blocking === true);
}

export function isPersistentMonitoringPolicyFlag(flag) {
  const clean = cleanPolicyFlag(flag);
  return policyFlags.some((policyFlag) => policyFlag.id === clean && policyFlag.persistent === true);
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
  return /\b(deadline|due|eligible|eligibility|requirement|recommendation|transcript|essay|nomination|submit|submission|application (?:deadline|material|portal|opens?|closes?)|award amount|stipend|tuition|funding)\b/i.test(
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
    .replace(/[^a-z0-9_-]+/g, "_")
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
