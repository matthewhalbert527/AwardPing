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
import { isScheduledNightlyVisualRun } from "./visual-nightly-run-contract.mjs";
import {
  validateVisualSourceInventoryCohort,
  validateVisualSourceInventoryProof,
} from "./visual-source-inventory-proof.mjs";

const MAX_EXAMPLES_PER_GROUP = 3;
const MAX_SOURCE_IDS_PER_GROUP = 500;
const RUN_HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-report.v1";
const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_REPORT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-report.v1";
const STAGE1_EVIDENCE_SCHEMA_UPGRADE_CLEAR_RESULT_STATUSES = new Set([
  "dry_run_already_upgraded",
  "already_upgraded",
  "dry_run_ready",
  "upgraded_and_queued",
  "upgraded",
  "candidate_queued",
]);

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
    code: "browser_network_policy_refusal",
    group: "network_safety",
    label: "Browser dependency violated the public-network policy",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "verify_public_network_dependency",
    solution:
      "Keep the current baseline and inspect the official page dependency that was refused. Correct or remove the unsafe dependency only after verification; never allow private, local, or reserved network access merely to make the capture pass.",
    matches: [
      "resource=browser_network_policy",
      "public_network_policy_refusal",
      "public network policy refused",
      "browser network policy",
    ],
  },
  {
    code: "browser_network_settle_timeout",
    group: "network_safety",
    label: "Browser network validation did not settle",
    severity: "critical",
    retry_mode: "automatic_once_then_operator",
    repair_code: "retry_fresh_proxy_then_inspect_dns",
    solution:
      "The worker retries once with a fresh browser and proxy at no API charge. If it repeats, keep the current baseline and inspect slow DNS or a hanging page dependency; never publish evidence while a network-policy decision is still in flight.",
    matches: [
      "resource=browser_network_settle",
      "awardping_proxy_settle_timeout",
      "network-policy evaluation did not settle",
    ],
  },
  {
    code: "browser_capture_boundary_shutdown",
    group: "network_safety",
    label: "Source browser boundary could not close cleanly",
    severity: "critical",
    retry_mode: "automatic_once_then_operator",
    repair_code: "retry_fresh_browser_then_inspect_shutdown",
    solution:
      "The worker retries once with a fresh browser and proxy at no API charge. If shutdown fails again, keep the current baseline and inspect the browser process or page dependency; never reuse or publish evidence from the failed source boundary.",
    matches: [
      "resource=browser_context_shutdown",
      "resource=browser_proxy_shutdown",
      "awardping_capture_context_shutdown",
      "awardping_capture_proxy_shutdown",
    ],
  },
  {
    code: "capture_resource_limit",
    group: "evidence_integrity",
    label: "Capture exceeded a guarded resource limit",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "inspect_capture_resource_limit",
    solution:
      "Keep the current baseline and inspect the official page for runaway, infinite, or unexpectedly duplicated content. Change the configured cap only after operator review; never publish partial evidence to clear the failure.",
    matches: ["capture_resource_limit", "awardping_capture_resource_limit"],
  },
  {
    code: "pdf_size_or_page_limit",
    group: "evidence_integrity",
    label: "PDF exceeded the guarded size or page limit",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "inspect_pdf_size_or_page_limit",
    solution:
      "Keep the current baseline and verify that the oversized PDF is the intended official document. Increase a limit only after operator review and a safe targeted test; never publish a truncated PDF as complete evidence.",
    matches: [
      "pdf is too large",
      "pdf has ",
      "pdf page limit",
      "awardping_pdf_page_limit",
    ],
  },
  {
    code: "pdf_parse_or_cleanup_failure",
    group: "evidence_integrity",
    label: "PDF parsing or cleanup failed",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "inspect_pdf_parser_time_limit",
    solution:
      "Keep the current baseline and inspect the retained PDF before a targeted parser retry. Adjust the parser time limit only after operator review; never publish missing or partial PDF text as complete evidence.",
    matches: [
      "pdf text parsing exceeded",
      "pdf text parsing failed",
      "pdf parser cleanup exceeded",
      "pdf text parsing timed out",
      "pdf parser cleanup timed out",
      "pdf parse timeout",
      "pdf cleanup timeout",
      "awardping_pdf_parse_failed",
    ],
  },
  {
    code: "pdf_discovery_scan_incomplete",
    group: "evidence_integrity",
    label: "PDF discovery scan retained as incomplete",
    severity: "warning",
    retry_mode: "automatic_next_scan",
    repair_code: "rescan_pdf_discovery_next_run",
    solution:
      "No action needed: an incomplete or failed discovery scan is deliberately retained without advancing the historical seed watermark, page evidence is unaffected, and the next scheduled scan retries discovery from the prior seed. Investigate only if the same source stays incomplete across many runs.",
    matches: [
      "pdf discovery scan was retained as incomplete",
      "pdf discovery dom scan failed and was left unseeded",
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
      "browser_network_policy_refusal",
      "browser_network_settle_timeout",
      "browser_capture_boundary_shutdown",
      "capture_resource_limit",
      "pdf_size_or_page_limit",
      "pdf_parse_or_cleanup_failure",
      "pdf_discovery_scan_incomplete",
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

  let failureGroups = [
    ...groups.values(),
    ...stage1EvidenceSchemaUpgradeFailureGroups(report),
  ].sort(compareFailureGroups);
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
  const processedSources = pagesCaptured + failedSources +
    nonNegativeNumber(report.skipped_existing_baseline) +
    nonNegativeNumber(report.skipped_pdf);
  const inventoryProofRequired = isDailyVisualShardReport(report);
  const inventoryProof = validateVisualSourceInventoryProof(report.source_inventory, {
    shardCount: reportShardCount(report),
    shardIndex: reportShardIndex(report) ?? undefined,
  });
  const inventoryProofComplete = !inventoryProofRequired || inventoryProof.complete;
  const inventoryComplete = loadedSources > 0 && processedSources === loadedSources &&
    inventoryProofComplete;
  const reportedStatus = cleanText(report.status) || "running";
  const executionStatus = cleanText(report.execution_status) ||
    cleanText(report.run_health?.execution_status) || reportedStatus;
  const initialOperationalStatus = operationalStatusFor({
    reportedStatus,
    executionStatus,
    loadedSources,
    pagesCaptured,
    failedSources,
    incidentCount: errors.length,
    inventoryComplete,
  });
  if (
    !["running", "blocked", "failed", "recovery_required"].includes(executionStatus)
    && !inventoryComplete
  ) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "source_inventory_empty_or_incomplete",
      group: "platform_dependency",
      label: "Scheduled source inventory was not fully processed",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "verify_inventory_then_restart_shard",
      solution:
        "Compare the shard's loaded and processed source inventory, repair the source query or interrupted loop, then restart only that shard. A zero-page run never proves a healthy scan.",
      count: 1,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    }]);
  }
  if (
    inventoryProofRequired &&
    !inventoryProof.complete &&
    !["running", "blocked", "recovery_required"].includes(executionStatus)
  ) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "source_inventory_proof_missing_or_mismatched",
      group: "platform_dependency",
      label: "Authoritative source inventory proof is missing or mismatched",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "verify_authoritative_inventory_then_restart_shard",
      solution:
        "Compare the independently enumerated global and partition source hashes with the shard's loaded-source hash. Repair the source query or shard launcher, then restart only the affected shard.",
      count: 1,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [{
        source_id: null,
        source_url: null,
        message: `Inventory proof failed: ${inventoryProof.reason}.`,
      }],
    }]);
  }

  const repairPlan = buildRepairPlan(failureGroups);
  const operationalStatus =
    initialOperationalStatus === "healthy" && repairPlan.requires_operator
      ? "degraded"
      : initialOperationalStatus;

  return {
    run_health: {
      schema_version: 2,
      status: operationalStatus,
      execution_status: executionStatus,
      loaded_sources: loadedSources,
      processed_sources: processedSources,
      inventory_complete: inventoryComplete,
      inventory_proof_required: inventoryProofRequired,
      inventory_proof_complete: inventoryProofComplete,
      inventory_proof_reason: inventoryProofRequired ? inventoryProof.reason : "not_required",
      pages_captured: pagesCaptured,
      source_failures: failedSources,
      incident_count: errors.length,
      failure_rate_percent: loadedSources
        ? roundPercent((failedSources / loadedSources) * 100)
        : 0,
      requires_attention: ["blocked", "degraded", "failed"].includes(operationalStatus),
    },
    failure_groups: failureGroups,
    repair_plan: repairPlan,
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

export function visualRunTerminalDisposition(report = {}, executionStatus = "succeeded") {
  const normalizedExecutionStatus = cleanText(executionStatus) || "succeeded";
  if (normalizedExecutionStatus !== "succeeded") {
    return {
      report_status: normalizedExecutionStatus,
      execution_status: normalizedExecutionStatus,
      worker_status: normalizedExecutionStatus === "running" ? "running" : "failed",
    };
  }

  const pagesCaptured = nonNegativeNumber(report.checked);
  const failedSources = nonNegativeNumber(report.failed);
  const loadedSources = nonNegativeNumber(report.baseline_coverage_start?.loaded_sources) ||
    Math.max(pagesCaptured, failedSources);
  const allLoadedSourcesFailed = failedSources > 0 && pagesCaptured === 0 &&
    loadedSources > 0 && failedSources >= loadedSources;

  return {
    report_status: allLoadedSourcesFailed
      ? "failed"
      : failedSources > 0
        ? "degraded"
        : "succeeded",
    execution_status: "succeeded",
    // local_worker_runs intentionally has no "degraded" enum value. Persist a
    // non-success terminal status whenever any source failed, then use
    // metadata.run_health to distinguish degraded completion from execution
    // failure for operators and downstream reporting.
    worker_status: failedSources > 0 ? "failed" : "succeeded",
  };
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

  const expectedShardCount = Math.max(
    3,
    ...windowReports.map(reportShardCount),
  );

  const shards = [...canonicalByShard.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shardIndex, report]) => {
      const executionStatus = cleanText(report.execution_status) ||
        cleanText(report.run_health?.execution_status) || cleanText(report.status) || "unknown";
      const heartbeatAt = cleanText(report.heartbeat_at) || cleanText(report.started_at);
      const heartbeatAgeMs = generatedAtMs - dateMs(heartbeatAt);
      const stalled = executionStatus === "running" &&
        heartbeatAgeMs >= RUN_HEARTBEAT_STALE_MS;
      const checked = nonNegativeNumber(report.checked);
      const failed = nonNegativeNumber(report.failed);
      const loaded = nonNegativeNumber(report.baseline_coverage_start?.loaded_sources) ||
        Math.max(checked, failed);
      const processed = checked + failed +
        nonNegativeNumber(report.skipped_existing_baseline) +
        nonNegativeNumber(report.skipped_pdf);
      const inventoryProof = validateVisualSourceInventoryProof(report.source_inventory, {
        shardCount: expectedShardCount,
        shardIndex,
      });
      const inventoryComplete = loaded > 0 && processed === loaded && inventoryProof.complete;
      return {
        shard_index: shardIndex,
        shard_number: shardIndex + 1,
        shard_count: reportShardCount(report),
        started_at: report.started_at || null,
        heartbeat_at: heartbeatAt || null,
        finished_at: report.finished_at || null,
        execution_status: executionStatus,
        operational_status: stalled
          ? "failed"
          : executionStatus === "running"
            ? "running"
            : !inventoryComplete
              ? "failed"
              : report.run_health.status,
        checked,
        failed,
        loaded,
        processed,
        inventory_complete: inventoryComplete,
        inventory_proof_complete: inventoryProof.complete,
        inventory_proof_reason: inventoryProof.reason,
        global_source_count: inventoryProof.globalCount,
        global_source_ids_sha256: inventoryProof.globalHash,
        expected_shard_source_count: inventoryProof.expectedShardCount,
        expected_shard_source_ids_sha256: inventoryProof.expectedShardHash,
        loaded_shard_source_count: inventoryProof.loadedShardCount,
        loaded_shard_source_ids_sha256: inventoryProof.loadedShardHash,
        incident_count: nonNegativeNumber(report.run_health.incident_count),
        attempt_id: cleanText(report.run_identity?.attempt_id) || null,
        stalled,
      };
    });
  const inventoryProof = validateVisualSourceInventoryCohort(
    [...canonicalByShard.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, report]) => report.source_inventory),
    expectedShardCount,
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
  const incompleteInventoryShards = shards.filter((shard) => !shard.inventory_complete);
  const inventoryGapShards = incompleteInventoryShards.filter((shard) =>
    shard.execution_status !== "running" && !shard.inventory_complete);
  let status = "healthy";
  if (hasFatalShard) status = "failed";
  else if (hasRunningShard) status = "running";
  else if (missingShards.length) status = "incomplete";
  else if (!inventoryProof.complete) status = "failed";
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
  if (inventoryGapShards.length && !failureGroups.some((group) =>
    group.code === "source_inventory_empty_or_incomplete")) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "source_inventory_empty_or_incomplete",
      group: "platform_dependency",
      label: "Scheduled source inventory was not fully processed",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "verify_inventory_then_restart_shard",
      solution:
        "Compare each shard's loaded and processed source inventory, repair the source query or interrupted loop, then restart only the affected shard. A zero-page run never proves a healthy scan.",
      count: inventoryGapShards.length,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [],
    }]);
  }
  if (!inventoryProof.complete && shards.length === expectedShardCount && !hasRunningShard) {
    failureGroups = mergeFailureGroups([...failureGroups, {
      code: "source_inventory_proof_missing_or_mismatched",
      group: "platform_dependency",
      label: "Authoritative source inventory proofs do not form one exact cohort",
      severity: "critical",
      retry_mode: "repair_then_restart_shard",
      repair_code: "verify_authoritative_inventory_then_restart_shard",
      solution:
        "Require all three shards to attest the same non-empty global source count and hash, matching partition hashes, exact loaded hashes, and a partition-count sum equal to the global count.",
      count: 1,
      source_ids: [],
      source_id_count: 0,
      source_ids_truncated: false,
      examples: [{
        source_id: null,
        source_url: null,
        message: `Inventory cohort proof failed: ${inventoryProof.reason}.`,
      }],
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
      inventory_complete: shards.length === expectedShardCount &&
        incompleteInventoryShards.length === 0 && inventoryProof.complete,
      inventory_proof_complete: inventoryProof.complete,
      global_source_count: inventoryProof.globalCount,
      global_source_ids_sha256: inventoryProof.globalHash,
      partition_source_count_sum: inventoryProof.partitionCountSum,
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
      failureGroups,
    }),
  };
}

