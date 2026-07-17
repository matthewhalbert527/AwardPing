import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717011309_atomic_office_award_tracking.sql",
    import.meta.url,
  ),
  "utf8",
);
const hardeningMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260717022006_harden_office_tracking_ownership.sql",
    import.meta.url,
  ),
  "utf8",
);
const trackingService = readFileSync(
  new URL("../src/lib/shared-awards.ts", import.meta.url),
  "utf8",
);

const consolidationFunction = functionBody(
  hardeningMigration,
  "private.consolidate_office_award_tracking",
  "revoke all on function private.consolidate_office_award_tracking",
);
const trackFunction = functionBody(
  migration,
  "public.track_office_shared_award_atomic",
  "revoke all on function public.track_office_shared_award_atomic",
);
const untrackAwardFunction = functionBody(
  migration,
  "public.untrack_office_shared_award_atomic",
  "revoke all on function public.untrack_office_shared_award_atomic",
);
const untrackSourceFunction = functionBody(
  migration,
  "public.untrack_office_shared_award_source_atomic",
  "revoke all on function public.untrack_office_shared_award_source_atomic",
);

describe("atomic office award tracking migration", () => {
  it("normalizes URL slices with callable pg_catalog functions", () => {
    expect(migration).not.toContain("pg_catalog.substring(");
    expect((migration.match(/pg_catalog\.substr\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("authenticates and authorizes the exact office mutation at the database", () => {
    for (const body of [trackFunction, untrackAwardFunction, untrackSourceFunction]) {
      expect(body).toContain("v_actor_user_id uuid := (select auth.uid())");
      expect(body).toContain("member.office_id = p_office_id");
      expect(body).toContain("member.user_id = v_actor_user_id");
      expect(body).toContain("member.status = 'active'");
      expect(body).toContain("member.role in ('owner', 'admin')");
      expect(body).toContain("for share");
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
    }

    expect(migration).toMatch(
      /revoke all on function public\.track_office_shared_award_atomic\([\s\S]*?from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.track_office_shared_award_atomic\([\s\S]*?to authenticated;/,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.(?:track|untrack)_office_shared_award[\s\S]*?to (?:anon|service_role|public);/,
    );
  });

  it("serializes mutations and rejects stale release, member, and source inputs", () => {
    expect(trackFunction).toContain("pg_advisory_xact_lock_shared");
    expect(trackFunction).toContain("stage1-national-25-release");
    expect(trackFunction).toContain("pg_advisory_xact_lock(");
    expect(trackFunction).toContain("office-award-tracking:");
    expect(trackFunction).toContain(
      "v_registry.release_epoch is distinct from p_expected_release_epoch",
    );
    expect(trackFunction).toContain(
      "v_expected_member_ids is distinct from v_current_member_ids",
    );
    expect(trackFunction).toContain(
      "v_database_source_bindings is distinct from p_expected_source_bindings",
    );
    expect(trackFunction).toContain(
      "pg_catalog.cardinality(v_selected_source_ids)",
    );
    expect(trackFunction).toContain(
      "count(distinct private.office_tracking_source_url_key(source.url))",
    );
    expect(trackFunction).toContain(
      "public.stage1_award_source_identity_rules identity_rule",
    );
    expect(trackFunction).toContain(
      "Selected source is excluded by the reviewed identity policy.",
    );
    expect(trackFunction).toContain("for update;");
    expect(trackFunction).toContain("for share;");
    expect(trackFunction).toContain("errcode = '40001'");

    for (const body of [untrackAwardFunction, untrackSourceFunction]) {
      expect(body).toContain("p_validate_release_epoch");
      expect(body).toContain(
        "v_expected_member_ids is distinct from v_current_member_ids",
      );
      expect(body).toContain("office-award-tracking:");
      expect(body).toContain("for update;");
    }
  });

  it("preserves every dependent and historical record during consolidation", () => {
    expect(consolidationFunction).toContain("update public.monitor_snapshots");
    expect(consolidationFunction).toContain("update public.change_events");
    expect(consolidationFunction).not.toContain(
      "update public.shared_award_change_events",
    );
    expect(consolidationFunction).toContain("set award_id = null");
    expect(consolidationFunction).toContain("status = 'paused'");
    expect(consolidationFunction).toContain("update public.award_notes");
    expect(consolidationFunction).toContain("update public.award_tasks");
    expect(consolidationFunction).toContain("update public.award_sources");
    expect(consolidationFunction).toContain("update public.monitors");
    expect(consolidationFunction.indexOf("update public.monitor_snapshots"))
      .toBeLessThan(consolidationFunction.indexOf("delete from public.monitors"));
    expect(consolidationFunction.indexOf("update public.change_events"))
      .toBeLessThan(consolidationFunction.indexOf("delete from public.monitors"));
    expect(consolidationFunction.indexOf("update public.award_notes"))
      .toBeLessThan(consolidationFunction.indexOf("delete from public.awards"));
    expect(consolidationFunction.indexOf("update public.award_tasks"))
      .toBeLessThan(consolidationFunction.indexOf("delete from public.awards"));
    expect(consolidationFunction).toContain("award.priority = 'high'");
    expect(consolidationFunction).toContain("pg_catalog.max(award.last_reviewed_at)");
  });

  it("untracks reversibly instead of deleting evidence or workspace history", () => {
    expect(untrackAwardFunction).toContain("set status = 'paused'");
    expect(untrackAwardFunction).toContain("set selected = false");
    expect(untrackAwardFunction).toContain("status = 'archived'");
    expect(untrackAwardFunction).not.toContain("delete from public.monitors");
    expect(untrackAwardFunction).not.toContain("delete from public.awards");
    expect(untrackAwardFunction).not.toContain("delete from public.award_sources");

    expect(untrackSourceFunction).toContain("set status = 'paused'");
    expect(untrackSourceFunction).toContain("set selected = false");
    expect(untrackSourceFunction).not.toContain("delete from public.monitors");
    expect(untrackSourceFunction).not.toContain("delete from public.awards");
    expect(untrackSourceFunction).not.toContain("delete from public.award_sources");
  });

  it("routes all three mutations through the atomic RPC contract", () => {
    expect(trackingService).toContain(
      'input.supabase.rpc(\n    "track_office_shared_award_atomic"',
    );
    expect(trackingService).toContain(
      'input.supabase.rpc(\n    "untrack_office_shared_award_atomic"',
    );
    expect(trackingService).toContain(
      'input.supabase.rpc(\n    "untrack_office_shared_award_source_atomic"',
    );
    expect(trackingService).toContain(
      "p_expected_source_bindings: expectedSourceBindings",
    );
    expect(trackingService).toContain(
      "p_expected_member_shared_award_ids: input.expectedMemberSharedAwardIds",
    );
  });
});

function functionBody(source, startName, endMarker) {
  const start = source.indexOf(`create or replace function ${startName}(`);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
