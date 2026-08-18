import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
  stage1EvidenceSchemaUpgradeExpectedManifest,
} from "./stage1-evidence-schema-upgrade.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
  stage1EvidenceSchemaUpgradeR2BindingReceiptSha256,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import {
  VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
} from "./visual-snapshot-latest-only-reconciliation.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
  createStage1EvidenceSchemaUpgradeReviewedApplyPlan,
  projectStage1EvidenceSchemaUpgradeFreshValidation,
  stage1EvidenceSchemaUpgradeFreshValidationSha256,
  stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes,
  stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256,
  validateStage1EvidenceSchemaUpgradeReviewedApplyPlan,
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";

const manifest = stage1EvidenceSchemaUpgradeExpectedManifest();
const selectedSourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const now = "2026-08-15T06:00:00.000Z";
const reportBytes = jsonBytes(reviewedReportFixture());

describe("Stage 1 reviewed exact-one apply-plan validator", () => {
  it("revalidates expired raw plan/report/manifest bytes only as historical recovery evidence", () => {
    const fixture = validFixture();
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...fixture,
      now: "2026-08-17T00:00:00.000Z",
    })).toThrow(/bounded review window/u);

    const historical =
      validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
        planBytes: fixture.planBytes,
        expectedPlanFileSha256: fixture.expectedPlanFileSha256,
        reportBytes: fixture.reportBytes,
        manifest: fixture.manifest,
      });
    expect(historical).toMatchObject({
      valid: true,
      historical_evidence_only: true,
      plan_file_sha256: fixture.expectedPlanFileSha256,
      selected_source_id: selectedSourceId,
    });
  });
  it("builds canonical bytes that independently pass the strict plan validator", () => {
    const created = createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      reportBytes,
      manifest,
      selectedSourceId,
      reviewer: {
        reviewer_id: "reviewed-operator@example.com",
        reviewed_at: "2026-08-15T05:00:00.000Z",
        expires_at: "2026-08-16T05:00:00.000Z",
      },
      now,
    });

    expect(created.plan_file_sha256).toBe(sha256(created.plan_bytes));
    expect(created.plan).toMatchObject({
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
      selected: { source: { source_id: selectedSourceId } },
      deferred_source_ids: manifest.source_ids.filter((id) => id !== selectedSourceId),
      expected_active_journal_sha256: null,
      authority: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
    });
    expect(created.checked).toMatchObject({
      valid: true,
      plan_file_sha256: created.plan_file_sha256,
      plan_sha256: created.plan.plan_sha256,
      selected_source_id: selectedSourceId,
    });
    expect(JSON.parse(created.plan_bytes.toString("utf8"))).toEqual(created.plan);
  });

  it("refuses to build authority for a blocked dry-run source", () => {
    const report = JSON.parse(reportBytes.toString("utf8"));
    const blockedSourceId = manifest.source_ids.find((id) => id !== selectedSourceId);
    expect(() => createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      reportBytes: jsonBytes(report),
      manifest,
      selectedSourceId: blockedSourceId,
      reviewer: {
        reviewer_id: "reviewed-operator@example.com",
        reviewed_at: "2026-08-15T05:00:00.000Z",
        expires_at: "2026-08-16T05:00:00.000Z",
      },
      now,
    })).toThrow(/not one exact dry_run_ready result/u);
  });

  it("validates one canonical, self-sealed plan bound to the raw reviewed report", () => {
    const fixture = validFixture();
    const checked = validateFixture(fixture);

    expect(checked).toMatchObject({
      valid: true,
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
      plan_file_sha256: fixture.expectedPlanFileSha256,
      plan_sha256: fixture.plan.plan_sha256,
      selected_source_id: selectedSourceId,
      expected_active_journal_sha256: null,
      authority: {
        required_capture_decision: "eligible_unchanged_upgrade",
        worker_run_audit_mode: "dedicated_exact_one_insert_one_terminal_update",
        allow_worker_run_supersession: false,
        allow_visual_review_candidate: false,
        allow_quarantine: false,
        allow_public_fact_writes: false,
        allow_hold_clearing: false,
      },
      fresh_validation_projection_sha256:
        fixture.plan.selected.validation.fresh_projection_sha256,
    });
    expect(checked.deferred_source_ids).toHaveLength(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_DEFERRED_COUNT,
    );
    expect(checked.deferred_source_ids).not.toContain(selectedSourceId);
    expect(checked.selected_result.status).toBe("dry_run_ready");
    expect(checked.fresh_validation_projection).toMatchObject({
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
      source_result: {
        source_id: selectedSourceId,
        capture_validation: {
          decision: "eligible_unchanged_upgrade",
        },
      },
    });
  });

  it("requires the CLI hash to bind the exact raw canonical plan bytes", () => {
    const fixture = validFixture();
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...fixture,
      expectedPlanFileSha256: "0".repeat(64),
    })).toThrow(/raw bytes differ from the CLI-expected SHA-256/u);

    const withTrailingLf = Buffer.concat([fixture.planBytes, Buffer.from("\n")]);
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...fixture,
      planBytes: withTrailingLf,
      expectedPlanFileSha256: sha256(withTrailingLf),
    })).toThrow(/not canonical sorted JSON with one LF/u);

    const pretty = Buffer.from(`${JSON.stringify(fixture.plan, null, 2)}\n`, "utf8");
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...fixture,
      planBytes: pretty,
      expectedPlanFileSha256: sha256(pretty),
    })).toThrow(/not canonical sorted JSON with one LF/u);

    const compactReport = Buffer.from(JSON.stringify(reportValue()), "utf8");
    const compactFixture = validFixture({ reportBytes: compactReport });
    expect(() => validateFixture(compactFixture))
      .toThrow(/not the exact producer JSON serialization/u);
  });

  it("rejects an invalid self-seal even when the raw file hash is exact", () => {
    const fixture = validFixture();
    fixture.plan.reviewer.reviewer_id = "another-reviewed-operator";
    refreshFileBytesWithoutResealing(fixture);
    expect(() => validateFixture(fixture)).toThrow(/canonical self-seal is invalid/u);
  });

  it.each([
    ["extra top-level authority surface", (plan) => { plan.selected_sources = []; }],
    ["missing selected binding", (plan) => { delete plan.selected; }],
    ["extra nested authority flag", (plan) => { plan.authority.allow_email = false; }],
    ["missing R2 identity", (plan) => { delete plan.selected.r2.pointer_sha256; }],
    ["missing baseline identity", (plan) => { delete plan.selected.local_baseline_identity; }],
    ["missing full pointer identity", (plan) => { delete plan.selected.existing_pointer_identity; }],
  ])("fails closed for %s", (_label, mutate) => {
    const fixture = validFixture();
    mutate(fixture.plan);
    resealFixture(fixture);
    expect(() => validateFixture(fixture)).toThrow(/extra or missing keys|authority exceeds|selected identities/u);
  });

  it("binds the exact raw dry-run report and exact full reviewed-nine selector", () => {
    const rawTamper = Buffer.from(reportBytes);
    rawTamper[rawTamper.length - 2] = rawTamper[rawTamper.length - 2] === 32 ? 10 : 32;
    const fixture = validFixture();
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...fixture,
      reportBytes: rawTamper,
    })).toThrow(/does not bind the exact raw dry-run report|not one valid JSON value/u);

    const report = reportValue();
    report.options.stage1_evidence_schema_upgrade_selector.source_ids.pop();
    const forged = validFixture({ reportBytes: jsonBytes(report) });
    expect(() => validateFixture(forged)).toThrow(/exact reviewed-nine selector/u);

    const missingResult = reportValue();
    missingResult.stage1_evidence_schema_upgrade.results.pop();
    missingResult.stage1_evidence_schema_upgrade.evaluated_source_count = 8;
    const missing = validFixture({ reportBytes: jsonBytes(missingResult) });
    expect(() => validateFixture(missing)).toThrow(/unsafe or inconsistent aggregate state|exactly nine results/u);

    const duplicateResult = reportValue();
    duplicateResult.stage1_evidence_schema_upgrade.results[0].source_id = selectedSourceId;
    const duplicate = validFixture({ reportBytes: jsonBytes(duplicateResult) });
    expect(() => validateFixture(duplicate)).toThrow(/exact parent manifest membership/u);

    const falseAggregate = reportValue();
    falseAggregate.stage1_evidence_schema_upgrade.blocked_source_count = 0;
    const falseCounts = validFixture({ reportBytes: jsonBytes(falseAggregate) });
    expect(() => validateFixture(falseCounts)).toThrow(/aggregate does not match/u);

    const applyStatus = reportValue();
    applyStatus.stage1_evidence_schema_upgrade.results[0].status = "upgraded";
    const wrongModeStatus = validFixture({ reportBytes: jsonBytes(applyStatus) });
    expect(() => validateFixture(wrongModeStatus)).toThrow(/invalid dry-run identity/u);

    const hiddenDeferredWriteReport = reportValue();
    hiddenDeferredWriteReport.stage1_evidence_schema_upgrade.results[0]
      .mutation_counts.database_writes = 1;
    hiddenDeferredWriteReport.stage1_evidence_schema_upgrade.results[0]
      .safety.database_writes = 1;
    const hiddenDeferredWrite = validFixture({
      reportBytes: jsonBytes(hiddenDeferredWriteReport),
    });
    expect(() => validateFixture(hiddenDeferredWrite))
      .toThrow(/invalid dry-run identity/u);

    const mutatedAuditReport = reportValue();
    mutatedAuditReport.worker_run_id = "33333333-3333-4333-8333-333333333333";
    const mutatedAudit = validFixture({ reportBytes: jsonBytes(mutatedAuditReport) });
    expect(() => validateFixture(mutatedAudit)).toThrow(/worker-run mutation/u);

    for (const mutate of [
      (report) => { report.status = "completed"; },
      (report) => { report.execution_status = "completed"; },
      (report) => { report.stop_reason = null; },
    ]) {
      const inconsistentReport = reportValue();
      mutate(inconsistentReport);
      const inconsistent = validFixture({ reportBytes: jsonBytes(inconsistentReport) });
      expect(() => validateFixture(inconsistent)).toThrow(/envelope is inconsistent/u);
    }
  });

  it("requires the selected source to be exactly dry_run_ready and defers the ordered complement", () => {
    const blockedReport = reportValue();
    const blocked = blockedReport.stage1_evidence_schema_upgrade.results[0];
    const fixture = validFixture({
      reportBytes: jsonBytes(blockedReport),
      selectedSourceId: blocked.source_id,
    });
    expect(() => validateFixture(fixture)).toThrow(/not one exact dry_run_ready result/u);

    for (const mutate of [
      (ids) => ids.pop(),
      (ids) => { ids[0] = ids[1]; },
      (ids) => ids.reverse(),
      (ids) => { ids[0] = selectedSourceId; },
    ]) {
      const deferred = validFixture();
      mutate(deferred.plan.deferred_source_ids);
      resealFixture(deferred);
      expect(() => validateFixture(deferred)).toThrow(/defer exactly|exact ordered complement/u);
    }
  });

  it("accepts completed authority only as deferred and derives truthful dry-run counts", () => {
    const report = reportValue();
    const alreadyUpgraded = report.stage1_evidence_schema_upgrade.results.find(
      (result) => result.status === "dry_run_evidence_failure",
    );
    const invalidAuthority = report.stage1_evidence_schema_upgrade.results.find(
      (result) => (
        result.status === "dry_run_evidence_failure"
        && result.source_id !== alreadyUpgraded.source_id
      ),
    );

    alreadyUpgraded.status = "dry_run_already_upgraded";
    alreadyUpgraded.reason_code = "completed_upgrade_authority_verified";
    alreadyUpgraded.source_eligible = true;
    alreadyUpgraded.eligibility.eligible = true;
    alreadyUpgraded.eligibility.reason_codes = [];
    alreadyUpgraded.capture_validation.decision = "already_upgraded_verified";
    alreadyUpgraded.capture_validation.reason = alreadyUpgraded.reason_code;
    invalidAuthority.status = "dry_run_completed_authority_invalid";
    invalidAuthority.reason_code = "completed_upgrade_authority_provenance_invalid";
    invalidAuthority.capture_validation.decision = "evidence_failure_quarantine";
    invalidAuthority.capture_validation.reason = invalidAuthority.reason_code;

    const stage1 = report.stage1_evidence_schema_upgrade;
    stage1.eligible_source_count = 2;
    stage1.completed_source_count = 1;
    stage1.blocked_source_count = manifest.source_count - 2;
    stage1.terminal_failure_source_count = manifest.source_count - 2;

    const created = createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      reportBytes: jsonBytes(report),
      manifest,
      selectedSourceId,
      reviewer: {
        reviewer_id: "reviewed-operator@example.com",
        reviewed_at: "2026-08-15T05:00:00.000Z",
        expires_at: "2026-08-16T05:00:00.000Z",
      },
      now,
    });
    expect(created.checked.deferred_source_ids).toContain(alreadyUpgraded.source_id);
    expect(created.checked.selected_result.status).toBe("dry_run_ready");

    expect(() => createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      reportBytes: jsonBytes(report),
      manifest,
      selectedSourceId: alreadyUpgraded.source_id,
      reviewer: {
        reviewer_id: "reviewed-operator@example.com",
        reviewed_at: "2026-08-15T05:00:00.000Z",
        expires_at: "2026-08-16T05:00:00.000Z",
      },
      now,
    })).toThrow(/not one exact dry_run_ready result/u);

    for (const mutate of [
      (value) => { value.completed_source_count = 0; },
      (value) => { value.blocked_source_count = manifest.source_count - 1; },
      (value) => { value.upgraded_source_count = 1; },
    ]) {
      const forged = structuredClone(report);
      mutate(forged.stage1_evidence_schema_upgrade);
      const fixture = validFixture({ reportBytes: jsonBytes(forged) });
      expect(() => validateFixture(fixture)).toThrow(/aggregate does not match/u);
    }
  });

  it.each([
    ["acquisition file", (plan) => { plan.selected.acquisition.file_sha256 = "0".repeat(64); }],
    ["activation guard", (plan) => { plan.selected.activation.guard_sha256 = "1".repeat(64); }],
    ["finalization receipt", (plan) => { plan.selected.finalization.receipt_sha256 = "2".repeat(64); }],
    ["source result", (plan) => { plan.selected.result.result_sha256 = "3".repeat(64); }],
    ["capture validation", (plan) => { plan.selected.validation.capture_validation_sha256 = "4".repeat(64); }],
    ["fresh projection", (plan) => { plan.selected.validation.fresh_projection_sha256 = "5".repeat(64); }],
    ["R2 receipt", (plan) => { plan.selected.r2.binding_receipt_sha256 = "6".repeat(64); }],
    ["R2 pointer", (plan) => { plan.selected.r2.pointer_sha256 = "7".repeat(64); }],
    ["R2 generation", (plan) => { plan.selected.r2.immutable_generation = "8".repeat(32); }],
    ["recovery evidence", (plan) => { plan.selected.recovery_evidence_sha256 = "9".repeat(64); }],
  ])("rejects a resealed plan with a different %s identity", (_label, mutate) => {
    const fixture = validFixture();
    mutate(fixture.plan);
    resealFixture(fixture);
    expect(() => validateFixture(fixture)).toThrow(/selected identities differ/u);
  });

  it("rejects malformed hash domains even when canonical and self-sealed", () => {
    const uppercase = validFixture();
    uppercase.plan.selected.r2.pointer_sha256 =
      uppercase.plan.selected.r2.pointer_sha256.toUpperCase();
    resealFixture(uppercase);
    expect(() => validateFixture(uppercase)).toThrow(/selected identities differ/u);

    const badExpected = validFixture();
    expect(() => validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      ...badExpected,
      expectedPlanFileSha256: badExpected.expectedPlanFileSha256.toUpperCase(),
    })).toThrow(/lowercase SHA-256/u);
  });

  it.each([
    ["quarantine", (authority) => { authority.allow_quarantine = true; }],
    ["candidate", (authority) => { authority.allow_visual_review_candidate = true; }],
    ["public facts", (authority) => { authority.allow_public_fact_writes = true; }],
    ["hold clearing", (authority) => { authority.allow_hold_clearing = true; }],
    ["automatic reconciliation", (authority) => {
      authority.automatic_reconciliation = true;
    }],
    ["unreviewed recovery", (authority) => {
      authority.separately_reviewed_exact_transaction_recovery = false;
    }],
    ["worker-run supersession", (authority) => {
      authority.allow_worker_run_supersession = true;
    }],
    ["generic worker-run audit", (authority) => {
      authority.worker_run_audit_mode = "generic_visual_worker";
    }],
  ])("does not grant %s authority", (_label, mutate) => {
    const fixture = validFixture();
    mutate(fixture.plan.authority);
    resealFixture(fixture);
    expect(() => validateFixture(fixture)).toThrow(/authority exceeds unchanged evidence upgrade scope/u);
  });

  it("requires an absent active journal and a bounded, current named review", () => {
    const journal = validFixture();
    journal.plan.expected_active_journal_sha256 = "a".repeat(64);
    resealFixture(journal);
    expect(() => validateFixture(journal)).toThrow(/expected_active_journal_sha256 to be null/u);

    const expired = validFixture();
    expired.plan.reviewer.expires_at = now;
    resealFixture(expired);
    expect(() => validateFixture(expired)).toThrow(/bounded review window/u);

    const future = validFixture();
    future.plan.reviewer.reviewed_at = "2026-08-15T07:00:00.000Z";
    future.plan.reviewer.expires_at = "2026-08-15T08:00:00.000Z";
    resealFixture(future);
    expect(() => validateFixture(future)).toThrow(/bounded review window/u);

    const tooLong = validFixture();
    tooLong.plan.reviewer.expires_at = new Date(
      Date.parse(tooLong.plan.reviewer.reviewed_at)
        + STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_MAX_LIFETIME_MS
        + 1,
    ).toISOString();
    resealFixture(tooLong);
    expect(() => validateFixture(tooLong)).toThrow(/bounded review window/u);

    const unnamed = validFixture();
    unnamed.plan.reviewer.reviewer_id = " operator ";
    resealFixture(unnamed);
    expect(() => validateFixture(unnamed)).toThrow(/reviewer identity/u);
  });

  it("rejects a forged report R2 identity even when the plan binds the forged raw bytes", () => {
    const report = reportValue();
    const ready = readyResult(report);
    ready.capture_validation.evidence.authoritative_existing_r2_binding
      .pointer_identity.immutable_generation = "0".repeat(32);
    const fixture = validFixture({ reportBytes: jsonBytes(report) });
    expect(() => validateFixture(fixture)).toThrow(/receipt seal|altered|R2 binding/u);
  });

  it.each([
    ["missing local baseline", (evidence) => { delete evidence.local_baseline_identity; }],
    ["empty local baseline", (evidence) => {
      evidence.local_baseline_identity.byte_length = 0;
    }],
    ["uppercase local baseline hash", (evidence) => {
      evidence.local_baseline_identity.sha256 =
        evidence.local_baseline_identity.sha256.toUpperCase();
    }],
    ["absent pointer", (evidence) => {
      evidence.existing_pointer_identity.exists = false;
    }],
    ["wrong pointer schema", (evidence) => {
      evidence.existing_pointer_identity.schema_version = "wrong";
    }],
    ["extra pointer projection", (evidence) => {
      evidence.existing_pointer_identity.projection = {};
    }],
  ])("rejects a reviewed report with %s authority", (_label, mutate) => {
    const report = reportValue();
    mutate(readyResult(report).capture_validation.evidence);
    const fixture = validFixture({ reportBytes: jsonBytes(report) });
    expect(() => validateFixture(fixture)).toThrow(
      /local baseline|pointer identity|lowercase SHA-256|extra or missing keys/u,
    );
  });
});

