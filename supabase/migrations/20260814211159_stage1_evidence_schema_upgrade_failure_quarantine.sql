-- Durable, zero-charge failure quarantine for the isolated Stage 1
-- evidence-schema upgrade. This mutation is intentionally separate from the
-- original first-baseline activation failure path: every call must bind to an
-- already-finalized reviewed-nine source and carry the complete sealed upgrade
-- evidence available at the point of failure.

revoke create on schema public from public;

create table private.stage1_evidence_schema_upgrade_failures (
  failure_sha256 text primary key,
  submitted_evidence_sha256 text not null unique,
  shared_award_source_id uuid not null references
    public.shared_award_sources(id) on delete restrict,
  source_acquisition_id uuid not null references
    public.shared_award_source_acquisitions(id) on delete restrict,
  source_page_request_id uuid not null,
  disposition_item_sha256 text not null references
    private.stage1_source_disposition_items(decision_item_sha256)
    on delete restrict,
  finalization_receipt_sha256 text not null references
    private.stage1_source_baseline_activation_finalizations(
      finalization_receipt_sha256
    ) on delete restrict,
  manifest_sha256 text not null,
  policy_sha256 text not null,
  reason_code text not null,
  failure_stage text not null,
  evidence jsonb not null,
  recorded_at timestamptz not null,
  constraint stage1_evidence_schema_upgrade_failure_hash_check check (
    failure_sha256 ~ '^[0-9a-f]{64}$'
    and submitted_evidence_sha256 ~ '^[0-9a-f]{64}$'
    and disposition_item_sha256 ~ '^[0-9a-f]{64}$'
    and finalization_receipt_sha256 ~ '^[0-9a-f]{64}$'
    and manifest_sha256 =
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184'
    and policy_sha256 =
      '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
    and reason_code ~ '^[a-z0-9][a-z0-9_]{1,159}$'
    and failure_stage ~ '^[a-z0-9][a-z0-9_]{1,159}$'
    and pg_catalog.jsonb_typeof(evidence) = 'object'
    and evidence ->> 'evidence_sha256' = submitted_evidence_sha256
  )
);

create index stage1_evidence_schema_upgrade_failures_source_idx
  on private.stage1_evidence_schema_upgrade_failures (
    shared_award_source_id,
    recorded_at desc,
    failure_sha256
  );

alter table private.stage1_evidence_schema_upgrade_failures
  owner to postgres;
alter table private.stage1_evidence_schema_upgrade_failures
  enable row level security;

revoke all on table private.stage1_evidence_schema_upgrade_failures
from public, anon, authenticated, service_role;
grant select, insert on table
  private.stage1_evidence_schema_upgrade_failures
to service_role;

create policy stage1_evidence_schema_upgrade_failures_service_read
on private.stage1_evidence_schema_upgrade_failures
for select to service_role using (true);

create policy stage1_evidence_schema_upgrade_failures_service_insert
on private.stage1_evidence_schema_upgrade_failures
for insert to service_role with check (true);

create trigger prevent_stage1_evidence_schema_upgrade_failure_mutation
before update or delete
on private.stage1_evidence_schema_upgrade_failures
for each row execute function
  private.prevent_stage1_source_disposition_mutation();

comment on table private.stage1_evidence_schema_upgrade_failures is
  'Append-only, source-bound audit evidence for failures in the reviewed-nine Stage 1 evidence-schema upgrade. No row grants public fact authority or records a paid call.';

-- A private, narrowly granted wrapper lets the public SECURITY INVOKER RPC
-- verify the same cross-language canonical JSON seals used by Stage 1 without
-- broadening EXECUTE on the shared private hashing primitives.
create function private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  v_entry record;
  v_number numeric;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      for v_entry in
        select entry.key, entry.value
        from pg_catalog.jsonb_each(p_value) entry
      loop
        if v_entry.key !~ '^[ -~]+$'
          or private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
            v_entry.value
          ) is not true
        then
          return false;
        end if;
      end loop;
      return true;
    when 'array' then
      for v_entry in
        select entry.value
        from pg_catalog.jsonb_array_elements(p_value) entry
      loop
        if private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
            v_entry.value
          ) is not true
        then
          return false;
        end if;
      end loop;
      return true;
    when 'number' then
      v_number := (p_value #>> '{}')::numeric;
      return (p_value #>> '{}') ~ '^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$'
        and v_number = pg_catalog.trunc(v_number)
        and v_number between -9007199254740991 and 9007199254740991;
    when 'null' then return true;
    when 'string' then return true;
    when 'boolean' then return true;
    else return false;
  end case;
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return false;
end;
$$;

alter function
  private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)
  owner to postgres;
revoke all on function
  private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(jsonb)
to service_role;

create function private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
  p_value jsonb
)
returns text
language plpgsql
stable
strict
security definer
set search_path = ''
as $$
begin
  if private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      p_value
    ) is not true
  then
    raise exception using errcode = '22023',
      message = 'Stage 1 quarantine JSON is outside the cross-language canonical hash domain.';
  end if;
  return private.stage1_canonical_json_sha256(p_value);
end;
$$;

alter function
  private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)
  owner to postgres;
revoke all on function
  private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  private.stage1_evidence_schema_upgrade_quarantine_json_sha256(jsonb)
to service_role;

create function private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(
  p_value text
)
returns text
language sql
stable
strict
security definer
set search_path = ''
as $$
  select private.stage1_pgcrypto_sha256(
    pg_catalog.decode(p_value, 'base64')
  )
$$;

alter function
  private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)
  owner to postgres;
revoke all on function
  private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)
from public, anon, authenticated, service_role;
grant execute on function
  private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(text)
to service_role;

create function private.stage1_evidence_schema_upgrade_has_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
    and (
      select pg_catalog.count(*) = pg_catalog.cardinality(p_keys)
        and pg_catalog.count(*) = pg_catalog.count(distinct key_name)
        and pg_catalog.bool_and(key_name = any(p_keys))
      from pg_catalog.jsonb_object_keys(p_value) key_name
    )
$$;

alter function
  private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb, text[])
  owner to postgres;
revoke all on function
  private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb, text[])
from public, anon, authenticated, service_role;
grant execute on function
  private.stage1_evidence_schema_upgrade_has_exact_keys(jsonb, text[])
to service_role;

alter table private.stage1_evidence_schema_upgrade_failures
  add constraint stage1_evidence_schema_upgrade_failure_evidence_seal_check
  check (
    private.stage1_evidence_schema_upgrade_quarantine_json_sha256(evidence) =
      failure_sha256
  );

create function public.quarantine_stage1_evidence_schema_upgrade_failure(
  p_source_id uuid,
  p_acquisition_id uuid,
  p_request_id uuid,
  p_reason_code text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_source public.shared_award_sources%rowtype;
  v_acquisition public.shared_award_source_acquisitions%rowtype;
  v_item private.stage1_source_disposition_items%rowtype;
  v_bundle private.stage1_source_disposition_bundles%rowtype;
  v_finalization private.stage1_source_baseline_activation_finalizations%rowtype;
  v_existing private.stage1_evidence_schema_upgrade_failures%rowtype;
  v_source_binding jsonb := p_evidence -> 'source_binding';
  v_manifest jsonb := p_evidence -> 'manifest';
  v_policy jsonb := p_evidence -> 'policy';
  v_validation jsonb := p_evidence -> 'validation';
  v_outcome jsonb := p_evidence #> array['validation', 'outcome'];
  v_mutation_failure jsonb :=
    p_evidence #> array['validation', 'evidence', 'mutation_failure'];
  v_mutation_accounting jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'mutation_failure', 'mutation_accounting'
    ];
  v_journal_read_unavailable jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'journal_read_unavailable'
    ];
  v_journal_read_absent jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'journal_read_absent'
    ];
  v_pointer_commit_receipt jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_receipt'
    ];
  v_pointer_journal_binding jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_journal_binding'
    ];
  v_pointer_receipt_cas jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_receipt', 'cas'
    ];
  v_pointer_cleanup_debt jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_receipt', 'cleanup_debt'
    ];
  v_pointer_source_health jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_receipt', 'source_health'
    ];
  v_pointer_accounting_evidence jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_receipt',
      'mutation_accounting', 'evidence'
    ];
  v_observed_candidate_identity jsonb :=
    p_evidence #> array[
      'validation', 'evidence', 'pointer_commit_journal_binding',
      'observed_candidate_identity'
    ];
  v_r2 jsonb := p_evidence -> 'r2_binding';
  v_recovery jsonb := p_evidence -> 'commit_recovery';
  v_recovery_receipt jsonb;
  v_candidate jsonb := p_evidence -> 'candidate_artifacts';
  v_availability jsonb := p_evidence -> 'evidence_availability';
  v_candidate_pointer jsonb;
  v_candidate_projection jsonb;
  v_candidate_keys jsonb;
  v_candidate_metadata jsonb;
  v_candidate_bindings jsonb;
  v_retained_projection jsonb;
  v_retained_authority jsonb;
  v_journal jsonb;
  v_disposition jsonb;
  v_guard jsonb;
  v_artifact jsonb;
  v_submitted_evidence_sha256 text;
  v_failure_evidence jsonb;
  v_failure_sha256 text;
  v_quarantine_evidence jsonb;
  v_quarantine_id uuid;
  v_audit_inserted boolean := false;
  v_receipt jsonb;
  v_receipt_sha256 text;
  v_expected_item integer;
  v_observed_at timestamptz;
  v_initial_open boolean := false;
  v_publication_registry_writes integer := 0;
  v_publication_event_writes integer := 0;
  v_release_registry_writes integer := 0;
  v_release_state_writes integer := 0;
  v_release_event_writes integer := 0;
  v_publication_safety_writes integer := 0;
  v_database_writes integer := 0;
  v_expected_journal_action text;
  v_expected_candidate_action text;
  v_expected_safe_action text;
