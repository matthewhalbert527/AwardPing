create schema if not exists private;
revoke all on schema private from public;

alter table public.profiles
  add column if not exists personal_data_reentry_required boolean not null default false,
  add column if not exists personal_data_reentry_reason text,
  add column if not exists personal_data_reentry_marked_at timestamptz,
  add column if not exists personal_data_reentered_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_personal_data_reentry_state_check;

alter table public.profiles
  add constraint profiles_personal_data_reentry_state_check check (
    (
      personal_data_reentry_required
      and personal_data_reentry_reason in (
        'legacy_v1_key_unavailable',
        'unsupported_ciphertext_format'
      )
      and personal_data_reentry_marked_at is not null
    )
    or (
      not personal_data_reentry_required
      and personal_data_reentry_reason is null
      and personal_data_reentry_marked_at is null
    )
  );

create table if not exists public.personal_data_legacy_ciphertext_archive (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_table text not null default 'profiles' check (source_table = 'profiles'),
  source_column text not null check (
    source_column in ('full_name_encrypted', 'organization_encrypted')
  ),
  ciphertext_format text not null check (
    ciphertext_format in ('ap:v1', 'unsupported')
  ),
  ciphertext text not null,
  ciphertext_sha256 text not null check (
    ciphertext_sha256 ~ '^[0-9a-f]{64}$'
  ),
  archived_at timestamptz not null default now(),
  unique (source_table, user_id, source_column, ciphertext_sha256)
);

alter table public.personal_data_legacy_ciphertext_archive enable row level security;

revoke all on table public.personal_data_legacy_ciphertext_archive
  from public, anon, authenticated, service_role;
grant select on table public.personal_data_legacy_ciphertext_archive to service_role;

create or replace function private.awardping_personal_data_sha256(p_value text)
returns text
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_hash text;
  v_digest_oid oid;
begin
  select candidate.function_oid
  into v_digest_oid
  from (
    values
      (
        0,
        pg_catalog.to_regprocedure('extensions.digest(bytea,text)')::oid
      ),
      (
        1,
        pg_catalog.to_regprocedure('public.digest(bytea,text)')::oid
      )
  ) as candidate(preference, function_oid)
  join pg_catalog.pg_depend dependency
    on dependency.classid =
      pg_catalog.to_regclass('pg_catalog.pg_proc')
    and dependency.objid = candidate.function_oid
    and dependency.refclassid =
      pg_catalog.to_regclass('pg_catalog.pg_extension')
    and dependency.deptype = 'e'
  join pg_catalog.pg_extension extension
    on extension.oid = dependency.refobjid
    and extension.extname = 'pgcrypto'
  join pg_catalog.pg_proc procedure
    on procedure.oid = candidate.function_oid
    and procedure.prokind = 'f'
    and procedure.prorettype =
      pg_catalog.to_regtype('pg_catalog.bytea')
    and procedure.proowner = extension.extowner
  where candidate.function_oid is not null
  order by candidate.preference
  limit 1;

  if v_digest_oid =
    pg_catalog.to_regprocedure('extensions.digest(bytea,text)')::oid then
    execute
      'select pg_catalog.encode(extensions.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_hash
      using p_value;
  elsif v_digest_oid =
    pg_catalog.to_regprocedure('public.digest(bytea,text)')::oid then
    execute
      'select pg_catalog.encode(public.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into v_hash
      using p_value;
  else
    raise exception using
      errcode = '55000',
      message = 'pgcrypto digest(bytea,text) is required to archive legacy personal data.';
  end if;

  return v_hash;
end;
$$;

alter function private.awardping_personal_data_sha256(text) owner to postgres;
revoke all on function private.awardping_personal_data_sha256(text)
  from public, anon, authenticated, service_role;

insert into public.personal_data_legacy_ciphertext_archive (
  user_id,
  source_column,
  ciphertext_format,
  ciphertext,
  ciphertext_sha256
)
select
  profile.id,
  value.source_column,
  case
    when value.ciphertext like 'ap:v1:%' then 'ap:v1'
    else 'unsupported'
  end,
  value.ciphertext,
  private.awardping_personal_data_sha256(value.ciphertext)
