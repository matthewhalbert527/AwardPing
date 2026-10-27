-- Complete worker enumeration without a global roster cap or an oversized IN URL.
-- Each STABLE call observes one statement snapshot. Identity changes between
-- calls invalidate the pinned seal; mutable capture state remains CAS-guarded.
-- Later text-only approval migration replaces this closed default. Existing
-- open sources remain compatible; no held source gains authority here.
create function private.awardping_program_text_source_approval_dto(p_source_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$ select '[]'::jsonb; $$;
revoke all on function private.awardping_program_text_source_approval_dto(uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_approval_dto(uuid) to service_role;
create function private.awardping_program_text_registered_source_roles()
returns jsonb language sql stable security invoker set search_path='' as $$ select '[]'::jsonb; $$;
revoke all on function private.awardping_program_text_registered_source_roles() from public,anon,authenticated;
grant execute on function private.awardping_program_text_registered_source_roles() to service_role;

create function public.get_program_text_worker_roster_page(
 p_kind text,p_after jsonb default null,p_expected_roster_seal text default null,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
 v_roles jsonb; v_sources jsonb; v_ids uuid[]; v_seal text; v_entries jsonb; v_next jsonb;
 v_role_count integer; v_source_count integer; v_cohort_count integer;
begin
 if p_kind is null or p_kind not in ('roles','sources','check') or p_limit is null or p_limit not between 1 and 100
  or p_expected_roster_seal is not null and p_expected_roster_seal !~ '^[a-f0-9]{64}$'
  or p_kind='check' and (p_after is not null or p_expected_roster_seal is null)
 then raise exception 'Invalid worker roster page request.' using errcode='23514'; end if;
 if p_after is not null then
  if p_expected_roster_seal is null then raise exception 'Roster cursor requires its identity seal.' using errcode='23514'; end if;
  if p_kind='roles' then
   if jsonb_typeof(p_after) is distinct from 'array' or jsonb_array_length(p_after)<>3 then
    raise exception 'Invalid worker role cursor.' using errcode='23514'; end if;
   if exists(select 1 from jsonb_array_elements(p_after) item
    where jsonb_typeof(item)<>'string' or item#>>'{}' !~ '^[a-z0-9_-]{1,200}$')
    or length(p_after->>0)>80 or length(p_after->>2)>80 then
    raise exception 'Invalid worker role cursor.' using errcode='23514'; end if;
  elsif p_kind='sources' and (jsonb_typeof(p_after) is distinct from 'string'
   or p_after#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
   raise exception 'Invalid worker source cursor.' using errcode='23514';
  end if;
 end if;

 with active_inventories as (
  select i.* from public.program_variation_inventories i where i.status='sealed' and
   (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.cohort_key=i.cohort_key and h.revision=i.revision)
    or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
     on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 ),roles as (
  select r.cohort_key,'legacy_common'::text as scope_key,r.source_role,r.source_ids,r.manifest_status,r.evidence,r.revision,
   null::uuid as inventory_id,null::uuid as inventory_revision,null::text as cycle,null::text as variation_scope_key
  from public.program_text_source_roster r
  where not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i
   on i.id=h.inventory_id and i.cohort_key=h.cohort_key and i.revision=h.revision and i.status='sealed' where h.cohort_key=r.cohort_key)
  union all
  select i.cohort_key,'inventory_'||replace(i.id::text,'-','')||'_'||s.scope_key,role->>'source_role',
   array(select value::uuid from jsonb_array_elements_text(role->'source_ids') value),
   role->>'manifest_status',role->'evidence',(role->>'revision')::uuid,i.id,i.revision,i.cycle,s.scope_key
  from active_inventories i
  join public.program_variation_scopes s on s.inventory_id=i.id and not s.retired
  cross join lateral jsonb_array_elements(s.source_roles) role
  union all
  select role->>'cohort_key',role->>'scope_key',role->>'source_role',
   array(select value::uuid from jsonb_array_elements_text(role->'source_ids') value),role->>'manifest_status',role->'evidence',
   (role->>'revision')::uuid,(role->>'inventory_id')::uuid,(role->>'inventory_revision')::uuid,role->>'cycle',role->>'variation_scope_key'
  from jsonb_array_elements(private.awardping_program_text_registered_source_roles()) role
 )
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'scope_key',scope_key,'source_role',source_role,
  'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence,'revision',revision,
  'inventory_id',inventory_id,'inventory_revision',inventory_revision,'cycle',cycle,'variation_scope_key',variation_scope_key)
  order by cohort_key collate "C",scope_key collate "C",source_role collate "C"),'[]'::jsonb)
 into v_roles from roles;
 if exists(select 1 from jsonb_array_elements(v_roles) role
  group by role->>'cohort_key',role->>'scope_key',role->>'source_role' having count(*)<>1) then
  raise exception 'Worker roster has duplicate role identities.' using errcode='23514'; end if;
 select array_agg(distinct value::uuid order by value::uuid) into v_ids
 from jsonb_array_elements(v_roles) role cross join lateral jsonb_array_elements_text(role->'source_ids') value;
 v_role_count:=jsonb_array_length(v_roles); v_source_count:=coalesce(cardinality(v_ids),0);
 -- Registry membership is independent of page enumeration: omitting a whole
 -- award's roles must fail the worker's exact cohort-union check as well.
 select count(*)::integer into v_cohort_count from public.stage1_award_registry;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,
  'title',s.title,'page_type',s.page_type,'admin_review_status',s.admin_review_status,
  'text_source_approvals',private.awardping_program_text_source_approval_dto(s.id)) order by s.id),'[]'::jsonb)
 into v_sources from public.shared_award_sources s where s.id=any(v_ids);
 if jsonb_array_length(v_sources)<>v_source_count then
  raise exception 'Worker roster source identities are incomplete.' using errcode='23514'; end if;
 v_seal:=encode(extensions.digest(convert_to(jsonb_build_object('roles',v_roles,'sources',v_sources)::text,'UTF8'),'sha256'),'hex');
 if p_expected_roster_seal is not null and v_seal<>p_expected_roster_seal then
  raise exception 'Worker roster identity changed during enumeration.' using errcode='40001'; end if;

 if p_kind='roles' then
  select coalesce(jsonb_agg(entry order by ordinal),'[]'::jsonb) into v_entries
  from (select entry,ordinal from jsonb_array_elements(v_roles) with ordinality role(entry,ordinal)
   where p_after is null or row((entry->>'cohort_key') collate "C",(entry->>'scope_key') collate "C",(entry->>'source_role') collate "C")>
    row((p_after->>0) collate "C",(p_after->>1) collate "C",(p_after->>2) collate "C")
   order by ordinal limit p_limit+1) page;
 elsif p_kind='sources' then
  select coalesce(jsonb_agg(entry order by id),'[]'::jsonb) into v_entries
  from (select s.id,jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,
   'page_type',s.page_type,'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state,
   'text_source_approvals',private.awardping_program_text_source_approval_dto(s.id)) as entry
   from public.shared_award_sources s where s.id=any(v_ids) and (p_after is null or s.id>(p_after#>>'{}')::uuid)
   order by s.id limit p_limit+1) page;
 else v_entries:='[]'::jsonb;
 end if;
 v_next:=null;
 if jsonb_array_length(v_entries)>p_limit then
  v_entries:=v_entries-(p_limit);
  v_next:=case when p_kind='roles' then jsonb_build_array(v_entries->(p_limit-1)->>'cohort_key',
   v_entries->(p_limit-1)->>'scope_key',v_entries->(p_limit-1)->>'source_role')
   else v_entries->(p_limit-1)->'id' end;
 end if;
 return jsonb_build_object('schema','awardping.program-text-worker-roster-page.v1','roster_seal',v_seal,
  'role_count',v_role_count,'source_count',v_source_count,'cohort_count',v_cohort_count,'entries',v_entries,'next_cursor',v_next);
end;
$$;
revoke all on function public.get_program_text_worker_roster_page(text,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.get_program_text_worker_roster_page(text,jsonb,text,integer) to service_role;
notify pgrst,'reload schema';
