import crypto from "node:crypto";
import {
  awardMonitoringPolicyIdentity,
  changeEventSuppressionPolicyIdentity,
  isGloballyActiveMonitoringPolicyRule,
  monitoringPolicyRuleDefinitionForReview,
  visualReviewBatchPolicyIdentity,
} from "./award-monitoring-policy.mjs";
import { changeEventMatchesMonitoringPolicyRule } from "./change-event-suppression.mjs";

export function currentMonitoringPromotionWorkerIdentity(env = process.env) {
  return {
    revision:
      cleanText(env.AWARDPING_WORKER_REVISION || env.GIT_COMMIT_SHA) ||
      "unavailable",
    policy_identity: awardMonitoringPolicyIdentity.id,
    policy_version: awardMonitoringPolicyIdentity.version,
    policy_hash: awardMonitoringPolicyIdentity.hash,
    batch_policy_identity: visualReviewBatchPolicyIdentity.id,
    batch_policy_version: visualReviewBatchPolicyIdentity.version,
    batch_policy_hash: visualReviewBatchPolicyIdentity.hash,
    suppression_policy_identity: changeEventSuppressionPolicyIdentity.id,
    suppression_policy_version: changeEventSuppressionPolicyIdentity.version,
    suppression_policy_hash: changeEventSuppressionPolicyIdentity.hash,
  };
}

export function buildMonitoringPromotionConfiguredRuleDraft(ruleId) {
  const rule = monitoringPolicyRuleDefinitionForReview(ruleId);
  if (!rule) return null;
  return {
    rule,
    hash: crypto.createHash("sha256").update(canonicalJson(rule)).digest("hex"),
  };
}

export function buildMonitoringPromotionShadowReport({
  clusterKey,
  ruleId,
  draftHash,
  feedbackEventIds = [],
  events = [],
  sourcesById = new Map(),
  historyComplete = true,
  now = new Date().toISOString(),
}) {
  const configuredDraft = buildMonitoringPromotionConfiguredRuleDraft(ruleId);
  const draftMatches =
    Boolean(configuredDraft) && configuredDraft.hash === cleanText(draftHash);
  const ruleActive = isGloballyActiveMonitoringPolicyRule(ruleId);
  const feedbackEventIdList = uniqueStrings(feedbackEventIds).sort();
  const feedbackEvents = new Set(feedbackEventIdList);
  const matchedEvents = events.filter((event) =>
    changeEventMatchesMonitoringPolicyRule(
      event,
      sourceForEvent(sourcesById, event),
      ruleId,
    ),
  );
  const matchedFeedbackEventIds = uniqueStrings(
    matchedEvents
      .filter((event) => feedbackEvents.has(cleanText(event.id)))
      .map((event) => event.id),
  ).sort();
  const legitimateUpdates = matchedEvents
    .filter((event) => !feedbackEvents.has(event.id) && isLegitimateUpdate(event))
    .map(publicCollisionEvidence);
  const matchedEveryRecurrence =
    feedbackEvents.size > 0 &&
    matchedFeedbackEventIds.length === feedbackEvents.size;
  const report = {
    schema_version: "monitoring-promotion-shadow-v1",
    report_id: crypto.randomUUID(),
    cluster_key: clusterKey,
    rule_id: ruleId,
    draft_hash: cleanText(draftHash) || null,
    status:
      draftMatches &&
      !ruleActive &&
      historyComplete === true &&
      matchedEveryRecurrence &&
      legitimateUpdates.length === 0
        ? "passed"
        : "failed",
    completed_at: canonicalPreciseRfc3339(now) || cleanText(now),
    total_history_checked: events.length,
    history_complete: historyComplete === true,
    proposed_rule_matches: matchedEvents.length,
    feedback_event_count: feedbackEvents.size,
    feedback_event_ids: feedbackEventIdList,
    recurrence_matches: matchedFeedbackEventIds.length,
    matched_feedback_event_ids: matchedFeedbackEventIds,
    legitimate_updates_suppressed: legitimateUpdates.length,
    legitimate_updates: legitimateUpdates,
    configured_rule_definition_hash: configuredDraft?.hash || null,
    rule_active: ruleActive,
    summary:
      legitimateUpdates.length > 0
        ? `The proposed rule would also hide ${legitimateUpdates.length} legitimate ${legitimateUpdates.length === 1 ? "update" : "updates"}.`
        : matchedEveryRecurrence
          ? "The proposed rule caught the known false updates without hiding a retained legitimate update."
          : `The proposed rule caught ${matchedFeedbackEventIds.length} of ${feedbackEvents.size} known false updates.`,
  };
  return sealPromotionReport(report);
}

