set lock_timeout = '5s';
set statement_timeout = '5min';

create index if not exists shared_awards_status_id_idx
  on public.shared_awards (status, id);

create index if not exists shared_awards_status_slug_idx
  on public.shared_awards (status, slug);

create index if not exists shared_award_sources_award_review_created_idx
  on public.shared_award_sources (
    shared_award_id,
    admin_review_status,
    created_at asc,
    id asc
  );

create index if not exists shared_award_sources_review_id_idx
  on public.shared_award_sources (admin_review_status, id);

create index if not exists shared_award_sources_review_award_idx
  on public.shared_award_sources (admin_review_status, shared_award_id);
