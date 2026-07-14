-- The review/export workers page through wide rows in these orders. Without
-- matching indexes PostgreSQL repeatedly sorts the full tables to disk for
-- every 1,000-row page, exhausting the project's disk I/O budget.
create index if not exists shared_award_sources_updated_at_id_idx
  on public.shared_award_sources (updated_at desc, id);

create index if not exists shared_award_source_visual_snapshots_updated_at_source_idx
  on public.shared_award_source_visual_snapshots (updated_at desc, shared_award_source_id);

create index if not exists shared_award_sources_created_at_id_idx
  on public.shared_award_sources (created_at, id);

-- Open sources are a small subset of the catalog. These partial indexes keep
-- the recurring worker scans small while avoiding full-table sort spills.
create index if not exists shared_award_sources_open_created_at_id_idx
  on public.shared_award_sources (created_at, id)
  where admin_review_status = 'open';

create index if not exists shared_award_sources_open_id_idx
  on public.shared_award_sources (id)
  where admin_review_status = 'open';

create index if not exists shared_award_sources_open_metadata_generated_at_id_idx
  on public.shared_award_sources (page_metadata_generated_at desc, id)
  where admin_review_status = 'open'
    and page_metadata_generated_at is not null;

-- No application query filters on local_worker_runs.metadata. The unused GIN
-- index was larger than the table and amplified every run-metadata update.
drop index if exists public.local_worker_runs_metadata_gin_idx;