export function buildMonitoringPromotionRegressionReport({
  clusterKey,
  ruleId,
  draftHash,
  positiveFixtures = [],
  negativeFixtures = [],
  sourcesById = new Map(),
  now = new Date().toISOString(),
}) {
  const configuredDraft = buildMonitoringPromotionConfiguredRuleDraft(ruleId);
  const draftMatches =
    Boolean(configuredDraft) && configuredDraft.hash === cleanText(draftHash);
  const ruleActive = isGloballyActiveMonitoringPolicyRule(ruleId);
  const canonicalPositiveFixtures = uniqueFixturesById(positiveFixtures);
  const canonicalNegativeFixtures = uniqueFixturesById(negativeFixtures);
  const positiveResults = canonicalPositiveFixtures.map((event) => ({
    fixture_id: cleanText(event.id),
    expected: "suppressed",
    matched: changeEventMatchesMonitoringPolicyRule(
      event,
      sourceForEvent(sourcesById, event),
      ruleId,
    ),
  }));
  const negativeResults = canonicalNegativeFixtures.map((event) => ({
    fixture_id: cleanText(event.id),
    expected: "visible",
    matched: changeEventMatchesMonitoringPolicyRule(
      event,
      sourceForEvent(sourcesById, event),
      ruleId,
    ),
  }));
  const failures = [
    ...positiveResults.filter((result) => !result.matched),
    ...negativeResults.filter((result) => result.matched),
  ];
  const report = {
    schema_version: "monitoring-promotion-regression-v1",
    report_id: crypto.randomUUID(),
    cluster_key: clusterKey,
    rule_id: ruleId,
    draft_hash: cleanText(draftHash) || null,
    status:
      draftMatches &&
      !ruleActive &&
      positiveResults.length > 0 &&
      negativeResults.length > 0 &&
      failures.length === 0
        ? "passed"
        : "failed",
    completed_at: canonicalPreciseRfc3339(now) || cleanText(now),
    positive_fixture_count: positiveResults.length,
    positive_fixture_event_ids: positiveResults.map((result) => result.fixture_id),
    negative_fixture_count: negativeResults.length,
    failure_count: failures.length,
    fixture_results: [...positiveResults, ...negativeResults],
    configured_rule_definition_hash: configuredDraft?.hash || null,
    rule_active: ruleActive,
    summary:
      failures.length === 0 && positiveResults.length > 0 && negativeResults.length > 0
        ? "The rule caught every positive fixture and preserved every legitimate negative fixture."
        : "The promotion-bound regression fixtures are incomplete or failing.",
  };
  return sealPromotionReport(report);
}

