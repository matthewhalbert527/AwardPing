import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const migration = read(
  "supabase/migrations/20260716211002_invite_only_beta_signup.sql",
);
const authForm = read("src/components/auth-form.tsx");
const signupPage = read("src/app/signup/page.tsx");
const joinPage = read("src/app/join/[token]/page.tsx");
const inviteCreationRoute = read("src/app/api/offices/invites/route.ts");
const inviteReissueRoute = read(
  "src/app/api/offices/invites/[invite]/reissue/route.ts",
);
const officeContext = read("src/lib/offices.ts");

describe("invite-only signup boundary", () => {
  it("keeps reservation state private, RLS-enabled, and row locked", () => {
    expect(migration).toMatch(
      /create table if not exists private\.office_invite_signup_reservations/i,
    );
    expect(migration).toMatch(
      /alter table private\.office_invite_signup_reservations enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table private\.office_invite_signup_reservations\s+from public, anon, authenticated, service_role/i,
    );
    expect((migration.match(/for update/gi) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("binds each addressed invitation to an immutable normalized email hash", () => {
    expect(migration).toContain("signup_email_hash");
    expect(migration).toMatch(/office_invites_immutable_signup_email/i);
    expect(migration).toMatch(/invitation email binding is immutable/i);
    expect(migration).toMatch(/lower\(pg_catalog\.btrim\(invite\.email\)\)/i);
  });

  it("uses high-entropy pending codes and sends the stronger bearer token in links", () => {
    expect(migration).toContain("office_invites_pending_code_entropy_check");
    expect(migration).toContain("invite_code ~ '^[A-F0-9]{32}$'");
    expect(inviteCreationRoute).toContain("crypto.randomBytes(16)");
    expect(inviteCreationRoute).toContain("/join/${inviteToken}");
    expect(inviteCreationRoute).not.toContain("/join/${invite.invite_code}");
  });

  it("exposes reservation and completion RPCs only to service_role", () => {
    for (const functionName of [
      "get_office_invite_signup_preview(text)",
      "reserve_office_invite_signup(text)",
      "reconcile_office_invite_signup_auth_user(uuid, uuid, text)",
      "complete_office_invite_signup(uuid, uuid, uuid, text)",
      "release_office_invite_signup_reservation(uuid, uuid)",
      "accept_office_invite_for_user(text, uuid, text)",
      "prepare_office_invite_security_reissue(uuid, uuid, text, text, timestamptz, uuid)",
      "record_office_invite_security_reissue_delivery(uuid, uuid, text, text)",
      "get_office_invite_security_reissue_status()",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `revoke all on function public\\.${escapeRegExp(functionName)}\\s+from public, anon, authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `grant execute on function public\\.${escapeRegExp(functionName)}\\s+to service_role`,
          "i",
        ),
      );
    }
  });

  it("turns every rotated legacy code into a durable, explicit resend action", () => {
    expect(migration).toMatch(
      /create table if not exists public\.office_invite_security_reissues/i,
    );
    expect(migration).toMatch(
      /insert into public\.office_invite_security_reissues[\s\S]*invite_code !~ '\^\[A-F0-9\]\{32\}\$'/i,
    );
    expect(migration.indexOf("insert into public.office_invite_security_reissues")).toBeLessThan(
      migration.indexOf("update public.office_invites invite\nset invite_code"),
    );
    expect(inviteReissueRoute).toContain("prepare_office_invite_security_reissue");
    expect(inviteReissueRoute).toContain("record_office_invite_security_reissue_delivery");
    expect(inviteReissueRoute).toContain("isSameOriginMutationRequest(request)");
    expect(inviteReissueRoute).toContain("/join/${inviteToken}");
  });

  it("invalidates every in-flight old signup reservation before rotating a credential", () => {
    const reissue = functionBody("prepare_office_invite_security_reissue");
    const deleteIndex = reissue.indexOf(
      "delete from private.office_invite_signup_reservations",
    );
    const rotateIndex = reissue.indexOf("update public.office_invites invite");

    expect(deleteIndex).toBeGreaterThan(0);
    expect(rotateIndex).toBeGreaterThan(deleteIndex);
    expect(reissue).toContain("where reservation.invite_id = selected_invite.id");
  });

  it("atomically preserves privileged roles, joins, consumes, and clears reservation", () => {
    const completion = functionBody("complete_office_invite_signup");

    expect(completion).toMatch(/insert into public\.office_members/i);
    expect(completion).toMatch(/when existing_member\.role = 'owner' then 'owner'/i);
    expect(completion).toMatch(/when existing_member\.role = 'admin' then 'admin'/i);
    expect(completion).toMatch(/update public\.office_invites/i);
    expect(completion).toMatch(/accepted_at = pg_catalog\.clock_timestamp\(\)/i);
    expect(completion).toMatch(
      /delete from private\.office_invite_signup_reservations/i,
    );
  });

  it("uses the same row-locked, role-preserving transaction for existing users", () => {
    const acceptance = functionBody("accept_office_invite_for_user");

    expect(acceptance).toMatch(/for update/i);
    expect(acceptance).toMatch(/insert into public\.office_members as existing_member/i);
    expect(acceptance).toMatch(/when existing_member\.role = 'owner' then 'owner'/i);
    expect(acceptance).toMatch(/when existing_member\.role = 'admin' then 'admin'/i);
    expect(acceptance).toMatch(/update public\.office_invites/i);
  });

  it("removes browser metadata and eager office creation from the Auth trigger", () => {
    const authTrigger = functionBody("handle_new_user");

    expect(authTrigger).not.toMatch(/raw_user_meta_data|existing_office_id/i);
    expect(authTrigger).not.toMatch(/office_members|ensure_default_office/i);
    expect(authTrigger).toMatch(/insert into public\.profiles/i);
    expect(authTrigger).toMatch(/insert into public\.subscriptions/i);
  });

  it("does not auto-provision a workspace for an account without an accepted invite", () => {
    expect(officeContext).not.toMatch(/ensureDefaultOffice|ensure_default_office_for_user/i);
    expect(officeContext).toMatch(/if \(memberships\.length === 0\) \{\s*return null;/i);
  });

  it("never renders general signup or calls browser signUp", () => {
    expect(authForm).not.toMatch(/\.auth\.signUp\s*\(/);
    expect(signupPage).not.toMatch(/<AuthForm|mode=["']signup["']/);
    expect(joinPage).toMatch(/get_office_invite_signup_preview/);
    expect(joinPage).toMatch(/preview \? \(/);
    expect(joinPage).toMatch(/<AuthForm[\s\S]*mode="signup"/);
  });
});

function read(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function functionBody(functionName: string) {
  const match = migration.match(
    new RegExp(
      `create or replace function public\\.${functionName}\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    ),
  );
  expect(match, `${functionName} must exist in the invite migration`).not.toBeNull();
  return match?.[0] || "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
