-- Group presentation is separate from immutable original alerts and delivery.
-- Only the authenticated administrator's server may call the service RPCs.
do $preimage$
declare item record;
begin
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.decide_program_text_alert(uuid,text,text,uuid)'::regprocedure),'UTF8'),'sha256'),'hex')
   <> 'f6a71a7ee0ee67ecbd6277bb703f885dbdce0f9bfe26ceaf141599a42e48e6e1'
 then raise exception 'Alert decision preimage changed' using errcode='40001';end if;
 for item in select * from(values
  ('private.program_text_alert_hash(public.shared_award_visual_review_candidates,jsonb,jsonb)','55328ee49c607d7065bdab98d821569d4d825e30c88b28842621470f4510225e'),
  ('private.publish_reviewed_program_text_event(uuid,jsonb,jsonb)','bdb5450a4c07b93bb614f51460419b08e974bcf0d6fcca10be190f2733a28fc0'),
  ('private.public_digest_reviewed_text_source_current(uuid)','e86fb4d7b5bd764f607d9664b81789724f4e3f3573dcb70e663578a1f1ed6549')
 )p(signature,hash) loop
  if encode(extensions.digest(convert_to(pg_get_functiondef(item.signature::regprocedure),'UTF8'),'sha256'),'hex')<>item.hash then
   raise exception 'Original alert helper changed: %',item.signature using errcode='40001';end if;
 end loop;
 if to_regprocedure('private.decide_program_text_alert_ungrouped(uuid,text,text,uuid)') is not null then
  raise exception 'Original decision leaf already exists' using errcode='40001';end if;
 execute replace(pg_get_functiondef('public.decide_program_text_alert(uuid,text,text,uuid)'::regprocedure),
   'FUNCTION public.decide_program_text_alert(', 'FUNCTION private.decide_program_text_alert_ungrouped(');
end $preimage$;
revoke all on function private.decide_program_text_alert_ungrouped(uuid,text,text,uuid) from public,anon,authenticated,service_role;

create table public.program_text_alert_groups (
 id uuid primary key default gen_random_uuid(),
 shared_award_id uuid not null references public.shared_awards(id),
 head_revision_id uuid,
 published_revision_id uuid,
 revision integer not null default 0 check(revision>=0),
 retired boolean not null default false
);
create table public.program_text_alert_group_revisions (
 id uuid primary key,
 group_id uuid not null references public.program_text_alert_groups(id),
 revision integer not null check(revision>0),
 operation text not null check(operation in('draft','approved','undo')),
 member_refs jsonb not null check(jsonb_typeof(member_refs)='array' and jsonb_array_length(member_refs)<=8),
 event_refs jsonb,
 content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 unique(group_id,revision),unique(group_id,id),
 check((operation='approved' and event_refs is not null and jsonb_typeof(event_refs)='array' and jsonb_array_length(event_refs)=jsonb_array_length(member_refs))
    or(operation<>'approved' and event_refs is null))
);
alter table public.program_text_alert_groups add constraint program_text_alert_group_head_fk
 foreign key(id,head_revision_id) references public.program_text_alert_group_revisions(group_id,id);
alter table public.program_text_alert_groups add constraint program_text_alert_group_published_fk
 foreign key(id,published_revision_id) references public.program_text_alert_group_revisions(group_id,id);
create table public.program_text_alert_group_members (
 review_id uuid primary key references public.program_text_alert_reviews(id),
 group_id uuid not null references public.program_text_alert_groups(id)
);
create index program_text_alert_group_members_group_idx on public.program_text_alert_group_members(group_id,review_id);
create index program_text_alert_group_revisions_group_idx on public.program_text_alert_group_revisions(group_id,revision desc);
alter table public.program_text_alert_groups enable row level security;
alter table public.program_text_alert_group_revisions enable row level security;
alter table public.program_text_alert_group_members enable row level security;
revoke all on public.program_text_alert_groups,public.program_text_alert_group_revisions,public.program_text_alert_group_members
 from public,anon,authenticated,service_role;

create function private.program_text_alert_group_revision_hash(p_id uuid,p_group uuid,p_revision integer,p_operation text,
 p_members jsonb,p_events jsonb,p_created timestamptz,p_actor uuid)
returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('schema','awardping.alert-group-revision.v1',
 'id',p_id,'group_id',p_group,'revision',p_revision,'operation',p_operation,'member_refs',p_members,
 'event_refs',p_events,'created_at',extract(epoch from p_created),'created_by',p_actor)::text,'UTF8'),'sha256'),'hex');
$$;
create function private.program_text_alert_group_freeze() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Alert group revisions are append-only' using errcode='55000';end $$;
create trigger program_text_alert_group_revision_immutable before update or delete on public.program_text_alert_group_revisions
 for each row execute function private.program_text_alert_group_freeze();
create trigger program_text_alert_group_revision_no_truncate before truncate on public.program_text_alert_group_revisions
 for each statement execute function private.program_text_alert_group_freeze();

-- Normalize the exact bounded client contract before casting any UUID.
create function private.program_text_alert_group_normalize(p_members jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare x jsonb;n integer;result jsonb;
begin
 if jsonb_typeof(p_members) is distinct from 'array' then raise exception 'Choose 2 to 8 original alerts' using errcode='22023';end if;
 n:=jsonb_array_length(p_members);
 if n not between 2 and 8 then raise exception 'Choose 2 to 8 original alerts' using errcode='22023';end if;
 for x in select value from jsonb_array_elements(p_members) loop
  if jsonb_typeof(x) is distinct from 'object' or (select count(*) from jsonb_object_keys(x))<>2
   or not(x?'id' and x?'content_hash') or jsonb_typeof(x->'id') is distinct from 'string'
   or jsonb_typeof(x->'content_hash') is distinct from 'string'
   or not coalesce(x->>'id'~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)
   or x->>'id'='00000000-0000-0000-0000-000000000000'
   or not coalesce(x->>'content_hash'~'^[a-f0-9]{64}$',false)
  then raise exception 'Exact alert identities and hashes are required' using errcode='22023';end if;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_members))<>n then
  raise exception 'Duplicate alert member' using errcode='22023';end if;
 select jsonb_agg(value order by value->>'id' collate "C") into result from jsonb_array_elements(p_members);
 return result;
end $$;

-- Validate original identities; grouping never relaxes source/evidence approval.
-- Pending originals must still be the exact current comparison. Previously
-- approved originals retain their complete production public-evidence checks.
create function private.program_text_alert_group_validate(p_members jsonb,p_award uuid default null) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare x jsonb;r public.program_text_alert_reviews%rowtype;c public.shared_award_visual_review_candidates%rowtype;
 s public.shared_award_sources%rowtype;a uuid:=p_award;first_time timestamptz;last_time timestamptz;
 cycle jsonb;known_cycle jsonb;epoch uuid;e jsonb;
