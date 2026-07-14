-- These one-time recovery tables were created during the 2026-05-24 cleanup.
-- They are no longer referenced by AwardPing and can be removed without CASCADE.
drop table if exists public.awardping_bad_worker_events_backup_20260524;
drop table if exists public.awardping_bad_worker_snapshots_backup_20260524;
drop table if exists public.awardping_bad_worker_sources_backup_20260524;
drop table if exists public.awardping_duplicate_award_sources_backup_20260524;
drop table if exists public.awardping_duplicate_monitors_backup_20260524;