describe("Stage 1 stable fresh-validation projection", () => {
  it("excludes only schema-defined prospective capture/evaluation volatility", () => {
    const left = structuredClone(readyResult(reportValue()));
    left.capture_validation.evidence.pdf_text_recovery = {
      receipt_sha256: "b".repeat(64),
      recovery: { recovered_text_sha256: "c".repeat(64) },
      prospective_observation: {
        captured_at: "2026-08-15T04:17:00.000Z",
        parser_metadata_object_sha256: "d".repeat(64),
        parser_metadata_object_bytes: 100,
        parser_text_sha256: "e".repeat(64),
      },
      authorized_local_candidate_mutation: {
        captured_at: "2026-08-15T04:17:00.000Z",
        scope: "new_uncommitted_capture_generation_only",
      },
    };
    const right = structuredClone(left);
    right.evaluated_at = "2026-08-15T09:00:00.000Z";
    right.capture_validation.evidence.capture.captured_at =
      "2026-08-15T09:00:01.000Z";
    right.capture_validation.evidence.capture.layout_hash = "0".repeat(64);
    right.capture_validation.evidence.pdf_text_recovery.receipt_sha256 = "f".repeat(64);
    right.capture_validation.evidence.pdf_text_recovery
      .prospective_observation.captured_at = "2026-08-15T09:00:03.000Z";
    right.capture_validation.evidence.pdf_text_recovery
      .prospective_observation.parser_metadata_object_sha256 = "1".repeat(64);
    right.capture_validation.evidence.pdf_text_recovery
      .prospective_observation.parser_metadata_object_bytes = 200;
    right.capture_validation.evidence.pdf_text_recovery
      .authorized_local_candidate_mutation.captured_at = "2026-08-15T09:00:04.000Z";

    expect(stage1EvidenceSchemaUpgradeFreshValidationSha256(left))
      .toBe(stage1EvidenceSchemaUpgradeFreshValidationSha256(right));
    const projection = projectStage1EvidenceSchemaUpgradeFreshValidation(left);
    expect(projection.source_result).not.toHaveProperty("evaluated_at");
    expect(projection.source_result.capture_validation.evidence.capture)
      .not.toHaveProperty("captured_at");
    expect(projection.source_result.capture_validation.evidence.capture)
      .not.toHaveProperty("layout_hash");
    expect(projection.source_result.capture_validation.evidence.pdf_text_recovery)
      .not.toHaveProperty("receipt_sha256");
    expect(left.capture_validation.evidence.capture)
      .toHaveProperty("captured_at", "2026-08-15T04:17:00.000Z");
  });

  it.each([
    ["semantic text", (row) => {
      row.capture_validation.evidence.comparison.semantic_fields.text_hash.current = "0".repeat(64);
    }],
    ["primary visual", (row) => {
      row.capture_validation.evidence.comparison.primary_visual_identity.current = "1".repeat(64);
    }],
    ["existing layout authority", (row) => {
      row.capture_validation.evidence.existing.layout_hash = "2".repeat(64);
    }],
    ["prospective image", (row) => {
      row.capture_validation.evidence.capture.image_hash = "2".repeat(64);
    }],
    ["prospective text", (row) => {
      row.capture_validation.evidence.capture.text_hash = "3".repeat(64);
    }],
    ["prospective final URL", (row) => {
      row.capture_validation.evidence.capture.final_url = "https://example.com/drifted";
    }],
    ["coverage", (row) => {
      row.capture_validation.evidence.capture.expansion_coverage_status = "incomplete";
    }],
    ["retained expansion count", (row) => {
      row.capture_validation.evidence.capture.retained_expansion_state_count = 3;
    }],
    ["artifact slots", (row) => {
      row.capture_validation.evidence.capture.artifact_slots = ["layout", "page"];
    }],
    ["existing authority", (row) => {
      row.capture_validation.evidence.existing.text_hash = "3".repeat(64);
    }],
    ["local baseline bytes", (row) => {
      row.capture_validation.evidence.local_baseline_identity.sha256 = "9".repeat(64);
    }],
    ["complete pointer identity", (row) => {
      row.capture_validation.evidence.existing_pointer_identity.canonical_sha256 =
        "a".repeat(64);
    }],
    ["acquisition", (row) => {
      row.capture_validation.evidence.immutable_acquisition.file_hash = "4".repeat(64);
    }],
    ["finalization", (row) => {
      row.eligibility.finalization_binding.finalization_receipt_sha256 = "5".repeat(64);
    }],
    ["R2 pointer", (row) => {
      row.capture_validation.evidence.authoritative_existing_r2_binding
        .pointer_identity.pointer_sha256 = "6".repeat(64);
    }],
    ["R2 role", (row) => {
      row.capture_validation.evidence.authoritative_existing_r2_binding
        .verified_roles[0].sha256 = "7".repeat(64);
    }],
    ["recovery evidence", (row) => {
      row.capture_validation.evidence.prior_recovery = { journal_sha256: "8".repeat(64) };
    }],
    ["result status", (row) => {
      row.status = "blocked";
    }],
    ["result reason", (row) => {
      row.reason_code = "changed_authority";
    }],
    ["planned pointer outcome", (row) => {
      row.pointer_journal = { status: "not_planned" };
    }],
    ["quarantine outcome", (row) => {
      row.quarantine = { status: "would_write" };
    }],
    ["safety authority", (row) => {
      row.safety.public_fact_writes = 1;
    }],
    ["unknown local-looking evidence", (row) => {
      row.capture_validation.evidence.capture.unreviewed_path_alias = "E:/not-known";
    }],
    ["unknown known-looking path evidence", (row) => {
      row.capture_validation.evidence.capture.text_path = "E:/must-remain-bound.txt";
    }],
    ["unknown nested captured_at evidence", (row) => {
      row.capture_validation.evidence.capture.nested = {
        captured_at: "2026-08-15T09:00:02.000Z",
      };
    }],
  ])("retains %s drift", (_label, mutate) => {
    const original = structuredClone(readyResult(reportValue()));
    const changed = structuredClone(original);
    mutate(changed);
    expect(stage1EvidenceSchemaUpgradeFreshValidationSha256(changed))
      .not.toBe(stage1EvidenceSchemaUpgradeFreshValidationSha256(original));
  });
});

