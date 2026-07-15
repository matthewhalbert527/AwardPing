import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const MAX_EXAMPLES_PER_GROUP = 3;
const MAX_SOURCE_IDS_PER_GROUP = 500;
const RUN_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

const FAILURE_POLICIES = [
  {
    code: "baseline_evidence_missing_or_invalid",
    group: "evidence_integrity",
    label: "Baseline evidence needs repair",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "restore_or_verify_baseline_evidence",
    solution:
      "Restore the complete retained baseline capture when it is available. If it is unavailable, verify the live official page before a targeted baseline refresh; never refresh a baseline merely to clear this error.",
    matches: [
      "baseline exists but evidence is missing",
      "baseline exists but could not be loaded",
      "missing baseline evidence",
      "baseline evidence is missing",
    ],
  },
  {
    code: "ai_quota_or_billing_blocked",
    group: "platform_dependency",
    label: "AI quota or spend cap blocked the shard",
    severity: "critical",
    retry_mode: "repair_then_restart_shard",
    repair_code: "restore_ai_quota_then_restart",
    solution:
      "Verify the AI account quota and billing state. Wait for the approved reset or increase the spend cap only with authorization, then restart only the affected shard; do not retry sources or change baselines while the shared limit is active.",
    matches: [
      "gemini api cap",
      "gemini api daily cost cap",
      "gemini daily cost cap",
      "quota exceeded",
      "insufficient quota",
      "resource exhausted",
      "resource_exhausted",
      "spend cap",
      "billing limit",
    ],
  },
  {
    code: "infra_blocked",
    group: "platform_dependency",
    label: "Worker dependency is unavailable",
    severity: "critical",
    retry_mode: "repair_then_restart_shard",
    repair_code: "restore_dependency_then_restart",
    solution:
      "Restore Supabase, credentials, billing, or the missing worker configuration, then restart only the affected shard. Do not retry individual sources or change baselines while the shared dependency is unavailable.",
    matches: [
      "supabase",
      "service role",
      "service_role",
      "billing blocked",
      "billing_blocked",
      "missing environment",
      "configuration is required",
      "source load incomplete",
    ],
  },
  {
    code: "downstream_persistence_failed",
    group: "downstream_persistence",
    label: "Downstream handoff failed",
    severity: "critical",
    retry_mode: "resume_idempotently",
    repair_code: "resume_downstream_handoff",
    solution:
      "Keep the captured evidence and retry only the failed queue, publish, or reconciliation handoff. Do not recapture the page or submit a duplicate paid review job.",
    matches: [
      "candidate enqueue failed",
      "reconciliation queue failed",
      "queue award reconciliation failed",
      "visual change publish failed",
      "publish failed",
      "rejection ledger",
    ],
  },
  {
    code: "storage_sync_failed",
    group: "platform_dependency",
    label: "Evidence storage sync failed",
    severity: "critical",
    retry_mode: "retry_failed_stage",
    repair_code: "repair_storage_then_resync",
    solution:
      "Verify R2 credentials and availability, then retry the storage sync for the retained evidence. Do not recapture or advance the baseline when the local capture already exists.",
    matches: ["r2 ", "r2_", "object storage", "s3 ", "snapshot upload failed"],
  },
  {
    code: "rate_limited",
    group: "transient_access",
    label: "Source rate-limited the scan",
    severity: "warning",
    retry_mode: "automatic_next_scan",
    repair_code: "backoff_then_retry",
    solution:
      "Allow the normal delayed retry with backoff. If the same source repeats, reduce request frequency or approve a stable alternate official URL; preserve the current baseline.",
    matches: ["http 429", "status 429", "too many requests", "rate limit"],
  },
  {
    code: "persistent_access_block",
    group: "persistent_access",
    label: "Source blocked automated access",
    severity: "warning",
    retry_mode: "manual_source_review",
    repair_code: "verify_access_or_alternate_source",
    solution:
      "Verify the source manually and review its access pattern or an alternate official URL. Do not replace the baseline with an access-denied, CAPTCHA, or security-challenge page.",
    matches: [
      "http 401",
      "http 403",
      "access_blocked",
      "access blocked",
      "access denied",
      "captcha",
      "robot challenge",
      "security_challenge",
      "security challenge",
    ],
  },
  {
    code: "source_gone_or_moved",
    group: "source_gone_or_moved",
    label: "Official source may have moved",
    severity: "warning",
    retry_mode: "manual_source_review",
    repair_code: "verify_replace_or_retire_source",
    solution:
      "Verify whether the official page moved. Replace the URL only with a confirmed official source, or retire it after confirmation; keep the prior baseline as historical evidence.",
    matches: [
      "http 404",
      "http 410",
      "soft_404",
      "soft 404",
      "page not found",
      "redirect loop",
      "too many redirects",
    ],
  },
  {
    code: "capture_blank_or_incomplete",
    group: "evidence_integrity",
    label: "Capture was blank or incomplete",
    severity: "critical",
    retry_mode: "automatic_then_manual",
    repair_code: "retry_capture_then_inspect_rendering",
    solution:
      "Retry once with a fresh browser and normal readiness waits. If it repeats, inspect site-specific rendering before comparison; never write a blank or incomplete capture as the baseline.",
    matches: [
      "blank capture",
      "blank page",
      "empty capture",
      "invalid capture",
      "captured page is empty",
      "captured page was empty",
    ],
  },
  {
    code: "capture_render_or_unsupported",
    group: "capture_runtime",
    label: "Page could not be rendered",
    severity: "warning",
    retry_mode: "automatic_next_scan",
    repair_code: "retry_or_route_content_type",
    solution:
      "Retry the capture in a fresh browser. If the response is a download or unsupported content type, route it to the matching PDF/file capture lane; preserve the existing baseline.",
    matches: [
      "browser has been closed",
      "context has been closed",
      "target page, context or browser has been closed",
      "page crashed",
      "screenshot failed",
      "unsupported content",
      "download content",
      "pdf download failed",
    ],
  },
  {
    code: "network_transient",
    group: "transient_access",
    label: "Transient network failure",
    severity: "warning",
    retry_mode: "automatic_next_scan",
    repair_code: "retry_after_backoff",
    solution:
      "Let the next scheduled scan retry with backoff. Investigate only if the host repeats; preserve the existing baseline and captured evidence.",
    matches: [
      "timeout",
      "timed out",
      "fetch failed",
      "err_name_not_resolved",
      "err_connection",
      "connection reset",
      "socket hang up",
      "http 500",
      "http 502",
      "http 503",
      "http 504",
      "http 522",
      "http 523",
    ],
  },
  {
    code: "localization_evidence_unavailable",
    group: "evidence_integrity",
    label: "Localized evidence was unavailable",
    severity: "warning",
    retry_mode: "targeted_evidence_repair",
    repair_code: "repair_localization_without_promotion",
    solution:
      "Re-run targeted localization only against unchanged evidence. Changed captures must return to the normal review path and must not be absorbed as a localization repair.",
    matches: ["localization", "localized screenshot", "change anchor", "capture geometry"],
  },
];