export function isDailyVisualShardReport(report = {}) {
  const options = record(report.options);
  const identity = record(report.run_identity);
  const shardCount = reportShardCount(report);
  if (shardCount <= 1) return false;
  return isScheduledNightlyVisualRun({
    startedAt: report.started_at,
    runIdentity: identity,
    options,
  });
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

function operationalStatusFor({
  reportedStatus,
  executionStatus,
  loadedSources,
  pagesCaptured,
  failedSources,
  incidentCount,
  inventoryComplete,
}) {
  if (executionStatus === "running") return "running";
  if (executionStatus === "recovery_required") return "blocked";
  if (executionStatus === "blocked") return "blocked";
  if (executionStatus === "failed") return "failed";
  if (reportedStatus === "failed") return "failed";
  if (!inventoryComplete) return "failed";
  if (
    failedSources > 0 && pagesCaptured === 0 && loadedSources > 0 &&
    failedSources >= loadedSources
  ) return "failed";
  if (reportedStatus === "degraded") return "degraded";
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

function stage1EvidenceSchemaUpgradeFailureGroups(report) {
  return [
    ...stage1EvidenceSchemaUpgradeLegacyFailureGroups(report),
    ...stage1EvidenceSchemaUpgradeReviewedApplyFailureGroups(report),
  ];
}

function stage1EvidenceSchemaUpgradeLegacyFailureGroups(report) {
  const upgrade = report?.stage1_evidence_schema_upgrade;
  if (
    !upgrade
    || typeof upgrade !== "object"
    || Array.isArray(upgrade)
    || upgrade.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA
  ) {
    return [];
  }

  const results = Array.isArray(upgrade.results) ? upgrade.results : [];
  const affectedResults = results.filter((result) => (
    !STAGE1_EVIDENCE_SCHEMA_UPGRADE_CLEAR_RESULT_STATUSES.has(
      cleanText(result?.status),
    )
  ));
  const reportedBlocked = Math.floor(nonNegativeNumber(upgrade.blocked_source_count));
  const reportedQuarantined = Math.floor(
    nonNegativeNumber(upgrade.quarantined_work_remaining),
  );
  const affectedCount = Math.max(
    reportedBlocked,
    reportedQuarantined,
    affectedResults.length,
  );
  if (affectedCount === 0) return [];

  const sourceIds = [...new Set(affectedResults
    .map((result) => cleanText(result?.source_id))
    .filter(Boolean))];
  const examples = affectedResults.slice(0, MAX_EXAMPLES_PER_GROUP).map((result) => {
    const status = cleanText(result?.status) || "unknown_status";
    const reason = cleanText(result?.reason_code)
      || cleanText(result?.capture_validation?.reason)
      || "reason_not_reported";
    return {
      source_id: cleanText(result?.source_id) || null,
      source_url: null,
      message: truncate(`Stage 1 result ${status}: ${reason}.`, 500),
    };
  });
  if (examples.length === 0) {
    examples.push({
      source_id: null,
      source_url: null,
      message: `Stage 1 reported ${affectedCount} non-clear evidence-schema upgrade result(s).`,
    });
  }

  return [{
    code: "stage1_evidence_schema_upgrade_work_remaining",
    group: "evidence_integrity",
    label: "Stage 1 evidence-schema upgrade needs reviewed follow-up",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "review_stage1_evidence_schema_upgrade_work",
    solution:
      "Review each non-clear Stage 1 result and its immutable evidence. Keep quarantined sources held, reconcile any exact active recovery journal before a new capture, and repair the cited source, acquisition, or baseline binding, then rerun the exact reviewed dry-run. Do not run apply or clear a hold until every remaining disposition is explicitly reviewed.",
    count: affectedCount,
    source_ids: sourceIds.slice(0, MAX_SOURCE_IDS_PER_GROUP),
    source_id_count: sourceIds.length,
    source_ids_truncated: sourceIds.length > MAX_SOURCE_IDS_PER_GROUP,
    examples,
  }];
}

function stage1EvidenceSchemaUpgradeReviewedApplyFailureGroups(report) {
  const apply = report?.stage1_evidence_schema_upgrade_reviewed_apply;
  if (
    !apply
    || typeof apply !== "object"
    || Array.isArray(apply)
    || apply.schema_version
      !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_REPORT_SCHEMA
  ) {
    return [];
  }

  const selectedStatus = cleanText(apply.selected?.status || apply.status);
  const selectedSourceId = cleanText(
    apply.selected?.source_id || apply.selected_source_id,
  );
  const selectedNeedsWork = selectedStatus !== "selected_completed";
  const deferredSourceIds = [...new Set(
    (Array.isArray(apply.deferred_source_ids) ? apply.deferred_source_ids : [])
      .map(cleanText)
      .filter(Boolean),
  )];
  const reportedDeferred = Math.floor(nonNegativeNumber(apply.deferred_source_count));
  const reportedBlocked = Math.floor(nonNegativeNumber(apply.blocked_source_count));
  const affectedCount = Math.max(
    reportedDeferred + (selectedNeedsWork ? 1 : 0),
    deferredSourceIds.length + (selectedNeedsWork && selectedSourceId ? 1 : 0),
    reportedBlocked + reportedDeferred,
  );
  if (affectedCount === 0) return [];

  const sourceIds = [...new Set([
    ...(selectedNeedsWork && selectedSourceId ? [selectedSourceId] : []),
    ...deferredSourceIds,
  ])];
  const examples = [];
  if (selectedNeedsWork) {
    examples.push({
      source_id: selectedSourceId || null,
      source_url: null,
      message: truncate(
        `Reviewed exact-one Stage 1 apply ended ${selectedStatus || "unknown_status"}: ${cleanText(apply.selected?.reason_code || apply.reason_code) || "reason_not_reported"}.`,
        500,
      ),
    });
  }
  for (const sourceId of deferredSourceIds) {
    if (examples.length >= MAX_EXAMPLES_PER_GROUP) break;
    examples.push({
      source_id: sourceId,
      source_url: null,
      message:
        "This source was explicitly deferred by the reviewed exact-one apply plan and remains outside its mutation authority.",
    });
  }

  return [{
    code: "stage1_evidence_schema_upgrade_work_remaining",
    group: "evidence_integrity",
    label: "Stage 1 evidence-schema upgrade needs reviewed follow-up",
    severity: "critical",
    retry_mode: "operator_guarded",
    repair_code: "review_stage1_evidence_schema_upgrade_work",
    solution:
      "Keep every deferred source unchanged. Review a fresh exact-nine dry-run before creating another exact-one apply plan. If the selected source reports recovery_required, reconcile its exact journal and authority before any new capture or retry; never broaden the completed plan or clear a hold implicitly.",
    count: affectedCount,
    source_ids: sourceIds.slice(0, MAX_SOURCE_IDS_PER_GROUP),
    source_id_count: sourceIds.length,
    source_ids_truncated: sourceIds.length > MAX_SOURCE_IDS_PER_GROUP,
    examples,
  }];
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
  failureGroups,
}) {
  if (status === "failed") {
    const primaryFailure = failureGroups?.find((group) =>
      group.code === "source_inventory_proof_missing_or_mismatched") || failureGroups?.[0];
    const reason = cleanText(primaryFailure?.label) || "A shard or required inventory check failed";
    return `The 6 PM scan failed: ${reason}. ${completedShards}/${expectedShardCount} shards reported; ${failedSources} source failures require attention.`;
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
