import { createHash } from "node:crypto";

export function validateHistoricalLocalizationInventory(
  report,
  { requireAudited = false } = {},
) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return invalidInventory("report_not_an_object");
  }
  if (requireAudited && report.audited !== true) {
    return invalidInventory("audit_not_complete");
  }
  if (report.version !== 2) {
    return invalidInventory("unsupported_report_version");
  }
  if (report.report_type !== "legacy_source_pointer_layout_maintenance") {
    return invalidInventory("unsupported_report_type");
  }
  if (report.metric_scope !== "source_pointer_layout_metadata_not_event_crop") {
    return invalidInventory("unsupported_metric_scope");
  }
  if (report.verified_event_crop_metric !== false || report.apply !== false) {
    return invalidInventory("report_mode_is_not_read_only_layout_inventory");
  }

  const startedAt = Date.parse(String(report.started_at || ""));
  const finishedAt = Date.parse(String(report.finished_at || ""));
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt
  ) {
    return invalidInventory("report_timestamp_missing_or_invalid");
  }

  const scope = report.inventory_scope;
  if (
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    scope.kind !== "all_active_open_monitorable_sources" ||
    scope.truncated !== false ||
    !Number.isInteger(scope.requested_source_limit) ||
    scope.requested_source_limit <= 0 ||
    !Number.isInteger(scope.database_sources_loaded) ||
    scope.database_sources_loaded < 0 ||
    scope.database_sources_loaded > scope.requested_source_limit
  ) {
    return invalidInventory("inventory_scope_is_not_complete");
  }

  const integerFields = [
    "source_count",
    "visual_versions_required",
    "accounted_for_versions",
    "repair_needed_versions",
    "latest_repair_needed",
    "previous_repair_needed",
    "historical_layout_unavailable",
    "r2_meta_errors",
    "work_source_count",
  ];
  if (
    integerFields.some(
      (field) =>
        typeof report[field] !== "number" ||
        !Number.isInteger(report[field]) ||
        report[field] < 0,
    )
  ) {
    return invalidInventory("completion_counts_missing_or_invalid");
  }
  if (
    report.automated_localization_complete !== true ||
    report.source_count > scope.database_sources_loaded ||
    report.accounted_for_versions !== report.visual_versions_required ||
    report.accounted_for_percent !== 100 ||
    report.repair_needed_versions !== 0 ||
    report.latest_repair_needed !== 0 ||
    report.previous_repair_needed !== 0 ||
    report.r2_meta_errors !== 0 ||
    report.work_source_count !== 0
  ) {
    return invalidInventory("localization_inventory_is_not_complete");
  }
  for (const field of [
    "repair_source_ids",
    "latest_repair_source_ids",
    "previous_repair_source_ids",
    "work_source_ids",
  ]) {
    if (!Array.isArray(report[field]) || report[field].length !== 0) {
      return invalidInventory("localization_work_inventory_is_not_empty");
    }
  }

  const declaredCount = report.historical_layout_unavailable;
  if (
    typeof declaredCount !== "number" ||
    !Number.isInteger(declaredCount) ||
    declaredCount < 0
  ) {
    return invalidInventory("declared_count_missing_or_invalid");
  }
  if (!Array.isArray(report.historical_fallback_source_ids)) {
    return invalidInventory("source_id_inventory_missing");
  }

  const cleanedSourceIds = report.historical_fallback_source_ids.map((value) =>
    typeof value === "string" ? value.trim() : "",
  );
  if (cleanedSourceIds.some((value) => !value)) {
    return invalidInventory("source_id_inventory_contains_invalid_value");
  }
  const sourceIds = [...new Set(cleanedSourceIds)].sort();
  if (sourceIds.length !== cleanedSourceIds.length) {
    return invalidInventory("source_id_inventory_contains_duplicates");
  }
  if (sourceIds.length !== declaredCount) {
    return invalidInventory("declared_count_does_not_match_source_ids");
  }
  if (declaredCount > report.source_count) {
    return invalidInventory("historical_count_exceeds_source_scope");
  }

  return {
    complete: true,
    reason: null,
    declaredCount,
    sourceIds,
  };
}

export function historicalLocalizationInventoryDigest(report) {
  const inventory = validateHistoricalLocalizationInventory(report);
  if (!inventory.complete) {
    throw new Error(`Invalid historical localization inventory: ${inventory.reason}`);
  }

  const canonical = {
    version: report.version,
    report_type: report.report_type,
    metric_scope: report.metric_scope,
    verified_event_crop_metric: report.verified_event_crop_metric,
    started_at: new Date(report.started_at).toISOString(),
    finished_at: new Date(report.finished_at).toISOString(),
    apply: report.apply,
    inventory_scope: {
      kind: report.inventory_scope.kind,
      requested_source_limit: report.inventory_scope.requested_source_limit,
      database_sources_loaded: report.inventory_scope.database_sources_loaded,
      truncated: report.inventory_scope.truncated,
    },
    source_count: report.source_count,
    visual_versions_required: report.visual_versions_required,
    accounted_for_versions: report.accounted_for_versions,
    accounted_for_percent: report.accounted_for_percent,
    repair_needed_versions: report.repair_needed_versions,
    latest_repair_needed: report.latest_repair_needed,
    previous_repair_needed: report.previous_repair_needed,
    historical_layout_unavailable: report.historical_layout_unavailable,
    r2_meta_errors: report.r2_meta_errors,
    work_source_count: report.work_source_count,
    automated_localization_complete: report.automated_localization_complete,
    repair_source_ids: [...report.repair_source_ids].sort(),
    latest_repair_source_ids: [...report.latest_repair_source_ids].sort(),
    previous_repair_source_ids: [...report.previous_repair_source_ids].sort(),
    work_source_ids: [...report.work_source_ids].sort(),
    historical_fallback_source_ids: inventory.sourceIds,
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function invalidInventory(reason) {
  return {
    complete: false,
    reason,
    declaredCount: null,
    sourceIds: [],
  };
}
