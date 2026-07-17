import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260717032000_atomic_public_form_rate_limits.sql", import.meta.url),
  "utf8",
);
const implementation = readFileSync(
  new URL("../src/lib/public-form-rate-limit.ts", import.meta.url),
  "utf8",
);

describe("atomic public form rate-limit migration", () => {
  it("serializes an exact kind/IP reservation before count and insert", () => {
    const lock = migration.indexOf("pg_advisory_xact_lock");
    const count = migration.indexOf("select count(*)::integer");
    const insert = migration.indexOf("insert into public.public_form_rate_limits");
    expect(lock).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(count);
    expect(migration).toContain("'public-form-rate-limit:' || p_kind || ':' || p_ip_hash");
  });

  it("removes direct service-role writes and exposes only the atomic RPC", () => {
    expect(migration).toContain("revoke insert, update, delete, truncate on table public.public_form_rate_limits");
    expect(migration).toContain("grant execute on function public.reserve_public_form_rate_limit");
    expect(implementation).toContain('.rpc("reserve_public_form_rate_limit"');
    expect(implementation).not.toContain('.from("public_form_rate_limits")');
  });

  it("computes retry timing with an ordinary schema-qualified function call", () => {
    expect(migration).not.toContain("pg_catalog.extract(epoch from");
    expect(migration).toContain("pg_catalog.date_part(");
    expect(migration).not.toContain("pg_catalog.greatest(");
    expect(migration).toContain("greatest(");
  });
});
