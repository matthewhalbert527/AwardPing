import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGRESSION_AUDIT_RUN_ONLY_PATHS } from "./lib/regression-audit-observation.mjs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717071500_stage1_regression_audit_observations.sql",
    import.meta.url,
  ),
  "utf8",
);
const runner = readFileSync(
  new URL("./evaluate-public-page-audit-canaries.mjs", import.meta.url),
  "utf8",
);
const readinessReader = readFileSync(
  new URL("./read-stage1-cohort-readiness.mjs", import.meta.url),
  "utf8",
);
const readinessCore = readFileSync(
  new URL("./lib/stage1-cohort-readiness.mjs", import.meta.url),
  "utf8",
);
const adminGate = readFileSync(
  new URL("../src/lib/admin-stage1-release-gate.ts", import.meta.url),
  "utf8",
);
const stage1RegistryMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260716204011_stage1_publication_registry.sql",
    import.meta.url,
  ),
  "utf8",
);
const stage1PromotionMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260716214500_stage1_reviewed_promotion.sql",
    import.meta.url,
  ),
  "utf8",
);

const invalidationHelper = migration.slice(
  migration.indexOf(
    "create or replace function private.invalidate_stage1_release_for_regression_audit",
  ),
  migration.indexOf(
    "revoke all on function private.invalidate_stage1_release_for_regression_audit",
  ),
);
const regressionWriter = migration.slice(
  migration.indexOf(
    "create or replace function public.record_shared_award_regression_audit(",
  ),
  migration.indexOf(
    "revoke all on function public.record_shared_award_regression_audit(uuid, jsonb, text)",
  ),
);
const evaluationBasis = migration.slice(
  migration.indexOf(
    "create or replace function private.regression_audit_evaluation_basis(",
  ),
  migration.indexOf(
    "revoke all on function private.regression_audit_evaluation_basis(uuid)",
  ),
);