function validFixture({
  reportBytes: selectedReportBytes = reportBytes,
  selectedSourceId: sourceId = selectedSourceId,
} = {}) {
  const report = JSON.parse(selectedReportBytes.toString("utf8"));
  const stage1 = report.stage1_evidence_schema_upgrade;
  const row = stage1.results.find((result) => result.source_id === sourceId);
  const manifestSource = manifest.sources.find((source) => source.source_id === sourceId);
  const evidence = row.capture_validation.evidence;
  const eligibility = row.eligibility;
  const r2 = evidence.authoritative_existing_r2_binding;
  const pointer = r2.pointer_identity;
  const recoveryEvidence = {
    pdf_text_recovery: evidence.pdf_text_recovery ?? null,
    prior_recovery: evidence.prior_recovery ?? null,
  };
  const plan = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_SCHEMA,
    manifest: {
      schema_version: manifest.schema_version,
      sha256: sha256(canonicalJson(manifest)),
      source_count: manifest.source_count,
    },
    dry_run_report: {
      file_sha256: sha256(selectedReportBytes),
      report_schema_version: report.report_schema_version,
      attempt_id: report.run_identity.attempt_id,
      worker_run_id: report.worker_run_id ?? null,
      started_at: report.started_at,
      finished_at: report.finished_at,
      stage1_report_schema_version: stage1.schema_version,
      stage1_report_generated_at: stage1.generated_at,
      stage1_report_sha256: sha256(canonicalJson(stage1)),
      manifest_sha256: stage1.manifest_sha256,
    },
    selected: {
      source: structuredClone(manifestSource),
      result: {
        schema_version: row.schema_version,
        evaluated_at: row.evaluated_at,
        result_sha256: sha256(canonicalJson(row)),
        status: row.status,
        reason_code: row.reason_code,
      },
      validation: {
        status: row.capture_validation.status,
        decision: row.capture_validation.decision,
        reason: row.capture_validation.reason,
        capture_validation_sha256: sha256(canonicalJson(row.capture_validation)),
        fresh_projection_schema:
          STAGE1_EVIDENCE_SCHEMA_UPGRADE_FRESH_VALIDATION_PROJECTION_SCHEMA,
        fresh_projection_sha256:
          stage1EvidenceSchemaUpgradeFreshValidationSha256(row),
      },
      acquisition: {
        source_acquisition_id:
          eligibility.finalization_binding.source_acquisition_id,
        file_sha256: evidence.immutable_acquisition.file_hash,
        text_sha256: evidence.immutable_acquisition.text_hash,
        normalized_text_sha256:
          evidence.immutable_acquisition.normalized_text_hash,
        evidence_quote_count:
          evidence.immutable_acquisition.evidence_quote_count,
      },
      activation: {
        guard_sha256: eligibility.activation_binding.guard_sha256,
        binding_reason: eligibility.activation_binding.reason,
      },
      finalization: {
        receipt_sha256:
          eligibility.finalization_binding.finalization_receipt_sha256,
        finalized_at: eligibility.finalization_binding.finalized_at,
      },
      local_baseline_identity: structuredClone(evidence.local_baseline_identity ?? null),
      existing_pointer_identity: structuredClone(evidence.existing_pointer_identity ?? null),
      r2: {
        binding_receipt_sha256: r2.receipt_sha256,
        pointer_sha256: pointer.pointer_sha256,
        previous_pointer_projection_sha256:
          r2.previous_pointer.projection_sha256,
        latest_metadata_sha256: pointer.latest_metadata_sha256,
        immutable_generation: pointer.immutable_generation,
        bucket: pointer.bucket,
        kind: r2.kind,
        captured_at: r2.captured_at,
        pointer_latest_object_keys_sha256:
          sha256(canonicalJson(pointer.latest_object_keys)),
        pointer_latest_hashes_sha256:
          sha256(canonicalJson(pointer.latest_hashes)),
        verified_roles_sha256: sha256(canonicalJson(r2.verified_roles)),
        semantic_text_sha256: r2.semantic_text.sha256,
      },
      recovery_evidence_sha256: sha256(canonicalJson(recoveryEvidence)),
    },
    deferred_source_ids: manifest.source_ids.filter((id) => id !== sourceId),
    reviewer: {
      reviewer_id: "reviewed-operator@example.com",
      reviewed_at: "2026-08-15T05:00:00.000Z",
      expires_at: "2026-08-16T05:00:00.000Z",
    },
    expected_active_journal_sha256: null,
    authority: structuredClone(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_APPLY_PLAN_AUTHORITY,
    ),
    plan_sha256: null,
  };
  plan.plan_sha256 = stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256(plan);
  const fixture = {
    plan,
    planBytes: stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes(plan),
    expectedPlanFileSha256: null,
    reportBytes: selectedReportBytes,
    manifest,
    now,
  };
  fixture.expectedPlanFileSha256 = sha256(fixture.planBytes);
  return fixture;
}

