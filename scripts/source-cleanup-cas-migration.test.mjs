import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717121500_source_cleanup_compare_and_swap.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("award-scoped source cleanup CAS migration", () => {
  it("fences the existing Action Inbox overload before its source lock", () => {
    const wrapperStart = migration.indexOf(
      "create or replace function public.retire_shared_award_source_preserving_visual_history(\n  p_source_id uuid,",
    );
    const bulkStart = migration.indexOf(
      "create or replace function public.apply_shared_award_source_cleanup_plan(",
    );
    const wrapper = migration.slice(wrapperStart, bulkStart);
    const nationalLock = wrapper.indexOf("stage1-national-25-release");
    const legacyCall = wrapper.indexOf(
      "private.retire_shared_award_source_unfenced_20260715143000(",
    );

    expect(wrapperStart).toBeGreaterThan(0);
    expect(nationalLock).toBeGreaterThan(0);
    expect(legacyCall).toBeGreaterThan(nationalLock);
    expect(wrapper).toContain(") to service_role;");
  });

  it("locks national, award, complete source set, and events in order", () => {
    const bulk = migration.slice(
      migration.indexOf(
        "create or replace function public.apply_shared_award_source_cleanup_plan(",
      ),
    );
    const nationalLock = bulk.indexOf("stage1-national-25-release");
    const awardLock = bulk.indexOf("select award.* into strict v_award");
    const sourceLocks = bulk.indexOf("perform source_row.id");
    const eventLocks = bulk.indexOf("perform event.id");

    expect(nationalLock).toBeGreaterThan(0);
    expect(awardLock).toBeGreaterThan(nationalLock);
    expect(sourceLocks).toBeGreaterThan(awardLock);
    expect(eventLocks).toBeGreaterThan(sourceLocks);
    expect(bulk.slice(awardLock, sourceLocks)).toContain("for update;");
    expect(bulk.slice(sourceLocks, eventLocks)).toContain("order by source_row.id");
    expect(bulk.slice(sourceLocks, eventLocks)).toContain("for update;");
  });

  it("compares the complete observed award and sibling-source snapshot", () => {
    expect(migration).toContain("v_current_source_states is distinct from v_expected_source_states");
    expect(migration).toContain("Award source set changed after cleanup planning; requeue cleanup.");
    for (const field of [
      "shared_award_id",
      "url",
      "title",
      "page_type",
      "confidence",
      "source",
      "last_error",
      "admin_review_status",
      "updated_at",
    ]) {
      expect(migration).toContain(`'${field}'`);
    }
    expect(migration).toContain("v_award.updated_at is distinct from v_expected_award_updated_at");
    expect(migration).toContain("v_award.official_homepage is distinct from v_expected_award_homepage");
  });

  it("verifies useful remaining sources and homepage replacement before mutation", () => {
    expect(migration).toContain("planned_useful_remaining_source_ids");
    expect(migration).toContain("<@ v_expected_remaining_open_source_ids");
    expect(migration).toContain("v_homepage_replacement_source_id");
    expect(migration).toContain("source_row.url = v_homepage_new");
    expect(migration).toContain(
      "homepage replacement is not a planned useful remaining source",
    );
  });

  it("requires exact bulk retirement and homepage row counts so errors roll back all work", () => {
    expect(migration).toContain("suppression_source = 'source_retirement'");
    expect(migration).toContain("admin_review_status = 'review_later'");
    expect(migration).toContain(
      "v_source_update_count <> pg_catalog.cardinality(v_retire_source_ids)",
    );
    expect(migration).toContain("v_award_update_count <> 1");
    expect(migration).toContain("errcode = '40001'");
    expect(migration).not.toMatch(/delete\s+from/i);
  });

  it("exposes only the fenced public functions to service role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("set statement_timeout = '60s'");
    expect(migration).toContain(
      "revoke all on function private.retire_shared_award_source_unfenced_20260715143000(",
    );
    expect(migration).toContain(
      "grant execute on function public.apply_shared_award_source_cleanup_plan(",
    );
    expect(migration).toContain(") to service_role;");
  });
});
