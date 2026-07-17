-- Invite-only beta signup is a server-owned workflow. Browser clients may log
-- in, but they must never be able to create an office membership from Auth
-- metadata or call these reservation/completion functions with an anon token.

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.invite_signup_sha256(input_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  result_hash text;
begin
  if input_text is null then
    return null;
  end if;

  if pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(extensions.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into result_hash
      using input_text;
  elsif pg_catalog.to_regprocedure('public.digest(bytea,text)') is not null then
    execute
      'select pg_catalog.encode(public.digest(pg_catalog.convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into result_hash
      using input_text;
  else
    raise exception using
      errcode = '55000',
      message = 'pgcrypto digest(bytea,text) is required for invite signup.';
  end if;

  return result_hash;
end;
$$;

revoke all on function private.invite_signup_sha256(text)
  from public, anon, authenticated, service_role;

alter table public.office_invites
  add column if not exists signup_email_hash text;

create table if not exists public.office_invite_security_reissues (
  invite_id uuid primary key
    references public.office_invites(id) on delete cascade,
  office_id uuid not null
    references public.offices(id) on delete cascade,
  email_hash text not null
    check (email_hash ~ '^[0-9a-f]{64}$'),
  legacy_code_hash text not null
    check (legacy_code_hash ~ '^[0-9a-f]{64}$'),
  reason text not null default 'legacy_invite_code_entropy_upgrade',
  status text not null default 'pending_reissue'
    check (status in ('pending_reissue', 'replacement_ready', 'delivered')),
  rotated_at timestamptz not null default pg_catalog.clock_timestamp(),
  replacement_prepared_at timestamptz,
  delivered_at timestamptz,
  reissued_by uuid references auth.users(id) on delete set null,
  delivery_status text,
  last_error text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (
    (status = 'pending_reissue' and replacement_prepared_at is null and delivered_at is null)
    or (status = 'replacement_ready' and replacement_prepared_at is not null and delivered_at is null)
    or (status = 'delivered' and replacement_prepared_at is not null and delivered_at is not null)
  )
);

alter table public.office_invite_security_reissues enable row level security;
revoke all on table public.office_invite_security_reissues
  from public, anon, authenticated;
grant select, insert, update, delete on table public.office_invite_security_reissues
  to service_role;
grant select on table public.office_invite_security_reissues to authenticated;

drop policy if exists "office invite security reissues visible to admins"
  on public.office_invite_security_reissues;
create policy "office invite security reissues visible to admins"
  on public.office_invite_security_reissues
  for select to authenticated
  using (private.is_office_admin(office_id));

create index if not exists office_invite_security_reissues_status_idx
  on public.office_invite_security_reissues (status, rotated_at, invite_id);

-- Legacy links exposed a 40-bit human code. Record every still-usable weak
-- code before replacing it so an operator receives a durable, evidence-bound
-- resend action instead of silently invalidating an already-delivered link.
insert into public.office_invite_security_reissues (
  invite_id,
  office_id,
  email_hash,
  legacy_code_hash,
  reason,
  status
)
select
  invite.id,
  invite.office_id,
  private.invite_signup_sha256(pg_catalog.lower(pg_catalog.btrim(invite.email))),
  private.invite_signup_sha256(invite.invite_code),
  'legacy_invite_code_entropy_upgrade',
  'pending_reissue'
from public.office_invites invite
where invite.accepted_at is null
  and invite.accepted_by is null
  and invite.expires_at > pg_catalog.statement_timestamp()
  and invite.email is not null
  and pg_catalog.length(pg_catalog.btrim(invite.email)) > 3
  and invite.invite_code !~ '^[A-F0-9]{32}$'
on conflict (invite_id) do nothing;

update public.office_invites invite
set invite_code = pg_catalog.upper(
  pg_catalog.replace(gen_random_uuid()::text, '-', '')
)
where invite.accepted_at is null
  and invite.invite_code !~ '^[A-F0-9]{32}$';

alter table public.office_invites
  drop constraint if exists office_invites_pending_code_entropy_check;

alter table public.office_invites
  add constraint office_invites_pending_code_entropy_check
  check (
    accepted_at is not null
    or invite_code ~ '^[A-F0-9]{32}$'
  );

update public.office_invites invite
set signup_email_hash = private.invite_signup_sha256(
  pg_catalog.lower(pg_catalog.btrim(invite.email))
)
where invite.email is not null
  and invite.signup_email_hash is null;

alter table public.office_invites
  drop constraint if exists office_invites_signup_email_hash_check;

alter table public.office_invites
  add constraint office_invites_signup_email_hash_check
  check (
    (email is null and signup_email_hash is null)
    or (
      email is not null
      and signup_email_hash ~ '^[0-9a-f]{64}$'
    )
  );

create or replace function private.enforce_office_invite_signup_email_hash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.signup_email_hash := case
      when new.email is null then null
      else private.invite_signup_sha256(
        pg_catalog.lower(pg_catalog.btrim(new.email))
      )
    end;
    return new;
  end if;

  if new.email is distinct from old.email
    or new.signup_email_hash is distinct from old.signup_email_hash then
    raise exception using
      errcode = '22000',
      message = 'An office invitation email binding is immutable.';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_office_invite_signup_email_hash()
  from public, anon, authenticated, service_role;

drop trigger if exists office_invites_immutable_signup_email on public.office_invites;
create trigger office_invites_immutable_signup_email
before insert or update of email, signup_email_hash
on public.office_invites
for each row
execute function private.enforce_office_invite_signup_email_hash();

create table if not exists private.office_invite_signup_reservations (
  invite_id uuid primary key
    references public.office_invites(id) on delete cascade,
  reservation_id uuid not null unique default gen_random_uuid(),
  email_hash text not null
    check (email_hash ~ '^[0-9a-f]{64}$'),
  reserved_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > reserved_at)
);

alter table private.office_invite_signup_reservations enable row level security;
revoke all on table private.office_invite_signup_reservations
  from public, anon, authenticated, service_role;

create index if not exists office_invite_signup_reservations_expiry_idx
  on private.office_invite_signup_reservations (expires_at);

create or replace function public.get_office_invite_signup_preview(
  p_invite_secret text
)
returns table (
  invite_id uuid,
  office_name text,
  email_hint text,
  invite_role text,
  invite_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    invite.id,
    office.name,
    case
      when pg_catalog.strpos(pg_catalog.lower(pg_catalog.btrim(invite.email)), '@') > 1
        then pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(invite.email)), 1)
          || '***@'
          || pg_catalog.split_part(pg_catalog.lower(pg_catalog.btrim(invite.email)), '@', 2)
      else 'invited email'
    end,
    invite.role,
    invite.expires_at
  from public.office_invites invite
  join public.offices office on office.id = invite.office_id
  where pg_catalog.length(pg_catalog.btrim(p_invite_secret)) between 8 and 256
    and (
      invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
      or invite.invite_code = pg_catalog.upper(pg_catalog.btrim(p_invite_secret))
    )
    and invite.email is not null
    and pg_catalog.length(pg_catalog.btrim(invite.email)) > 3
    and invite.signup_email_hash = private.invite_signup_sha256(
      pg_catalog.lower(pg_catalog.btrim(invite.email))
    )
    and invite.accepted_at is null
    and invite.accepted_by is null
    and invite.expires_at > pg_catalog.statement_timestamp()
  order by
    case
      when invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
        then 0
      else 1
    end,
    invite.created_at desc
  limit 1;
