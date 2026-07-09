alter table public.shared_award_change_events
  add column if not exists suppressed_at timestamptz,
  add column if not exists suppression_reason text,
  add column if not exists suppression_source text;

create index if not exists shared_award_change_events_unsuppressed_detected_idx
  on public.shared_award_change_events (shared_award_id, detected_at desc)
  where suppressed_at is null;

create index if not exists shared_award_change_events_suppressed_idx
  on public.shared_award_change_events (suppressed_at)
  where suppressed_at is not null;
