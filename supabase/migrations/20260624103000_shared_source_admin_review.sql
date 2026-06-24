alter table public.shared_award_sources
  add column if not exists admin_review_status text not null default 'open' check (
    admin_review_status in ('open', 'review_later')
  ),
  add column if not exists admin_review_note text,
  add column if not exists admin_reviewed_at timestamptz,
  add column if not exists admin_reviewed_by text;

create index if not exists shared_award_sources_admin_review_idx
  on public.shared_award_sources (admin_review_status, updated_at desc);

drop policy if exists "shared award sources visible to authenticated users" on public.shared_award_sources;
create policy "shared award sources visible to authenticated users" on public.shared_award_sources
  for select using (
    auth.uid() is not null
    and shared_award_sources.admin_review_status = 'open'
    and exists (
      select 1 from public.shared_awards
      where shared_awards.id = shared_award_sources.shared_award_id
      and shared_awards.status = 'active'
    )
  );