begin
  if p_source_id is null
    or p_acquisition_id is null
    or p_request_id is null
    or coalesce(p_reason_code, '') !~ '^[a-z0-9][a-z0-9_]{1,159}$'
    or private.stage1_evidence_schema_upgrade_has_exact_keys(
      p_evidence,
      array[
        'candidate_artifacts',
        'candidate_artifacts_sha256',
        'commit_recovery',
        'commit_recovery_sha256',
        'creates_api_charge',
        'detail',
        'evidence_availability',
        'evidence_sha256',
        'failure_stage',
        'manifest',
        'manifest_sha256',
        'policy',
        'policy_sha256',
        'public_award_update_created',
        'public_fact_authority',
        'r2_binding',
        'r2_binding_sha256',
        'reason_code',
        'safe_action',
        'schema_version',
        'source_binding',
        'validation',
        'validation_sha256'
      ]
    ) is not true
    or p_evidence ->> 'schema_version' is distinct from
      'awardping.stage1.evidence-schema-upgrade-quarantine-evidence.v1'
    or p_evidence ->> 'reason_code' is distinct from p_reason_code
    or coalesce(p_evidence ->> 'failure_stage', '') !~
      '^[a-z0-9][a-z0-9_]{1,159}$'
    or not (
      p_evidence -> 'detail' = 'null'::jsonb
      or pg_catalog.jsonb_typeof(p_evidence -> 'detail') = 'string'
    )
    or nullif(pg_catalog.btrim(p_evidence ->> 'safe_action'), '') is null
    or p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb
    or p_evidence -> 'public_fact_authority' is distinct from 'false'::jsonb
    or p_evidence -> 'public_award_update_created' is distinct from
      'false'::jsonb
    or private.stage1_evidence_schema_upgrade_quarantine_json_domain_valid(
      p_evidence
    ) is not true
    or coalesce(p_evidence ->> 'evidence_sha256', '') !~ '^[0-9a-f]{64}$'
    or p_evidence ->> 'evidence_sha256' is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        p_evidence - 'evidence_sha256'
      )
  then
    raise exception using errcode = '22023',
      message = 'Exact sealed zero-charge Stage 1 evidence-schema-upgrade failure evidence is required.';
  end if;

  if private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_source_binding,
      array[
        'disposition_item_sha256',
        'finalization_receipt_sha256',
        'guard_sha256',
        'manifest_item',
        'source_acquisition_id',
        'source_id',
        'source_page_request_id'
      ]
    ) is not true
    or v_source_binding ->> 'source_id' is distinct from p_source_id::text
    or v_source_binding ->> 'source_acquisition_id'
      is distinct from p_acquisition_id::text
    or v_source_binding ->> 'source_page_request_id'
      is distinct from p_request_id::text
    or coalesce(v_source_binding ->> 'guard_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_source_binding ->> 'disposition_item_sha256', '') !~
      '^[0-9a-f]{64}$'
    or coalesce(v_source_binding ->> 'finalization_receipt_sha256', '') !~
      '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade failure source binding is malformed.';
  end if;

  v_expected_item := case p_source_id
    when 'c30778fe-43d7-57be-842a-e046d84baaee'::uuid then 1
    when '2ea41875-5c88-5794-81b3-afa8ddaf31c1'::uuid then 2
    when 'af1367b5-0cb0-5b21-8e78-7dc195dd996f'::uuid then 3
    when 'b9407ce4-71f8-5c97-8f98-8466d640d4de'::uuid then 5
    when '5ec9a453-fd62-53e5-b885-726b21ce7247'::uuid then 6
    when 'fa4088a7-706e-4ad3-ae12-3653751dd5e1'::uuid then 8
    when '664d38ba-c717-5d51-b7ce-9e3a27f41fec'::uuid then 9
    when '719ffd9e-f97c-5c6d-8a5a-71b617cadf49'::uuid then 10
    when 'c28878c0-6a8b-5fa8-b99b-ec826b86d8f2'::uuid then 11
    else null
  end;
  if v_expected_item is null
    or (v_source_binding ->> 'manifest_item')::integer is distinct from
      v_expected_item
  then
    raise exception using errcode = '23514',
      message = 'Only the exact reviewed-nine sources can enter Stage 1 evidence-schema-upgrade quarantine.';
  end if;

  if pg_catalog.jsonb_typeof(v_manifest) is distinct from 'object'
    or p_evidence ->> 'manifest_sha256' is distinct from
      'f2a16adec57b3a66c3e467599bbf962cf02c94d1f6ded1daf5db09bf980c0184'
    or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_manifest)
      is distinct from p_evidence ->> 'manifest_sha256'
    or v_manifest ->> 'schema_version' is distinct from
      'awardping.stage1.reviewed-source-capture-allowlist.v1'
    or v_manifest ->> 'evidence_packet_sha256' is distinct from
      '8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f'
    or v_manifest ->> 'applied_disposition_bundle_sha256' is distinct from
      'a3825703fd736cea3ca38a3294a7d0378c94316b828820ee138336ecc6777acb'
    or v_manifest ->> 'disposition_confirmation_sha256' is distinct from
      'b967506e8cb67f1f9315d9b9ece9a5a8bd658e34bb5452c769e801c8f7703866'
    or (v_manifest ->> 'source_count')::integer <> 9
    or not (v_manifest -> 'source_ids' ? p_source_id::text)
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade failure does not carry the exact reviewed-nine manifest.';
  end if;

  if private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_policy,
      array[
        'context',
        'creates_api_charge',
        'manifest_sha256',
        'policy_id',
        'policy_version',
        'public_fact_authority',
        'reviewed_source_count',
        'schema_version'
      ]
    ) is not true
    or p_evidence ->> 'policy_sha256' is distinct from
      '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c'
    or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_policy)
      is distinct from p_evidence ->> 'policy_sha256'
    or v_policy ->> 'schema_version' is distinct from
      'awardping.stage1.evidence-schema-upgrade-quarantine-policy.v1'
    or v_policy ->> 'policy_id' is distinct from
      'awardping-stage1-evidence-schema-upgrade-quarantine'
    or v_policy ->> 'policy_version' is distinct from '1'
    or v_policy ->> 'context' is distinct from 'stage1_evidence_schema_upgrade'
    or v_policy ->> 'manifest_sha256' is distinct from
      p_evidence ->> 'manifest_sha256'
    or (v_policy ->> 'reviewed_source_count')::integer <> 9
    or v_policy -> 'creates_api_charge' is distinct from 'false'::jsonb
    or v_policy -> 'public_fact_authority' is distinct from 'false'::jsonb
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade quarantine policy binding is invalid.';
  end if;

  if private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_validation,
      array[
        'creates_api_charge',
        'decision',
        'evidence',
        'outcome',
        'reason',
        'reasons',
        'schema_version'
      ]
    ) is not true
    or v_validation ->> 'schema_version' is distinct from
      'awardping.stage1.evidence-schema-upgrade-validation.v1'
    or coalesce(v_validation ->> 'decision', '') not in (
      'eligible_unchanged_upgrade',
      'material_difference_candidate',
      'evidence_failure_quarantine'
    )
    or v_validation -> 'creates_api_charge' is distinct from 'false'::jsonb
    or pg_catalog.jsonb_typeof(v_validation -> 'reasons') is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_validation -> 'evidence') is distinct from 'object'
    or v_validation #>> array['evidence', 'source_id'] is distinct from
      p_source_id::text
    or (
      (v_validation #> array['evidence', 'capture']) ? 'source_id'
      and v_validation #>> array['evidence', 'capture', 'source_id']
        is distinct from p_source_id::text
    )
    or (
      (v_validation #> array['evidence', 'immutable_acquisition']) ? 'source_id'
      and v_validation #>> array[
        'evidence',
        'immutable_acquisition',
        'source_id'
      ] is distinct from p_source_id::text
    )
    or private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_outcome,
      array[
        'creates_api_charge',
        'would_commit',
        'would_quarantine',
        'would_queue_visual_candidate'
      ]
    ) is not true
    or v_outcome -> 'creates_api_charge' is distinct from 'false'::jsonb
    or (v_outcome -> 'would_commit') is distinct from pg_catalog.to_jsonb(
      v_validation ->> 'decision' = 'eligible_unchanged_upgrade'
    )
    or (v_outcome -> 'would_queue_visual_candidate') is distinct from
      pg_catalog.to_jsonb(
        v_validation ->> 'decision' = 'material_difference_candidate'
      )
    or (v_outcome -> 'would_quarantine') is distinct from pg_catalog.to_jsonb(
      v_validation ->> 'decision' = 'evidence_failure_quarantine'
    )
    or coalesce(p_evidence ->> 'validation_sha256', '') !~ '^[0-9a-f]{64}$'
    or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
      v_validation
    ) is distinct from p_evidence ->> 'validation_sha256'
    or (
      p_evidence ->> 'failure_stage' in ('candidate_enqueue', 'pointer_commit')
    ) is distinct from (
      (v_validation -> 'evidence') ? 'mutation_failure'
    )
    or (
      (v_validation -> 'evidence') ? 'journal_read_unavailable'
      and (
        private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_journal_read_unavailable,
          array['error', 'status']
        ) is not true
        or v_journal_read_unavailable ->> 'status' is distinct from
          'unavailable'
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_journal_read_unavailable -> 'error',
          array['code', 'message', 'name']
        ) is not true
        or nullif(pg_catalog.btrim(
          v_journal_read_unavailable #>> array['error', 'name']
        ), '') is null
        or nullif(pg_catalog.btrim(
          v_journal_read_unavailable #>> array['error', 'message']
        ), '') is null
        or not (
          v_journal_read_unavailable #> array['error', 'code'] = 'null'::jsonb
          or (
            pg_catalog.jsonb_typeof(
              v_journal_read_unavailable #> array['error', 'code']
            ) = 'string'
            and nullif(pg_catalog.btrim(
              v_journal_read_unavailable #>> array['error', 'code']
            ), '') is not null
          )
        )
      )
    )
    or (
      (v_validation -> 'evidence') ? 'journal_read_absent'
      and (
        private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_journal_read_absent,
          array['error', 'journal', 'status']
        ) is not true
        or v_journal_read_absent ->> 'status' is distinct from 'absent'
        or v_journal_read_absent -> 'journal' is distinct from 'null'::jsonb
        or v_journal_read_absent -> 'error' is distinct from 'null'::jsonb
      )
    )
    or (
      (v_validation -> 'evidence') ? 'journal_read_absent'
      and (v_validation -> 'evidence') ? 'journal_read_unavailable'
    )
    or (
      (v_validation -> 'evidence') ? 'mutation_failure'
      and (
        private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_mutation_failure,
          array['error', 'mutation_accounting', 'operation']
        ) is not true
        or coalesce(v_mutation_failure ->> 'operation', '') !~
          '^[a-z0-9][a-z0-9_]{1,159}$'
        or v_mutation_failure ->> 'operation' is distinct from
          p_evidence ->> 'failure_stage'
        or coalesce(v_mutation_failure ->> 'operation', '') not in (
          'candidate_enqueue',
          'pointer_commit'
        )
        or (
          v_mutation_failure ->> 'operation' = 'candidate_enqueue'
          and v_validation ->> 'decision' is distinct from
            'material_difference_candidate'
        )
        or (
          v_mutation_failure ->> 'operation' = 'pointer_commit'
          and coalesce(v_validation ->> 'decision', '') not in (
            'eligible_unchanged_upgrade',
            'evidence_failure_quarantine'
          )
        )
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_mutation_failure -> 'error',
          array['code', 'message', 'name']
        ) is not true
        or nullif(pg_catalog.btrim(
          v_mutation_failure #>> array['error', 'name']
        ), '') is null
        or nullif(pg_catalog.btrim(
          v_mutation_failure #>> array['error', 'message']
        ), '') is null
        or not (
          v_mutation_failure #> array['error', 'code'] = 'null'::jsonb
          or (
            pg_catalog.jsonb_typeof(
              v_mutation_failure #> array['error', 'code']
            ) = 'string'
            and nullif(pg_catalog.btrim(
              v_mutation_failure #>> array['error', 'code']
            ), '') is not null
          )
        )
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_mutation_accounting,
          array[
            'accounting_sha256',
            'count_semantics',
            'evidence',
            'exact',
            'lower_bound_counts',
            'operation',
            'schema_version',
            'unknown_write_categories'
          ]
        ) is not true
        or v_mutation_accounting ->> 'schema_version' is distinct from
          'awardping.stage1.evidence-schema-upgrade-mutation-accounting.v1'
        or v_mutation_accounting ->> 'operation' is distinct from
          v_mutation_failure ->> 'operation'
        or v_mutation_accounting ->> 'count_semantics' is distinct from
          'confirmed_lower_bounds'
        or pg_catalog.jsonb_typeof(
          v_mutation_accounting -> 'unknown_write_categories'
        ) is distinct from 'array'
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            v_mutation_accounting -> 'unknown_write_categories'
          ) category(value)
          where pg_catalog.jsonb_typeof(category.value) <> 'string'
            or category.value #>> '{}' <> all(array[
              'candidate_writes',
              'database_writes',
              'local_baseline_writes',
              'quarantine_writes',
              'r2_writes',
              'source_state_writes'
            ]::text[])
        )
        or v_mutation_accounting -> 'unknown_write_categories' is distinct from
          coalesce((
            select pg_catalog.jsonb_agg(
              category.value order by category.value collate "C"
            )
            from (
              select distinct category.value
              from pg_catalog.jsonb_array_elements_text(
                v_mutation_accounting -> 'unknown_write_categories'
              ) category(value)
            ) category
          ), '[]'::jsonb)
        or v_mutation_accounting -> 'exact' is distinct from
          pg_catalog.to_jsonb(
            pg_catalog.jsonb_array_length(
              v_mutation_accounting -> 'unknown_write_categories'
            ) = 0
          )
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_mutation_accounting -> 'lower_bound_counts',
          array[
            'candidate_writes',
            'database_writes',
            'local_baseline_writes',
            'quarantine_writes',
            'r2_writes',
            'source_state_writes'
          ]
        ) is not true
        or exists (
          select 1
          from pg_catalog.jsonb_each(
            v_mutation_accounting -> 'lower_bound_counts'
          ) count_entry(name, value)
          where pg_catalog.jsonb_typeof(count_entry.value) <> 'number'
            or (count_entry.value #>> '{}')::numeric < 0
        )
        or (
          v_mutation_failure ->> 'operation' = 'candidate_enqueue'
          and (
            v_mutation_accounting #> array[
              'lower_bound_counts', 'r2_writes'
            ] <> '0'::jsonb
            or v_mutation_accounting #> array[
              'lower_bound_counts', 'local_baseline_writes'
            ] <> '0'::jsonb
            or v_mutation_accounting #> array[
              'lower_bound_counts', 'quarantine_writes'
            ] <> '0'::jsonb
            or v_mutation_accounting #> array[
              'lower_bound_counts', 'source_state_writes'
            ] <> '0'::jsonb
            or (v_mutation_accounting #>> array[
              'lower_bound_counts', 'database_writes'
            ])::numeric < (v_mutation_accounting #>> array[
              'lower_bound_counts', 'candidate_writes'
            ])::numeric
            or exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                v_mutation_accounting -> 'unknown_write_categories'
              ) category(value)
              where category.value not in (
                'candidate_writes', 'database_writes'
              )
            )
          )
        )
        or (
          v_mutation_failure ->> 'operation' = 'pointer_commit'
          and (
            v_mutation_accounting #> array[
              'lower_bound_counts', 'candidate_writes'
            ] <> '0'::jsonb
            or v_mutation_accounting #> array[
              'lower_bound_counts', 'quarantine_writes'
            ] <> '0'::jsonb
            or (v_mutation_accounting #>> array[
              'lower_bound_counts', 'database_writes'
            ])::numeric < (v_mutation_accounting #>> array[
              'lower_bound_counts', 'source_state_writes'
            ])::numeric
            or v_mutation_accounting -> 'unknown_write_categories'
              ?| array['candidate_writes', 'quarantine_writes']
          )
        )
        or (
          v_mutation_failure ->> 'operation' = 'candidate_enqueue'
          and (
            private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_mutation_accounting -> 'evidence',
              array[
                'boundary',
                'candidate_signature',
                'response_loss_possible'
              ]
            ) is not true
            or nullif(pg_catalog.btrim(
              v_mutation_accounting #>> array['evidence', 'boundary']
            ), '') is null
            or v_mutation_accounting #> array[
              'evidence', 'response_loss_possible'
            ] is distinct from case
              when v_mutation_accounting -> 'exact' = 'true'::jsonb
                then 'false'::jsonb
              else 'true'::jsonb
            end
            or not (
              coalesce(v_mutation_accounting #>> array[
                'evidence', 'candidate_signature'
              ], '') ~ '^[0-9a-f]{64}$'
              or (
                v_mutation_accounting #> array[
                  'evidence', 'candidate_signature'
                ] = 'null'::jsonb
                and v_mutation_accounting #>> array[
                  'evidence', 'boundary'
                ] = 'before_candidate_enqueue'
                and v_mutation_accounting -> 'exact' = 'true'::jsonb
                and v_mutation_accounting -> 'unknown_write_categories' =
                  '[]'::jsonb
                and not exists (
                  select 1
                  from pg_catalog.jsonb_each(
                    v_mutation_accounting -> 'lower_bound_counts'
                  ) count_entry(name, value)
                  where count_entry.value <> '0'::jsonb
                )
              )
            )
          )
        )
        or coalesce(v_mutation_accounting ->> 'accounting_sha256', '') !~
          '^[0-9a-f]{64}$'
        or v_mutation_accounting ->> 'accounting_sha256' is distinct from
          private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_mutation_accounting - 'accounting_sha256'
        )
      )
    )
    or (
      (v_validation -> 'evidence') ? 'pointer_commit_receipt'
      and (
        v_mutation_failure ->> 'operation' is distinct from 'pointer_commit'
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_commit_receipt,
          array[
            'authoritative_baseline_sha256',
            'authoritative_baseline_state',
            'authoritative_pointer_sha256',
            'authoritative_pointer_state',
            'cas',
            'cleanup_debt',
            'cleanup_delete_performed',
            'context',
            'creates_api_charge',
            'journal_archived',
            'journal_phase',
            'journal_sha256',
            'mutation_accounting',
            'mutation_count_scope',
            'mutation_counts',
            'operation',
            'outcome',
            'schema_version',
            'source_health',
            'source_id',
            'status',
            'transaction_id'
          ]
        ) is not true
        or v_pointer_commit_receipt ->> 'schema_version' is distinct from
          'awardping.stage1.evidence-schema-upgrade-commit-receipt.v1'
        or v_pointer_commit_receipt ->> 'source_id' is distinct from
          p_source_id::text
        or v_pointer_commit_receipt ->> 'context' is distinct from
          'stage1_evidence_schema_upgrade'
        or v_pointer_commit_receipt ->> 'operation' is distinct from
          'pointer_commit'
        or v_pointer_commit_receipt ->> 'status' is distinct from
          'recovery_required'
        or v_pointer_commit_receipt -> 'creates_api_charge' is distinct from
          'false'::jsonb
        or nullif(pg_catalog.btrim(
          v_pointer_commit_receipt ->> 'transaction_id'
        ), '') is null
        or pg_catalog.jsonb_typeof(v_pointer_commit_receipt -> 'outcome')
          is distinct from 'string'
        or coalesce(v_pointer_commit_receipt ->> 'outcome', '') not in (
          'ambiguous_authority',
          'authority_changed_after_source_health',
          'candidate_authority_convergence_failed',
          'old_authority_convergence_failed'
        )
        or v_pointer_commit_receipt ->> 'journal_phase' is distinct from
          'recovery_required'
        or coalesce(v_pointer_commit_receipt ->> 'journal_sha256', '') !~
          '^[0-9a-f]{64}$'
        or v_pointer_commit_receipt -> 'journal_archived' is distinct from
          'false'::jsonb
        or pg_catalog.jsonb_typeof(
          v_pointer_commit_receipt -> 'authoritative_pointer_state'
        ) is distinct from 'string'
        or coalesce(
          v_pointer_commit_receipt ->> 'authoritative_pointer_state', ''
        ) not in (
          'both', 'candidate', 'old', 'other', 'unknown', 'unreadable'
        )
        or pg_catalog.jsonb_typeof(
          v_pointer_commit_receipt -> 'authoritative_baseline_state'
        ) is distinct from 'string'
        or coalesce(
          v_pointer_commit_receipt ->> 'authoritative_baseline_state', ''
        ) not in (
          'both', 'candidate', 'old', 'other', 'unknown', 'unreadable'
        )
        or case
          when v_pointer_commit_receipt ->> 'authoritative_pointer_state' =
            'candidate'
          then coalesce(
              v_pointer_commit_receipt ->> 'authoritative_pointer_sha256', ''
            ) !~ '^[0-9a-f]{64}$'
            or coalesce(
              v_pointer_commit_receipt ->> 'authoritative_baseline_sha256', ''
            ) !~ '^[0-9a-f]{64}$'
          when v_pointer_commit_receipt ->> 'authoritative_pointer_state' =
            'old'
          then coalesce(
              v_pointer_commit_receipt ->> 'authoritative_pointer_sha256', ''
            ) !~ '^[0-9a-f]{64}$'
            or not (
              v_pointer_commit_receipt -> 'authoritative_baseline_sha256' =
                'null'::jsonb
              or coalesce(
                v_pointer_commit_receipt ->>
                  'authoritative_baseline_sha256', ''
              ) ~ '^[0-9a-f]{64}$'
            )
          else v_pointer_commit_receipt -> 'authoritative_pointer_sha256'
              is distinct from 'null'::jsonb
            or v_pointer_commit_receipt -> 'authoritative_baseline_sha256'
              is distinct from 'null'::jsonb
        end
        or (
          v_pointer_commit_receipt ->> 'outcome' = 'ambiguous_authority'
          and v_pointer_commit_receipt ->> 'authoritative_pointer_state'
            in ('candidate', 'old')
        )
        or (
          v_pointer_commit_receipt ->> 'outcome' =
            'old_authority_convergence_failed'
          and v_pointer_commit_receipt ->> 'authoritative_pointer_state' =
            'old'
          and v_pointer_commit_receipt ->> 'authoritative_baseline_state'
            in ('old', 'both')
        )
        or (
          v_pointer_commit_receipt ->> 'outcome' in (
            'authority_changed_after_source_health',
            'candidate_authority_convergence_failed'
          )
          and v_pointer_commit_receipt ->> 'authoritative_pointer_state' =
            'candidate'
          and v_pointer_commit_receipt ->> 'authoritative_baseline_state'
            in ('candidate', 'both')
        )
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_receipt_cas,
          array[
            'attempted',
            'confirmed_database_pointer_writes',
            'error_code',
            'error_message',
            'recovered',
            'returned',
            'threw',
            'write_attribution'
          ]
        ) is not true
        or pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'attempted')
          is distinct from 'boolean'
        or not (
          v_pointer_receipt_cas -> 'returned' = 'null'::jsonb
          or pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'returned') =
            'boolean'
        )
        or pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'threw')
          is distinct from 'boolean'
        or pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'recovered')
          is distinct from 'boolean'
        or not (
          (
            pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'returned') =
              'boolean'
            and v_pointer_receipt_cas -> 'attempted' = 'true'::jsonb
            and v_pointer_receipt_cas -> 'threw' = 'false'::jsonb
            and v_pointer_receipt_cas -> 'recovered' = 'false'::jsonb
            and v_pointer_receipt_cas -> 'error_code' = 'null'::jsonb
            and v_pointer_receipt_cas -> 'error_message' = 'null'::jsonb
          )
          or (
            v_pointer_receipt_cas -> 'attempted' = 'true'::jsonb
            and v_pointer_receipt_cas -> 'returned' = 'null'::jsonb
            and v_pointer_receipt_cas -> 'threw' = 'true'::jsonb
            and v_pointer_receipt_cas -> 'recovered' = 'false'::jsonb
            and nullif(pg_catalog.btrim(
              v_pointer_receipt_cas ->> 'error_code'
            ), '') is not null
            and nullif(pg_catalog.btrim(
              v_pointer_receipt_cas ->> 'error_message'
            ), '') is not null
          )
          or (
            pg_catalog.jsonb_typeof(v_pointer_receipt_cas -> 'attempted') =
              'boolean'
            and v_pointer_receipt_cas -> 'returned' = 'null'::jsonb
            and v_pointer_receipt_cas -> 'threw' = 'false'::jsonb
            and v_pointer_receipt_cas -> 'recovered' = 'true'::jsonb
            and v_pointer_receipt_cas -> 'error_code' = 'null'::jsonb
            and v_pointer_receipt_cas -> 'error_message' = 'null'::jsonb
          )
        )
        or v_pointer_receipt_cas -> 'confirmed_database_pointer_writes'
          is distinct from case
            when v_pointer_receipt_cas -> 'returned' = 'true'::jsonb
              then '1'::jsonb
            else '0'::jsonb
          end
        or v_pointer_receipt_cas ->> 'write_attribution' is distinct from case
          when v_pointer_receipt_cas -> 'returned' = 'true'::jsonb
            then 'confirmed_by_strict_true_return'
          when v_pointer_receipt_cas -> 'threw' = 'true'::jsonb
            then 'unattributed_after_exception'
          when v_pointer_receipt_cas -> 'returned' = 'false'::jsonb
            then 'confirmed_not_written_by_this_cas'
          else 'prior_invocation_not_counted'
        end
        or v_pointer_commit_receipt -> 'cleanup_delete_performed' is distinct
          from 'false'::jsonb
        or v_pointer_commit_receipt ->> 'mutation_count_scope' is distinct from
          'confirmed_io_receipts_in_this_invocation'
        or v_pointer_commit_receipt -> 'mutation_counts' is distinct from
          v_mutation_accounting -> 'lower_bound_counts'
        or v_pointer_commit_receipt -> 'mutation_accounting' is distinct from
          v_mutation_accounting
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_accounting_evidence,
          array['boundary', 'cas', 'journal_phase', 'response_loss_possible']
        ) is not true
        or nullif(pg_catalog.btrim(
          v_pointer_accounting_evidence ->> 'boundary'
        ), '') is null
        or v_pointer_accounting_evidence ->> 'journal_phase' is distinct from
          v_pointer_commit_receipt ->> 'journal_phase'
        or v_pointer_accounting_evidence -> 'response_loss_possible'
          is distinct from pg_catalog.to_jsonb(
            not coalesce((v_mutation_accounting ->> 'exact')::boolean, false)
          )
        or v_pointer_accounting_evidence -> 'cas' is distinct from
          v_pointer_receipt_cas
        or (v_mutation_accounting -> 'exact') is distinct from
          pg_catalog.to_jsonb(
            v_pointer_receipt_cas -> 'threw' = 'false'::jsonb
          )
        or (
          v_pointer_receipt_cas -> 'threw' = 'true'::jsonb
          and not (
            v_mutation_accounting -> 'unknown_write_categories'
              ? 'database_writes'
          )
        )
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_cleanup_debt,
          array[
            'candidate_keys',
            'deferred_keys',
            'delete_performed',
            'eligible_count',
            'eligible_keys',
            'item_count',
            'protected_keys',
            'reason',
            'requires_authoritative_recheck',
            'requires_published_reference_graph_check',
            'schema_version'
          ]
        ) is not true
        or v_pointer_cleanup_debt ->> 'schema_version' is distinct from
          'awardping.visual-snapshot.latest-only-cleanup-debt.v1'
        or nullif(pg_catalog.btrim(
          v_pointer_cleanup_debt ->> 'reason'
        ), '') is null
        or v_pointer_cleanup_debt -> 'delete_performed' is distinct from
          'false'::jsonb
        or pg_catalog.jsonb_typeof(
          v_pointer_cleanup_debt -> 'requires_authoritative_recheck'
        ) is distinct from 'boolean'
        or pg_catalog.jsonb_typeof(
          v_pointer_cleanup_debt ->
            'requires_published_reference_graph_check'
        ) is distinct from 'boolean'
        or exists (
          select 1
          from (values
            ('candidate_keys'),
            ('deferred_keys'),
            ('eligible_keys'),
            ('protected_keys')
          ) fields(field_name)
          where pg_catalog.jsonb_typeof(
              v_pointer_cleanup_debt -> fields.field_name
            ) is distinct from 'array'
            or exists (
              select 1
              from pg_catalog.jsonb_array_elements(
                case
                  when pg_catalog.jsonb_typeof(
                    v_pointer_cleanup_debt -> fields.field_name
                  ) = 'array'
                    then v_pointer_cleanup_debt -> fields.field_name
                  else '[]'::jsonb
                end
              ) item(value)
              where pg_catalog.jsonb_typeof(item.value) <> 'string'
                or nullif(pg_catalog.btrim(item.value #>> '{}'), '') is null
            )
            or v_pointer_cleanup_debt -> fields.field_name is distinct from
              coalesce((
                select pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(item.value)
                  order by item.value collate "C"
                )
                from (
                  select distinct item.value
                  from pg_catalog.jsonb_array_elements_text(
                    case
                      when pg_catalog.jsonb_typeof(
                        v_pointer_cleanup_debt -> fields.field_name
                      ) = 'array'
                        then v_pointer_cleanup_debt -> fields.field_name
                      else '[]'::jsonb
                    end
                  ) item(value)
                ) item
              ), '[]'::jsonb)
        )
        or pg_catalog.jsonb_array_length(
          v_pointer_cleanup_debt -> 'candidate_keys'
        ) < 1
        or v_pointer_cleanup_debt -> 'item_count' is distinct from
          pg_catalog.to_jsonb(pg_catalog.jsonb_array_length(
            v_pointer_cleanup_debt -> 'candidate_keys'
          ))
        or v_pointer_cleanup_debt -> 'eligible_count' is distinct from
          pg_catalog.to_jsonb(pg_catalog.jsonb_array_length(
            v_pointer_cleanup_debt -> 'eligible_keys'
          ))
        or exists (
          select 1
          from (values
            ('deferred_keys'),
            ('eligible_keys'),
            ('protected_keys')
          ) fields(field_name)
          cross join lateral pg_catalog.jsonb_array_elements_text(
            case
              when pg_catalog.jsonb_typeof(
                v_pointer_cleanup_debt -> fields.field_name
              ) = 'array'
                then v_pointer_cleanup_debt -> fields.field_name
              else '[]'::jsonb
            end
          ) item(value)
          where not (
            v_pointer_cleanup_debt -> 'candidate_keys' ? item.value
          )
        )
        or (
          v_pointer_commit_receipt ->> 'outcome' =
            'authority_changed_after_source_health'
          and (
            private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_pointer_source_health,
              array['mutation_counts', 'status']
            ) is not true
            or pg_catalog.jsonb_typeof(v_pointer_source_health -> 'status')
              is distinct from 'string'
            or coalesce(v_pointer_source_health ->> 'status', '') not in (
              'already_current', 'succeeded'
            )
            or private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_pointer_source_health -> 'mutation_counts',
              array[
                'candidate_writes',
                'database_writes',
                'local_baseline_writes',
                'quarantine_writes',
                'r2_writes',
                'source_state_writes'
              ]
            ) is not true
            or exists (
              select 1
              from pg_catalog.jsonb_each(
                v_pointer_source_health -> 'mutation_counts'
              ) count_entry(name, value)
              where pg_catalog.jsonb_typeof(count_entry.value) <> 'number'
                or (count_entry.value #>> '{}')::numeric < 0
                or (count_entry.value #>> '{}')::numeric >
                  (v_pointer_commit_receipt #>> array[
                    'mutation_counts', count_entry.name
                  ])::numeric
            )
            or v_pointer_source_health #> array[
              'mutation_counts', 'r2_writes'
            ] is distinct from '0'::jsonb
            or v_pointer_source_health #> array[
              'mutation_counts', 'local_baseline_writes'
            ] is distinct from '0'::jsonb
            or v_pointer_source_health #> array[
              'mutation_counts', 'candidate_writes'
            ] is distinct from '0'::jsonb
            or v_pointer_source_health #> array[
              'mutation_counts', 'quarantine_writes'
            ] is distinct from '0'::jsonb
            or v_pointer_source_health #> array[
              'mutation_counts', 'database_writes'
            ] is distinct from v_pointer_source_health #> array[
              'mutation_counts', 'source_state_writes'
            ]
          )
        )
        or (
          v_pointer_commit_receipt ->> 'outcome' <>
            'authority_changed_after_source_health'
          and v_pointer_source_health is distinct from 'null'::jsonb
        )
        or (v_pointer_commit_receipt #>> array[
          'mutation_counts', 'source_state_writes'
        ])::numeric is distinct from coalesce((v_pointer_source_health #>> array[
          'mutation_counts', 'source_state_writes'
        ])::numeric, 0)
        or case
          when v_mutation_accounting -> 'exact' = 'true'::jsonb then
            (v_pointer_commit_receipt #>> array[
              'mutation_counts', 'database_writes'
            ])::numeric is distinct from
              (v_pointer_receipt_cas ->>
                'confirmed_database_pointer_writes')::numeric
              + coalesce((v_pointer_source_health #>> array[
                'mutation_counts', 'database_writes'
              ])::numeric, 0)
          else
            (v_pointer_commit_receipt #>> array[
              'mutation_counts', 'database_writes'
            ])::numeric <
              (v_pointer_receipt_cas ->>
                'confirmed_database_pointer_writes')::numeric
              + coalesce((v_pointer_source_health #>> array[
                'mutation_counts', 'database_writes'
              ])::numeric, 0)
        end
      )
    )
    or (
      (v_validation -> 'evidence') ? 'pointer_commit_receipt'
      and v_recovery = 'null'::jsonb
      and v_journal_read_unavailable is null
      and v_journal_read_absent is null
    )
    or (
      ((v_validation -> 'evidence') ? 'pointer_commit_journal_binding')
        is distinct from (
          ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
          or v_recovery <> 'null'::jsonb
          or (
            ((v_validation -> 'evidence') ? 'journal_read_absent')
            and coalesce(v_mutation_failure ->> 'operation', '') =
              'pointer_commit'
          )
        )
    )
    or (
      (v_validation -> 'evidence') ? 'pointer_commit_journal_binding'
      and (
        private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_pointer_journal_binding,
          array[
            'fresh_journal_read_status',
            'fresh_journal_sha256',
            'observed_candidate_identity',
            'prior_receipt_journal_sha256',
            'safe_action',
            'schema_version',
            'status'
          ]
        ) is not true
        or v_pointer_journal_binding ->> 'schema_version' is distinct from
          'awardping.stage1.evidence-schema-upgrade-pointer-journal-binding.v1'
        or v_pointer_journal_binding -> 'prior_receipt_journal_sha256'
          is distinct from case
            when (v_validation -> 'evidence') ? 'pointer_commit_receipt'
              then v_pointer_commit_receipt -> 'journal_sha256'
            else 'null'::jsonb
          end
        or v_pointer_journal_binding -> 'fresh_journal_sha256' is distinct from
          case
            when v_recovery <> 'null'::jsonb
              then v_recovery -> 'journal_sha256'
            else 'null'::jsonb
          end
        or v_pointer_journal_binding ->> 'fresh_journal_read_status'
          is distinct from case
            when v_recovery <> 'null'::jsonb then 'sealed_present'
            when v_journal_read_unavailable is not null then 'unavailable'
            else 'absent'
          end
        or v_pointer_journal_binding ->> 'status' is distinct from case
          when not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
            and v_recovery <> 'null'::jsonb
            then 'fresh_observation_only'
          when not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
            and (v_validation -> 'evidence') ? 'journal_read_absent'
            and coalesce(v_mutation_failure ->> 'operation', '') =
              'pointer_commit'
            then 'fresh_absence_only'
          when v_recovery <> 'null'::jsonb
            and v_pointer_commit_receipt ->> 'journal_sha256' =
              v_recovery ->> 'journal_sha256'
            then 'same_journal'
          when v_recovery <> 'null'::jsonb then 'changed_since_failure'
          when v_journal_read_unavailable is not null
            then 'prior_observation_only'
          else 'missing_since_failure'
        end
        or v_pointer_journal_binding ->> 'safe_action' is distinct from case
          when not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
            and v_recovery <> 'null'::jsonb
            then 'Keep the source quarantined and reconcile the separately observed fresh journal before retrying the failed operation.'
          when not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
            and (v_validation -> 'evidence') ? 'journal_read_absent'
            and coalesce(v_mutation_failure ->> 'operation', '') =
              'pointer_commit'
            then 'Keep the source quarantined; the fresh read verified that no active upgrade journal exists.'
          when v_recovery <> 'null'::jsonb
            and v_pointer_commit_receipt ->> 'journal_sha256' =
              v_recovery ->> 'journal_sha256'
            then 'Keep the source quarantined and reconcile the freshly verified journal before retrying.'
          when v_recovery <> 'null'::jsonb
            then 'Keep the source quarantined and reconcile both the prior receipt journal and the different fresh journal before retrying.'
          when v_journal_read_unavailable is not null
            then 'Treat the receipt journal as a prior observation only; obtain a fresh sealed journal read before retrying.'
          else 'Keep the source quarantined; verify current pointer and baseline authority, then restore or reconstruct and reconcile the prior receipt journal before retrying.'
        end
        or (
          v_pointer_journal_binding ->> 'status' in (
            'fresh_absence_only',
            'fresh_observation_only'
          )
          and (v_validation -> 'evidence') ? 'pointer_commit_receipt'
        )
        or (
          v_pointer_journal_binding ->> 'status' not in (
            'fresh_absence_only',
            'fresh_observation_only'
          )
          and not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
        )
        or (
          v_pointer_journal_binding ->> 'status' = 'same_journal'
          and (
            v_pointer_commit_receipt ->> 'transaction_id' is distinct from
              v_recovery #>> array['journal', 'transaction_id']
            or v_pointer_commit_receipt ->> 'journal_phase' is distinct from
              v_recovery #>> array['journal', 'phase']
            or v_pointer_commit_receipt -> 'authoritative_pointer_sha256'
              is distinct from case
                when v_pointer_commit_receipt ->>
                  'authoritative_pointer_state' = 'candidate'
                  then v_recovery #> array[
                    'journal', 'candidate_pointer_identity', 'canonical_sha256'
                  ]
                when v_pointer_commit_receipt ->>
                  'authoritative_pointer_state' = 'old'
                  then v_recovery #> array[
                    'journal', 'old_pointer_identity', 'canonical_sha256'
                  ]
                else 'null'::jsonb
              end
            or v_pointer_commit_receipt -> 'authoritative_baseline_sha256'
              is distinct from case
                when v_pointer_commit_receipt ->>
                  'authoritative_pointer_state' = 'candidate'
                  then v_recovery #> array[
                    'journal', 'candidate_baseline', 'sha256'
                  ]
                when v_pointer_commit_receipt ->>
                  'authoritative_pointer_state' = 'old'
                  then v_recovery #> array[
                    'journal', 'old_baseline', 'sha256'
                  ]
                else 'null'::jsonb
              end
            or v_pointer_cleanup_debt -> 'candidate_keys' is distinct from
              coalesce((
                select pg_catalog.jsonb_agg(
                  pg_catalog.to_jsonb(candidate_key.value)
                  order by candidate_key.value collate "C"
                )
                from (
                  select distinct candidate_entry.value
                  from pg_catalog.jsonb_each_text(
                    v_recovery #> array['journal', 'candidate_object_keys']
                  ) candidate_entry(role, value)
                ) candidate_key(value)
              ), '[]'::jsonb)
          )
        )
        or (
          v_candidate = 'null'::jsonb
          and v_observed_candidate_identity is distinct from 'null'::jsonb
        )
        or (
          v_candidate <> 'null'::jsonb
          and (
            private.stage1_evidence_schema_upgrade_has_exact_keys(
              v_observed_candidate_identity,
              array[
                'bucket',
                'candidate_pointer_sha256',
                'captured_at',
                'file_hash',
                'image_hash',
                'journal_sha256',
                'kind',
                'layout_hash',
                'source_id',
                'text_hash',
                'version'
              ]
            ) is not true
            or v_observed_candidate_identity ->> 'source_id' is distinct from
              p_source_id::text
            or v_observed_candidate_identity ->> 'kind' is distinct from
              v_candidate ->> 'kind'
            or v_observed_candidate_identity ->> 'bucket' is distinct from
              v_candidate ->> 'bucket'
            or v_observed_candidate_identity ->> 'version' is distinct from
              v_candidate ->> 'version'
            or v_observed_candidate_identity ->> 'captured_at' is distinct from
              v_candidate ->> 'captured_at'
            or v_observed_candidate_identity ->> 'candidate_pointer_sha256'
              is distinct from v_candidate #>> array[
                'candidate_pointer_identity', 'canonical_sha256'
              ]
            or v_observed_candidate_identity -> 'journal_sha256' is distinct
              from v_candidate -> 'journal_sha256'
            or v_observed_candidate_identity -> 'text_hash' is distinct from
              v_candidate #> array[
                'candidate_pointer_identity', 'projection', 'latest_hashes',
                'text_hash'
              ]
            or v_observed_candidate_identity -> 'image_hash' is distinct from
              v_candidate #> array[
                'candidate_pointer_identity', 'projection', 'latest_hashes',
                'image_hash'
              ]
            or v_observed_candidate_identity -> 'file_hash' is distinct from
              v_candidate #> array[
                'candidate_pointer_identity', 'projection', 'latest_hashes',
                'file_hash'
              ]
            or v_observed_candidate_identity -> 'layout_hash' is distinct from
              v_candidate #> array[
                'candidate_pointer_identity', 'projection', 'latest_hashes',
                'layout_hash'
              ]
          )
        )
        or (
          v_recovery <> 'null'::jsonb
          and (
            v_observed_candidate_identity = 'null'::jsonb
            or v_observed_candidate_identity ->> 'journal_sha256' is distinct
              from v_recovery ->> 'journal_sha256'
          )
        )
        or (
          v_recovery = 'null'::jsonb
          and v_observed_candidate_identity <> 'null'::jsonb
          and v_observed_candidate_identity -> 'journal_sha256' is distinct
            from 'null'::jsonb
        )
      )
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade validation proof is incomplete or contradictory.';
  end if;

  v_expected_journal_action := case
    when (v_validation -> 'evidence') ? 'pointer_commit_journal_binding'
      then v_pointer_journal_binding ->> 'safe_action'
    when (v_validation -> 'evidence') ? 'journal_read_unavailable'
      then 'Keep this source quarantined. Repair access to the durable upgrade journal, obtain and validate its exact fresh state, and reconcile any active journal before any new capture or retry.'
    else null
  end;
  v_expected_candidate_action := case
    when v_mutation_failure ->> 'operation' = 'candidate_enqueue'
      and coalesce(v_mutation_accounting #>> array[
        'evidence', 'candidate_signature'
      ], '') ~ '^[0-9a-f]{64}$'
      then 'reconcile the exact visual-review candidate signature '
        || (v_mutation_accounting #>> array[
          'evidence', 'candidate_signature'
        ])
        || ' and its current terminal/observation state before any retry; do not enqueue a duplicate.'
    when v_mutation_failure ->> 'operation' = 'candidate_enqueue'
      then 'repair the sealed pre-enqueue candidate preparation failure, then retry; exact accounting proves no candidate or database write was attempted.'
    when v_mutation_failure ->> 'operation' = 'pointer_commit'
      and not ((v_validation -> 'evidence') ? 'pointer_commit_receipt')
      then 'verify the current pointer, baseline, source health, and any archived transaction journal against the sealed pointer-commit accounting; retry only if the commit is proven incomplete.'
    else null
  end;
  v_expected_safe_action := case
    when v_expected_journal_action is not null
      and v_expected_candidate_action is not null
      then v_expected_journal_action || ' Also ' || v_expected_candidate_action
    when v_expected_journal_action is not null
      then v_expected_journal_action
    when v_expected_candidate_action is not null
      then 'Keep this source quarantined. ' || v_expected_candidate_action
    else null
  end;
  if v_expected_safe_action is not null
    and p_evidence ->> 'safe_action' is distinct from v_expected_safe_action
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 quarantine safe action contradicts the sealed recovery or mutation evidence.';
  end if;

  if private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_availability,
      array[
        'candidate_artifacts',
        'commit_recovery',
        'r2_binding',
        'validation'
      ]
    ) is not true
    or exists (
      select 1
      from pg_catalog.jsonb_each(v_availability) availability(name, value)
      where private.stage1_evidence_schema_upgrade_has_exact_keys(
          availability.value,
          array['at_failure_stage', 'status', 'unavailable_reason']
        ) is not true
        or availability.value ->> 'at_failure_stage' is distinct from
          p_evidence ->> 'failure_stage'
        or pg_catalog.jsonb_typeof(availability.value -> 'status')
          is distinct from 'string'
        or coalesce(availability.value ->> 'status', '') not in (
          'sealed_present',
          'not_observed',
          'unavailable',
          'verified_absent'
        )
        or (
          availability.value ->> 'status' in (
            'sealed_present', 'verified_absent'
          )
          and availability.value -> 'unavailable_reason' <> 'null'::jsonb
        )
        or (
          availability.value ->> 'status' in ('not_observed', 'unavailable')
          and nullif(
            pg_catalog.btrim(availability.value ->> 'unavailable_reason'),
            ''
          ) is null
        )
    )
    or v_availability #>> array['validation', 'status'] is distinct from
      'sealed_present'
    or (
      v_recovery <> 'null'::jsonb
      and (
        v_journal_read_unavailable is not null
        or v_journal_read_absent is not null
      )
    )
    -- Parentheses keep each CASE nested while PL/pgSQL scans for this IF's THEN.
    or v_availability #>> array['r2_binding', 'status'] is distinct from (
      case
        when v_r2 = 'null'::jsonb then 'not_observed'
        else 'sealed_present'
      end
    )
    or v_availability #>> array['commit_recovery', 'status'] is distinct from
      (
        case
          when v_recovery <> 'null'::jsonb then 'sealed_present'
          when v_journal_read_unavailable is not null then 'unavailable'
          when v_journal_read_absent is not null then 'verified_absent'
          else 'not_observed'
        end
      )
    or v_availability #>> array['candidate_artifacts', 'status'] is distinct
      from (
        case when v_candidate = 'null'::jsonb then 'not_observed'
        else 'sealed_present' end
      )
    or (
      v_r2 = 'null'::jsonb
      and v_availability #>> array['r2_binding', 'unavailable_reason']
        is distinct from 'r2_binding_not_observed_before_failure'
    )
    or (
      v_recovery = 'null'::jsonb
      and v_journal_read_unavailable is null
      and v_journal_read_absent is null
      and v_availability #>> array['commit_recovery', 'unavailable_reason']
        is distinct from
          'durable_upgrade_journal_not_observed_before_failure'
    )
    or (
      v_recovery = 'null'::jsonb
      and v_journal_read_absent is not null
      and v_availability #> array['commit_recovery', 'unavailable_reason']
        is distinct from 'null'::jsonb
    )
    or (
      v_recovery = 'null'::jsonb
      and v_journal_read_unavailable is not null
      and v_availability #>> array['commit_recovery', 'unavailable_reason']
        is distinct from 'durable_upgrade_journal_read_unavailable'
    )
    or (
      v_candidate = 'null'::jsonb
      and v_availability #>> array['candidate_artifacts', 'unavailable_reason']
        is distinct from 'candidate_plan_not_observed_before_failure'
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade stage-specific evidence availability is inconsistent.';
  end if;

  if v_r2 = 'null'::jsonb then
    if p_evidence -> 'r2_binding_sha256' <> 'null'::jsonb then
      raise exception using errcode = '23514',
        message = 'Absent R2 evidence must have a null seal.';
    end if;
  elsif pg_catalog.jsonb_typeof(v_r2) is distinct from 'object'
    or v_r2 ->> 'schema' is distinct from
      'awardping.stage1.evidence-schema-upgrade-r2-binding.v1'
    or v_r2 ->> 'status' is distinct from 'verified'
    or v_r2 ->> 'source_id' is distinct from p_source_id::text
    or v_r2 -> 'creates_api_charge' is distinct from 'false'::jsonb
    or v_r2 -> 'mutation_performed' is distinct from 'false'::jsonb
    or coalesce(v_r2 ->> 'receipt_sha256', '') !~ '^[0-9a-f]{64}$'
    or v_r2 ->> 'receipt_sha256' is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_r2 - 'receipt_sha256'
      )
    or coalesce(v_r2 #>> array['pointer_identity', 'pointer_sha256'], '') !~
      '^[0-9a-f]{64}$'
    or v_r2 #>> array['pointer_identity', 'pointer_sha256'] is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        (v_r2 -> 'pointer_identity') - 'pointer_sha256'
      )
    or coalesce(v_r2 #>> array['previous_pointer', 'projection_sha256'], '') !~
      '^[0-9a-f]{64}$'
    or v_r2 #>> array['previous_pointer', 'projection_sha256'] is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        (v_r2 -> 'previous_pointer') - 'projection_sha256'
      )
    or pg_catalog.jsonb_typeof(v_r2 -> 'verified_roles') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_r2 -> 'verified_roles') < 1
    or coalesce(p_evidence ->> 'r2_binding_sha256', '') !~ '^[0-9a-f]{64}$'
    or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_r2)
      is distinct from p_evidence ->> 'r2_binding_sha256'
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade R2 binding proof is malformed or unsealed.';
  end if;

  if v_candidate = 'null'::jsonb then
    if p_evidence -> 'candidate_artifacts_sha256' <> 'null'::jsonb then
      raise exception using errcode = '23514',
        message = 'Absent candidate-artifact evidence must have a null seal.';
    end if;
  else
    v_candidate_pointer := v_candidate -> 'candidate_pointer_identity';
    v_candidate_projection := v_candidate_pointer -> 'projection';
    v_candidate_keys := v_candidate_projection -> 'latest_object_keys';
    v_candidate_metadata := v_candidate_projection -> 'latest_metadata';
    v_candidate_bindings := v_candidate_metadata -> 'artifact_bindings';
    v_retained_projection :=
      v_candidate_metadata -> 'retained_artifact_projection';
    v_retained_authority := v_retained_projection -> 'authoritative';

    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_candidate,
        array[
          'artifacts',
          'bucket',
          'captured_at',
          'candidate_pointer_identity',
          'creates_api_charge',
          'journal_sha256',
          'kind',
          'public_fact_authority',
          'schema_version',
          'source_id',
          'version'
        ]
      ) is not true
      or v_candidate ->> 'schema_version' is distinct from
        'awardping.stage1.evidence-schema-upgrade-candidate-artifacts.v1'
      or v_candidate ->> 'source_id' is distinct from p_source_id::text
      or pg_catalog.jsonb_typeof(v_candidate -> 'kind') is distinct from
        'string'
      or coalesce(v_candidate ->> 'kind', '') not in ('webpage', 'pdf')
      or coalesce(v_candidate ->> 'bucket', '') = ''
      or coalesce(v_candidate ->> 'version', '') !~ '^[0-9a-f]{32}$'
      or coalesce(v_candidate ->> 'captured_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or pg_catalog.to_char(
        (v_candidate ->> 'captured_at')::timestamptz at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) is distinct from v_candidate ->> 'captured_at'
      or (v_candidate ->> 'captured_at')::timestamptz >
        v_now + interval '5 minutes'
      or not (
        v_candidate -> 'journal_sha256' = 'null'::jsonb
        or coalesce(v_candidate ->> 'journal_sha256', '') ~
          '^[0-9a-f]{64}$'
      )
      or v_candidate -> 'creates_api_charge' is distinct from 'false'::jsonb
      or v_candidate -> 'public_fact_authority' is distinct from 'false'::jsonb
      or pg_catalog.jsonb_typeof(v_candidate -> 'artifacts') is distinct from
        'array'
      or pg_catalog.jsonb_array_length(v_candidate -> 'artifacts') < 1
      or coalesce(p_evidence ->> 'candidate_artifacts_sha256', '') !~
        '^[0-9a-f]{64}$'
      or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_candidate
      ) is distinct from p_evidence ->> 'candidate_artifacts_sha256'
      or private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_candidate_pointer,
        array['canonical_sha256', 'exists', 'projection', 'schema_version']
      ) is not true
      or v_candidate_pointer ->> 'schema_version' is distinct from
        'awardping.visual-snapshot.pointer-identity.v1'
      or v_candidate_pointer -> 'exists' is distinct from 'true'::jsonb
      or coalesce(v_candidate_pointer ->> 'canonical_sha256', '') !~
        '^[0-9a-f]{64}$'
      or private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_candidate_projection,
        array[
          'bucket',
          'kind',
          'latest_captured_at',
          'latest_hashes',
          'latest_metadata',
          'latest_object_keys',
          'previous_captured_at',
          'previous_hashes',
          'previous_metadata',
          'previous_object_keys',
          'shared_award_id',
          'shared_award_source_id',
          'source_page_type',
          'source_title',
          'source_url',
          'updated_at'
        ]
      ) is not true
      or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_candidate_projection
      ) is distinct from v_candidate_pointer ->> 'canonical_sha256'
      or v_candidate_projection ->> 'shared_award_source_id' is distinct from
        p_source_id::text
      or v_candidate_projection ->> 'kind' is distinct from
        v_candidate ->> 'kind'
      or v_candidate_projection ->> 'bucket' is distinct from
        v_candidate ->> 'bucket'
      or v_candidate_projection ->> 'latest_captured_at' is distinct from
        v_candidate ->> 'captured_at'
      or (
        coalesce(v_pointer_journal_binding ->> 'status', '') not in (
          'changed_since_failure',
          'fresh_observation_only'
        )
        and (
          v_validation #>> array['evidence', 'kind'] is distinct from
            v_candidate ->> 'kind'
          or pg_catalog.jsonb_typeof(
            v_validation #> array['evidence', 'capture']
          ) is distinct from 'object'
          or (v_validation #> array['evidence', 'capture']) ?& array[
            'captured_at',
            'file_hash',
            'image_hash',
            'layout_hash',
            'source_id',
            'text_hash'
          ] is not true
          or v_validation #>> array['evidence', 'capture', 'source_id']
            is distinct from p_source_id::text
          or v_validation #>> array['evidence', 'capture', 'captured_at']
            is distinct from v_candidate ->> 'captured_at'
          or v_candidate_projection #> array['latest_hashes', 'text_hash']
            is distinct from
              v_validation #> array['evidence', 'capture', 'text_hash']
          or v_candidate_projection #> array['latest_hashes', 'image_hash']
            is distinct from
              v_validation #> array['evidence', 'capture', 'image_hash']
          or v_candidate_projection #> array['latest_hashes', 'file_hash']
            is distinct from
              v_validation #> array['evidence', 'capture', 'file_hash']
          or v_candidate_projection #> array['latest_hashes', 'layout_hash']
            is distinct from
              v_validation #> array['evidence', 'capture', 'layout_hash']
        )
      )
      or coalesce(v_candidate_projection ->> 'updated_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or pg_catalog.to_char(
        (v_candidate_projection ->> 'updated_at')::timestamptz
          at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) is distinct from v_candidate_projection ->> 'updated_at'
      or not (
        v_candidate_projection -> 'previous_captured_at' = 'null'::jsonb
        or (
          coalesce(
            v_candidate_projection ->> 'previous_captured_at', ''
          ) ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          and pg_catalog.to_char(
            (v_candidate_projection ->> 'previous_captured_at')::timestamptz
              at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) = v_candidate_projection ->> 'previous_captured_at'
        )
      )
      or pg_catalog.jsonb_typeof(v_candidate_keys) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_candidate_projection -> 'latest_hashes')
        is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_candidate_metadata) is distinct from
        'object'
      or v_candidate_metadata ->> 'artifact_bindings_schema' is distinct from
        'awardping.r2.capture-artifact-bindings.v1'
      or pg_catalog.jsonb_typeof(v_candidate_bindings) is distinct from
        'object'
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 candidate pointer identity is malformed, unsealed, or not source/generation bound.';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_candidate -> 'artifacts')
        artifact(value)
      where private.stage1_evidence_schema_upgrade_has_exact_keys(
          artifact.value,
          array[
            'bucket',
            'byte_length',
            'content_type',
            'hash_mode',
            'object_key',
            'role',
            'sha256',
            'version'
          ]
        ) is not true
        or coalesce(artifact.value ->> 'role', '') !~
          '^[a-z][a-z0-9_]{0,63}$'
        or nullif(pg_catalog.btrim(artifact.value ->> 'object_key'), '') is null
        or artifact.value ->> 'object_key' like '/%'
        or artifact.value ->> 'object_key' like '%\\%'
        or ('/' || artifact.value ->> 'object_key' || '/') like '%/../%'
        or coalesce(artifact.value ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
        or pg_catalog.jsonb_typeof(artifact.value -> 'byte_length')
          is distinct from 'number'
        or (artifact.value ->> 'byte_length')::bigint <= 0
        or nullif(pg_catalog.btrim(artifact.value ->> 'content_type'), '') is null
        or artifact.value ->> 'hash_mode' is distinct from 'raw_sha256'
        or artifact.value ->> 'bucket' is distinct from
          v_candidate ->> 'bucket'
        or artifact.value ->> 'version' is distinct from
          v_candidate ->> 'version'
        or artifact.value ->> 'object_key' is distinct from
          'visual-snapshots/sources/' || p_source_id::text || '/captures/' ||
          (v_candidate ->> 'version') || '/' || case
            when artifact.value ->> 'role' = 'page' then 'page.jpg'
            when artifact.value ->> 'role' = 'thumb' then 'thumb.jpg'
            when artifact.value ->> 'role' = 'pdf' then 'document.pdf'
            when artifact.value ->> 'role' = 'text' then 'text.txt'
            when artifact.value ->> 'role' = 'layout' then 'layout.json'
            when artifact.value ->> 'role' = 'meta' then 'meta.json'
            when artifact.value ->> 'role' ~
                '^expansion_state_(0[1-9]|[1-9][0-9]+)$'
              then 'expansion-state-' || pg_catalog.substring(
                artifact.value ->> 'role'
                from '^expansion_state_([0-9]+)$'
              ) || '.jpg'
            when artifact.value ->> 'role' ~
                '^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$'
              then 'expansion-state-' || pg_catalog.substring(
                artifact.value ->> 'role'
                from '^expansion_state_([0-9]+)_layout$'
              ) || '-layout.json'
            else null
          end
        or artifact.value ->> 'content_type' is distinct from case
          when artifact.value ->> 'role' in ('page', 'thumb')
            or artifact.value ->> 'role' ~
              '^expansion_state_(0[1-9]|[1-9][0-9]+)$'
            then 'image/jpeg'
          when artifact.value ->> 'role' = 'pdf' then 'application/pdf'
          when artifact.value ->> 'role' = 'text'
            then 'text/plain; charset=utf-8'
          when artifact.value ->> 'role' in ('layout', 'meta')
            or artifact.value ->> 'role' ~
              '^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$'
            then 'application/json; charset=utf-8'
          else null
        end
        or v_candidate_keys ->> (artifact.value ->> 'role') is distinct from
          artifact.value ->> 'object_key'
        or private.stage1_evidence_schema_upgrade_has_exact_keys(
          v_candidate_bindings -> (artifact.value ->> 'role'),
          array['byte_length', 'content_type', 'hash_mode', 'sha256']
        ) is not true
        or v_candidate_bindings #>> array[
          artifact.value ->> 'role',
          'sha256'
        ] is distinct from artifact.value ->> 'sha256'
        or v_candidate_bindings #>> array[
          artifact.value ->> 'role',
          'byte_length'
        ] is distinct from artifact.value ->> 'byte_length'
        or v_candidate_bindings #>> array[
          artifact.value ->> 'role',
          'content_type'
        ] is distinct from artifact.value ->> 'content_type'
        or v_candidate_bindings #>> array[
          artifact.value ->> 'role',
          'hash_mode'
        ] is distinct from artifact.value ->> 'hash_mode'
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_candidate -> 'artifacts')
        artifact(value)
      group by artifact.value ->> 'role'
      having pg_catalog.count(*) > 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_candidate -> 'artifacts')
        artifact(value)
      group by artifact.value ->> 'object_key'
      having pg_catalog.count(*) > 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_each_text(v_candidate_keys) key_binding(role, key)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_candidate -> 'artifacts')
          artifact(value)
        where artifact.value ->> 'role' = key_binding.role
      )
        or not (v_candidate_bindings ? key_binding.role)
    ) or exists (
      select 1
      from pg_catalog.jsonb_object_keys(v_candidate_bindings) binding_role
      where not (v_candidate_keys ? binding_role)
    ) or exists (
      select 1
      from pg_catalog.jsonb_each_text(v_candidate_keys) key_binding(role, key)
      group by key_binding.key
      having pg_catalog.count(*) > 1
    ) or v_candidate -> 'artifacts' is distinct from (
      select pg_catalog.jsonb_agg(artifact.value order by artifact.value ->> 'role')
      from pg_catalog.jsonb_array_elements(v_candidate -> 'artifacts')
        artifact(value)
    ) then
      raise exception using errcode = '23514',
        message = 'Stage 1 candidate-artifact bindings are malformed, duplicated, unsorted, or not exactly pointer bound.';
    end if;

    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_retained_projection,
        array['authoritative', 'kind', 'localization_status', 'schema']
      ) is not true
      or private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_retained_authority,
        array['expansion_state_count', 'layout_hash', 'layout_retained']
      ) is not true
      or v_retained_projection ->> 'schema' is distinct from
        'awardping.capture-retained-artifact-projection.v1'
      or v_retained_projection ->> 'kind' is distinct from
        v_candidate ->> 'kind'
      or pg_catalog.jsonb_typeof(
        v_retained_authority -> 'expansion_state_count'
      ) is distinct from 'number'
      or (v_retained_authority ->> 'expansion_state_count')::integer < 0
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 candidate retained-artifact projection is incomplete.';
    end if;

    if v_candidate ->> 'kind' = 'pdf' then
      if (
        select pg_catalog.array_agg(role order by role)
        from pg_catalog.jsonb_object_keys(v_candidate_keys) role
      ) is distinct from array['meta', 'pdf', 'text']::text[]
        or v_retained_projection ->> 'localization_status' is distinct from
          'not_applicable_pdf'
        or v_retained_authority -> 'layout_retained' is distinct from
          'false'::jsonb
        or v_retained_authority -> 'layout_hash' is distinct from 'null'::jsonb
        or (v_retained_authority ->> 'expansion_state_count')::integer <> 0
      then
        raise exception using errcode = '23514',
          message = 'Stage 1 candidate PDF topology or retained-artifact projection is invalid.';
      end if;
    else
      if not (v_candidate_keys ?& array['meta', 'page', 'text', 'thumb'])
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(v_candidate_keys) role
          where role not in ('layout', 'meta', 'page', 'text', 'thumb')
            and role !~
              '^expansion_state_(0[1-9]|[1-9][0-9]+)(_layout)?$'
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(v_candidate_keys) role
          where role ~ '^expansion_state_(0[1-9]|[1-9][0-9]+)$'
            and not (v_candidate_keys ? (role || '_layout'))
        )
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(v_candidate_keys) role
          where role ~
              '^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$'
            and not (
              v_candidate_keys ? pg_catalog.regexp_replace(
                role,
                '_layout$',
                ''
              )
            )
        )
        or exists (
          select 1
          from pg_catalog.generate_series(
            1,
            (v_retained_authority ->> 'expansion_state_count')::integer
          ) expansion(index)
          where not (
            v_candidate_keys ? (
              'expansion_state_' || pg_catalog.lpad(expansion.index::text, 2, '0')
            )
          )
        )
        or (
          select pg_catalog.count(*)
          from pg_catalog.jsonb_object_keys(v_candidate_keys) role
          where role ~ '^expansion_state_(0[1-9]|[1-9][0-9]+)$'
        ) <> (v_retained_authority ->> 'expansion_state_count')::integer
        or (v_retained_authority -> 'layout_retained') is distinct from
          pg_catalog.to_jsonb(v_candidate_keys ? 'layout')
        or (
          v_candidate_keys ? 'layout'
          and (
            v_retained_projection ->> 'localization_status' is distinct from
              'exact_geometry_available'
            or coalesce(v_retained_authority ->> 'layout_hash', '') !~
              '^[0-9a-f]{64}$'
            or v_retained_authority ->> 'layout_hash' is distinct from
              v_candidate_projection #>> array['latest_hashes', 'layout_hash']
          )
        )
        or (
          not (v_candidate_keys ? 'layout')
          and (
            v_retained_projection ->> 'localization_status' is distinct from
              'evidence_only_geometry_unavailable'
            or v_retained_authority -> 'layout_hash' is distinct from
              'null'::jsonb
            or v_candidate_projection #> array['latest_hashes', 'layout_hash']
              is distinct from 'null'::jsonb
          )
        )
      then
        raise exception using errcode = '23514',
          message = 'Stage 1 candidate webpage topology, expansion pairs, or layout availability is invalid.';
      end if;
    end if;
  end if;

  if v_recovery = 'null'::jsonb then
    if p_evidence -> 'commit_recovery_sha256' <> 'null'::jsonb then
      raise exception using errcode = '23514',
        message = 'Absent commit-recovery evidence must have a null seal.';
    end if;
    if v_candidate <> 'null'::jsonb
      and v_candidate -> 'journal_sha256' <> 'null'::jsonb
    then
      raise exception using errcode = '23514',
        message = 'A pre-journal candidate plan must explicitly bind to journal absence.';
    end if;
  else
    v_journal := v_recovery -> 'journal';
    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_recovery,
        array[
          'context',
          'creates_api_charge',
          'journal',
          'journal_sha256',
          'reason',
          'safe_action',
          'schema_version',
          'source_id',
          'status'
        ]
      ) is not true
      or v_recovery ->> 'schema_version' is distinct from
        'awardping.stage1.evidence-schema-upgrade-recovery-evidence.v1'
      or v_recovery ->> 'source_id' is distinct from p_source_id::text
      or v_recovery ->> 'context' is distinct from
        'stage1_evidence_schema_upgrade'
      or v_recovery -> 'creates_api_charge' is distinct from 'false'::jsonb
      or v_recovery ->> 'status' is distinct from 'recovery_required'
      or v_recovery ->> 'reason' is distinct from case
        when v_pointer_commit_receipt is not null
          and v_pointer_commit_receipt ->> 'journal_sha256' =
            v_recovery ->> 'journal_sha256'
          then v_pointer_commit_receipt ->> 'outcome'
        else 'fresh_active_upgrade_journal_requires_reconciliation'
      end
      or v_recovery ->> 'safe_action' is distinct from
        'Keep the source quarantined and reconcile this exact freshly verified journal before retrying.'
      or coalesce(v_recovery ->> 'journal_sha256', '') !~
        '^[0-9a-f]{64}$'
      or coalesce(p_evidence ->> 'commit_recovery_sha256', '') !~
        '^[0-9a-f]{64}$'
      or private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_recovery
      ) is distinct from p_evidence ->> 'commit_recovery_sha256'
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 commit-recovery evidence is malformed or unsealed.';
    end if;

    if v_candidate = 'null'::jsonb
      or private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_journal,
        array[
          'candidate_baseline',
          'candidate_object_keys',
          'candidate_pointer_identity',
          'created_at',
          'journal_sha256',
          'old_baseline',
          'old_pointer_identity',
          'phase',
          'phase_history',
          'schema_version',
          'source_id',
          'transaction_id',
          'updated_at'
        ]
      ) is not true
      or v_journal ->> 'schema_version' is distinct from
        'awardping.stage1.evidence-schema-upgrade-journal.v1'
      or v_journal ->> 'source_id' is distinct from p_source_id::text
      or nullif(pg_catalog.btrim(v_journal ->> 'transaction_id'), '') is null
      or coalesce(v_journal ->> 'created_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or pg_catalog.to_char(
        (v_journal ->> 'created_at')::timestamptz at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) is distinct from v_journal ->> 'created_at'
      or coalesce(v_journal ->> 'updated_at', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or pg_catalog.to_char(
        (v_journal ->> 'updated_at')::timestamptz at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) is distinct from v_journal ->> 'updated_at'
      or pg_catalog.jsonb_typeof(v_journal -> 'phase') is distinct from
        'string'
      or coalesce(v_journal ->> 'phase', '') not in (
        'prepared',
        'local_candidate_written',
        'pointer_cas_attempted',
        'pointer_candidate_committed',
        'completed',
        'recovery_required'
      )
      or (v_journal ->> 'created_at')::timestamptz >
        (v_journal ->> 'updated_at')::timestamptz
      or v_journal ->> 'journal_sha256' is distinct from
        v_recovery ->> 'journal_sha256'
      or v_journal ->> 'journal_sha256' is distinct from
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_journal - 'journal_sha256'
        )
      or v_candidate ->> 'journal_sha256' is distinct from
        v_journal ->> 'journal_sha256'
      or v_journal -> 'candidate_pointer_identity' is distinct from
        v_candidate_pointer
      or v_journal -> 'candidate_object_keys' is distinct from
        v_candidate_keys
      or pg_catalog.jsonb_typeof(v_journal -> 'phase_history') is distinct from
        'array'
      or pg_catalog.jsonb_array_length(v_journal -> 'phase_history') < 1
      or v_journal #>> array['phase_history', '0', 'phase'] is distinct from
        'prepared'
      or v_journal #>> array['phase_history', '-1', 'phase'] is distinct from
        v_journal ->> 'phase'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_journal -> 'phase_history')
          history(value)
        where private.stage1_evidence_schema_upgrade_has_exact_keys(
          history.value,
          array['at', 'detail', 'phase']
        ) is not true
          or pg_catalog.jsonb_typeof(history.value -> 'phase') is distinct from
            'string'
          or coalesce(history.value ->> 'phase', '') not in (
            'prepared',
            'local_candidate_written',
            'pointer_cas_attempted',
            'pointer_candidate_committed',
            'completed',
            'recovery_required'
          )
          or not (
            history.value -> 'detail' = 'null'::jsonb
            or pg_catalog.jsonb_typeof(history.value -> 'detail') = 'object'
          )
          or nullif(history.value ->> 'at', '') is null
          or coalesce(history.value ->> 'at', '') !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          or pg_catalog.to_char(
            (history.value ->> 'at')::timestamptz at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) is distinct from history.value ->> 'at'
          or (history.value ->> 'at')::timestamptz <
            (v_journal ->> 'created_at')::timestamptz
          or (history.value ->> 'at')::timestamptz >
            (v_journal ->> 'updated_at')::timestamptz
      )
      or exists (
        select 1
        from (
          select
            history.value,
            history.ordinality,
            pg_catalog.lag(history.value ->> 'phase') over (
              order by history.ordinality
            ) as previous_phase,
            pg_catalog.lag((history.value ->> 'at')::timestamptz) over (
              order by history.ordinality
            ) as previous_at
          from pg_catalog.jsonb_array_elements(v_journal -> 'phase_history')
            with ordinality history(value, ordinality)
        ) ordered
        where ordered.ordinality > 1
          and (
            (ordered.value ->> 'at')::timestamptz < ordered.previous_at
            or coalesce(case ordered.previous_phase
              when 'prepared' then ordered.value ->> 'phase' in (
                'local_candidate_written', 'recovery_required'
              )
              when 'local_candidate_written' then ordered.value ->> 'phase' in (
                'pointer_cas_attempted', 'recovery_required'
              )
              when 'pointer_cas_attempted' then ordered.value ->> 'phase' in (
                'pointer_candidate_committed', 'recovery_required'
              )
              when 'pointer_candidate_committed' then ordered.value ->> 'phase'
                in ('completed', 'recovery_required')
              when 'completed' then ordered.value ->> 'phase' =
                'recovery_required'
              when 'recovery_required' then ordered.value ->> 'phase' in (
                'pointer_candidate_committed', 'completed'
              )
              else false
            end, false) is not true
          )
      )
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 active-journal recovery evidence has an invalid journal identity, history, candidate pointer, or seal.';
    end if;

    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_journal -> 'candidate_baseline',
        array['byte_length', 'bytes_base64', 'encoding', 'present', 'sha256']
      ) is not true
      or v_journal #> array['candidate_baseline', 'present'] is distinct from
        'true'::jsonb
      or v_journal #>> array['candidate_baseline', 'encoding'] is distinct from
        'base64'
      or coalesce(v_journal #>> array['candidate_baseline', 'sha256'], '') !~
        '^[0-9a-f]{64}$'
      or (v_journal #>> array['candidate_baseline', 'byte_length'])::bigint < 1
      or pg_catalog.replace(pg_catalog.replace(
        pg_catalog.encode(pg_catalog.decode(
          v_journal #>> array['candidate_baseline', 'bytes_base64'],
          'base64'
        ), 'base64'),
        E'\n',
        ''
      ), E'\r', '') is distinct from
        v_journal #>> array['candidate_baseline', 'bytes_base64']
      or pg_catalog.octet_length(pg_catalog.decode(
        v_journal #>> array['candidate_baseline', 'bytes_base64'],
        'base64'
      )) is distinct from
        (v_journal #>> array['candidate_baseline', 'byte_length'])::integer
      or private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(
        v_journal #>> array['candidate_baseline', 'bytes_base64']
      ) is distinct from v_journal #>> array['candidate_baseline', 'sha256']
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 active journal candidate-baseline bytes are not exactly sealed.';
    end if;

    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_journal -> 'old_baseline',
        array['byte_length', 'bytes_base64', 'encoding', 'present', 'sha256']
      ) is not true
      or not (
        (
          v_journal #> array['old_baseline', 'present'] = 'false'::jsonb
          and v_journal #> array['old_baseline', 'encoding'] = 'null'::jsonb
          and v_journal #> array['old_baseline', 'bytes_base64'] = 'null'::jsonb
          and v_journal #> array['old_baseline', 'byte_length'] = '0'::jsonb
          and v_journal #> array['old_baseline', 'sha256'] = 'null'::jsonb
        )
        or (
          v_journal #> array['old_baseline', 'present'] = 'true'::jsonb
          and v_journal #>> array['old_baseline', 'encoding'] = 'base64'
          and coalesce(v_journal #>> array['old_baseline', 'sha256'], '') ~
            '^[0-9a-f]{64}$'
          and (v_journal #>> array['old_baseline', 'byte_length'])::bigint >= 0
          and pg_catalog.replace(pg_catalog.replace(
            pg_catalog.encode(pg_catalog.decode(
              v_journal #>> array['old_baseline', 'bytes_base64'],
              'base64'
            ), 'base64'),
            E'\n',
            ''
          ), E'\r', '') =
            v_journal #>> array['old_baseline', 'bytes_base64']
          and pg_catalog.octet_length(pg_catalog.decode(
            v_journal #>> array['old_baseline', 'bytes_base64'],
            'base64'
          )) = (v_journal #>> array['old_baseline', 'byte_length'])::integer
          and private.stage1_evidence_schema_upgrade_quarantine_base64_sha256(
            v_journal #>> array['old_baseline', 'bytes_base64']
          ) = v_journal #>> array['old_baseline', 'sha256']
        )
      )
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 active journal old-baseline bytes are not exactly sealed.';
    end if;

    if private.stage1_evidence_schema_upgrade_has_exact_keys(
        v_journal -> 'old_pointer_identity',
        array['canonical_sha256', 'exists', 'projection', 'schema_version']
      ) is not true
      or v_journal #>> array['old_pointer_identity', 'schema_version']
        is distinct from 'awardping.visual-snapshot.pointer-identity.v1'
      or not (
        (
          v_journal #> array['old_pointer_identity', 'exists'] = 'false'::jsonb
          and v_journal #> array['old_pointer_identity', 'canonical_sha256'] =
            'null'::jsonb
          and v_journal #> array['old_pointer_identity', 'projection'] =
            'null'::jsonb
        )
        or (
          v_journal #> array['old_pointer_identity', 'exists'] = 'true'::jsonb
          and coalesce(
            v_journal #>> array['old_pointer_identity', 'canonical_sha256'],
            ''
          ) ~ '^[0-9a-f]{64}$'
          and private.stage1_evidence_schema_upgrade_has_exact_keys(
            v_journal #> array['old_pointer_identity', 'projection'],
            array[
              'bucket', 'kind', 'latest_captured_at', 'latest_hashes',
              'latest_metadata', 'latest_object_keys', 'previous_captured_at',
              'previous_hashes', 'previous_metadata', 'previous_object_keys',
              'shared_award_id', 'shared_award_source_id', 'source_page_type',
              'source_title', 'source_url', 'updated_at'
            ]
          )
          and v_journal #>> array[
            'old_pointer_identity', 'projection', 'shared_award_source_id'
          ] = p_source_id::text
          and coalesce(v_journal #>> array[
            'old_pointer_identity', 'projection', 'latest_captured_at'
          ], '') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          and pg_catalog.to_char(
            (v_journal #>> array[
              'old_pointer_identity', 'projection', 'latest_captured_at'
            ])::timestamptz at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) = v_journal #>> array[
            'old_pointer_identity', 'projection', 'latest_captured_at'
          ]
          and coalesce(v_journal #>> array[
            'old_pointer_identity', 'projection', 'updated_at'
          ], '') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          and pg_catalog.to_char(
            (v_journal #>> array[
              'old_pointer_identity', 'projection', 'updated_at'
            ])::timestamptz at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) = v_journal #>> array[
            'old_pointer_identity', 'projection', 'updated_at'
          ]
          and (
            v_journal #> array[
              'old_pointer_identity', 'projection', 'previous_captured_at'
            ] = 'null'::jsonb
            or (
              coalesce(v_journal #>> array[
                'old_pointer_identity', 'projection', 'previous_captured_at'
              ], '') ~
                '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
              and pg_catalog.to_char(
                (v_journal #>> array[
                  'old_pointer_identity', 'projection',
                  'previous_captured_at'
                ])::timestamptz at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) = v_journal #>> array[
                'old_pointer_identity', 'projection', 'previous_captured_at'
              ]
            )
          )
          and private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
            v_journal #> array['old_pointer_identity', 'projection']
          ) = v_journal #>> array[
            'old_pointer_identity', 'canonical_sha256'
          ]
        )
      )
    then
      raise exception using errcode = '23514',
        message = 'Stage 1 active journal old-pointer identity is malformed or unsealed.';
    end if;
  end if;

  -- Match the source-release fence's global -> operation -> row lock order.
  -- The source UPDATE trigger reacquires the global lock reentrantly.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stage1-national-25-release', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stage1-evidence-schema-upgrade-quarantine:' || p_acquisition_id::text,
      0
    )
  );

  select source.* into strict v_source
  from public.shared_award_sources source
  join public.shared_awards award on award.id = source.shared_award_id
  where source.id = p_source_id
    and award.status = 'active'
  for update of source;

  v_observed_at := pg_catalog.clock_timestamp();
  v_initial_open := v_source.admin_review_status = 'open';

  if not (
      v_source.admin_review_status = 'open'
      and v_source.admin_review_note = 'exact_first_visual_baseline_verified'
      and v_source.admin_reviewed_by = 'stage1-baseline-activation-receipt'
    ) and not (
      v_source.admin_review_status = 'review_later'
      and v_source.admin_reviewed_by =
        'stage1-evidence-schema-upgrade-quarantine'
      and v_source.admin_review_note like
        'stage1_evidence_schema_upgrade_failed:%'
      and pg_catalog.length(v_source.admin_review_note) >
        pg_catalog.length('stage1_evidence_schema_upgrade_failed:')
    )
  then
    raise exception using errcode = '55000',
      message = 'The Stage 1 evidence-schema-upgrade source is not in its finalized or worker-owned quarantine state.';
  end if;

  select acquisition.* into strict v_acquisition
  from public.shared_award_source_acquisitions acquisition
  where acquisition.id = p_acquisition_id
    and acquisition.shared_award_source_id = p_source_id
    and acquisition.origin_source_page_request_id = p_request_id;

  select item.* into strict v_item
  from private.stage1_source_disposition_items item
  where item.source_acquisition_id = p_acquisition_id
    and item.shared_award_source_id = p_source_id
    and item.request_id = p_request_id
    and item.item_number = v_expected_item
    and item.decision = 'approve_baseline_only'
    and item.decision_item_sha256 =
      v_source_binding ->> 'disposition_item_sha256';

  select bundle.* into strict v_bundle
  from private.stage1_source_disposition_bundles bundle
  where bundle.bundle_sha256 = v_item.bundle_sha256
    and bundle.bundle_sha256 =
      'a3825703fd736cea3ca38a3294a7d0378c94316b828820ee138336ecc6777acb'
    and bundle.confirmation_sha256 =
      'b967506e8cb67f1f9315d9b9ece9a5a8bd658e34bb5452c769e801c8f7703866'
    and bundle.evidence_packet_sha256 =
      '8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f'
    and bundle.approved_count = 10
    and bundle.quarantined_count = 1
    and bundle.item_count = 11;

  v_disposition := v_acquisition.review_seal -> 'human_source_disposition';
  v_guard := v_disposition -> 'activation_guard';
  if v_disposition ->> 'guard_sha256' is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_disposition - 'guard_sha256'
      )
    or v_disposition ->> 'guard_sha256' is distinct from
      v_source_binding ->> 'guard_sha256'
    or v_guard ->> 'shared_award_source_id' is distinct from p_source_id::text
    or v_guard ->> 'shared_award_source_acquisition_id'
      is distinct from p_acquisition_id::text
    or v_guard ->> 'source_page_request_id' is distinct from p_request_id::text
    or v_guard ->> 'decision_item_sha256' is distinct from
      v_item.decision_item_sha256
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade failure is not bound to the immutable human disposition.';
  end if;

  select finalized.* into strict v_finalization
  from private.stage1_source_baseline_activation_finalizations finalized
  where finalized.source_acquisition_id = p_acquisition_id
    and finalized.shared_award_source_id = p_source_id
    and finalized.source_page_request_id = p_request_id
    and finalized.disposition_item_sha256 = v_item.decision_item_sha256
    and finalized.guard_sha256 = v_disposition ->> 'guard_sha256'
    and finalized.finalization_receipt_sha256 =
      v_source_binding ->> 'finalization_receipt_sha256';

  if private.stage1_evidence_schema_upgrade_has_exact_keys(
      v_finalization.receipt,
      array[
        'creates_api_charge',
        'decision_item_sha256',
        'finalized_at',
        'guard_sha256',
        'observed_normalized_text_sha256',
        'persistence_evidence_sha256',
        'prepare_receipt_sha256',
        'public_fact_authority',
        'schema_version',
        'shared_award_source_id',
        'source_acquisition_id',
        'source_page_request_id',
        'status'
      ]
    ) is not true
    or v_finalization.receipt ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-activation-finalization-receipt.v1'
    or v_finalization.receipt ->> 'status' is distinct from 'finalized_open'
    or v_finalization.receipt -> 'creates_api_charge' is distinct from
      'false'::jsonb
    or v_finalization.receipt -> 'public_fact_authority' is distinct from
      'false'::jsonb
    or v_finalization.receipt ->> 'shared_award_source_id' is distinct from
      v_finalization.shared_award_source_id::text
    or v_finalization.receipt ->> 'source_acquisition_id' is distinct from
      v_finalization.source_acquisition_id::text
    or v_finalization.receipt ->> 'source_page_request_id' is distinct from
      v_finalization.source_page_request_id::text
    or v_finalization.receipt ->> 'decision_item_sha256' is distinct from
      v_finalization.disposition_item_sha256
    or v_finalization.receipt ->> 'prepare_receipt_sha256' is distinct from
      v_finalization.prepare_receipt_sha256
    or v_finalization.receipt ->> 'guard_sha256' is distinct from
      v_finalization.guard_sha256
    or v_finalization.receipt ->> 'observed_normalized_text_sha256'
      is distinct from v_finalization.observed_normalized_text_sha256
    or v_finalization.receipt ->> 'persistence_evidence_sha256'
      is distinct from
        private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
          v_finalization.persistence_evidence
        )
    or v_finalization.finalization_receipt_sha256 is distinct from
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_finalization.receipt
      )
    or (v_finalization.receipt ->> 'finalized_at')::timestamptz is distinct from
      v_finalization.finalized_at
    or (
      v_initial_open
      and v_source.admin_reviewed_at is distinct from v_finalization.finalized_at
    )
  then
    raise exception using errcode = '23514',
      message = 'Stage 1 evidence-schema-upgrade failure is not bound to the exact immutable finalized-open activation receipt and timestamp.';
  end if;

  v_submitted_evidence_sha256 := p_evidence ->> 'evidence_sha256';
  select failure.* into v_existing
  from private.stage1_evidence_schema_upgrade_failures failure
  where failure.submitted_evidence_sha256 = v_submitted_evidence_sha256;

  if found then
    if v_existing.shared_award_source_id is distinct from p_source_id
      or v_existing.source_acquisition_id is distinct from p_acquisition_id
      or v_existing.source_page_request_id is distinct from p_request_id
      or v_existing.reason_code is distinct from p_reason_code
      or v_existing.failure_stage is distinct from
        p_evidence ->> 'failure_stage'
      or v_existing.disposition_item_sha256 is distinct from
        v_item.decision_item_sha256
      or v_existing.finalization_receipt_sha256 is distinct from
        v_finalization.finalization_receipt_sha256
    then
      raise exception using errcode = '40001',
        message = 'The Stage 1 upgrade failure evidence seal collides with another immutable binding.';
    end if;
    v_failure_sha256 := v_existing.failure_sha256;
    v_now := v_existing.recorded_at;
  else
    v_failure_evidence := p_evidence || pg_catalog.jsonb_build_object(
      'server_binding', pg_catalog.jsonb_build_object(
        'shared_award_source_id', p_source_id,
        'source_acquisition_id', p_acquisition_id,
        'source_page_request_id', p_request_id,
        'disposition_item_sha256', v_item.decision_item_sha256,
        'finalization_receipt_sha256',
          v_finalization.finalization_receipt_sha256,
        'manifest_sha256', p_evidence ->> 'manifest_sha256',
        'policy_sha256', p_evidence ->> 'policy_sha256'
      ),
      'recorded_at', v_now
    );
    v_failure_sha256 :=
      private.stage1_evidence_schema_upgrade_quarantine_json_sha256(
        v_failure_evidence
      );

    insert into private.stage1_evidence_schema_upgrade_failures (
      failure_sha256,
      submitted_evidence_sha256,
      shared_award_source_id,
      source_acquisition_id,
      source_page_request_id,
      disposition_item_sha256,
      finalization_receipt_sha256,
      manifest_sha256,
      policy_sha256,
      reason_code,
      failure_stage,
      evidence,
      recorded_at
    ) values (
      v_failure_sha256,
      v_submitted_evidence_sha256,
      p_source_id,
      p_acquisition_id,
      p_request_id,
      v_item.decision_item_sha256,
      v_finalization.finalization_receipt_sha256,
      p_evidence ->> 'manifest_sha256',
      p_evidence ->> 'policy_sha256',
      p_reason_code,
      p_evidence ->> 'failure_stage',
      v_failure_evidence,
      v_now
    );
    v_audit_inserted := true;
  end if;

  if v_initial_open then
    select pg_catalog.count(*)::integer
    into v_publication_registry_writes
    from public.stage1_award_registry registry
    where registry.publication_state = 'verified_beta'
      and exists (
        select 1
        from public.stage1_award_source_manifest manifest
        where manifest.cohort_key = registry.cohort_key
          and p_source_id = any(manifest.source_ids)
      );
    v_publication_event_writes := v_publication_registry_writes;
    if v_publication_registry_writes > 0 then
      select pg_catalog.count(*)::integer
      into v_release_registry_writes
      from public.stage1_award_registry registry
      where registry.release_epoch is not null;

      select pg_catalog.count(*)::integer
      into v_release_state_writes
      from public.stage1_publication_release_state release_state
      where release_state.release_key = 'stage1-national-25'
        and (
          release_state.release_state = 'verified_beta'
          or release_state.release_epoch is not null
        );
      v_release_event_writes := v_release_state_writes;

      -- The existing source invalidation trigger changes publication_state
      -- before the release helper clears release_epoch. Clear only the exact
      -- affected verified rows first so the registry check constraint remains
      -- true; the trigger then performs the mandatory safety invalidation.
      update public.stage1_award_registry registry
      set
        release_epoch = null,
        updated_at = pg_catalog.greatest(registry.updated_at, v_observed_at)
      where registry.publication_state = 'verified_beta'
        and registry.release_epoch is not null
        and exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = registry.cohort_key
            and p_source_id = any(manifest.source_ids)
        );
    end if;
  end if;
  v_publication_safety_writes :=
    v_publication_registry_writes
    + v_publication_event_writes
    + v_release_registry_writes
    + v_release_state_writes
    + v_release_event_writes;
  v_database_writes :=
    case when v_audit_inserted then 1 else 0 end
    + 1 -- shared_award_sources
    + 3 -- quarantine registry, registry event, and backlog state
    + v_publication_safety_writes;

  update public.shared_award_sources source
  set
    admin_review_status = 'review_later',
    admin_review_note =
      'stage1_evidence_schema_upgrade_failed:' || p_reason_code,
    admin_reviewed_at = pg_catalog.greatest(
      source.admin_reviewed_at,
      v_observed_at
    ),
    admin_reviewed_by = 'stage1-evidence-schema-upgrade-quarantine',
    last_error = 'Stage 1 evidence-schema upgrade failed: ' ||
      coalesce(nullif(p_evidence ->> 'detail', ''), p_reason_code),
    consecutive_failures = greatest(source.consecutive_failures, 1),
    updated_at = pg_catalog.greatest(source.updated_at, v_observed_at)
  where source.id = p_source_id;
  if not found then
    raise exception using errcode = '40001',
      message = 'The Stage 1 evidence-schema-upgrade source re-hold failed.';
  end if;

  v_quarantine_evidence := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-quarantine.v1',
    'failure_sha256', v_failure_sha256,
    'evidence_sha256', v_submitted_evidence_sha256,
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', p_request_id,
    'disposition_item_sha256', v_item.decision_item_sha256,
    'finalization_receipt_sha256',
      v_finalization.finalization_receipt_sha256,
    'manifest_sha256', p_evidence ->> 'manifest_sha256',
    'policy_sha256', p_evidence ->> 'policy_sha256',
    'reason_code', p_reason_code,
    'failure_stage', p_evidence ->> 'failure_stage',
    'failure_evidence', p_evidence,
    'public_fact_authority', false,
    'creates_api_charge', false
  );

  insert into public.manual_quarantine_registry (
    quarantine_key,
    case_key,
    classification,
    category,
    status,
    requires_action,
    terminal,
    terminal_failure_count,
    severity,
    public_impact,
    owner,
    retry_mode,
    retry_charge,
    title,
    reason_code,
    reason,
    recommended_action,
    shared_award_id,
    shared_award_source_id,
    primary_source_table,
    primary_source_record_id,
    evidence_record_count,
    evidence,
    evidence_hash,
    policy_id,
    policy_version,
    policy_hash,
    first_observed_at,
    last_observed_at
  ) values (
    'stage1:evidence-schema-upgrade:' || p_source_id::text,
    'stage1:evidence-schema-upgrade:' || p_source_id::text,
    'actionable_quarantine',
    'visual_review',
    'quarantined',
    true,
    true,
    1,
    'high',
    'protected',
    'stage1-visual-owner',
    'Retry only after the sealed evidence shown here is repaired; recovery and capture retries remain zero-charge.',
    'none',
    'Stage 1 evidence-schema upgrade failed',
    p_reason_code,
    coalesce(nullif(p_evidence ->> 'detail', ''), p_reason_code),
    p_evidence ->> 'safe_action',
    v_source.shared_award_id,
    p_source_id,
    'shared_award_sources',
    p_source_id,
    1,
    v_quarantine_evidence,
    public.manual_quarantine_evidence_hash(v_quarantine_evidence),
    'awardping-stage1-evidence-schema-upgrade-quarantine',
    '1',
    '1921da9c76a2e02665eee8e5f6df2bc0216273e31acb13d5d75a7da99c6a3f6c',
    v_now,
    v_observed_at
  )
  on conflict (quarantine_key) do update
  set
    case_key = excluded.case_key,
    classification = 'actionable_quarantine',
    category = 'visual_review',
    status = 'quarantined',
    requires_action = true,
    terminal = true,
    terminal_failure_count = 1,
    severity = 'high',
    public_impact = 'protected',
    owner = 'stage1-visual-owner',
    retry_mode = excluded.retry_mode,
    retry_charge = 'none',
    title = 'Stage 1 evidence-schema upgrade failed',
    reason_code = excluded.reason_code,
    reason = excluded.reason,
    recommended_action = excluded.recommended_action,
    shared_award_id = excluded.shared_award_id,
    shared_award_source_id = excluded.shared_award_source_id,
    primary_source_table = excluded.primary_source_table,
    primary_source_record_id = excluded.primary_source_record_id,
    evidence_record_count = public.manual_quarantine_registry.evidence_record_count
      + case when v_audit_inserted then 1 else 0 end,
    evidence = excluded.evidence,
    evidence_hash = excluded.evidence_hash,
    policy_id = excluded.policy_id,
    policy_version = excluded.policy_version,
    policy_hash = excluded.policy_hash,
    last_observed_at = pg_catalog.greatest(
      public.manual_quarantine_registry.last_observed_at
        + interval '1 microsecond',
      excluded.last_observed_at
    ),
    quarantined_at = case
      when public.manual_quarantine_registry.status = 'resolved'
        then pg_catalog.greatest(
          public.manual_quarantine_registry.quarantined_at,
          excluded.last_observed_at
        )
      else public.manual_quarantine_registry.quarantined_at
    end,
    resolved_at = null,
    resolved_by = null,
    resolution_note = null
  returning id, last_observed_at into v_quarantine_id, v_observed_at;

  v_receipt := pg_catalog.jsonb_build_object(
    'schema_version',
      'awardping.stage1.evidence-schema-upgrade-quarantine-receipt.v1',
    'status', 'quarantined',
    'quarantine_id', v_quarantine_id,
    'failure_sha256', v_failure_sha256,
    'evidence_sha256', v_submitted_evidence_sha256,
    'shared_award_source_id', p_source_id,
    'source_acquisition_id', p_acquisition_id,
    'source_page_request_id', p_request_id,
    'reason_code', p_reason_code,
    'failure_stage', p_evidence ->> 'failure_stage',
    'mutation_count_scope', 'quarantine_rpc_only',
    'mutation_counts', pg_catalog.jsonb_build_object(
      'database_writes', v_database_writes,
      'failure_audit_writes', case when v_audit_inserted then 1 else 0 end,
      'r2_writes', 0,
      'local_baseline_writes', 0,
      'candidate_writes', 0,
      'quarantine_writes', 3,
      'publication_safety_writes', v_publication_safety_writes,
      'source_state_writes', 1
    ),
    'release_safety', pg_catalog.jsonb_build_object(
      'manual_quarantine_event_writes', 1,
      'manual_quarantine_backlog_state_writes', 1,
      'stage1_award_registry_writes', v_publication_registry_writes,
      'stage1_award_publication_event_writes', v_publication_event_writes,
      'stage1_publication_invalidated', v_publication_registry_writes > 0,
      'stage1_release_registry_writes', v_release_registry_writes,
      'stage1_release_state_writes', v_release_state_writes,
      'stage1_release_event_writes', v_release_event_writes,
      'stage1_release_invalidated',
        v_release_registry_writes > 0 or v_release_state_writes > 0
    ),
    'source_reheld', true,
    'audit_inserted', v_audit_inserted,
    'creates_api_charge', false,
    'public_fact_authority', false,
    'public_award_update_created', false,
    'recorded_at', v_now,
    'observed_at', v_observed_at
  );
  v_receipt_sha256 :=
    private.stage1_evidence_schema_upgrade_quarantine_json_sha256(v_receipt);

  return v_receipt || pg_catalog.jsonb_build_object(
    'receipt_sha256', v_receipt_sha256
  );
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
  then
    raise exception using errcode = '22023',
      message = 'Stage 1 evidence-schema-upgrade quarantine evidence contains an invalid typed value.';