$$;

create or replace function public.reserve_office_invite_signup(
  p_invite_secret text
)
returns table (
  invite_id uuid,
  office_id uuid,
  normalized_email text,
  reservation_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_invite public.office_invites%rowtype;
  selected_reservation private.office_invite_signup_reservations%rowtype;
  created_reservation_id uuid;
  clean_email text;
begin
  if pg_catalog.length(pg_catalog.btrim(p_invite_secret)) not between 8 and 256 then
    return;
  end if;

  select invite.*
  into selected_invite
  from public.office_invites invite
  where (
      invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
      or invite.invite_code = pg_catalog.upper(pg_catalog.btrim(p_invite_secret))
    )
    and invite.accepted_at is null
    and invite.accepted_by is null
    and invite.expires_at > pg_catalog.statement_timestamp()
  order by
    case
      when invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
        then 0
      else 1
    end,
    invite.created_at desc
  limit 1
  for update;

  if not found or selected_invite.email is null then
    return;
  end if;

  clean_email := pg_catalog.lower(pg_catalog.btrim(selected_invite.email));
  if pg_catalog.length(clean_email) < 3
    or selected_invite.signup_email_hash is null
    or selected_invite.signup_email_hash
      <> private.invite_signup_sha256(clean_email) then
    return;
  end if;

  select reservation.*
  into selected_reservation
  from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id
  for update;

  if found then
    if selected_reservation.email_hash <> selected_invite.signup_email_hash then
      return;
    end if;

    if selected_reservation.expires_at <= pg_catalog.statement_timestamp() then
      if exists (
        select 1
        from auth.users auth_user
        where pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = clean_email
          and auth_user.raw_user_meta_data ->> 'awardping_invite_id'
            = selected_invite.id::text
          and auth_user.raw_user_meta_data ->> 'awardping_invite_reservation_id'
            = selected_reservation.reservation_id::text
      ) then
        update private.office_invite_signup_reservations reservation
        set expires_at = pg_catalog.clock_timestamp() + interval '10 minutes'
        where reservation.invite_id = selected_invite.id;
      else
        delete from private.office_invite_signup_reservations reservation
        where reservation.invite_id = selected_invite.id;
        selected_reservation := null;
      end if;
    end if;

    if selected_reservation.invite_id is not null then
      invite_id := selected_invite.id;
      office_id := selected_invite.office_id;
      normalized_email := clean_email;
      reservation_id := selected_reservation.reservation_id;
      return next;
      return;
    end if;
  end if;

  if exists (
    select 1
    from auth.users auth_user
    where pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = clean_email
  ) then
    return;
  end if;

  insert into private.office_invite_signup_reservations (
    invite_id,
    email_hash,
    expires_at
  ) values (
    selected_invite.id,
    selected_invite.signup_email_hash,
    pg_catalog.clock_timestamp() + interval '10 minutes'
  )
  returning private.office_invite_signup_reservations.reservation_id
  into created_reservation_id;

  invite_id := selected_invite.id;
  office_id := selected_invite.office_id;
  normalized_email := clean_email;
  reservation_id := created_reservation_id;
  return next;
end;
$$;

create or replace function public.reconcile_office_invite_signup_auth_user(
  p_invite_id uuid,
  p_reservation_id uuid,
  p_normalized_email text
)
returns table (user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_invite public.office_invites%rowtype;
  selected_reservation private.office_invite_signup_reservations%rowtype;
  clean_email text;
begin
  clean_email := pg_catalog.lower(pg_catalog.btrim(p_normalized_email));

  select invite.*
  into selected_invite
  from public.office_invites invite
  where invite.id = p_invite_id
  for update;

  if not found then return; end if;

  select reservation.*
  into selected_reservation
  from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id
    and reservation.reservation_id = p_reservation_id
    and reservation.expires_at > pg_catalog.statement_timestamp()
  for update;

  if not found
    or selected_invite.signup_email_hash is null
    or selected_reservation.email_hash <> selected_invite.signup_email_hash
    or selected_invite.signup_email_hash
      <> private.invite_signup_sha256(clean_email) then
    return;
  end if;

  select auth_user.id
  into user_id
  from auth.users auth_user
  where pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = clean_email
    and auth_user.raw_user_meta_data ->> 'awardping_invite_id'
      = selected_invite.id::text
    and auth_user.raw_user_meta_data ->> 'awardping_invite_reservation_id'
      = selected_reservation.reservation_id::text
  limit 1;

  if user_id is not null then return next; end if;
end;
$$;

create or replace function public.complete_office_invite_signup(
  p_invite_id uuid,
  p_reservation_id uuid,
  p_user_id uuid,
  p_normalized_email text
)
returns table (office_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_invite public.office_invites%rowtype;
  selected_reservation private.office_invite_signup_reservations%rowtype;
  clean_email text;
  auth_email text;
  auth_invite_id text;
  auth_reservation_id text;
begin
  clean_email := pg_catalog.lower(pg_catalog.btrim(p_normalized_email));

  select invite.*
  into selected_invite
  from public.office_invites invite
  where invite.id = p_invite_id
  for update;

  if not found then
    return;
  end if;

  select
    pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
    auth_user.raw_user_meta_data ->> 'awardping_invite_id',
    auth_user.raw_user_meta_data ->> 'awardping_invite_reservation_id'
  into auth_email, auth_invite_id, auth_reservation_id
  from auth.users auth_user
  where auth_user.id = p_user_id;

  if auth_email is null
    or auth_email <> clean_email
    or auth_invite_id <> selected_invite.id::text
    or auth_reservation_id <> p_reservation_id::text
    or selected_invite.signup_email_hash is null
    or selected_invite.signup_email_hash
      <> private.invite_signup_sha256(clean_email) then
    return;
  end if;

  -- A caller can lose the response after the transaction commits. Make an exact
  -- retry an idempotent success so the application never deletes the completed
  -- Auth user (and cascades its membership) while consuming the invitation.
  if selected_invite.accepted_at is not null
    or selected_invite.accepted_by is not null then
    if selected_invite.accepted_at is not null
      and selected_invite.accepted_by = p_user_id
      and exists (
        select 1
        from public.office_members member
        where member.office_id = selected_invite.office_id
          and member.user_id = p_user_id
          and member.status = 'active'
          and pg_catalog.lower(pg_catalog.btrim(member.email)) = clean_email
      ) then
      office_id := selected_invite.office_id;
      return next;
    end if;
    return;
  end if;

  if selected_invite.expires_at <= pg_catalog.statement_timestamp() then
    return;
  end if;

  select reservation.*
  into selected_reservation
  from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id
    and reservation.reservation_id = p_reservation_id
  for update;

  if not found
    or selected_reservation.expires_at <= pg_catalog.statement_timestamp() then
    return;
  end if;

  if selected_invite.signup_email_hash is null
    or selected_reservation.email_hash <> selected_invite.signup_email_hash
    or selected_invite.signup_email_hash
      <> private.invite_signup_sha256(clean_email) then
    return;
  end if;

  insert into public.office_members as existing_member (
    office_id,
    user_id,
    email,
    role,
    notification_preference,
    status,
    joined_at,
    updated_at
  ) values (
    selected_invite.office_id,
    p_user_id,
    clean_email,
    selected_invite.role,
    'immediate',
    'active',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  on conflict (office_id, user_id) do update set
    email = excluded.email,
    role = case
      when existing_member.role = 'owner' then 'owner'
      when existing_member.role = 'admin' then 'admin'
      else excluded.role
    end,
    status = 'active',
    updated_at = pg_catalog.clock_timestamp();

  update public.office_invites invite
  set accepted_by = p_user_id,
    accepted_at = pg_catalog.clock_timestamp()
  where invite.id = selected_invite.id;

  delete from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id
    and reservation.reservation_id = p_reservation_id;

  office_id := selected_invite.office_id;
  return next;
end;
$$;

create or replace function public.release_office_invite_signup_reservation(
  p_invite_id uuid,
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_invite_id uuid;
  deleted_count integer;
begin
  select invite.id
  into locked_invite_id
  from public.office_invites invite
  where invite.id = p_invite_id
  for update;

  if not found then
    return false;
  end if;

  delete from private.office_invite_signup_reservations reservation
  where reservation.invite_id = locked_invite_id
    and reservation.reservation_id = p_reservation_id;

  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

create or replace function public.prepare_office_invite_security_reissue(
  p_invite_id uuid,
  p_office_id uuid,
  p_token_hash text,
  p_invite_code text,
  p_expires_at timestamptz,
  p_reissued_by uuid
)
returns table (
  invite_email text,
  office_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_invite public.office_invites%rowtype;
  selected_reissue public.office_invite_security_reissues%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$'
    or p_invite_code !~ '^[A-F0-9]{32}$'
    or p_expires_at <= pg_catalog.statement_timestamp()
    or p_reissued_by is null then
    return;
  end if;

  select invite.*
  into selected_invite
  from public.office_invites invite
  where invite.id = p_invite_id
    and invite.office_id = p_office_id
  for update;

  if not found
    or selected_invite.accepted_at is not null
    or selected_invite.accepted_by is not null
    or selected_invite.email is null then
    return;
  end if;

  select reissue.*
  into selected_reissue
  from public.office_invite_security_reissues reissue
  where reissue.invite_id = selected_invite.id
    and reissue.office_id = selected_invite.office_id
    and reissue.status in ('pending_reissue', 'replacement_ready')
  for update;

  if not found
    or selected_reissue.email_hash <> private.invite_signup_sha256(
      pg_catalog.lower(pg_catalog.btrim(selected_invite.email))
    ) then
    return;
  end if;

  -- Rotation revokes the old bearer credential. Serialize on the invite row
  -- and delete every uncompleted signup reservation before installing the new
  -- token/code, so an Auth user created from the old link cannot complete
  -- membership after the reissue wins this lock.
  delete from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id;

  update public.office_invites invite
  set token_hash = p_token_hash,
    invite_code = p_invite_code,
    expires_at = p_expires_at
  where invite.id = selected_invite.id;

  update public.office_invite_security_reissues reissue
  set status = 'replacement_ready',
    replacement_prepared_at = pg_catalog.clock_timestamp(),
    delivered_at = null,
    reissued_by = p_reissued_by,
    delivery_status = 'pending_delivery',
    last_error = null,
    updated_at = pg_catalog.clock_timestamp()
  where reissue.invite_id = selected_invite.id;

  invite_email := pg_catalog.lower(pg_catalog.btrim(selected_invite.email));
  select office.name into office_name
  from public.offices office
  where office.id = selected_invite.office_id;
  return next;
end;
$$;

create or replace function public.record_office_invite_security_reissue_delivery(
  p_invite_id uuid,
  p_reissued_by uuid,
  p_delivery_status text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_delivery_status not in ('sent', 'not_configured', 'failed') then
    return false;
  end if;

  update public.office_invite_security_reissues reissue
  set status = case when p_delivery_status = 'sent' then 'delivered' else 'replacement_ready' end,
    delivered_at = case
      when p_delivery_status = 'sent' then pg_catalog.clock_timestamp()
      else null
    end,
    delivery_status = p_delivery_status,
    last_error = pg_catalog.nullif(pg_catalog.btrim(p_error), ''),
    updated_at = pg_catalog.clock_timestamp()
  where reissue.invite_id = p_invite_id
    and reissue.reissued_by = p_reissued_by
    and reissue.status = 'replacement_ready';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.accept_office_invite_for_user(
  p_invite_secret text,
  p_user_id uuid,
  p_normalized_email text
)
returns table (office_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_invite public.office_invites%rowtype;
  clean_email text;
  auth_email text;
begin
  if pg_catalog.length(pg_catalog.btrim(p_invite_secret)) not between 8 and 256 then
    return;
  end if;

  select invite.*
  into selected_invite
  from public.office_invites invite
  where invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
    or invite.invite_code = pg_catalog.upper(pg_catalog.btrim(p_invite_secret))
  order by
    case
      when invite.token_hash = private.invite_signup_sha256(pg_catalog.btrim(p_invite_secret))
        then 0
      else 1
    end,
    invite.created_at desc
  limit 1
  for update;

  if not found or selected_invite.expires_at <= pg_catalog.statement_timestamp() then
    return;
  end if;

  clean_email := pg_catalog.lower(pg_catalog.btrim(p_normalized_email));
  select pg_catalog.lower(pg_catalog.btrim(auth_user.email))
  into auth_email
  from auth.users auth_user
  where auth_user.id = p_user_id;

  if auth_email is null or auth_email <> clean_email then
    return;
  end if;

  if selected_invite.email is not null
    and (
      selected_invite.signup_email_hash is null
      or selected_invite.signup_email_hash
        <> private.invite_signup_sha256(clean_email)
    ) then
    return;
  end if;

  if selected_invite.accepted_at is not null
    or selected_invite.accepted_by is not null then
    if selected_invite.accepted_by = p_user_id
      and exists (
        select 1
        from public.office_members existing_member
        where existing_member.office_id = selected_invite.office_id
          and existing_member.user_id = p_user_id
          and existing_member.status = 'active'
      ) then
      office_id := selected_invite.office_id;
      return next;
    end if;
    return;
  end if;

  insert into public.office_members as existing_member (
    office_id,
    user_id,
    email,
    role,
    notification_preference,
    status,
    joined_at,
    updated_at
  ) values (
    selected_invite.office_id,
    p_user_id,
    clean_email,
    selected_invite.role,
    'immediate',
    'active',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  on conflict (office_id, user_id) do update set
    email = excluded.email,
    role = case
      when existing_member.role = 'owner' then 'owner'
      when existing_member.role = 'admin' then 'admin'
      else excluded.role
    end,
    status = 'active',
    updated_at = pg_catalog.clock_timestamp();

  update public.office_invites invite
  set accepted_by = p_user_id,
    accepted_at = pg_catalog.clock_timestamp()
  where invite.id = selected_invite.id;

  delete from private.office_invite_signup_reservations reservation
  where reservation.invite_id = selected_invite.id;

  office_id := selected_invite.office_id;
  return next;
end;
$$;

revoke all on function public.get_office_invite_signup_preview(text)
  from public, anon, authenticated;
revoke all on function public.reserve_office_invite_signup(text)
  from public, anon, authenticated;
revoke all on function public.reconcile_office_invite_signup_auth_user(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_office_invite_signup(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_office_invite_signup_reservation(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.accept_office_invite_for_user(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.prepare_office_invite_security_reissue(uuid, uuid, text, text, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.record_office_invite_security_reissue_delivery(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.get_office_invite_signup_preview(text)
  to service_role;
grant execute on function public.reserve_office_invite_signup(text)
  to service_role;
grant execute on function public.reconcile_office_invite_signup_auth_user(uuid, uuid, text)
  to service_role;
grant execute on function public.complete_office_invite_signup(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.release_office_invite_signup_reservation(uuid, uuid)
  to service_role;
grant execute on function public.accept_office_invite_for_user(text, uuid, text)
  to service_role;
grant execute on function public.prepare_office_invite_security_reissue(uuid, uuid, text, text, timestamptz, uuid)
  to service_role;
grant execute on function public.record_office_invite_security_reissue_delivery(uuid, uuid, text, text)
  to service_role;

create or replace function public.get_office_invite_security_reissue_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'unresolved_count', count(*),
    'oldest_rotated_at', min(reissue.rotated_at),
    'evaluated_at', statement_timestamp()
  )
  from public.office_invite_security_reissues reissue
  where reissue.status in ('pending_reissue', 'replacement_ready');
$$;

revoke all on function public.get_office_invite_security_reissue_status()
  from public, anon, authenticated, service_role;
grant execute on function public.get_office_invite_security_reissue_status()
  to service_role;

alter table public.office_invites enable row level security;
revoke insert, update, delete, truncate, references, trigger
  on table public.office_invites from anon, authenticated;

-- The old trigger trusted raw_user_meta_data.existing_office_id and also made
-- a seeded default office before an invitation was completed. Browser-managed
-- metadata is never authorization. New Auth users now receive only support
-- rows; the completion RPC above is the sole invite membership write.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set
    email = excluded.email,
    updated_at = pg_catalog.clock_timestamp();

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user()
  from public, anon, authenticated, service_role;

-- Hosted release requirement (not enforceable by SQL migrations): Supabase
-- Auth must report disable_signup=true. The application release-readiness
-- helper checks /auth/v1/settings using only the public anon key.
