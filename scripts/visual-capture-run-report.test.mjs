import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireFileLock,
  buildNightlyVisualReport,
  buildVisualRunReportSummary,
  classifyVisualCaptureFailure,
  isDailyVisualShardReport,
  monitoringDateForTimestamp,
  monitoringDateForVisualReportFilename,
  shouldReplaceLatestNightlyReport,
  visualRunTerminalDisposition,
} from "./lib/visual-capture-run-report.mjs";
import { buildVisualSourceInventoryProof } from "./lib/visual-source-inventory-proof.mjs";

function shardReport(shardIndex, overrides = {}) {
  const report = {
    started_at: `2026-07-14T23:00:0${shardIndex}.000Z`,
    finished_at: `2026-07-14T23:30:0${shardIndex}.000Z`,
    status: "succeeded",
    options: {
      shard_count: 3,
      shard_index: shardIndex,
      run_trigger: "scheduled",
      limit: 50000,
      include_not_due: true,
      pdf_only: false,
      web_only: false,
      skip_existing_baseline: false,
      baseline_refresh: false,
      complete_missing_baselines: false,
      localization_repair: false,
      r2_backfill_baselines: false,
      discovery_mode: true,
      discovery_intent: "live_recurring",
      discovery_onboarding_batch_id: null,
      discover_pdf_subpages: true,
      discover_html_subpages: false,
      visual_review_mode: "batch",
      interpret_visual_changes: true,
      r2_snapshot_sync: true,
      source_id: null,
      source_url: null,
      award: null,
    },
    checked: 100,
    failed: 0,
    baseline_coverage_start: { loaded_sources: 100 },
    errors: [],
    ...overrides,
  };
  if (!("source_inventory" in overrides)) {
    const loaded = Number(report.baseline_coverage_start?.loaded_sources || 0);
    report.source_inventory = inventoryProof(shardIndex, [loaded, loaded, loaded]);
  }
  return report;
}

function inventoryProof(shardIndex, partitionCounts = [100, 100, 100]) {
  const sources = partitionCounts.flatMap((count, partition) =>
    Array.from({ length: count }, (_, index) => ({
      id: `source-${partition}-${String(index).padStart(4, "0")}`,
      partition,
    })),
  );
  return buildVisualSourceInventoryProof({
    eligibleSources: sources,
    loadedSources: sources.filter((source) => source.partition === shardIndex),
    shardCount: 3,
    shardIndex,
    shardIndexForSource: (source) => source.partition,
    capturedAt: "2026-07-14T22:59:59.000Z",
  });
}

