import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const laneMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260716062211_downstream_lanes_and_gemini_budget_reservations.sql",
    import.meta.url,
  ),
  "utf8",
);
const releaseMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260716224000_stage1_release_acceptance.sql",
    import.meta.url,
  ),
  "utf8",
);
const contactFenceMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260717123000_legacy_contact_ciphertext_quarantine.sql",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814191514_fix_stage1_lane_gate_cadence_sla.sql",
    import.meta.url,
  ),
  "utf8",
);

const queueLanes = [
  "new_page_review",
  "changed_page_review",
  "feedback_promotion",
  "reconciliation",
];
const cadenceLanes = [
  "suppression",
  "page_audit",
  "manual_quarantine",
  "nightly_report",
];

describe("Stage 1 cadence-lane release-gate migration", () => {
  it("repairs the real cross-contract mismatch without changing the status API", () => {
    expect(releaseMigration).toContain(
      "and lane.oldest_item_sla_seconds > 0",
    );
    expect(laneMigration).toContain(
      "then extract(epoch from lane.sla)::bigint\n      else null::bigint\n    end as oldest_item_sla_seconds",
    );
    expect(laneMigration).toContain(
      "else coalesce(state.last_succeeded_at, state.created_at) + lane.sla",
    );
    expect(laneMigration).toContain("end as next_sla_due_at");
    expect(laneMigration).toContain(
      "else coalesce(state.last_succeeded_at, state.created_at) + lane.sla <= lane_clock.now_at",
    );
    expect(laneMigration).toContain("end as sla_breached");

    for (const lane of [...queueLanes, ...cadenceLanes]) {
      expect(laneMigration).toContain(`'${lane}'`);
      expect(migration).toContain(`'${lane}'`);
    }
  });

  it("uses one private pure helper with distinct queue and cadence contracts", () => {
    expect(migration).toContain(
      "create or replace function private.stage1_downstream_lane_sla_contract_valid(",
    );
    for (const contract of [
      "p_sla_seconds > 0",
      "p_oldest_item_sla_seconds = p_sla_seconds",
      "p_oldest_item_sla_seconds is null",
      "p_queue_depth = 0",
      "p_oldest_item_at is null",
      "p_next_sla_due_at is not null",
      "else false",
      "coalesce(",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toMatch(
      /language sql\s+immutable\s+parallel safe\s+security invoker\s+set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_downstream_lane_sla_contract_valid\([\s\S]*?\) from public, anon, authenticated, service_role;/i,
    );
  });

  it("patches the active inherited gate exactly once and fails closed on drift", () => {
    expect(contactFenceMigration).toContain(
      "rename to stage1_gate_without_contact_fence_20260717123000",
    );
    expect(contactFenceMigration).toContain(
      "private.stage1_gate_without_contact_fence_20260717123000(",
    );
    for (const contract of [
      "private.stage1_gate_without_contact_fence_20260717123000(timestamp with time zone)",
      "private.stage1_release_gate_snapshot(timestamp with time zone)",
      "v_old_predicate constant text := 'lane.oldest_item_sla_seconds > 0'",
      "v_old_count <> 1",
      "v_new_count <> 0",
      "v_wrapper_anchor_count <> 1",
      "pg_catalog.replace(\n    v_definition,\n    v_old_predicate,\n    v_new_predicate",
      "Stage 1 cadence-lane repair did not match the exact active gate chain.",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).not.toContain(
      "create or replace function private.stage1_release_gate_snapshot(",
    );
  });

  it("retains all independent eight-lane health and charge guards", () => {
    for (const guard of [
      "lane.enabled",
      "not lane.lease_expired",
      "not lane.sla_breached",
      "lane.timeout_seconds > 0",
      "lane.lease_ttl_seconds > lane.timeout_seconds",
      "lane.source = 'postgres_lane_scheduler_v1'",
      "lane.creates_api_charge",
      "lane.paid_lane_key = lane.lane_key",
      "not lane.creates_api_charge",
      "lane.paid_lane_key is null",
      "v_lane_count = 8 and v_lane_valid_count = 8",
    ]) {
      expect(releaseMigration).toContain(guard);
    }
    expect(migration).toContain(
      "Existing enabled/lease/SLA-breach/timeout/source\n-- and paid-lane predicates remain byte-for-byte unchanged.",
    );
    expect(migration.match(/execute v_updated_definition;/g)).toHaveLength(1);
  });

  it("preserves the inner gate identity, ownership, ACL, and execution boundary", () => {
    for (const contract of [
      "procedure.proowner = v_owner",
      "procedure.proacl is not distinct from v_acl",
      "procedure.prosecdef = v_security_definer",
      "procedure.provolatile = v_volatility",
      "procedure.proparallel = v_parallel",
      "procedure.proleakproof = v_leakproof",
      "procedure.proconfig is not distinct from v_proconfig",
      "v_volatility <> 'v'",
      "'search_path=\"\"' = any(v_proconfig)",
      "'anon', v_gate_oid, 'EXECUTE'",
      "'authenticated', v_gate_oid, 'EXECUTE'",
      "'service_role', v_gate_oid, 'EXECUTE'",
    ]) {
      expect(migration).toContain(contract);
    }
  });

  it("executes an eight-positive and fail-closed negative migration smoke", () => {
    expect(migration).toContain("if v_valid_count <> 8 then");
    expect(migration).toContain(
      "did not accept exactly eight healthy metric shapes",
    );
    expect(migration).toContain("'suppression', 0, null, 0, null, v_now");
    expect(migration).toContain("'suppression', 3600, 3600, 0, null, v_now");
    expect(migration).toContain("'suppression', 3600, null, 1, null, v_now");
    expect(migration).toContain("'suppression', 3600, null, 0, v_now, v_now");
    expect(migration).toContain("'suppression', 3600, null, 0, null, null");
    expect(migration).toContain("'reconciliation', 3600, null, 1, v_now, v_now");
    expect(migration).toContain("'reconciliation', 3600, 1800, 1, v_now, v_now");
    expect(migration).toContain("'unreviewed_lane', 3600, 3600, 0, null, null");
    expect(migration).toContain("accepted an invalid metric shape");
  });

  it("is a forward-only catalog repair with no data or migration-history writes", () => {
    expect(migration).not.toMatch(
      /\b(?:insert|update|delete|truncate)\b|\b(?:create|alter|drop)\s+table\b|supabase_migrations/iu,
    );
    expect(migration).not.toMatch(/^\s*(?:begin|commit|rollback)\s*;/imu);
  });
});
