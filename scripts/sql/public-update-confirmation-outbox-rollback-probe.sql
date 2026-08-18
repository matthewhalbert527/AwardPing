-- Template: execute only through
--   node scripts/run-public-update-confirmation-outbox-rollback-probe.mjs
-- It applies the exact migration and smoke inside a transaction, then proves
-- that rollback restores every replaced function and removes every new object.

begin;

create temporary table awardping_confirmation_outbox_probe_baseline (
  required_prior_versions text[] not null,
  function_contract jsonb not null,
  function_metadata_contract jsonb not null,
  trigger_contract jsonb not null
) on commit preserve rows;

create function pg_temp.awardping_confirmation_outbox_probe_assert(
  p_condition boolean,
  p_message text
)
returns void
language plpgsql
as $$
begin
  if coalesce(p_condition, false) is not true then
    raise exception using
      errcode = 'P0001',
      message = 'Public-update confirmation rollback probe failed: ' || p_message;
  end if;
end;
$$;

create function pg_temp.awardping_confirmation_outbox_function_contract(
  p_include_definition boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'schema', namespace.nspname,
          'name', target.proname,
          'oid', target.oid::text,
          'definition', case
            when p_include_definition
              then pg_catalog.pg_get_functiondef(target.oid)
            else null
          end,
          'identity_arguments',
            pg_catalog.pg_get_function_identity_arguments(target.oid),
          'result', pg_catalog.pg_get_function_result(target.oid),
          'owner_oid', target.proowner::text,
          'acl', pg_catalog.to_jsonb(target.proacl),
          'config', pg_catalog.to_jsonb(target.proconfig),
          'volatility', target.provolatile::text,
          'security_definer', target.prosecdef,
          'strict', target.proisstrict,
          'leakproof', target.proleakproof,
          'parallel', target.proparallel::text,
          'kind', target.prokind::text,
          'language_oid', target.prolang::text,
          'return_type_oid', target.prorettype::text,
          'argument_type_oids', target.proargtypes::text,
          'all_argument_type_oids', pg_catalog.to_jsonb(target.proallargtypes),
          'argument_modes', pg_catalog.to_jsonb(target.proargmodes),
          'argument_names', pg_catalog.to_jsonb(target.proargnames),
          'comment', pg_catalog.obj_description(target.oid, 'pg_proc')
        )
      )
      order by namespace.nspname, target.proname, target.oid
    ),
    '[]'::jsonb
  )
  from pg_catalog.pg_proc target
  join pg_catalog.pg_namespace namespace
    on namespace.oid = target.pronamespace
  where (namespace.nspname, target.proname) in (
    ('public', 'unsubscribe_public_update_subscriber'),
    ('public', 'erase_public_update_subscriber'),
    ('private', 'fence_sending_digest_subscriber_mutation')
  );
$$;

do $preflight$
declare
  v_required_prior_versions text[] :=
-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__
  ;
  v_missing_prior_versions text[];
  v_function_contract jsonb;
  v_function_metadata_contract jsonb;
  v_trigger_contract jsonb;
