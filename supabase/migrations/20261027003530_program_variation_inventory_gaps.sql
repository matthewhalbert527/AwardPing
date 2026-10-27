-- Private manual governing/source gaps. No legacy fact draft, source identity,
-- capture, approval or public release is modified by this additive migration.
create function private.awardping_variation_coverage_gaps_valid(p_gaps jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare gap jsonb;source_url text;hostname text;
begin
 if jsonb_typeof(p_gaps) is distinct from 'array' or jsonb_array_length(p_gaps)>50
  or (select count(distinct x->>'key') from jsonb_array_elements(p_gaps) x)<>jsonb_array_length(p_gaps)
 then return false;end if;
 for gap in select value from jsonb_array_elements(p_gaps) loop
  if not private.awardping_program_exact_object(gap,array['key','label','source_url'])
   or jsonb_typeof(gap->'key') is distinct from 'string' or not coalesce(gap->>'key' ~ '^[a-z0-9][a-z0-9_-]{0,79}$',false)
   or jsonb_typeof(gap->'label') is distinct from 'string' or length(btrim(gap->>'label'))=0
   or btrim(gap->>'label')<>gap->>'label' or private.awardping_program_utf16_length(gap->>'label')>500
   or gap->>'label' ~ '[[:cntrl:]]' or jsonb_typeof(gap->'source_url') not in ('string','null') then return false;end if;
  if gap->'source_url'<>'null'::jsonb then
   source_url:=gap->>'source_url';
   if private.awardping_program_utf16_length(source_url)>2048 or source_url ~ '[[:cntrl:]]'
    or source_url !~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}(:443)?(/[^[:space:]#\\]*)?$'
   then return false;end if;
   hostname:=split_part(split_part(substring(source_url from 9),'/',1),':',1);
   if length(hostname)>253 or hostname ~ '(^|\.)(localhost|local|internal|test|invalid|example|onion)$' then return false;end if;
  end if;
 end loop;
 return true;
exception when others then return false;
end $$;
revoke all on function private.awardping_variation_coverage_gaps_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_variation_coverage_gaps_valid(jsonb) to service_role;

-- Existing v1 inventory hashes and seals retain their original bytes. New
-- inventories, or drafts explicitly curated through the operation below, use v2.
alter table public.program_variation_inventories
 add column coverage_gaps jsonb not null default '[]'::jsonb,
 add column inventory_hash_version smallint not null default 1,
 add constraint program_variation_inventory_gaps_valid check(private.awardping_variation_coverage_gaps_valid(coverage_gaps)),
 add constraint program_variation_inventory_gap_hash_version check(inventory_hash_version in (1,2) and (inventory_hash_version=2 or coverage_gaps='[]'::jsonb)),
 add constraint program_variation_inventory_sealed_no_gaps check(status<>'sealed' or coverage_gaps='[]'::jsonb);
alter table public.program_variation_inventories alter column inventory_hash_version set default 2;

create or replace function private.awardping_variation_inventory_hash(p_inventory uuid)
returns text language sql stable set search_path='' as $$
 select encode(extensions.digest(convert_to((jsonb_build_object('cohort_key',i.cohort_key,'cycle',i.cycle,
 'expected_variants',i.expected_variants,'previous_revision',i.previous_revision,'scopes',coalesce((select jsonb_agg(
 jsonb_build_object('scope_key',s.scope_key,'label',s.label,'attributes',s.attributes,'source_roles',s.source_roles,
 'provider_support',s.provider_support,'retired',s.retired,'evidence_hash',e.content_hash) order by s.scope_key)
 from public.program_variation_scopes s join public.program_variation_inventory_evidence e on e.id=s.evidence_id
 where s.inventory_id=i.id),'[]'))||case when i.inventory_hash_version=2 then jsonb_build_object(
 'schema','awardping.program-variation-inventory.v2','coverage_gaps',i.coverage_gaps) else '{}'::jsonb end)::text,'UTF8'),'sha256'),'hex')
 from public.program_variation_inventories i where i.id=p_inventory;
$$;

create function private.awardping_variation_preserve_sealed_gaps()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.status='sealed' and (new.coverage_gaps is distinct from old.coverage_gaps or new.inventory_hash_version is distinct from old.inventory_hash_version)
 then raise exception 'Sealed inventory coverage is immutable; create a new draft.' using errcode='23514';end if;
 return new;
end $$;
revoke all on function private.awardping_variation_preserve_sealed_gaps() from public,anon,authenticated,service_role;
create trigger program_variation_preserve_sealed_gaps before update of coverage_gaps,inventory_hash_version
 on public.program_variation_inventories for each row execute function private.awardping_variation_preserve_sealed_gaps();

create function public.set_program_variation_inventory_gaps(p_inventory uuid,p_expected_revision uuid,p_expected_hash text,p_coverage_gaps jsonb,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype;old_gaps jsonb;old_revision uuid;old_hash text;new_hash text;old_hash_version smallint;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict i from public.program_variation_inventories where id=p_inventory for update;
 old_hash:=private.awardping_variation_inventory_hash(i.id);
 if i.status<>'draft' or i.revision is distinct from p_expected_revision or old_hash is distinct from p_expected_hash
  or not exists(select 1 from public.program_variation_inventory_draft_heads h where h.inventory_id=i.id and h.cohort_key=i.cohort_key and h.revision=i.revision)
 then raise exception 'Current exact draft inventory version is required.' using errcode='40001';end if;
 if not private.awardping_variation_coverage_gaps_valid(p_coverage_gaps)
  or length(btrim(coalesce(p_reason,'')))<20 or private.awardping_program_utf16_length(p_reason)>2000 or p_reason ~ '[[:cntrl:]]'
  or length(btrim(coalesce(p_actor,'')))=0 or private.awardping_program_utf16_length(p_actor)>320
 then raise exception 'Bounded manual gaps and a review reason are required.' using errcode='23514';end if;
 if i.coverage_gaps is distinct from p_coverage_gaps or i.inventory_hash_version<>2 then
  old_gaps:=i.coverage_gaps;old_revision:=i.revision;old_hash_version:=i.inventory_hash_version;
  update public.program_variation_inventories set coverage_gaps=p_coverage_gaps,inventory_hash_version=2,revision=gen_random_uuid()
  where id=i.id returning * into i;
  update public.program_variation_inventory_draft_heads set revision=i.revision where inventory_id=i.id;
  new_hash:=private.awardping_variation_inventory_hash(i.id);
  insert into public.program_variation_review_events(action,subject_id,details,actor) values('inventory_gaps_set',i.id,
   jsonb_build_object('schema','awardping.program-variation-inventory-gap-audit.v1','previous_revision',old_revision,'revision',i.revision,
    'previous_hash',old_hash,'draft_hash',new_hash,'previous_hash_version',old_hash_version,'inventory_hash_version',2,
    'previous_gaps',old_gaps,'coverage_gaps',i.coverage_gaps,'reason',p_reason),p_actor);
 end if;
 return to_jsonb(i)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes s where s.inventory_id=i.id),
  'draft_hash',private.awardping_variation_inventory_hash(i.id));
end $$;
revoke all on function public.set_program_variation_inventory_gaps(uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.set_program_variation_inventory_gaps(uuid,uuid,text,jsonb,text,text) to service_role;

-- Starting another draft must not hide unresolved gaps on the current draft.
-- Carry those manual records forward unchanged; resolving them still requires
-- the explicit versioned gap action and its reason/audit.
create or replace function public.create_program_variation_inventory(p_cohort text,p_cycle text,p_expected_variants integer,p_previous_revision uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype;prior_draft public.program_variation_inventories%rowtype;current_revision uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if length(btrim(coalesce(p_actor,''))) not between 1 and 320 or length(btrim(coalesce(p_cycle,''))) not between 1 and 120
  or p_expected_variants is null or p_expected_variants<0 then raise exception 'Invalid inventory header.' using errcode='23514';end if;
 select revision into current_revision from public.program_variation_inventory_heads where cohort_key=p_cohort;
 if current_revision is distinct from p_previous_revision then raise exception 'Inventory head changed.' using errcode='40001';end if;
 select previous.* into prior_draft from public.program_variation_inventory_draft_heads head
 join public.program_variation_inventories previous on previous.id=head.inventory_id and previous.revision=head.revision
  and previous.cohort_key=head.cohort_key and previous.status='draft' where head.cohort_key=p_cohort;
 if prior_draft.id is null and exists(select 1 from public.program_variation_inventory_draft_heads head where head.cohort_key=p_cohort)
 then raise exception 'Current draft head changed.' using errcode='40001';end if;
 insert into public.program_variation_inventories(cohort_key,cycle,expected_variants,previous_revision,created_by,coverage_gaps)
 values(p_cohort,p_cycle,p_expected_variants,p_previous_revision,p_actor,coalesce(prior_draft.coverage_gaps,'[]'::jsonb)) returning * into i;
 insert into public.program_variation_inventory_draft_heads(cohort_key,inventory_id,revision) values(i.cohort_key,i.id,i.revision)
 on conflict(cohort_key) do update set inventory_id=excluded.inventory_id,revision=excluded.revision;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('inventory_created',i.id,jsonb_build_object(
  'revision',i.revision,'previous_draft_id',prior_draft.id,'previous_draft_revision',prior_draft.revision,
  'inherited_coverage_gaps',i.coverage_gaps,'inventory_hash_version',i.inventory_hash_version),p_actor);
 return to_jsonb(i)||jsonb_build_object('scope_count',0,'draft_hash',private.awardping_variation_inventory_hash(i.id));
end $$;

create or replace function public.seal_program_variation_inventory(p_inventory uuid,p_expected_revision uuid,p_expected_hash text,p_complete_provider_inventory_reviewed boolean,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.program_variation_inventories%rowtype;h uuid;actual_hash text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict i from public.program_variation_inventories where id=p_inventory for update;
 select revision into h from public.program_variation_inventory_heads where cohort_key=i.cohort_key;
 actual_hash:=private.awardping_variation_inventory_hash(i.id);
 if jsonb_array_length(i.coverage_gaps)>0 then raise exception 'Resolve every recorded inventory coverage gap before sealing.' using errcode='23514';end if;
 if i.status<>'draft' or i.revision is distinct from p_expected_revision or h is distinct from i.previous_revision
  or not exists(select 1 from public.program_variation_inventory_draft_heads d where d.inventory_id=i.id and d.revision=i.revision and d.cohort_key=i.cohort_key)
  or actual_hash is distinct from p_expected_hash or p_complete_provider_inventory_reviewed is distinct from true
  or not private.awardping_variation_inventory_sources_current(i.id)
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or not exists(select 1 from public.program_variation_scopes where inventory_id=i.id and scope_key='common' and not retired)
  or (select count(*) from public.program_variation_scopes where inventory_id=i.id and scope_key<>'common' and not retired)<>i.expected_variants
  or exists(select 1 from public.program_variation_inventory_heads oldh join public.program_variation_scopes oldscope on oldscope.inventory_id=oldh.inventory_id
    where oldh.cohort_key=i.cohort_key and oldscope.scope_key<>'common' and not exists(select 1 from public.program_variation_scopes ns where ns.inventory_id=i.id and ns.scope_key=oldscope.scope_key))
 then raise exception 'Inventory is incomplete, stale or lacks explicit retirement history.' using errcode='23514';end if;
 update public.program_variation_inventories set status='sealed',content_hash=actual_hash,sealed_at=clock_timestamp() where id=i.id returning * into i;
 insert into public.program_variation_inventory_heads(cohort_key,inventory_id,revision) values(i.cohort_key,i.id,i.revision)
 on conflict(cohort_key) do update set inventory_id=excluded.inventory_id,revision=excluded.revision;
 delete from public.program_variation_inventory_draft_heads where inventory_id=i.id;
 insert into public.program_variation_review_events(action,subject_id,details,actor) values('inventory_sealed',i.id,jsonb_build_object('content_hash',actual_hash,'revision',i.revision),p_actor);
 return to_jsonb(i)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes where inventory_id=i.id));
end $$;

-- Only the private board exposes gaps. A current draft takes precedence for
-- this curation display; sealed-head approval/currentness remains independent.
create or replace function public.get_program_variation_admin_batch()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-variation-admin-batch.v1','revision',r.revision,'active',r.is_active,'approval_ids',r.approval_ids,
 'awards',(select jsonb_agg(jsonb_build_object('cohort_key',reg.cohort_key,'approval_id',a.id,'content_hash',a.content_hash,
 'current',case when a.id is null then false else private.awardping_variation_award_current(a.id) end,
 'inventory_id',i.id,'inventory_revision',i.revision,'expected_variants',coalesce(i.expected_variants,0),
 'inventory_sealed',coalesce(i.status='sealed',false),'total_variants',coalesce(i.expected_variants,0),
 'scope_total',(select count(*) from public.program_variation_scopes s where s.inventory_id=i.id and not s.retired),
 'draft_inventory_id',draft.id,'coverage_gaps',coalesce(draft.coverage_gaps,i.coverage_gaps,'[]'::jsonb),
 'coverage_gap_count',jsonb_array_length(coalesce(draft.coverage_gaps,i.coverage_gaps,'[]'::jsonb)),
 'coverage_gap_inventory_id',coalesce(draft.id,i.id),'coverage_gap_revision',coalesce(draft.revision,i.revision),
 'coverage_gap_hash',private.awardping_variation_inventory_hash(coalesce(draft.id,i.id)),'coverage_gap_status',coalesce(draft.status,i.status),
 'approved_variants',coalesce((select count(*) from jsonb_object_keys(a.child_reviews)),0),
 'current_approved_variants',case when a.id is not null and private.awardping_variation_award_current(a.id) then i.expected_variants else 0 end,
 'approved_source_ids',case when a.id is not null and private.awardping_variation_award_current(a.id) then private.awardping_variation_inventory_source_ids(i.id) else '[]'::jsonb end,
 'source_count',case when a.id is not null and private.awardping_variation_award_current(a.id) then jsonb_array_length(private.awardping_variation_inventory_source_ids(i.id)) else 0 end,
 'source_set_seal',case when a.id is not null and private.awardping_variation_award_current(a.id) then encode(extensions.digest(convert_to(jsonb_build_object(
 'inventory_revision',i.revision,'approval_hash',a.content_hash,'source_ids',private.awardping_variation_inventory_source_ids(i.id))::text,'UTF8'),'sha256'),'hex') else null end,
 'ready_variants',(select count(*) from public.program_variation_scopes s join lateral(select * from public.program_variation_unit_reviews ur
  where ur.inventory_id=i.id and ur.scope_key=s.scope_key order by created_at desc,id desc limit 1) u on true
  where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired and u.validation#>'{review,reviewed_all_sources}'='true'::jsonb
  and not exists(select 1 from jsonb_array_elements(u.validation#>'{review,fields}') field where field->>'status'='unresolved')
  and private.awardping_variation_unit_current(u.id,u.created_at,true)),
 'reviewed_variants',(select count(*) from public.program_variation_scopes s where s.inventory_id=i.id and s.scope_key<>'common' and not s.retired and exists(
 select 1 from public.program_variation_unit_reviews u where u.inventory_id=i.id and u.scope_key=s.scope_key)),
 'blockers',(case when i.id is null and draft.id is null then jsonb_build_array('provider_inventory_missing')
 when i.id is null then jsonb_build_array('provider_inventory_unsealed') when a.id is null then jsonb_build_array('award_approval_missing')
 when not private.awardping_variation_award_current(a.id) then jsonb_build_array('award_approval_stale') else '[]'::jsonb end)||
 case when jsonb_array_length(coalesce(draft.coverage_gaps,i.coverage_gaps,'[]'::jsonb))>0 then jsonb_build_array('inventory_coverage_gaps') else '[]'::jsonb end) order by reg.cohort_key)
 from public.stage1_award_registry reg left join public.program_variation_inventory_heads h on h.cohort_key=reg.cohort_key
 left join public.program_variation_inventories i on i.id=h.inventory_id and i.revision=h.revision
 left join public.program_variation_inventory_draft_heads dh on dh.cohort_key=reg.cohort_key
 left join public.program_variation_inventories draft on draft.id=dh.inventory_id and draft.revision=dh.revision and draft.status='draft'
 left join lateral(select * from public.program_variation_award_approvals aa where aa.inventory_id=i.id order by reviewed_at desc,id desc limit 1) a on true))
 from public.program_variation_release r where r.release_key='national-25-provider-variations';
$$;
-- Replaced RPCs retain their OIDs and ACLs; explicitly retain service-only entry.
revoke all on function public.create_program_variation_inventory(text,text,integer,uuid,text),public.seal_program_variation_inventory(uuid,uuid,text,boolean,text),public.get_program_variation_admin_batch(),
 private.awardping_variation_inventory_hash(uuid) from public,anon,authenticated;
grant execute on function public.create_program_variation_inventory(text,text,integer,uuid,text),public.seal_program_variation_inventory(uuid,uuid,text,boolean,text),public.get_program_variation_admin_batch(),
 private.awardping_variation_inventory_hash(uuid) to service_role;
notify pgrst,'reload schema';
