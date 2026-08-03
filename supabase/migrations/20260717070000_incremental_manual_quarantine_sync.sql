-- Keep the recurring quarantine refresh comfortably below the Data API's
-- default timeout without weakening evidence or resolution semantics.
--
-- The original function aggregated every historical Gemini page-audit batch
-- and issued conflict updates for every open public-page and visual case, even
-- when the evidence hash and all operator-facing fields were unchanged. Those
-- no-op updates repeatedly rewrote large TOAST values and fired registry
-- triggers. Restrict the batch aggregate to request keys used by the latest
-- active-award audits and make both current-case upserts idempotent.

-- The remaining pending migration chain uses legacy SHA-256 helpers before the
-- reviewed-import migration installs the catalog-bound helper. Fail closed
-- unless the exact routine those helpers resolve is the pgcrypto extension
-- member owned by the extension owner, and remove the historical public-schema
-- function-planting privilege before any pending helper can run.
revoke create on schema public from public;

do $stage1_pgcrypto_guard$
declare
  v_extension_digest_oids oid[];
  v_extension_digest_oid oid;
  v_resolved_digest_oid oid;
begin
  select pg_catalog.array_agg(proc.oid order by proc.oid)
  into v_extension_digest_oids
  from pg_catalog.pg_extension ext
  join pg_catalog.pg_depend dep
    on dep.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    and dep.refobjid = ext.oid
    and dep.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    and dep.deptype = 'e'
  join pg_catalog.pg_proc proc
    on proc.oid = dep.objid
  join pg_catalog.pg_namespace namespace
    on namespace.oid = proc.pronamespace
  where ext.extname = 'pgcrypto'
    and proc.proname = 'digest'
    and proc.prokind = 'f'
    and proc.pronargs = 2
    and proc.proargtypes[0] = 'pg_catalog.bytea'::pg_catalog.regtype
    and proc.proargtypes[1] = 'pg_catalog.text'::pg_catalog.regtype
    and proc.prorettype = 'pg_catalog.bytea'::pg_catalog.regtype
    and proc.proowner = ext.extowner
    and namespace.nspname in ('extensions', 'public');

  if pg_catalog.cardinality(v_extension_digest_oids) is distinct from 1 then
    raise exception using
      errcode = '55000',
      message = 'The pending Stage 1 migration chain requires extension-owned pgcrypto digest(bytea,text) in extensions or public.';
  end if;
  v_extension_digest_oid := v_extension_digest_oids[1];

  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is not null then
    v_resolved_digest_oid :=
      pg_catalog.to_regprocedure('extensions.digest(bytea,text)')::oid;
  else
    v_resolved_digest_oid :=
      pg_catalog.to_regprocedure('public.digest(bytea,text)')::oid;
  end if;

  if v_resolved_digest_oid is distinct from v_extension_digest_oid then
    raise exception using
      errcode = '55000',
      message = 'The pending Stage 1 migration chain refused a non-extension digest(bytea,text) resolution.';
  end if;
end;
$stage1_pgcrypto_guard$;

create index if not exists shared_award_page_audits_batch_request_key_idx
  on public.shared_award_page_audits (
    gemini_batch_request_key,
    created_at,
    id
  )
  where audit_kind = 'gemini_batch'
    and gemini_batch_request_key is not null;