function validateFixture(fixture) {
  return validateStage1EvidenceSchemaUpgradeReviewedApplyPlan(fixture);
}

function resealFixture(fixture) {
  fixture.plan.plan_sha256 = stage1EvidenceSchemaUpgradeReviewedApplyPlanSha256(
    fixture.plan,
  );
  refreshFileBytesWithoutResealing(fixture);
}

function refreshFileBytesWithoutResealing(fixture) {
  fixture.planBytes = stage1EvidenceSchemaUpgradeReviewedApplyPlanCanonicalBytes(
    fixture.plan,
  );
  fixture.expectedPlanFileSha256 = sha256(fixture.planBytes);
}

function reportValue() {
  return JSON.parse(reportBytes.toString("utf8"));
}

function reviewedReportFixture() {
  const manifestSha256 = sha256(canonicalJson(manifest));
  const results = manifest.sources.map((source) => reviewedSourceResultFixture({
    source,
    manifestSha256,
    ready: source.source_id === selectedSourceId,
  }));
  return {
    report_schema_version: 2,
    worker_run_id: null,
    started_at: "2026-08-15T04:16:04.313Z",
    finished_at: "2026-08-15T04:18:00.000Z",
    status: "blocked",
    execution_status: "blocked",
    stop_reason: "stage1_evidence_schema_upgrade_not_ready",
    run_identity: {
      workflow: "visual_capture",
      trigger: "manual",
      shard_count: 1,
      shard_index: 0,
      attempt_id: "11111111-1111-4111-8111-111111111111",
    },
    options: {
      stage1_evidence_schema_upgrade: true,
      stage1_evidence_schema_upgrade_dry_run: true,
      source_id: null,
      source_ids_filter_count: manifest.source_count,
      limit: manifest.source_count,
      stage1_evidence_schema_upgrade_selector: {
        exact_source_count: manifest.source_count,
        dry_run: true,
        source_ids: [...manifest.source_ids],
      },
    },
    stage1_evidence_schema_upgrade: {
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
      mode: "dry_run",
      generated_at: "2026-08-15T04:17:30.000Z",
      manifest_sha256: manifestSha256,
      exact_source_count: manifest.source_count,
      evaluated_source_count: manifest.source_count,
      eligible_source_count: 1,
      upgraded_source_count: 0,
      candidate_source_count: 0,
      quarantined_source_count: 0,
      completed_source_count: 0,
      blocked_source_count: manifest.source_count - 1,
      terminal_failure_source_count: manifest.source_count - 1,
      automated_work_clear: false,
      quarantined_work_remaining: 0,
      status: "blocked",
      mutation_counts_are_exact: true,
      mutation_count_semantics: "exact",
      mutation_count_uncertain_source_count: 0,
      unknown_write_categories: [],
      mutation_counts: zeroMutationCountsFixture(),
      safety: dryRunSafetyFixture(),
      results,
    },
  };
}