begin
  select pg_catalog.array_agg(required.version order by required.version)
  into v_missing_prior_versions
  from pg_catalog.unnest(v_required_prior_versions) required(version)
  where not exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = required.version
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    coalesce(pg_catalog.cardinality(v_missing_prior_versions), 0) = 0,
    'one or more prior repository migrations are not recorded as applied'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260815023357'
    ),
    'migration 20260815023357 is already recorded as applied'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_catalog.to_regclass(
      'private.public_update_confirmation_outbox'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.enqueue_public_update_confirmation(uuid,timestamp with time zone,text,text,text,text,text,text,text,text,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.claim_public_update_confirmations(text,integer,integer,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.authorize_public_update_confirmation_send(uuid,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.complete_public_update_confirmation_send(uuid,uuid,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.fail_public_update_confirmation_send(uuid,uuid,text,boolean,boolean)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.confirm_public_update_subscription(text)'
      ) is null,
    'a target confirmation outbox object already exists'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    not exists (
      select 1
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid =
        'public.public_update_subscribers'::pg_catalog.regclass
        and attribute.attname in (
          'confirmation_generation',
          'confirmation_issued_at',
          'confirmation_expires_at',
          'confirmation_contract_version'
        )
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
    'a target subscriber column already exists'
  );

  v_function_contract :=
    pg_temp.awardping_confirmation_outbox_function_contract(true);
  v_function_metadata_contract :=
    pg_temp.awardping_confirmation_outbox_function_contract(false);
  select pg_catalog.jsonb_build_object(
    'oid', trigger.oid::text,
    'definition', pg_catalog.pg_get_triggerdef(trigger.oid, true),
    'enabled', trigger.tgenabled::text,
    'function_oid', trigger.tgfoid::text
  ) into v_trigger_contract
  from pg_catalog.pg_trigger trigger
  where trigger.tgrelid =
      'public.public_update_subscribers'::pg_catalog.regclass
    and trigger.tgname =
      'fence_sending_digest_subscriber_mutation_trigger'
    and not trigger.tgisinternal;
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_catalog.jsonb_array_length(v_function_contract) = 3,
    'the exact three-function replacement baseline was not captured'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    v_trigger_contract is not null,
    'the exact subscriber trigger baseline was not captured'
  );
  insert into pg_temp.awardping_confirmation_outbox_probe_baseline (
    required_prior_versions,
    function_contract,
    function_metadata_contract,
    trigger_contract
  ) values (
    v_required_prior_versions,
    v_function_contract,
    v_function_metadata_contract,
    v_trigger_contract
  );
end;
$preflight$;

commit;

-- MIGRATION TRANSACTION START
begin;

-- __AWARDPING_EXACT_MIGRATION__

-- __AWARDPING_EXACT_SMOKE__

do $applied_contract$
begin
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_catalog.to_regclass(
      'private.public_update_confirmation_outbox'
    ) is not null,
    'the migration did not create the private outbox'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    (
      select pg_catalog.count(*)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid =
        'public.public_update_subscribers'::pg_catalog.regclass
        and attribute.attname in (
          'confirmation_generation',
          'confirmation_issued_at',
          'confirmation_expires_at',
          'confirmation_contract_version'
        )
        and attribute.attnum > 0
        and not attribute.attisdropped
    ) = 4,
    'the migration did not create all four subscriber columns'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_temp.awardping_confirmation_outbox_function_contract(false) = (
      select baseline.function_metadata_contract
      from pg_temp.awardping_confirmation_outbox_probe_baseline baseline
    ),
    'a replaced function changed OID or catalog metadata outside its body'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_temp.awardping_confirmation_outbox_function_contract(true) <> (
      select baseline.function_contract
      from pg_temp.awardping_confirmation_outbox_probe_baseline baseline
    ),
    'the replacement function definitions did not change'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    (
      select pg_catalog.pg_get_triggerdef(trigger.oid, true) like
        '%BEFORE INSERT OR DELETE OR UPDATE%'
        or pg_catalog.pg_get_triggerdef(trigger.oid, true) like
          '%BEFORE INSERT OR UPDATE OR DELETE%'
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid =
          'public.public_update_subscribers'::pg_catalog.regclass
        and trigger.tgname =
          'fence_sending_digest_subscriber_mutation_trigger'
        and not trigger.tgisinternal
    ),
    'the applied subscriber trigger does not fence rolling-deploy inserts'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260815023357'
    ),
    'direct rollback-probe execution changed migration history'
  );
end;
$applied_contract$;

rollback;
-- MIGRATION TRANSACTION END

-- POST-ROLLBACK VERIFICATION START
begin;

do $post_rollback$
declare
  v_required_prior_versions text[] := (
    select baseline.required_prior_versions
    from pg_temp.awardping_confirmation_outbox_probe_baseline baseline
  );
begin
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_catalog.to_regclass(
      'private.public_update_confirmation_outbox'
    ) is null
      and pg_catalog.to_regprocedure(
        'public.enqueue_public_update_confirmation(uuid,timestamp with time zone,text,text,text,text,text,text,text,text,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.claim_public_update_confirmations(text,integer,integer,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.authorize_public_update_confirmation_send(uuid,uuid)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.complete_public_update_confirmation_send(uuid,uuid,text)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.fail_public_update_confirmation_send(uuid,uuid,text,boolean,boolean)'
      ) is null
      and pg_catalog.to_regprocedure(
        'public.confirm_public_update_subscription(text)'
      ) is null,
    'a new confirmation object survived rollback'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    not exists (
      select 1
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid =
        'public.public_update_subscribers'::pg_catalog.regclass
        and attribute.attname in (
          'confirmation_generation',
          'confirmation_issued_at',
          'confirmation_expires_at',
          'confirmation_contract_version'
        )
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
    'a new subscriber column survived rollback'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    pg_temp.awardping_confirmation_outbox_function_contract(true) = (
      select baseline.function_contract
      from pg_temp.awardping_confirmation_outbox_probe_baseline baseline
    ),
    'an original function definition or catalog attribute was not restored'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    (
      select pg_catalog.jsonb_build_object(
        'oid', trigger.oid::text,
        'definition', pg_catalog.pg_get_triggerdef(trigger.oid, true),
        'enabled', trigger.tgenabled::text,
        'function_oid', trigger.tgfoid::text
      )
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid =
          'public.public_update_subscribers'::pg_catalog.regclass
        and trigger.tgname =
          'fence_sending_digest_subscriber_mutation_trigger'
        and not trigger.tgisinternal
    ) = (
      select baseline.trigger_contract
      from pg_temp.awardping_confirmation_outbox_probe_baseline baseline
    ),
    'the original subscriber trigger definition or identity was not restored'
  );
  perform pg_temp.awardping_confirmation_outbox_probe_assert(
    not exists (
      select 1
      from pg_catalog.unnest(v_required_prior_versions) required(version)
      where not exists (
        select 1
        from supabase_migrations.schema_migrations migration
        where migration.version = required.version
      )
    ) and not exists (
      select 1
      from supabase_migrations.schema_migrations migration
      where migration.version = '20260815023357'
    ),
    'migration history changed despite rollback'
  );
end;
$post_rollback$;

select
  'awardping_stage1_pending_migration_rollback_probe_passed' as status,
  'awardping_public_update_confirmation_outbox_rollback_probe_passed' as probe,
  1 as exact_migration_count,
  1 as exact_smoke_count,
  '20260815023357_durable_public_update_confirmation_outbox.sql'::text
    as exact_migration,
  'public_update_confirmation_outbox_smoke.sql'::text as exact_smoke,
  'migration/smoke/table/column/function changes rolled back'::text
    as persistence_result;

drop table pg_temp.awardping_confirmation_outbox_probe_baseline;
drop function pg_temp.awardping_confirmation_outbox_function_contract(boolean);
drop function pg_temp.awardping_confirmation_outbox_probe_assert(boolean, text);

commit;
-- POST-ROLLBACK VERIFICATION END
