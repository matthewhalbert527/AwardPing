create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
  selected_office_id uuid;
  selected_office_name text;
  profile_full_name text;
  profile_organization text;
begin
  profile_full_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  profile_organization := nullif(trim(coalesce(new.raw_user_meta_data ->> 'organization', '')), '');

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

  insert into public.profiles (id, email, full_name, organization)
  values (
    new.id,
    new.email,
    profile_full_name,
    coalesce(profile_organization, selected_office_name)
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

delete from public.offices office
where office.name in ('New office', 'New award office')
  and not exists (
    select 1 from public.awards award
    where award.office_id = office.id
  )
  and not exists (
    select 1 from public.award_sources source
    where source.office_id = office.id
  )
  and not exists (
    select 1 from public.monitors monitor
    where monitor.office_id = office.id
  )
  and not exists (
    select 1 from public.change_events event
    where event.office_id = office.id
  );
