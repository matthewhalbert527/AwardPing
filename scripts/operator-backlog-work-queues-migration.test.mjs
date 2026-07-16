import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716102555_operator_backlog_work_queues.sql",
    import.meta.url,
  ),
  "utf8",
);
const databaseTypes = readFileSync(
  new URL("../src/lib/database.types.ts", import.meta.url),
  "utf8",
);

const listFunction = between(
  "create or replace function public.list_manual_quarantine_backlog(",
  "revoke all on function public.list_manual_quarantine_backlog(",
);
const bulkFunction = between(
  "create or replace function public.apply_manual_quarantine_bulk_action(",
  "revoke all on function public.apply_manual_quarantine_bulk_action(",
);
const saveViewFunction = between(
  "create or replace function public.save_manual_quarantine_saved_view(",
  "revoke all on function public.save_manual_quarantine_saved_view(",
);
const deleteViewFunction = between(
  "create or replace function public.delete_manual_quarantine_saved_view(",
  "revoke all on function public.delete_manual_quarantine_saved_view(",
);
const orphanReturnTriggerFunction = between(
  "create or replace function public.return_unowned_manual_quarantine_to_queue()",
  "revoke all on function public.return_unowned_manual_quarantine_to_queue()",
);
const revisionBumpTriggerFunction = between(
  "create or replace function public.bump_manual_quarantine_backlog_revision()",
  "revoke all on function public.bump_manual_quarantine_backlog_revision()",
);
const assignmentTypes = betweenText(
  databaseTypes,
  "      manual_quarantine_operator_assignments: {",
  "      manual_quarantine_saved_views: {",
);
const actionEventTypes = betweenText(
  databaseTypes,
  "      manual_quarantine_operator_action_events: {",
  "      manual_quarantine_backlog_state: {",
);
const backlogStateTypes = betweenText(
  databaseTypes,
  "      manual_quarantine_backlog_state: {",
  "      monitoring_policy_sweep_state: {",
);

