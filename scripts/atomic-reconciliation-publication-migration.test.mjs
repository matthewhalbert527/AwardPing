import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716221500_atomic_reconciliation_publication.sql",
    import.meta.url,
  ),
  "utf8",
);
const worker = readFileSync(
  new URL("./reconcile-impacted-award-pages.mjs", import.meta.url),
  "utf8",
);
const reconciliationLibrary = readFileSync(
  new URL("./lib/award-fact-reconciliation.mjs", import.meta.url),
  "utf8",
);

const atomicFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.commit_award_reconciliation_publication(",
  ),
  migration.indexOf(
    "revoke execute on function public.commit_award_reconciliation_publication(",
  ),
);
const publishBranch = worker.slice(
  worker.indexOf("if (shouldPublish)"),
  worker.indexOf("report.awards_publication_blocked += 1"),
);

describe("atomic reconciliation publication migration", () => {
  it("commits evidence, public facts, and queue success in one RPC", () => {
    expect(atomicFunction).toContain(
      "delete from public.stage1_award_reconciled_fact_evidence",
    );
    expect(atomicFunction).toContain(
      "insert into public.stage1_award_reconciled_fact_evidence",
    );
    expect(atomicFunction).toContain(
      "insert into public.shared_award_fact_candidates",
    );
    expect(atomicFunction).toContain(
      "update public.shared_award_fact_candidates candidate",
    );
    expect(atomicFunction).toContain(
      "insert into public.shared_award_page_audits",
    );
    expect(atomicFunction).toContain("update public.shared_awards award");
    expect(atomicFunction).toContain(
      "update public.shared_award_reconciliation_queue queue",
    );
    expect(atomicFunction).toContain("status = 'succeeded'");

    expect(worker).toContain(
      'supabase.rpc(\n    "commit_award_reconciliation_publication"',
    );
    expect(worker).not.toContain(
      '.from("stage1_award_reconciled_fact_evidence")',
    );
    expect(worker).not.toContain('status: "succeeded"');
    expect(worker).not.toContain("async function publishAwardFacts");
    expect(publishBranch).not.toContain(
      "persistPreparedGeneratedFactCandidates",
    );
    expect(publishBranch).not.toContain("persistAuditRow");
    expect(publishBranch).not.toContain("updateCandidateStatuses");
    expect(worker).toContain("p_generated_candidates: generatedCandidateRows");
    expect(worker).toContain(
      "p_candidate_status_updates: candidateStatusUpdates",
    );
    expect(worker).toContain("p_audit_row: auditRow");
    expect(worker).toContain(
      "Manual reconciliation could not acquire a durable queue identity.",
    );
  });

  it("locks both mutable records and rejects stale claims or award inputs", () => {
    expect(atomicFunction.match(/for update;/g)).toHaveLength(2);
    expect(atomicFunction).toContain(
      "pg_catalog.hashtextextended('stage1-national-25-release', 0)",
    );
    expect(atomicFunction).toContain(
      "registry.canonical_shared_award_id = p_shared_award_id",
    );
    expect(atomicFunction.indexOf("stage1-national-25-release")).toBeLessThan(
      atomicFunction.indexOf("for update;"),
    );
    expect(atomicFunction).toContain(
      "v_queue.started_at is distinct from p_expected_started_at",
    );
    expect(atomicFunction).toContain(
      "v_queue.generation is distinct from p_expected_queue_generation",
    );
    expect(atomicFunction).toContain(
      "requeued_after_trigger_during_processing",
    );
    expect(atomicFunction).toContain(
      "v_award.updated_at is distinct from p_expected_award_updated_at",
    );
    expect(atomicFunction).toContain(
      "v_award.public_facts is distinct from p_expected_public_facts",
    );
    expect(atomicFunction).toContain("errcode = '40001'");

    expect(worker).toContain("async function claimQueueRow(queueRow, startedAt)");
    expect(worker).toContain('.eq("status", queueRow.status)');
    expect(worker).toContain(
      "p_expected_queue_generation: queueRow.generation",
    );
    expect(worker).toContain("async function updateOwnedQueue(id, startedAt, patch)");
    expect(worker).toContain('.eq("started_at", startedAt)');
    expect(reconciliationLibrary).toContain(
      ".eq(\"generation\", currentGeneration)",
    );
    expect(reconciliationLibrary).toContain(
      "generation: currentGeneration + 1",
    );
    expect(reconciliationLibrary).toContain(
      ".eq(\"status\", existing.status)",
    );
  });

  it("binds the exact queue identities to exact published fact values", () => {
    expect(atomicFunction).toContain(
      "Queue success identities must exactly match reconciled fact evidence identities.",
    );
    expect(atomicFunction).toContain(
      "p_public_facts -> (evidence_row.value ->> 'field_name') is distinct from",
    );
    expect(atomicFunction).toContain(
      "candidate.shared_award_source_id = any(",
    );
    expect(atomicFunction).toContain(
      "candidate.candidate_status not in ('selected', 'conflicted')",
    );
    expect(atomicFunction).toContain(
      "Reconciled fact evidence field names must be unique.",
    );
    expect(atomicFunction).toContain(
      "Every non-empty publishable fact requires exact reconciled evidence in the same commit.",
    );
    expect(atomicFunction).toContain(
      "candidate_source.shared_award_id is distinct from candidate.shared_award_id",
    );
    expect(atomicFunction).toContain(
      "public.stage1_award_members target_member",
    );
    expect(atomicFunction).toContain(
      "'candidate_bindings',\n        candidate_identity.value,\n        'normalized_value'",
    );
    expect(atomicFunction).toContain("'contributes_to_field'");
    expect(atomicFunction).toContain("'selected_value'");
    expect(atomicFunction).toContain(
      "is distinct from evidence_row.value -> 'public_value'",
    );
    expect(worker).toContain("selected_value: publicValue");
    expect(worker).toContain("contributes_to_field: fieldName");
    expect(worker).toContain(
      "const shouldPublish = !amountPreservedForReview",
    );
    expect(worker).toContain("preserved_amount_requires_exact_evidence");
  });

  it("derives immutable hashes from the JSONB actually stored", () => {
    expect(atomicFunction).toContain(
      "public.stage1_publication_evidence_hash(evidence_row.value -> 'evidence')",
    );
    expect(worker).not.toContain(
      '.update(JSON.stringify(evidence))',
    );
    expect(worker).not.toContain("evidence_hash:");
  });

  it("exposes the definer function only to the service role", () => {
    expect(atomicFunction).toContain("security definer");
    expect(atomicFunction).toContain("set search_path = ''");
    expect(migration).toContain(
      ") from public, anon, authenticated;",
    );
    expect(migration).toContain(") to service_role;");
    expect(migration).not.toMatch(
      /grant execute on function public\.commit_award_reconciliation_publication\([\s\S]+?\) to (?:anon|authenticated|public);/i,
    );
  });
});
