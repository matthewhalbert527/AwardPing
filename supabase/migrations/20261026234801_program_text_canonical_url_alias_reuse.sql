-- Explicit existing canonical reuse across preserved, reviewed same-cohort URL aliases.
-- No alias source, legacy approval, capture, monitoring state or fact is changed.
-- The existing unique(owner, normalized URL) index preserves owner identities;
-- a nonunique URL-leading index also supports global collision lookups.
create index shared_award_sources_program_text_url_alias_idx on public.shared_award_sources
 ((lower(regexp_replace(split_part(url,'#',1),'/+$',''))));

alter table public.program_text_source_pending_requests add column url_alias_boundary jsonb not null default '[]'::jsonb
 check(jsonb_typeof(url_alias_boundary)='array');
alter table public.program_text_source_approvals add column url_alias_boundary jsonb not null default '[]'::jsonb
 check(jsonb_typeof(url_alias_boundary)='array');

create function private.awardping_program_text_url_alias_boundary(
 p_source_id uuid,p_cohort text,p_owner uuid,p_url text,p_create boolean)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;canonical_id uuid;
begin
 select canonical_shared_award_id into strict canonical_id from public.stage1_award_registry where cohort_key=p_cohort;
 if p_source_id is null or p_owner is null or p_url is null or p_create is null
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards a on a.id=m.shared_award_id and a.status='active'
   where m.shared_award_id=p_owner and m.cohort_key=p_cohort)
  or not p_create and not exists(select 1 from public.shared_award_sources s where s.id=p_source_id and s.shared_award_id=p_owner and s.url=p_url)
 then raise exception 'Explicit source/owner/cohort identity is unavailable.' using errcode='23514';end if;
 select coalesce(jsonb_agg(jsonb_build_object('source_id',x.id,'shared_award_id',x.shared_award_id,'source_url',x.url,
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('cohort_key',m.cohort_key,'member_kind',m.member_kind) order by m.cohort_key,m.member_kind)
   from public.stage1_award_members m where m.shared_award_id=x.shared_award_id),'[]'::jsonb)) order by x.id),'[]'::jsonb)
 into result from public.shared_award_sources x where x.id<>p_source_id
  and lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(split_part(p_url,'#',1),'/+$',''));
 if result='[]'::jsonb then return result;end if;
 if p_create or p_owner<>canonical_id
  or not exists(select 1 from public.stage1_award_members m where m.shared_award_id=p_owner and m.cohort_key=p_cohort and m.member_kind='canonical')
  or exists(select 1 from jsonb_array_elements(result) as aliases(entry)
   where jsonb_array_length(aliases.entry->'memberships')<>1 or aliases.entry#>>'{memberships,0,cohort_key}' is distinct from p_cohort)
  or exists(select 1 from public.shared_award_sources x left join public.shared_awards a on a.id=x.shared_award_id
   where x.id<>p_source_id and lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(split_part(p_url,'#',1),'/+$',''))
    and (a.status is distinct from 'active' or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=p_cohort
     and ((r.url_pattern is not null and x.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',x.title,x.display_title) ~* r.title_pattern)))))
 then raise exception 'A normalized URL collision is not an explicit existing canonical same-cohort reuse.' using errcode='23505';end if;
 return result;
end;
$$;
revoke all on function private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean) to service_role;

create function private.awardping_program_text_url_alias_boundary_current(
 p_source_id uuid,p_cohort text,p_owner uuid,p_url text,p_boundary jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 return p_boundary is not null and private.awardping_program_text_url_alias_boundary(p_source_id,p_cohort,p_owner,p_url,false)=p_boundary;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb) to service_role;

create function private.awardping_program_text_source_alias_proof_hash(p_validation jsonb,p_boundary jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(extensions.digest(convert_to(case when p_boundary='[]'::jsonb then p_validation::text
  else jsonb_build_object('schema','awardping.program-text-source-url-alias-proof.v1','validation',p_validation,'url_alias_boundary',p_boundary)::text end,'UTF8'),'sha256'),'hex');
$$;
revoke all on function private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb) to service_role;

-- A short NOWAIT identity section excludes phantom alias inserts/deletes and
-- membership moves by every ordinary writer, without changing their workflow.
-- Retained-text validation runs before this section; contention fails closed.
create function private.awardping_program_text_lock_alias_context(p_proposal jsonb)
returns void language plpgsql volatile security invoker set search_path='' as $$
declare authority jsonb:=p_proposal->'authority_ref';epoch_id uuid;
begin
 lock table public.shared_award_sources in share mode nowait;
 lock table public.stage1_award_members in share mode nowait;
 perform 1 from public.stage1_award_registry where cohort_key=p_proposal->>'cohort_key' for share nowait;
 select epoch into strict epoch_id from public.program_text_source_authority_epochs where active for share nowait;
 perform 1 from public.shared_awards a where a.id in (
  select s.shared_award_id from public.shared_award_sources s where s.id=(authority#>>'{source,id}')::uuid
   or lower(regexp_replace(split_part(s.url,'#',1),'/+$',''))=lower(regexp_replace(split_part(p_proposal#>>'{source,url}','#',1),'/+$',''))
  union select (p_proposal#>>'{source,shared_award_id}')::uuid) for share nowait;
 if epoch_id::text is distinct from p_proposal->>'epoch'
  or not exists(select 1 from public.shared_award_sources a where a.id=(authority#>>'{source,id}')::uuid
   and a.shared_award_id::text=authority#>>'{source,shared_award_id}' and a.url=authority#>>'{source,url}'
   and a.text_monitoring_state->'latest_ref'=authority
   and private.awardping_program_text_source_access(a.id,p_proposal->>'cohort_key',epoch_id)
   and private.awardping_program_source_allowed(a.id))
 then raise exception 'Provider authority advanced before the final locked identity check.' using errcode='40001';end if;
end;
$$;
revoke all on function private.awardping_program_text_lock_alias_context(jsonb) from public,anon,authenticated,service_role;


create or replace function public.get_program_text_source_pending_capture(p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare request public.program_text_source_pending_requests%rowtype;s public.shared_award_sources%rowtype;
 snapshot jsonb;proof public.program_text_source_probe_receipts%rowtype;
begin
 select * into strict request from public.program_text_source_pending_requests where id=p_id;
 if not private.awardping_program_source_pending_valid(request.validation) then raise exception 'Pending provider/role/epoch authority changed.' using errcode='40001';end if;
 select * into strict s from public.shared_award_sources where id=request.source_id;
 snapshot:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state);
 if not private.awardping_program_text_url_alias_boundary_current(s.id,request.cohort_key,s.shared_award_id,s.url,request.url_alias_boundary) then
  raise exception 'Preserved normalized URL alias identities changed.' using errcode='40001';end if;
 if snapshot is distinct from request.source_snapshot then raise exception 'Pending source identity or preserved history changed.' using errcode='40001';end if;
 select * into proof from public.program_text_source_probe_receipts where pending_id=request.id;
 return jsonb_build_object('schema','awardping.program-text-source-pending-capture.v1','id',request.id,'content_hash',request.content_hash,
  'epoch',request.epoch,'source',snapshot,'role_revisions',coalesce((select jsonb_agg(jsonb_build_object('source_role',value->>'source_role','revision',value->>'expected_revision') order by value->>'source_role') from jsonb_array_elements(request.validation#>'{proposal,roles}')),'[]'::jsonb),
  'registration_scope',request.validation#>'{proposal,registration_scope}',
  'proof',case when proof.pending_id is null then 'null'::jsonb else jsonb_build_object('reference',proof.document->'reference','content_hash',proof.content_hash) end);
end;
$$;

create or replace function public.prepare_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare src jsonb:=p_proposal->'source';s public.shared_award_sources%rowtype;old public.program_text_source_pending_requests%rowtype;
 c jsonb;new_hash text;source_snapshot jsonb;source_id uuid;alias_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if p_validation->'proposal' is distinct from p_proposal or not private.awardping_program_source_pending_valid(p_validation)
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320 then raise exception 'Invalid current pending text-source proof.' using errcode='23514';end if;
 new_hash:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
 select * into old from public.program_text_source_pending_requests where id=(p_proposal->>'id')::uuid;
 if found then
  if old.content_hash<>private.awardping_program_text_source_alias_proof_hash(p_validation,old.url_alias_boundary) or old.validation<>p_validation then raise exception 'Pending identity was reused.' using errcode='40001';end if;
  return public.get_program_text_source_pending_capture(old.id);
 end if;
 for c in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  perform 1 from public.program_text_source_roster where cohort_key=p_proposal->>'cohort_key' and source_role=c->>'source_role' for share;
 end loop;
 source_id:=(src->>'id')::uuid;
 perform private.awardping_program_text_lock_alias_context(p_proposal);
 select * into s from public.shared_award_sources where id=source_id for update;
 if (src->>'create')::boolean then
  if found or src->>'expected_member_kind'<>'canonical' or src->>'shared_award_id'<>p_proposal->>'expected_canonical_shared_award_id'
   or src->'expected_admin_review_status' is distinct from 'null'::jsonb or src->'expected_text_monitoring_state' is distinct from '{}'::jsonb then
   raise exception 'A new pending source requires an unused canonical identity and empty history.' using errcode='23514';end if;
 else
  if not found or s.shared_award_id::text is distinct from src->>'shared_award_id' or s.url is distinct from src->>'url'
   or s.title is distinct from src->>'title' or s.page_type is distinct from src->>'page_type'
   or s.admin_review_status::text is distinct from src->>'expected_admin_review_status' or s.admin_review_status not in ('open','review_later')
   or s.text_monitoring_state is distinct from src->'expected_text_monitoring_state' then
   raise exception 'Explicit pending reuse has stale source identity or history.' using errcode='40001';end if;
 end if;
 alias_boundary:=private.awardping_program_text_url_alias_boundary(source_id,p_proposal->>'cohort_key',(src->>'shared_award_id')::uuid,src->>'url',(src->>'create')::boolean);
 new_hash:=private.awardping_program_text_source_alias_proof_hash(p_validation,alias_boundary);
 if (src->>'create')::boolean then
  insert into public.shared_award_sources(id,shared_award_id,url,title,page_type,source,confidence,reason,admin_review_status)
  values(source_id,(src->>'shared_award_id')::uuid,src->>'url',src->>'title',src->>'page_type','admin',1,
   'Pending text-only provider source; no capture, baseline, factual or legacy approval.','review_later') returning * into s;
 end if;
 source_snapshot:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state);
 insert into public.program_text_source_pending_requests(id,source_id,cohort_key,epoch,content_hash,validation,source_snapshot,url_alias_boundary,created_by)
 values((p_proposal->>'id')::uuid,s.id,p_proposal->>'cohort_key',(p_proposal->>'epoch')::uuid,new_hash,p_validation,source_snapshot,alias_boundary,p_actor);
 return public.get_program_text_source_pending_capture((p_proposal->>'id')::uuid);
end;
$$;

create or replace function public.approve_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 src jsonb:=p_proposal->'source';link jsonb:=p_validation->'provider_link';doc jsonb;target jsonb;block jsonb;change jsonb;
 registry public.stage1_award_registry%rowtype;authority public.shared_award_sources%rowtype;s public.shared_award_sources%rowtype;
 role public.program_text_source_roster%rowtype;prior public.program_text_source_approvals%rowtype;
 pending public.program_text_source_pending_requests%rowtype;probe public.program_text_source_probe_receipts%rowtype;descriptor jsonb;normalized jsonb;
 approval_id uuid;source_id uuid;owner_id uuid;policy_epoch uuid;expected_ids uuid[];next_ids uuid[];sid uuid;
 href text;resolved text;origin text;part text;parts text[]:='{}';source_url text;proof_hash text;
 roles_result jsonb:='[]'::jsonb;bindings jsonb;updated_role jsonb;old_role jsonb;alias_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if not private.awardping_program_exact_object(p_proposal,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','source','authority_ref','link_block_id','target_ref','roles','registration_scope'])
  or p_proposal->>'schema' is distinct from 'awardping.program-text-source-approval-request.v1'
  or not private.awardping_program_exact_object(src,array['id','shared_award_id','url','title','page_type','create','expected_member_kind','expected_admin_review_status','expected_text_monitoring_state'])
  or not private.awardping_program_exact_object(p_validation,array['schema','proposal','source_text','provider_link'])
  or p_validation->>'schema' is distinct from 'awardping.program-text-source-approval-proof.v1'
  or p_validation->'proposal' is distinct from p_proposal
  or octet_length(p_proposal::text)>262144 or octet_length(p_validation::text)>16777216
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or coalesce(p_proposal->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(p_proposal->>'cohort_key','') !~ '^[a-z0-9_-]{1,80}$'
  or coalesce(src->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(src->>'shared_award_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or jsonb_typeof(src->'create') is distinct from 'boolean' or jsonb_typeof(src->'expected_text_monitoring_state') is distinct from 'object'
  or src->>'expected_member_kind' not in ('canonical','alias')
  or jsonb_typeof(src->'title') is distinct from 'string' or length(btrim(src->>'title')) not between 1 and 1000
  or src->>'page_type' not in ('homepage','deadline','application','eligibility','requirements','pdf','faq','other')
  or jsonb_typeof(p_proposal->'roles') is distinct from 'array' or jsonb_array_length(p_proposal->'roles')>50
 then raise exception 'Invalid explicit text-only source approval.' using errcode='23514'; end if;
 approval_id:=(p_proposal->>'id')::uuid;source_id:=(src->>'id')::uuid;owner_id:=(src->>'shared_award_id')::uuid;source_url:=src->>'url';
 select epoch into strict policy_epoch from public.program_text_source_authority_epochs where active;
 if p_proposal->>'epoch' is distinct from policy_epoch::text or source_url is null
  or (source_url !~ '^https://[^/@\\?#[:space:]]+(/[^?#[:space:]]*)?$'
   and not coalesce(src->>'page_type'='pdf' and private.awardping_program_public_drive_pdf_identity(source_url) is not null,false))
 then raise exception 'The current text epoch or exact public source URL changed.' using errcode='23514'; end if;
 proof_hash:=private.awardping_program_text_source_alias_proof_hash(p_validation,coalesce((select request.url_alias_boundary from public.program_text_source_pending_requests request where request.id=approval_id),'[]'::jsonb));
 select * into prior from public.program_text_source_approvals where id=approval_id;
 if found then
  if prior.content_hash<>proof_hash or prior.validation<>p_validation or exists(select 1 from public.program_text_source_approval_events e where e.approval_id=prior.id and e.action='revoked')
  then raise exception 'Approval identity was reused or revoked.' using errcode='40001'; end if;
  return jsonb_build_object('id',prior.id,'source_id',prior.source_id,'content_hash',prior.content_hash,'roles',prior.role_receipts,'idempotent',true);
 end if;
 -- Final approval accepts ONLY the actual pending identity and its immutable
 -- probe receipt. It never fabricates a target baseline or creates a source.
 select * into strict pending from public.program_text_source_pending_requests where id=approval_id;
 descriptor:=public.get_program_text_source_pending_capture(pending.id);
 select * into strict probe from public.program_text_source_probe_receipts where pending_id=pending.id;
 normalized:=(pending.validation->'proposal')||jsonb_build_object('schema','awardping.program-text-source-approval-request.v1',
  'target_ref',probe.document->'reference','source',(pending.validation#>'{proposal,source}')||jsonb_build_object('create',false,
   'expected_admin_review_status',descriptor#>'{source,admin_review_status}','expected_text_monitoring_state',descriptor#>'{source,text_monitoring_state}'));
 if p_proposal is distinct from normalized or p_validation#>'{source_text,0}' is distinct from pending.validation#>'{source_text,0}'
  or p_validation#>'{source_text,1}' is distinct from probe.document or p_validation->'provider_link' is distinct from pending.validation->'provider_link'
 then raise exception 'Approval must use the exact pending source, provider proof and immutable target original.' using errcode='40001';end if;
 select * into strict registry from public.stage1_award_registry where cohort_key=p_proposal->>'cohort_key' for share;
 if p_proposal->>'expected_canonical_shared_award_id' is distinct from registry.canonical_shared_award_id::text
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards a on a.id=m.shared_award_id and a.status='active'
   where m.cohort_key=registry.cohort_key and m.shared_award_id=owner_id and m.member_kind=src->>'expected_member_kind')
  or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=registry.cohort_key and
   ((r.url_pattern is not null and source_url ~* r.url_pattern) or (r.title_pattern is not null and src->>'title' ~* r.title_pattern)))
 then raise exception 'Explicit canonical/member ownership or exclusion checks failed.' using errcode='23514'; end if;
 if jsonb_typeof(p_validation->'source_text') is distinct from 'array' or jsonb_array_length(p_validation->'source_text')<>2 then
  raise exception 'Both complete retained originals are required.' using errcode='23514'; end if;
 doc:=p_validation#>'{source_text,0}';target:=p_validation#>'{source_text,1}';
 if not private.awardping_program_source_approval_document_valid(doc) or not private.awardping_program_source_approval_document_valid(target)
  or doc->'reference' is distinct from p_proposal->'authority_ref' or target->'reference' is distinct from p_proposal->'target_ref'
  or target#>>'{reference,source,id}'<>source_id::text or target#>>'{reference,source,shared_award_id}'<>owner_id::text
  or target#>>'{reference,source,url}' is distinct from source_url
  or (target#>>'{reference,final_url}' is distinct from source_url and not private.awardping_program_public_drive_pdf_metadata_valid(target->'reference'))
  or target#>>'{reference,source,title}' is distinct from src->>'title' or target#>>'{reference,source,page_type}' is distinct from src->>'page_type'
  or doc#>>'{reference,source,id}'=source_id::text
  or exists(select 1 from jsonb_array_elements(p_validation->'source_text') d where
   (d#>>'{reference,captured_at}')::timestamptz>clock_timestamp()+interval '5 minutes'
   or (d#>>'{reference,captured_at}')::timestamptz<clock_timestamp()-interval '7 days')
 then raise exception 'Original completeness, freshness or exact source identity failed.' using errcode='23514'; end if;
 select * into strict authority from public.shared_award_sources where id=(doc#>>'{reference,source,id}')::uuid for share;
 if authority.shared_award_id::text is distinct from doc#>>'{reference,source,shared_award_id}'
  or authority.url is distinct from doc#>>'{reference,source,url}' or authority.text_monitoring_state->'latest_ref' is distinct from doc->'reference'
  or not private.awardping_program_text_source_access(authority.id,registry.cohort_key,policy_epoch)
  or not private.awardping_program_source_allowed(authority.id)
 then raise exception 'Provider index capture or its current authority changed.' using errcode='40001'; end if;
 if not private.awardping_program_exact_object(link,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])
  or link->>'source_id' is distinct from authority.id::text or link->>'capture_id' is distinct from doc#>>'{reference,capture_id}'
  or link->>'block_id' is distinct from p_proposal->>'link_block_id' or link->>'resolved_url' is distinct from source_url
 then raise exception 'Literal provider-link identity failed.' using errcode='23514'; end if;
 select value into strict block from jsonb_array_elements(doc->'blocks') where value->>'id'=link->>'block_id';
 if block->>'kind' is distinct from 'source_link' or block#>>'{context,source_attribute}' is distinct from 'href'
  or block#>'{context,base_hrefs}' is distinct from '[]'::jsonb or block->'start_utf16' is distinct from link->'start_utf16'
  or block->'end_utf16' is distinct from link->'end_utf16' or block->>'text' is distinct from link->>'text'
 then raise exception 'The complete literal provider link is unavailable.' using errcode='23514'; end if;
 href:=block->>'text';origin:=substring(doc#>>'{reference,final_url}' from '^https://[^/]+');
 if href ~ '^https://' then resolved:=href;
 else
  if href !~ '^[A-Za-z0-9_./-]+$' or position('//' in href)>0 then raise exception 'Ambiguous provider href.' using errcode='23514'; end if;
  resolved:=case when left(href,1)='/' then origin||href else regexp_replace(doc#>>'{reference,final_url}','[^/]*$','')||href end;
  foreach part in array string_to_array(substr(resolved,length(origin)+1),'/') loop
   if part='..' then parts:=parts[1:greatest(cardinality(parts)-1,0)];elsif part not in ('','.') then parts:=array_append(parts,part);end if;
  end loop;
  resolved:=origin||'/'||array_to_string(parts,'/')||case when right(href,1)='/' then '/' else '' end;
 end if;
 if resolved is distinct from source_url then raise exception 'Provider href does not resolve to the exact requested source.' using errcode='23514'; end if;
 if (select count(distinct r->>'source_role') from jsonb_array_elements(p_proposal->'roles') r)<>jsonb_array_length(p_proposal->'roles') then
  raise exception 'Duplicate role identity.' using errcode='23514';end if;
 -- ALL role versions are checked under the common lock before any insertion.
 for change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  if not private.awardping_program_exact_object(change,array['source_role','expected_revision','expected_source_ids','next_source_ids'])
   or coalesce(change->>'source_role','') !~ '^[a-z][a-z0-9_]{0,79}$'
   or jsonb_typeof(change->'expected_source_ids') is distinct from 'array' or jsonb_typeof(change->'next_source_ids') is distinct from 'array'
   or jsonb_array_length(change->'expected_source_ids') not between 1 and 50 or jsonb_array_length(change->'next_source_ids') not between 1 and 50
  then raise exception 'Explicit bounded role CAS is required.' using errcode='23514';end if;
  select array_agg(value::uuid order by ord) into expected_ids from jsonb_array_elements_text(change->'expected_source_ids') with ordinality valueset(value,ord);
  select array_agg(value::uuid order by ord) into next_ids from jsonb_array_elements_text(change->'next_source_ids') with ordinality valueset(value,ord);
  if cardinality(expected_ids)<>(select count(distinct x) from unnest(expected_ids) x) or cardinality(next_ids)<>(select count(distinct x) from unnest(next_ids) x)
   or not expected_ids<@next_ids or not source_id=any(next_ids) or exists(select 1 from unnest(next_ids) x where x<>source_id and not x=any(expected_ids))
  then raise exception 'Only the explicitly reviewed source may be added; no role history can be removed.' using errcode='23514';end if;
  select * into strict role from public.program_text_source_roster where cohort_key=registry.cohort_key and source_role=change->>'source_role' for update;
  if role.revision::text is distinct from change->>'expected_revision' or role.source_ids is distinct from expected_ids then
   raise exception 'Source role changed; reload the exact current role.' using errcode='40001';end if;
 end loop;
 perform private.awardping_program_text_lock_alias_context(p_proposal);
 select * into s from public.shared_award_sources where id=source_id for update;
 if (src->>'create')::boolean or not found or s.shared_award_id<>owner_id or s.url<>source_url or s.title<>src->>'title' or s.page_type<>src->>'page_type'
   or s.admin_review_status::text is distinct from src->>'expected_admin_review_status' or s.admin_review_status not in ('open','review_later')
   or s.text_monitoring_state is distinct from src->'expected_text_monitoring_state' then
   raise exception 'Existing source identity or preserved history changed.' using errcode='40001';end if;
 alias_boundary:=private.awardping_program_text_url_alias_boundary(source_id,registry.cohort_key,owner_id,source_url,false);
 if alias_boundary is distinct from pending.url_alias_boundary then
  raise exception 'Normalized URL alias identities changed after the pending proof.' using errcode='40001';end if;
 for change in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  select * into strict role from public.program_text_source_roster where cohort_key=registry.cohort_key and source_role=change->>'source_role';old_role:=to_jsonb(role);
  select array_agg(value::uuid order by ord) into next_ids from jsonb_array_elements_text(change->'next_source_ids') with ordinality valueset(value,ord);
  foreach sid in array role.source_ids loop
   if sid<>source_id and (not private.awardping_program_text_source_access(sid,registry.cohort_key,policy_epoch) or
    not exists(select 1 from public.shared_award_sources x where x.id=sid
     and role.evidence#>>array['source_bindings',sid::text,'source_url']=x.url
     and role.evidence#>>array['source_bindings',sid::text,'shared_award_id']=x.shared_award_id::text)) then
    raise exception 'A retained role source lost its exact authority.' using errcode='23514';end if;
  end loop;
  bindings:=coalesce(role.evidence->'source_bindings','{}'::jsonb)||jsonb_build_object(source_id::text,jsonb_build_object(
   'source_url',source_url,'shared_award_id',owner_id,'authority_url',authority.url,
   'review_note','Explicit independent text-only approval backed by retained provider link and complete target capture.'));
  update public.program_text_source_roster set source_ids=next_ids,evidence=jsonb_build_object('schema','awardping.program-text-source-role.v1','source_bindings',bindings),
   revision=gen_random_uuid(),reviewed_by=p_actor,reviewed_at=clock_timestamp() where cohort_key=registry.cohort_key and source_role=role.source_role returning to_jsonb(program_text_source_roster.*) into updated_role;
  insert into public.program_text_source_roster_events(cohort_key,source_role,previous_entry,next_entry,reviewed_by)
   values(registry.cohort_key,role.source_role,old_role,updated_role,p_actor);
  roles_result:=roles_result||jsonb_build_array(updated_role);
 end loop;
 insert into public.program_text_source_approvals(id,source_id,cohort_key,epoch,shared_award_id,source_url,content_hash,validation,role_receipts,url_alias_boundary,approved_by)
 values(approval_id,source_id,registry.cohort_key,policy_epoch,owner_id,source_url,proof_hash,p_validation,roles_result,alias_boundary,p_actor);
 insert into public.program_text_source_approval_events(approval_id,action,actor,reason) values(approval_id,'approved',p_actor,'Explicit text-only collection authority; no facts approved or published.');
 return jsonb_build_object('id',approval_id,'source_id',source_id,'content_hash',proof_hash,'roles',roles_result,'idempotent',false);
end;
$$;

create or replace function private.awardping_program_text_source_approval_dto(p_source_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('schema','awardping.program-text-source-approval.v1','id',a.id,
  'source_id',a.source_id,'shared_award_id',a.shared_award_id,'source_url',a.source_url,'cohort_key',a.cohort_key,
  'epoch',a.epoch,'content_hash',a.content_hash,'current',true) order by a.cohort_key),'[]'::jsonb)
 from (select distinct on (approval.cohort_key) approval.* from public.program_text_source_approvals approval
  where approval.source_id=p_source_id and approval.epoch=(select epoch from public.program_text_source_authority_epochs where active)
   and not exists(select 1 from public.program_text_source_approval_events e where e.approval_id=approval.id and e.action='revoked')
   and private.awardping_program_text_approval_context_current(approval.cohort_key,approval.source_id,approval.shared_award_id,approval.source_url,
    approval.validation#>'{proposal,registration_scope}')
  order by approval.cohort_key,approval.approved_at desc,approval.id desc) a
 join public.shared_award_sources s on s.id=a.source_id and s.shared_award_id=a.shared_award_id and s.url=a.source_url
 join public.shared_awards award on award.id=s.shared_award_id and award.status='active'
 where s.admin_review_status in ('open','review_later')
  and s.title=a.validation#>>'{proposal,source,title}' and s.page_type=a.validation#>>'{proposal,source,page_type}'
  and (s.text_monitoring_state='{}'::jsonb or s.text_monitoring_state->>'epoch'=a.epoch::text)
  and exists(select 1 from public.stage1_award_members m where m.cohort_key=a.cohort_key and m.shared_award_id=s.shared_award_id)
  and not exists(select 1 from public.program_text_source_approval_events e where e.approval_id=a.id and e.action='revoked')
  and private.awardping_program_text_url_alias_boundary_current(a.source_id,a.cohort_key,a.shared_award_id,a.source_url,a.url_alias_boundary)
  and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=a.cohort_key and
   ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)));
$$;
notify pgrst,'reload schema';