do $migration$
declare
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_rewritten text;
  v_batch_match_count integer;
  v_upsert_match_count integer;
  v_public_resolution_match_count integer;
  v_visual_resolution_match_count integer;
  v_old_batch text := $old$    from public.shared_award_page_audits attempt
    where attempt.audit_kind = 'gemini_batch'
      and attempt.gemini_batch_request_key is not null
    group by attempt.gemini_batch_request_key$old$;
  v_new_batch text := $new$    from public.shared_award_page_audits attempt
    join (
      select distinct latest.gemini_batch_request_key
      from latest_audit latest
      where latest.audit_kind = 'gemini_batch'
        and latest.gemini_batch_request_key is not null
    ) latest_request
      on latest_request.gemini_batch_request_key = attempt.gemini_batch_request_key
    where attempt.audit_kind = 'gemini_batch'
      and attempt.gemini_batch_request_key is not null
    group by attempt.gemini_batch_request_key$new$;
  v_old_upsert_tail text := $old$      resolved_at = null,
      resolved_by = null,
      resolution_note = null
    returning id$old$;
  v_new_upsert_tail text := $new$      resolved_at = null,
      resolved_by = null,
      resolution_note = null
    where public.manual_quarantine_registry.status = 'resolved'
       or public.manual_quarantine_registry.case_key is distinct from excluded.case_key
       or public.manual_quarantine_registry.classification is distinct from excluded.classification
       or public.manual_quarantine_registry.category is distinct from excluded.category
       or public.manual_quarantine_registry.requires_action is distinct from excluded.requires_action
       or public.manual_quarantine_registry.terminal is distinct from excluded.terminal
       or public.manual_quarantine_registry.terminal_failure_count is distinct from excluded.terminal_failure_count
       or public.manual_quarantine_registry.severity is distinct from excluded.severity
       or public.manual_quarantine_registry.public_impact is distinct from excluded.public_impact
       or public.manual_quarantine_registry.owner is distinct from excluded.owner
       or public.manual_quarantine_registry.retry_mode is distinct from excluded.retry_mode
       or public.manual_quarantine_registry.retry_charge is distinct from excluded.retry_charge
       or public.manual_quarantine_registry.title is distinct from excluded.title
       or public.manual_quarantine_registry.reason_code is distinct from excluded.reason_code
       or public.manual_quarantine_registry.reason is distinct from excluded.reason
       or public.manual_quarantine_registry.recommended_action is distinct from excluded.recommended_action
       or public.manual_quarantine_registry.policy_id is distinct from 'awardping-manual-quarantine'
       or public.manual_quarantine_registry.policy_version is distinct from '1'
       or public.manual_quarantine_registry.policy_hash is distinct from
         '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4'
       or public.manual_quarantine_registry.shared_award_id is distinct from excluded.shared_award_id
       or public.manual_quarantine_registry.primary_source_table is distinct from excluded.primary_source_table
       or public.manual_quarantine_registry.primary_source_record_id is distinct from excluded.primary_source_record_id
       or public.manual_quarantine_registry.evidence_record_count is distinct from excluded.evidence_record_count
       or public.manual_quarantine_registry.evidence_hash is distinct from excluded.evidence_hash
       or public.manual_quarantine_registry.first_observed_at is distinct from least(
         public.manual_quarantine_registry.first_observed_at,
         excluded.first_observed_at
       )
       or public.manual_quarantine_registry.last_observed_at is distinct from excluded.last_observed_at
       or public.manual_quarantine_registry.resolved_at is not null
       or public.manual_quarantine_registry.resolved_by is not null
       or public.manual_quarantine_registry.resolution_note is not null
    returning id$new$;
  v_old_public_resolution text := $old$    where registry.category = 'public_page'
      and registry.status in ('quarantined', 'in_review')$old$;
  v_new_public_resolution text := $new$    where registry.category = 'public_page'
      and registry.policy_id = 'awardping-manual-quarantine'
      and registry.status in ('quarantined', 'in_review')$new$;
  v_old_visual_resolution text := $old$    where registry.category = 'visual_review'
      and registry.status in ('quarantined', 'in_review')$old$;
  v_new_visual_resolution text := $new$    where registry.category = 'visual_review'
      and registry.policy_id = 'awardping-manual-quarantine'
      and registry.status in ('quarantined', 'in_review')$new$;
