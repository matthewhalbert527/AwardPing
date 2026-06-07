alter table public.profiles
  add column if not exists full_name text,
  add column if not exists organization text;

update public.profiles profile
set organization = office.name,
  updated_at = now()
from public.office_members member
join public.offices office on office.id = member.office_id
where member.user_id = profile.id
  and profile.organization is null
  and office.name <> 'New award office';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
  profile_full_name text;
  profile_organization text;
begin
  profile_full_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  profile_organization := nullif(trim(coalesce(new.raw_user_meta_data ->> 'organization', '')), '');

  insert into public.profiles (id, email, full_name, organization)
  values (new.id, new.email, profile_full_name, profile_organization)
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    organization = coalesce(public.profiles.organization, excluded.organization),
    updated_at = now();

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  default_office_id := public.ensure_default_office_for_user(new.id, new.email);

  if profile_organization is not null then
    update public.offices
    set name = profile_organization,
      updated_at = now()
    where id = default_office_id
      and name = 'New award office';
  end if;

  return new;
end;
$$;
