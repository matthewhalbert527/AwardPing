import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20261018172127_fix_visual_semantic_side_text_aliases.sql", import.meta.url), "utf8");
const original = readFileSync(new URL("../supabase/migrations/20260716224500_exact_text_semantic_crop_binding.sql", import.meta.url), "utf8");
const start = original.indexOf("create or replace function public.awardping_visual_event_has_semantic_side(");
const oldBody = original.slice(original.indexOf("as $$", start) + 5, original.indexOf("\n$$;", start)).trim();
const newBody = migration.slice(migration.indexOf("AS $function$") + 13, migration.indexOf("\n$function$", migration.indexOf("AS $function$") + 13)).trim();

describe("visual semantic-side SETOF text aliases", () => {
  it("changes only the three undefined text column references", () => {
    expect((newBody.match(/select text_value\.value from public\.awardping_visual_json_text_values\(/g) || [])).toHaveLength(3);
    expect((newBody.match(/\) as text_value\(value\)/g) || [])).toHaveLength(3);
    const restored = newBody
      .replaceAll("select text_value.value from public.awardping_visual_json_text_values(", "select value from public.awardping_visual_json_text_values(")
      .replaceAll(") as text_value(value)", ")");
    expect(restored).toBe(oldBody);
  });

  it("preserves function identity and security attributes without data or privilege mutation", () => {
    expect(migration).toContain("public.awardping_visual_event_has_semantic_side(p_change_details jsonb, p_side text)");
    expect(migration).toContain("RETURNS boolean");
    expect(migration).toContain("LANGUAGE plpgsql");
    expect(migration).toContain("IMMUTABLE");
    expect(migration).toContain("SET search_path TO ''");
    const statements = migration.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\b(?:grant|revoke|drop|update|insert|delete|security\s+definer)\b/i);
    expect((statements.match(/CREATE OR REPLACE FUNCTION/gi) || [])).toHaveLength(1);
  });
});
