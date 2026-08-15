import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814203233_get_stage1_source_activation_finalizations.sql",
    import.meta.url,
  ),
  "utf8",
);
const smoke = readFileSync(
  new URL(
    "../supabase/tests/stage1_source_activation_finalizations_getter_smoke.sql",
    import.meta.url,
  ),
  "utf8",
);

const functionStart = migration.indexOf(
  "create or replace function public.get_stage1_source_activation_finalizations(",
);
const functionEnd = migration.indexOf(
  "alter function public.get_stage1_source_activation_finalizations(uuid[])",
  functionStart,
);
const getter = migration.slice(functionStart, functionEnd);

const exactReturnContract = `returns table (
  source_acquisition_id uuid,
  shared_award_source_id uuid,
  source_page_request_id uuid,
  disposition_item_sha256 text,
  prepare_receipt_sha256 text,
  guard_sha256 text,
  observed_normalized_text_sha256 text,
  persistence_evidence jsonb,
  finalization_receipt_sha256 text,
  receipt jsonb,
  finalized_at timestamptz
)`;

describe("Stage 1 source-activation finalization getter migration", () => {
  it("is exact parseable PostgreSQL with no application-data mutation", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(migration.match(/create or replace function/gi)).toHaveLength(1);
    expect(migration).not.toMatch(
      /^\s*(?:insert|update|delete|truncate)\b|^\s*(?:create|alter|drop)\s+table\b/imu,
    );
    expect(smoke).not.toMatch(
      /^\s*(?:insert|update|delete|truncate)\b|^\s*(?:create|alter|drop)\s+table\b/imu,
    );
  });

  it("returns only the eleven immutable finalization fields in exact order", () => {
    expect(getter).toContain(exactReturnContract);
    expect(getter).toContain(
      "join private.stage1_source_baseline_activation_finalizations finalized",
    );
    for (const column of [
      "source_acquisition_id",
      "shared_award_source_id",
      "source_page_request_id",
      "disposition_item_sha256",
      "prepare_receipt_sha256",
      "guard_sha256",
      "observed_normalized_text_sha256",
      "persistence_evidence",
      "finalization_receipt_sha256",
      "receipt",
      "finalized_at",
    ]) {
      expect(getter).toContain(`finalized.${column}`);
    }
    expect(getter).not.toContain("stage1_source_baseline_activation_failures");
    expect(getter).not.toContain("shared_award_sources");
  });

  it("rejects every non-exact source-ID set and never returns partial rows", () => {
    for (const contract of [
      "v_requested_count not between 1 and 25",
      "pg_catalog.array_ndims(p_source_ids) is distinct from 1",
      "pg_catalog.array_lower(p_source_ids, 1) is distinct from 1",
      "where requested.source_id is null",
      "count(distinct requested.source_id)",
      "v_distinct_count <> v_requested_count",
      "v_matched_count <> v_requested_count",
      "errcode = '22023'",
      "errcode = 'P0002'",
    ]) {
      expect(getter).toContain(contract);
    }
    expect(getter.indexOf("v_matched_count <> v_requested_count")).toBeLessThan(
      getter.indexOf("return query"),
    );
  });

  it("is a deterministic stable read-only invoker function", () => {
    expect(getter).toMatch(
      /language plpgsql\s+stable\s+parallel safe\s+security invoker\s+set search_path = ''/i,
    );
    expect(getter).not.toMatch(/security definer/i);
    expect(getter).toContain(
      "from pg_catalog.unnest(p_source_ids) with ordinality",
    );
    expect(getter).toContain("order by requested.requested_ordinality");
    expect(getter).not.toMatch(
      /^\s*(?:insert|update|delete|truncate|execute)\b/imu,
    );
  });

  it("has an explicit postgres owner and service-role-only execution ACL", () => {
    expect(migration).toContain(
      "alter function public.get_stage1_source_activation_finalizations(uuid[])\n  owner to postgres;",
    );
    expect(migration).toContain(
      "revoke all on function public.get_stage1_source_activation_finalizations(uuid[])\nfrom public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.get_stage1_source_activation_finalizations(uuid[])\nto service_role;",
    );
    for (const assertion of [
      "pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'",
      "target.provolatile = 's'",
      "target.proparallel = 's'",
      "not target.prosecdef",
      "array['search_path=\"\"']::text[]",
      "pg_catalog.has_function_privilege(\n          'service_role'",
      "not pg_catalog.has_function_privilege(\n          'anon'",
      "not pg_catalog.has_function_privilege(\n          'authenticated'",
      "privilege.grantee = 0",
      "privilege.grantee not in (target.proowner, v_service_role_oid)",
    ]) {
      expect(migration).toContain(assertion);
    }
  });

  it("smokes validation, exact receipt round-trip, order, authority, and immutability", () => {
    for (const assertion of [
      "A null source-ID array was accepted.",
      "An empty source-ID array was accepted.",
      "A source-ID array containing null was accepted.",
      "Duplicate source IDs were accepted.",
      "More than 25 source IDs were accepted.",
      "A requested source without an exact finalization was accepted.",
      "changed or omitted an immutable receipt field",
      "did not preserve source-ID input order",
      "lacks its existing narrow service-role read authority",
      "read-only Stage 1 finalization smoke changed evidence rows",
      "The anon role invoked the Stage 1 finalization getter.",
      "The authenticated role invoked the Stage 1 finalization getter.",
      "The service role did not reach the getter completeness check through RLS.",
      "service-role getter round trip changed immutable finalization evidence",
    ]) {
      expect(smoke).toContain(assertion);
    }
    expect(smoke).toContain("exception when sqlstate '22023'");
    expect(smoke).toContain("exception when sqlstate 'P0002'");
    expect(smoke).toContain("pg_catalog.to_jsonb(finalized)");
    expect(smoke).toContain("pg_catalog.to_jsonb(loaded)");
    expect(smoke).toContain("set role anon;");
    expect(smoke).toContain("set role authenticated;");
    expect(smoke).toContain("set role service_role;");
    expect(smoke.match(/reset role;/g)).toHaveLength(3);
  });
});