export function buildMonitoringPromotionHashAttestation({
  clusterKey,
  ruleId,
  draftHash,
  app,
  worker,
  workerRunIds = [],
  expectedRuleActive = null,
  now = new Date().toISOString(),
}) {
  const configuredDraft = buildMonitoringPromotionConfiguredRuleDraft(ruleId);
  const draftMatches =
    Boolean(configuredDraft) && configuredDraft.hash === cleanText(draftHash);
  const ruleActive = isGloballyActiveMonitoringPolicyRule(ruleId);
  const appRevision = cleanText(app?.revision);
  const workerRevision = cleanText(worker?.revision);
  const comparisons = [
    ["revision", appRevision, workerRevision],
    ["full", app?.policy_hash, worker?.policy_hash],
    ["visual_batch", app?.batch_policy_hash, worker?.batch_policy_hash],
    ["suppression", app?.suppression_policy_hash, worker?.suppression_policy_hash],
  ].map(([kind, appHash, workerHash]) => ({
    kind,
    app_hash: cleanText(appHash) || null,
    worker_hash: cleanText(workerHash) || null,
    matches: Boolean(cleanText(appHash) && cleanText(appHash) === cleanText(workerHash)),
  }));
  const status =
    draftMatches &&
    (expectedRuleActive === null || ruleActive === expectedRuleActive) &&
    comparisons.every((item) => item.matches)
      ? "passed"
      : "failed";
  return sealPromotionReport({
    schema_version: "monitoring-promotion-hash-attestation-v1",
    report_id: crypto.randomUUID(),
    cluster_key: clusterKey,
    rule_id: cleanText(ruleId) || null,
    draft_hash: cleanText(draftHash) || null,
    status,
    completed_at: canonicalPreciseRfc3339(now) || cleanText(now),
    app_revision: appRevision || null,
    worker_revision: workerRevision || null,
    worker_run_ids: uniqueStrings(workerRunIds),
    configured_rule_definition_hash: configuredDraft?.hash || null,
    rule_active: ruleActive,
    comparisons,
    app_policy_hash: cleanText(app?.policy_hash) || null,
    worker_policy_hash: cleanText(worker?.policy_hash) || null,
    app_batch_policy_hash: cleanText(app?.batch_policy_hash) || null,
    worker_batch_policy_hash: cleanText(worker?.batch_policy_hash) || null,
    app_suppression_policy_hash: cleanText(app?.suppression_policy_hash) || null,
    worker_suppression_policy_hash: cleanText(worker?.suppression_policy_hash) || null,
    summary:
      status === "passed"
        ? "The app and worker revision and all three policy identities match."
        : "The app and worker revision or policy identities do not match.",
  });
}

export function buildMonitoringPromotionCanaryReport({
  clusterKey,
  ruleId,
  draftHash,
  monitoringDate,
  notBefore = null,
  scheduledRuns = [],
  expectedHashes,
  events = [],
  sourcesById = new Map(),
  requiredShardCount = 3,
  now = new Date().toISOString(),
}) {
  const configuredDraft = buildMonitoringPromotionConfiguredRuleDraft(ruleId);
  const draftMatches =
    Boolean(configuredDraft) && configuredDraft.hash === cleanText(draftHash);
  const ruleActive = isGloballyActiveMonitoringPolicyRule(ruleId);
  const canonicalRuns = newestRunPerShard(scheduledRuns, {
    monitoringDate,
    notBefore,
    requiredShardCount,
  });
  const completedRuns = canonicalRuns.filter((run) =>
    ["completed", "succeeded"].includes(cleanKey(run.status)),
  );
  const hashesMatch = canonicalRuns.every((run) => workerRunHashesMatch(run, expectedHashes));
  const matchedEvents = events.filter((event) =>
    changeEventMatchesMonitoringPolicyRule(
      event,
      sourceForEvent(sourcesById, event),
      ruleId,
    ),
  );
  const legitimateUpdates = matchedEvents
    .filter(isLegitimateUpdate)
    .map(publicCollisionEvidence);
  const passed =
    draftMatches &&
    !ruleActive &&
    Boolean(cleanMonitoringDate(monitoringDate)) &&
    canonicalRuns.length === requiredShardCount &&
    completedRuns.length === requiredShardCount &&
    hashesMatch &&
    legitimateUpdates.length === 0;
  return sealPromotionReport({
    schema_version: "monitoring-promotion-six-pm-canary-v1",
    report_id: crypto.randomUUID(),
    cluster_key: clusterKey,
    rule_id: ruleId,
    draft_hash: cleanText(draftHash) || null,
    monitoring_date: cleanMonitoringDate(monitoringDate),
    configured_rule_definition_hash: configuredDraft?.hash || null,
    rule_active: ruleActive,
    status: passed ? "passed" : "failed",
    completed_at: canonicalPreciseRfc3339(now) || cleanText(now),
    expected_shards: requiredShardCount,
    observed_shards: canonicalRuns.length,
    completed_shards: completedRuns.length,
    failed_shards: Math.max(0, requiredShardCount - completedRuns.length),
    policy_hashes_match: hashesMatch,
    full_hash: cleanText(expectedHashes?.policy_hash) || null,
    batch_hash: cleanText(expectedHashes?.batch_policy_hash) || null,
    suppression_hash: cleanText(expectedHashes?.suppression_policy_hash) || null,
    proposed_rule_matches: matchedEvents.length,
    legitimate_updates_suppressed: legitimateUpdates.length,
    legitimate_updates: legitimateUpdates,
    run_ids: canonicalRuns.map((run) => run.id).filter(Boolean),
    shard_indices: canonicalRuns
      .map((run) => Number(objectValue(objectValue(run.metadata).run_identity).shard_index))
      .sort((left, right) => left - right),
    summary: passed
      ? "The scheduled 6 PM cohort completed with matching policy hashes and no legitimate collisions."
      : "The 6 PM cohort is incomplete, mismatched, failed, or found a legitimate collision.",
  });
}

