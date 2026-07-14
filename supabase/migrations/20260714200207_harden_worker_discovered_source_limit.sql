-- Forward-apply the source-cap trigger definition added to the replay-safe
-- hardening migration after that migration had already run in production.
create or replace function public.awardping_limit_worker_discovered_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The live source check permits seed/user/admin. Worker-discovered rows use
  -- the allowed admin provenance plus a stable metadata kind; prose reasons
  -- are deliberately not part of this enforcement contract.
  if new.source = 'admin'
    and coalesce(new.page_metadata ->> 'kind', '') = 'source_discovery_candidate' then
    -- Serialize the count-and-insert decision per award so simultaneous visual
    -- capture shards cannot each admit rows past the global cap.
    perform 1
    from public.shared_awards award
    where award.id = new.shared_award_id
    for update;

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

revoke execute on function public.awardping_limit_worker_discovered_sources()
  from public, anon, authenticated;
