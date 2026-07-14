-- Keep candidate deletion / archival from scanning the full rejection ledger.
create index if not exists shared_award_visual_rejection_ledger_candidate_idx
  on public.shared_award_visual_rejection_ledger (candidate_id)
  where candidate_id is not null;