export function buildMonitoringPromotionRetroactiveSweepReport({
  clusterKey,
  ruleId,
  draftHash,
  sweep,
  app,
  worker,
  workerRunIds = [],
  now = new Date().toISOString(),
}) {
  const activationAttestation = buildMonitoringPromotionHashAttestation({
    clusterKey,
    ruleId,
    draftHash,
    app,
    worker,
    workerRunIds,
    expectedRuleActive: true,
    now,
  });
  const configuredDraft = buildMonitoringPromotionConfiguredRuleDraft(ruleId);
  const activeRuleDefinitionHash = configuredDraft?.hash || null;
  const ruleActive = isGloballyActiveMonitoringPolicyRule(ruleId);
  const draftMatches = activeRuleDefinitionHash === cleanText(draftHash);
  const complete = sweep?.complete === true;
  const cursorComplete = sweep?.cursor_complete === true || complete;
  const sweepCursor = objectOrNull(sweep?.cursor);
  const terminalCursor = Boolean(
    sweepCursor &&
      Object.hasOwn(sweepCursor, "detected_at") &&
      Object.hasOwn(sweepCursor, "event_id") &&
      Object.hasOwn(sweepCursor, "end_of_history") &&
      sweepCursor.detected_at === null &&
      sweepCursor.event_id === null &&
      sweepCursor.end_of_history === true,
  );
  const sweepRunId = cleanText(sweep?.run_id);
  const sweepKey = cleanText(sweep?.sweep_key);
  const statePolicyHash = cleanText(sweep?.state_policy_hash);
  const checkpointValue = cleanText(sweep?.checkpoint_at);
  const lastMutationValue = cleanText(sweep?.last_mutation_at);
  const completedValue = cleanText(now);
  const canonicalCheckpointAt = canonicalPreciseRfc3339(checkpointValue);
  const canonicalLastMutationAt = lastMutationValue
    ? canonicalPreciseRfc3339(lastMutationValue)
    : null;
  const canonicalCompletedAt = canonicalPreciseRfc3339(completedValue);
  const checkpointMutationOrder = lastMutationValue
    ? comparePreciseRfc3339(canonicalCheckpointAt, canonicalLastMutationAt)
    : 1;
  const durableCompletionBoundary =
    Boolean(canonicalCheckpointAt) &&
    canonicalCompletedAt === canonicalCheckpointAt &&
    (!lastMutationValue || Boolean(canonicalLastMutationAt)) &&
    checkpointMutationOrder === 1;
  const checkpointAt = canonicalCheckpointAt || checkpointValue;
  const lastMutationAt = canonicalLastMutationAt || lastMutationValue;
  const completedAt = canonicalCompletedAt || completedValue;
  const hashMatches =
    cleanText(sweep?.policy_hash) === cleanText(app?.suppression_policy_hash) &&
    Boolean(cleanText(app?.suppression_policy_hash));
  const errorCount = nonNegativeInt(sweep?.error_count);
  const status =
    ruleActive &&
    draftMatches &&
    activationAttestation.status === "passed" &&
    complete &&
    cursorComplete &&
    terminalCursor &&
    Boolean(sweepRunId) &&
    Boolean(sweepKey) &&
    /^[0-9a-f]{64}$/.test(statePolicyHash) &&
    durableCompletionBoundary &&
    hashMatches &&
    errorCount === 0
      ? "completed"
      : "failed";
  return sealPromotionReport({
    schema_version: "monitoring-promotion-retroactive-sweep-v1",
    report_id: crypto.randomUUID(),
    cluster_key: clusterKey,
    rule_id: cleanText(ruleId) || null,
    draft_hash: cleanText(draftHash) || null,
    status,
    completed_at: completedAt,
    checkpoint_at: checkpointAt || null,
    last_mutation_at: lastMutationAt || null,
    sweep_key: sweepKey || null,
    state_policy_hash: statePolicyHash || null,
    policy_hash: cleanText(sweep?.policy_hash) || null,
    expected_policy_hash: cleanText(app?.suppression_policy_hash) || null,
    rule_active: ruleActive,
    active_rule_definition_hash: activeRuleDefinitionHash,
    activation_attestation: activationAttestation,
    policy_hashes_match: activationAttestation.status === "passed",
    app_revision: activationAttestation.app_revision,
    worker_revision: activationAttestation.worker_revision,
    app_policy_hash: activationAttestation.app_policy_hash,
    worker_policy_hash: activationAttestation.worker_policy_hash,
    app_batch_policy_hash: activationAttestation.app_batch_policy_hash,
    worker_batch_policy_hash: activationAttestation.worker_batch_policy_hash,
    app_suppression_policy_hash:
      activationAttestation.app_suppression_policy_hash,
    worker_suppression_policy_hash:
      activationAttestation.worker_suppression_policy_hash,
    cursor_complete: cursorComplete,
    sweep_run_id: sweepRunId || null,
    scanned_count: nonNegativeInt(sweep?.scanned_count),
    suppressed_count: nonNegativeInt(sweep?.suppressed_count),
    error_count: errorCount,
    cursor: sweepCursor,
    summary:
      status === "completed"
        ? "The verified rule completed its bounded historical sweep."
        : "The historical sweep is incomplete, mismatched, or failed.",
  });
}