from public.profiles profile
cross join lateral (
  values
    ('full_name_encrypted'::text, profile.full_name_encrypted),
    ('organization_encrypted'::text, profile.organization_encrypted)
) as value(source_column, ciphertext)
where value.ciphertext is not null
  and value.ciphertext not like 'ap:v2:%'
on conflict (source_table, user_id, source_column, ciphertext_sha256) do nothing;

update public.profiles profile
set
  personal_data_reentry_required = true,
  personal_data_reentry_reason = case
    when profile.full_name_encrypted like 'ap:v1:%'
      or profile.organization_encrypted like 'ap:v1:%'
      then 'legacy_v1_key_unavailable'
    else 'unsupported_ciphertext_format'
  end,
  personal_data_reentry_marked_at = coalesce(
    profile.personal_data_reentry_marked_at,
    now()
  ),
  personal_data_reentered_at = null
where (
    profile.full_name_encrypted is not null
    and profile.full_name_encrypted not like 'ap:v2:%'
  )
  or (
    profile.organization_encrypted is not null
    and profile.organization_encrypted not like 'ap:v2:%'
  );

create or replace function private.awardping_preserve_legacy_personal_data_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and pg_catalog.current_setting(
      'awardping.personal_data_erasure_user_id',
      true
    ) = old.user_id::text
  then
    return old;
  end if;

  raise exception using
    errcode = '55000',
    message = 'Legacy personal-data ciphertext is immutable outside a verified account-erasure request.';
end;
$$;

alter function private.awardping_preserve_legacy_personal_data_archive() owner to postgres;
revoke all on function private.awardping_preserve_legacy_personal_data_archive()
  from public, anon, authenticated, service_role;

drop trigger if exists preserve_legacy_personal_data_archive_rows
  on public.personal_data_legacy_ciphertext_archive;
create trigger preserve_legacy_personal_data_archive_rows
before update or delete on public.personal_data_legacy_ciphertext_archive
for each row
execute function private.awardping_preserve_legacy_personal_data_archive();

drop trigger if exists preserve_legacy_personal_data_archive_truncate
  on public.personal_data_legacy_ciphertext_archive;
create trigger preserve_legacy_personal_data_archive_truncate
before truncate on public.personal_data_legacy_ciphertext_archive
for each statement
execute function private.awardping_preserve_legacy_personal_data_archive();

create or replace function public.erase_personal_data_legacy_archive_for_privacy_request(
  p_user_id uuid,
  p_privacy_request_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.privacy_requests%rowtype;
  v_deleted integer := 0;
begin
  if p_user_id is null or p_privacy_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'A user and privacy-request identity are required.';
  end if;

  select request.*
  into strict v_request
  from public.privacy_requests request
  where request.id = p_privacy_request_id
  for update;

  if v_request.user_id is distinct from p_user_id
    or v_request.request_type <> 'delete'
    or v_request.status <> 'pending'
  then
    raise exception using
      errcode = '42501',
      message = 'The archive erasure is not bound to this pending account-deletion request.';
  end if;

  perform pg_catalog.set_config(
    'awardping.personal_data_erasure_user_id',
    p_user_id::text,
    true
  );

  delete from public.personal_data_legacy_ciphertext_archive archive
  where archive.user_id = p_user_id;
  get diagnostics v_deleted = row_count;

  perform pg_catalog.set_config(
    'awardping.personal_data_erasure_user_id',
    '',
    true
  );

  return v_deleted;
end;
$$;

alter function public.erase_personal_data_legacy_archive_for_privacy_request(uuid, uuid)
  owner to postgres;
revoke all on function public.erase_personal_data_legacy_archive_for_privacy_request(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.erase_personal_data_legacy_archive_for_privacy_request(uuid, uuid)
  to service_role;