begin
  v_function := pg_catalog.to_regprocedure(
    'public.sync_manual_quarantine_registry()'
  );
  if v_function is null then
    raise exception
      'sync_manual_quarantine_registry() must exist before incremental optimization';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_batch_match_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_batch, ''))
  ) / pg_catalog.length(v_old_batch);
  if v_batch_match_count <> 1 then
    raise exception
      'Expected one full-history page-audit batch aggregate, found %.',
      v_batch_match_count;
  end if;

  v_rewritten := pg_catalog.replace(v_definition, v_old_batch, v_new_batch);
  v_upsert_match_count := (
    pg_catalog.length(v_rewritten)
    - pg_catalog.length(pg_catalog.replace(v_rewritten, v_old_upsert_tail, ''))
  ) / pg_catalog.length(v_old_upsert_tail);
  if v_upsert_match_count <> 2 then
    raise exception
      'Expected two non-incremental current-case upsert tails, found %.',
      v_upsert_match_count;
  end if;

  v_rewritten := pg_catalog.replace(
    v_rewritten,
    v_old_upsert_tail,
    v_new_upsert_tail
  );
  v_public_resolution_match_count := (
    pg_catalog.length(v_rewritten)
    - pg_catalog.length(pg_catalog.replace(
      v_rewritten,
      v_old_public_resolution,
      ''
    ))
  ) / pg_catalog.length(v_old_public_resolution);
  if v_public_resolution_match_count <> 1 then
    raise exception
      'Expected one generic public-page resolution scope, found %.',
      v_public_resolution_match_count;
  end if;
  v_rewritten := pg_catalog.replace(
    v_rewritten,
    v_old_public_resolution,
    v_new_public_resolution
  );

  v_visual_resolution_match_count := (
    pg_catalog.length(v_rewritten)
    - pg_catalog.length(pg_catalog.replace(
      v_rewritten,
      v_old_visual_resolution,
      ''
    ))
  ) / pg_catalog.length(v_old_visual_resolution);
  if v_visual_resolution_match_count <> 1 then
    raise exception
      'Expected one generic visual-review resolution scope, found %.',
      v_visual_resolution_match_count;
  end if;
  v_rewritten := pg_catalog.replace(
    v_rewritten,
    v_old_visual_resolution,
    v_new_visual_resolution
  );
  execute v_rewritten;
end;
$migration$;

-- Supabase's Data API defaults service-role RPCs to the authenticator role's
-- eight-second timeout. This recurring, bounded maintenance function gets a
-- function-only exemption; the lane's independent three-minute child budget
-- remains the outer kill switch.
alter function public.sync_manual_quarantine_registry()
  set statement_timeout to '60s';

-- The operator-backlog revision trigger was originally statement-level across
-- INSERT/UPDATE/DELETE. PostgreSQL fires statement triggers even when an
-- idempotent ON CONFLICT ... DO UPDATE WHERE clause affects zero rows, so an
-- otherwise unchanged sync still advanced the operator cursor. Transition
-- tables preserve statement-level batching while proving that at least one row
-- actually changed before advancing the revision.
create or replace function public.bump_manual_quarantine_backlog_for_changed_registry_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from changed_manual_quarantine_registry_rows
  ) then
    return null;
  end if;

  insert into public.manual_quarantine_backlog_state as state (
    state_key,
    revision,
    updated_at
  ) values (
    'operator_backlog',
    1,
    pg_catalog.clock_timestamp()
  )
  on conflict (state_key) do update set
    revision = state.revision + 1,
    updated_at = excluded.updated_at;
  return null;
end;
$$;

revoke all on function public.bump_manual_quarantine_backlog_for_changed_registry_rows()
  from public, anon, authenticated, service_role;

drop trigger if exists bump_manual_quarantine_backlog_after_registry_mutation
  on public.manual_quarantine_registry;
drop trigger if exists bump_manual_quarantine_backlog_after_registry_insert
  on public.manual_quarantine_registry;
drop trigger if exists bump_manual_quarantine_backlog_after_registry_update
  on public.manual_quarantine_registry;
drop trigger if exists bump_manual_quarantine_backlog_after_registry_delete
  on public.manual_quarantine_registry;

create trigger bump_manual_quarantine_backlog_after_registry_insert
after insert on public.manual_quarantine_registry
referencing new table as changed_manual_quarantine_registry_rows
for each statement execute function
  public.bump_manual_quarantine_backlog_for_changed_registry_rows();

create trigger bump_manual_quarantine_backlog_after_registry_update
after update on public.manual_quarantine_registry
referencing new table as changed_manual_quarantine_registry_rows
for each statement execute function
  public.bump_manual_quarantine_backlog_for_changed_registry_rows();

create trigger bump_manual_quarantine_backlog_after_registry_delete
after delete on public.manual_quarantine_registry
referencing old table as changed_manual_quarantine_registry_rows
for each statement execute function
  public.bump_manual_quarantine_backlog_for_changed_registry_rows();
