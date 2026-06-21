alter table if exists public.awardping_bad_worker_sources_backup_20260524
  enable row level security;

alter table if exists public.awardping_bad_worker_snapshots_backup_20260524
  enable row level security;

alter table if exists public.awardping_bad_worker_events_backup_20260524
  enable row level security;

alter table if exists public.awardping_duplicate_monitors_backup_20260524
  enable row level security;

alter table if exists public.awardping_duplicate_award_sources_backup_20260524
  enable row level security;
