alter table public.profiles
  add column if not exists email_hash text,
  add column if not exists full_name_encrypted text,
  add column if not exists organization_encrypted text;

create index if not exists profiles_email_hash_idx
  on public.profiles (email_hash)
  where email_hash is not null;

alter table public.public_update_subscribers
  add column if not exists email_hash text,
  add column if not exists email_encrypted text;

alter table public.public_update_subscribers
  alter column email drop not null;

alter table public.public_update_subscribers
  drop constraint if exists public_update_subscribers_email_key;

create unique index if not exists public_update_subscribers_email_hash_key
  on public.public_update_subscribers (email_hash)
  where email_hash is not null;

alter table public.public_update_deliveries
  add column if not exists recipient_hash text;

alter table public.public_update_deliveries
  alter column recipient drop not null;

create index if not exists public_update_deliveries_recipient_hash_idx
  on public.public_update_deliveries (recipient_hash)
  where recipient_hash is not null;

alter table public.alert_deliveries
  add column if not exists recipient_hash text;

alter table public.alert_deliveries
  alter column recipient drop not null;

create index if not exists alert_deliveries_recipient_hash_idx
  on public.alert_deliveries (recipient_hash)
  where recipient_hash is not null;

create table if not exists public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email_hash text,
  request_type text not null check (request_type in ('export', 'delete')),
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.privacy_requests enable row level security;

drop policy if exists "privacy requests are user owned" on public.privacy_requests;
create policy "privacy requests are user owned" on public.privacy_requests
  for select using (auth.uid() = user_id);

create index if not exists privacy_requests_user_created_idx
  on public.privacy_requests (user_id, created_at desc);

create index if not exists privacy_requests_email_hash_idx
  on public.privacy_requests (email_hash, created_at desc)
  where email_hash is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
  selected_office_id uuid;
  selected_office_name text;
begin
  begin
    selected_office_id := nullif(trim(coalesce(new.raw_user_meta_data ->> 'existing_office_id', '')), '')::uuid;
  exception when invalid_text_representation then
    selected_office_id := null;
  end;

  if selected_office_id is not null then
    select name into selected_office_name
    from public.offices
    where id = selected_office_id;
  end if;

  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set
    email = excluded.email,
    updated_at = now();

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  if selected_office_id is not null and selected_office_name is not null then
    insert into public.office_members (office_id, user_id, email, role, notification_preference, status)
    values (selected_office_id, new.id, new.email, 'member', 'immediate', 'active')
    on conflict (office_id, user_id) do update set
      email = excluded.email,
      status = 'active',
      updated_at = now();

    return new;
  end if;

  default_office_id := public.ensure_default_office_for_user(new.id, new.email);
  return new;
end;
$$;
