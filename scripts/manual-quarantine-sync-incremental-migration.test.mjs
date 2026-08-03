import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717070000_incremental_manual_quarantine_sync.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("incremental manual quarantine sync migration", () => {
  it("indexes and limits batch-attempt aggregation to current request keys", () => {
    expect(migration).toContain(
      "shared_award_page_audits_batch_request_key_idx",
    );
    expect(migration).toContain(
      "select distinct latest.gemini_batch_request_key\n      from latest_audit latest",
    );
    expect(migration).toContain(
      "latest_request.gemini_batch_request_key = attempt.gemini_batch_request_key",
    );
    expect(migration).toContain("if v_batch_match_count <> 1 then");
  });

  it("skips unchanged current cases without weakening evidence comparison", () => {
    expect(migration).toContain("if v_upsert_match_count <> 2 then");
    expect(migration).toContain(
      "public.manual_quarantine_registry.evidence_hash is distinct from excluded.evidence_hash",
    );
    expect(migration).toContain(
      "public.manual_quarantine_registry.last_observed_at is distinct from excluded.last_observed_at",
    );
    expect(migration).toContain(
      "public.manual_quarantine_registry.status = 'resolved'",
    );
    expect(migration).toContain(
      "public.manual_quarantine_registry.policy_hash is distinct from",
    );
  });

  it("auto-resolves only cases owned by the generic quarantine policy", () => {
    expect(migration).toContain("if v_public_resolution_match_count <> 1 then");
    expect(migration).toContain("if v_visual_resolution_match_count <> 1 then");
    expect(migration).toContain(
      "where registry.category = 'public_page'\n      and registry.policy_id = 'awardping-manual-quarantine'",
    );
    expect(migration).toContain(
      "where registry.category = 'visual_review'\n      and registry.policy_id = 'awardping-manual-quarantine'",
    );
  });

  it("uses a function-only timeout and leaves quarantine rows untouched during migration", () => {
    expect(migration).toContain(
      "alter function public.sync_manual_quarantine_registry()\n  set statement_timeout to '60s';",
    );
    expect(migration).not.toMatch(
      /(?:insert into|update|delete from) public\.manual_quarantine_registry\b/i,
    );
    expect(migration).not.toContain(
      "select public.sync_manual_quarantine_registry();",
    );
    expect(migration).not.toMatch(/grant execute[\s\S]*\b(?:anon|authenticated)\b/i);
  });

  it("advances the operator backlog revision only when a sync statement changes rows", () => {
    expect(migration).toContain(
      "create or replace function public.bump_manual_quarantine_backlog_for_changed_registry_rows()",
    );
    expect(migration).toContain(
      "from changed_manual_quarantine_registry_rows",
    );
    expect(migration).toContain(
      "drop trigger if exists bump_manual_quarantine_backlog_after_registry_mutation",
    );
    for (const operation of ["insert", "update", "delete"]) {
      expect(migration).toContain(
        `create trigger bump_manual_quarantine_backlog_after_registry_${operation}`,
      );
      expect(migration).toMatch(new RegExp(
        `after ${operation} on public\\.manual_quarantine_registry[\\s\\S]*?referencing (?:new|old) table as changed_manual_quarantine_registry_rows[\\s\\S]*?for each statement execute function[\\s\\S]*?public\\.bump_manual_quarantine_backlog_for_changed_registry_rows\\(\\);`,
      ));
    }
    expect(migration).toMatch(
      /revoke all on function public\.bump_manual_quarantine_backlog_for_changed_registry_rows\(\)\s+from public, anon, authenticated, service_role;/,
    );
  });
});