begin
 perform private.program_text_alert_group_normalize(p_members);
 select z.epoch into strict epoch from public.program_text_source_authority_epochs z where z.active;
 for x in select value from jsonb_array_elements(p_members) loop
  select * into strict r from public.program_text_alert_reviews where id=(x->>'id')::uuid;
  select * into strict c from public.shared_award_visual_review_candidates where id=r.id;
  select * into strict s from public.shared_award_sources where id=c.shared_award_source_id;
  if a is null then a:=c.shared_award_id;end if;
  if c.shared_award_id is distinct from a or s.shared_award_id is distinct from a or s.url is distinct from c.source_url
   or c.candidate_scope is distinct from 'program_text_change' or r.status not in('pending','approved')
   or r.content_hash is distinct from x->>'content_hash' or r.candidate_signature is distinct from c.candidate_signature
   or r.content_hash is distinct from private.program_text_alert_hash(c,r.details,r.localization)
   or not coalesce(private.awardping_program_source_allowed(s.id),false)
   or c.worker_metadata->>'epoch' is distinct from epoch::text
   or s.text_monitoring_state->>'epoch' is distinct from epoch::text
   or c.prompt_payload#>>'{comparison,context,award_id}' is distinct from a::text
   or c.prompt_payload#>>'{comparison,context,source_id}' is distinct from s.id::text
   or c.prompt_payload#>>'{comparison,context,epoch}' is distinct from epoch::text
   or not exists(select 1 from public.program_award_members m join public.program_award_registry z on z.cohort_key=m.cohort_key
       where m.shared_award_id=a and private.program_award_identity_is_public(m.cohort_key))
  then raise exception 'Alert group source, owner, evidence or status changed' using errcode='40001';end if;
  cycle:=c.prompt_payload#>'{comparison,context,cycle_id}';
  if cycle is null or (cycle<>'null'::jsonb and (jsonb_typeof(cycle)<>'string' or length(btrim(cycle#>>'{}')) not between 1 and 200)) then
   raise exception 'Alert cycle context is unavailable' using errcode='23514';end if;
  if cycle<>'null'::jsonb then
   if known_cycle is not null and known_cycle<>cycle then raise exception 'Different application cycles cannot be grouped' using errcode='23514';end if;
   known_cycle:=cycle;
  end if;
  first_time:=least(first_time,c.created_at);last_time:=greatest(last_time,c.created_at);
  if last_time-first_time>interval '30 days' then raise exception 'Related alerts must be within 30 days' using errcode='23514';end if;
  if r.status='pending' then
   if c.status is distinct from 'succeeded' or c.published_at is not null or r.event_id is not null
    or s.text_monitoring_state->'baseline_ref' is distinct from c.previous_snapshot_ref
    or s.text_monitoring_state->'latest_ref' is distinct from c.new_snapshot_ref then
    raise exception 'Pending alert comparison is stale' using errcode='40001';end if;
   e:=jsonb_build_object('change_event_id',r.id,'shared_award_id',a,'shared_award_source_id',s.id,
    'visual_review_candidate_id',c.id,'candidate_signature',c.candidate_signature,'bucket',c.worker_metadata->>'bucket',
    'evidence_status','verified_text','evidence_schema_version','program-text-event-evidence-v1',
    'previous_capture',c.previous_snapshot_ref,'current_capture',c.new_snapshot_ref,'localization',r.localization,'verified_at',r.created_at);
   perform public.awardping_validate_program_text_evidence(e,to_jsonb(c),r.details);
  elsif not coalesce(private.public_digest_reviewed_text_source_current(r.event_id),false) then
   raise exception 'Approved alert evidence is no longer public' using errcode='40001';
  end if;
 end loop;
 return a;
end $$;

create function private.program_text_alert_group_append(p_group uuid,p_operation text,p_members jsonb,p_events jsonb,p_actor uuid)
returns public.program_text_alert_group_revisions language plpgsql security definer set search_path='' as $$
declare g public.program_text_alert_groups%rowtype;r public.program_text_alert_group_revisions%rowtype;
begin
 select * into strict g from public.program_text_alert_groups where id=p_group for update;
 r.id:=gen_random_uuid();r.group_id:=g.id;r.revision:=g.revision+1;r.operation:=p_operation;
 r.member_refs:=p_members;r.event_refs:=p_events;r.created_at:=clock_timestamp();r.created_by:=p_actor;
 r.content_hash:=private.program_text_alert_group_revision_hash(r.id,r.group_id,r.revision,r.operation,r.member_refs,r.event_refs,r.created_at,r.created_by);
 insert into public.program_text_alert_group_revisions select r.*;
 update public.program_text_alert_groups set head_revision_id=r.id,revision=r.revision,
  published_revision_id=case when p_operation='approved' then r.id else published_revision_id end where id=g.id;
 return r;
end $$;

create function public.save_program_text_alert_group(p_group_id uuid,p_expected_hash text,p_members jsonb,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare refs jsonb;g public.program_text_alert_groups%rowtype;h public.program_text_alert_group_revisions%rowtype;
 r public.program_text_alert_group_revisions%rowtype;a uuid;
begin
 if p_actor is null or not exists(select 1 from auth.users where id=p_actor) then raise exception 'A real authenticated reviewer is required' using errcode='42501';end if;
 refs:=private.program_text_alert_group_normalize(p_members);
 perform pg_advisory_xact_lock(hashtextextended('stage1-national-25-release',0));
 if p_group_id is null then
  if p_expected_hash is not null then raise exception 'A new group has no previous revision' using errcode='22023';end if;
 else
  select * into strict g from public.program_text_alert_groups where id=p_group_id for update;
  select * into strict h from public.program_text_alert_group_revisions where id=g.head_revision_id;
  if g.retired or h.content_hash is distinct from p_expected_hash or h.group_id<>g.id or h.revision<>g.revision
   or h.content_hash is distinct from private.program_text_alert_group_revision_hash(h.id,h.group_id,h.revision,h.operation,h.member_refs,h.event_refs,h.created_at,h.created_by) then
   raise exception 'Alert group revision changed' using errcode='40001';end if;
  if exists(select 1 from jsonb_array_elements(h.member_refs) x where not refs@>jsonb_build_array(x.value)) then
   raise exception 'An append must retain every existing member' using errcode='23514';end if;
 end if;
 -- Use the same global lock and deterministic row ordering as group decisions.
 perform 1 from public.shared_award_visual_review_candidates where id in(select(value->>'id')::uuid from jsonb_array_elements(refs)) order by id for update;
 perform 1 from public.shared_award_sources where id in(select c.shared_award_source_id from public.shared_award_visual_review_candidates c
  where c.id in(select(value->>'id')::uuid from jsonb_array_elements(refs))) order by id for update;
 perform 1 from public.program_text_alert_reviews where id in(select(value->>'id')::uuid from jsonb_array_elements(refs)) order by id for update;
 a:=private.program_text_alert_group_validate(refs,g.shared_award_id);
 if exists(select 1 from public.program_text_alert_group_members m where m.review_id in(select(value->>'id')::uuid from jsonb_array_elements(refs))
   and (p_group_id is null or m.group_id<>p_group_id)) then raise exception 'An alert already belongs to another group' using errcode='40001';end if;
 if p_group_id is null then insert into public.program_text_alert_groups(shared_award_id) values(a) returning * into g;
 elsif h.operation='draft' and h.member_refs=refs then
  return jsonb_build_object('ok',true,'group_id',g.id,'revision_id',h.id,'content_hash',h.content_hash,'revision',h.revision,'status','draft');
 end if;
 r:=private.program_text_alert_group_append(g.id,'draft',refs,null,p_actor);
 insert into public.program_text_alert_group_members(review_id,group_id)
  select(value->>'id')::uuid,g.id from jsonb_array_elements(refs) on conflict(review_id) do nothing;
 return jsonb_build_object('ok',true,'group_id',g.id,'revision_id',r.id,'content_hash',r.content_hash,'revision',r.revision,'status','draft');
end $$;

create function public.decide_program_text_alert_group(p_id uuid,p_expected_hash text,p_action text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.program_text_alert_groups%rowtype;h public.program_text_alert_group_revisions%rowtype;
 r public.program_text_alert_group_revisions%rowtype;published public.program_text_alert_group_revisions%rowtype;x jsonb;events jsonb;
begin
 if p_actor is null or not exists(select 1 from auth.users where id=p_actor) then raise exception 'A real authenticated reviewer is required' using errcode='42501';end if;
 if p_action is null or p_action not in('approve','undo') or p_expected_hash is null then raise exception 'Choose an explicit group decision' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('stage1-national-25-release',0));
 select * into strict g from public.program_text_alert_groups where id=p_id for update;
 select * into strict h from public.program_text_alert_group_revisions where id=g.head_revision_id;
 if g.retired or h.content_hash is distinct from p_expected_hash or h.revision<>g.revision
  or h.content_hash is distinct from private.program_text_alert_group_revision_hash(h.id,h.group_id,h.revision,h.operation,h.member_refs,h.event_refs,h.created_at,h.created_by)
 then raise exception 'Alert group revision changed' using errcode='40001';end if;
 if h.operation is distinct from 'draft' then
  if p_action='approve' and h.operation='approved' then return jsonb_build_object('ok',true,'group_id',g.id,'revision_id',h.id,
   'content_hash',h.content_hash,'revision',h.revision,'status','approved','already_reviewed',true);end if;
  raise exception 'Only a draft group can be decided' using errcode='40001';end if;
 if p_action='undo' then
  if g.published_revision_id is not null then
   select * into strict published from public.program_text_alert_group_revisions where id=g.published_revision_id and group_id=g.id and operation='approved';
   r:=private.program_text_alert_group_append(g.id,'undo',published.member_refs,null,p_actor);
   delete from public.program_text_alert_group_members m where m.group_id=g.id and not exists(
    select 1 from jsonb_array_elements(published.member_refs) x where(x.value->>'id')::uuid=m.review_id);
  else
   r:=private.program_text_alert_group_append(g.id,'undo','[]'::jsonb,null,p_actor);
   delete from public.program_text_alert_group_members where group_id=g.id;
   update public.program_text_alert_groups set retired=true where id=g.id;
  end if;
  return jsonb_build_object('ok',true,'group_id',g.id,'revision_id',r.id,'content_hash',r.content_hash,'revision',r.revision,
   'status',case when g.published_revision_id is null then 'retired' else 'undone' end);
 end if;
 perform 1 from public.shared_award_visual_review_candidates where id in(select(value->>'id')::uuid from jsonb_array_elements(h.member_refs)) order by id for update;
 perform 1 from public.shared_award_sources where id in(select c.shared_award_source_id from public.shared_award_visual_review_candidates c
  where c.id in(select(value->>'id')::uuid from jsonb_array_elements(h.member_refs))) order by id for update;
 perform 1 from public.program_text_alert_reviews where id in(select(value->>'id')::uuid from jsonb_array_elements(h.member_refs)) order by id for update;
 if (select count(*) from public.program_text_alert_group_members where group_id=g.id)<>jsonb_array_length(h.member_refs)
  or exists(select 1 from jsonb_array_elements(h.member_refs) x where not exists(select 1 from public.program_text_alert_group_members m where m.group_id=g.id and m.review_id=(x.value->>'id')::uuid)) then
  raise exception 'Alert group membership changed' using errcode='40001';end if;
 perform private.program_text_alert_group_validate(h.member_refs,g.shared_award_id);
 for x in select value from jsonb_array_elements(h.member_refs) order by value->>'id' collate "C" loop
  if (select status from public.program_text_alert_reviews where id=(x->>'id')::uuid)='pending' then
   perform private.decide_program_text_alert_ungrouped((x->>'id')::uuid,x->>'content_hash','approve',p_actor);
  end if;
 end loop;
 -- All original approvals/publications and this revision commit together.
 perform private.program_text_alert_group_validate(h.member_refs,g.shared_award_id);
 select jsonb_agg(jsonb_build_object('review_id',a.id,'event_id',a.event_id,'content_hash',a.content_hash) order by a.id)
 into events from public.program_text_alert_reviews a where a.id in(select(value->>'id')::uuid from jsonb_array_elements(h.member_refs));
 r:=private.program_text_alert_group_append(g.id,'approved',h.member_refs,events,p_actor);
 return jsonb_build_object('ok',true,'group_id',g.id,'revision_id',r.id,'content_hash',r.content_hash,'revision',r.revision,'status','approved');
end $$;

-- Old clients cannot approve or dismiss one pending member behind the group.
create or replace function public.decide_program_text_alert(p_id uuid,p_expected_hash text,p_action text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('stage1-national-25-release',0));
 if exists(select 1 from public.program_text_alert_group_members m join public.program_text_alert_reviews r on r.id=m.review_id
   where m.review_id=p_id and r.status='pending') then raise exception 'Review this alert with its related group' using errcode='40001';end if;
 return private.decide_program_text_alert_ungrouped(p_id,p_expected_hash,p_action,p_actor);
end $$;

create function public.get_program_text_alert_groups(p_review_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_review_ids is null or cardinality(p_review_ids)>100 or array_ndims(p_review_ids)>1
  or array_position(p_review_ids,null) is not null then raise exception 'Use at most 100 review identities' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'shared_award_id',g.shared_award_id,'revision',g.revision,'retired',g.retired,
  'head',to_jsonb(h)-'created_by'-'group_id','published',case when p.id is null then null else to_jsonb(p)-'created_by'-'group_id' end,
  'member_ids',(select jsonb_agg(m.review_id order by m.review_id) from public.program_text_alert_group_members m where m.group_id=g.id)) order by g.id),'[]'::jsonb)
 into result from public.program_text_alert_groups g join public.program_text_alert_group_revisions h on h.id=g.head_revision_id and h.group_id=g.id
 left join public.program_text_alert_group_revisions p on p.id=g.published_revision_id and p.group_id=g.id and p.operation='approved'
 where not g.retired and (g.id=any(p_review_ids) or exists(select 1 from public.program_text_alert_group_members m where m.group_id=g.id and m.review_id=any(p_review_ids)));
 return result;
end $$;

create function public.get_program_text_published_alert_groups(p_event_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_event_ids is null or cardinality(p_event_ids)>1000 or array_ndims(p_event_ids)>1
  or array_position(p_event_ids,null) is not null then raise exception 'Use at most 1000 event identities' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('group_id',g.id,'revision_id',r.id,'content_hash',r.content_hash,'shared_award_id',g.shared_award_id,
  'event_ids',(select jsonb_agg((x.value->>'event_id')::uuid order by x.value->>'review_id') from jsonb_array_elements(r.event_refs) x),
  'member_refs',r.member_refs,'event_refs',r.event_refs,'created_at',r.created_at) order by g.id),'[]'::jsonb)
 into result from public.program_text_alert_groups g join public.program_text_alert_group_revisions r on r.id=g.published_revision_id and r.group_id=g.id and r.operation='approved'
 where not g.retired and exists(select 1 from jsonb_array_elements(r.event_refs) x where(x.value->>'event_id')::uuid=any(p_event_ids))
 and r.content_hash=private.program_text_alert_group_revision_hash(r.id,r.group_id,r.revision,r.operation,r.member_refs,r.event_refs,r.created_at,r.created_by)
 and not exists(select 1 from jsonb_array_elements(r.event_refs) x left join public.program_text_alert_reviews a on a.id=(x.value->>'review_id')::uuid
  where a.id is null or a.status is distinct from 'approved' or a.content_hash is distinct from x.value->>'content_hash'
   or a.event_id is distinct from(x.value->>'event_id')::uuid
   or not r.member_refs@>jsonb_build_array(jsonb_build_object('id',a.id,'content_hash',a.content_hash))
   or not coalesce(private.public_digest_reviewed_text_source_current((x.value->>'event_id')::uuid),false));
 return result;
end $$;

revoke all on function private.program_text_alert_group_revision_hash(uuid,uuid,integer,text,jsonb,jsonb,timestamptz,uuid),
 private.program_text_alert_group_freeze(),private.program_text_alert_group_normalize(jsonb),private.program_text_alert_group_validate(jsonb,uuid),
 private.program_text_alert_group_append(uuid,text,jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.save_program_text_alert_group(uuid,text,jsonb,uuid),public.decide_program_text_alert_group(uuid,text,text,uuid),
 public.get_program_text_alert_groups(uuid[]),public.get_program_text_published_alert_groups(uuid[]),public.decide_program_text_alert(uuid,text,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.save_program_text_alert_group(uuid,text,jsonb,uuid),public.decide_program_text_alert_group(uuid,text,text,uuid),
 public.get_program_text_alert_groups(uuid[]),public.get_program_text_published_alert_groups(uuid[]),public.decide_program_text_alert(uuid,text,text,uuid) to service_role;

-- Prove the private decision body is the exact reviewed preimage, renamed only.
do $postimage$
declare item record;
begin
 if encode(extensions.digest(convert_to(replace(pg_get_functiondef('private.decide_program_text_alert_ungrouped(uuid,text,text,uuid)'::regprocedure),
 'FUNCTION private.decide_program_text_alert_ungrouped(','FUNCTION public.decide_program_text_alert('),'UTF8'),'sha256'),'hex')
 <> 'f6a71a7ee0ee67ecbd6277bb703f885dbdce0f9bfe26ceaf141599a42e48e6e1' then raise exception 'Original decision body changed' using errcode='40001';end if;
 for item in select * from(values
  ('private.program_text_alert_hash(public.shared_award_visual_review_candidates,jsonb,jsonb)','55328ee49c607d7065bdab98d821569d4d825e30c88b28842621470f4510225e'),
  ('private.publish_reviewed_program_text_event(uuid,jsonb,jsonb)','bdb5450a4c07b93bb614f51460419b08e974bcf0d6fcca10be190f2733a28fc0'),
  ('private.public_digest_reviewed_text_source_current(uuid)','e86fb4d7b5bd764f607d9664b81789724f4e3f3573dcb70e663578a1f1ed6549')
 )p(signature,hash) loop
  if encode(extensions.digest(convert_to(pg_get_functiondef(item.signature::regprocedure),'UTF8'),'sha256'),'hex')<>item.hash then
   raise exception 'Original alert helper changed: %',item.signature using errcode='40001';end if;
 end loop;
end $postimage$;
