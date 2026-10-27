-- Independent text-only authority. No legacy intake/status/evidence guard changes.
create table public.program_text_source_authority_epochs (
 epoch uuid primary key,active boolean not null,created_at timestamptz not null default clock_timestamp()
);
create unique index program_text_one_active_source_epoch on public.program_text_source_authority_epochs(active) where active;
insert into public.program_text_source_authority_epochs(epoch,active) values('ec349339-ff62-4d2e-a610-8c361b4044ec',true);
create table public.program_text_source_approvals (
 id uuid primary key,source_id uuid not null references public.shared_award_sources(id),
 cohort_key text not null references public.stage1_award_registry(cohort_key),
 epoch uuid not null references public.program_text_source_authority_epochs(epoch),
 shared_award_id uuid not null references public.shared_awards(id),source_url text not null,
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),validation jsonb not null,role_receipts jsonb not null,
 approved_by text not null,approved_at timestamptz not null default clock_timestamp()
);
create index program_text_source_approval_latest on public.program_text_source_approvals(source_id,cohort_key,epoch,approved_at desc,id desc);
create table public.program_text_source_approval_events (
 id uuid primary key default gen_random_uuid(),approval_id uuid not null references public.program_text_source_approvals(id),
 action text not null check(action in ('approved','revoked')),actor text not null,reason text not null,
 created_at timestamptz not null default clock_timestamp(),unique(approval_id,action)
);
create table public.program_text_source_pending_requests (
 id uuid primary key,source_id uuid not null references public.shared_award_sources(id),
 cohort_key text not null references public.stage1_award_registry(cohort_key),epoch uuid not null references public.program_text_source_authority_epochs(epoch),
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),validation jsonb not null,source_snapshot jsonb not null,
 created_by text not null,created_at timestamptz not null default clock_timestamp()
);
create table public.program_text_source_probe_receipts (
 pending_id uuid primary key references public.program_text_source_pending_requests(id),
 document jsonb not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['program_text_source_authority_epochs','program_text_source_approvals','program_text_source_approval_events',
  'program_text_source_pending_requests','program_text_source_probe_receipts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
 end loop;
end $$;

create function private.awardping_program_inventory_retains_source(p_inventory uuid,p_cohort text,p_source uuid,p_owner uuid,p_url text)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.program_variation_inventories i join public.program_variation_scopes s on s.inventory_id=i.id and not s.retired
  cross join lateral jsonb_array_elements(s.source_roles) role where i.id=p_inventory and i.cohort_key=p_cohort and i.status='sealed'
   and (role->'source_ids') ? p_source::text and role#>>array['evidence','source_bindings',p_source::text,'source_url']=p_url
   and role#>>array['evidence','source_bindings',p_source::text,'shared_award_id']=p_owner::text);
$$;
create function private.awardping_program_text_approval_context_current(p_cohort text,p_source uuid,p_owner uuid,p_url text,p_scope jsonb)
returns boolean language sql stable security invoker set search_path='' as $$
 select case when p_scope->>'kind'='legacy_roles' then true when p_scope->>'kind'='variation_inventory' then
  exists(select 1 from public.program_variation_inventory_draft_heads h join public.program_variation_inventories i on i.id=h.inventory_id
   where h.cohort_key=p_cohort and i.cohort_key=p_cohort and h.revision=i.revision and i.status='draft' and i.id=(p_scope->>'inventory_id')::uuid)
  or exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
   where h.cohort_key=p_cohort and i.cohort_key=p_cohort and h.revision=i.revision and i.status='sealed' and h.inventory_id=(p_scope->>'inventory_id')::uuid)
  or exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
   where h.cohort_key=p_cohort and i.cohort_key=p_cohort and h.revision=i.revision and
   private.awardping_program_inventory_retains_source(h.inventory_id,p_cohort,p_source,p_owner,p_url))
  or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
   on approval.id::text=release.approval_ids->>p_cohort where release.is_active and approval.cohort_key=p_cohort and
   private.awardping_program_inventory_retains_source(approval.inventory_id,p_cohort,p_source,p_owner,p_url)) else false end;
$$;
revoke all on function private.awardping_program_inventory_retains_source(uuid,text,uuid,uuid,text),
 private.awardping_program_text_approval_context_current(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_inventory_retains_source(uuid,text,uuid,uuid,text),
 private.awardping_program_text_approval_context_current(text,uuid,uuid,text,jsonb) to service_role;

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
  and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=a.cohort_key and
   ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)));
