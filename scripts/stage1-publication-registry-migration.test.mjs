import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716204011_stage1_publication_registry.sql",
    import.meta.url,
  ),
  "utf8",
);
const publicationLoader = readFileSync(
  new URL("../src/lib/stage1-publication.ts", import.meta.url),
  "utf8",
);
const adminGateLoader = readFileSync(
  new URL("../src/lib/admin-stage1-release-gate.ts", import.meta.url),
  "utf8",
);

const manifestFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.set_stage1_award_manifest_entry(",
  ),
  migration.indexOf(
    "revoke all on function public.set_stage1_award_manifest_entry(",
  ),
);

const transitionFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.transition_stage1_award_publication(",
  ),
  migration.indexOf(
    "revoke all on function public.transition_stage1_award_publication(",
  ),
);

const expectedCohort = [
  "Rhodes Scholarship (United States)",
  "Marshall Scholarship",
  "Fulbright U.S. Student Program",
  "Gates Cambridge Scholarship",
  "Churchill Scholarship",
  "Schwarzman Scholars",
  "Knight-Hennessy Scholars",
  "Yenching Academy",
  "Luce Scholars Program",
  "Harry S. Truman Scholarship",
  "Barry Goldwater Scholarship",
  "Udall Undergraduate Scholarship",
  "Beinecke Scholarship",
  "Benjamin A. Gilman International Scholarship",
  "Boren Scholarships and Fellowships",
  "Critical Language Scholarship Program",
  "NSF Graduate Research Fellowship Program",
  "Hertz Fellowship",
  "National Defense Science and Engineering Graduate Fellowship",
  "SMART Scholarship-for-Service Program",
  "GEM Fellowship",
  "NOAA Ernest F. Hollings Undergraduate Scholarship",
  "Paul & Daisy Soros Fellowships for New Americans",
  "Samvid Scholars",
  "James C. Gaither Junior Fellows Program",
];

