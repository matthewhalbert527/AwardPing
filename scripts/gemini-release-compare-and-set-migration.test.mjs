import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "..",
    "supabase",
    "migrations",
    "20260716070500_gemini_release_compare_and_set.sql",
  ),
  "utf8",
);

describe("Gemini spend release compare-and-set migration", () => {
  it("replaces the unsafe two-argument release function", () => {
    expect(migration).toContain(
      "drop function if exists public.release_gemini_spend_reservation(uuid, text);",
    );
    expect(migration).toContain("p_expected_status text default null");
    expect(migration).toContain("p_expected_attempt_token uuid default null");
  });

  it("fails closed when a stale reserved observation races to creating", () => {
    expect(migration).toContain("'reason', 'reservation_state_changed'");
    expect(migration).toContain(
      "p_expected_attempt_token is null\n    or (",
    );
    expect(migration).toContain(
      "provider-started reservation % requires owner-bound definitive no-create evidence or settlement",
    );
  });

  it("keeps the function service-role-only", () => {
    expect(migration).toContain(
      "revoke all on function public.release_gemini_spend_reservation(uuid, text, text, uuid)",
    );
    expect(migration).toContain(
      "grant execute on function public.release_gemini_spend_reservation(uuid, text, text, uuid)\n  to service_role;",
    );
  });
});
