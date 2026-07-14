-- Pin helper/trigger function name resolution so objects on a caller-controlled
-- search path cannot shadow the functions and relations they use.
alter function public.normalized_lookup_name(text) set search_path = '';
alter function public.awardping_slugify(text) set search_path = '';
alter function public.set_shared_award_slug() set search_path = '';

-- This production trigger predated the repository migration history. Define it
-- here before hardening its privileges so a fresh database replay is complete.
create or replace function public.awardping_limit_worker_discovered_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reason like 'Local worker discovered%' then
    if (
      select count(*)
      from public.shared_award_sources existing
      where existing.shared_award_id = new.shared_award_id
    ) >= 25 then
      return null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists awardping_limit_worker_discovered_sources_trigger
  on public.shared_award_sources;
create trigger awardping_limit_worker_discovered_sources_trigger
  before insert on public.shared_award_sources
  for each row
  execute function public.awardping_limit_worker_discovered_sources();

-- These SECURITY DEFINER functions are triggers, implementation details, or
-- server-only RPCs. The browser roles must not be able to invoke them directly.
revoke execute on function public.awardping_limit_worker_discovered_sources()
  from public, anon, authenticated;
revoke execute on function public.default_watchlist_awards()
  from public, anon, authenticated;
revoke execute on function public.ensure_default_office_for_user(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.ensure_organization_for_name(text, uuid)
  from public, anon, authenticated;
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;
revoke execute on function public.seed_default_awards_for_office(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.ensure_default_office_for_user(uuid, text, uuid, text)
  to service_role;
grant execute on function public.seed_default_awards_for_office(uuid, uuid)
  to service_role;

-- RLS policies call these membership helpers as signed-in users, so retain
-- authenticated access while preventing unauthenticated direct RPC calls.
revoke execute on function public.is_office_admin(uuid, uuid)
  from public, anon;
revoke execute on function public.is_office_member(uuid, uuid)
  from public, anon;
grant execute on function public.is_office_admin(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.is_office_member(uuid, uuid)
  to authenticated, service_role;
