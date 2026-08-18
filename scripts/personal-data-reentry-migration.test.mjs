import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717113112_preserve_legacy_personal_data_for_reentry.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("personal-data preserved re-entry migration", () => {
  it("archives every non-v2 profile ciphertext before marking re-entry", () => {
    const archiveInsert = migration.indexOf(
      "insert into public.personal_data_legacy_ciphertext_archive",
    );
    const markReentry = migration.indexOf("update public.profiles profile");

    expect(archiveInsert).toBeGreaterThan(-1);
    expect(markReentry).toBeGreaterThan(archiveInsert);
    expect(migration).toContain("('full_name_encrypted'::text, profile.full_name_encrypted)");
    expect(migration).toContain("('organization_encrypted'::text, profile.organization_encrypted)");
    expect(migration).toContain("value.ciphertext not like 'ap:v2:%'");
    expect(migration).toContain("private.awardping_personal_data_sha256(value.ciphertext)");
    expect(migration).toContain("legacy_v1_key_unavailable");
    expect(migration).toContain("unsupported_ciphertext_format");
    expect(migration).not.toMatch(
      /update public\.profiles[\s\S]*?(full_name_encrypted|organization_encrypted)\s*=\s*null/,
    );
  });

  it("keeps the archive unreadable and immutable to API roles", () => {
    expect(migration).toContain(
      "alter table public.personal_data_legacy_ciphertext_archive enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.personal_data_legacy_ciphertext_archive",
    );
    expect(migration).toContain(
      "from public, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "grant select on table public.personal_data_legacy_ciphertext_archive to service_role",
    );
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete|truncate|all)[\s\S]*personal_data_legacy_ciphertext_archive/i,
    );
    expect(migration).toContain(
      "before update or delete on public.personal_data_legacy_ciphertext_archive",
    );
    expect(migration).toContain(
      "before truncate on public.personal_data_legacy_ciphertext_archive",
    );
  });

  it("accepts only an extension-owned pgcrypto digest implementation", () => {
    const digest = functionBody(
      migration,
      "create or replace function private.awardping_personal_data_sha256",
    );

    expect(digest).toContain("language plpgsql\nstable\nstrict");
    expect(digest).toContain("pg_catalog.pg_depend");
    expect(digest).toContain("pg_catalog.pg_extension");
    expect(digest).toContain("dependency.deptype = 'e'");
    expect(digest).toContain("extension.extname = 'pgcrypto'");
    expect(digest).toContain("procedure.prokind = 'f'");
    expect(digest).toContain("procedure.proowner = extension.extowner");
    expect(digest).toContain("pg_catalog.to_regtype('pg_catalog.bytea')");
    expect(digest).toContain(
      "pg_catalog.to_regprocedure('extensions.digest(bytea,text)')::oid",
    );
    expect(digest).toContain(
      "pg_catalog.to_regprocedure('public.digest(bytea,text)')::oid",
    );
    expect(digest.indexOf("extensions.digest(bytea,text)")).toBeLessThan(
      digest.indexOf("public.digest(bytea,text)"),
    );
    expect(digest).not.toMatch(
      /elsif pg_catalog\.to_regprocedure\('public\.digest\(bytea,text\)'\) is not null/,
    );
  });

  it("permits erasure only through the exact pending account-deletion request", () => {
    const rpc = functionBody(
      migration,
      "create or replace function public.erase_personal_data_legacy_archive_for_privacy_request",
    );

    expect(rpc).toContain("security definer");
    expect(rpc).toContain("set search_path = ''");
    expect(rpc).toContain("from public.privacy_requests request");
    expect(rpc).toContain("for update");
    expect(rpc).toContain("v_request.user_id is distinct from p_user_id");
    expect(rpc).toContain("v_request.request_type <> 'delete'");
    expect(rpc).toContain("v_request.status <> 'pending'");
    expect(rpc).toContain("awardping.personal_data_erasure_user_id");
    expect(migration).toContain(
      "grant execute on function public.erase_personal_data_legacy_archive_for_privacy_request(uuid, uuid)",
    );
    expect(migration).toContain("to service_role");
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const end = source.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`Missing function terminator for ${signature}`);
  return source.slice(start, end + 4);
}