const UNKNOWN_POLICY = {
  code: "unknown_failure",
  group: "unknown",
  label: "Unclassified worker failure",
  severity: "critical",
  retry_mode: "manual_investigation",
  repair_code: "classify_before_retry",
  solution:
    "Inspect the exact run and retained evidence before retrying. Preserve the baseline and classify the failed stage before automating any mutation.",
};

export function classifyVisualCaptureFailure(error) {
  const message = cleanText(error?.message || error);
  const lower = message.toLowerCase();
  const stageSpecific = FAILURE_POLICIES
    .filter((candidate) => [
      "baseline_evidence_missing_or_invalid",
      "downstream_persistence_failed",
      "storage_sync_failed",
      "capture_blank_or_incomplete",
      "localization_evidence_unavailable",
    ].includes(candidate.code))
    .find((candidate) => candidate.matches.some((pattern) => lower.includes(pattern)));
  const policy = stageSpecific || FAILURE_POLICIES.find((candidate) =>
    candidate.matches.some((pattern) => lower.includes(pattern)),
  ) || UNKNOWN_POLICY;

  return {
    code: policy.code,
    group: policy.group,
    label: policy.label,
    severity: policy.severity,
    retry_mode: policy.retry_mode,
    repair_code: policy.repair_code,
    solution: policy.solution,
  };
}

