import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717073548_reconciliation_disposition_atomicity.sql",
    import.meta.url,
  ),
  "utf8",
);
const worker = readFileSync(
  new URL("./reconcile-impacted-award-pages.mjs", import.meta.url),
  "utf8",
);
const databaseTypes = readFileSync(
  new URL("../src/lib/database.types.ts", import.meta.url),
  "utf8",
);

const blockedFunction = section(
  migration,
  "create or replace function public.commit_award_reconciliation_blocked(",
  "revoke all on function public.commit_award_reconciliation_blocked(",
);
const finishFunction = section(
  migration,
  "create or replace function public.finish_or_requeue_award_reconciliation_claim(",
  "revoke all on function public.finish_or_requeue_award_reconciliation_claim(",
);
const invalidationFunction = section(
  migration,
  "create or replace function public.invalidate_stage1_publication_on_fact_candidate_change()",
  "revoke all on function public.invalidate_stage1_publication_on_fact_candidate_change()",
);
const lifecycleFunction = section(
  migration,
  "create or replace function public.awardping_enforce_fact_candidate_status_lifecycle()",
  "revoke all on function public.awardping_enforce_fact_candidate_status_lifecycle()",
);
const terminalArchiveTable = section(
  migration,
  "create table public.shared_award_fact_candidate_terminal_archive (",
  "alter table public.shared_award_fact_candidate_terminal_archive",
);
const terminalArchiveMutationGuard = section(
  migration,
  "create or replace function private.prevent_terminal_candidate_archive_mutation()",
  "revoke all on function private.prevent_terminal_candidate_archive_mutation()",
);
const stage1OutcomeHelper = section(
  migration,
  "create or replace function private.invalidate_stage1_reconciliation_outcome(",
  "revoke all on function private.invalidate_stage1_reconciliation_outcome(",
);
const successWrapper = section(
  migration,
  "create function public.commit_award_reconciliation_publication(",
  "revoke all on function public.commit_award_reconciliation_publication(",
);
const blockedBranch = section(
  worker,
  "} else {\n      report.awards_publication_blocked += 1;",
  "\n    }\n  } catch (error)",
);