describe("Stage 1 regression audit observations", () => {
  it("records regression evidence and the scan cursor in one idempotent RPC", () => {
    expect(migration).toContain("record_shared_award_regression_audit");
    expect(migration).toContain(
      "shared_award_page_audits_regression_observation_idx",
    );
    expect(migration).toContain("for update;");
    expect(migration).toContain("observation_key");
    expect(migration).toContain("shared_award_regression_audit_state");
    expect(migration).toContain(
      "shared_award_regression_audit_state_rotation_idx",
    );
    expect(migration).toContain(
      "last_attempted_at = excluded.last_attempted_at",
    );
    expect(migration).toContain("last_evaluated_at timestamptz");
    expect(migration).toContain(
      "when v_state_advanced then excluded.last_audit_error",
    );
    expect(migration).toContain("scheduled_regression_pass");
    expect(migration).toContain("v_should_block");
    expect(migration).toContain(
      "v_status_blocks is distinct from v_severity_blocks",
    );
    expect(migration).toContain(
      "Regression audit status and severity must agree on whether publication is blocked.",
    );
    expect(migration).toContain(
      "Regression audit error state must agree with the blocking audit outcome.",
    );
    expect(migration).toContain("audit.severity in ('error', 'critical')");
    expect(migration).toContain(
      "applied_to_public' is distinct from 'false'::jsonb",
    );
    expect(migration).not.toMatch(
      /update public\.shared_awards[\s\S]*public_facts\s*=/i,
    );
    expect(migration).not.toContain("last_structure_scan_at");
    expect(migration).not.toContain("structure_scan_error");
    expect(migration).not.toMatch(
      /alter table public\.shared_awards\s+add column/i,
    );
  });

  it("recursively removes volatile run timestamps while retaining material evidence identity", () => {
    expect(migration).toContain("private.regression_audit_stable_value");
    expect(REGRESSION_AUDIT_RUN_ONLY_PATHS).toEqual([
      "public_page_snapshot.evaluated_at",
      "*.reconciliation.generated_at",
      "*.observation_key",
    ]);
    expect(migration).toContain(
      "coalesce(p_parent_key = 'public_page_snapshot', false)",
    );
    expect(migration).toContain("entry.key = 'evaluated_at'");
    expect(migration).toContain(
      "coalesce(p_parent_key = 'reconciliation', false)",
    );
    expect(migration).toContain("entry.key = 'generated_at'");
    expect(migration).not.toMatch(/entry\.key\s*!~\*/);
    expect(migration).not.toContain(
      "entry.key <> 'reconciliation_audit_signature'",
    );
    expect(migration).toContain(
      "'selected_fact_summary', p_audit_row -> 'selected_fact_summary'",
    );
    expect(migration).toContain("'public_page_snapshot', v_snapshot");
    expect(migration).toContain("'observation_key'");
    expect(migration).toContain(
      "public.stage1_publication_evidence_hash(\n    v_observation_basis",
    );
  });

  it("deduplicates only the currently unresolved occurrence so a resolved failure may recur", () => {
    expect(migration).toMatch(
      /where audit_kind = 'regression'[\s\S]*public_page_snapshot ->> 'observation_key' is not null[\s\S]*resolved_at is null;/,
    );
    expect(migration).toMatch(
      /audit\.public_page_snapshot ->> 'observation_key' = v_observation_key\s+and audit\.resolved_at is null/,
    );
    expect(migration).toContain("and audit.id <> v_audit_id");
  });

  it("keeps canonical Stage 1 selectors on deterministic audits", () => {
    expect(
      migration.match(/audit\.audit_kind = 'deterministic'/g),
    ).toHaveLength(4);
    expect(migration).toContain(
      "private.stage1_promotion_review_snapshot(text)",
    );
    expect(migration).toContain(
      "public.transition_stage1_award_publication(text,text,text,text,text)",
    );
    expect(migration).toContain(
      "public.stage1_effective_publication_reason(text,timestamp with time zone)",
    );
    expect(readinessReader).toContain('.eq("audit_kind", "deterministic")');
    expect(readinessCore).toContain('audit.audit_kind === "deterministic"');
    expect(adminGate).toContain('.eq("audit_kind", "deterministic")');
    expect(stage1RegistryMigration).not.toContain(
      "shared_award_regression_audit_state",
    );
    expect(stage1PromotionMigration).not.toContain(
      "shared_award_regression_audit_state",
    );
  });

  it("atomically invalidates an affected award, national release, and ready acceptances", () => {
    const nationalLockAt = invalidationHelper.indexOf(
      "perform pg_catalog.pg_advisory_xact_lock(",
    );
    const registryLockAt = invalidationHelper.indexOf(
      "select * into v_registry",
    );
    const auditLockAt = invalidationHelper.indexOf(
      "select * into v_regression_audit",
    );
    const acceptanceRejectionAt = invalidationHelper.indexOf(
      "update public.stage1_release_acceptance_records acceptance",
    );

    expect(invalidationHelper).toContain(
      "pg_catalog.hashtextextended('stage1-national-25-release', 0)",
    );
    expect(nationalLockAt).toBeGreaterThan(-1);
    expect(auditLockAt).toBeGreaterThan(nationalLockAt);
    expect(registryLockAt).toBeGreaterThan(nationalLockAt);
    expect(acceptanceRejectionAt).toBeGreaterThan(registryLockAt);
    expect(invalidationHelper).toMatch(
      /audit\.audit_kind = 'regression'[\s\S]*audit\.resolved_at is null[\s\S]*audit\.public_page_snapshot ->> 'observation_key' = p_observation_key/,
    );
    expect(invalidationHelper).toContain("audit.audit_kind = 'deterministic'");
    expect(invalidationHelper).toMatch(
      /update public\.stage1_release_acceptance_records acceptance[\s\S]*set status = 'rejected'[\s\S]*acceptance\.status = 'ready'/,
    );
    expect(invalidationHelper).toMatch(
      /update public\.stage1_award_registry registry[\s\S]*publication_state = 'revalidation_pending'[\s\S]*release_epoch = null/,
    );
    expect(invalidationHelper).toMatch(
      /update public\.stage1_publication_release_state release_state[\s\S]*release_state = 'revalidation_pending'[\s\S]*release_epoch = null[\s\S]*activated_at = null/,
    );
    expect(invalidationHelper).toContain(
      "where registry.release_epoch is not null",
    );
    expect(invalidationHelper).toContain(
      "insert into public.stage1_award_publication_events",
    );
    expect(invalidationHelper).toContain(
      "insert into public.stage1_publication_release_events",
    );
    expect(invalidationHelper).toContain("'stage1-blocking-regression-v1'");
    expect(invalidationHelper).toContain(
      "'regression', pg_catalog.jsonb_build_object(",
    );
    expect(invalidationHelper).toContain(
      "'audit_kind', v_regression_audit.audit_kind",
    );
    expect(invalidationHelper).toContain(
      "'deterministic_publication', pg_catalog.jsonb_build_object(",
    );
    expect(invalidationHelper).toContain("'audit_kind', 'deterministic'");
    expect(invalidationHelper).toContain(
      "'page_audit_id', v_deterministic_audit_id",
    );
    expect(invalidationHelper).toContain(
      "'fact_ledger_batch_id', v_registry.fact_ledger_batch_id",
    );
    expect(invalidationHelper).not.toMatch(/fact_ledger_batch_id\s*=/);
    expect(invalidationHelper).not.toContain(
      "update public.shared_award_page_audits",
    );
    expect(invalidationHelper).not.toContain("update public.shared_awards");
    expect(invalidationHelper).not.toContain("sync_manual_quarantine_registry");
    expect(migration).toMatch(
      /revoke all on function private\.invalidate_stage1_release_for_regression_audit\(\s*uuid, uuid, text, timestamptz\s*\) from public, anon, authenticated, service_role;/,
    );
  });

  it("runs fail-closed invalidation inside the blocking observation writer transaction", () => {
    const auditInsertAt = regressionWriter.indexOf(
      "insert into public.shared_award_page_audits",
    );
    const invalidationAt = regressionWriter.indexOf(
      "private.invalidate_stage1_release_for_regression_audit(",
    );
    const stateWriteAt = regressionWriter.indexOf(
      "insert into public.shared_award_regression_audit_state",
    );
    const responseAt = regressionWriter.indexOf(
      "return pg_catalog.jsonb_build_object(",
    );

    expect(auditInsertAt).toBeGreaterThan(-1);
    expect(invalidationAt).toBeGreaterThan(auditInsertAt);
    expect(stateWriteAt).toBeGreaterThan(invalidationAt);
    expect(responseAt).toBeGreaterThan(stateWriteAt);
    expect(regressionWriter).toMatch(
      /if not v_should_block then[\s\S]*else\s+v_stage1_invalidation :=[\s\S]*private\.invalidate_stage1_release_for_regression_audit/,
    );
    expect(regressionWriter).toContain(
      "'stage1_invalidation', v_stage1_invalidation",
    );
    expect(regressionWriter).not.toContain(
      "transition_stage1_award_publication",
    );
    expect(regressionWriter).not.toContain("transition_stage1_cohort_release");
  });

  it("takes the national Stage 1 fence before the award row lock", () => {
    const nationalFence = regressionWriter.indexOf(
      "pg_catalog.hashtextextended('stage1-national-25-release', 0)",
    );
    const awardLock = regressionWriter.indexOf(
      "from public.shared_awards award\n  where award.id = p_shared_award_id\n  for update;",
    );

    expect(nationalFence).toBeGreaterThan(-1);
    expect(awardLock).toBeGreaterThan(nationalFence);
    expect(regressionWriter.slice(0, nationalFence)).not.toContain("for update");
    expect(regressionWriter.slice(0, nationalFence)).not.toContain("for share");
    expect(regressionWriter.slice(0, nationalFence)).not.toContain(
      "from public.stage1_award_members",
    );
  });

  it("binds selection to every ordered evaluation input and rejects award or source drift", () => {
    expect(evaluationBasis).toContain("'stage1-regression-evaluation-v1'");
    for (const awardField of [
      "'name', award.name",
      "'slug', award.slug",
      "'official_homepage', award.official_homepage",
      "'summary', award.summary",
      "'public_facts', award.public_facts",
      "'confidence', award.confidence",
      "'status', award.status",
    ]) expect(evaluationBasis).toContain(awardField);
    expect(evaluationBasis).toContain("from public.shared_award_sources source_row");
    expect(evaluationBasis).toContain("source_row.admin_review_status = 'open'");
    expect(evaluationBasis).toMatch(
      /jsonb_agg\([\s\S]*order by\s+source_row\.page_metadata_generated_at desc nulls last,\s+source_row\.id asc/,
    );
    expect(evaluationBasis).not.toMatch(/\blimit\b/i);
    expect(migration).toContain("'revision', public.stage1_publication_evidence_hash(evaluation_basis.value)");
    expect(migration).toContain("'source_count', pg_catalog.jsonb_array_length(");

    const awardLock = regressionWriter.indexOf(
      "from public.shared_awards award\n  where award.id = p_shared_award_id\n  for update;",
    );
    const sourceLock = regressionWriter.indexOf(
      "from public.shared_award_sources source_row",
    );
    const revisionRecompute = regressionWriter.indexOf(
      "v_current_revision := public.stage1_publication_evidence_hash(",
    );
    const staleRejection = regressionWriter.indexOf(
      "Regression evaluation became stale because the award or its complete source inputs changed",
    );
    const auditInsert = regressionWriter.indexOf(
      "insert into public.shared_award_page_audits",
    );
    expect(sourceLock).toBeGreaterThan(awardLock);
    expect(regressionWriter.slice(sourceLock, revisionRecompute)).toContain("for share;");
    expect(revisionRecompute).toBeGreaterThan(sourceLock);
    expect(staleRejection).toBeGreaterThan(revisionRecompute);
    expect(auditInsert).toBeGreaterThan(staleRejection);
    expect(regressionWriter).toContain("v_expected_revision is distinct from v_current_revision");
    expect(regressionWriter).toContain("v_expected_source_count is distinct from v_current_source_count");
  });

  it("lets an accepted pass resolve only strictly older blocking evaluations", () => {
    expect(regressionWriter).toContain(
      "private.regression_audit_evaluated_at(\n        audit.public_page_snapshot,\n        audit.created_at\n      ) < v_evaluated_at",
    );
    expect(regressionWriter).toContain(
      "if v_latest_evaluated_at > v_evaluated_at then",
    );
    expect(regressionWriter).toContain(
      "v_evaluated_at > v_previous_state_evaluated_at",
    );
    for (const field of [
      "last_succeeded_at",
      "last_evaluated_at",
      "last_audit_error",
      "last_audit_id",
      "last_observation_key",
    ]) {
      expect(regressionWriter).toMatch(
        new RegExp(`${field} = case\\s+when v_state_advanced then excluded\\.${field}`),
      );
    }
    expect(regressionWriter).toContain("'latest_state_advanced', v_state_advanced");
    expect(regressionWriter).not.toMatch(
      /resolved_by = 'scheduled_regression_pass'[\s\S]*created_at\s*<\s*v_now/,
    );
  });

  it("preserves the Stage 1 blocker contract while rejecting inconsistent regression rows", () => {
    const sqlGateContract = [stage1RegistryMigration, stage1PromotionMigration];
    for (const source of sqlGateContract) {
      expect(source).toMatch(
        /audit\.audit_status in \('failed', 'needs_review'\)\s+or audit\.severity = 'critical'/,
      );
    }
    expect(readinessCore).toContain(
      'audit.audit_status === "failed" || audit.audit_status === "needs_review" || audit.severity === "critical"',
    );
    expect(migration).toContain(
      "v_status_blocks is distinct from v_severity_blocks",
    );
  });

  it("exposes the atomic writer only to the service role", () => {
    expect(migration).toMatch(
      /language plpgsql\s+security definer\s+set search_path = ''/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_shared_award_regression_audit\(uuid, jsonb, text\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_shared_award_regression_audit\(uuid, jsonb, text\)\s+to service_role;/,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.record_shared_award_regression_audit[\s\S]*to (?:anon|authenticated)/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.list_shared_awards_for_regression_audit\(integer, text\[\], boolean\)\s+to service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_shared_award_regression_audit_attempt_failure\(uuid, text\)\s+to service_role;/,
    );
    expect(migration).toContain(
      "revoke all on table public.shared_award_regression_audit_state from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "alter table public.shared_award_regression_audit_state enable row level security;",
    );
  });

  it("durably backs off operational poison rows without fabricating audit evidence", () => {
    expect(migration).toContain(
      "record_shared_award_regression_audit_attempt_failure",
    );
    expect(migration).toContain(
      "consecutive_failures = excluded.consecutive_failures",
    );
    expect(migration).toContain("next_retry_at = excluded.next_retry_at");
    expect(migration).toContain(
      "last_operational_error = excluded.last_operational_error",
    );
    expect(migration).toContain(
      "pg_catalog.make_interval(secs => v_delay_seconds)",
    );
    expect(migration).not.toContain("pg_catalog.least(");
    expect(migration).not.toContain("pg_catalog.greatest(");
    const failureRpc = migration.slice(
      migration.indexOf(
        "create or replace function public.record_shared_award_regression_audit_attempt_failure",
      ),
      migration.indexOf(
        "revoke all on function public.record_shared_award_regression_audit_attempt_failure",
      ),
    );
    expect(failureRpc).not.toContain(
      "insert into public.shared_award_page_audits",
    );
    expect(failureRpc).not.toContain("update public.shared_awards");
    const failureFence = failureRpc.indexOf(
      "pg_catalog.hashtextextended('stage1-national-25-release', 0)",
    );
    const failureAwardLock = failureRpc.indexOf(
      "from public.shared_awards award\n  where award.id = p_shared_award_id\n  for update;",
    );
    expect(failureFence).toBeGreaterThan(-1);
    expect(failureAwardLock).toBeGreaterThan(failureFence);
  });

  it("never lets the scheduled regression lane publish facts or hide persistence errors", () => {
    expect(runner).toContain(
      'supabase.rpc("record_shared_award_regression_audit"',
    );
    expect(runner).toContain("observation_only: true");
    expect(runner).toContain("applied_to_public: false");
    expect(runner).not.toContain("async function publishReconciledFacts");
    expect(runner).not.toContain("public_facts: reconciliation.selectedFacts");
    expect(runner).toContain(
      'supabase.rpc("list_shared_awards_for_regression_audit"',
    );
    expect(runner).toContain("requireRegressionEvaluation(award)");
    expect(runner).toContain("evaluation_revision: evaluation.revision");
    expect(runner).toContain("evaluation_source_count: evaluation.sourceCount");
    expect(runner).toContain("evaluated_at: evaluation.selectedAt");
    expect(runner).not.toContain('.from("shared_award_sources")');
    expect(runner).toContain("p_audit_outcome_error");
    expect(runner).toContain(
      "selected_evidence_bindings: buildSelectedEvidenceBindings(reconciliation)",
    );
    expect(runner).toContain("reconciliation_audit_signature");
    expect(runner).toContain("source_captured_at");
    expect(runner).toContain(
      "record_shared_award_regression_audit_attempt_failure",
    );
    expect(runner).toContain(
      'report.status = "succeeded_with_deferred_failures"',
    );
    expect(runner).toContain(
      "report.operational_failures_recorded === report.errors.length",
    );
    expect(runner).not.toContain("last_structure_scan_at");
    expect(runner).not.toContain("structure_scan_error");
    expect(runner).not.toContain("last_regression_audit_at");
    expect(runner).not.toContain("regression_audit_error");
    expect(runner).toContain(
      "--apply=true cannot be combined with --dry-run=true",
    );
    expect(runner).toContain("if (!outcomeCounted) report.failed += 1");
  });
});