export function sealPromotionReport(report) {
  return {
    ...report,
    digest: crypto
      .createHash("sha256")
      .update(canonicalJson(report))
      .digest("hex"),
  };
}

function newestRunPerShard(
  runs,
  { monitoringDate, notBefore, requiredShardCount = 3 } = {},
) {
  const byShard = new Map();
  const wantedDate = cleanMonitoringDate(monitoringDate);
  const hasMinimumTimestamp = Boolean(cleanText(notBefore));
  const minimumTimestamp = hasMinimumTimestamp
    ? canonicalPreciseRfc3339(notBefore)
    : null;
  if (hasMinimumTimestamp && !minimumTimestamp) return [];
  const orderedRuns = (Array.isArray(runs) ? runs : [])
    .map((run) => ({
      run,
      startedAt: canonicalPreciseRfc3339(run?.started_at),
    }))
    .sort((left, right) => {
      if (left.startedAt && right.startedAt) {
        const order = comparePreciseRfc3339(right.startedAt, left.startedAt);
        if (order !== 0) return order;
      } else if (left.startedAt) return -1;
      else if (right.startedAt) return 1;
      return cleanText(left.run?.id).localeCompare(cleanText(right.run?.id));
    });
  for (const { run, startedAt } of orderedRuns) {
    if (!startedAt) continue;
    const metadata = objectValue(run.metadata);
    const identity = objectValue(metadata.run_identity);
    if (cleanKey(identity.trigger) !== "scheduled") continue;
    if (wantedDate && cleanMonitoringDate(identity.monitoring_date) !== wantedDate) continue;
    if (
      wantedDate &&
      cleanText(identity.cohort_id) !== `visual-nightly:${wantedDate}`
    ) continue;
    if (
      minimumTimestamp &&
      comparePreciseRfc3339(startedAt, minimumTimestamp) !== 1
    ) continue;
    const shard = Number(identity.shard_index);
    if (
      !Number.isInteger(shard) ||
      shard < 0 ||
      shard >= requiredShardCount ||
      Number(identity.shard_count) !== requiredShardCount ||
      byShard.has(shard)
    ) continue;
    byShard.set(shard, run);
  }
  return [...byShard.values()];
}

