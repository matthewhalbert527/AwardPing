-- A retained source-intake review may be replayed after a downstream failure.
-- Bind every extracted fact to the originating request, field, and normalized
-- value so the replay is a no-op instead of creating duplicate candidates.

alter table public.shared_award_fact_candidates
  add column if not exists source_page_request_id uuid,
  add column if not exists intake_value_sha256 text;

-- Preserve existing history without deleting duplicate legacy rows. Exactly one
-- canonical row for each already-persisted intake fact receives the durable
-- identity; any older duplicates remain visible but cannot cause another replay
-- insert once the unique index is present.
with ranked_intake_facts as (
  select
    candidate.id,
    (candidate.metadata ->> 'source_page_request_id')::uuid as source_page_request_id,
    public.awardping_sha256_text(candidate.normalized_value #>> '{}') as intake_value_sha256,
    row_number() over (
      partition by
        (candidate.metadata ->> 'source_page_request_id')::uuid,
        candidate.field_name,
        candidate.normalized_value
      order by candidate.created_at asc, candidate.id asc
    ) as identity_rank
  from public.shared_award_fact_candidates candidate
  where candidate.source_page_request_id is null
    and candidate.intake_value_sha256 is null
    and jsonb_typeof(candidate.normalized_value) = 'string'
    and coalesce(candidate.metadata ->> 'source_page_request_id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
update public.shared_award_fact_candidates candidate
set
  source_page_request_id = ranked.source_page_request_id,
  intake_value_sha256 = ranked.intake_value_sha256
from ranked_intake_facts ranked
where ranked.id = candidate.id
  and ranked.identity_rank = 1;

alter table public.shared_award_fact_candidates
  drop constraint if exists shared_award_fact_candidates_intake_identity_check;
alter table public.shared_award_fact_candidates
  add constraint shared_award_fact_candidates_intake_identity_check check (
    ((
      (
        source_page_request_id is null
        and intake_value_sha256 is null
      )
      or (
        source_page_request_id is not null
        and intake_value_sha256 ~ '^[0-9a-f]{64}$'
        and jsonb_typeof(normalized_value) = 'string'
        and metadata ->> 'source_page_request_id' = source_page_request_id::text
        and intake_value_sha256 = public.awardping_sha256_text(normalized_value #>> '{}')
      )
    ) is true)
  );

-- The service worker inserts these candidates directly through PostgREST, so
-- it must be able to evaluate the hash helper used by the CHECK constraint.
-- The helper remains unavailable to anon/authenticated callers.
revoke all on function public.awardping_sha256_text(text)
  from public, anon, authenticated, service_role;
grant execute on function public.awardping_sha256_text(text) to service_role;

create unique index if not exists shared_award_fact_candidates_intake_identity_idx
  on public.shared_award_fact_candidates (
    source_page_request_id,
    field_name,
    intake_value_sha256
  );

create or replace function public.awardping_preserve_intake_fact_candidate_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
      old.source_page_request_id is not null
      or old.intake_value_sha256 is not null
      or new.source_page_request_id is not null
      or new.intake_value_sha256 is not null
    ) and (
      new.source_page_request_id is distinct from old.source_page_request_id
      or new.field_name is distinct from old.field_name
      or new.intake_value_sha256 is distinct from old.intake_value_sha256
      or new.normalized_value is distinct from old.normalized_value
    ) then
    raise exception using
      errcode = '55000',
      message = 'A source-intake fact candidate request/field/value identity is immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists awardping_preserve_intake_fact_candidate_identity_trigger
  on public.shared_award_fact_candidates;
create trigger awardping_preserve_intake_fact_candidate_identity_trigger
  before update on public.shared_award_fact_candidates
  for each row execute function public.awardping_preserve_intake_fact_candidate_identity();

comment on column public.shared_award_fact_candidates.source_page_request_id is
  'Durable source-intake request identity used to make retained-result replay idempotent.';
comment on column public.shared_award_fact_candidates.intake_value_sha256 is
  'SHA-256 of the normalized string value; unique with request and field for replay-safe persistence.';
