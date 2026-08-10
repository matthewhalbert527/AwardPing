import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const authConfig = read("supabase/config.toml");
const recoveryTemplate = read("supabase/templates/recovery.html");
const recoveryRequestRoute = read(
  "src/app/api/auth/password-recovery/route.ts",
);
const passwordUpdateRoute = read("src/app/api/auth/password-update/route.ts");
const rateLimitMigration = read(
  "supabase/migrations/20260810214215_add_password_recovery_rate_limit_kind.sql",
);
const rateLimitConstraintMigration = read(
  "supabase/migrations/20260810220418_expand_password_recovery_rate_limit_constraint.sql",
);

describe("invite-only password recovery boundary", () => {
  it("keeps public signup disabled while enforcing the app password floor", () => {
    expect(authConfig).toMatch(/^enable_signup = false$/m);
    expect(authConfig).toMatch(/^minimum_password_length = 12$/m);
  });

  it("uses the exact allow-listed callback and server-side recovery verification", () => {
    expect(recoveryRequestRoute).toContain(
      'new URL("/auth/confirm", appConfig.url).toString()',
    );
    expect(recoveryTemplate).toContain("{{ .RedirectTo }}?token_hash=");
    expect(recoveryTemplate).toContain("{{ .TokenHash }}");
    expect(recoveryTemplate).toContain("type=recovery");
    expect(recoveryTemplate).toContain("next=%2Freset-password");
  });

  it("never creates an account during password recovery", () => {
    expect(recoveryRequestRoute).toContain("resetPasswordForEmail");
    expect(recoveryRequestRoute).not.toMatch(/signUp|createUser|serviceRole/i);
  });

  it("uses a dedicated atomic and privileged durable IP budget", () => {
    expect(recoveryRequestRoute).toContain('kind: "password_recovery"');
    expect(rateLimitMigration).toContain("'password_recovery'");
    expect(rateLimitMigration).toContain("pg_advisory_xact_lock");
    expect(rateLimitMigration).toMatch(
      /revoke all on function public\.reserve_public_form_rate_limit[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(rateLimitMigration).toMatch(
      /grant execute on function public\.reserve_public_form_rate_limit[\s\S]*to service_role/i,
    );
    expect(rateLimitConstraintMigration).toMatch(
      /check \(kind in \('subscribe', 'contact', 'source_request', 'password_recovery'\)\)/i,
    );
    expect(rateLimitConstraintMigration).toMatch(
      /add constraint public_form_rate_limits_kind_check_v2[\s\S]*not valid;[\s\S]*validate constraint public_form_rate_limits_kind_check_v2;[\s\S]*drop constraint public_form_rate_limits_kind_check;[\s\S]*rename constraint public_form_rate_limits_kind_check_v2[\s\S]*to public_form_rate_limits_kind_check;/i,
    );
  });

  it("authorizes the password mutation on the server before updating", () => {
    const authorization = passwordUpdateRoute.indexOf("supabase.auth.getUser()");
    const mutation = passwordUpdateRoute.indexOf("supabase.auth.updateUser");

    expect(passwordUpdateRoute).toContain("isSameOriginMutationRequest(request)");
    expect(authorization).toBeGreaterThan(0);
    expect(mutation).toBeGreaterThan(authorization);
  });
});

function read(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