describe("reconciliation disposition atomicity migration", () => {
  it("commits blocked dispositions, audit, and queue failure in one RPC", () => {
    expect(blockedFunction).toContain("for update;");
    expect(blockedFunction).toContain(
      "v_queue.generation is distinct from p_expected_queue_generation",
    );
    expect(
      blockedFunction.indexOf(
        "v_queue.generation is distinct from p_expected_queue_generation",
      ),
    ).toBeLessThan(
      blockedFunction.indexOf(
        "insert into public.shared_award_fact_candidates",
      ),
    );
    expect(blockedFunction).toContain(
      "insert into public.shared_award_fact_candidates",
    );
    expect(blockedFunction).toContain(
      "update public.shared_award_fact_candidates candidate",
    );
    expect(blockedFunction).toContain(
      "candidate.updated_at = mutation.expected_updated_at",
    );
    expect(blockedFunction).toContain(
      "insert into public.shared_award_page_audits",
    );
    expect(blockedFunction).toContain(
      "update public.shared_award_reconciliation_queue queue",
    );
    expect(blockedFunction).toContain(
      "queue.generation = p_expected_queue_generation",
    );
    expect(blockedFunction).toContain("status = 'failed'");
    expect(blockedFunction).toContain(
      "'warnings', 'failed', 'needs_review'",
    );
    expect(blockedFunction).not.toContain(
      "'passed', 'warnings', 'failed', 'needs_review'",
    );
    expect(blockedFunction).toContain(
      "'warning', 'error', 'critical'",
    );

    expect(blockedBranch).toContain(
      "const blockedStatus = await commitBlockedAwardReconciliation({",
    );
    expect(blockedBranch).toContain(
      "const blockedAudit = auditForBlockedDisposition(audit, failureReason);",
    );
    expect(blockedBranch).toContain(
      "auditRow: buildAuditRow(award, blockedAudit, publishableFacts)",
    );
    expect(worker).toContain(
      'audit_status: "needs_review"',
    );
    expect(worker).toContain(
      'code: "reconciliation_blocked_after_passing_field_audit"',
    );
    expect(worker).toContain(
      'supabase.rpc(\n    "commit_award_reconciliation_blocked"',
    );
    expect(blockedBranch).not.toContain(
      '.from("shared_award_fact_candidates")',
    );
    expect(blockedBranch).not.toContain('.from("shared_award_page_audits")');
  });

  it("requeues a merged generation instead of overwriting the newer trigger", () => {
    const generationCheck = finishFunction.indexOf(
      "v_queue.generation is distinct from p_expected_queue_generation",
    );
    const terminalWrite = finishFunction.indexOf("status = p_terminal_status");
    expect(generationCheck).toBeGreaterThan(-1);
    expect(terminalWrite).toBeGreaterThan(generationCheck);
    expect(finishFunction).toContain("status = 'pending'");
    expect(finishFunction).toContain("started_at = null");
    expect(finishFunction).toContain("completed_at = null");
    expect(finishFunction).toContain(
      "requeued_after_trigger_during_processing",
    );
    expect(finishFunction).toContain("p_terminal_status = 'pending'");
    expect(finishFunction).toContain(
      "requeued_after_transient_reconciliation_conflict",
    );
    expect(worker).toContain('"finish_or_requeue_award_reconciliation_claim"');
    expect(worker).toContain(
      "const retryableConflict = isRetryableReconciliationConflict(error);",
    );
    expect(worker).toContain(
      'return ["40001", "40P01"].includes(String(error?.code || ""));',
    );
    expect(worker).toContain("transient_conflicts_requeued");
    expect(worker).toContain(
      'data.status === "pending" && terminalStatus !== "pending"',
    );
    expect(worker).not.toContain("async function updateOwnedQueue(");
  });

  it("takes the national release lock before terminal queue mutations", () => {
    const finishLock = finishFunction.indexOf(
      "perform pg_catalog.pg_advisory_xact_lock(",
    );
    const finishQueueLock = finishFunction.indexOf(
      "from public.shared_award_reconciliation_queue queue",
    );
    const blockedLock = blockedFunction.indexOf(
      "perform pg_catalog.pg_advisory_xact_lock(",
    );
    const blockedQueueLock = blockedFunction.indexOf(
      "from public.shared_award_reconciliation_queue queue",
    );
    expect(finishFunction).toContain(
      "if p_terminal_status in ('failed', 'skipped') then",
    );
    expect(finishLock).toBeGreaterThan(-1);
    expect(finishLock).toBeLessThan(finishQueueLock);
    expect(blockedLock).toBeGreaterThan(-1);
    expect(blockedLock).toBeLessThan(blockedQueueLock);

    const generationRequeue = section(
      finishFunction,
      "if v_queue.generation is distinct from p_expected_queue_generation then",
      "if p_terminal_status = 'pending' then",
    );
    const explicitRequeue = section(
      finishFunction,
      "if p_terminal_status = 'pending' then",
      "update public.shared_award_reconciliation_queue queue\n  set\n    status = p_terminal_status",
    );
    expect(generationRequeue).not.toContain(
      "private.invalidate_stage1_reconciliation_outcome",
    );
    expect(explicitRequeue).not.toContain(
      "private.invalidate_stage1_reconciliation_outcome",
    );
    expect(
      occurrences(
        finishFunction,
        "private.invalidate_stage1_reconciliation_outcome",
      ),
    ).toBe(1);
    expect(
      occurrences(
        blockedFunction,
        "private.invalidate_stage1_reconciliation_outcome",
      ),
    ).toBe(1);
  });

  it("fences every successful publication before the deployed implementation can lock rows", () => {
    expect(migration).toContain(") set schema private;");
    expect(migration).toContain(
      ") rename to commit_award_reconciliation_publication_unfenced_20260716221500;",
    );
    const lock = successWrapper.indexOf(
      "perform pg_catalog.pg_advisory_xact_lock(",
    );
    const innerCall = successWrapper.indexOf(
      "private.commit_award_reconciliation_publication_unfenced_20260716221500(",
    );
    expect(lock).toBeGreaterThan(-1);
    expect(innerCall).toBeGreaterThan(lock);
    expect(successWrapper).toContain("security definer");
    expect(successWrapper).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function private\.commit_award_reconciliation_publication_unfenced_20260716221500\([\s\S]+?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.commit_award_reconciliation_publication\([\s\S]+?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.commit_award_reconciliation_publication\([\s\S]+?\) to service_role;/,
    );
  });

  it("invalidates Stage 1 when candidate evidence changes without text drift", () => {
    expect(migration).toContain(
      "before insert or update or delete on public.shared_award_fact_candidates",
    );
    expect(migration).toContain(
      "execute function public.stage1_evidence_release_fence_before_statement()",
    );
    expect(migration).toContain(
      "execute function public.invalidate_stage1_publication_on_fact_candidate_change()",
    );
    expect(invalidationFunction).toContain(
      "old.candidate_status is distinct from new.candidate_status",
    );
    expect(invalidationFunction).toContain(
      "old.selected_reason is distinct from new.selected_reason",
    );
    expect(invalidationFunction).toContain(
      "old.rejection_reason is distinct from new.rejection_reason",
    );
    expect(invalidationFunction).toContain(
      "publication_state = 'revalidation_pending'",
    );
    expect(invalidationFunction).toMatch(
      /publication_state = 'revalidation_pending',\s+release_epoch = null,/,
    );
    expect(invalidationFunction).toContain(
      "registry.publication_state = 'verified_beta'",
    );
    expect(invalidationFunction).toContain(
      "perform public.invalidate_stage1_cohort_release(",
    );
  });

  it("makes candidate identity and rejected material state database-immutable", () => {
    expect(lifecycleFunction).toContain("if tg_op = 'DELETE' then");
    expect(lifecycleFunction).toContain("old.candidate_status = 'rejected'");
    expect(lifecycleFunction).toContain(
      "A rejected fact candidate is terminal and cannot be deleted.",
    );
    expect(lifecycleFunction).toContain("new.id is distinct from old.id");
    expect(lifecycleFunction).toContain(
      "new.created_at is distinct from old.created_at",
    );
    expect(lifecycleFunction).toContain(
      "old.candidate_status = 'rejected' and v_material_changed",
    );
    expect(migration).toContain(
      "before update or delete on public.shared_award_fact_candidates",
    );
    expect(blockedFunction).toContain(
      "mutation.value ->> 'expected_status' = 'rejected'",
    );
    expect(blockedFunction).toContain("revives terminal rejection");
  });

  it("archives the exact rejected row only for database-owned FK lifecycle actions", () => {
    expect(terminalArchiveTable).toContain(
      "'rejected-candidate-fk-lifecycle-v1'",
    );
    expect(terminalArchiveTable).toContain("candidate_snapshot jsonb not null");
    expect(terminalArchiveTable).toContain(
      "candidate_snapshot_hash text not null",
    );
    expect(terminalArchiveTable).toContain("trigger_depth > 1");
    expect(terminalArchiveTable).toContain(
      "candidate_snapshot ->> 'candidate_status' = 'rejected'",
    );
    expect(terminalArchiveTable).not.toContain(
      "references public.shared_awards",
    );
    expect(terminalArchiveTable).not.toContain(
      "references public.shared_award_sources",
    );
    expect(migration).toContain(
      "shared_award_fact_candidate_terminal_archive_award_idx",
    );

    expect(lifecycleFunction).toContain("security definer");
    expect(lifecycleFunction).toContain(
      "v_trigger_depth integer := pg_catalog.pg_trigger_depth()",
    );
    expect(lifecycleFunction).toContain("v_trigger_depth <= 1 or exists (");
    expect(lifecycleFunction).toContain("from public.shared_awards award");
    expect(lifecycleFunction).toContain("'award_deleted'");
    expect(lifecycleFunction).toContain("v_trigger_depth > 1");
    expect(lifecycleFunction).toContain(
      "from public.shared_award_sources source",
    );
    expect(lifecycleFunction).toContain(
      "pg_catalog.to_jsonb(new) - 'updated_at' - 'shared_award_source_id'",
    );
    expect(lifecycleFunction).toContain("'source_deleted'");
    expect(lifecycleFunction).toContain(
      "public.stage1_publication_evidence_hash(v_snapshot)",
    );
    expect(lifecycleFunction).not.toContain("on conflict");
    expect(lifecycleFunction).not.toContain("current_setting");
    expect(lifecycleFunction).not.toContain("set_config");
  });

  it("keeps terminal archives append-only and inaccessible to direct service writes", () => {
    expect(migration).toContain(
      "alter table public.shared_award_fact_candidate_terminal_archive\n  enable row level security;",
    );
    expect(migration).toContain(
      "revoke all on table public.shared_award_fact_candidate_terminal_archive\n  from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "grant select on table public.shared_award_fact_candidate_terminal_archive\n  to service_role;",
    );
    expect(migration).toContain(
      "revoke truncate, trigger on table\n  public.shared_awards,\n  public.shared_award_sources,\n  public.shared_award_fact_candidates\nfrom service_role;",
    );
    expect(terminalArchiveMutationGuard).toContain(
      "Rejected-candidate lifecycle archives are append-only.",
    );
    expect(migration).toContain(
      "before update or delete on public.shared_award_fact_candidate_terminal_archive",
    );
    expect(migration).toMatch(
      /revoke all on function private\.prevent_terminal_candidate_archive_mutation\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.awardping_enforce_fact_candidate_status_lifecycle\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(databaseTypes).toContain(
      "shared_award_fact_candidate_terminal_archive: {",
    );
    expect(databaseTypes).toContain(
      'archive_contract: "rejected-candidate-fk-lifecycle-v1";',
    );
  });

  it("fences source and award deletes before parent rows can invert reconciliation lock order", () => {
    for (const [triggerName, tableName] of [
      ["stage1_candidate_parent_award_delete_release_fence", "shared_awards"],
      [
        "stage1_candidate_parent_source_delete_release_fence",
        "shared_award_sources",
      ],
    ]) {
      expect(migration).toContain(`create trigger ${triggerName}`);
      expect(migration).toContain(`before delete on public.${tableName}`);
    }
    expect(
      occurrences(
        migration,
        "execute function public.stage1_evidence_release_fence_before_statement();",
      ),
    ).toBeGreaterThanOrEqual(3);
  });

  it("uses updated_at as a database-managed CAS version without no-op churn", () => {
    expect(lifecycleFunction).toContain(
      "(pg_catalog.to_jsonb(new) - 'updated_at') is distinct from",
    );
    expect(lifecycleFunction).toContain(
      "(pg_catalog.to_jsonb(old) - 'updated_at')",
    );
    expect(lifecycleFunction).toContain("if v_material_changed then");
    expect(lifecycleFunction).toContain("new.updated_at := greatest(");
    expect(lifecycleFunction).toContain(
      "old.updated_at + interval '1 microsecond'",
    );
    expect(lifecycleFunction).toContain("new.updated_at := old.updated_at");
    expect(blockedFunction).toContain(
      "candidate.updated_at = mutation.expected_updated_at",
    );
  });

  it("centralizes exactly-once Stage 1 invalidation for terminal outcomes", () => {
    expect(stage1OutcomeHelper).toContain(
      "perform pg_catalog.pg_advisory_xact_lock(",
    );
    expect(stage1OutcomeHelper).toContain(
      "from public.stage1_award_members member",
    );
    expect(stage1OutcomeHelper).toContain(
      "registry.publication_state = 'verified_beta'",
    );
    expect(stage1OutcomeHelper).toMatch(
      /publication_state = 'revalidation_pending',\s+release_epoch = null,/,
    );
    expect(stage1OutcomeHelper).toContain(
      "insert into public.stage1_award_publication_events",
    );
    expect(stage1OutcomeHelper).toContain("from invalidated;");
    expect(stage1OutcomeHelper).toContain("if v_invalidated_count > 0 then");
    expect(stage1OutcomeHelper).toContain(
      "perform public.invalidate_stage1_cohort_release(v_reason, v_actor);",
    );
    expect(migration).toMatch(
      /revoke all on function private\.invalidate_stage1_reconciliation_outcome\([\s\S]+?\) from public, anon, authenticated, service_role;/,
    );

    const finishTerminalUpdate = finishFunction.indexOf(
      "status = p_terminal_status",
    );
    const finishInvalidation = finishFunction.indexOf(
      "private.invalidate_stage1_reconciliation_outcome",
    );
    const blockedQueueFailure = blockedFunction.indexOf("status = 'failed'");
    const blockedInvalidation = blockedFunction.indexOf(
      "private.invalidate_stage1_reconciliation_outcome",
    );
    expect(finishInvalidation).toBeGreaterThan(finishTerminalUpdate);
    expect(blockedInvalidation).toBeGreaterThan(blockedQueueFailure);
  });

  it("keeps both privileged RPCs service-role only", () => {
    expect(migration).toMatch(
      /revoke all on function public\.commit_award_reconciliation_blocked\([\s\S]+?\) from public, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.commit_award_reconciliation_blocked\([\s\S]+?\) to service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.finish_or_requeue_award_reconciliation_claim\([\s\S]+?\) from public, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.finish_or_requeue_award_reconciliation_claim\([\s\S]+?\) to service_role;/,
    );
  });

  it("checks both RPCs into the generated database contract", () => {
    expect(databaseTypes).toContain("commit_award_reconciliation_blocked: {");
    expect(databaseTypes).toContain(
      "finish_or_requeue_award_reconciliation_claim: {",
    );
    expect(databaseTypes).toContain(
      'p_terminal_status: "failed" | "skipped" | "pending";',
    );
    expect(databaseTypes).toMatch(
      /Returns:\s+\| Database\["public"\]\["Tables"\]\["shared_award_reconciliation_queue"\]\["Row"\]\s+\| null;/,
    );
  });
});

function section(value, start, end) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Missing section boundary: ${start} -> ${end}`);
  }
  return value.slice(startIndex, endIndex);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
