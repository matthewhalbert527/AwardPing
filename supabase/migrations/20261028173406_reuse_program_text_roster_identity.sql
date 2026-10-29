-- PRIVATE PROPOSED BODY ONLY. Root creates the real migration filename after rollback acceptance.
-- Exact observed prosrc preimage; only the selected-source branch changes. No grants, tables or source writes.
DO $guard$
DECLARE v_oid oid; v_before jsonb; v_after jsonb; v_actual text;
BEGIN
 v_oid:=to_regprocedure('public.get_program_text_worker_roster_page(text,jsonb,text,integer)');
 IF v_oid IS NULL THEN RAISE EXCEPTION 'Roster function absent.'; END IF;
 SELECT encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex'),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'volatility',p.provolatile,'security_definer',p.prosecdef,'config',p.proconfig,'kind',p.prokind,'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,'returns',p.prorettype,'args',p.proargtypes::text,'cost',p.procost,'rows',p.prorows)
 INTO v_actual,v_before FROM pg_catalog.pg_proc p WHERE p.oid=v_oid;
 IF v_actual IS DISTINCT FROM '765e1ffeb17e2492ba70d2469ba651c16b7b14ceb447f3502b37fd05c49da1dc' THEN RAISE EXCEPTION 'Roster function preimage changed.' USING ERRCODE='40001'; END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.get_program_text_worker_roster_page(p_kind text, p_after jsonb DEFAULT NULL::jsonb, p_expected_roster_seal text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),
   role->>'manifest_status',role->'evidence',(role->>'revision')::uuid,i.id,i.revision,i.cycle,s.scope_key
  from active_inventories i
  join public.program_variation_scopes s on s.inventory_id=i.id and not s.retired
  cross join lateral jsonb_array_elements(s.source_roles) role
  union all
  select role->>'cohort_key',role->>'scope_key',role->>'source_role',
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),role->>'manifest_status',role->'evidence',
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
 select array_agg(distinct source_ids.source_id::uuid order by source_ids.source_id::uuid) into v_ids
 from jsonb_array_elements(v_roles) as role_rows(role_entry)
 cross join lateral jsonb_array_elements_text(role_rows.role_entry->'source_ids') as source_ids(source_id);
 v_role_count:=jsonb_array_length(v_roles); v_source_count:=coalesce(cardinality(v_ids),0);
 -- Registry membership is independent of page enumeration: omitting a whole
 -- award's roles must fail the worker's exact cohort-union check as well.
 select count(*)::integer into v_cohort_count from public.stage1_award_registry;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,
  'title',s.title,'page_type',s.page_type,'admin_review_status',s.admin_review_status,
  'text_source_approvals',private.awardping_program_text_source_approval_dto(s.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(s.id,(select epoch from public.program_text_source_authority_epochs where active))) order by s.id),'[]'::jsonb)
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
  from (select s.id,identity.entry || jsonb_build_object(
   'text_monitoring_state',s.text_monitoring_state,
   'text_collection_quality',private.awardping_program_text_collection_quality(s.id)) as entry
   from jsonb_array_elements(v_sources) as identity(entry)
   join public.shared_award_sources s on s.id=(identity.entry->>'id')::uuid
   where p_after is null or s.id>(p_after#>>'{}')::uuid
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
$function$
$definition$;
 SELECT encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex'),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'volatility',p.provolatile,'security_definer',p.prosecdef,'config',p.proconfig,'kind',p.prokind,'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,'returns',p.prorettype,'args',p.proargtypes::text,'cost',p.procost,'rows',p.prorows)
 INTO v_actual,v_after FROM pg_catalog.pg_proc p WHERE p.oid=v_oid;
 IF v_actual IS DISTINCT FROM '8527832e9bc394bec75d57ae35af62febd429bf217d0fcb28b87ce2c57ebd221' OR v_after IS DISTINCT FROM v_before
 THEN RAISE EXCEPTION 'Roster function postimage or metadata mismatch.'; END IF;
END;
$guard$;
