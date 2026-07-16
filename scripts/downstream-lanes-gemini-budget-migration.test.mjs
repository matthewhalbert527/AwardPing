import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716062211_downstream_lanes_and_gemini_budget_reservations.sql",
    import.meta.url,
  ),
  "utf8",
);

const functionSql = (name, nextMarker) =>
  migration.slice(
    migration.indexOf(`create or replace function public.${name}`),
    nextMarker ? migration.indexOf(nextMarker) : migration.length,
  );

const reserveSql = functionSql(
  "reserve_gemini_spend(",
  "create or replace function public.mark_gemini_spend_create_started(",
);
const markCreateStartedSql = functionSql(
  "mark_gemini_spend_create_started(",
  "create or replace function public.submit_gemini_spend_reservation(",
);
const submitSql = functionSql(
  "submit_gemini_spend_reservation(",
  "create or replace function public.settle_gemini_spend_reservation(",
);
const settleSql = functionSql(
  "settle_gemini_spend_reservation(",
  "create or replace function public.release_gemini_spend_reservation(",
);
const releaseSql = functionSql(
  "release_gemini_spend_reservation(",
  "create or replace function public.list_gemini_budget_status()",
);
const claimSql = functionSql(
  "claim_monitoring_downstream_lane(",
  "create or replace function public.heartbeat_monitoring_downstream_lane(",
);
const heartbeatSql = functionSql(
  "heartbeat_monitoring_downstream_lane(",
  "create or replace function public.complete_monitoring_downstream_lane(",
);
const completeSql = functionSql(
  "complete_monitoring_downstream_lane(",
  "create or replace function public.list_monitoring_downstream_lane_status()",
);
const laneStatusSql = functionSql(
  "list_monitoring_downstream_lane_status()",
);

