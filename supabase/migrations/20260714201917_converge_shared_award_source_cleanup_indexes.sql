-- Production's previously missing history row for 20260703093000 was repaired
-- and verified on 2026-07-14. If another environment is still missing it, mark
-- 20260703093000 applied before this migration; see
-- docs/supabase-migration-history.md. Do not execute the old migration.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Keep the index used by active-award ID keyset scans.
create index if not exists shared_awards_status_id_idx
  on public.shared_awards (status, id);

-- These indexes came from the unapplied 20260703093000 migration. Its cleanup
-- query changed from created_at pagination to ID pagination on the same day,
-- and later partial open-source indexes cover the recurring worker scans.
-- Drop them if another environment applied the historical migration so every
-- environment converges on the production index set.
drop index if exists public.shared_awards_status_slug_idx;
drop index if exists public.shared_award_sources_award_review_created_idx;
drop index if exists public.shared_award_sources_review_id_idx;
drop index if exists public.shared_award_sources_review_award_idx;