end;
$$;

alter function public.quarantine_stage1_evidence_schema_upgrade_failure(
  uuid, uuid, uuid, text, jsonb
) owner to postgres;
revoke all on function public.quarantine_stage1_evidence_schema_upgrade_failure(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.quarantine_stage1_evidence_schema_upgrade_failure(
  uuid, uuid, uuid, text, jsonb
) to service_role;

comment on function public.quarantine_stage1_evidence_schema_upgrade_failure(
  uuid, uuid, uuid, text, jsonb
) is
  'Atomically validates full sealed reviewed-nine Stage 1 evidence-schema-upgrade failure proof, inserts immutable audit evidence, re-holds the source, and reopens its zero-charge operator quarantine.';

do $stage1_evidence_schema_upgrade_quarantine_catalog_guard$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.quarantine_stage1_evidence_schema_upgrade_failure(uuid,uuid,uuid,text,jsonb)'
  );
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
begin
  if v_function_oid is null
    or v_service_role_oid is null
    or not exists (
      select 1
      from pg_catalog.pg_proc target
      where target.oid = v_function_oid
        and pg_catalog.pg_get_userbyid(target.proowner) = 'postgres'
        and target.provolatile = 'v'
        and not target.prosecdef
        and target.proconfig is not distinct from
          array['search_path=""']::text[]
        and pg_catalog.has_function_privilege(
          'service_role', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'anon', target.oid, 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', target.oid, 'EXECUTE'
        )
        and not exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              target.proacl,
              pg_catalog.acldefault('f', target.proowner)
            )
          ) privilege
          where privilege.grantee = 0
            or privilege.grantee not in (target.proowner, v_service_role_oid)
            or privilege.privilege_type <> 'EXECUTE'
            or (
              privilege.grantee = v_service_role_oid
              and privilege.is_grantable
            )
        )
    )
  then
    raise exception using errcode = '55000',
      message = 'Stage 1 evidence-schema-upgrade quarantine RPC owner, security, volatility, search path, or ACL is unsafe.';
  end if;

  if not exists (
      select 1
      from pg_catalog.pg_policy policy
      where policy.polrelid =
          'private.stage1_evidence_schema_upgrade_failures'::regclass
        and policy.polcmd = 'r'
        and v_service_role_oid = any(policy.polroles)
    )
    or not exists (
      select 1
      from pg_catalog.pg_policy policy
      where policy.polrelid =
          'private.stage1_evidence_schema_upgrade_failures'::regclass
        and policy.polcmd = 'a'
        and v_service_role_oid = any(policy.polroles)
    )
    or not pg_catalog.has_table_privilege(
      'service_role',
      'private.stage1_evidence_schema_upgrade_failures',
      'SELECT,INSERT'
    )
  then
    raise exception using errcode = '55000',
      message = 'Stage 1 evidence-schema-upgrade failure audit permissions are incomplete.';
  end if;
end;
$stage1_evidence_schema_upgrade_quarantine_catalog_guard$;