export function buildVisualRunReportSummary(report = {}) {
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const groups = new Map();
  const sourceIdsByGroup = new Map();

  for (const error of errors) {
    const classification = classifyVisualCaptureFailure(error);
    const current = groups.get(classification.code) || {
      ...classification,
      count: 0,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    };
    current.count += 1;

    const sourceId = cleanText(error?.source_id);
    const seenSourceIds = sourceIdsByGroup.get(classification.code) || new Set();
    if (sourceId && !seenSourceIds.has(sourceId)) {
      seenSourceIds.add(sourceId);
      sourceIdsByGroup.set(classification.code, seenSourceIds);
      current.source_id_count += 1;
      if (current.source_ids.length < MAX_SOURCE_IDS_PER_GROUP) {
        current.source_ids.push(sourceId);
      } else {
        current.source_ids_truncated = true;
      }
    }

    if (current.examples.length < MAX_EXAMPLES_PER_GROUP) {
      current.examples.push({
        source_id: sourceId || null,
        source_url: cleanText(error?.source_url) || null,
        message: truncate(cleanText(error?.message || error), 500),
      });
    }
    groups.set(classification.code, current);
  }

  let failureGroups = [...groups.values()].sort(compareFailureGroups);
  const pagesCaptured = nonNegativeNumber(report.checked);
  const failedSources = nonNegativeNumber(report.failed);
  const unrepresentedFailures = Math.max(0, failedSources - errors.length);
  if (unrepresentedFailures) {
    failureGroups = [...failureGroups, {
      ...UNKNOWN_POLICY,
      count: unrepresentedFailures,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    }].sort(compareFailureGroups);
  }
  const loadedSources = nonNegativeNumber(report.baseline_coverage_start?.loaded_sources) ||
    Math.max(pagesCaptured, failedSources);
  const executionStatus = cleanText(report.status) || "running";
  const operationalStatus = operationalStatusFor({
    executionStatus,
    failedSources,
    incidentCount: errors.length,
  });

  return {
    run_health: {
      schema_version: 2,
      status: operationalStatus,
      execution_status: executionStatus,
      loaded_sources: loadedSources,
      pages_captured: pagesCaptured,
      source_failures: failedSources,
      incident_count: errors.length,
      failure_rate_percent: loadedSources
        ? roundPercent((failedSources / loadedSources) * 100)
        : 0,
      requires_attention: ["blocked", "degraded", "failed"].includes(operationalStatus),
    },
    failure_groups: failureGroups,
    repair_plan: buildRepairPlan(failureGroups),
  };
}

export function annotateVisualRunReport(report) {
  const summary = buildVisualRunReportSummary(report);
  report.report_schema_version = 2;
  report.run_health = summary.run_health;
  report.failure_groups = summary.failure_groups;
  report.repair_plan = summary.repair_plan;
  return report;
}

