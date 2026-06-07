alter table public.office_invites
  alter column email drop not null,
  add column if not exists invite_code text;

update public.office_invites
set invite_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
where invite_code is null;

alter table public.office_invites
  alter column invite_code set not null;

create unique index if not exists office_invites_code_idx
  on public.office_invites (invite_code);

create or replace function public.ensure_default_office_for_user(target_user_id uuid, target_email text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
begin
  select om.office_id into default_office_id
  from public.office_members om
  where om.user_id = target_user_id
  order by om.created_at asc
  limit 1;

  if default_office_id is not null then
    return default_office_id;
  end if;

  insert into public.offices (name, created_by)
  values ('New award office', target_user_id)
  returning id into default_office_id;

  insert into public.office_members (office_id, user_id, email, role, notification_preference, status)
  values (default_office_id, target_user_id, target_email, 'owner', 'immediate', 'active')
  on conflict (office_id, user_id) do nothing;

  return default_office_id;
end;
$$;

update public.offices
set name = 'New award office',
  updated_at = now()
where name ~ '^[^@]+''s office$';