describe("visual capture run reporting", () => {
  it.each([
    {
      label: "zero source failures",
      report: { checked: 10, failed: 0, baseline_coverage_start: { loaded_sources: 10 } },
      expected: {
        report_status: "succeeded",
        execution_status: "succeeded",
        worker_status: "succeeded",
        health_status: "healthy",
      },
    },
    {
      label: "partial source failures",
      report: { checked: 9, failed: 1, baseline_coverage_start: { loaded_sources: 10 } },
      expected: {
        report_status: "degraded",
        execution_status: "succeeded",
        worker_status: "failed",
        health_status: "degraded",
      },
    },
    {
      label: "total source failures",
      report: { checked: 0, failed: 10, baseline_coverage_start: { loaded_sources: 10 } },
      expected: {
        report_status: "failed",
        execution_status: "succeeded",
        worker_status: "failed",
        health_status: "failed",
      },
    },
  ])("persists a truthful terminal outcome for $label", ({ report, expected }) => {
    const disposition = visualRunTerminalDisposition(report);
    const summary = buildVisualRunReportSummary({
      ...report,
      status: disposition.report_status,
      execution_status: disposition.execution_status,
      errors: Array.from({ length: report.failed }, (_, index) => ({
        source_id: `source-${index}`,
        message: "Source capture failed.",
      })),
    });

    expect(disposition).toMatchObject({
      report_status: expected.report_status,
      execution_status: expected.execution_status,
      worker_status: expected.worker_status,
    });
    expect(summary.run_health).toMatchObject({
      status: expected.health_status,
      execution_status: "succeeded",
      loaded_sources: 10,
      source_failures: report.failed,
      inventory_complete: true,
    });
  });

  it("applies the truthful disposition at every visual-worker success exit and persistence boundary", () => {
    const workerSource = readFileSync(
      new URL("./capture-visual-snapshots.mjs", import.meta.url),
      "utf8",
    );

    expect(workerSource.match(/const terminalDisposition = visualRunTerminalDisposition\(report\);/g))
      .toHaveLength(2);
    expect(workerSource).toContain(
      "const persistedStatus = visualRunTerminalDisposition(report, status).worker_status;",
    );
    expect(workerSource).not.toContain('finishWorkerRun(workerRunId, "succeeded"');
  });

  it("marks process success with source failures as degraded and supplies a guarded repair", () => {
    const summary = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 99,
      failed: 1,
      baseline_coverage_start: { loaded_sources: 100 },
      errors: [{
        source_id: "source-1",
        source_url: "https://example.org/award",
        message: "Baseline exists but evidence is missing (page.jpg).",
      }],
    });

    expect(summary.run_health).toMatchObject({
      status: "degraded",
      execution_status: "succeeded",
      loaded_sources: 100,
      pages_captured: 99,
      source_failures: 1,
      failure_rate_percent: 1,
      requires_attention: true,
    });
    expect(summary.failure_groups[0]).toMatchObject({
      code: "baseline_evidence_missing_or_invalid",
      count: 1,
      retry_mode: "operator_guarded",
    });
    expect(summary.repair_plan.actions[0].solution).toContain("never refresh a baseline merely to clear this error");
  });

  it("does not let an HTTP 200 observation mask a baseline or timeout failure", () => {
    expect(classifyVisualCaptureFailure({
      message: "Baseline exists but evidence is missing. Probe returned HTTP 200.",
    }).code).toBe("baseline_evidence_missing_or_invalid");
    expect(classifyVisualCaptureFailure({
      message: "page.goto: Timeout 60000ms exceeded. Probe returned HTTP 200.",
    }).code).toBe("network_transient");
  });

  it.each([
    {
      message:
        "capture_resource_limit: resource=browser_network_policy observed=https_tunnel_refusal timeout",
      expectedCode: "browser_network_policy_refusal",
    },
    {
      message:
        "capture_resource_limit: resource=browser_network_settle observed=1_in_flight timeout",
      expectedCode: "browser_network_settle_timeout",
    },
    {
      message:
        "capture_resource_limit: resource=browser_context_shutdown observed=context_close_failed",
      expectedCode: "browser_capture_boundary_shutdown",
    },
    {
      message:
        "capture_resource_limit: resource=render_pixels observed=90000000 limit=80000000",
      expectedCode: "capture_resource_limit",
    },
    {
      message: "PDF is too large (52428801 bytes) after a fetch timeout.",
      expectedCode: "pdf_size_or_page_limit",
    },
    {
      message: "PDF has 501 pages; limit 500 pages. The parser timed out.",
      expectedCode: "pdf_size_or_page_limit",
    },
    {
      message: "PDF text parsing exceeded 30000ms after a network timeout.",
      expectedCode: "pdf_parse_or_cleanup_failure",
    },
    {
      message: "PDF parser cleanup timed out after 5000ms.",
      expectedCode: "pdf_parse_or_cleanup_failure",
    },
    {
      message: "PDF text parsing failed: malformed cross-reference table.",
      expectedCode: "pdf_parse_or_cleanup_failure",
    },
  ])("classifies guarded capture failures before generic network errors", ({
    message,
    expectedCode,
  }) => {
    expect(classifyVisualCaptureFailure({ message }).code).toBe(expectedCode);
  });

  it("emits guarded repair actions for network, resource, and PDF limits", () => {
    const summary = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 0,
      failed: 5,
      baseline_coverage_start: { loaded_sources: 5 },
      errors: [
        {
          source_id: "network-source",
          message:
            "capture_resource_limit: resource=browser_network_policy observed=http_policy_refusal",
        },
        {
          source_id: "settle-source",
          message:
            "capture_resource_limit: resource=browser_network_settle observed=1_in_flight limit=0",
        },
        {
          source_id: "render-source",
          message:
            "capture_resource_limit: resource=render_height_css_px observed=60001 limit=60000",
        },
        {
          source_id: "large-pdf-source",
          message: "PDF has 501 pages; limit 500 pages.",
        },
        {
          source_id: "slow-pdf-source",
          message: "PDF parser cleanup exceeded 5000ms after timeout.",
        },
      ],
    });

    expect(summary.repair_plan.requires_operator).toBe(true);
    expect(summary.failure_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "browser_network_policy_refusal",
        group: "network_safety",
        retry_mode: "operator_guarded",
        repair_code: "verify_public_network_dependency",
        solution: expect.stringContaining("never allow private, local, or reserved network access"),
      }),
      expect.objectContaining({
        code: "browser_network_settle_timeout",
        group: "network_safety",
        retry_mode: "automatic_once_then_operator",
        repair_code: "retry_fresh_proxy_then_inspect_dns",
        solution: expect.stringContaining("never publish evidence"),
      }),
      expect.objectContaining({
        code: "capture_resource_limit",
        group: "evidence_integrity",
        retry_mode: "operator_guarded",
        repair_code: "inspect_capture_resource_limit",
        solution: expect.stringContaining("never publish partial evidence"),
      }),
      expect.objectContaining({
        code: "pdf_size_or_page_limit",
        group: "evidence_integrity",
        retry_mode: "operator_guarded",
        repair_code: "inspect_pdf_size_or_page_limit",
        solution: expect.stringContaining("never publish a truncated PDF"),
      }),
      expect.objectContaining({
        code: "pdf_parse_or_cleanup_failure",
        group: "evidence_integrity",
        retry_mode: "operator_guarded",
        repair_code: "inspect_pdf_parser_time_limit",
        solution: expect.stringContaining("never publish missing or partial PDF text"),
      }),
    ]));
    expect(summary.repair_plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        failure_code: "browser_network_policy_refusal",
        retry_mode: "operator_guarded",
        repair_code: "verify_public_network_dependency",
        solution: expect.stringContaining("never allow private, local, or reserved network access"),
      }),
      expect.objectContaining({
        failure_code: "browser_network_settle_timeout",
        retry_mode: "automatic_once_then_operator",
        repair_code: "retry_fresh_proxy_then_inspect_dns",
        solution: expect.stringContaining("never publish evidence"),
      }),
      expect.objectContaining({
        failure_code: "capture_resource_limit",
        retry_mode: "operator_guarded",
        repair_code: "inspect_capture_resource_limit",
        solution: expect.stringContaining("never publish partial evidence"),
      }),
      expect.objectContaining({
        failure_code: "pdf_size_or_page_limit",
        retry_mode: "operator_guarded",
        repair_code: "inspect_pdf_size_or_page_limit",
        solution: expect.stringContaining("never publish a truncated PDF"),
      }),
      expect.objectContaining({
        failure_code: "pdf_parse_or_cleanup_failure",
        retry_mode: "operator_guarded",
        repair_code: "inspect_pdf_parser_time_limit",
        solution: expect.stringContaining("never publish missing or partial PDF text"),
      }),
    ]));
  });

  it("prioritizes the failed stage over a provider named in the message", () => {
    expect(classifyVisualCaptureFailure({
      message: "Visual review candidate enqueue failed: Supabase request timed out.",
    }).code).toBe("downstream_persistence_failed");
    expect(classifyVisualCaptureFailure({
      message: "R2 snapshot upload failed after a Supabase lookup.",
    }).code).toBe("storage_sync_failed");
  });

  it("routes shared AI quota failures to account repair instead of source backoff", () => {
    expect(classifyVisualCaptureFailure({
      message: "Gemini API cap reached after HTTP 429 quota exceeded.",
    })).toMatchObject({
      code: "ai_quota_or_billing_blocked",
      repair_code: "restore_ai_quota_then_restart",
      retry_mode: "repair_then_restart_shard",
    });
  });

  it("always supplies a repair path when failure counters exceed error events", () => {
    const summary = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 10,
      failed: 2,
      errors: [],
    });

    expect(summary.failure_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "unknown_failure",
        count: 2,
        repair_code: "classify_before_retry",
      }),
    ]));
  });

  it("turns blocked Stage 1 results into an operator repair group", () => {
    const blockedSourceIds = Array.from(
      { length: 8 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const summary = buildVisualRunReportSummary({
      status: "blocked",
      execution_status: "blocked",
      checked: 9,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 9 },
      errors: [],
      stage1_evidence_schema_upgrade: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-report.v1",
        status: "blocked",
        blocked_source_count: 8,
        results: [
          {
            source_id: "00000000-0000-4000-8000-000000000009",
            status: "dry_run_ready",
            reason_code: "exact_semantic_and_primary_visual_identity_verified",
          },
          ...blockedSourceIds.map((sourceId, index) => ({
            source_id: sourceId,
            status: "dry_run_evidence_failure",
            reason_code: index === 7
              ? "existing_baseline_normalized_text_disagrees_with_acquisition"
              : "existing_baseline_semantic_identity_mismatch",
          })),
        ],
      },
    });

    expect(summary.failure_groups).toEqual([
      expect.objectContaining({
        code: "stage1_evidence_schema_upgrade_work_remaining",
        group: "evidence_integrity",
        severity: "critical",
        retry_mode: "operator_guarded",
        repair_code: "review_stage1_evidence_schema_upgrade_work",
        count: 8,
        source_id_count: 8,
        source_ids: blockedSourceIds,
      }),
    ]);
    expect(summary.failure_groups[0].examples[0]).toMatchObject({
      source_id: blockedSourceIds[0],
      message: expect.stringContaining("existing_baseline_semantic_identity_mismatch"),
    });
    expect(summary.repair_plan).toMatchObject({
      requires_operator: true,
      actions: [expect.objectContaining({
        failure_code: "stage1_evidence_schema_upgrade_work_remaining",
        affected_count: 8,
        source_id_count: 8,
        solution: expect.stringContaining("rerun the exact reviewed dry-run"),
      })],
    });
  });

  it("keeps already-upgraded authority clear while invalid authority needs operator work", () => {
    const alreadyUpgradedSourceId = "00000000-0000-4000-8000-000000000001";
    const invalidAuthoritySourceId = "00000000-0000-4000-8000-000000000002";
    const applyAlreadyUpgradedSourceId = "00000000-0000-4000-8000-000000000004";
    const summary = buildVisualRunReportSummary({
      status: "blocked",
      execution_status: "blocked",
      checked: 4,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 4 },
      errors: [],
      stage1_evidence_schema_upgrade: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-report.v1",
        status: "blocked",
        completed_source_count: 1,
        blocked_source_count: 1,
        results: [
          {
            source_id: alreadyUpgradedSourceId,
            status: "dry_run_already_upgraded",
            reason_code: "completed_upgrade_authority_verified",
          },
          {
            source_id: invalidAuthoritySourceId,
            status: "dry_run_completed_authority_invalid",
            reason_code: "completed_upgrade_authority_provenance_invalid",
          },
          {
            source_id: "00000000-0000-4000-8000-000000000003",
            status: "dry_run_ready",
            reason_code: "exact_semantic_and_primary_visual_identity_verified",
          },
          {
            source_id: applyAlreadyUpgradedSourceId,
            status: "already_upgraded",
            reason_code: "completed_upgrade_authority_verified",
          },
        ],
      },
    });

    expect(summary.failure_groups).toEqual([
      expect.objectContaining({
        code: "stage1_evidence_schema_upgrade_work_remaining",
        count: 1,
        source_id_count: 1,
        source_ids: [invalidAuthoritySourceId],
      }),
    ]);
    expect(summary.failure_groups[0].examples).toEqual([
      expect.objectContaining({
        source_id: invalidAuthoritySourceId,
        message: expect.stringContaining("dry_run_completed_authority_invalid"),
      }),
    ]);
    expect(summary.failure_groups[0].source_ids).not.toContain(alreadyUpgradedSourceId);
    expect(summary.failure_groups[0].source_ids).not.toContain(applyAlreadyUpgradedSourceId);
    expect(summary.repair_plan).toMatchObject({
      requires_operator: true,
      actions: [expect.objectContaining({ affected_count: 1 })],
    });
  });

  it("keeps quarantined-only Stage 1 work operator-visible", () => {
    const quarantinedSourceIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const summary = buildVisualRunReportSummary({
      status: "blocked",
      execution_status: "blocked",
      checked: 2,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 2 },
      errors: [],
      stage1_evidence_schema_upgrade: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-report.v1",
        status: "quarantined_work_remaining",
        blocked_source_count: 0,
        quarantined_work_remaining: 2,
        results: [
          {
            source_id: quarantinedSourceIds[0],
            status: "evidence_failure_quarantined",
            reason_code: "existing_baseline_semantic_identity_mismatch",
          },
          {
            source_id: quarantinedSourceIds[1],
            status: "journal_recovered_quarantine_remaining",
            reason_code: "active_upgrade_journal_recovered_existing_quarantine_preserved",
          },
        ],
      },
    });

    expect(summary.failure_groups).toEqual([
      expect.objectContaining({
        code: "stage1_evidence_schema_upgrade_work_remaining",
        label: "Stage 1 evidence-schema upgrade needs reviewed follow-up",
        count: 2,
        source_id_count: 2,
        source_ids: quarantinedSourceIds,
      }),
    ]);
    expect(summary.failure_groups[0].examples).toEqual([
      expect.objectContaining({ message: expect.stringContaining("evidence_failure_quarantined") }),
      expect.objectContaining({
        message: expect.stringContaining("journal_recovered_quarantine_remaining"),
      }),
    ]);
    expect(summary.repair_plan).toMatchObject({
      requires_operator: true,
      actions: [expect.objectContaining({
        failure_code: "stage1_evidence_schema_upgrade_work_remaining",
        affected_count: 2,
        solution: expect.stringContaining("Keep quarantined sources held"),
      })],
    });
  });

  it("keeps all eight explicitly deferred sources visible after a successful reviewed exact-one apply", () => {
    const selectedSourceId = "00000000-0000-4000-8000-000000000009";
    const deferredSourceIds = Array.from(
      { length: 8 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const summary = buildVisualRunReportSummary({
      status: "completed",
      execution_status: "completed",
      checked: 1,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 1 },
      errors: [],
      stage1_evidence_schema_upgrade_reviewed_apply: {
        schema_version:
          "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-report.v1",
        status: "selected_completed",
        selected_source_id: selectedSourceId,
        selected_source_count: 1,
        deferred_source_ids: deferredSourceIds,
        deferred_source_count: 8,
        blocked_source_count: 0,
        selected: {
          source_id: selectedSourceId,
          status: "selected_completed",
          reason_code: "reviewed_unchanged_upgrade_committed",
        },
      },
    });

    expect(summary.failure_groups).toEqual([
      expect.objectContaining({
        code: "stage1_evidence_schema_upgrade_work_remaining",
        count: 8,
        source_id_count: 8,
        source_ids: deferredSourceIds,
      }),
    ]);
    expect(summary.failure_groups[0].examples[0]).toMatchObject({
      source_id: deferredSourceIds[0],
      message: expect.stringContaining("explicitly deferred"),
    });
    expect(summary.run_health).toMatchObject({
      status: "degraded",
      execution_status: "completed",
      requires_attention: true,
    });
    expect(summary.repair_plan).toMatchObject({
      requires_operator: true,
      actions: [expect.objectContaining({
        affected_count: 8,
        solution: expect.stringContaining("fresh exact-nine dry-run"),
      })],
    });
  });

  it("adds the selected source to deferred work when reviewed exact-one apply blocks", () => {
    const selectedSourceId = "00000000-0000-4000-8000-000000000009";
    const deferredSourceIds = Array.from(
      { length: 8 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const summary = buildVisualRunReportSummary({
      status: "blocked",
      execution_status: "blocked",
      checked: 1,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 1 },
      errors: [],
      stage1_evidence_schema_upgrade_reviewed_apply: {
        schema_version:
          "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-report.v1",
        status: "selected_recovery_required",
        reason_code: "reviewed_unchanged_upgrade_recovery_required",
        selected_source_id: selectedSourceId,
        deferred_source_ids: deferredSourceIds,
        deferred_source_count: 8,
        blocked_source_count: 1,
        selected: {
          source_id: selectedSourceId,
          status: "selected_recovery_required",
          reason_code: "reviewed_unchanged_upgrade_recovery_required",
        },
      },
    });

    expect(summary.failure_groups[0]).toMatchObject({
      count: 9,
      source_id_count: 9,
      source_ids: [selectedSourceId, ...deferredSourceIds],
    });
    expect(summary.failure_groups[0].examples[0]).toMatchObject({
      source_id: selectedSourceId,
      message: expect.stringContaining("selected_recovery_required"),
    });
  });

  it("preserves recovery-required execution while marking operational health blocked", () => {
    const summary = buildVisualRunReportSummary({
      status: "recovery_required",
      execution_status: "recovery_required",
      checked: 0,
      failed: 0,
      errors: [],
    });

    expect(summary.run_health).toMatchObject({
      status: "blocked",
      execution_status: "recovery_required",
      requires_attention: true,
    });
    expect(summary.failure_groups).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_inventory_empty_or_incomplete" }),
    ]));
  });

  it("does not change normal-mode or fully ready Stage 1 repair grouping", () => {
    const base = {
      status: "blocked",
      execution_status: "blocked",
      checked: 1,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 1 },
      errors: [],
    };
    const normal = buildVisualRunReportSummary(base);
    const ready = buildVisualRunReportSummary({
      ...base,
      status: "succeeded",
      execution_status: "succeeded",
      stage1_evidence_schema_upgrade: {
        schema_version: "awardping.stage1.evidence-schema-upgrade-report.v1",
        status: "dry_run_complete",
        blocked_source_count: 0,
        results: [{
          source_id: "00000000-0000-4000-8000-000000000001",
          status: "dry_run_ready",
        }],
      },
    });

    for (const summary of [normal, ready]) {
      expect(summary.failure_groups).toEqual([]);
      expect(summary.repair_plan).toEqual({ requires_operator: false, actions: [] });
    }
  });

  it("never reports a zero-page or partially processed inventory as healthy", () => {
    const empty = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 0,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 0 },
      errors: [],
    });
    const partial = buildVisualRunReportSummary({
      status: "succeeded",
      checked: 8,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 10 },
      errors: [],
    });

    for (const summary of [empty, partial]) {
      expect(summary.run_health).toMatchObject({
        status: "failed",
        inventory_complete: false,
        requires_attention: true,
      });
      expect(summary.failure_groups).toContainEqual(expect.objectContaining({
        code: "source_inventory_empty_or_incomplete",
        severity: "critical",
      }));
    }
  });

  it("uses the Chicago 6 PM boundary for the monitoring date", () => {
    expect(monitoringDateForTimestamp("2026-07-14T22:59:59.000Z")).toBe("2026-07-13");
    expect(monitoringDateForTimestamp("2026-07-14T23:00:00.000Z")).toBe("2026-07-14");
  });

  it("includes permanent live discovery but excludes onboarding, repair, and targeted runs", () => {
    expect(isDailyVisualShardReport(shardReport(0))).toBe(true);

    const excludedOptions = [
      { discovery_intent: "historical_onboarding", discovery_onboarding_batch_id: "batch-1" },
      { baseline_refresh: true },
      { localization_repair: true },
      { discover_pdf_subpages: false },
      { discover_html_subpages: true },
      { visual_review_mode: "none", interpret_visual_changes: false },
      { r2_snapshot_sync: false },
      { source_id: "10000000-0000-4000-8000-000000000001" },
      { source_ids_filter_count: 2 },
      { initial_official_document_materialization: true },
    ];
    for (const optionOverrides of excludedOptions) {
      const base = shardReport(0);
      expect(isDailyVisualShardReport({
        ...base,
        options: { ...base.options, ...optionOverrides },
      })).toBe(false);
    }

    const missingIntent = shardReport(0);
    delete missingIntent.options.discovery_intent;
    expect(isDailyVisualShardReport(missingIntent)).toBe(false);
  });

  it("derives monitoring windows from report filenames before parsing files", () => {
    expect(monitoringDateForVisualReportFilename(
      "visual-snapshot-run-2026-07-14T22-59-59-999Z.json",
    )).toBe("2026-07-13");
    expect(monitoringDateForVisualReportFilename(
      "visual-snapshot-run-2026-07-14T23-00-00-000Z-shard-1-deadbeef.json",
    )).toBe("2026-07-14");
  });

  it("serializes nightly report writers with the shared lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-report-lock-"));
    const lockPath = join(directory, "visual-nightly-report.lock");
    try {
      const releaseFirst = await acquireFileLock(lockPath, 1_000);
      let secondAcquired = false;
      const second = acquireFileLock(lockPath, 1_000).then((release) => {
        secondAcquired = true;
        return release;
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(secondAcquired).toBe(false);
      releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      releaseSecond();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips a fresh-install false alarm before 6 PM and reports a total launch failure after grace", () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-report-cli-"));
    const cli = resolve(import.meta.dirname, "report-visual-nightly.mjs");
    try {
      writeFileSync(join(
        directory,
        "visual-snapshot-run-2026-07-14T23-00-00-000Z-manual.json",
      ), JSON.stringify({
        started_at: "2026-07-14T23:00:00.000Z",
        status: "succeeded",
        options: { shard_count: 3, shard_index: 0, run_trigger: "manual" },
      }), "utf8");
      const beforeDue = spawnSync(process.execPath, [
        cli,
        "--reports-dir", directory,
        "--now=2026-07-15T17:00:00.000Z",
        "--write=true",
      ], { encoding: "utf8" });
      expect(beforeDue.status).toBe(0);
      expect(beforeDue.stdout).toContain("No 6 PM scan is due yet");
      expect(existsSync(join(directory, "visual-nightly-report-latest.json"))).toBe(false);

      const afterGrace = spawnSync(process.execPath, [
        cli,
        "--reports-dir", directory,
        "--now=2026-07-16T00:05:00.000Z",
        "--write=true",
      ], { encoding: "utf8" });
      expect(afterGrace.status).toBe(0);
      const report = JSON.parse(readFileSync(
        join(directory, "visual-nightly-report-2026-07-15.json"),
        "utf8",
      ));
      expect(report).toMatchObject({
        status: "incomplete",
        missing_shards: [1, 2, 3],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a historical rebuild replace the latest nightly report", () => {
    expect(shouldReplaceLatestNightlyReport(
      { monitoring_date: "2026-07-15" },
      { monitoring_date: "2026-07-14" },
    )).toBe(false);
    expect(shouldReplaceLatestNightlyReport(
      { monitoring_date: "2026-07-15" },
      { monitoring_date: "2026-07-15" },
    )).toBe(true);
  });

  it("requires all three canonical shards and reports missing shards", () => {
    const report = buildNightlyVisualReport([
      shardReport(0),
      shardReport(2),
    ], { monitoringDate: "2026-07-14", generatedAt: "2026-07-15T00:00:00.000Z" });

    expect(report).toMatchObject({
      status: "incomplete",
      expected_shards: 3,
      observed_shards: 2,
      missing_shards: [2],
    });
    expect(report.summary).toContain("Missing shard 2");
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "missing_shard", count: 1 }),
    ]);
    expect(report.repair_plan.actions[0]).toMatchObject({
      repair_code: "inspect_task_then_start_missing_shard",
      affected_count: 1,
    });
  });

  it("synthesizes a repairable report when no shard launches", () => {
    const report = buildNightlyVisualReport([], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:00:00.000Z",
    });

    expect(report).toMatchObject({
      status: "incomplete",
      observed_shards: 0,
      missing_shards: [1, 2, 3],
    });
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "missing_shard", count: 3 }),
    ]);
  });

  it("distinguishes a live shard heartbeat from a stalled shard", () => {
    const fresh = shardReport(0, {
      status: "running",
      finished_at: null,
      heartbeat_at: "2026-07-15T00:55:00.000Z",
    });
    const liveReport = buildNightlyVisualReport([fresh, shardReport(1), shardReport(2)], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:00:00.000Z",
    });
    expect(liveReport.status).toBe("running");
    expect(liveReport.shards[0]).toMatchObject({ stalled: false, operational_status: "running" });

    const stalledReport = buildNightlyVisualReport([fresh, shardReport(1), shardReport(2)], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:11:00.000Z",
    });
    expect(stalledReport.status).toBe("failed");
    expect(stalledReport.shards[0]).toMatchObject({ stalled: true, operational_status: "failed" });
    expect(stalledReport.failure_groups).toContainEqual(
      expect.objectContaining({ code: "stalled_shard", count: 1 }),
    );
  });

  it("keeps an actively processing shard running without a premature inventory incident", () => {
    const active = shardReport(0, {
      status: "running",
      checked: 20,
      finished_at: null,
      heartbeat_at: "2026-07-15T00:55:00.000Z",
    });
    const report = buildNightlyVisualReport([active, shardReport(1), shardReport(2)], {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T01:00:00.000Z",
    });

    expect(report).toMatchObject({
      status: "running",
      totals: { inventory_complete: false },
    });
    expect(report.shards[0]).toMatchObject({
      operational_status: "running",
      inventory_complete: false,
    });
    expect(report.failure_groups).not.toContainEqual(expect.objectContaining({
      code: "source_inventory_empty_or_incomplete",
    }));
  });

  it("reports a complete triad with any failure as degraded and aggregates solutions", () => {
    const report = buildNightlyVisualReport([
      shardReport(0, {
        checked: 98,
        failed: 2,
        errors: [
          { source_id: "a", message: "Page load failed with HTTP 429" },
          { source_id: "b", message: "Page load failed with HTTP 429" },
        ],
      }),
      shardReport(1),
      shardReport(2),
    ], { monitoringDate: "2026-07-14", generatedAt: "2026-07-15T00:00:00.000Z" });

    expect(report).toMatchObject({
      status: "degraded",
      expected_shards: 3,
      completed_shards: 3,
      missing_shards: [],
      totals: {
        loaded_sources: 300,
        pages_captured: 298,
        source_failures: 2,
      },
    });
    expect(report.failure_groups).toEqual([
      expect.objectContaining({ code: "rate_limited", count: 2 }),
    ]);
    expect(report.repair_plan.actions[0]).toMatchObject({
      repair_code: "backoff_then_retry",
      affected_count: 2,
    });
  });

  it("fails a complete three-shard cohort when every shard checks zero pages", () => {
    const emptyShards = [0, 1, 2].map((shardIndex) => shardReport(shardIndex, {
      checked: 0,
      failed: 0,
      baseline_coverage_start: { loaded_sources: 0 },
    }));
    const report = buildNightlyVisualReport(emptyShards, {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      status: "failed",
      totals: {
        loaded_sources: 0,
        pages_captured: 0,
        inventory_complete: false,
      },
    });
    expect(report.failure_groups).toContainEqual(expect.objectContaining({
      code: "source_inventory_empty_or_incomplete",
    }));
  });

  it("fails a fully processed triad when one shard attests a different global inventory", () => {
    const shards = [shardReport(0), shardReport(1), shardReport(2)];
    shards[2].source_inventory = {
      ...shards[2].source_inventory,
      global_source_ids_sha256: "f".repeat(64),
    };
    const report = buildNightlyVisualReport(shards, {
      monitoringDate: "2026-07-14",
      generatedAt: "2026-07-15T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      status: "failed",
      totals: {
        inventory_complete: false,
        inventory_proof_complete: false,
      },
    });
    expect(report.failure_groups).toContainEqual(expect.objectContaining({
      code: "source_inventory_proof_missing_or_mismatched",
    }));
    expect(report.summary).toContain("inventory proofs");
  });

  it("keeps only the newest attempt for each shard", () => {
    const olderFailure = shardReport(0, {
      started_at: "2026-07-14T23:00:00.000Z",
      finished_at: "2026-07-14T23:10:00.000Z",
      status: "failed",
      checked: 0,
      failed: 1,
      errors: [{ message: "Supabase request failed" }],
    });
    const retry = shardReport(0, {
      started_at: "2026-07-15T00:00:00.000Z",
      finished_at: "2026-07-15T00:20:00.000Z",
    });
    const report = buildNightlyVisualReport([
      olderFailure,
      retry,
      shardReport(1),
      shardReport(2),
    ], { monitoringDate: "2026-07-14" });

    expect(report.status).toBe("healthy");
    expect(report.shards).toHaveLength(3);
    expect(report.totals.source_failures).toBe(0);
  });

  it("does not let a later untagged catch-up cohort replace the scheduled triad", () => {
    const catchup = [0, 1, 2].map((shardIndex) => shardReport(shardIndex, {
      started_at: `2026-07-15T04:43:0${shardIndex}.000Z`,
      finished_at: `2026-07-15T04:50:0${shardIndex}.000Z`,
      checked: shardIndex === 0 ? 10 : 0,
      options: {
        ...shardReport(shardIndex).options,
        run_trigger: "",
      },
    }));
    const report = buildNightlyVisualReport([
      shardReport(0),
      shardReport(1),
      shardReport(2),
      ...catchup,
    ], { monitoringDate: "2026-07-14" });

    expect(report).toMatchObject({
      status: "healthy",
      observed_shards: 3,
      totals: { pages_captured: 300 },
    });
  });

  it("does not treat legacy untagged shards as authoritative 6 PM evidence", () => {
    const legacyScheduled = [0, 1, 2].map((shardIndex) => {
      const report = shardReport(shardIndex);
      report.options.run_trigger = "";
      return report;
    });

    expect(buildNightlyVisualReport(legacyScheduled, {
      monitoringDate: "2026-07-14",
    })).toMatchObject({
      status: "incomplete",
      observed_shards: 0,
      missing_shards: [1, 2, 3],
    });
  });

  it("excludes partial scheduled scans from the authoritative cohort", () => {
    for (const overrides of [
      { include_not_due: false },
      { limit: 100 },
      { pdf_only: true },
      { web_only: true },
      { skip_existing_baseline: true },
      { discovery_mode: false },
      { discovery_intent: "" },
    ]) {
      const partial = shardReport(0);
      partial.options = { ...partial.options, ...overrides };
      expect(isDailyVisualShardReport(partial), JSON.stringify(overrides)).toBe(false);
    }
  });

  it("excludes manual and maintenance shard runs from the scheduled nightly cohort", () => {
    const manual = shardReport(0);
    manual.options.run_trigger = "manual";
    const maintenance = shardReport(1);
    maintenance.options.run_trigger = "maintenance";
    const scheduled = shardReport(2);

    const report = buildNightlyVisualReport([manual, maintenance, scheduled], {
      monitoringDate: "2026-07-14",
    });

    expect(report.observed_shards).toBe(1);
    expect(report.missing_shards).toEqual([1, 2]);
  });
});