export function buildNightlyVisualReport(reports, options = {}) {
  const candidates = (Array.isArray(reports) ? reports : [])
    .filter(isDailyVisualShardReport)
    .map((report) => annotateVisualRunReport({ ...report }));
  const monitoringDate = cleanText(options.monitoringDate) || latestMonitoringDate(candidates);
  const generatedAt = cleanText(options.generatedAt) || new Date().toISOString();
  const generatedAtMs = dateMs(generatedAt);
  const windowReports = candidates.filter(
    (report) => monitoringDateForTimestamp(report.started_at) === monitoringDate,
  );
  const canonicalByShard = new Map();

  for (const report of windowReports.sort(compareRunStartedDescending)) {
    const shardIndex = reportShardIndex(report);
    if (shardIndex === null || canonicalByShard.has(shardIndex)) continue;
    canonicalByShard.set(shardIndex, report);
  }

  const shards = [...canonicalByShard.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shardIndex, report]) => {
      const executionStatus = cleanText(report.status) || "unknown";
      const heartbeatAt = cleanText(report.heartbeat_at) || cleanText(report.started_at);
      const heartbeatAgeMs = generatedAtMs - dateMs(heartbeatAt);
      const stalled = executionStatus === "running" &&
        heartbeatAgeMs >= RUN_HEARTBEAT_STALE_MS;
      return {
        shard_index: shardIndex,
        shard_number: shardIndex + 1,
        shard_count: reportShardCount(report),
        started_at: report.started_at || null,
        heartbeat_at: heartbeatAt || null,
        finished_at: report.finished_at || null,
        execution_status: executionStatus,
        operational_status: stalled ? "failed" : report.run_health.status,
        checked: nonNegativeNumber(report.checked),
        failed: nonNegativeNumber(report.failed),
        loaded: nonNegativeNumber(report.baseline_coverage_start?.loaded_sources) ||
          Math.max(nonNegativeNumber(report.checked), nonNegativeNumber(report.failed)),
        incident_count: nonNegativeNumber(report.run_health.incident_count),
        attempt_id: cleanText(report.run_identity?.attempt_id) || null,
        stalled,
      };
    });
  const expectedShardCount = Math.max(
    3,
    ...windowReports.map(reportShardCount),
  );
  const missingShards = Array.from({ length: expectedShardCount }, (_, index) => index)
    .filter((index) => !canonicalByShard.has(index))
    .map((index) => index + 1);
  let failureGroups = mergeFailureGroups(
    [...canonicalByShard.values()].flatMap((report) => report.failure_groups || []),
  );
  const pagesCaptured = sum(shards.map((shard) => shard.checked));
  const failedSources = sum(shards.map((shard) => shard.failed));
  const loadedSources = sum(shards.map((shard) => shard.loaded));
  const hasFatalShard = shards.some((shard) =>
    ["blocked", "failed"].includes(shard.operational_status),
  );
  const hasRunningShard = shards.some((shard) => shard.execution_status === "running");
  let status = "healthy";
  if (hasFatalShard) status = "failed";
  else if (hasRunningShard) status = "running";
  else if (missingShards.length) status = "incomplete";
  else if (failedSources > 0 || failureGroups.length > 0) status = "degraded";
  const stalledShards = shards.filter((shard) => shard.stalled);
  if (stalledShards.length) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "stalled_shard",
      group: "platform_dependency",
      label: "Shard heartbeat stopped",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "inspect_then_restart_stalled_shard",
      solution:
        "Inspect the shard log and process lock, repair the blocking dependency, then restart only the stalled shard. Do not rerun completed shards.",
      count: stalledShards.length,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    }]);
  }
  if (missingShards.length) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "missing_shard",
      group: "platform_dependency",
      label: "Scheduled shard did not report",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "inspect_task_then_start_missing_shard",
      solution:
        "Check the missing shard's Windows Scheduled Task result and wrapper log, repair the launch failure, then start only that shard.",
      count: missingShards.length,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    }]);
  }

  return {
    report_schema_version: 2,
    report_type: "visual_nightly_capture",
    generated_at: generatedAt,
    monitoring_date: monitoringDate || null,
    timezone: "America/Chicago",
    status,
    expected_shards: expectedShardCount,
    observed_shards: shards.length,
    completed_shards: shards.filter((shard) => shard.execution_status !== "running").length,
    missing_shards: missingShards,
    totals: {
      loaded_sources: loadedSources,
      pages_captured: pagesCaptured,
      source_failures: failedSources,
      incident_count: sum(shards.map((shard) => shard.incident_count)),
      failure_rate_percent: loadedSources
        ? roundPercent((failedSources / loadedSources) * 100)
        : 0,
    },
    shards,
    failure_groups: failureGroups,
    repair_plan: buildRepairPlan(failureGroups),
    summary: nightlySummary({
      status,
      completedShards: shards.filter((shard) => shard.execution_status !== "running").length,
      expectedShardCount,
      pagesCaptured,
      failedSources,
      missingShards,
    }),
  };
}