$$;

create or replace function private.awardping_program_text_source_access(p_source_id uuid,p_cohort text default null,p_epoch uuid default null)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.shared_award_sources s where s.id=p_source_id and
  (s.admin_review_status='open' and (p_cohort is null or exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id))
   or exists(select 1 from jsonb_array_elements(private.awardping_program_text_source_approval_dto(s.id)) a
    where (p_cohort is null or a->>'cohort_key'=p_cohort) and a->>'epoch'=coalesce(p_epoch,
      (select epoch from public.program_text_source_authority_epochs where active))::text)));
$$;
revoke all on function private.awardping_program_text_source_approval_dto(uuid),
 private.awardping_program_text_source_access(uuid,text,uuid) from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_approval_dto(uuid),
 private.awardping_program_text_source_access(uuid,text,uuid) to service_role;

create function public.get_program_text_source_approvals(p_source_ids uuid[],p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if p_epoch is null or p_epoch is distinct from (select epoch from public.program_text_source_authority_epochs where active)
  or p_source_ids is null or cardinality(p_source_ids) not between 1 and 100 or array_position(p_source_ids,null) is not null
  or cardinality(p_source_ids)<>(select count(distinct x) from unnest(p_source_ids) x)
 then raise exception 'Invalid current text approval scope.' using errcode='23514'; end if;
 return jsonb_build_object('schema','awardping.program-text-source-approval-page.v1','epoch',p_epoch,'source_ids',p_source_ids,
  'approvals',coalesce((select jsonb_agg(a order by id,a->>'cohort_key') from unnest(p_source_ids) id
   cross join lateral jsonb_array_elements(private.awardping_program_text_source_approval_dto(id)) a),'[]'::jsonb));
end;
$$;
revoke all on function public.get_program_text_source_approvals(uuid[],uuid) from public,anon,authenticated;
grant execute on function public.get_program_text_source_approvals(uuid[],uuid) to service_role;

create or replace function private.awardping_program_text_source_registration_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from jsonb_array_elements(private.awardping_program_text_source_approval_dto(p_source_id)) dto
  join public.program_text_source_approvals a on a.id=(dto->>'id')::uuid
  where a.validation#>>'{proposal,registration_scope,kind}'='variation_inventory');
$$;
create or replace function private.awardping_program_text_registered_source_roles()
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',a.cohort_key,
  'scope_key','registration_'||replace(i.id::text,'-',''),'variation_scope_key','source_registration',
  'source_role','source_'||replace(a.source_id::text,'-','_'),'source_ids',jsonb_build_array(a.source_id),
  'manifest_status','reviewed_text','revision',a.id,'inventory_id',i.id,'inventory_revision',i.revision,'cycle',i.cycle,
  'evidence',jsonb_build_object('schema','awardping.program-text-source-role.v1','source_bindings',jsonb_build_object(a.source_id::text,
   jsonb_build_object('source_url',a.source_url,'shared_award_id',a.shared_award_id,
    'authority_url',a.validation#>>'{proposal,authority_ref,source,url}',
    'review_note','Immutable retained provider link and complete target proof in explicit text approval '||a.id::text))),
  'approval_content_hash',a.content_hash) order by a.cohort_key,a.source_id),'[]'::jsonb)
 from public.program_text_source_approvals a join public.program_variation_inventories i
  on i.id=(a.validation#>>'{proposal,registration_scope,inventory_id}')::uuid and i.cohort_key=a.cohort_key
 where a.validation#>>'{proposal,registration_scope,kind}'='variation_inventory'
  and exists(select 1 from jsonb_array_elements(private.awardping_program_text_source_approval_dto(a.source_id)) dto where dto->>'id'=a.id::text)
  and (exists(select 1 from public.program_variation_inventory_draft_heads h where h.cohort_key=a.cohort_key and h.inventory_id=i.id and h.revision=i.revision and i.status='draft')
   or exists(select 1 from public.program_variation_inventory_heads h where h.cohort_key=a.cohort_key and h.inventory_id=i.id and h.revision=i.revision and i.status='sealed'));
$$;
revoke all on function private.awardping_program_text_source_registration_allowed(uuid),
 private.awardping_program_text_registered_source_roles() from public,anon,authenticated;
grant execute on function private.awardping_program_text_source_registration_allowed(uuid),
 private.awardping_program_text_registered_source_roles() to service_role;

-- Validate full retained text, not only a convenient excerpt from an incomplete page.
create function private.awardping_program_source_approval_document_valid(p_doc jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare r jsonb:=p_doc->'reference';b jsonb;cursor_at integer:=0;next_at integer;
begin
 if not private.awardping_program_exact_object(p_doc,array['reference','text','blocks','blocks_json'])
  or not private.awardping_program_text_reference_valid(r)
  or private.awardping_program_fact_known_html_shell(r) or private.awardping_program_fact_known_footer_only_pdf(r)
  or jsonb_typeof(p_doc->'text') is distinct from 'string' or private.awardping_program_utf16_length(p_doc->>'text')<>(r->>'text_length')::integer
  or encode(extensions.digest(convert_to(p_doc->>'text','UTF8'),'sha256'),'hex')<>r->>'text_sha256'
  or jsonb_typeof(p_doc->'blocks') is distinct from 'array' or jsonb_array_length(p_doc->'blocks') not between 1 and 20000
  or jsonb_typeof(p_doc->'blocks_json') is distinct from 'string' or (p_doc->>'blocks_json')::jsonb<>p_doc->'blocks'
  or encode(extensions.digest(convert_to(p_doc->>'blocks_json','UTF8'),'sha256'),'hex')<>r->>'blocks_sha256'
  or (select count(distinct x->>'id') from jsonb_array_elements(p_doc->'blocks') x)<>jsonb_array_length(p_doc->'blocks')
 then return false; end if;
 for b in select value from jsonb_array_elements(p_doc->'blocks') loop
  if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||b,p_doc->>'text') then return false; end if;
  next_at:=(b->>'start_utf16')::integer;
  if next_at<cursor_at or next_at>cursor_at and private.awardping_program_utf16_slice(p_doc->>'text',cursor_at,next_at) ~ '[^[:space:]]' then return false; end if;
  cursor_at:=(b->>'end_utf16')::integer;
 end loop;
 return cursor_at=(r->>'text_length')::integer or private.awardping_program_utf16_slice(p_doc->>'text',cursor_at,(r->>'text_length')::integer) !~ '[^[:space:]]';
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_source_approval_document_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_source_approval_document_valid(jsonb) to service_role;

create function private.awardping_program_source_pending_valid(p_validation jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare p jsonb:=p_validation->'proposal';src jsonb:=p->'source';d jsonb:=p_validation#>'{source_text,0}';l jsonb:=p_validation->'provider_link';
 r public.stage1_award_registry%rowtype;a public.shared_award_sources%rowtype;m public.program_text_source_roster%rowtype;
 b jsonb;c jsonb;expected_ids uuid[];next_ids uuid[];epoch_id uuid;href text;origin text;resolved text;part text;parts text[]:='{}';sid uuid;
begin
 if not private.awardping_program_exact_object(p_validation,array['schema','proposal','source_text','provider_link'])
  or p_validation->>'schema' is distinct from 'awardping.program-text-source-pending-proof.v1'
  or not private.awardping_program_exact_object(p,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','source','authority_ref','link_block_id','roles','registration_scope'])
  or p->>'schema' is distinct from 'awardping.program-text-source-pending-request.v1'
  or not private.awardping_program_exact_object(src,array['id','shared_award_id','url','title','page_type','create','expected_member_kind','expected_admin_review_status','expected_text_monitoring_state'])
  or coalesce(p->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(p->>'cohort_key','') !~ '^[a-z0-9_-]{1,80}$'
  or coalesce(src->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or coalesce(src->>'shared_award_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or jsonb_typeof(src->'create') is distinct from 'boolean' or jsonb_typeof(src->'expected_text_monitoring_state') is distinct from 'object'
  or coalesce(src->>'expected_member_kind','') not in ('canonical','alias')
  or jsonb_typeof(src->'title') is distinct from 'string' or length(btrim(src->>'title')) not between 1 and 1000
  or coalesce(src->>'page_type','') not in ('homepage','deadline','application','eligibility','requirements','pdf','faq','other')
  or (coalesce(src->>'url','') !~ '^https://[^/@\\?#[:space:]]+(/[^?#[:space:]]*)?$'
   and not coalesce(src->>'page_type'='pdf' and private.awardping_program_public_drive_pdf_identity(src->>'url') is not null,false))
  or jsonb_typeof(p->'roles') is distinct from 'array' or jsonb_array_length(p->'roles')>50
  or octet_length(p::text)>262144 or octet_length(p_validation::text)>16777216
  or jsonb_typeof(p_validation->'source_text') is distinct from 'array' or jsonb_array_length(p_validation->'source_text')<>1
  or not private.awardping_program_source_approval_document_valid(d) or d->'reference' is distinct from p->'authority_ref'
  or d#>>'{reference,source,id}'=src->>'id'
 then return false;end if;
 select epoch into strict epoch_id from public.program_text_source_authority_epochs where active;
 select * into strict r from public.stage1_award_registry where cohort_key=p->>'cohort_key';
 if p#>>'{registration_scope,kind}'='legacy_roles' then
  if not private.awardping_program_exact_object(p->'registration_scope',array['kind']) or jsonb_array_length(p->'roles')=0 then return false;end if;
 elsif p#>>'{registration_scope,kind}'='variation_inventory' then
  if not private.awardping_program_exact_object(p->'registration_scope',array['kind','inventory_id','revision']) or p->'roles'<>'[]'::jsonb
   or not exists(select 1 from public.program_variation_inventories i join public.program_variation_inventory_draft_heads h
    on h.inventory_id=i.id and h.cohort_key=i.cohort_key and h.revision=i.revision where i.id=(p#>>'{registration_scope,inventory_id}')::uuid
    and i.revision=(p#>>'{registration_scope,revision}')::uuid and i.cohort_key=r.cohort_key and i.status='draft') then return false;end if;
 else return false;end if;
 if p->>'epoch' is distinct from epoch_id::text or p->>'expected_canonical_shared_award_id' is distinct from r.canonical_shared_award_id::text
  or not exists(select 1 from public.stage1_award_members x join public.shared_awards award on award.id=x.shared_award_id and award.status='active'
   where x.cohort_key=r.cohort_key and x.shared_award_id=(src->>'shared_award_id')::uuid and x.member_kind=src->>'expected_member_kind')
  or exists(select 1 from public.stage1_award_source_identity_rules x where x.cohort_key=r.cohort_key and
   ((x.url_pattern is not null and src->>'url' ~* x.url_pattern) or (x.title_pattern is not null and src->>'title' ~* x.title_pattern)))
  or (d#>>'{reference,captured_at}')::timestamptz>clock_timestamp()+interval '5 minutes'
  or (d#>>'{reference,captured_at}')::timestamptz<clock_timestamp()-interval '7 days'
 then return false;end if;
 select * into strict a from public.shared_award_sources where id=(d#>>'{reference,source,id}')::uuid;
 if a.shared_award_id::text is distinct from d#>>'{reference,source,shared_award_id}' or a.url is distinct from d#>>'{reference,source,url}'
  or a.text_monitoring_state->'latest_ref' is distinct from d->'reference'
  or not private.awardping_program_text_source_access(a.id,r.cohort_key,epoch_id) or not private.awardping_program_source_allowed(a.id)
  or not private.awardping_program_exact_object(l,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])
  or l->>'source_id' is distinct from a.id::text or l->>'capture_id' is distinct from d#>>'{reference,capture_id}'
  or l->>'block_id' is distinct from p->>'link_block_id' or l->>'resolved_url' is distinct from src->>'url'
 then return false;end if;
 select value into strict b from jsonb_array_elements(d->'blocks') where value->>'id'=l->>'block_id';
 if b->>'kind' is distinct from 'source_link' or b#>>'{context,source_attribute}' is distinct from 'href' or b#>'{context,base_hrefs}' is distinct from '[]'::jsonb
  or b->'start_utf16' is distinct from l->'start_utf16' or b->'end_utf16' is distinct from l->'end_utf16' or b->>'text' is distinct from l->>'text'
 then return false;end if;
 href:=b->>'text';origin:=substring(d#>>'{reference,final_url}' from '^https://[^/]+');
 if href ~ '^https://' then resolved:=href;
 else
  if href !~ '^[A-Za-z0-9_./-]+$' or position('//' in href)>0 then return false;end if;
  resolved:=case when left(href,1)='/' then origin||href else regexp_replace(d#>>'{reference,final_url}','[^/]*$','')||href end;
  foreach part in array string_to_array(substr(resolved,length(origin)+1),'/') loop
   if part='..' then parts:=parts[1:greatest(cardinality(parts)-1,0)];elsif part not in ('','.') then parts:=array_append(parts,part);end if;
  end loop;
  resolved:=origin||'/'||array_to_string(parts,'/')||case when right(href,1)='/' then '/' else '' end;
 end if;
 if resolved is distinct from src->>'url' then return false;end if;
 if (select count(distinct value->>'source_role') from jsonb_array_elements(p->'roles'))<>jsonb_array_length(p->'roles') then return false;end if;
 for c in select value from jsonb_array_elements(p->'roles') loop
  if not private.awardping_program_exact_object(c,array['source_role','expected_revision','expected_source_ids','next_source_ids'])
   or coalesce(c->>'source_role','') !~ '^[a-z][a-z0-9_]{0,79}$'
   or jsonb_typeof(c->'expected_source_ids') is distinct from 'array' or jsonb_typeof(c->'next_source_ids') is distinct from 'array'
   or jsonb_array_length(c->'expected_source_ids') not between 1 and 50 or jsonb_array_length(c->'next_source_ids') not between 1 and 50
  then return false;end if;
  select array_agg(value::uuid order by ord) into expected_ids from jsonb_array_elements_text(c->'expected_source_ids') with ordinality t(value,ord);
  select array_agg(value::uuid order by ord) into next_ids from jsonb_array_elements_text(c->'next_source_ids') with ordinality t(value,ord);
  if cardinality(expected_ids)<>(select count(distinct x) from unnest(expected_ids) x) or cardinality(next_ids)<>(select count(distinct x) from unnest(next_ids) x)
   or not expected_ids<@next_ids or not (src->>'id')::uuid=any(next_ids)
   or exists(select 1 from unnest(next_ids) x where x<>(src->>'id')::uuid and not x=any(expected_ids)) then return false;end if;
  select * into strict m from public.program_text_source_roster where cohort_key=r.cohort_key and source_role=c->>'source_role';
  if m.revision::text is distinct from c->>'expected_revision' or m.source_ids is distinct from expected_ids then return false;end if;
  foreach sid in array expected_ids loop
   if sid<>(src->>'id')::uuid and (not private.awardping_program_text_source_access(sid,r.cohort_key,epoch_id) or
    not exists(select 1 from public.shared_award_sources s where s.id=sid
     and m.evidence#>>array['source_bindings',sid::text,'source_url']=s.url
     and m.evidence#>>array['source_bindings',sid::text,'shared_award_id']=s.shared_award_id::text)) then return false;end if;
  end loop;
 end loop;
 return true;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_source_pending_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_source_pending_valid(jsonb) to service_role;

create function public.get_program_text_source_pending_capture(p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare request public.program_text_source_pending_requests%rowtype;s public.shared_award_sources%rowtype;
 snapshot jsonb;proof public.program_text_source_probe_receipts%rowtype;
begin
 select * into strict request from public.program_text_source_pending_requests where id=p_id;
 if not private.awardping_program_source_pending_valid(request.validation) then raise exception 'Pending provider/role/epoch authority changed.' using errcode='40001';end if;
 select * into strict s from public.shared_award_sources where id=request.source_id;
 snapshot:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state);
 if snapshot is distinct from request.source_snapshot then raise exception 'Pending source identity or preserved history changed.' using errcode='40001';end if;
 select * into proof from public.program_text_source_probe_receipts where pending_id=request.id;
 return jsonb_build_object('schema','awardping.program-text-source-pending-capture.v1','id',request.id,'content_hash',request.content_hash,
  'epoch',request.epoch,'source',snapshot,'role_revisions',coalesce((select jsonb_agg(jsonb_build_object('source_role',value->>'source_role','revision',value->>'expected_revision') order by value->>'source_role') from jsonb_array_elements(request.validation#>'{proposal,roles}')),'[]'::jsonb),
  'registration_scope',request.validation#>'{proposal,registration_scope}',
  'proof',case when proof.pending_id is null then 'null'::jsonb else jsonb_build_object('reference',proof.document->'reference','content_hash',proof.content_hash) end);
end;
$$;
revoke all on function public.get_program_text_source_pending_capture(uuid) from public,anon,authenticated;
grant execute on function public.get_program_text_source_pending_capture(uuid) to service_role;

create function public.prepare_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare src jsonb:=p_proposal->'source';s public.shared_award_sources%rowtype;old public.program_text_source_pending_requests%rowtype;
 c jsonb;new_hash text;source_snapshot jsonb;source_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if p_validation->'proposal' is distinct from p_proposal or not private.awardping_program_source_pending_valid(p_validation)
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320 then raise exception 'Invalid current pending text-source proof.' using errcode='23514';end if;
 new_hash:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
 select * into old from public.program_text_source_pending_requests where id=(p_proposal->>'id')::uuid;
 if found then
  if old.content_hash<>new_hash or old.validation<>p_validation then raise exception 'Pending identity was reused.' using errcode='40001';end if;
  return public.get_program_text_source_pending_capture(old.id);
 end if;
 for c in select value from jsonb_array_elements(p_proposal->'roles') order by value->>'source_role' loop
  perform 1 from public.program_text_source_roster where cohort_key=p_proposal->>'cohort_key' and source_role=c->>'source_role' for share;
 end loop;
 source_id:=(src->>'id')::uuid;
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
 if exists(select 1 from public.shared_award_sources x where x.id<>source_id and
  lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(src->>'url','/+$',''))) then
  raise exception 'A global source identity already exists; reuse the exact reviewed member explicitly.' using errcode='23505';end if;
 if (src->>'create')::boolean then
  insert into public.shared_award_sources(id,shared_award_id,url,title,page_type,source,confidence,reason,admin_review_status)
  values(source_id,(src->>'shared_award_id')::uuid,src->>'url',src->>'title',src->>'page_type','admin',1,
   'Pending text-only provider source; no capture, baseline, factual or legacy approval.','review_later') returning * into s;
 end if;
 source_snapshot:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state);
 insert into public.program_text_source_pending_requests(id,source_id,cohort_key,epoch,content_hash,validation,source_snapshot,created_by)
 values((p_proposal->>'id')::uuid,s.id,p_proposal->>'cohort_key',(p_proposal->>'epoch')::uuid,new_hash,p_validation,source_snapshot,p_actor);
 return public.get_program_text_source_pending_capture((p_proposal->>'id')::uuid);
end;
$$;
revoke all on function public.prepare_program_text_source(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_program_text_source(jsonb,jsonb,text) to service_role;

create function public.record_program_text_source_probe(p_pending_id uuid,p_expected_hash text,p_document jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d jsonb;source jsonb;old public.program_text_source_probe_receipts%rowtype;document_hash text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 d:=public.get_program_text_source_pending_capture(p_pending_id);source:=d->'source';
 if d->>'content_hash' is distinct from p_expected_hash or not private.awardping_program_source_approval_document_valid(p_document)
  or p_document#>>'{reference,source,id}' is distinct from source->>'id' or p_document#>>'{reference,source,shared_award_id}' is distinct from source->>'shared_award_id'
  or p_document#>>'{reference,source,url}' is distinct from source->>'url'
  or (p_document#>>'{reference,final_url}' is distinct from source->>'url' and not private.awardping_program_public_drive_pdf_metadata_valid(p_document->'reference'))
  or p_document#>>'{reference,source,title}' is distinct from source->>'title' or p_document#>>'{reference,source,page_type}' is distinct from source->>'page_type'
  or (p_document#>>'{reference,captured_at}')::timestamptz>clock_timestamp()+interval '5 minutes'
  or (p_document#>>'{reference,captured_at}')::timestamptz<clock_timestamp()-interval '7 days'
 then raise exception 'Pending proof capture failed complete source/epoch/role binding.' using errcode='23514';end if;
 document_hash:=encode(extensions.digest(convert_to(p_document::text,'UTF8'),'sha256'),'hex');
 select * into old from public.program_text_source_probe_receipts where pending_id=p_pending_id;
 if found then
  if old.document<>p_document or old.content_hash<>document_hash then raise exception 'An immutable pending proof already exists.' using errcode='40001';end if;
 else
  insert into public.program_text_source_probe_receipts(pending_id,document,content_hash) values(p_pending_id,p_document,document_hash);
 end if;
 return jsonb_build_object('schema','awardping.program-text-source-probe-receipt.v1','pending_id',p_pending_id,'reference',p_document->'reference','content_hash',document_hash);
end;
$$;
revoke all on function public.record_program_text_source_probe(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_program_text_source_probe(uuid,text,jsonb) to service_role;

create function public.approve_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 src jsonb:=p_proposal->'source';link jsonb:=p_validation->'provider_link';doc jsonb;target jsonb;block jsonb;change jsonb;
 registry public.stage1_award_registry%rowtype;authority public.shared_award_sources%rowtype;s public.shared_award_sources%rowtype;
 role public.program_text_source_roster%rowtype;prior public.program_text_source_approvals%rowtype;
 pending public.program_text_source_pending_requests%rowtype;probe public.program_text_source_probe_receipts%rowtype;descriptor jsonb;normalized jsonb;
 approval_id uuid;source_id uuid;owner_id uuid;policy_epoch uuid;expected_ids uuid[];next_ids uuid[];sid uuid;
 href text;resolved text;origin text;part text;parts text[]:='{}';source_url text;proof_hash text;
 roles_result jsonb:='[]'::jsonb;bindings jsonb;updated_role jsonb;old_role jsonb;
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
 proof_hash:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
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
 select * into s from public.shared_award_sources where id=source_id for update;
 if (src->>'create')::boolean or not found or s.shared_award_id<>owner_id or s.url<>source_url or s.title<>src->>'title' or s.page_type<>src->>'page_type'
   or s.admin_review_status::text is distinct from src->>'expected_admin_review_status' or s.admin_review_status not in ('open','review_later')
   or s.text_monitoring_state is distinct from src->'expected_text_monitoring_state' then
   raise exception 'Existing source identity or preserved history changed.' using errcode='40001';end if;
 if exists(select 1 from public.shared_award_sources x where
  lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(source_url,'/+$','')) and x.id<>source_id) then
  raise exception 'A global page identity already exists; no alias is accepted automatically.' using errcode='23505';end if;
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
 insert into public.program_text_source_approvals(id,source_id,cohort_key,epoch,shared_award_id,source_url,content_hash,validation,role_receipts,approved_by)
 values(approval_id,source_id,registry.cohort_key,policy_epoch,owner_id,source_url,proof_hash,p_validation,roles_result,p_actor);
 insert into public.program_text_source_approval_events(approval_id,action,actor,reason) values(approval_id,'approved',p_actor,'Explicit text-only collection authority; no facts approved or published.');
 return jsonb_build_object('id',approval_id,'source_id',source_id,'content_hash',proof_hash,'roles',roles_result,'idempotent',false);
end;
$$;
revoke all on function public.approve_program_text_source(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.approve_program_text_source(jsonb,jsonb,text) to service_role;

create function public.revoke_program_text_source_approval(p_id uuid,p_expected_hash text,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.program_text_source_approvals%rowtype;v_prior_event public.program_text_source_approval_events%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict a from public.program_text_source_approvals where id=p_id for share;
 if a.content_hash is distinct from p_expected_hash or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or length(btrim(coalesce(p_reason,''))) not between 20 and 2000 then raise exception 'Invalid exact text approval revocation.' using errcode='23514';end if;
 select * into v_prior_event from public.program_text_source_approval_events where approval_id=p_id and action='revoked';
 if found then
  if v_prior_event.actor<>p_actor or v_prior_event.reason<>p_reason then raise exception 'Revocation record is immutable.' using errcode='40001';end if;
 else
  insert into public.program_text_source_approval_events(approval_id,action,actor,reason)
  select x.id,'revoked',p_actor,p_reason from public.program_text_source_approvals x
   where x.source_id=a.source_id and x.cohort_key=a.cohort_key and x.epoch=a.epoch and x.shared_award_id=a.shared_award_id and x.source_url=a.source_url
    and not exists(select 1 from public.program_text_source_approval_events ev_rows where ev_rows.approval_id=x.id and ev_rows.action='revoked');
 end if;
 return jsonb_build_object('id',p_id,'revoked',true);
end;
$$;
revoke all on function public.revoke_program_text_source_approval(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.revoke_program_text_source_approval(uuid,text,text,text) to service_role;

-- Same text-roster CAS/ownership/evidence/history contract; only the admission
-- predicate recognizes independent text authority. Visual intake is untouched.
create or replace function public.replace_program_text_source_role(
 p_cohort text,p_role text,p_expected_revision uuid,p_source_ids uuid[],p_evidence jsonb,p_reviewer text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_old public.program_text_source_roster%rowtype;v_new public.program_text_source_roster%rowtype;
 v_source public.shared_award_sources%rowtype;v_id uuid;v_binding jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if p_expected_revision is null or p_source_ids is null or cardinality(p_source_ids) not between 1 and 50
  or array_position(p_source_ids,null) is not null or cardinality(p_source_ids)<>(select count(distinct x) from unnest(p_source_ids) x)
  or length(btrim(coalesce(p_reviewer,''))) not between 1 and 320
  or not private.awardping_program_exact_object(p_evidence,array['schema','source_bindings'])
  or p_evidence->>'schema' is distinct from 'awardping.program-text-source-role.v1'
  or jsonb_typeof(p_evidence->'source_bindings') is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_evidence->'source_bindings'))<>cardinality(p_source_ids)
 then raise exception 'Invalid reviewed text collection role.' using errcode='23514';end if;
 select * into strict v_old from public.program_text_source_roster where cohort_key=p_cohort and source_role=p_role for update;
 if v_old.revision<>p_expected_revision then raise exception 'Text collection role changed; review the current version.' using errcode='40001';end if;
 foreach v_id in array p_source_ids loop
  select * into strict v_source from public.shared_award_sources where id=v_id for share;
  v_binding:=p_evidence#>array['source_bindings',v_id::text];
  if not private.awardping_program_text_source_access(v_id,p_cohort)
   or not exists(select 1 from public.shared_awards a where a.id=v_source.shared_award_id and a.status='active')
   or not exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=v_source.shared_award_id)
   or exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=p_cohort and
    ((r.url_pattern is not null and v_source.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',v_source.title,v_source.display_title) ~* r.title_pattern)))
   or not private.awardping_program_exact_object(v_binding,array['source_url','shared_award_id','authority_url','review_note'])
   or v_binding->>'source_url' is distinct from v_source.url or v_binding->>'shared_award_id' is distinct from v_source.shared_award_id::text
   or not coalesce(jsonb_typeof(v_binding->'authority_url')='string' and v_binding->>'authority_url' ~ '^https://[^[:space:]]+$'
    and length(v_binding->>'authority_url')<=4000 and jsonb_typeof(v_binding->'review_note')='string'
    and length(btrim(v_binding->>'review_note')) between 20 and 2000,false)
  then raise exception 'Text collection role requires exact approved source/owner/authority bindings.' using errcode='23514';end if;
 end loop;
 update public.program_text_source_roster set source_ids=p_source_ids,evidence=p_evidence,revision=gen_random_uuid(),
  reviewed_by=btrim(p_reviewer),reviewed_at=clock_timestamp() where cohort_key=p_cohort and source_role=p_role returning * into v_new;
 insert into public.program_text_source_roster_events(cohort_key,source_role,previous_entry,next_entry,reviewed_by)
 values(p_cohort,p_role,to_jsonb(v_old),to_jsonb(v_new),btrim(p_reviewer));return to_jsonb(v_new);
end;
$$;
revoke all on function public.replace_program_text_source_role(text,text,uuid,uuid[],jsonb,text) from public,anon,authenticated;
grant execute on function public.replace_program_text_source_role(text,text,uuid,uuid[],jsonb,text) to service_role;

-- Preserve the complete existing CAS implementation behind an additional
-- scoped-epoch boundary. No legacy visual RPC or queue permission is changed.
alter function public.set_program_text_source_state(uuid,jsonb,jsonb) rename to awardping_set_program_text_source_state_base;
alter function public.awardping_set_program_text_source_state_base(uuid,jsonb,jsonb) set schema private;
revoke all on function private.awardping_set_program_text_source_state_base(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_set_program_text_source_state_base(uuid,jsonb,jsonb) to service_role;
create function public.set_program_text_source_state(p_source_id uuid,p_expected_state jsonb,p_next_state jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if not private.awardping_program_text_source_access(p_source_id,null,(p_next_state->>'epoch')::uuid) then
  raise exception 'Current scoped text-source authority is required.' using errcode='23514';end if;
 return private.awardping_set_program_text_source_state_base(p_source_id,p_expected_state,p_next_state);
end;
$$;
revoke all on function public.set_program_text_source_state(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.set_program_text_source_state(uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