function workerRunHashesMatch(run, expected) {
  const metadata = objectValue(run.metadata);
  return [
    [objectValue(metadata.monitoring_policy_bundle).hash, expected?.policy_hash],
    [objectValue(metadata.monitoring_policy).hash, expected?.batch_policy_hash],
    [objectValue(metadata.suppression_policy).hash, expected?.suppression_policy_hash],
  ].every(([actual, wanted]) => Boolean(cleanText(actual) && cleanText(actual) === cleanText(wanted)));
}

function sourceForEvent(sourcesById, event) {
  const sourceId = event?.shared_award_source_id;
  if (!sourceId) return null;
  return sourcesById instanceof Map
    ? sourcesById.get(sourceId) || null
    : sourcesById?.[sourceId] || null;
}

function isLegitimateUpdate(event) {
  if (!event || event.suppressed_at) return false;
  const details = objectValue(event.change_details);
  if (details.suppressed_at || details.suppression_reason) return false;
  if (details.is_alert_worthy === false || details.isAlertWorthy === false) return false;
  return !["rejected", "invalid-json"].includes(cleanKey(details.generation_status));
}

function publicCollisionEvidence(event) {
  return {
    event_id: event.id,
    source_id: event.shared_award_source_id || null,
    source_title: event.source_title || null,
    source_url: event.source_url || null,
    summary: event.summary || "Update summary unavailable",
    detected_at: event.detected_at || null,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/[\s_]+/g, "-");
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))];
}

function uniqueFixturesById(fixtures) {
  const byId = new Map();
  for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
    const id = cleanText(fixture?.id);
    if (id && !byId.has(id)) byId.set(id, fixture);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, fixture]) => fixture);
}

function cleanMonitoringDate(value) {
  const clean = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : null;
}

export function canonicalPreciseRfc3339(value) {
  const instant = preciseRfc3339Instant(value);
  if (!instant) return null;
  const utcSecond = new Date(instant.wholeSecondMillis)
    .toISOString()
    .slice(0, 19);
  const fraction = instant.fraction.padEnd(6, "0");
  return `${utcSecond}.${fraction}Z`;
}

export function comparePreciseRfc3339(left, right) {
  const leftInstant = preciseRfc3339Instant(left);
  const rightInstant = preciseRfc3339Instant(right);
  if (!leftInstant || !rightInstant) return null;
  if (leftInstant.epochMicros === rightInstant.epochMicros) return 0;
  return leftInstant.epochMicros < rightInstant.epochMicros ? -1 : 1;
}

function preciseRfc3339Instant(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const offsetHour = Number(match[10] || 0);
  const offsetMinute = Number(match[11] || 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) return null;

  const localSecond = new Date(0);
  localSecond.setUTCFullYear(year, month - 1, day);
  localSecond.setUTCHours(hour, minute, second, 0);
  if (
    localSecond.getUTCFullYear() !== year ||
    localSecond.getUTCMonth() !== month - 1 ||
    localSecond.getUTCDate() !== day ||
    localSecond.getUTCHours() !== hour ||
    localSecond.getUTCMinutes() !== minute ||
    localSecond.getUTCSeconds() !== second
  ) return null;

  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMillis =
    offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const wholeSecondMillis = localSecond.getTime() - offsetMillis;
  const utcSecond = new Date(wholeSecondMillis).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(utcSecond)) return null;
  const fraction = (match[7] || "").padEnd(6, "0");
  return {
    epochMicros:
      BigInt(wholeSecondMillis) * 1_000n + BigInt(fraction || "0"),
    wholeSecondMillis,
    fraction,
  };
}