describe("downstream lanes and Gemini budget migration", () => {
  it("fixes exactly two paid lanes at five dollars per UTC day", () => {
    expect(migration).toContain("create table public.gemini_paid_lanes (");
    expect(migration).toContain(
      "lane_key in ('new_page_review', 'changed_page_review')",
    );
    expect(migration).toContain("daily_cap_micro_usd = 5000000");
    expect(migration.match(/\('(?:new|changed)_page_review', 5000000\)/g)).toHaveLength(2);
    expect(migration).toContain("(v_now at time zone 'UTC')::date");
    expect(migration).toContain("((v_budget_date + 1)::timestamp at time zone 'UTC')");
  });

  it("serializes idempotent reservations against one authoritative day row", () => {
    expect(reserveSql).toContain(
      "pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(v_work_fingerprint, 714311681)",
    );
    expect(reserveSql).toContain(
      "pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(v_key, 714311682)",
    );
    expect(reserveSql).toContain("where reservation.reservation_key = v_key\n  for update;");
    expect(reserveSql).toContain(
      "where day.budget_date = v_budget_date\n    and day.lane_key = p_lane_key\n  for update;",
    );
    expect(reserveSql).toContain(
      "if p_estimated_micro_usd > v_remaining then",
    );
    expect(reserveSql).toContain("'reason', 'daily_lane_cap_exceeded'");
    expect(reserveSql).toContain(
      "raise exception 'reservation_key % was already used with a different payload'",
    );
    expect(reserveSql).toContain(
      "v_existing.attempt_token is distinct from p_attempt_token",
    );
    expect(reserveSql).toContain(
      "v_existing.work_fingerprint is distinct from v_work_fingerprint",
    );
    expect(migration).toContain("reservation_key text not null unique");
    expect(migration).toContain("attempt_token uuid not null");
    expect(migration).toContain("work_fingerprint text not null");
    expect(migration).toContain(
      "create unique index gemini_spend_reservations_one_active_work_idx\n  on public.gemini_spend_reservations (work_fingerprint)\n  where status in ('reserved', 'creating', 'submitted');",
    );
    expect(reserveSql).toContain(
      "where reservation.work_fingerprint = v_work_fingerprint\n    and reservation.status in ('reserved', 'creating', 'submitted')",
    );
    expect(reserveSql).toContain("'reason', 'active_work_reservation_exists'");
  });

  it("keeps submitted spend held, records truthful settlement, and permits explicit pre-submit release only", () => {
    expect(markCreateStartedSql).toContain(
      "v_reservation.attempt_token is distinct from p_attempt_token",
    );
    expect(markCreateStartedSql).toContain("'create_allowed', false");
    expect(markCreateStartedSql).toContain("'create_allowed', true");
    expect(markCreateStartedSql).toContain("status = 'creating'");
    expect(markCreateStartedSql).toContain("create_started_at = v_now");
    expect(markCreateStartedSql).toContain("'create_started'");
    expect(submitSql).toContain("status = 'submitted'");
    expect(submitSql).toContain(
      "v_reservation.attempt_token is distinct from p_attempt_token",
    );
    expect(submitSql).toContain("provider_batch_name = v_provider_batch_name");
    expect(submitSql).toContain("must record provider-create start before submission");
    expect(releaseSql).toContain("if v_reservation.status = 'submitted' then");
    expect(releaseSql).toContain(
      "requires settlement and cannot be released",
    );
    expect(releaseSql).not.toContain(
      "delete from public.gemini_spend_reservations",
    );
    expect(releaseSql).not.toMatch(/released_at\s*</i);
    expect(settleSql).toContain(
      "v_spent_after := v_day.spent_micro_usd + p_spent_micro_usd;",
    );
    expect(settleSql).toContain("'over_cap', v_spent_after > v_cap");
    expect(settleSql).toContain("if v_reservation.status in ('reserved', 'creating', 'submitted') then");
    expect(releaseSql).toContain("v_reservation.status = 'creating'");
    expect(releaseSql).toContain("provider_create_definitively_failed:");
    expect(settleSql).toContain(
      "A released reservation may later be corrected when provider evidence proves",
    );
    expect(migration).not.toMatch(/gemini_spend_reservations[\s\S]{0,1000}expires_at/);
  });

  it("provides an append-only evidence ledger and complete status rows", () => {
    expect(migration).toContain("create table public.gemini_spend_events (");
    expect(migration).toContain("before update or delete on public.gemini_spend_events");
    expect(migration).toContain("raise exception 'gemini_spend_events is append-only'");
    expect(migration).toContain(
      "grant select on table public.gemini_spend_events to service_role;",
    );
    expect(migration).not.toContain(
      "grant insert on table public.gemini_spend_events to service_role;",
    );
    expect(migration).toContain(
      "revoke all on sequence public.gemini_spend_events_id_seq\n  from public, anon, authenticated, service_role;",
    );
    for (const field of [
      "cap_micro_usd bigint",
      "reserved_micro_usd bigint",
      "spent_micro_usd bigint",
      "remaining_micro_usd bigint",
      "reset_at timestamptz",
      "source text",
    ]) {
      expect(migration, field).toContain(field);
    }
    expect(migration).toContain("from public.gemini_paid_lanes lane\n  cross join utc_clock");
  });

  it("seeds eight independent downstream lanes and keeps page audit no-cost", () => {
    const seeds = [
      ["new_page_review", "new_page_review"],
      ["changed_page_review", "changed_page_review"],
      ["feedback_promotion", null],
      ["suppression", null],
      ["reconciliation", null],
      ["page_audit", null],
      ["manual_quarantine", null],
      ["nightly_report", null],
    ];
    for (const [lane, paidLane] of seeds) {
      const paidValue = paidLane ? `'${paidLane}'` : "null";
      expect(migration, lane).toMatch(
        new RegExp(`\\('${lane}', '[^']+', ${paidValue.replaceAll("'", "\\'")}, true, interval`),
      );
    }
    expect(migration).toContain(
      "constraint monitoring_downstream_lanes_page_audit_no_cost_check check",
    );
    expect(migration).toContain("lane_key <> 'page_audit' or paid_lane_key is null");
    expect(migration).toContain("create table public.monitoring_downstream_lane_runs (");
    expect(migration).toContain("create table public.monitoring_downstream_lane_state (");
    expect(migration).toContain("lease_ttl interval not null");
    expect(migration).toContain("timeout interval not null");
    expect(migration).toContain("sla interval not null");
    expect(migration).toContain("retry_base interval not null");
    expect(migration).toContain("retry_max interval not null");
  });

  it("promotes persisted public-page quarantine rows to deterministic no-cost audit repair", () => {
    expect(migration).toContain(
      "v_definition := pg_catalog.pg_get_functiondef(v_function);",
    );
    expect(migration).toContain("pg_catalog.quote_literal('may_charge')");
    expect(migration).toContain("pg_catalog.quote_literal('none')");
    expect(migration).toContain(
      "The latest deterministic page audit reached its safe retry limit.",
    );
    expect(migration).toContain(
      "rerun the deterministic no-cost page audit.",
    );
    expect(migration).toContain("execute v_next;");
    expect(migration).toContain(
      "select public.sync_manual_quarantine_registry();",
    );
  });

  it("claims atomically, heartbeats only live tokens, and backs failures off independently", () => {
    expect(claimSql).toContain(
      "where state.lane_key = p_lane_key\n  for update;",
    );
    expect(claimSql).toContain("and status = 'running'");
    expect(claimSql).toContain("'expired_lease_entered_backoff'");
    expect(claimSql).toContain("v_lane.retry_base * pg_catalog.power(");
    expect(heartbeatSql).toContain("'stale_or_mismatched_claim'");
    expect(heartbeatSql).toContain("v_lease_expires_at := v_now + v_lane.lease_ttl;");
    expect(completeSql).toContain("if v_state.lease_expires_at <= v_now then");
    expect(completeSql).toContain("'failed_with_backoff'");
    expect(completeSql).toContain("consecutive_failures = 0");
    expect(migration).toContain(
      "create unique index monitoring_downstream_lane_runs_one_active_idx",
    );
  });

  it("reports oldest-item SLA only for retryable queues and cadence for refresh lanes", () => {
    expect(laneStatusSql).toContain("queue_depth bigint");
    expect(laneStatusSql).toContain("oldest_item_at timestamptz");
    expect(laneStatusSql).toContain("oldest_item_sla_seconds bigint");
    expect(laneStatusSql).toContain("timeout_seconds bigint");
    expect(laneStatusSql).toContain("extract(epoch from lane.timeout)::bigint as timeout_seconds");
    expect(laneStatusSql).toContain("from public.source_page_requests request");
    expect(laneStatusSql).toContain("'ai_review_submitted'");
    expect(laneStatusSql).toContain(
      "from public.shared_award_visual_review_candidates candidate",
    );
    expect(laneStatusSql).toContain("candidate.status in ('pending', 'submitted', 'processing', 'succeeded')");
    expect(laneStatusSql).toContain("'missing_batch_response'");
    expect(laneStatusSql).toContain("'failure_retry_count'");
    expect(laneStatusSql).toContain(
      "from public.monitoring_feedback_promotion_clusters cluster\n    where cluster.resolved_at is null",
    );
    expect(laneStatusSql).toContain("min(cluster.updated_at) as oldest_item_at");
    for (const stage of [
      "rule_drafted",
      "historical_shadow_test",
      "regression_tests_pass",
      "app_worker_hashes_match",
      "six_pm_canary",
      "retroactive_sweep",
    ]) {
      expect(laneStatusSql, stage).toContain(`'${stage}'`);
    }
    expect(laneStatusSql).not.toContain("'triaged'");
    expect(laneStatusSql).toContain(
      "cluster.current_stage <> 'retroactive_sweep'",
    );
    expect(laneStatusSql).toContain(
      "cluster.activation_status in (\n          'blocked_late_evidence',\n          'rollback_required',\n          'sweep_completed'",
    );
    expect(laneStatusSql).toContain(
      "from public.shared_award_reconciliation_queue queue\n    where queue.status in ('pending', 'processing')",
    );
    expect(laneStatusSql).toContain(
      "select 'page_audit'::text, 0::bigint, null::timestamptz",
    );
    expect(laneStatusSql).toContain(
      "select 'manual_quarantine'::text, 0::bigint, null::timestamptz",
    );
    expect(laneStatusSql).not.toContain("latest_page_audits as (");
    expect(laneStatusSql).not.toContain("quarantine_queue as (");
    expect(laneStatusSql).toContain(
      "select 'suppression'::text, 0::bigint, null::timestamptz",
    );
    expect(laneStatusSql).toContain(
      "select 'nightly_report'::text, 0::bigint, null::timestamptz",
    );
    expect(laneStatusSql).toContain(
      "backlog.oldest_item_at + lane.sla",
    );
    expect(laneStatusSql).toContain(
      "coalesce(backlog.oldest_item_at + lane.sla <= lane_clock.now_at, false)",
    );
  });

  it("makes every exposed RPC SECURITY DEFINER, search-path hardened, and service-role-only", () => {
    const signatures = [
      "reserve_gemini_spend(text, text, uuid, text, bigint, text, uuid, integer, text, jsonb)",
      "mark_gemini_spend_create_started(uuid, uuid, jsonb)",
      "submit_gemini_spend_reservation(uuid, uuid, text)",
      "settle_gemini_spend_reservation(uuid, bigint, jsonb, text)",
      "release_gemini_spend_reservation(uuid, text)",
      "list_gemini_budget_status()",
      "claim_monitoring_downstream_lane(text, text, uuid, jsonb)",
      "heartbeat_monitoring_downstream_lane(text, uuid, uuid, jsonb)",
      "complete_monitoring_downstream_lane(text, uuid, uuid, boolean, jsonb, text)",
      "list_monitoring_downstream_lane_status()",
    ];
    for (const signature of signatures) {
      const name = signature.slice(0, signature.indexOf("("));
      const body = functionSql(`${name}(`, `revoke all on function public.${signature}`);
      expect(body, signature).toContain("security definer\nset search_path = ''");
      expect(migration, signature).toContain(
        `revoke all on function public.${signature}\n  from public, anon, authenticated, service_role;`,
      );
      expect(migration, signature).toContain(
        `grant execute on function public.${signature}\n  to service_role;`,
      );
    }
  });

  it("keeps every ledger and scheduler table service-role-readable but RPC-write-only", () => {
    for (const table of [
      "gemini_paid_lanes",
      "gemini_spend_days",
      "gemini_spend_reservations",
      "gemini_spend_events",
      "monitoring_downstream_lanes",
      "monitoring_downstream_lane_runs",
      "monitoring_downstream_lane_state",
    ]) {
      expect(migration, table).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(migration, table).toContain(
        `revoke all on table public.${table}\n  from public, anon, authenticated, service_role;`,
      );
      expect(migration, table).toContain(
        `grant select on table public.${table} to service_role;`,
      );
      expect(migration, table).not.toContain(
        `grant all on table public.${table} to service_role;`,
      );
    }
  });
});