function reviewedSourceResultFixture({ source, manifestSha256, ready }) {
  const reasonCode = ready
    ? "exact_semantic_and_primary_visual_identity_verified"
    : "existing_baseline_semantic_identity_mismatch";
  const guardSha256 = fixtureSha256(`${source.source_id}:guard`);
  return {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    mode: "dry_run",
    source_id: source.source_id,
    manifest_sha256: manifestSha256,
    evaluated_at: "2026-08-15T04:17:00.000Z",
    source_eligible: ready,
    status: ready ? "dry_run_ready" : "dry_run_evidence_failure",
    reason_code: reasonCode,
    eligibility: {
      activation_binding: {
        applies: true,
        allowed: true,
        guard_sha256: guardSha256,
        reason: "stage1_baseline_activation_exact_binding_verified",
      },
      award: source.award,
      eligible: ready,
      evidence_completeness_checked: false,
      finalization_binding: {
        present: true,
        source_acquisition_id: "22222222-2222-4222-8222-222222222222",
        finalization_receipt_sha256: fixtureSha256(`${source.source_id}:finalization`),
        finalized_at: "2026-08-14T19:00:00.000Z",
      },
      manifest_item: source.item,
      page: source.page,
      reason_codes: ready ? [] : [reasonCode],
      semantic_difference_checked: false,
      source_id: source.source_id,
    },
    capture_validation: {
      status: "evaluated",
      decision: ready
        ? "eligible_unchanged_upgrade"
        : "evidence_failure_quarantine",
      reason: reasonCode,
      evidence: reviewedEvidenceFixture({
        sourceId: source.source_id,
        guardSha256,
      }),
    },
    queue_policy: {
      context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
      bypassRejectionLedger: true,
      queueReconciliation: false,
    },
    pointer_journal: ready ? { status: "would_commit" } : { status: "not_planned" },
    visual_review_candidate: { status: "not_planned" },
    quarantine: { status: "not_planned" },
    mutation_counts: zeroMutationCountsFixture(),
    safety: dryRunSafetyFixture(),
  };
}

