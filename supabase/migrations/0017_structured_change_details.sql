alter table public.shared_award_change_events
  add column if not exists change_details jsonb not null default '{}'::jsonb;

alter table public.change_events
  add column if not exists change_details jsonb not null default '{}'::jsonb;
