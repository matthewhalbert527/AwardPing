import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716040000_manual_quarantine_registry.sql",
    import.meta.url,
  ),
  "utf8",
);

const syncFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.sync_manual_quarantine_registry()",
  ),
  migration.indexOf(
    "revoke all on function public.sync_manual_quarantine_registry()",
  ),
);
const historicalFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.replace_manual_quarantine_historical_limitations(",
  ),
  migration.indexOf(
    "revoke all on function public.replace_manual_quarantine_historical_limitations(",
  ),
);
const refreshFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.refresh_manual_quarantine_registry_state(",
  ),
  migration.indexOf(
    "revoke all on function public.refresh_manual_quarantine_registry_state(",
  ),
);

describe("manual quarantine registry migration", () => {
  it("creates a durable, service-only registry with append-only event access", () => {
    for (const table of [
      "manual_quarantine_registry",
      "manual_quarantine_registry_state",
    ]) {
      expect(migration).toContain(`create table if not exists public.${table} (`);
      expect(migration).toContain(`alter table public.${table} enable row level security;`);
      expect(migration).toContain(
        `revoke all on table public.${table} from public, anon, authenticated;`,
      );
    }

    expect(migration).toContain(
      "revoke all on table public.manual_quarantine_registry_events from public, anon, authenticated, service_role;",
    );

    expect(migration).toContain(
      "grant select, insert on table public.manual_quarantine_registry_events to service_role;",
    );
    expect(migration).not.toContain(
      "grant all on table public.manual_quarantine_registry_events to service_role;",
    );
    expect(migration).toContain("'case_refreshed'");
    expect(migration).toContain("old.policy_version");
    expect(migration).toContain("new.retry_charge");
    expect(migration).toContain(
      "manual_quarantine_registry_visual_candidate_idx",
    );
    expect(migration).toContain("to_jsonb(new)");
    expect(migration).toContain(
      "revoke all on sequence public.manual_quarantine_registry_events_id_seq\n  from public, anon, authenticated, service_role;",
    );
    expect(refreshFunction).toContain("with open_registry as materialized (");
    expect(migration).toContain(
      "revoke all on function public.refresh_manual_quarantine_registry_state(timestamptz)\n  from public, anon, authenticated, service_role;",
    );
    expect(migration).not.toContain(
      "grant execute on function public.refresh_manual_quarantine_registry_state(timestamptz)",
    );
  });

  it("reports the four completion categories without the retired scalar", () => {
    for (const field of [
      "automated_work_clear boolean",
      "quarantined_work_remaining bigint",
      "historical_limitations bigint",
      "terminal_failures_requiring_action bigint",
    ]) {
      expect(migration, field).toContain(field);
    }

    expect(migration).toContain(
      "historical_inventory_status text not null default 'not_imported'",
    );
    expect(refreshFunction).toContain("historical_limitations = case");
    expect(refreshFunction).toContain(
      "when public.manual_quarantine_registry_state.historical_inventory_status = 'complete'",
    );
    expect(migration).not.toContain("safe_manual_review_items");
  });

  it("groups the latest actionable audit and latest failed reconciliation into one award case", () => {
    expect(syncFunction.match(/select distinct on \((?:audit|queue)\.shared_award_id\)/g)).toHaveLength(2);
    expect(syncFunction).toContain(
      "order by audit.shared_award_id, audit.created_at desc, audit.id desc",
    );
    expect(syncFunction).toContain(
      "order by queue.shared_award_id, queue.created_at desc, queue.id desc",
    );
    expect(syncFunction).toContain(
      "'public-page:' || candidate.shared_award_id::text as quarantine_key",
    );
    expect(syncFunction).toContain(
      "where candidate.audit_requires_action\n       or candidate.reconciliation_requires_action",
    );
    expect(syncFunction).toContain(
      "case when page.audit_requires_action then 1 else 0 end\n        + case when page.reconciliation_requires_action then 1 else 0 end",
    );
    expect(syncFunction).toContain(
      "when page.audit_requires_action then 'shared_award_page_audits'\n        else 'shared_award_reconciliation_queue'",
    );
    expect(syncFunction).toContain(
      "reconciliation.status = 'failed'",
    );
  });

  it("keeps a reconciliation-only failure open until both latest states are safe", () => {
    const resolutionSql = syncFunction.slice(
      syncFunction.indexOf("with public_resolution_cases as ("),
      syncFunction.indexOf("with visual_resolution_cases as ("),
    );

    expect(resolutionSql).toContain("left join lateral (");
    expect(resolutionSql).toContain("from public.shared_award_page_audits audit");
    expect(resolutionSql).toContain("from public.shared_award_reconciliation_queue queue");
    expect(resolutionSql).toContain(
      "reconciliation.id is not null\n            and reconciliation.status = 'failed'",
    );
    expect(resolutionSql).toContain(
      "Newer safe page-audit and reconciliation states superseded this quarantine.",
    );
    expect(resolutionSql).toContain("'award_inactive'");
    expect(resolutionSql).toContain(
      "evidence_hash = public.manual_quarantine_evidence_hash",
    );
  });

  it("derives exhausted page-audit failures from the same two-attempt worker contract", () => {
    expect(syncFunction).toContain("page_audit_batch_request_state as (");
    expect(syncFunction).toContain(
      "attempt.ai_result ->> 'error' in ('invalid_json', 'missing_batch_response')",
    );
    expect(syncFunction).toContain("as active_attempt_count");
    expect(syncFunction).toContain("as retryable_failure_count");
    expect(syncFunction).toContain("as successful_attempt_count");
    expect(syncFunction).toContain(
      "coalesce(batch_state.retryable_failure_count, 0) >= 2",
    );
    expect(syncFunction).toContain(
      "coalesce(batch_state.active_attempt_count, 0) = 0",
    );
    expect(syncFunction).toContain(
      "coalesce(batch_state.successful_attempt_count, 0) = 0 as audit_terminal",
    );
    expect(syncFunction).toContain(
      "candidate.reconciliation_requires_action or candidate.audit_terminal as terminal",
    );
  });

  it("counts terminal failure evidence separately from grouped terminal cases", () => {
    expect(migration).toContain(
      "terminal_failure_count integer not null default 0 check (terminal_failure_count >= 0)",
    );
    expect(migration).toContain("(terminal and terminal_failure_count > 0)");
    expect(migration).toContain("(not terminal and terminal_failure_count = 0)");
    expect(migration).toContain(
      "category = 'public_page' and terminal_failure_count between 0 and 2",
    );
    expect(migration).toContain(
      "category = 'visual_review' and terminal_failure_count = 1",
    );
    expect(migration).toContain(
      "category = 'historical_localization' and terminal_failure_count = 0",
    );
    expect(syncFunction).toContain(
      "case when page.reconciliation_requires_action then 1 else 0 end\n        + case when page.audit_terminal then 1 else 0 end",
    );
    expect(refreshFunction).toContain(
      "coalesce(sum(terminal_failure_count) filter (",
    );
    expect(refreshFunction).toContain(
      "'terminal_cases', count(*) filter (where terminal)",
    );
    expect(refreshFunction).toContain(
      "'terminal_failures', coalesce(sum(terminal_failure_count), 0)",
    );

    const groupedPublicPage = {
      cases: 1,
      evidenceRecords: 2,
      terminalCases: Number(true || true),
      terminalFailures: Number(true) + Number(true),
    };
    expect(groupedPublicPage).toEqual({
      cases: 1,
      evidenceRecords: 2,
      terminalCases: 1,
      terminalFailures: 2,
    });
  });

  it("uses the worker's exact terminal visual-review boundary", () => {
    expect(syncFunction.match(/candidate\.status = 'failed'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(syncFunction.match(/= 'missing_batch_response'\n\s+then false/g)?.length).toBeGreaterThanOrEqual(2);
    expect(
      syncFunction.match(
        /=\n\s+'manual_recovery_required_possible_external_batch_created'\n\s+then true/g,
      )?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(syncFunction.match(/'failure_retry_count'[\s\S]{0,180}>= 3 then true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(syncFunction).toContain("terminal_failure_count = 1");
    for (const field of [
      "'gemini_batch_request_key', visual.gemini_batch_request_key",
      "'submitted_at', visual.submitted_at",
      "'completed_at', visual.completed_at",
      "'ai_result', visual.ai_result",
      "'actual_usage', visual.actual_usage",
      "'publication_claim_token', visual.publication_claim_token",
    ]) {
      expect(syncFunction).toContain(field);
    }
    expect(syncFunction).toContain("'attempts', candidate.audit_batch_attempts");
    expect(syncFunction).toContain("'id', attempt.id");
  });

  it("imports historical limitations only from an explicit, artifact-bound inventory", () => {
    expect(historicalFunction).toContain("if p_source_ids is null then");
    expect(historicalFunction).toContain(
      "pass an explicit empty UUID array for a verified empty inventory",
    );
    expect(historicalFunction).toContain("array_position(p_source_ids, null)");
    expect(historicalFunction).toContain("select distinct requested.source_id");
    expect(historicalFunction).toContain("select distinct item.source_id");
    expect(historicalFunction).toContain(
      "where snapshot.shared_award_source_id = any(p_source_ids)\n  for share;",
    );
    expect(historicalFunction).toContain(
      "snapshot.previous_object_keys <> '{}'::jsonb",
    );
    expect(historicalFunction).toContain(
      "snapshot.previous_hashes <> '{}'::jsonb",
    );
    expect(historicalFunction).toContain(
      "snapshot.previous_captured_at is not null",
    );
    expect(historicalFunction).toContain(
      "'previous_object_keys', snapshot.previous_object_keys",
    );
    expect(historicalFunction).toContain(
      "'previous_hashes', snapshot.previous_hashes",
    );
    expect(historicalFunction).toContain(
      "historical_inventory_status = 'complete'",
    );
    expect(historicalFunction).toContain(
      "from unnest(p_source_ids) requested(source_id)\n      where requested.source_id = registry.shared_award_source_id",
    );
    expect(historicalFunction).toContain("p_reported_at < v_existing_reported_at");
    expect(historicalFunction).toContain("p_report_digest is distinct from v_existing_digest");
    expect(historicalFunction).toContain(
      "p_reported_at > v_now + interval '5 minutes'",
    );
    expect(historicalFunction).toContain("snapshot.updated_at <= p_reported_at");
    expect(historicalFunction).toContain("snapshot.previous_captured_at <= p_reported_at");
    expect(historicalFunction).toContain("'inventory_report_digest', p_report_digest");
    expect(historicalFunction).toContain("return v_result;");
  });

  it("rejects completion reports that would overwrite newer state", () => {
    expect(migration).toContain("p_reported_at < v_state.completion_reported_at");
    expect(migration).toContain(
      "v_state.automated_work_clear is distinct from p_automated_work_clear",
    );
    expect(migration).toContain(
      "v_state.source_worker_run_id is distinct from p_source_worker_run_id",
    );
    expect(migration).toContain(
      "p_reported_at > clock_timestamp() + interval '5 minutes'",
    );
  });

  it("refreshes policy identity and keeps self-contained resolution evidence", () => {
    expect(syncFunction.match(/policy_id = 'awardping-manual-quarantine'/g)).toHaveLength(2);
    expect(historicalFunction).toContain("policy_id = 'awardping-manual-quarantine'");
    expect(syncFunction).toContain("with public_resolution_cases as (");
    expect(syncFunction).toContain("with visual_resolution_cases as (");
    expect(syncFunction.match(/'resolution'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(historicalFunction).toContain("'not_in_newer_complete_inventory'");
  });

  it("hashes every evidence snapshot with an available pgcrypto schema and consumes data-modifying CTEs", () => {
    expect(migration).toContain(
      "pg_catalog.to_regprocedure('extensions.digest(bytea,text)')",
    );
    expect(migration).toContain(
      "pg_catalog.to_regprocedure('public.digest(bytea,text)')",
    );
    expect(migration).toContain(
      "manual_quarantine_evidence_hash(page.evidence)",
    );
    expect(migration).toContain(
      "manual_quarantine_evidence_hash(visual.evidence)",
    );
    expect(migration).toContain(
      "manual_quarantine_evidence_hash(historical.evidence)",
    );
    expect(migration).not.toMatch(/select count\(\*\) from upserted/);
    expect(migration.match(/select count\(\*\) into v_write_count/g)).toHaveLength(3);
  });
});