export function isDailyVisualShardReport(report = {}) {
  const options = record(report.options);
  const identity = record(report.run_identity);
  const trigger = cleanText(identity.trigger || options.run_trigger);
  const shardCount = reportShardCount(report);
  if (shardCount <= 1) return false;
  if (trigger ? trigger !== "scheduled" : chicagoHourForTimestamp(report.started_at) !== 18) {
    return false;
  }
  return ![
    options.baseline_refresh,
    options.complete_missing_baselines,
    options.localization_repair,
    options.r2_backfill_baselines,
    options.discovery_mode,
    options.source_id,
    options.source_url,
    options.award,
  ].some(Boolean);
}

export function monitoringDateForTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const localDate = new Date(Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
  ));
  if (Number(byType.get("hour")) < 18) localDate.setUTCDate(localDate.getUTCDate() - 1);
  return localDate.toISOString().slice(0, 10);
}

export function monitoringDateForVisualReportFilename(name) {
  const match = String(name || "").match(
    /^visual-snapshot-run-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-|\.json$)/i,
  );
  if (!match) return "";
  return monitoringDateForTimestamp(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
}

export async function acquireFileLock(lockPath, timeoutMs = 30_000) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const startedAt = Date.now();

  while (true) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, JSON.stringify({
        token,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }), "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      return () => releaseFileLock(lockPath, token);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // ignore close failures while unwinding a failed acquisition
        }
      }
      if (error?.code !== "EEXIST") throw error;
      recoverAbandonedFileLock(lockPath);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await delay(100 + Math.floor(Math.random() * 150));
    }
  }
}

export function shouldReplaceLatestNightlyReport(currentReport, candidateReport) {
  const currentDate = cleanText(currentReport?.monitoring_date);
  const candidateDate = cleanText(candidateReport?.monitoring_date);
  if (!candidateDate) return false;
  return !currentDate || candidateDate >= currentDate;
}

function operationalStatusFor({ executionStatus, failedSources, incidentCount }) {
  if (executionStatus === "running") return "running";
  if (executionStatus === "blocked") return "blocked";
  if (executionStatus === "failed") return "failed";
  if (failedSources > 0 || incidentCount > 0) return "degraded";
  return "healthy";
}

function buildRepairPlan(failureGroups) {
  return {
    requires_operator: failureGroups.some((group) =>
      !["automatic_next_scan"].includes(group.retry_mode),
    ),
    actions: failureGroups.map((group) => ({
      repair_code: group.repair_code,
      failure_code: group.code,
      label: group.label,
      affected_count: group.count,
      source_id_count: group.source_id_count,
      retry_mode: group.retry_mode,
      severity: group.severity,
      solution: group.solution,
    })),
  };
}

