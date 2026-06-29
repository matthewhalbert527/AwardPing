create extension if not exists pgcrypto;

alter table public.shared_awards
  add column if not exists slug text,
  add column if not exists public_facts jsonb not null default '{}'::jsonb,
  add column if not exists public_facts_generated_at timestamptz,
  add column if not exists public_facts_model text;

with award_slugs as (
  select
    id,
    coalesce(
      nullif(
        trim(
          both '-' from regexp_replace(
            regexp_replace(lower(name), '&', ' and ', 'g'),
            '[^a-z0-9]+',
            '-',
            'g'
          )
        ),
        ''
      ),
      'award-' || left(id::text, 8)
    ) as base_slug
  from public.shared_awards
  where slug is null
),
ranked_award_slugs as (
  select
    id,
    base_slug,
    row_number() over (partition by base_slug order by id) as duplicate_index
  from award_slugs
)
update public.shared_awards award
set slug = case
  when ranked.duplicate_index = 1 then ranked.base_slug
  else ranked.base_slug || '-' || ranked.duplicate_index::text
end
from ranked_award_slugs ranked
where award.id = ranked.id
  and award.slug is null;

create unique index if not exists shared_awards_slug_key
  on public.shared_awards (slug)
  where slug is not null;

create table if not exists public.shared_award_slug_aliases (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.shared_award_update_read_baselines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  baseline_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shared_award_change_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  shared_award_change_event_id uuid not null references public.shared_award_change_events(id) on delete cascade,
  shared_award_id uuid not null references public.shared_awards(id) on delete cascade,
  shared_award_source_id uuid references public.shared_award_sources(id) on delete set null,
  read_at timestamptz not null default now(),
  primary key (user_id, shared_award_change_event_id)
);

create index if not exists shared_award_slug_aliases_award_idx
  on public.shared_award_slug_aliases (shared_award_id);

create index if not exists shared_award_change_reads_user_award_idx
  on public.shared_award_change_reads (user_id, shared_award_id, read_at desc);

create index if not exists shared_award_change_reads_source_idx
  on public.shared_award_change_reads (shared_award_source_id, read_at desc);

alter table public.shared_award_slug_aliases enable row level security;
alter table public.shared_award_update_read_baselines enable row level security;
alter table public.shared_award_change_reads enable row level security;

grant select on table public.shared_award_slug_aliases to anon, authenticated;
grant all on table public.shared_award_slug_aliases to service_role;

grant select, insert, update on table public.shared_award_update_read_baselines to authenticated;
grant all on table public.shared_award_update_read_baselines to service_role;

grant select, insert, update, delete on table public.shared_award_change_reads to authenticated;
grant all on table public.shared_award_change_reads to service_role;

drop policy if exists "shared award aliases visible for active awards" on public.shared_award_slug_aliases;
create policy "shared award aliases visible for active awards" on public.shared_award_slug_aliases
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.shared_awards
      where shared_awards.id = shared_award_slug_aliases.shared_award_id
        and shared_awards.status = 'active'
    )
  );

drop policy if exists "read baselines are user owned" on public.shared_award_update_read_baselines;
create policy "read baselines are user owned" on public.shared_award_update_read_baselines
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "change reads are user owned" on public.shared_award_change_reads;
create policy "change reads are user owned" on public.shared_award_change_reads
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
