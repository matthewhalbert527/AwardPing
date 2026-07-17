import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716212857_atomic_free_check_rate_limit.sql",
    import.meta.url,
  ),
  "utf8",
);

const reservationFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.reserve_free_check_attempt(",
  ),
  migration.indexOf(
    "revoke execute on function public.reserve_free_check_attempt(",
  ),
);

const completionFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.complete_free_check_attempt(",
  ),
  migration.indexOf(
    "revoke execute on function public.reserve_free_check_attempt(",
  ),
);

describe("atomic free-check rate-limit migration", () => {
  it("creates private RLS-protected counter and audit tables", () => {
    for (const table of [
      "free_check_rate_limit_windows",
      "free_check_attempts",
    ]) {
      expect(migration).toContain(`create table public.${table} (`);
      expect(migration).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(migration).toContain(`revoke all on table public.${table}`);
    }

    expect(migration).not.toMatch(
      /grant\s+[^;]+free_check_(?:rate_limit_windows|attempts)[^;]+to\s+(?:anon|authenticated)/i,
    );
    expect(migration).toContain(
      "grant select on table public.free_check_rate_limit_windows to service_role;",
    );
    expect(migration).toContain(
      "grant select on table public.free_check_attempts to service_role;",
    );
    expect(migration).not.toMatch(
      /grant\s+update[^;]+free_check_attempts/i,
    );
  });

  it("serializes each IP reservation inside one transaction", () => {
    expect(reservationFunction).toContain("language plpgsql");
    expect(reservationFunction).toContain("security definer");
    expect(reservationFunction).toContain("set search_path = ''");
    expect(reservationFunction).toContain(
      "pg_catalog.pg_advisory_xact_lock(",
    );
    expect(reservationFunction).toContain("pg_catalog.hashtextextended(");
    expect(reservationFunction).toContain("for update;");
    expect(reservationFunction.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      reservationFunction.indexOf("select rate_window.reserved_count"),
    );
    expect(
      reservationFunction.indexOf("select rate_window.reserved_count"),
    ).toBeLessThan(
      reservationFunction.indexOf("insert into public.free_check_attempts"),
    );
  });

  it("cannot be configured above ten checks per hour", () => {
    expect(migration).toContain(
      "check (reserved_count between 0 and 10)",
    );
    expect(reservationFunction).toContain(
      "least(greatest(coalesce(p_limit, 10), 1), 10)",
    );
    expect(reservationFunction).toContain(
      "v_allowed := v_reserved_count < v_effective_limit;",
    );
    expect(reservationFunction).toContain("interval '1 hour'");
  });

  it("records allowed and denied attempts without storing the raw URL", () => {
    expect(migration).toContain("url_hash text not null");
    expect(migration).not.toContain("requested_url text");
    expect(reservationFunction).toContain("'reserved'");
    expect(reservationFunction).toContain("'rate_limited'");
    expect(migration).toContain(
      "create unique index free_check_attempts_one_denial_per_window_idx",
    );
    expect(reservationFunction).toContain("and not attempt.allowed");
    expect(migration).toContain("'succeeded'");
    expect(migration).toContain("'failed'");
  });

  it("exposes the definer RPC only to the service role", () => {
    for (const signature of [
      "public.reserve_free_check_attempt(text, text, text, integer)",
      "public.complete_free_check_attempt(uuid, text, text)",
    ]) {
      expect(migration).toContain(
        `revoke execute on function ${signature}`,
      );
      expect(migration).toContain(`grant execute on function ${signature}`);
    }
    expect(migration).toContain("from public, anon, authenticated;");
    expect(migration).toContain("to service_role;");
  });

  it("completes outcomes with a timestamped compare-and-set RPC", () => {
    expect(completionFunction).toContain("security definer");
    expect(completionFunction).toContain("set search_path = ''");
    expect(completionFunction).toContain(
      "p_outcome not in ('succeeded', 'failed')",
    );
    expect(completionFunction).toContain("completed_at = statement_timestamp()");
    expect(completionFunction).toContain("and attempt.allowed");
    expect(completionFunction).toContain("and attempt.outcome = 'reserved'");
    expect(completionFunction).toContain("and attempt.completed_at is null");
    expect(completionFunction).toContain("return found;");
  });

  it("reconciles stale reservations and performs bounded indexed retention", () => {
    expect(reservationFunction).toContain("outcome = 'outcome_unknown'");
    expect(reservationFunction).toContain(
      "failure_kind = 'reservation_stale'",
    );
    expect(reservationFunction).toContain("interval '15 minutes'");
    expect(reservationFunction).toContain("limit 100");
    expect(reservationFunction).toContain("interval '30 days'");
    expect(reservationFunction.match(/limit 200/g)).toHaveLength(2);
    expect(
      reservationFunction.match(/for update(?: of rate_window)? skip locked/g),
    ).toHaveLength(3);
    expect(migration).toContain("free_check_attempts_created_idx");
    expect(migration).toContain("free_check_rate_limit_windows_started_idx");
  });

  it("publishes one versioned read-only release-contract probe", () => {
    expect(migration).toContain(
      "create or replace function public.get_awardping_release_contract_status()",
    );
    expect(migration).toContain("'awardping-release-contract-v1'");
    for (const signature of [
      "public.get_office_invite_signup_preview(text)",
      "public.reserve_office_invite_signup(text)",
      "public.reconcile_office_invite_signup_auth_user(uuid,uuid,text)",
      "public.complete_office_invite_signup(uuid,uuid,uuid,text)",
      "public.release_office_invite_signup_reservation(uuid,uuid)",
      "public.prepare_office_invite_security_reissue(uuid,uuid,text,text,timestamptz,uuid)",
      "public.record_office_invite_security_reissue_delivery(uuid,uuid,text,text)",
      "public.accept_office_invite_for_user(text,uuid,text)",
      "public.get_office_invite_security_reissue_status()",
      "public.reserve_free_check_attempt(text,text,text,integer)",
      "public.complete_free_check_attempt(uuid,text,text)",
    ]) {
      expect(migration, signature).toContain(
        `pg_catalog.to_regprocedure('${signature}') is not null`,
      );
    }
    for (const table of [
      "public.office_invite_security_reissues",
      "private.office_invite_signup_reservations",
      "public.free_check_rate_limit_windows",
      "public.free_check_attempts",
    ]) {
      expect(migration, table).toContain(
        `pg_catalog.to_regclass('${table}') is not null`,
      );
    }
    expect(migration).toContain("'column:public.office_invites.signup_email_hash'");
    expect(migration).toContain(
      "grant execute on function public.get_awardping_release_contract_status()",
    );
  });
});
