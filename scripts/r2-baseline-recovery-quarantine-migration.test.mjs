import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const migrationName = "20260716161529_r2_baseline_recovery_quarantine.sql";

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

const migration = read(`supabase/migrations/${migrationName}`);

describe("R2 baseline-recovery quarantine migration", () => {
  it("defines service-role-only record and exact-success resolution RPCs", () => {
    expect(migration).toMatch(
      /create or replace function public\.record_r2_baseline_recovery_quarantine\(\s*p_source_id uuid,\s*p_reason_code text,\s*p_evidence jsonb\s*\)\s*returns uuid[\s\S]*?security definer\s*set search_path = ''/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.resolve_r2_baseline_recovery_quarantine\(\s*p_source_id uuid,\s*p_evidence jsonb\s*\)\s*returns boolean[\s\S]*?security definer\s*set search_path = ''/i,
    );
    for (const signature of [
      "record_r2_baseline_recovery_quarantine(uuid, text, jsonb)",
      "resolve_r2_baseline_recovery_quarantine(uuid, jsonb)",
    ]) {
      expect(migration).toContain(`revoke all on function public.${signature}`);
      expect(migration).toContain(`grant execute on function public.${signature}`);
    }
  });

  it("atomically protects an active-award source and opens one source-keyed terminal case", () => {
    expect(migration).toContain("award.status = 'active'");
    expect(migration).toContain("for update of source, award");
    expect(migration).toContain("admin_review_status = 'review_later'");
    expect(migration).toContain("admin_reviewed_by = 'awardping-r2-baseline-recovery'");
    expect(migration).toContain("'r2-baseline-recovery:' || v_source.id::text");
    expect(migration).toContain("insert into public.manual_quarantine_registry");
    expect(migration).toContain("'actionable_quarantine'");
    expect(migration).toContain("'protected'");
    expect(migration).toContain("'none'");
    expect(migration).toContain("true,\n    1,\n    'high'");
    expect(migration).toContain("public.manual_quarantine_evidence_hash(v_evidence)");
    expect(migration).toContain("public.refresh_manual_quarantine_registry_state(v_now)");
    expect(migration).toContain("awardping-r2-baseline-recovery-quarantine");
    expect(migration).toContain("'r2_authoritative_baseline_recovery_failed'");
    expect(migration).toContain(
      "4458c623fe35d74671bf6b6c418b0dd3ac0567933f05fb87d562348a8a288683",
    );
    expect(migration).toContain("Do not fetch or promote a replacement baseline");
    expect(migration).toContain("exact-source, no-charge recovery path");
  });

  it("does not overwrite another review owner and cannot be auto-resolved by generic sync", () => {
    expect(migration).toContain("if v_worker_owns_review then");
    expect(migration).toContain("preserve_r2_baseline_recovery_quarantine");
    expect(migration).toContain(
      "old.policy_id = 'awardping-r2-baseline-recovery-quarantine'",
    );
    expect(migration).toContain("new.resolved_by = 'manual-quarantine-sync'");
    expect(migration).toContain("return old;");
    expect(migration).toMatch(
      /create trigger zz_preserve_r2_baseline_recovery_quarantine\s*before update on public\.manual_quarantine_registry/i,
    );
  });

  it("reopens and clears only the still-owned source after exact immutable-generation evidence", () => {
    for (const contract of [
      "'awardping.r2-baseline-recovery-resolution.v1'",
      "p_evidence -> 'rehydrated' is distinct from 'true'::jsonb",
      "p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb",
      "p_evidence -> 'used_live_fetch' is distinct from 'false'::jsonb",
      "'exact_r2_generation_rehydrated%'",
      "coalesce(p_evidence ->> 'generation', '') not in ('latest', 'previous')",
      "coalesce(p_evidence ->> 'family', '') not in ('captures', 'approved')",
      "p_evidence #>> '{baseline,source,id}' is distinct from p_source_id::text",
      "p_evidence #>> '{baseline,source,shared_award_id}'",
      "p_evidence #>> '{baseline,text_hash}'",
      "p_evidence #>> '{baseline,file_hash}'",
      "p_evidence #>> '{baseline,image_hash}'",
      "'AwardPing R2 recovery quarantine:%'",
      "v_reopen_source :=",
      "if v_reopen_source then",
      "'source_reopened', v_reopen_source",
      "'source_review_state_preserved', not v_reopen_source",
      "admin_review_status = 'open'",
      "next_check_at = v_now",
      "consecutive_failures = 0",
      "last_error = null",
      "resolved_by = 'awardping-r2-baseline-recovery'",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).not.toContain(
      "p_evidence -> 'restored_missing_baseline' is distinct from 'true'::jsonb",
    );
    expect(migration).toContain("evidence_hash = public.manual_quarantine_evidence_hash");
  });

  it("is required by launch checks, typed for workers, and documented in migration order", () => {
    const launchCheck = read("scripts/check-private-beta.mjs");
    const databaseTypes = read("src/lib/database.types.ts");
    const runbook = read("docs/private-beta-launch.md");
    const policy = read("docs/award-monitoring-policy.md");

    expect(launchCheck).toContain(migrationName);
    expect(launchCheck).toContain("record_r2_baseline_recovery_quarantine");
    expect(launchCheck).toContain("resolve_r2_baseline_recovery_quarantine");
    expect(launchCheck).toContain("preserve_r2_baseline_recovery_quarantine");
    expect(launchCheck).toContain(
      "p_evidence -> 'rehydrated' is distinct from 'true'::jsonb",
    );
    expect(launchCheck).not.toContain(
      "p_evidence -> 'restored_missing_baseline' is distinct from 'true'::jsonb",
    );
    expect(databaseTypes).toContain("record_r2_baseline_recovery_quarantine:");
    expect(databaseTypes).toContain("resolve_r2_baseline_recovery_quarantine:");
    expect(runbook).toContain(`\`${migrationName}\``);
    expect(policy).toContain("Generic registry refreshes cannot clear it");
    expect(policy).toContain("if another workflow has taken ownership");
  });
});
