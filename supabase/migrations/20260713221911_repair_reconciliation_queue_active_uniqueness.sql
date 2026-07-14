drop index if exists public.shared_award_reconciliation_queue_pending_reason_idx;

with ranked_active_rows as (
  select
    id,
    row_number() over (
      partition by shared_award_id
      order by priority asc, created_at asc, id asc
    ) as active_rank
  from public.shared_award_reconciliation_queue
  where status in ('pending', 'processing')
)
update public.shared_award_reconciliation_queue as queue
set
  status = 'skipped',
  completed_at = coalesce(queue.completed_at, now()),
  error = coalesce(queue.error, 'superseded_duplicate_active_queue_row')
from ranked_active_rows
where queue.id = ranked_active_rows.id
  and ranked_active_rows.active_rank > 1;

create unique index if not exists shared_award_reconciliation_queue_active_award_idx
  on public.shared_award_reconciliation_queue (shared_award_id)
  where status in ('pending', 'processing');
