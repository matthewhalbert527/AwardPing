-- Observe the same approved basic-details snapshot used by the website.
-- This journal is independent of legacy regression publication gates.
create table private.program_basic_page_audit_observations (
 id uuid primary key default gen_random_uuid(),
 award_id uuid not null references public.shared_awards(id),
 cohort_key text not null references public.program_award_registry(cohort_key),
 snapshot_id uuid references public.program_basic_fact_snapshots(id),
 evaluation_revision text not null check(evaluation_revision ~ '^[a-f0-9]{64}$'),
 observation_key text not null check(observation_key ~ '^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 first_checked_at timestamptz not null default statement_timestamp(),
 last_checked_at timestamptz not null default statement_timestamp(),
 check_count bigint not null default 1 check(check_count>0),
 unique(award_id,observation_key)
);
create index program_basic_page_audit_rotation on private.program_basic_page_audit_observations(award_id,last_checked_at desc);
alter table private.program_basic_page_audit_observations enable row level security;
revoke all on private.program_basic_page_audit_observations from public,anon,authenticated,service_role;

create function public.inspect_program_basic_page_audit(p_award_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.program_award_registry%rowtype;a public.shared_awards%rowtype;
 s public.program_basic_fact_snapshots%rowtype;d public.program_text_fact_reviews%rowtype;
 published jsonb;basis jsonb;draft jsonb;
begin
 select * into r from public.program_award_registry where canonical_shared_award_id=p_award_id;
 if not found then return null;end if;
 select * into strict a from public.shared_awards where id=p_award_id;
 select x.* into s from public.program_basic_fact_heads h join public.program_basic_fact_snapshots x on x.id=h.snapshot_id where h.cohort_key=r.cohort_key;
 published:=public.get_program_basic_facts(array[p_award_id]);
 if s.id is not null then
  select * into strict d from public.program_text_fact_reviews where id=s.input_review_id;
  draft:=jsonb_build_object('id',d.id,'content_hash',d.content_hash,'validation_schema',d.validation->'schema','review',d.validation->'review',
   'content_hash_valid',d.content_hash=encode(extensions.digest(convert_to(d.validation::text,'UTF8'),'sha256'),'hex'));
 end if;
 basis:=jsonb_build_object('schema','awardping.program-basic-page-audit-basis.v1',
  'award',jsonb_build_object('id',a.id,'name',a.name,'slug',a.slug,'status',a.status),
  'cohort_key',r.cohort_key,'snapshot',case when s.id is null then null else to_jsonb(s) end,
  'draft',draft,'published',published);
 return jsonb_build_object('schema','awardping.program-basic-page-audit-context.v1','basis',basis,
  'revision',public.stage1_publication_evidence_hash(basis),
  'selected_at',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;$$;

create function public.list_program_basic_page_audit_awards(p_limit integer default 25,p_slugs text[] default null) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-basic-page-audit-roster.v1',
  'registered_award_ids',coalesce((select jsonb_agg(canonical_shared_award_id order by canonical_shared_award_id) from public.program_award_registry),'[]'::jsonb),
  'awards',coalesce((select jsonb_agg(jsonb_build_object('award_id',candidate.id,'cohort_key',candidate.cohort_key,
    'name',candidate.name,'slug',candidate.slug) order by candidate.last_checked_at asc nulls first,candidate.launch_rank)
   from (select r.canonical_shared_award_id id,r.cohort_key,a.name,a.slug,r.launch_rank,max(o.last_checked_at) last_checked_at
    from public.program_award_registry r join public.shared_awards a on a.id=r.canonical_shared_award_id
    left join private.program_basic_page_audit_observations o on o.award_id=r.canonical_shared_award_id
    where a.status='active' and (p_slugs is null or cardinality(p_slugs)=0 or a.slug=any(p_slugs))
    group by r.canonical_shared_award_id,r.cohort_key,a.name,a.slug,r.launch_rank
    order by max(o.last_checked_at) asc nulls first,r.launch_rank limit greatest(1,least(coalesce(p_limit,25),250))) candidate),'[]'::jsonb));
$$;

create function public.record_program_basic_page_audit(p_award_id uuid,p_expected_revision text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb;basis jsonb;observation text;v_id uuid;inserted boolean;
begin
 -- The same national fence used by basic publication prevents a concurrent
 -- publication from passing between our fresh getter check and journal write.
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform 1 from public.program_award_registry where canonical_shared_award_id=p_award_id for share;
 context:=public.inspect_program_basic_page_audit(p_award_id);basis:=context->'basis';
 if context is null or p_expected_revision is null or p_expected_revision !~ '^[a-f0-9]{64}$' or context->>'revision' is distinct from p_expected_revision
 then raise exception 'Basic page audit inputs changed.' using errcode='40001';end if;
 if not private.awardping_program_exact_object(p_result,array['schema','award_id','cohort_key','snapshot_id','evaluation_revision','evaluated_at',
  'audit_status','severity','findings','field_count','value_count','capture_count','applied_to_public','observation_only'])
  or p_result->>'schema' is distinct from 'awardping.program-basic-page-audit-result.v1'
  or p_result->>'award_id' is distinct from p_award_id::text or p_result->>'cohort_key' is distinct from basis->>'cohort_key'
  or p_result->'snapshot_id' is distinct from coalesce(basis#>'{snapshot,id}','null'::jsonb)
  or p_result->>'evaluation_revision' is distinct from p_expected_revision
  or p_result->'applied_to_public' is distinct from 'false'::jsonb or p_result->'observation_only' is distinct from 'true'::jsonb
  or p_result->>'audit_status' not in ('passed','failed') or p_result->>'severity' not in ('none','error')
  or jsonb_typeof(p_result->'findings') is distinct from 'array' or jsonb_array_length(p_result->'findings')>100
  or (p_result->>'audit_status'='passed') is distinct from (p_result->>'severity'='none')
  or (p_result->>'audit_status'='passed') is distinct from (p_result->'findings'='[]'::jsonb)
  or jsonb_typeof(p_result->'field_count') is distinct from 'number' or jsonb_typeof(p_result->'value_count') is distinct from 'number'
  or jsonb_typeof(p_result->'capture_count') is distinct from 'number' or jsonb_typeof(p_result->'evaluated_at') is distinct from 'string'
  or coalesce(p_result->>'field_count','') !~ '^(0|[1-9][0-9]{0,2})$' or (p_result->>'field_count')::integer>15
  or coalesce(p_result->>'value_count','') !~ '^(0|[1-9][0-9]{0,3})$' or (p_result->>'value_count')::integer>960
  or coalesce(p_result->>'capture_count','') !~ '^(0|[1-9][0-9]{0,3})$' or (p_result->>'capture_count')::integer>1000
  or (p_result->>'evaluated_at')::timestamptz>statement_timestamp() or (p_result->>'evaluated_at')::timestamptz<statement_timestamp()-interval '2 hours'
  or octet_length(p_result::text)>262144
 then raise exception 'Invalid observation-only basic page audit result.' using errcode='23514';end if;
 if p_result->>'audit_status'='passed' and (basis#>>'{snapshot,id}' is null or jsonb_array_length(basis->'published')<>1
  or basis#>'{published,0,current}' is distinct from 'true'::jsonb or basis#>'{published,0,public_facts}' is distinct from basis#>'{snapshot,public_facts}')
 then raise exception 'A passing basic page audit requires current published details.' using errcode='23514';end if;
 observation:=public.stage1_publication_evidence_hash(p_result-'evaluated_at');
 insert into private.program_basic_page_audit_observations(award_id,cohort_key,snapshot_id,evaluation_revision,observation_key,result)
 values(p_award_id,basis->>'cohort_key',(basis#>>'{snapshot,id}')::uuid,p_expected_revision,observation,p_result)
 on conflict(award_id,observation_key) do nothing returning id into v_id;
 inserted:=found;
 if not inserted then
  update private.program_basic_page_audit_observations set last_checked_at=statement_timestamp(),check_count=check_count+1
   where award_id=p_award_id and observation_key=observation returning id into strict v_id;
 end if;
 return jsonb_build_object('audit_id',v_id,'inserted',inserted,'observation_only',true);
end;$$;

revoke all on function public.inspect_program_basic_page_audit(uuid),public.list_program_basic_page_audit_awards(integer,text[]),
 public.record_program_basic_page_audit(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.inspect_program_basic_page_audit(uuid),public.list_program_basic_page_audit_awards(integer,text[]),
 public.record_program_basic_page_audit(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
