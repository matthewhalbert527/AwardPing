create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  country text,
  country_code text,
  state_province text,
  domains text[] not null default '{}',
  web_pages text[] not null default '{}',
  source text not null default 'user' check (source in ('hipo', 'user', 'admin')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.normalized_lookup_name(input text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(trim(coalesce(input, '')), '\s+', ' ', 'g'));
$$;

create unique index if not exists organizations_normalized_name_idx
  on public.organizations (normalized_name);

create index if not exists organizations_name_idx
  on public.organizations (name);

alter table public.offices
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists offices_organization_idx
  on public.offices (organization_id, name);

alter table public.organizations enable row level security;

drop policy if exists "organizations are readable" on public.organizations;
create policy "organizations are readable" on public.organizations
  for select using (true);

drop policy if exists "authenticated users can create organizations" on public.organizations;
create policy "authenticated users can create organizations" on public.organizations
  for insert with check (auth.uid() is not null);

drop policy if exists "organization creators can update organizations" on public.organizations;
create policy "organization creators can update organizations" on public.organizations
  for update using (created_by = auth.uid())
  with check (created_by = auth.uid());

create or replace function public.ensure_organization_for_name(
  input_name text,
  input_created_by uuid default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  clean_name text;
  clean_key text;
  organization_id uuid;
begin
  clean_name := nullif(trim(regexp_replace(coalesce(input_name, ''), '\s+', ' ', 'g')), '');
  if clean_name is null then
    return null;
  end if;

  clean_key := public.normalized_lookup_name(clean_name);

  insert into public.organizations (name, normalized_name, source, created_by)
  values (clean_name, clean_key, 'user', input_created_by)
  on conflict (normalized_name) do update set
    updated_at = public.organizations.updated_at
  returning id into organization_id;

  return organization_id;
end;
$$;

with owner_profiles as (
  select distinct on (member.office_id)
    member.office_id,
    office.name as office_name,
    office.created_by,
    profile.organization as profile_organization
  from public.office_members member
  join public.offices office on office.id = member.office_id
  left join public.profiles profile on profile.id = member.user_id
  where member.status = 'active'
  order by member.office_id,
    case member.role when 'owner' then 1 when 'admin' then 2 else 3 end,
    member.created_at asc
),
office_organization_names as (
  select
    office_id,
    created_by,
    nullif(
      trim(
        coalesce(
          nullif(profile_organization, ''),
          case
            when office_name ~ '\s+-\s+' then split_part(office_name, ' - ', 1)
            else null
          end
        )
      ),
      ''
    ) as organization_name
  from owner_profiles
)
insert into public.organizations (name, normalized_name, source, created_by)
select distinct
  organization_name,
  public.normalized_lookup_name(organization_name),
  'user',
  created_by
from office_organization_names
where organization_name is not null
  and public.normalized_lookup_name(organization_name) not in ('new office', 'new award office')
on conflict (normalized_name) do nothing;

with owner_profiles as (
  select distinct on (member.office_id)
    member.office_id,
    office.name as office_name,
    profile.organization as profile_organization
  from public.office_members member
  join public.offices office on office.id = member.office_id
  left join public.profiles profile on profile.id = member.user_id
  where member.status = 'active'
  order by member.office_id,
    case member.role when 'owner' then 1 when 'admin' then 2 else 3 end,
    member.created_at asc
),
office_organization_names as (
  select
    office_id,
    office_name,
    nullif(
      trim(
        coalesce(
          nullif(profile_organization, ''),
          case
            when office_name ~ '\s+-\s+' then split_part(office_name, ' - ', 1)
            else null
          end
        )
      ),
      ''
    ) as organization_name
  from owner_profiles
)
update public.offices office
set organization_id = organization.id,
  name = case
    when office.name ~ '\s+-\s+'
      and public.normalized_lookup_name(split_part(office.name, ' - ', 1)) = organization.normalized_name
    then trim(substr(office.name, position(' - ' in office.name) + 3))
    else office.name
  end,
  updated_at = now()
from office_organization_names source
join public.organizations organization
  on organization.normalized_name = public.normalized_lookup_name(source.organization_name)
where office.id = source.office_id
  and office.organization_id is null;

drop function if exists public.ensure_default_office_for_user(uuid, text);

create or replace function public.ensure_default_office_for_user(
  target_user_id uuid,
  target_email text,
  target_organization_id uuid default null,
  target_office_name text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
  clean_office_name text;
begin
  select om.office_id into default_office_id
  from public.office_members om
  where om.user_id = target_user_id
  order by om.created_at asc
  limit 1;

  if default_office_id is not null then
    return default_office_id;
  end if;

  clean_office_name := nullif(trim(regexp_replace(coalesce(target_office_name, ''), '\s+', ' ', 'g')), '');

  insert into public.offices (name, organization_id, created_by)
  values (
    coalesce(clean_office_name, 'New award office'),
    target_organization_id,
    target_user_id
  )
  returning id into default_office_id;

  insert into public.office_members (office_id, user_id, email, role, notification_preference, status)
  values (default_office_id, target_user_id, target_email, 'owner', 'immediate', 'active')
  on conflict (office_id, user_id) do nothing;

  perform public.seed_default_awards_for_office(default_office_id, target_user_id);

  return default_office_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
  selected_office_id uuid;
  selected_office_name text;
  selected_office_organization_id uuid;
  selected_office_organization_name text;
  selected_organization_id uuid;
  selected_organization_name text;
  profile_full_name text;
  profile_organization text;
  profile_office_name text;
begin
  profile_full_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  profile_organization := nullif(trim(coalesce(new.raw_user_meta_data ->> 'organization', '')), '');
  profile_office_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'office_name', '')), '');

  begin
    selected_office_id := nullif(trim(coalesce(new.raw_user_meta_data ->> 'existing_office_id', '')), '')::uuid;
  exception when invalid_text_representation then
    selected_office_id := null;
  end;

  begin
    selected_organization_id := nullif(trim(coalesce(new.raw_user_meta_data ->> 'organization_id', '')), '')::uuid;
  exception when invalid_text_representation then
    selected_organization_id := null;
  end;

  if selected_office_id is not null then
    select office.name, office.organization_id, organization.name
      into selected_office_name, selected_office_organization_id, selected_office_organization_name
    from public.offices office
    left join public.organizations organization on organization.id = office.organization_id
    where office.id = selected_office_id;
  end if;

  if selected_organization_id is not null then
    select name into selected_organization_name
    from public.organizations
    where id = selected_organization_id;
  end if;

  if selected_organization_name is null and profile_organization is not null then
    selected_organization_id := public.ensure_organization_for_name(profile_organization, new.id);
    select name into selected_organization_name
    from public.organizations
    where id = selected_organization_id;
  end if;

  insert into public.profiles (id, email, full_name, organization)
  values (
    new.id,
    new.email,
    profile_full_name,
    coalesce(selected_office_organization_name, selected_organization_name, profile_organization)
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    organization = coalesce(public.profiles.organization, excluded.organization),
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

  default_office_id := public.ensure_default_office_for_user(
    new.id,
    new.email,
    selected_organization_id,
    profile_office_name
  );

  return new;
end;
$$;
