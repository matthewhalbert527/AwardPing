import { describe, expect, it } from "vitest";
import {
  historicalLocalizationInventoryDigest,
  validateHistoricalLocalizationInventory,
} from "./lib/manual-quarantine.mjs";

function completeReport(overrides = {}) {
  return {
    version: 2,
    report_type: "legacy_source_pointer_layout_maintenance",
    metric_scope: "source_pointer_layout_metadata_not_event_crop",
    verified_event_crop_metric: false,
    started_at: "2026-07-15T05:00:00.000Z",
    finished_at: "2026-07-15T05:01:00.000Z",
    apply: false,
    inventory_scope: {
      kind: "all_active_open_monitorable_sources",
      requested_source_limit: 100_000,
      database_sources_loaded: 2,
      truncated: false,
    },
    source_count: 2,
    visual_versions_required: 4,
    accounted_for_versions: 4,
    accounted_for_percent: 100,
    repair_needed_versions: 0,
    latest_repair_needed: 0,
    previous_repair_needed: 0,
    historical_layout_unavailable: 2,
    r2_meta_errors: 0,
    work_source_count: 0,
    automated_localization_complete: true,
    repair_source_ids: [],
    latest_repair_source_ids: [],
    previous_repair_source_ids: [],
    work_source_ids: [],
    historical_fallback_source_ids: ["source-b", "source-a"],
    ...overrides,
  };
}

describe("manual quarantine historical inventory", () => {
  it("accepts an explicit, exact, unique, full-scope inventory", () => {
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ audited: true }),
        { requireAudited: true },
      ),
    ).toEqual({
      complete: true,
      reason: null,
      declaredCount: 2,
      sourceIds: ["source-a", "source-b"],
    });
  });

  it("allows sources without retained visual versions in a complete source inventory", () => {
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({
          visual_versions_required: 3,
          accounted_for_versions: 3,
        }),
      ),
    ).toMatchObject({ complete: true, declaredCount: 2 });
  });

  it("accepts a verified empty inventory without inferring it from missing fields", () => {
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({
          source_count: 0,
          visual_versions_required: 0,
          accounted_for_versions: 0,
          historical_layout_unavailable: 0,
          historical_fallback_source_ids: [],
          inventory_scope: {
            kind: "all_active_open_monitorable_sources",
            requested_source_limit: 100_000,
            database_sources_loaded: 0,
            truncated: false,
          },
        }),
      ),
    ).toMatchObject({ complete: true, declaredCount: 0, sourceIds: [] });
    expect(validateHistoricalLocalizationInventory({})).toMatchObject({
      complete: false,
      reason: "unsupported_report_version",
    });
  });

  it("rejects reports with the wrong provenance, mode, scope, or timestamps", () => {
    expect(
      validateHistoricalLocalizationInventory(completeReport({ version: 1 })).reason,
    ).toBe("unsupported_report_version");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ metric_scope: "verified_event_crops" }),
      ).reason,
    ).toBe("unsupported_metric_scope");
    expect(
      validateHistoricalLocalizationInventory(completeReport({ apply: true })).reason,
    ).toBe("report_mode_is_not_read_only_layout_inventory");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({
          inventory_scope: {
            kind: "all_active_open_monitorable_sources",
            requested_source_limit: 1,
            database_sources_loaded: 1,
            truncated: true,
          },
        }),
      ).reason,
    ).toBe("inventory_scope_is_not_complete");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ finished_at: "2026-07-15T04:59:00.000Z" }),
      ).reason,
    ).toBe("report_timestamp_missing_or_invalid");
  });

  it("rejects incomplete automation accounting", () => {
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ accounted_for_versions: 3 }),
      ).reason,
    ).toBe("localization_inventory_is_not_complete");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({
          repair_needed_versions: 1,
          repair_source_ids: ["source-a"],
        }),
      ).reason,
    ).toBe("localization_inventory_is_not_complete");
  });

  it("rejects partial, duplicate, invalid, and unaudited inventories", () => {
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ historical_fallback_source_ids: ["source-a"] }),
      ).reason,
    ).toBe("declared_count_does_not_match_source_ids");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ historical_fallback_source_ids: ["source-a", "source-a"] }),
      ).reason,
    ).toBe("source_id_inventory_contains_duplicates");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({
          historical_layout_unavailable: 1,
          historical_fallback_source_ids: [null],
        }),
      ).reason,
    ).toBe("source_id_inventory_contains_invalid_value");
    expect(
      validateHistoricalLocalizationInventory(
        completeReport({ audited: false }),
        { requireAudited: true },
      ).reason,
    ).toBe("audit_not_complete");
  });

  it("uses one canonical digest across file and catch-up representations", () => {
    const fileReport = completeReport();
    const catchupReport = {
      ...completeReport({
        audited: true,
        samples: { historical_layout_unavailable: [{ source_id: "source-a" }] },
        historical_fallback_source_ids: ["source-a", "source-b"],
      }),
    };

    expect(historicalLocalizationInventoryDigest(fileReport)).toBe(
      historicalLocalizationInventoryDigest(catchupReport),
    );
    expect(
      historicalLocalizationInventoryDigest(
        completeReport({ finished_at: "2026-07-15T05:02:00.000Z" }),
      ),
    ).not.toBe(historicalLocalizationInventoryDigest(fileReport));
  });
});