describe("Stage 1 publication registry migration", () => {
  it("defines exactly the intended 25-award public cohort", () => {
    expect(expectedCohort).toHaveLength(25);
    for (const [index, name] of expectedCohort.entries()) {
      expect(migration, name).toContain(`(${index + 1},`);
      expect(migration, name).toContain(`'${name.replaceAll("'", "''")}'`);
    }

    expect(migration).toContain("v_registry_count <> 25");
    expect(migration).toContain("v_canonical_member_count <> 25");
    expect(migration).toContain("v_alias_member_count <> 25");
    expect(migration).not.toContain("marshall sherfield fellowship");
    expect(migration).toContain("'udall scholarship'");
    expect(migration).toContain("'gem national consortium'");
    expect(migration).toContain("'smart scholarship for service program'");
    expect(migration).toContain("create temporary table stage1_cohort_seed");
    expect(migration).toContain("insert into public.shared_awards (");
    expect(migration).toContain("on conflict (id) do update");
    expect(migration).toContain("on conflict (search_key) do nothing");
  });

  it("fails closed until an award is explicitly verified", () => {
    expect(migration).toContain(
      "publication_state text not null default 'pending'",
    );
    expect(migration).toContain("'verified_beta'");
    expect(migration).toContain("'revalidation_pending'");
    expect(migration).toContain("'suspended'");
    expect(migration).toContain(
      "state_reason text not null default 'Awaiting verified Stage 1 evidence.'",
    );
    expect(migration).not.toMatch(
      /set\s+publication_state\s*=\s*'verified_beta'/,
    );
    expect(migration).not.toContain("then 'verified_beta'");
  });

  it("keeps the registry and evidence service-only behind RLS", () => {
    for (const table of [
      "stage1_award_registry",
      "stage1_publication_release_state",
      "stage1_publication_release_events",
      "stage1_award_members",
      "stage1_award_source_manifest",
      "stage1_award_publication_events",
      "stage1_award_reconciled_fact_evidence",
      "stage1_award_fact_publication_ledger",
    ]) {
      expect(migration).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(migration).toContain(`revoke all on table public.${table}`);
    }

    expect(migration).not.toMatch(
      /grant\s+(?:all|insert|update|delete)[^;]+stage1_award_(?:registry|members|source_manifest|publication_events)/i,
    );
    expect(migration).toContain(
      "grant select on table public.stage1_award_registry to service_role;",
    );
  });

  it("requires all eight source roles with fresh immutable evidence", () => {
    for (const role of [
      "identity_home",
      "eligibility",
      "application_materials",
      "dates_cycle",
      "funding",
      "faq",
      "selection_interviews",
      "current_documents",
    ]) {
      expect(migration, role).toContain(`'${role}'`);
    }

    expect(manifestFunction).toContain("p_checked_at < now() - interval '24 hours'");
    expect(migration).toContain(
      "p_evidence #> array['source_bindings', source_id::text, 'r2_hashes']",
    );
    expect(migration).toContain(
      "p_evidence #> array['source_bindings', source_id::text, 'local_hashes']",
    );
    expect(migration).toContain(
      "p_evidence #>> array['source_bindings', source_id::text, 'source_url']",
    );
    expect(migration).toContain(
      "is distinct from snapshot.latest_object_keys",
    );
    expect(migration).toContain(
      "is distinct from snapshot.latest_hashes",
    );
    expect(manifestFunction).toContain("source.admin_review_status <> 'open'");
    expect(manifestFunction).toContain(
      "nullif(pg_catalog.btrim(source.last_error), '') is not null",
    );
    expect(transitionFunction).toContain(") <> 8 then");
  });

  it("blocks publication on quarantine, audit, or reconciliation failures", () => {
    expect(transitionFunction).toContain(
      "quarantine.classification = 'actionable_quarantine'",
    );
    expect(transitionFunction).toContain(
      "quarantine.status in ('quarantined', 'in_review')",
    );
    expect(transitionFunction).toContain(
      "audit.audit_status in ('failed', 'needs_review')",
    );
    expect(transitionFunction).toContain("audit.severity = 'critical'");
    expect(transitionFunction).toContain(
      "v_reconciliation ->> 'status' <> 'succeeded'",
    );
    expect(transitionFunction).toContain(
      "v_page_audit ->> 'audit_status' <> 'passed'",
    );
    expect(transitionFunction).toContain("interval '24 hours'");
  });

  it("records immutable transition evidence with the real previous state", () => {
    expect(transitionFunction).toContain(
      "v_previous_state := v_registry.publication_state;",
    );
    expect(transitionFunction).toContain(
      "public.stage1_publication_evidence_hash(coalesce(v_evidence, '{}'::jsonb))",
    );
    expect(transitionFunction).toContain(
      "v_previous_state,\n    p_next_state,",
    );
    expect(transitionFunction).not.toContain(
      "v_registry.publication_state,\n    p_next_state,",
    );
  });

  it("maps known duplicates without collapsing retained evidence", () => {
    for (const alias of [
      "knight-hennessy scholars program",
      "gilman scholarship",
      "boren awards for international study",
      "critical language scholarships program",
      "national gem consortium - master's engineering and science fellowship",
      "hollings scholarship",
      "carnegie junior fellowship",
    ]) {
      expect(migration, alias).toContain(alias.replaceAll("'", "''"));
    }

    expect(migration).not.toMatch(/delete\s+from\s+public\.shared_awards/i);
    expect(migration).not.toMatch(/update\s+public\.shared_award_sources/i);
  });

  it("hard-excludes sibling programs and denies direct catalog reads", () => {
    expect(migration).toContain("exclude_marshall_sherfield");
    expect(migration).toContain(
      "(?:^|/)marshall-sherfield(?:/|$)|/media/[0-9]+/msf_",
    );
    expect(migration).toContain("sherfield|postdoctoral|\\mmsf\\M");
    expect(manifestFunction).toContain(
      "public.stage1_award_source_identity_rules identity_rule",
    );

    for (const table of [
      "shared_awards",
      "shared_award_sources",
      "shared_award_source_snapshots",
      "shared_award_change_events",
      "shared_award_slug_aliases",
    ]) {
      expect(migration).toContain(
        `revoke all on table public.${table} from anon, authenticated;`,
      );
    }
    for (const table of [
      "shared_award_update_read_baselines",
      "shared_award_change_reads",
    ]) {
      expect(migration).toContain(
        `revoke all on table public.${table} from authenticated;`,
      );
    }
  });

  it("re-evaluates live blockers instead of trusting a stale state label", () => {
    expect(migration).toContain(
      "create or replace function public.stage1_effective_publication_reason(",
    );
    expect(migration).toContain(
      "create or replace function public.list_stage1_effective_publication()",
    );
    expect(migration).toContain("return 'canonical_reconciliation_not_fresh_success';");
    expect(migration).toContain("return 'canonical_page_audit_not_fresh_pass';");
    expect(migration).toContain("return 'actionable_quarantine_open';");
    expect(migration).toContain("return 'source_or_snapshot_identity_invalid';");
    expect(migration).toContain("return 'fact_ledger_binding_invalid';");
    expect(migration).toContain(
      "release_decision.decision_reason = 'verified' as effectively_verified",
    );
    expect(migration).toContain(
      "create or replace function public.get_stage1_publication_snapshot()",
    );
    expect(migration).toContain("'allowed_source_ids'");
    expect(migration).toContain("'published_facts'");
    expect(publicationLoader).toContain(
      'admin.rpc("get_stage1_publication_snapshot")',
    );
    expect(publicationLoader).not.toContain('.from("stage1_award_registry")');
    expect(migration).toContain(
      "create or replace function public.invalidate_stage1_publication_on_evidence_change()",
    );
    for (const trigger of [
      "stage1_members_invalidate_publication",
      "stage1_manifest_invalidate_publication",
      "stage1_identity_rules_invalidate_publication",
    ]) {
      expect(migration).toContain(`create trigger ${trigger}`);
    }
    expect(migration).toContain("publication_state = 'revalidation_pending'");
    expect(migration).toContain("'database-trigger'");
    expect(migration).toContain("get diagnostics v_invalidated_count = row_count;");
    expect(migration).toContain("if v_invalidated_count > 0 then");
  });

  it("publishes the reviewed 25 only under one atomic cohort release epoch", () => {
    expect(migration).toContain("release_epoch uuid");
    expect(migration).toContain(
      "create table if not exists public.stage1_publication_release_state (",
    );
    expect(migration).toContain(
      "create or replace function public.transition_stage1_cohort_release(",
    );
    expect(migration).toContain("if v_ready_count <> 25 then");
    expect(migration).toContain("set release_epoch = v_epoch");
    expect(migration).toContain("if v_updated_count <> 25 then");
    expect(migration).toContain("'cohort_release_epoch_mismatch'");
    expect(migration).toContain(
      "perform public.invalidate_stage1_cohort_release(",
    );
    expect(migration).toContain("'schema_version', 3");
    expect(publicationLoader).toContain("schema_version: z.literal(3)");
    expect(adminGateLoader).toContain("snapshot.schema_version !== 3");
  });

  it("fails the admin gate closed on missing invite/free-check contracts or reissues", () => {
    expect(adminGateLoader).toContain(
      'admin.rpc("get_awardping_release_contract_status")',
    );
    expect(adminGateLoader).toContain('"awardping-release-contract-v1"');
    expect(adminGateLoader).toContain(
      'admin.rpc("get_office_invite_security_reissue_status")',
    );
    expect(adminGateLoader).toContain("contract.requirement_count !== 16");
  });

  it("binds identity_home to the exact reviewed registry homepage", () => {
    expect(manifestFunction).toContain("p_source_role = 'identity_home'");
    expect(manifestFunction).toContain("cardinality(v_source_ids) <> 1");
    expect(manifestFunction).toContain(
      "source.url = registry.official_homepage",
    );
    expect(manifestFunction).toContain(
      "p_evidence ->> 'source_url' = registry.official_homepage",
    );
    expect(transitionFunction).toContain(
      "message = 'The identity_home manifest does not exactly bind the reviewed registry homepage.'",
    );
    expect(migration).toContain("return 'identity_home_not_allowlisted';");
    expect(migration).toContain("'reviewed_homepage'");
  });

  it("binds every non-empty public fact field to immutable reconciled contributor evidence", () => {
    expect(migration).toContain(
      "create table if not exists public.stage1_award_reconciled_fact_evidence (",
    );
    expect(migration).toContain(
      "create table if not exists public.stage1_award_fact_publication_ledger (",
    );
    expect(transitionFunction).toContain("v_ledger_batch_id := gen_random_uuid();");
    expect(transitionFunction).toContain(
      "materialization.public_value = fact.value",
    );
    expect(transitionFunction).toContain(
      "(v_reconciliation -> 'candidate_ids') ? candidate.id::text",
    );
    expect(transitionFunction).toContain(
      "(v_reconciliation -> 'source_ids') ? candidate.shared_award_source_id::text",
    );
    expect(transitionFunction).toContain(
      "v_page_audit -> 'public_page_snapshot' -> fact.key = fact.value",
    );
    expect(transitionFunction).toContain(
      "(manifest.evidence -> 'fact_candidate_ids') ? candidate.id::text",
    );
    expect(transitionFunction).toContain(
      "if v_ledger_count <> v_public_fact_count then",
    );
    expect(transitionFunction).toContain(
      "fact_ledger_batch_id = case",
    );
    expect(migration).toContain(
      "award.public_facts -> ledger.field_name is distinct from ledger.public_value",
    );
    expect(transitionFunction).toContain(
      "materialization.evidence_hash =\n        public.stage1_publication_evidence_hash(materialization.evidence)",
    );
    expect(transitionFunction).toContain("materialization.candidate_ids");
    expect(transitionFunction).toContain("materialization.source_ids");
    for (const field of [
      "source_url text not null",
      "supporting_text text not null",
      "source_snapshot_hashes jsonb not null",
      "source_captured_at timestamptz not null",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain(
      "revoke all on table public.stage1_award_fact_publication_ledger",
    );
  });
});