function mergeFailureGroups(groups) {
  const merged = new Map();
  for (const group of groups) {
    if (!group?.code) continue;
    const current = merged.get(group.code) || {
      code: group.code,
      group: group.group,
      label: group.label,
      severity: group.severity,
      retry_mode: group.retry_mode,
      repair_code: group.repair_code,
      solution: group.solution,
      count: 0,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    };
    current.count += nonNegativeNumber(group.count);
    current.source_id_count += nonNegativeNumber(group.source_id_count) ||
      (Array.isArray(group.source_ids) ? group.source_ids.length : 0);
    for (const sourceId of Array.isArray(group.source_ids) ? group.source_ids : []) {
      if (!sourceId || current.source_ids.includes(sourceId)) continue;
      if (current.source_ids.length < MAX_SOURCE_IDS_PER_GROUP) current.source_ids.push(sourceId);
      else current.source_ids_truncated = true;
    }
    current.source_ids_truncated ||= Boolean(group.source_ids_truncated);
    for (const example of Array.isArray(group.examples) ? group.examples : []) {
      if (current.examples.length >= MAX_EXAMPLES_PER_GROUP) break;
      current.examples.push(example);
    }
    merged.set(group.code, current);
  }
  return [...merged.values()].sort(compareFailureGroups);
}

function nightlySummary({
  status,
  completedShards,
  expectedShardCount,
  pagesCaptured,
  failedSources,
  missingShards,
}) {
  if (status === "failed") {
    return `The 6 PM scan failed. ${completedShards}/${expectedShardCount} shards reported; ${failedSources} source failures require attention.`;
  }
  if (status === "running") {
    return `The 6 PM scan is running. ${completedShards}/${expectedShardCount} shards have completed.`;
  }
  if (status === "incomplete") {
    return `The 6 PM scan is incomplete. Missing ${missingShards.map((number) => `shard ${number}`).join(", ")}.`;
  }
  if (status === "degraded") {
    return `All ${expectedShardCount} shards completed, captured ${pagesCaptured} pages, and recorded ${failedSources} source failures.`;
  }
  return `All ${expectedShardCount} shards completed, captured ${pagesCaptured} pages, and recorded no source failures.`;
}

function reportShardIndex(report) {
  const options = record(report.options);
  const identity = record(report.run_identity);
  const parsed = numberOrNull(identity.shard_index ?? options.shard_index);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : null;
}

function reportShardCount(report) {
  const options = record(report.options);
  const identity = record(report.run_identity);
  const parsed = numberOrNull(identity.shard_count ?? options.shard_count);
  return parsed !== null && parsed > 0 ? Math.floor(parsed) : 1;
}

function latestMonitoringDate(reports) {
  return [...reports]
    .sort(compareRunStartedDescending)
    .map((report) => monitoringDateForTimestamp(report.started_at))
    .find(Boolean) || "";
}

function compareRunStartedDescending(left, right) {
  return dateMs(right.started_at) - dateMs(left.started_at);
}

function compareFailureGroups(left, right) {
  const severity = { critical: 2, warning: 1 };
  return (severity[right.severity] || 0) - (severity[left.severity] || 0) ||
    nonNegativeNumber(right.count) - nonNegativeNumber(left.count) ||
    String(left.code).localeCompare(String(right.code));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}

function sum(values) {
  return values.reduce((total, value) => total + nonNegativeNumber(value), 0);
}

function dateMs(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function chicagoHourForTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return -1;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value);
}

function recoverAbandonedFileLock(lockPath) {
  const owner = readLockOwner(lockPath);
  if (owner?.pid && processIsAlive(owner.pid)) return;

  let oldEnough = Boolean(owner?.pid);
  if (!oldEnough) {
    try {
      oldEnough = Date.now() - statSync(lockPath).mtimeMs >= 2 * 60 * 1000;
    } catch {
      return;
    }
  }
  if (!oldEnough) return;

  const abandonedPath = `${lockPath}.abandoned-${randomUUID()}`;
  try {
    renameSync(lockPath, abandonedPath);
    rmSync(abandonedPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

function releaseFileLock(lockPath, token) {
  if (readLockOwner(lockPath)?.token !== token) return;
  rmSync(lockPath, { force: true });
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