function reviewedEvidenceFixture({ sourceId, guardSha256 }) {
  const textHash = fixtureSha256(`${sourceId}:text`);
  return {
    source_id: sourceId,
    kind: "webpage",
    local_baseline_identity: {
      sha256: fixtureSha256(`${sourceId}:local-baseline`),
      byte_length: 12_345,
    },
    existing_pointer_identity: {
      schema_version: VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
      exists: true,
      canonical_sha256: fixtureSha256(`${sourceId}:complete-pointer`),
    },
    immutable_acquisition: {
      file_hash: fixtureSha256(`${sourceId}:file`),
      text_hash: textHash,
      normalized_text_hash: fixtureSha256(`${sourceId}:normalized-text`),
      evidence_quote_count: 1,
      guard_sha256: guardSha256,
    },
    authoritative_existing_r2_binding: reviewedR2BindingFixture(sourceId, textHash),
    existing: {
      text_hash: textHash,
      layout_hash: fixtureSha256(`${sourceId}:existing-layout`),
    },
    capture: {
      captured_at: "2026-08-15T04:17:00.000Z",
      final_url: "https://example.com/faq",
      text_hash: textHash,
      image_hash: fixtureSha256(`${sourceId}:image`),
      layout_hash: fixtureSha256(`${sourceId}:layout`),
      retained_expansion_state_count: 4,
      expansion_coverage_status: "complete",
      artifact_slots: ["layout", "meta", "page", "text", "thumb"],
      raw_metadata_verified: true,
    },
    comparison: {
      semantic_fields: {
        text_hash: { current: textHash },
      },
      primary_visual_identity: {
        current: fixtureSha256(`${sourceId}:primary-visual`),
      },
    },
    pdf_text_recovery: null,
    prior_recovery: null,
  };
}

