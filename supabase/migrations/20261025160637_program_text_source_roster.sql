-- Separate collection authority from the preserved visual/fact manifests.
-- Seeding preserves the exact reviewed identities; it approves no new facts.
create table public.program_text_source_roster (
 cohort_key text not null references public.stage1_award_registry(cohort_key),
 source_role text not null,
 manifest_status text generated always as ('reviewed_text'::text) stored,
 source_ids uuid[] not null check(cardinality(source_ids) between 1 and 50),
 evidence jsonb not null check(jsonb_typeof(evidence)='object'),
 revision uuid not null default gen_random_uuid(),
 reviewed_by text not null check(length(btrim(reviewed_by)) between 1 and 320),
 reviewed_at timestamptz not null default now(),
 primary key(cohort_key,source_role)
);
create table public.program_text_source_roster_events (
 id uuid primary key default gen_random_uuid(),
 cohort_key text not null,
 source_role text not null,
 previous_entry jsonb not null,
 next_entry jsonb not null,
 reviewed_by text not null,
 created_at timestamptz not null default now()
);
alter table public.program_text_source_roster enable row level security;
alter table public.program_text_source_roster_events enable row level security;
revoke all on public.program_text_source_roster,public.program_text_source_roster_events from public,anon,authenticated,service_role;
grant select on public.program_text_source_roster,public.program_text_source_roster_events to service_role;

do $$
begin
 if (select count(distinct cohort_key) from public.stage1_award_source_manifest)<>25
  or exists(select 1 from public.stage1_award_source_manifest m where m.manifest_status='missing'
   or cardinality(m.source_ids) not between 1 and 50
   or exists(select 1 from unnest(m.source_ids) input(source_id)
    left join public.shared_award_sources s on s.id=input.source_id
    left join public.stage1_award_members member on member.shared_award_id=s.shared_award_id and member.cohort_key=m.cohort_key
    where s.id is null or member.shared_award_id is null
     or m.evidence#>>array['source_bindings',input.source_id::text,'source_url'] is distinct from s.url))
 then raise exception 'Reviewed source roster cannot be seeded incompletely.'; end if;
end $$;
insert into public.program_text_source_roster(cohort_key,source_role,source_ids,evidence,reviewed_by)
select m.cohort_key,m.source_role,m.source_ids,
 jsonb_build_object('schema','awardping.program-text-source-role.v1','source_bindings',
  (select jsonb_object_agg(s.id::text,jsonb_build_object('source_url',s.url,'shared_award_id',s.shared_award_id,
   'authority_url',r.official_homepage,'review_note','Inherited collection role from the reviewed roster; not a new factual approval.'))
   from public.shared_award_sources s where s.id=any(m.source_ids))),
 'seed:reviewed-legacy-roster'
from public.stage1_award_source_manifest m join public.stage1_award_registry r using(cohort_key);

create function public.get_program_text_source_roster()
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'source_role',source_role,
  'source_ids',source_ids,'manifest_status','reviewed_text','evidence',evidence,
  'revision',revision,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at) order by cohort_key,source_role),'[]'::jsonb)
 from public.program_text_source_roster;
$$;
revoke all on function public.get_program_text_source_roster() from public,anon,authenticated;
grant execute on function public.get_program_text_source_roster() to service_role;

create function public.replace_program_text_source_role(
 p_cohort text,p_role text,p_expected_revision uuid,p_source_ids uuid[],p_evidence jsonb,p_reviewer text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_old public.program_text_source_roster%rowtype; v_new public.program_text_source_roster%rowtype;
 v_source public.shared_award_sources%rowtype; v_id uuid; v_binding jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if p_expected_revision is null or p_source_ids is null or cardinality(p_source_ids) not between 1 and 50
  or array_position(p_source_ids,null) is not null
  or cardinality(p_source_ids)<>(select count(distinct x) from unnest(p_source_ids) x)
  or length(btrim(coalesce(p_reviewer,''))) not between 1 and 320
  or not private.awardping_program_exact_object(p_evidence,array['schema','source_bindings'])
  or p_evidence->>'schema' is distinct from 'awardping.program-text-source-role.v1'
  or jsonb_typeof(p_evidence->'source_bindings') is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_evidence->'source_bindings'))<>cardinality(p_source_ids)
 then raise exception 'Invalid reviewed text collection role.' using errcode='23514'; end if;
 select * into strict v_old from public.program_text_source_roster
  where cohort_key=p_cohort and source_role=p_role for update;
 if v_old.revision<>p_expected_revision then
  raise exception 'Text collection role changed; review the current version.' using errcode='40001'; end if;
 foreach v_id in array p_source_ids loop
  select * into strict v_source from public.shared_award_sources where id=v_id for share;
  v_binding:=p_evidence#>array['source_bindings',v_id::text];
  if v_source.admin_review_status is distinct from 'open'
   or not exists(select 1 from public.shared_awards a where a.id=v_source.shared_award_id and a.status='active')
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=v_source.shared_award_id)
   or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=p_cohort
    and ((r.url_pattern is not null and v_source.url ~* r.url_pattern)
     or (r.title_pattern is not null and concat_ws(' ',v_source.title,v_source.display_title) ~* r.title_pattern)))
   or not private.awardping_program_exact_object(v_binding,array['source_url','shared_award_id','authority_url','review_note'])
   or v_binding->>'source_url' is distinct from v_source.url
   or v_binding->>'shared_award_id' is distinct from v_source.shared_award_id::text
   or not coalesce(jsonb_typeof(v_binding->'authority_url')='string'
    and v_binding->>'authority_url' ~ '^https://[^[:space:]]+$'
    and length(v_binding->>'authority_url')<=4000
    and jsonb_typeof(v_binding->'review_note')='string'
    and length(btrim(v_binding->>'review_note')) between 20 and 2000,false)
  then raise exception 'Text collection role requires exact approved source/owner/authority bindings.' using errcode='23514'; end if;
 end loop;
 update public.program_text_source_roster set source_ids=p_source_ids,evidence=p_evidence,
  revision=gen_random_uuid(),reviewed_by=btrim(p_reviewer),reviewed_at=clock_timestamp()
  where cohort_key=p_cohort and source_role=p_role returning * into v_new;
 insert into public.program_text_source_roster_events(cohort_key,source_role,previous_entry,next_entry,reviewed_by)
 values(p_cohort,p_role,to_jsonb(v_old),to_jsonb(v_new),btrim(p_reviewer));
 return to_jsonb(v_new);
end;
$$;
revoke all on function public.replace_program_text_source_role(text,text,uuid,uuid[],jsonb,text) from public,anon,authenticated;
grant execute on function public.replace_program_text_source_role(text,text,uuid,uuid[],jsonb,text) to service_role;

-- Only this new text authority changes. Legacy screenshot/fact guards are intact.
create or replace function private.awardping_program_source_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(
 select 1 from public.shared_award_sources s
 join public.shared_awards a on a.id=s.shared_award_id and a.status='active'
 join public.stage1_award_members member on member.shared_award_id=s.shared_award_id
 join public.program_text_source_roster m on m.cohort_key=member.cohort_key and s.id=any(m.source_ids)
 where s.id=p_source_id and s.admin_review_status='open'
 and m.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and m.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text
 and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=m.cohort_key
  and ((r.url_pattern is not null and s.url ~* r.url_pattern)
   or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
);
$$;
notify pgrst,'reload schema';
