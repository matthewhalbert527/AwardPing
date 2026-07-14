import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260714194126_secure_office_membership_policy_helpers.sql",
    import.meta.url,
  ),
  "utf8",
);

const membershipPolicies = [
  "offices visible to members",
  "office members visible to members",
  "office invites visible to admins",
  "awards are office visible",
  "award sources are office visible",
  "monitors are office visible",
  "snapshots visible through office monitor",
  "events visible through office monitor",
  "alert deliveries visible to office members",
  "awards workflow editable by office members",
  "award notes visible to office members",
  "award notes created by office members",
  "award tasks visible to office members",
  "award tasks created by office members",
  "award tasks editable by office members",
];

describe("office membership helper security migration", () => {
  it("moves every membership-dependent policy to the private helpers", () => {
    for (const [index, policy] of membershipPolicies.entries()) {
      const start = migration.indexOf(`alter policy "${policy}"`);
      const nextPolicy = membershipPolicies[index + 1];
      const end = nextPolicy
        ? migration.indexOf(`alter policy "${nextPolicy}"`, start)
        : migration.indexOf("drop function public.is_office_admin", start);

      expect(start, policy).toBeGreaterThanOrEqual(0);
      expect(end, policy).toBeGreaterThan(start);
      expect(migration.slice(start, end), policy).toContain("private.is_office_");
      expect(migration.slice(start, end), policy).not.toContain("public.is_office_");
    }
  });

  it("permits RLS evaluation without leaving public membership RPCs", () => {
    expect(migration).toContain(
      "create or replace function private.is_office_member(target_office_id uuid)",
    );
    expect(migration).toContain("member.user_id = (select auth.uid())");
    expect(migration).not.toContain("target_user_id uuid");
    expect(migration).toContain(
      "grant execute on function private.is_office_member(uuid)\n  to anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant execute on function private.is_office_admin(uuid)\n  to anon, authenticated, service_role;",
    );
    expect(migration).toContain("drop function public.is_office_member(uuid, uuid);");
    expect(migration).toContain("drop function public.is_office_admin(uuid, uuid);");
  });
});