function reviewedR2BindingFixture(sourceId, textHash) {
  const key = `snapshots/${sourceId}/${"a".repeat(32)}/text.txt`;
  const pointerContent = {
    shared_award_source_id: sourceId,
    kind: "webpage",
    bucket: "reviewed-fixture-bucket",
    immutable_generation: "a".repeat(32),
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: { text: key },
    latest_hashes: { text_hash: textHash },
    latest_metadata_sha256: fixtureSha256(`${sourceId}:metadata`),
  };
  const previousPointerContent = {
    preserved: true,
    verification_scope: "report_only_not_validated",
  };
  const receiptContent = {
    schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
    status: "verified",
    source_id: sourceId,
    kind: "webpage",
    captured_at: "2026-08-14T18:00:00.000Z",
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerContent,
      pointer_sha256: sha256(canonicalJson(pointerContent)),
    },
    previous_pointer: {
      ...previousPointerContent,
      projection_sha256: sha256(canonicalJson(previousPointerContent)),
    },
    verified_roles: [{
      role: "text",
      key,
      sha256: textHash,
      byte_length: 42,
      content_type: "text/plain; charset=utf-8",
      remote_body_verified: true,
    }],
    semantic_text: {
      sha256: textHash,
      character_length: 41,
      object_byte_length: 42,
      writer_framing: "lf",
    },
  };
  return {
    ...receiptContent,
    receipt_sha256:
      stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receiptContent),
  };
}

function zeroMutationCountsFixture() {
  return {
    database_writes: 0,
    r2_writes: 0,
    local_baseline_writes: 0,
    candidate_writes: 0,
    quarantine_writes: 0,
    source_state_writes: 0,
  };
}

function dryRunSafetyFixture() {
  return {
    creates_api_charge: false,
    live_capture_permitted: true,
    local_capture_artifacts_permitted: true,
    public_fact_writes: 0,
    reconciliation_requests: 0,
    public_events: 0,
    source_discovery: false,
    baseline_refreshes: 0,
    ...zeroMutationCountsFixture(),
  };
}

function fixtureSha256(label) {
  return sha256(Buffer.from(label, "utf8"));
}

function readyResult(report) {
  return report.stage1_evidence_schema_upgrade.results.find(
    (result) => result.status === "dry_run_ready",
  );
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