describe("operator backlog work queues migration", () => {
  it("keeps ownership, saved views, and action history service-role-only", () => {
    for (const table of [
      "manual_quarantine_operator_assignments",
      "manual_quarantine_saved_views",
      "manual_quarantine_operator_action_events",
      "manual_quarantine_backlog_state",
    ]) {
      expect(migration).toContain(`create table public.${table} (`);
      expect(migration).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(migration).toMatch(
        new RegExp(
          `revoke all on table public\\.${table}\\s+from public, anon, authenticated, service_role;`,
        ),
      );
    }

    expect(migration).not.toMatch(/grant all on table public\.manual_quarantine_/);
    expect(migration).toContain(
      "grant select, insert on table public.manual_quarantine_operator_action_events",
    );
    expect(migration).not.toContain(
      "grant select, insert, update, delete\n  on table public.manual_quarantine_operator_action_events",
    );
    expect(migration).toContain(
      "revoke all on sequence public.manual_quarantine_operator_action_events_id_seq",
    );
    expect(migration).toContain(
      "grant usage, select on sequence public.manual_quarantine_operator_action_events_id_seq",
    );
    expect(migration).toContain(
      "grant select on table public.manual_quarantine_backlog_state to service_role;",
    );
    expect(migration).not.toMatch(
      /grant [^;]*(?:insert|update|delete)[^;]*manual_quarantine_backlog_state/,
    );
    expect(migration).toMatch(
      /jsonb_typeof\(metadata\) = 'object'[\s\S]*?octet_length\(metadata::text\) <= 65536/,
    );
    expect(migration.match(/security definer/g)).toHaveLength(2);
    expect(revisionBumpTriggerFunction).toContain("security definer");
    expect(revisionBumpTriggerFunction).toContain("set search_path = ''");
    expect(revisionBumpTriggerFunction).toContain(
      "insert into public.manual_quarantine_backlog_state as state",
    );
    expect(revisionBumpTriggerFunction).toContain("revision = state.revision + 1");
    expect(revisionBumpTriggerFunction).not.toMatch(/execute\s|format\s*\(/);
    expect(orphanReturnTriggerFunction).toContain("security definer");
    expect(orphanReturnTriggerFunction).toContain("set search_path = ''");
    expect(orphanReturnTriggerFunction).toContain(
      "update public.manual_quarantine_registry registry",
    );
    expect(orphanReturnTriggerFunction).not.toMatch(/execute\s|format\s*\(/);
    expect(migration).toMatch(
      /revoke all on function public\.return_unowned_manual_quarantine_to_queue\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.bump_manual_quarantine_backlog_revision\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration.match(/security invoker/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("binds durable ownership to auth users and indexes every new foreign key", () => {
    expect(migration).toContain(
      "assigned_to_user_id uuid not null references auth.users(id) on delete cascade",
    );
    expect(migration).toContain(
      "assigned_by_user_id uuid references auth.users(id) on delete set null",
    );
    expect(migration).toContain(
      "user_id uuid not null references auth.users(id) on delete cascade",
    );
    expect(migration).toContain(
      "actor_user_id uuid references auth.users(id) on delete set null",
    );
    for (const index of [
      "manual_quarantine_operator_assignments_assigned_user_idx",
      "manual_quarantine_operator_assignments_assigned_by_idx",
      "manual_quarantine_saved_views_user_idx",
      "manual_quarantine_operator_action_events_actor_idx",
      "manual_quarantine_operator_action_events_case_idx",
    ]) {
      expect(migration).toContain(`create index ${index}`);
    }
    expect(migration).toContain("unique (user_id, name_key)");
    expect(migration).toContain("unique (request_id, quarantine_id)");
    expect(migration).toMatch(
      /create trigger return_unowned_manual_quarantine_to_queue\s+after delete on public\.manual_quarantine_operator_assignments\s+for each row execute function public\.return_unowned_manual_quarantine_to_queue\(\);/,
    );
    expect(orphanReturnTriggerFunction).toMatch(
      /set status = 'quarantined'[\s\S]*?registry\.status = 'in_review'/,
    );
  });

  it("computes authoritative totals and clusters before applying bounded pagination", () => {
    const totalsAt = listFunction.indexOf("totals as (");
    const orderedItemsAt = listFunction.indexOf("ordered_items as (");
    const groupedAt = listFunction.indexOf("grouped as (");
    const itemOffsetAt = listFunction.indexOf("offset (");

    expect(totalsAt).toBeGreaterThan(0);
    expect(orderedItemsAt).toBeGreaterThan(totalsAt);
    expect(groupedAt).toBeGreaterThan(orderedItemsAt);
    expect(itemOffsetAt).toBeGreaterThan(totalsAt);
    expect(listFunction).toContain("count(*)::bigint as exact_total");
    expect(listFunction).toContain(
      "'unfiltered_exact_total', (select count(*)::bigint from labeled)",
    );
    expect(listFunction).toContain(
      "v_registry_state_total = (select count(*)::bigint from labeled)",
    );
    expect(listFunction).toContain("count(*)::bigint as exact_cluster_total");
    expect(
      listFunction.match(
        /order by\s+cases desc,\s+oldest_observed_at asc,\s+cluster_label asc,\s+cluster_key asc/g,
      ),
    ).toHaveLength(2);
    expect(listFunction).toContain("registry.requires_action");
    expect(listFunction).toContain(
      "registry.status in ('quarantined', 'in_review')",
    );
    expect(listFunction).toContain("p_expected_synced_at");
    expect(listFunction).toContain("p_expected_revision bigint default null");
    expect(listFunction).toContain("p_as_of_at timestamptz default null");
    expect(listFunction).toContain(
      "v_as_of_at timestamptz := coalesce(p_as_of_at, v_now)",
    );
    expect(listFunction).toContain("pg_catalog.isfinite(v_as_of_at)");
    expect(listFunction).toContain(
      "from public.manual_quarantine_backlog_state state",
    );
    expect(listFunction).toContain(
      "v_backlog_revision is distinct from p_expected_revision",
    );
    expect(listFunction).toContain("'backlog_revision', v_backlog_revision");
    expect(listFunction).toContain("'as_of_at', v_as_of_at");
    expect(listFunction).toContain(
      "v_as_of_at - registry.first_observed_at",
    );
    expect(listFunction).not.toContain(
      "v_now - registry.first_observed_at",
    );
    expect(listFunction).toContain("errcode = '40001'");
    expect(listFunction).toContain(
      "Manual-quarantine filters accept at most 20 values per facet.",
    );
    expect(listFunction).toMatch(
      /greatest\([\s\S]*?cardinality\(p_owners\)[\s\S]*?cardinality\(p_statuses\)[\s\S]*?\) > 20/,
    );
    expect(listFunction).toContain(
      "Manual-quarantine search is limited to 160 characters.",
    );
    for (const table of [
      "manual_quarantine_operator_assignments",
      "manual_quarantine_registry",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create trigger bump_manual_quarantine_backlog_after_(?:assignment|registry)_mutation\\s+after insert or update or delete on public\\.${table}\\s+for each statement execute function public\\.bump_manual_quarantine_backlog_revision\\(\\);`,
        ),
      );
    }
    expect(migration).toMatch(
      /create trigger bump_manual_quarantine_backlog_after_source_join_update\s+after update of url\s+on public\.shared_award_sources\s+for each statement execute function public\.bump_manual_quarantine_backlog_revision\(\);/,
    );
    expect(migration).toMatch(
      /create trigger bump_manual_quarantine_backlog_after_candidate_source_update\s+after update of source_url\s+on public\.shared_award_visual_review_candidates\s+for each statement execute function public\.bump_manual_quarantine_backlog_revision\(\);/,
    );
    expect(migration).toMatch(
      /create trigger bump_manual_quarantine_backlog_after_award_join_update\s+after update of name, slug, official_homepage\s+on public\.shared_awards\s+for each statement execute function public\.bump_manual_quarantine_backlog_revision\(\);/,
    );
  });

  it("derives honest source-domain, failure, policy, repair, age, and owner facets", () => {
    expect(migration).toContain("create or replace function public.manual_quarantine_source_domain");
    expect(migration).toContain("pg_catalog.split_part(value, '/', 1)");
    expect(migration).toContain(
      "pg_catalog.regexp_replace(value, '^//', '') as value",
    );
    expect(migration).toMatch(
      /pg_catalog\.split_part\([\s\S]*?'#',\s*1\s*\) as value/,
    );
    expect(migration).toContain("'^www\\.'");
    expect(listFunction).not.toContain("registry.evidence #>> '{source,url}'");
    expect(listFunction).not.toContain("registry.evidence ->> 'source_url'");
    expect(listFunction).toContain(
      "left join public.shared_award_visual_review_candidates visual_candidate",
    );
    expect(listFunction).toContain("nullif(visual_candidate.source_url, '')");
    expect(listFunction).toMatch(
      /when nullif\(visual_candidate\.source_url, ''\) is not null\s+then 'event_specific_source'/,
    );
    expect(listFunction).toMatch(
      /when nullif\(source\.url, ''\) is not null then 'current_source'/,
    );
    expect(listFunction).toContain("registry.evidence #>> '{award,official_homepage}'");
    expect(listFunction).toContain("award.official_homepage");
    for (const grouping of [
      "repair_group",
      "domain",
      "evidence_failure",
      "policy_reason",
      "likely_repair",
    ]) {
      expect(listFunction).toContain(`'${grouping}'`);
    }
    for (const facet of [
      "domain_facets as (",
      "evidence_facets as (",
      "policy_facets as (",
      "repair_facets as (",
      "owner_facets as (",
      "status_facets as (",
      "age_facets as (",
    ]) {
      expect(listFunction).toContain(facet);
    }
    for (const evidenceField of [
      "'evidence_hash', evidence_hash",
      "'policy_id', policy_id",
      "'policy_version', policy_version",
      "'policy_hash', policy_hash",
    ]) {
      expect(listFunction).toContain(evidenceField);
    }
  });

  it("makes bulk actions atomic, stale-safe, idempotent, and unable to retry or resolve", () => {
    expect(bulkFunction).toContain(
      "p_action not in ('assign_to_me', 'unassign', 'start_review')",
    );
    expect(bulkFunction).toContain("cardinality(v_ids) > 100");
    expect(bulkFunction).toContain(
      "pg_catalog.octet_length(p_cases::text) > 262144",
    );
    expect(bulkFunction).toContain(
      "Duplicate quarantine case IDs are not allowed.",
    );
    expect(bulkFunction).toContain("registry.evidence_hash = selected.evidence_hash");
    expect(bulkFunction).toContain("registry.status = selected.status");
    expect(bulkFunction).toContain(
      "coalesce(assignment.assigned_to_email, '') =",
    );
    expect(bulkFunction).toContain(
      "Assign every selected case to yourself before starting review.",
    );
    expect(bulkFunction).toContain(
      "assignment.assigned_to_user_id = p_actor_user_id",
    );
    expect(bulkFunction).toContain(
      "The auth UUID is the ownership authority.",
    );
    expect(bulkFunction).toMatch(
      /if v_previous_status = 'in_review' then\s+v_next_status := 'quarantined';/,
    );
    expect(bulkFunction).toMatch(
      /set status = 'quarantined'\s+where registry\.id = v_row\.id and registry\.status = 'in_review'/,
    );
    expect(listFunction).toMatch(
      /'start_review',\s*status = 'quarantined' and assigned_to_user_id is not null/,
    );
    expect(bulkFunction).toContain("order by registry.id");
    expect(bulkFunction).toContain("for update of registry");
    expect(bulkFunction).toContain("where event.request_id = p_request_id");
    expect(bulkFunction).toContain("'replayed', true");
    expect(bulkFunction).toContain("if v_row_changed then\n        insert into public.manual_quarantine_operator_assignments");
    expect(bulkFunction).toContain("'creates_api_charge', false");
    expect(bulkFunction).toContain("'can_retry', false");
    expect(bulkFunction).toContain("'can_resolve', false");
    expect(bulkFunction).not.toMatch(/p_action\s*=\s*'(retry|resolve|delete)'/);
  });

  it("scopes saved-view mutations to the authenticated operator identity supplied by the admin route", () => {
    expect(saveViewFunction).toContain("where saved.id = p_view_id and saved.user_id = p_user_id");
    expect(saveViewFunction).not.toContain(
      "on conflict (user_id, name_key) do update",
    );
    expect(saveViewFunction).toContain(
      "insert into public.manual_quarantine_saved_views",
    );
    expect(saveViewFunction).toContain("Saved-view filters are too large.");
    expect(saveViewFunction).toContain("p_page_size not between 10 and 100");
    expect(deleteViewFunction).toContain(
      "where saved.id = p_view_id and saved.user_id = p_user_id",
    );
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it("keeps the handwritten database contract aligned with auth-user deletion behavior", () => {
    for (const typeName of [
      "ManualQuarantineOpenStatus",
      "ManualQuarantineOperatorAction",
      "ManualQuarantineBacklogGroupBy",
      "ManualQuarantineBacklogSort",
      "ManualQuarantineBacklogAgeBucket",
    ]) {
      expect(databaseTypes).toContain(`export type ${typeName}`);
    }
    expect(assignmentTypes).toMatch(
      /Row: \{[\s\S]*?assigned_to_user_id: string;/,
    );
    expect(assignmentTypes).toMatch(
      /Insert: \{[\s\S]*?assigned_to_user_id: string;/,
    );
    expect(assignmentTypes).toMatch(
      /Insert: \{[\s\S]*?assigned_by_user_id\?: string \| null;/,
    );
    expect(assignmentTypes).toMatch(
      /Update: \{[\s\S]*?assigned_to_user_id\?: string;/,
    );
    expect(actionEventTypes).toMatch(
      /Row: \{[\s\S]*?actor_user_id: string \| null;/,
    );
    expect(actionEventTypes).toMatch(
      /Insert: \{[\s\S]*?actor_user_id\?: string \| null;/,
    );
    expect(actionEventTypes).toContain(
      "action: ManualQuarantineOperatorAction;",
    );
    expect(actionEventTypes).toContain(
      "previous_status: ManualQuarantineOpenStatus;",
    );
    expect(databaseTypes).toContain(
      "p_statuses?: ManualQuarantineOpenStatus[] | null;",
    );
    expect(databaseTypes).toContain(
      "p_action: ManualQuarantineOperatorAction;",
    );
    expect(databaseTypes).toContain("p_expected_revision?: number | null;");
    expect(databaseTypes).toContain("p_as_of_at?: string | null;");
    expect(backlogStateTypes).toContain('state_key: "operator_backlog";');
    expect(backlogStateTypes).toContain("revision: number;");
  });
});

function between(start, end) {
  return betweenText(migration, start, end);
}

function betweenText(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) {
    throw new Error(`Could not locate static section: ${start} ... ${end}`);
  }
  return source.slice(startAt, endAt);
}
