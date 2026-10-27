-- Durable collection-quality holds and finite official-guidance source approval.
-- No source, baseline, review, provider or public-fact data is seeded.
-- Reviewed combined DDL: quality-v2, canonical PAPPG-v2, SMART-twelve.

do $combined_original_preflight$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('private.awardping_program_fact_source_ready(uuid)','c0777586d609afbdf4e1d876efc6bf1a44c88f8dfe743be825c8a9469b765e4f'),
  ('private.awardping_program_source_allowed(uuid)','dc1a1b621be259f7f54a4f9acfe5197162f66496827d4bcf06cee55944e7aba2'),
  ('private.awardping_program_source_pending_valid(jsonb)','bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e'),
  ('private.awardping_program_text_reference_valid(jsonb)','72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027'),
  ('private.awardping_program_text_source_access(uuid,text,uuid)','a56ccca4438d7711fba48f2823d3b6feb50da7d4f11c809ca7a7b02afbc064ad'),
  ('private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb)','2f3534abaf9eb254a0e9156ffcda9a1a0aa37b1a947c8126c337c2b9cbfa4f44'),
  ('private.awardping_program_text_source_approval_dto(uuid)','aa798ee66b38cab9c2f711ed29c5d1ec9d89cce4f4fed2ff4434f011fac86232'),
  ('private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb)','3ce1fbde760edb6e3e34890321871ed873eeba16d64ccfc1ecfbfca638fd56a8'),
  ('private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean)','8963fbde4b07680ed402161713a5ae705963c417a9026fc3eae8cca4594235bb'),
  ('private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)','c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4'),
  ('public.approve_program_text_source(jsonb,jsonb,text)','38bc575638016e966692b9d2a3d2d243fcb652b8157a343d5f0500e4bfda5115'),
  ('public.get_program_text_fact_review_batch()','02eb02251d3b9f6a096f020acf77b8e5fc9b50b2d5b8505c335fce8d7c8b53a4'),
  ('public.get_program_text_source_pending_capture(uuid)','6e971b495758a8b5d7fbbb47b691965e73b420a3f906a2d35a92549d873f3689'),
  ('public.get_program_text_worker_roster_page(text,jsonb,text,integer)','0dcd76f3e6a55a087c98149ed47ff5865154c1737b68b9acc8b16031f7d84334'),
  ('public.prepare_program_text_source(jsonb,jsonb,text)','2c3deee422c83ac638de9649d53ee468ce49c33a63a299df4270077927221fc1')
 ) as reviewed(signature,body_hash) loop
  select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual
   from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure;
  if actual is distinct from expected.body_hash then
   raise exception 'Combined composition combined_original_preflight function changed: %',expected.signature using errcode='40001';end if;
  if exists(select 1 from pg_catalog.pg_proc p,lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   where p.oid=expected.signature::regprocedure and a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,'service_role'::regrole))
  then raise exception 'Combined composition original function ACL changed: %',expected.signature using errcode='42501';end if;
 end loop;
end $combined_original_preflight$;

-- BEGIN quality-v2 exact pinned input
-- PROPOSED PRIVATE SQL ONLY. Root creates the real migration name and rehearses
-- it transactionally before any application. No old evidence/state is replaced.
create sequence private.awardping_program_text_collection_failure_order;
revoke all on sequence private.awardping_program_text_collection_failure_order from public,anon,authenticated;
grant usage on sequence private.awardping_program_text_collection_failure_order to service_role;

create table public.program_text_collection_failures (
 id uuid primary key,
 attempt_number bigint not null unique check(attempt_number>0),
 source_id uuid not null references public.shared_award_sources(id) on delete restrict,
 shared_award_id uuid not null references public.shared_awards(id) on delete restrict,
 source_url text not null check(length(source_url) between 1 and 10000),
 epoch uuid not null check(epoch<>'00000000-0000-0000-0000-000000000000'),
 expected_state jsonb not null check(jsonb_typeof(expected_state)='object' and octet_length(expected_state::text)<=131072),
 observed_at timestamptz not null,
 reason_codes text[] not null,
 capture_summary jsonb
);
alter table public.program_text_collection_failures enable row level security;
revoke all on table public.program_text_collection_failures from public,anon,authenticated,service_role;
grant select,insert on table public.program_text_collection_failures to service_role;
create index program_text_collection_failures_source_latest on public.program_text_collection_failures(source_id,attempt_number desc);
create index program_text_collection_failures_source_epoch_latest on public.program_text_collection_failures(source_id,epoch,attempt_number desc);

create function private.awardping_program_text_failure_summary_valid(p_value jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_time timestamptz;
begin
 if p_value is null then return true;end if;
 if not private.awardping_program_exact_object(p_value,array['capture_id','captured_at','raw_sha256','raw_byte_length','retained_locally','incomplete_reason_codes'])
  or not coalesce(jsonb_typeof(p_value->'capture_id')='string' and p_value->>'capture_id' ~ '^[a-f0-9]{64}$'
   and jsonb_typeof(p_value->'raw_sha256')='string' and p_value->>'raw_sha256' ~ '^[a-f0-9]{64}$'
   and jsonb_typeof(p_value->'raw_byte_length')='number' and p_value->>'raw_byte_length' ~ '^[1-9][0-9]*$'
   and (p_value->>'raw_byte_length')::numeric between 1 and 20971520
   and jsonb_typeof(p_value->'retained_locally')='boolean'
   and jsonb_typeof(p_value->'captured_at')='string'
   and p_value->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   and jsonb_typeof(p_value->'incomplete_reason_codes')='array',false)
 then return false;end if;
 if jsonb_array_length(p_value->'incomplete_reason_codes') not between 1 and 16
  or exists(select 1 from jsonb_array_elements(p_value->'incomplete_reason_codes') r
   where jsonb_typeof(r)<>'string' or r#>>'{}' !~ '^[a-z][a-z0-9_]{0,100}$')
  or (select count(*) from jsonb_array_elements(p_value->'incomplete_reason_codes'))<>
   (select count(distinct r) from jsonb_array_elements(p_value->'incomplete_reason_codes') r)
 then return false;end if;
 v_time:=(p_value->>'captured_at')::timestamptz;
 return to_char(v_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=p_value->>'captured_at';
exception when others then return false;
end;
$$;

create function private.awardping_guard_program_text_collection_failure()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_source public.shared_award_sources%rowtype;
begin
 if tg_op<>'INSERT' then raise exception 'Collection failure history is immutable.' using errcode='23514';end if;
 -- Match the existing collection-state/fact/publication lock order.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict v_source from public.shared_award_sources where id=new.source_id for update;
 if new.id is null or new.id='00000000-0000-0000-0000-000000000000'
  or new.shared_award_id is distinct from v_source.shared_award_id or new.source_url is distinct from v_source.url
  or new.epoch is null or new.epoch='00000000-0000-0000-0000-000000000000'
  or new.epoch is distinct from (select epoch from public.program_text_source_authority_epochs where active)
  or not private.awardping_program_text_source_access(new.source_id,null,new.epoch)
 then raise exception 'Current source/owner/URL/epoch authority is required.' using errcode='23514';end if;
 if jsonb_typeof(new.expected_state) is distinct from 'object' or octet_length(new.expected_state::text)>131072 then
  raise exception 'A bounded exact prior state is required.' using errcode='23514';end if;
 if v_source.text_monitoring_state is distinct from new.expected_state then
  raise exception 'Source state changed before failure recording.' using errcode='40001';end if;
 if new.expected_state<>'{}'::jsonb and (new.expected_state->>'schema' is distinct from 'awardping.program-text-state.v1'
  or new.expected_state->>'epoch' is distinct from new.epoch::text) then
  raise exception 'A collection failure cannot change the monitoring epoch.' using errcode='23514';end if;
 if new.expected_state->>'status' in ('awaiting_review','held','error') and
  new.expected_state->'baseline_ref' is distinct from new.expected_state->'latest_ref' then
  raise exception 'Preserved comparisons are not new capture failures.' using errcode='23514';end if;
 if new.reason_codes is null or cardinality(new.reason_codes) not between 1 and 16 or
  array_position(new.reason_codes,null) is not null or not (new.reason_codes <@ array[
   'capture_failed','incomplete_capture','incomplete_capture_retention_failed','durable_retention_failed','retained_reference_mismatch','durable_readback_mismatch','pdf_original_changed_without_text_change']::text[])
  or (select count(*) from unnest(new.reason_codes) r)<>(select count(distinct r) from unnest(new.reason_codes) r)
 then raise exception 'Only bounded safe collection failure reasons are accepted.' using errcode='23514';end if;
 if not private.awardping_program_text_failure_summary_valid(new.capture_summary)
  or new.capture_summary is not null and not (new.reason_codes && array['incomplete_capture','incomplete_capture_retention_failed']::text[])
 then raise exception 'Only an honest incomplete observation summary may be recorded.' using errcode='23514';end if;
 if new.capture_summary is not null and (new.capture_summary->>'captured_at')::timestamptz>clock_timestamp()+interval '5 minutes' then
  raise exception 'Invalid collection observation time.' using errcode='23514';end if;
 -- Allocate ordering AFTER locking. Wall-clock rollback cannot make a newer
 -- failed attempt disappear behind a previously cleared older failure.
 new.attempt_number:=pg_catalog.nextval('private.awardping_program_text_collection_failure_order'::regclass);
 new.observed_at:=clock_timestamp();
 return new;
end;
$$;
create trigger program_text_collection_failure_insert_guard before insert on public.program_text_collection_failures
 for each row execute function private.awardping_guard_program_text_collection_failure();
create trigger program_text_collection_failure_immutable before update or delete on public.program_text_collection_failures
 for each row execute function private.awardping_guard_program_text_collection_failure();

create function private.awardping_program_text_collection_failure_dto(p_row public.program_text_collection_failures)
returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-text-collection-quality.v1','id',(p_row).id,
  'source_id',(p_row).source_id,'shared_award_id',(p_row).shared_award_id,'source_url',(p_row).source_url,'epoch',(p_row).epoch,
  'observed_at',to_char((p_row).observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'reason_codes',(p_row).reason_codes,'expected_latest_capture_id',(p_row).expected_state#>'{latest_ref,capture_id}',
  'capture_summary',(p_row).capture_summary);
$$;
create function private.awardping_program_text_collection_quality(p_id uuid,p_epoch uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.awardping_program_text_collection_failure_dto(failure)
 from public.program_text_collection_failures failure join public.shared_award_sources source on source.id=failure.source_id
 where source.id=p_id and failure.shared_award_id=source.shared_award_id and failure.source_url=source.url
  and (p_epoch is null or failure.epoch=p_epoch)
 order by failure.attempt_number desc limit 1;
$$;
create function private.awardping_program_text_collection_quality_ready(p_id uuid,p_epoch uuid)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare v_source public.shared_award_sources%rowtype; v_failure jsonb; v_state jsonb; v_latest jsonb;
begin
 select * into strict v_source from public.shared_award_sources where id=p_id;
 if p_epoch is null then return false;end if;
 v_failure:=private.awardping_program_text_collection_quality(p_id,p_epoch);
 if v_failure is null then return true;end if;
 v_state:=v_source.text_monitoring_state;v_latest:=v_state->'latest_ref';
 return coalesce(v_state->>'schema'='awardping.program-text-state.v1' and v_state->>'epoch'=p_epoch::text
  and private.awardping_program_text_reference_valid(v_latest)
  and v_latest#>>'{source,id}'=v_source.id::text and v_latest#>>'{source,shared_award_id}'=v_source.shared_award_id::text
  and v_latest#>>'{source,url}'=v_source.url
  and v_latest->'capture_id' is distinct from v_failure->'expected_latest_capture_id'
  and (v_latest->>'captured_at')::timestamptz>(v_failure->>'observed_at')::timestamptz
  and (v_state->>'last_checked_at')::timestamptz>=(v_latest->>'captured_at')::timestamptz,false);
exception when others then return false;
end;
$$;

create function public.record_program_text_collection_failure(p_request jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_row public.program_text_collection_failures%rowtype;
begin
 if not private.awardping_program_exact_object(p_request,array['schema','attempt_id','source_id','shared_award_id','source_url','epoch','expected_state','reason_codes','capture_summary'])
  or p_request->>'schema' is distinct from 'awardping.program-text-collection-failure-request.v1'
  or octet_length(p_request::text)>262144 or jsonb_typeof(p_request->'reason_codes') is distinct from 'array'
 then raise exception 'Invalid collection failure request.' using errcode='23514';end if;
 if jsonb_array_length(p_request->'reason_codes') not between 1 and 16
  or exists(select 1 from jsonb_array_elements(p_request->'reason_codes') r where jsonb_typeof(r)<>'string')
 then raise exception 'Invalid collection failure reason list.' using errcode='23514';end if;
 insert into public.program_text_collection_failures(id,source_id,shared_award_id,source_url,epoch,expected_state,reason_codes,capture_summary)
 values((p_request->>'attempt_id')::uuid,(p_request->>'source_id')::uuid,(p_request->>'shared_award_id')::uuid,
  p_request->>'source_url',(p_request->>'epoch')::uuid,p_request->'expected_state',
  array(select jsonb_array_elements_text(p_request->'reason_codes')),nullif(p_request->'capture_summary','null'::jsonb)) returning * into v_row;
 return jsonb_build_object('schema','awardping.program-text-collection-failure-receipt.v1','recorded',true,
  'failure',private.awardping_program_text_collection_failure_dto(v_row));
end;
$$;

-- Existing private board status only. No new page or raw diagnostic output.
create function private.awardping_program_text_collection_quality_label(p_id uuid)
returns text language plpgsql stable security invoker set search_path='' as $$
declare v_source public.shared_award_sources%rowtype; v_failure jsonb; v_epoch uuid;
begin
 select * into strict v_source from public.shared_award_sources where id=p_id;
 v_failure:=private.awardping_program_text_collection_quality(p_id);
 if v_failure is null then return null;end if;
 v_epoch:=coalesce(v_source.text_monitoring_state->>'epoch',v_failure->>'epoch')::uuid;
 if v_failure->>'epoch'<>v_epoch::text then return null;end if;
 if private.awardping_program_text_collection_quality_ready(p_id,v_epoch) then return null;end if;
 return 'Latest collection incomplete';
exception when others then return 'Latest collection unavailable';
end;
$$;

-- Extend two existing bounded APIs surgically; all old readiness, scope, source,
-- page-count, cursor, seal and authority guards remain in their current bodies.
do $quality_wrappers$
declare v_definition text; v_needle text; v_replacement text;
begin
 v_definition:=pg_catalog.pg_get_functiondef('private.awardping_program_fact_source_ready(uuid)'::regprocedure);
 v_needle:='and v_state->>''status''=''baseline_ready''';
 v_replacement:='and private.awardping_program_text_collection_quality_ready(p_id,(v_state->>''epoch'')::uuid)'||chr(10)||'  '||v_needle;
 if length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) then
  raise exception 'Current fact-readiness body changed; review required.' using errcode='23514';end if;
 execute replace(v_definition,v_needle,v_replacement);

 v_definition:=pg_catalog.pg_get_functiondef('public.get_program_text_worker_roster_page(text,jsonb,text,integer)'::regprocedure);
 v_needle:='''text_monitoring_state'',s.text_monitoring_state,'||chr(10)||'   ''text_source_approvals'',private.awardping_program_text_source_approval_dto(s.id)) as entry';
 v_replacement:='''text_monitoring_state'',s.text_monitoring_state,'||chr(10)||'   ''text_collection_quality'',private.awardping_program_text_collection_quality(s.id),'||chr(10)||'   ''text_source_approvals'',private.awardping_program_text_source_approval_dto(s.id)) as entry';
 if length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) then
  raise exception 'Current paged source body changed; review required.' using errcode='23514';end if;
 execute replace(v_definition,v_needle,v_replacement);

 v_definition:=pg_catalog.pg_get_functiondef('public.get_program_text_fact_review_batch()'::regprocedure);
 v_needle:='''state'',coalesce(s.text_monitoring_state->>''status'',''not_captured'')) order by s.url)';
 v_replacement:='''state'',coalesce(private.awardping_program_text_collection_quality_label(s.id),s.text_monitoring_state->>''status'',''not_captured'')) order by s.url)';
 if length(v_definition)-length(replace(v_definition,v_needle,''))<>length(v_needle) then
  raise exception 'Current private board source status changed; review required.' using errcode='23514';end if;
 execute replace(v_definition,v_needle,v_replacement);
end;
$quality_wrappers$;

revoke all on function private.awardping_program_text_failure_summary_valid(jsonb),
 private.awardping_guard_program_text_collection_failure(),
 private.awardping_program_text_collection_failure_dto(public.program_text_collection_failures),
 private.awardping_program_text_collection_quality(uuid,uuid),
 private.awardping_program_text_collection_quality_ready(uuid,uuid),
 private.awardping_program_text_collection_quality_label(uuid),
 public.record_program_text_collection_failure(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_text_failure_summary_valid(jsonb),
 private.awardping_guard_program_text_collection_failure(),
 private.awardping_program_text_collection_failure_dto(public.program_text_collection_failures),
 private.awardping_program_text_collection_quality(uuid,uuid),
 private.awardping_program_text_collection_quality_ready(uuid,uuid),
 private.awardping_program_text_collection_quality_label(uuid),
 public.record_program_text_collection_failure(jsonb) to service_role;
notify pgrst,'reload schema';

-- END quality-v2
do $combined_after_quality$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('private.awardping_program_fact_source_ready(uuid)','fc6f20fad1d8ca97e144c564ebccfc2a28e97fa4c173bbb1117efc02c0203e96'),
  ('private.awardping_program_source_allowed(uuid)','dc1a1b621be259f7f54a4f9acfe5197162f66496827d4bcf06cee55944e7aba2'),
  ('private.awardping_program_source_pending_valid(jsonb)','bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e'),
  ('private.awardping_program_text_reference_valid(jsonb)','72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027'),
  ('private.awardping_program_text_source_access(uuid,text,uuid)','a56ccca4438d7711fba48f2823d3b6feb50da7d4f11c809ca7a7b02afbc064ad'),
  ('private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb)','2f3534abaf9eb254a0e9156ffcda9a1a0aa37b1a947c8126c337c2b9cbfa4f44'),
  ('private.awardping_program_text_source_approval_dto(uuid)','aa798ee66b38cab9c2f711ed29c5d1ec9d89cce4f4fed2ff4434f011fac86232'),
  ('private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb)','3ce1fbde760edb6e3e34890321871ed873eeba16d64ccfc1ecfbfca638fd56a8'),
  ('private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean)','8963fbde4b07680ed402161713a5ae705963c417a9026fc3eae8cca4594235bb'),
  ('private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)','c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4'),
  ('public.approve_program_text_source(jsonb,jsonb,text)','38bc575638016e966692b9d2a3d2d243fcb652b8157a343d5f0500e4bfda5115'),
  ('public.get_program_text_fact_review_batch()','eb3c1f639dd5e1ee72684d254169dde63a45e8a52b56bcb2c4b28e51eb1d5b51'),
  ('public.get_program_text_source_pending_capture(uuid)','6e971b495758a8b5d7fbbb47b691965e73b420a3f906a2d35a92549d873f3689'),
  ('public.get_program_text_worker_roster_page(text,jsonb,text,integer)','f6376d4980527f58393c96cc42aee8bbe38e8225ff52c4045ef7b9e99e90555a'),
  ('public.prepare_program_text_source(jsonb,jsonb,text)','2c3deee422c83ac638de9649d53ee468ce49c33a63a299df4270077927221fc1')
 ) as reviewed(signature,body_hash) loop
  select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual
   from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure;
  if actual is distinct from expected.body_hash then
   raise exception 'Combined composition combined_after_quality function changed: %',expected.signature using errcode='40001';end if;
 end loop;
end $combined_after_quality$;

-- BEGIN PAPPG-v2 composed roster successor
-- PRIVATE CANDIDATE ONLY. No seed, source creation, lease, claim or handoff.
-- Root must derive a real migration and compile/rollback-test against actual PG.
create function private.awardping_pappg_canonical_url_key(p_url text)
returns text language sql immutable security invoker set search_path='' as $$
 select lower(regexp_replace(split_part(p_url,'#',1),'/+$',''));
$$;

create function private.awardping_pappg_canonical_catalogue()
returns table(source_id uuid,owner_id uuid) language sql immutable security invoker set search_path='' as $$
 values
 ('19204933-2b56-42ac-96ee-b54213a2785a'::uuid,'c9b26239-8177-445b-ab39-473bc0c14d8f'::uuid),
 ('27a2e7e7-d679-4b60-a9fb-300bbe33a94c'::uuid,'e4087bdf-e170-43a8-a1d1-6f6cead31eb4'::uuid),
 ('29839757-599c-4758-873f-974380ca7e9d'::uuid,'36ddccfa-b6a2-414c-b955-6a56b269148f'::uuid),
 ('3e5795a6-d0d0-4894-af01-b1abcfdee999'::uuid,'c2771e8a-9328-47ca-a15b-871f27178b1d'::uuid),
 ('5a952e53-9c66-4c0f-9c42-07eaef865011'::uuid,'2208c57b-6bde-44da-8c9e-6461c607ffe9'::uuid),
 ('73e4e932-cf63-47c4-a929-11a50e170728'::uuid,'b752360f-b17b-4e19-acbd-28ec4222a9d6'::uuid),
 ('8ff84135-5a09-4873-ab89-28129e5d9cbf'::uuid,'017d5a96-6121-4353-b094-985080a3f84e'::uuid),
 ('a04ebac4-827b-423d-a79f-8bfdd5e24008'::uuid,'3a091e8a-57b9-40bf-b7df-7ed977cfca1b'::uuid),
 ('ca7a2e0b-39aa-44ea-9cf3-3949fbcb8e4c'::uuid,'789d0f7a-4ed1-4588-b399-e14ce33e6ccb'::uuid);
$$;

create table public.program_text_pappg_canonical_dispositions (
 source_url text primary key check(source_url='https://www.nsf.gov/policies/pappg'),
 revision uuid not null unique,content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 selected_source_id uuid not null unique check(selected_source_id='de868fe8-54ba-4fa0-8210-b27c8f182112'),
 shared_award_id uuid not null check(shared_award_id='d955a846-cee1-4c01-932e-e3cb7215f3fb'),
 cohort_key text not null check(cohort_key='nsf_grfp'),epoch uuid not null references public.program_text_source_authority_epochs(epoch),
 pending_id uuid not null unique,proposal_hash text not null check(proposal_hash~'^[a-f0-9]{64}$'),
 proposal jsonb not null,boundary jsonb not null,reason text not null check(length(btrim(reason)) between 20 and 2000),
 approved_id uuid unique,actor text not null check(length(btrim(actor)) between 1 and 320),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(selected_source_id) references public.shared_award_sources(id) deferrable initially deferred,
 foreign key(pending_id) references public.program_text_source_pending_requests(id) deferrable initially deferred,
 foreign key(approved_id) references public.program_text_source_approvals(id) deferrable initially deferred,
 check(jsonb_typeof(proposal)='object' and jsonb_typeof(boundary)='object' and octet_length(boundary::text)<=1048576)
);
alter table public.program_text_pappg_canonical_dispositions enable row level security;
revoke all on public.program_text_pappg_canonical_dispositions from public,anon,authenticated,service_role;
grant select on public.program_text_pappg_canonical_dispositions to service_role;

-- Only NULL -> exact pending approval may change. Revoke never deletes the tombstone.
create function private.awardping_pappg_canonical_disposition_immutable()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-'approved_id') is distinct from (to_jsonb(old)-'approved_id')
  or old.approved_id is not null or new.approved_id is distinct from old.pending_id
 then raise exception 'The finite PAPPG disposition is an immutable tombstone.' using errcode='23514';end if;
 return new;
end;
$$;
create trigger pappg_canonical_disposition_immutable before update or delete on public.program_text_pappg_canonical_dispositions
for each row execute function private.awardping_pappg_canonical_disposition_immutable();

-- No row-version or updated_at fingerprints: only identities, history and activity.
-- Hash original history rows individually; never expose prompts or snapshot bodies.
create function private.awardping_pappg_canonical_page_metadata_hash(p_metadata jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(extensions.digest(convert_to((coalesce(p_metadata,'{}'::jsonb)-'generated_at')::text,'UTF8'),'sha256'),'hex');
$$;

create function private.awardping_pappg_canonical_foreign_projection(p_source uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s public.shared_award_sources%rowtype;history jsonb;activity jsonb;result jsonb;n bigint;
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 if not exists(select 1 from private.awardping_pappg_canonical_catalogue() c where c.source_id=s.id and c.owner_id=s.shared_award_id)
  or s.url is distinct from 'https://www.nsf.gov/policies/pappg' then raise exception 'Foreign catalogue identity changed.' using errcode='40001';end if;
 select (select count(*) from public.shared_award_source_snapshots x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_source_visual_snapshots x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_visual_review_candidates x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_change_events x where x.shared_award_source_id=s.id)
  +(select count(*) from public.shared_award_change_event_visual_evidence x where x.shared_award_source_id=s.id)
  into n;
 if n>2000 then raise exception 'Foreign retained-history bound exceeded.' using errcode='23514';end if;
 if (select count(*) from public.shared_award_source_acquisitions x where x.shared_award_source_id=s.id)
  +(select count(*) from public.program_text_source_approvals x where x.source_id=s.id)
  +(select count(*) from public.program_text_source_approval_events x join public.program_text_source_approvals a on a.id=x.approval_id where a.source_id=s.id)
  +(select count(*) from public.program_text_source_pending_requests x where x.source_id=s.id)
  +(select count(*) from public.program_text_source_roster x where s.id=any(x.source_ids))
  +(select count(*) from public.stage1_award_source_manifest x where s.id=any(x.source_ids))
  +(select count(*) from public.program_variation_scopes x where exists(select 1 from jsonb_array_elements(x.source_roles) r where r->'source_ids' ? s.id::text))
  +(select count(*) from public.program_text_fact_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id))))
  +(select count(*) from public.program_variation_unit_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id))))
  +(select count(*) from public.monitors x where x.shared_award_source_id=s.id)>2000
 then raise exception 'Foreign dependency activity bound exceeded.' using errcode='23514';end if;
 select jsonb_build_object(
  'snapshots',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.hash,x.source_url) order by x.id) from public.shared_award_source_snapshots x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'visual',coalesce((select jsonb_agg(encode(extensions.digest(convert_to((to_jsonb(x)-'updated_at')::text,'UTF8'),'sha256'),'hex') order by (to_jsonb(x)-'updated_at')::text) from public.shared_award_source_visual_snapshots x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'candidates',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.status,x.candidate_signature,x.previous_snapshot_ref,x.new_snapshot_ref,x.gemini_batch_name,x.model,encode(extensions.digest(convert_to(coalesce(x.ai_result,'null'::jsonb)::text,'UTF8'),'sha256'),'hex')) order by x.id) from public.shared_award_visual_review_candidates x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.previous_snapshot_id,x.new_snapshot_id,x.previous_hash,x.new_hash) order by x.id) from public.shared_award_change_events x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'event_evidence',coalesce((select jsonb_agg(encode(extensions.digest(convert_to((to_jsonb(x)-'verified_at'-'backfilled_at')::text,'UTF8'),'sha256'),'hex') order by x.change_event_id) from public.shared_award_change_event_visual_evidence x where x.shared_award_source_id=s.id),'[]'::jsonb)) into history;
 select jsonb_build_object(
  'acquisitions',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.acquisition_kind,x.notification_mode,
   encode(extensions.digest(convert_to(x.review_seal::text,'UTF8'),'sha256'),'hex'),encode(extensions.digest(convert_to(x.metadata::text,'UTF8'),'sha256'),'hex')) order by x.id) from public.shared_award_source_acquisitions x where x.shared_award_source_id=s.id),'[]'::jsonb),
  'approvals',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.epoch,x.content_hash,(select coalesce(jsonb_agg(jsonb_build_array(e.id,e.action) order by e.id),'[]'::jsonb) from public.program_text_source_approval_events e where e.approval_id=x.id)) order by x.id) from public.program_text_source_approvals x where x.source_id=s.id),'[]'::jsonb),
  'pending',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.epoch,x.content_hash) order by x.id) from public.program_text_source_pending_requests x where x.source_id=s.id),'[]'::jsonb),
  'text_roles',coalesce((select jsonb_agg(jsonb_build_array(x.cohort_key,x.source_role,x.revision) order by x.cohort_key,x.source_role) from public.program_text_source_roster x where s.id=any(x.source_ids)),'[]'::jsonb),
  'legacy_roles',coalesce((select jsonb_agg(jsonb_build_array(x.cohort_key,x.source_ids) order by x.cohort_key) from public.stage1_award_source_manifest x where s.id=any(x.source_ids)),'[]'::jsonb),
  'variation_scopes',coalesce((select jsonb_agg(jsonb_build_array(x.inventory_id,x.scope_key,x.retired) order by x.inventory_id,x.scope_key) from public.program_variation_scopes x where exists(select 1 from jsonb_array_elements(x.source_roles) r where r->'source_ids' ? s.id::text)),'[]'::jsonb),
  'fact_reviews',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.status,x.content_hash) order by x.id) from public.program_text_fact_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id)))),'[]'::jsonb),
  'variation_reviews',coalesce((select jsonb_agg(jsonb_build_array(x.id,x.content_hash) order by x.id) from public.program_variation_unit_reviews x where x.validation#>'{review,capture_refs}' @> jsonb_build_array(jsonb_build_object('source',jsonb_build_object('id',s.id)))),'[]'::jsonb),
  'monitors',coalesce((select jsonb_agg(jsonb_build_array(x.id,to_jsonb(x)->'status',to_jsonb(x)->'is_active') order by x.id) from public.monitors x where x.shared_award_source_id=s.id),'[]'::jsonb)) into activity;
 if octet_length(history::text)>4194304 or octet_length(activity::text)>262144 then raise exception 'Foreign evidence projection is too large.' using errcode='23514';end if;
 result:=jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state,'last_hash',s.last_hash,
  'page_metadata_sha256',private.awardping_pappg_canonical_page_metadata_hash(s.page_metadata),
  'owner_status',(select a.status from public.shared_awards a where a.id=s.shared_award_id),
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('cohort_key',m.cohort_key,'member_kind',m.member_kind) order by m.cohort_key) from public.stage1_award_members m where m.shared_award_id=s.shared_award_id),'[]'::jsonb),
  'history_count',n,'history_sha256',encode(extensions.digest(convert_to(history::text,'UTF8'),'sha256'),'hex'),
  'activity',activity);
 if octet_length(result::text)>131072 then raise exception 'Foreign source projection is too large.' using errcode='23514';end if;
 return result;
end;
$$;

create function private.awardping_pappg_canonical_context(p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare catalogue jsonb;collisions jsonb;selected jsonb;authority jsonb;roles jsonb;result jsonb;
begin
 if not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
  or not exists(select 1 from public.stage1_award_registry where cohort_key='nsf_grfp' and canonical_shared_award_id='d955a846-cee1-4c01-932e-e3cb7215f3fb')
 then raise exception 'Current NSF authority epoch changed.' using errcode='40001';end if;
 select jsonb_agg(private.awardping_pappg_canonical_foreign_projection(c.source_id) order by c.source_id) into catalogue from private.awardping_pappg_canonical_catalogue() c;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url) order by s.id),'[]'::jsonb) into collisions
 from public.shared_award_sources s where private.awardping_pappg_canonical_url_key(s.url)='https://www.nsf.gov/policies/pappg';
 if jsonb_array_length(collisions)>10 then raise exception 'PAPPG collision catalogue grew.' using errcode='40001';end if;
 select jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
  'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state) into selected from public.shared_award_sources s where id='de868fe8-54ba-4fa0-8210-b27c8f182112';
 select jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,'text_monitoring_state',s.text_monitoring_state) into strict authority
 from public.shared_award_sources s where id='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',r.cohort_key,'source_role',r.source_role,'revision',r.revision,'source_ids',r.source_ids,'manifest_status',r.manifest_status,'evidence',r.evidence) order by r.source_role),'[]'::jsonb)
 into roles from public.program_text_source_roster r where cohort_key='nsf_grfp';
 result:=jsonb_build_object('schema','awardping.program-text-pappg-canonical-context.v1','epoch',p_epoch,'cohort_key','nsf_grfp',
  'shared_award_id','d955a846-cee1-4c01-932e-e3cb7215f3fb','selected_source_id','de868fe8-54ba-4fa0-8210-b27c8f182112',
  'catalogue',catalogue,'collisions',collisions,'selected_source',coalesce(selected,'null'::jsonb),'authority',authority,'roles',roles);
 if jsonb_array_length(catalogue)<>9 or jsonb_array_length(roles)<>8 or octet_length(result::text)>1048576 then raise exception 'Finite NSF context is incomplete or oversized.' using errcode='23514';end if;
 return result;
end;
$$;

create function public.inspect_program_text_pappg_canonical(p_epoch uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-text-pappg-canonical-inspection.v1','epoch',p_epoch,'context',c,
  'context_hash',encode(extensions.digest(convert_to(c::text,'UTF8'),'sha256'),'hex')) from (select private.awardping_pappg_canonical_context(p_epoch) c) inspected;
$$;

-- Three phases: reserve before creation, exact pending proof, current approved collector.
create function private.awardping_pappg_canonical_boundary_current(p_pending uuid,p_approved boolean default false)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;actual jsonb;s public.shared_award_sources%rowtype;
 a public.program_text_source_approvals%rowtype;r jsonb;role public.program_text_source_roster%rowtype;ref jsonb;authority public.shared_award_sources%rowtype;
begin
 select * into strict d from public.program_text_pappg_canonical_dispositions where pending_id=p_pending;
 actual:=private.awardping_pappg_canonical_context(d.epoch);
 if actual->'catalogue' is distinct from d.boundary->'catalogue'
  or (actual->'collisions')-((select ordinality::integer-1 from jsonb_array_elements(actual->'collisions') with ordinality x(v,ordinality) where v->>'id'=d.selected_source_id::text)) is distinct from d.boundary->'collisions'
 then
  -- Before normal prepare inserts the selected row, there is nothing to subtract.
  if actual->'catalogue' is distinct from d.boundary->'catalogue' or actual->'collisions' is distinct from d.boundary->'collisions' or p_approved then return false;end if;
 end if;
 if d.proposal_hash is distinct from encode(extensions.digest(convert_to(d.proposal::text,'UTF8'),'sha256'),'hex')
  or d.content_hash is distinct from encode(extensions.digest(convert_to(jsonb_build_object('schema','awardping.program-text-pappg-canonical-disposition.v1',
   'revision',d.revision,'pending_id',to_jsonb(d.pending_id),'proposal_hash',d.proposal_hash,'context',d.boundary,'reason',to_jsonb(d.reason))::text,'UTF8'),'sha256'),'hex')
  or d.boundary->'selected_source' is distinct from 'null'::jsonb then return false;end if;
 if not p_approved then
  if actual->'authority' is distinct from d.boundary->'authority' or actual->'roles' is distinct from d.boundary->'roles' then return false;end if;
  select * into s from public.shared_award_sources where id=d.selected_source_id;
  if found and (s.shared_award_id<>d.shared_award_id or s.url<>d.source_url or s.title is distinct from d.proposal#>>'{source,title}'
   or s.page_type is distinct from d.proposal#>>'{source,page_type}' or s.admin_review_status<>'review_later' or s.text_monitoring_state<>'{}'::jsonb) then return false;end if;
  return true;
 end if;
 if d.approved_id is null then return false;end if;
 select * into strict a from public.program_text_source_approvals where id=d.approved_id;
 select * into strict s from public.shared_award_sources where id=d.selected_source_id;
 if a.id<>d.pending_id or a.source_id<>s.id or a.epoch<>d.epoch or a.cohort_key<>d.cohort_key or a.shared_award_id<>d.shared_award_id or a.source_url<>d.source_url
  or s.shared_award_id<>d.shared_award_id or s.url<>d.source_url or s.title is distinct from d.proposal#>>'{source,title}' or s.page_type is distinct from d.proposal#>>'{source,page_type}'
  or s.admin_review_status not in('open','review_later') or (s.text_monitoring_state<>'{}'::jsonb and s.text_monitoring_state->>'epoch' is distinct from d.epoch::text)
  or exists(select 1 from public.program_text_source_approval_events e where e.approval_id=a.id and e.action='revoked')
  or exists(select 1 from public.stage1_award_source_identity_rules rule where rule.cohort_key=d.cohort_key and
   ((rule.url_pattern is not null and s.url ~* rule.url_pattern) or (rule.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* rule.title_pattern)))
  or not exists(select 1 from public.stage1_award_members m join public.shared_awards aw on aw.id=m.shared_award_id and aw.status='active' where m.cohort_key=d.cohort_key and m.shared_award_id=d.shared_award_id and m.member_kind='canonical')
 then return false;end if;
 select * into strict authority from public.shared_award_sources where id='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';ref:=d.proposal->'authority_ref';
 if authority.id::text is distinct from ref#>>'{source,id}' or authority.shared_award_id::text is distinct from ref#>>'{source,shared_award_id}' or authority.url is distinct from ref#>>'{source,url}'
  or authority.text_monitoring_state->>'epoch' is distinct from d.epoch::text or authority.text_monitoring_state->>'status' is distinct from 'baseline_ready'
  or not coalesce((authority.text_monitoring_state->>'successful_checks')::bigint>=2,false)
  or authority.text_monitoring_state->'baseline_ref' is distinct from authority.text_monitoring_state->'latest_ref'
  or authority.text_monitoring_state#>>'{latest_ref,text_sha256}' is distinct from ref->>'text_sha256'
  or authority.text_monitoring_state#>>'{latest_ref,final_url}' is distinct from ref->>'final_url'
  or authority.text_monitoring_state#>>'{latest_ref,acquisition}' is distinct from ref->>'acquisition'
  or authority.text_monitoring_state#>'{latest_ref,extractor}' is distinct from ref->'extractor'
  or private.awardping_program_source_allowed(authority.id) is distinct from true then return false;end if;
 for r in select value from jsonb_array_elements(a.role_receipts) loop
  select * into strict role from public.program_text_source_roster where cohort_key=d.cohort_key and source_role=r->>'source_role';
  if role.manifest_status<>'reviewed_text' or not s.id=any(role.source_ids) or not (r->'source_ids')<@to_jsonb(role.source_ids)
   or role.evidence#>array['source_bindings',s.id::text] is distinct from r#>array['evidence','source_bindings',s.id::text] then return false;end if;
 end loop;
 return jsonb_array_length(a.role_receipts) between 1 and 2;
exception when others then return false;
end;
$$;

create function private.awardping_pappg_canonical_known(p_source uuid,p_url text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(p_source='de868fe8-54ba-4fa0-8210-b27c8f182112' or exists(select 1 from private.awardping_pappg_canonical_catalogue() c where c.source_id=p_source)
  or private.awardping_pappg_canonical_url_key(p_url)='https://www.nsf.gov/policies/pappg',false);
$$;

create function private.awardping_pappg_canonical_admission_allowed(p_source uuid,p_cohort text default null,p_epoch uuid default null)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare s public.shared_award_sources%rowtype;d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 if not private.awardping_pappg_canonical_known(s.id,s.url) then return true;end if;
 if s.id<>'de868fe8-54ba-4fa0-8210-b27c8f182112' or (p_cohort is not null and p_cohort<>'nsf_grfp') then return false;end if;
 select * into strict d from public.program_text_pappg_canonical_dispositions where selected_source_id=s.id;
 return coalesce((p_epoch is null or p_epoch=d.epoch) and private.awardping_pappg_canonical_boundary_current(d.pending_id,true),false);
exception when others then return false;
end;
$$;

create function private.awardping_program_text_canonical_url_admission(p_source uuid,p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s public.shared_award_sources%rowtype;d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 if not private.awardping_pappg_canonical_known(s.id,s.url) then return null;end if;
 select * into d from public.program_text_pappg_canonical_dispositions where source_url='https://www.nsf.gov/policies/pappg';
 return jsonb_build_object('schema','awardping.program-text-canonical-url-admission.v1','source_id',s.id,'shared_award_id',s.shared_award_id,'source_url',s.url,
  'cohort_key','nsf_grfp','epoch',p_epoch,'selected_source_id','de868fe8-54ba-4fa0-8210-b27c8f182112','revision',d.revision,'content_hash',d.content_hash,
  'current',private.awardping_pappg_canonical_admission_allowed(s.id,'nsf_grfp',p_epoch));
end;
$$;

create function public.get_program_text_canonical_url_admissions(p_source_ids uuid[],p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare admissions jsonb;
begin
 if p_source_ids is null or cardinality(p_source_ids) not between 1 and 100 or array_position(p_source_ids,null) is not null
  or cardinality(p_source_ids)<>(select count(distinct x) from unnest(p_source_ids) x)
  or not exists(select 1 from public.program_text_source_authority_epochs where epoch=p_epoch and active)
  or (select count(*) from public.shared_award_sources where id=any(p_source_ids))<>cardinality(p_source_ids)
 then raise exception 'Invalid canonical URL admission scope.' using errcode='23514';end if;
 select coalesce(jsonb_agg(dto order by id),'[]'::jsonb) into admissions from
  (select id,private.awardping_program_text_canonical_url_admission(id,p_epoch) dto from public.shared_award_sources where id=any(p_source_ids)) q where dto is not null;
 return jsonb_build_object('schema','awardping.program-text-canonical-url-admission-page.v1','epoch',p_epoch,'source_ids',to_jsonb(p_source_ids),'admissions',admissions);
end;
$$;

-- The existing v1 functions remain byte-for-byte unchanged. Only finite calls dispatch.
create function private.awardping_program_text_canonical_boundary_dispatch(p_source_id uuid,p_cohort text,p_owner uuid,p_url text,p_create boolean)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 if p_source_id<>'de868fe8-54ba-4fa0-8210-b27c8f182112' then
  return private.awardping_program_text_url_alias_boundary(p_source_id,p_cohort,p_owner,p_url,p_create);end if;
 select * into strict d from public.program_text_pappg_canonical_dispositions where selected_source_id=p_source_id;
 if p_create is null or p_cohort is distinct from d.cohort_key or p_owner is distinct from d.shared_award_id or p_url is distinct from d.source_url
  or private.awardping_pappg_canonical_boundary_current(d.pending_id,d.approved_id is not null) is distinct from true
 then raise exception 'Exact finite PAPPG disposition is not current.' using errcode='40001';end if;
 return '[]'::jsonb;
end;
$$;

create function private.awardping_program_text_canonical_boundary_current(p_source uuid,p_cohort text,p_owner uuid,p_url text,p_boundary jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 return p_boundary is not null and private.awardping_program_text_canonical_boundary_dispatch(p_source,p_cohort,p_owner,p_url,false)=p_boundary;
exception when others then return false;
end;
$$;

create function private.awardping_program_text_canonical_proof_hash(p_validation jsonb,p_boundary jsonb)
returns text language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 if p_validation#>>'{proposal,source,id}' is distinct from 'de868fe8-54ba-4fa0-8210-b27c8f182112' then
  return private.awardping_program_text_source_alias_proof_hash(p_validation,p_boundary);end if;
 select * into strict d from public.program_text_pappg_canonical_dispositions where pending_id=(p_validation#>>'{proposal,id}')::uuid;
 if p_boundary is distinct from '[]'::jsonb or d.selected_source_id::text is distinct from p_validation#>>'{proposal,source,id}'
  or (p_validation->>'schema'='awardping.program-text-source-pending-proof.v2' and p_validation->'proposal' is distinct from d.proposal)
  or private.awardping_pappg_canonical_boundary_current(d.pending_id,d.approved_id is not null) is distinct from true
 then raise exception 'Finite PAPPG proof binding changed.' using errcode='40001';end if;
 return encode(extensions.digest(convert_to(jsonb_build_object('schema','awardping.program-text-pappg-canonical-proof.v1',
  'validation',p_validation,'disposition_revision',d.revision,'disposition_hash',d.content_hash)::text,'UTF8'),'sha256'),'hex');
end;
$$;

create function private.awardping_pappg_canonical_prepare_guard(p_proposal jsonb)
returns void language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 if p_proposal#>>'{source,id}' is distinct from 'de868fe8-54ba-4fa0-8210-b27c8f182112' then return;end if;
 select * into strict d from public.program_text_pappg_canonical_dispositions where pending_id=(p_proposal->>'id')::uuid;
 if p_proposal is distinct from d.proposal or d.proposal_hash is distinct from encode(extensions.digest(convert_to(p_proposal::text,'UTF8'),'sha256'),'hex')
  or private.awardping_pappg_canonical_boundary_current(d.pending_id,d.approved_id is not null) is distinct from true
 then raise exception 'Selected PAPPG source requires its exact explicitly reviewed reservation.' using errcode='40001';end if;
end;
$$;

create function public.get_program_text_pappg_canonical_disposition(p_pending_id uuid,p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 if p_pending_id is null or p_epoch is null then raise exception 'Exact disposition identity and epoch required.' using errcode='23514';end if;
 select * into d from public.program_text_pappg_canonical_dispositions where pending_id=p_pending_id;
 if not found then return null;end if;
 return jsonb_build_object('schema','awardping.program-text-pappg-canonical-disposition-record.v1','pending_id',d.pending_id,'epoch',d.epoch,
  'selected_source_id',d.selected_source_id,'source_url',d.source_url,'shared_award_id',d.shared_award_id,'cohort_key',d.cohort_key,
  'revision',d.revision,'content_hash',d.content_hash,'current',p_epoch=d.epoch and private.awardping_pappg_canonical_boundary_current(d.pending_id,d.approved_id is not null),
  'context',d.boundary,'reason',d.reason,'approval_id',d.approved_id);
end;
$$;

-- Finite row-level fence covers INSERT/UPDATE/DELETE, including direct intake.
-- It never blocks legacy foreign status/history changes; live admission then fails closed.
create function private.awardping_pappg_canonical_source_fence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (tg_op<>'INSERT' and private.awardping_pappg_canonical_known(old.id,old.url))
  or (tg_op<>'DELETE' and private.awardping_pappg_canonical_known(new.id,new.url)) then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));end if;
 if tg_op='DELETE' then return old;end if;return new;
end;
$$;
create trigger pappg_canonical_source_fence before insert or update or delete on public.shared_award_sources
for each row execute function private.awardping_pappg_canonical_source_fence();

create function public.prepare_program_text_pappg_canonical(p_proposal jsonb,p_validation jsonb,p_disposition jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare inspection jsonb;context jsonb;rev uuid;h text;ph text;result jsonb;d public.program_text_pappg_canonical_dispositions%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if not private.awardping_program_exact_object(p_disposition,array['schema','context_hash','context','reason'])
  or p_disposition->>'schema' is distinct from 'awardping.program-text-pappg-canonical-disposition.v1'
  or jsonb_typeof(p_disposition->'reason') is distinct from 'string'
  or jsonb_typeof(p_disposition->'context_hash') is distinct from 'string' or p_disposition->>'context_hash' !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_disposition->'context') is distinct from 'object'
  or length(btrim(coalesce(p_disposition->>'reason',''))) not between 20 and 2000
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320
  or p_proposal->>'schema' is distinct from 'awardping.program-text-source-pending-request.v2'
  or p_proposal#>>'{source,id}' is distinct from 'de868fe8-54ba-4fa0-8210-b27c8f182112'
  or p_proposal#>>'{source,shared_award_id}' is distinct from 'd955a846-cee1-4c01-932e-e3cb7215f3fb'
  or p_proposal#>>'{source,url}' is distinct from 'https://www.nsf.gov/policies/pappg'
  or p_proposal#>>'{source,expected_member_kind}' is distinct from 'canonical' or p_proposal#>'{source,create}' is distinct from 'true'::jsonb
  or p_proposal#>>'{registration_scope,kind}' is distinct from 'legacy_roles' or jsonb_array_length(p_proposal->'roles') not between 1 and 2
  or exists(select 1 from jsonb_array_elements(p_proposal->'roles') r where r->>'source_role' not in('application_materials','current_documents'))
  or p_validation->'proposal' is distinct from p_proposal or private.awardping_program_source_pending_valid(p_validation) is distinct from true
 then raise exception 'Exact independently reviewed finite NSF pending proof is required.' using errcode='23514';end if;
 ph:=encode(extensions.digest(convert_to(p_proposal::text,'UTF8'),'sha256'),'hex');
 select * into d from public.program_text_pappg_canonical_dispositions where source_url='https://www.nsf.gov/policies/pappg';
 if found then
  if d.pending_id::text is distinct from p_proposal->>'id' or d.proposal_hash<>ph or d.boundary is distinct from p_disposition->'context'
   or d.reason is distinct from p_disposition->>'reason' or private.awardping_pappg_canonical_boundary_current(d.pending_id,d.approved_id is not null) is distinct from true
  then raise exception 'The finite PAPPG reservation already exists or changed.' using errcode='40001';end if;
  result:=public.get_program_text_source_pending_capture(d.pending_id);
  return result||jsonb_build_object('canonical_disposition',jsonb_build_object('revision',d.revision,'content_hash',d.content_hash));
 end if;
 lock table public.shared_award_sources in share mode nowait;
 lock table public.stage1_award_members in share mode nowait;
 perform 1 from public.stage1_award_registry where cohort_key='nsf_grfp' for share nowait;
 perform 1 from public.program_text_source_authority_epochs where active for share nowait;
 perform 1 from public.shared_awards where id in(select owner_id from private.awardping_pappg_canonical_catalogue() union select 'd955a846-cee1-4c01-932e-e3cb7215f3fb'::uuid) for share nowait;
 inspection:=public.inspect_program_text_pappg_canonical((p_proposal->>'epoch')::uuid);context:=inspection->'context';
 if context is distinct from p_disposition->'context' or inspection->>'context_hash' is distinct from p_disposition->>'context_hash'
  or context->'selected_source' is distinct from 'null'::jsonb or jsonb_array_length(context->'collisions')<>9
  or exists(select 1 from jsonb_array_elements(context->'catalogue') c where c->>'admin_review_status' is distinct from 'review_later'
   or c->'text_monitoring_state' is distinct from '{}'::jsonb or c->>'owner_status' is distinct from 'active' or c->'memberships'<>'[]'::jsonb
   or c#>'{activity,approvals}'<>'[]'::jsonb or c#>'{activity,pending}'<>'[]'::jsonb or c#>'{activity,text_roles}'<>'[]'::jsonb
   or c#>'{activity,legacy_roles}'<>'[]'::jsonb or c#>'{activity,variation_scopes}'<>'[]'::jsonb
   or c#>'{activity,fact_reviews}'<>'[]'::jsonb or c#>'{activity,variation_reviews}'<>'[]'::jsonb or c#>'{activity,monitors}'<>'[]'::jsonb)
 then raise exception 'Fresh complete nine-record disposition boundary changed or is active in current25.' using errcode='40001';end if;
 rev:=gen_random_uuid();h:=encode(extensions.digest(convert_to(jsonb_build_object('schema','awardping.program-text-pappg-canonical-disposition.v1',
  'revision',rev,'pending_id',p_proposal->'id','proposal_hash',ph,'context',context,'reason',p_disposition->'reason')::text,'UTF8'),'sha256'),'hex');
 insert into public.program_text_pappg_canonical_dispositions(source_url,revision,content_hash,selected_source_id,shared_award_id,cohort_key,epoch,pending_id,proposal_hash,proposal,boundary,reason,actor)
 values('https://www.nsf.gov/policies/pappg',rev,h,'de868fe8-54ba-4fa0-8210-b27c8f182112','d955a846-cee1-4c01-932e-e3cb7215f3fb','nsf_grfp',
  (p_proposal->>'epoch')::uuid,(p_proposal->>'id')::uuid,ph,p_proposal,context,p_disposition->>'reason',p_actor);
 result:=public.prepare_program_text_source(p_proposal,p_validation,p_actor);
 return result||jsonb_build_object('canonical_disposition',jsonb_build_object('revision',rev,'content_hash',h));
end;
$$;

-- Revoke PUBLIC defaults for every new helper. Only bounded inspection/reads and
-- the authenticated-admin server wrapper are service-role entry points.
do $acl$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and (p.proname like 'awardping_pappg_canonical_%' or p.proname like 'awardping_program_text_canonical_%'))
   or (n.nspname='public' and p.proname in('inspect_program_text_pappg_canonical','get_program_text_canonical_url_admissions','get_program_text_pappg_canonical_disposition','prepare_program_text_pappg_canonical')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  if f.sig::text not like '%disposition_immutable(%' and f.sig::text not like '%source_fence(%' then execute format('grant execute on function %s to service_role',f.sig);end if;
 end loop;
end $acl$;

do $canonical_v1_invariant$ begin
 if (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') from pg_catalog.pg_proc where oid='private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean)'::regprocedure)
  is distinct from '8963fbde4b07680ed402161713a5ae705963c417a9026fc3eae8cca4594235bb' then raise exception 'Unchanged v1 alias contract changed.' using errcode='40001';end if;
end $canonical_v1_invariant$;

do $canonical_v1_invariant$ begin
 if (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') from pg_catalog.pg_proc where oid='private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  is distinct from '3ce1fbde760edb6e3e34890321871ed873eeba16d64ccfc1ecfbfca638fd56a8' then raise exception 'Unchanged v1 alias contract changed.' using errcode='40001';end if;
end $canonical_v1_invariant$;

do $canonical_v1_invariant$ begin
 if (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') from pg_catalog.pg_proc where oid='private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb)'::regprocedure)
  is distinct from '2f3534abaf9eb254a0e9156ffcda9a1a0aa37b1a947c8126c337c2b9cbfa4f44' then raise exception 'Unchanged v1 alias contract changed.' using errcode='40001';end if;
end $canonical_v1_invariant$;

-- Clean30a exact prosrc preimage private.awardping_program_text_source_access: a56ccca4438d7711fba48f2823d3b6feb50da7d4f11c809ca7a7b02afbc064ad
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='private.awardping_program_text_source_access(uuid,text,uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from 'a56ccca4438d7711fba48f2823d3b6feb50da7d4f11c809ca7a7b02afbc064ad' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
create or replace function private.awardping_program_text_source_access(p_source_id uuid,p_cohort text default null,p_epoch uuid default null)
returns boolean language sql stable security invoker set search_path='' as $$
 select private.awardping_pappg_canonical_admission_allowed(p_source_id,p_cohort,p_epoch) and exists(select 1 from public.shared_award_sources s where s.id=p_source_id and
  (s.admin_review_status='open' and (p_cohort is null or exists(select 1 from public.stage1_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id))
   or exists(select 1 from jsonb_array_elements(private.awardping_program_text_source_approval_dto(s.id)) a
    where (p_cohort is null or a->>'cohort_key'=p_cohort) and a->>'epoch'=coalesce(p_epoch,
      (select epoch from public.program_text_source_authority_epochs where active))::text)));
$$;

-- Clean30a exact prosrc preimage private.awardping_program_source_allowed: dc1a1b621be259f7f54a4f9acfe5197162f66496827d4bcf06cee55944e7aba2
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='private.awardping_program_source_allowed(uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from 'dc1a1b621be259f7f54a4f9acfe5197162f66496827d4bcf06cee55944e7aba2' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
create or replace function private.awardping_program_source_allowed(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select private.awardping_pappg_canonical_admission_allowed(p_source_id) and (exists(select 1 from public.shared_award_sources s join public.shared_awards a on a.id=s.shared_award_id and a.status='active'
 join public.stage1_award_members member on member.shared_award_id=s.shared_award_id
 where s.id=p_source_id and private.awardping_program_text_source_access(s.id,member.cohort_key) and not exists(
 select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=member.cohort_key and
 ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
 and (exists(select 1 from public.program_text_source_roster m where m.cohort_key=member.cohort_key and s.id=any(m.source_ids)
 and not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
  and i.revision=h.revision and i.status='sealed' where h.cohort_key=member.cohort_key)
 and m.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and m.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)
 or exists(select 1 from public.program_variation_inventories i join public.program_variation_scopes v on v.inventory_id=i.id and not v.retired
 cross join lateral jsonb_array_elements(v.source_roles) role where i.status='sealed' and i.cohort_key=member.cohort_key and role->'source_ids' ? s.id::text
 and (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.revision=i.revision and h.cohort_key=i.cohort_key)
 or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
 on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 and role#>>array['evidence','source_bindings',s.id::text,'source_url']=s.url
 and role#>>array['evidence','source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)))
 or private.awardping_program_text_source_registration_allowed(p_source_id));
$$;

-- Clean30a exact prosrc preimage public.prepare_program_text_source: 2c3deee422c83ac638de9649d53ee468ce49c33a63a299df4270077927221fc1
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='public.prepare_program_text_source(jsonb,jsonb,text)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from '2c3deee422c83ac638de9649d53ee468ce49c33a63a299df4270077927221fc1' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
create or replace function public.prepare_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare src jsonb:=p_proposal->'source';s public.shared_award_sources%rowtype;old public.program_text_source_pending_requests%rowtype;
 c jsonb;new_hash text;source_snapshot jsonb;source_id uuid;alias_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform private.awardping_pappg_canonical_prepare_guard(p_proposal);
 if p_validation->'proposal' is distinct from p_proposal or not private.awardping_program_source_pending_valid(p_validation)
  or length(btrim(coalesce(p_actor,''))) not between 1 and 320 then raise exception 'Invalid current pending text-source proof.' using errcode='23514';end if;
 new_hash:=encode(extensions.digest(convert_to(p_validation::text,'UTF8'),'sha256'),'hex');
 select * into old from public.program_text_source_pending_requests where id=(p_proposal->>'id')::uuid;
 if found then
  if old.content_hash<>private.awardping_program_text_canonical_proof_hash(p_validation,old.url_alias_boundary) or old.validation<>p_validation then raise exception 'Pending identity was reused.' using errcode='40001';end if;
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
 alias_boundary:=private.awardping_program_text_canonical_boundary_dispatch(source_id,p_proposal->>'cohort_key',(src->>'shared_award_id')::uuid,src->>'url',(src->>'create')::boolean);
 new_hash:=private.awardping_program_text_canonical_proof_hash(p_validation,alias_boundary);
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

-- Clean30a exact prosrc preimage public.get_program_text_source_pending_capture: 6e971b495758a8b5d7fbbb47b691965e73b420a3f906a2d35a92549d873f3689
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='public.get_program_text_source_pending_capture(uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from '6e971b495758a8b5d7fbbb47b691965e73b420a3f906a2d35a92549d873f3689' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
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
 if not private.awardping_program_text_canonical_boundary_current(s.id,request.cohort_key,s.shared_award_id,s.url,request.url_alias_boundary) then
  raise exception 'Preserved normalized URL alias identities changed.' using errcode='40001';end if;
 if snapshot is distinct from request.source_snapshot then raise exception 'Pending source identity or preserved history changed.' using errcode='40001';end if;
 select * into proof from public.program_text_source_probe_receipts where pending_id=request.id;
 return jsonb_build_object('schema','awardping.program-text-source-pending-capture.v1','id',request.id,'content_hash',request.content_hash,
  'epoch',request.epoch,'source',snapshot,'role_revisions',coalesce((select jsonb_agg(jsonb_build_object('source_role',value->>'source_role','revision',value->>'expected_revision') order by value->>'source_role') from jsonb_array_elements(request.validation#>'{proposal,roles}')),'[]'::jsonb),
  'registration_scope',request.validation#>'{proposal,registration_scope}',
  'proof',case when proof.pending_id is null then 'null'::jsonb else jsonb_build_object('reference',proof.document->'reference','content_hash',proof.content_hash) end);
end;
$$;

-- Clean30a exact prosrc preimage public.approve_program_text_source: 38bc575638016e966692b9d2a3d2d243fcb652b8157a343d5f0500e4bfda5115
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='public.approve_program_text_source(jsonb,jsonb,text)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from '38bc575638016e966692b9d2a3d2d243fcb652b8157a343d5f0500e4bfda5115' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
create or replace function public.approve_program_text_source(p_proposal jsonb,p_validation jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 src jsonb:=p_proposal->'source';link jsonb:=p_validation->'provider_link';doc jsonb;target jsonb;block jsonb;change jsonb;
 raw_anchor boolean:=coalesce(p_proposal->>'schema'='awardping.program-text-source-approval-request.v2',false);
 registry public.stage1_award_registry%rowtype;authority public.shared_award_sources%rowtype;s public.shared_award_sources%rowtype;
 role public.program_text_source_roster%rowtype;prior public.program_text_source_approvals%rowtype;
 pending public.program_text_source_pending_requests%rowtype;probe public.program_text_source_probe_receipts%rowtype;descriptor jsonb;normalized jsonb;
 approval_id uuid;source_id uuid;owner_id uuid;policy_epoch uuid;expected_ids uuid[];next_ids uuid[];sid uuid;
 href text;resolved text;origin text;part text;parts text[]:='{}';source_url text;proof_hash text;
 roles_result jsonb:='[]'::jsonb;bindings jsonb;updated_role jsonb;old_role jsonb;alias_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if not private.awardping_program_exact_object(p_proposal,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','source','authority_ref',case when raw_anchor then 'link_proof' else 'link_block_id' end,'target_ref','roles','registration_scope'])
  or p_proposal->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end)
  or not private.awardping_program_exact_object(src,array['id','shared_award_id','url','title','page_type','create','expected_member_kind','expected_admin_review_status','expected_text_monitoring_state'])
  or not private.awardping_program_exact_object(p_validation,array['schema','proposal','source_text','provider_link'])
  or p_validation->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-proof.v2' else 'awardping.program-text-source-approval-proof.v1' end)
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
 proof_hash:=private.awardping_program_text_canonical_proof_hash(p_validation,coalesce((select request.url_alias_boundary from public.program_text_source_pending_requests request where request.id=approval_id),'[]'::jsonb));
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
 normalized:=(pending.validation->'proposal')||jsonb_build_object('schema',case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end,
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
 if raw_anchor then
  if not private.awardping_program_raw_anchor_provider_link_valid(doc,link,p_proposal) then
   raise exception 'Complete retained raw provider-link proof is invalid.' using errcode='23514';end if;
 else
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
 end if; -- unchanged v1 source_link branch
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
 alias_boundary:=private.awardping_program_text_canonical_boundary_dispatch(source_id,registry.cohort_key,owner_id,source_url,false);
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
 if source_id='de868fe8-54ba-4fa0-8210-b27c8f182112' then
  update public.program_text_pappg_canonical_dispositions set approved_id=approval_id
   where pending_id=approval_id and selected_source_id=source_id and approved_id is null;
  if not found or private.awardping_pappg_canonical_boundary_current(approval_id,true) is distinct from true then
   raise exception 'Final finite PAPPG disposition did not bind its exact current approval.' using errcode='40001';end if;
 end if;
 return jsonb_build_object('id',approval_id,'source_id',source_id,'content_hash',proof_hash,'roles',roles_result,'idempotent',false);
end;
$$;

-- Clean30a exact prosrc preimage private.awardping_program_text_source_approval_dto: aa798ee66b38cab9c2f711ed29c5d1ec9d89cce4f4fed2ff4434f011fac86232
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='private.awardping_program_text_source_approval_dto(uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from 'aa798ee66b38cab9c2f711ed29c5d1ec9d89cce4f4fed2ff4434f011fac86232' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
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
 where private.awardping_pappg_canonical_admission_allowed(s.id,a.cohort_key,a.epoch)
  and s.admin_review_status in ('open','review_later')
  and s.title=a.validation#>>'{proposal,source,title}' and s.page_type=a.validation#>>'{proposal,source,page_type}'
  and (s.text_monitoring_state='{}'::jsonb or s.text_monitoring_state->>'epoch'=a.epoch::text)
  and exists(select 1 from public.stage1_award_members m where m.cohort_key=a.cohort_key and m.shared_award_id=s.shared_award_id)
  and not exists(select 1 from public.program_text_source_approval_events e where e.approval_id=a.id and e.action='revoked')
  and private.awardping_program_text_canonical_boundary_current(a.source_id,a.cohort_key,a.shared_award_id,a.source_url,a.url_alias_boundary)
  and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=a.cohort_key and
   ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)));
$$;

-- Quality-v2 successor exact prosrc preimage public.get_program_text_worker_roster_page: f6376d4980527f58393c96cc42aee8bbe38e8225ff52c4045ef7b9e99e90555a
do $canonical_preimage$ declare actual text;begin
 select prosrc into strict actual from pg_catalog.pg_proc where oid='public.get_program_text_worker_roster_page(text,jsonb,text,integer)'::regprocedure;
 if encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex') is distinct from 'f6376d4980527f58393c96cc42aee8bbe38e8225ff52c4045ef7b9e99e90555a' then
  raise exception 'Canonical PAPPG source workflow preimage changed.' using errcode='40001';end if;
end $canonical_preimage$;
create or replace function public.get_program_text_worker_roster_page(
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
  from (select s.id,jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,
   'page_type',s.page_type,'admin_review_status',s.admin_review_status,'text_monitoring_state',s.text_monitoring_state,
   'text_collection_quality',private.awardping_program_text_collection_quality(s.id),
   'text_source_approvals',private.awardping_program_text_source_approval_dto(s.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(s.id,(select epoch from public.program_text_source_authority_epochs where active))) as entry
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

-- Existing function ownership/ACL is retained by CREATE OR REPLACE. New table remains empty.
notify pgrst,'reload schema';

-- END PAPPG-v2
do $combined_after_pappg$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('private.awardping_program_fact_source_ready(uuid)','fc6f20fad1d8ca97e144c564ebccfc2a28e97fa4c173bbb1117efc02c0203e96'),
  ('private.awardping_program_source_allowed(uuid)','f6085998475c55dc26e78ef6534096c80619957845abbf601904d3210cf436fc'),
  ('private.awardping_program_source_pending_valid(jsonb)','bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e'),
  ('private.awardping_program_text_reference_valid(jsonb)','72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027'),
  ('private.awardping_program_text_source_access(uuid,text,uuid)','70cd411e896ea60b273ada0650f8279c71f15a6711cf8c8f5d4df01aad9610f1'),
  ('private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb)','2f3534abaf9eb254a0e9156ffcda9a1a0aa37b1a947c8126c337c2b9cbfa4f44'),
  ('private.awardping_program_text_source_approval_dto(uuid)','48ac75ccdff0cd64c206183d654d21db53edb566476e58acf37ddc192f28b7a6'),
  ('private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb)','3ce1fbde760edb6e3e34890321871ed873eeba16d64ccfc1ecfbfca638fd56a8'),
  ('private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean)','8963fbde4b07680ed402161713a5ae705963c417a9026fc3eae8cca4594235bb'),
  ('private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)','c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4'),
  ('public.approve_program_text_source(jsonb,jsonb,text)','28f7fe0d9b6a950eae4fc06edc61e198bdedac1d20e6029629a0c54f6d9144e1'),
  ('public.get_program_text_fact_review_batch()','eb3c1f639dd5e1ee72684d254169dde63a45e8a52b56bcb2c4b28e51eb1d5b51'),
  ('public.get_program_text_source_pending_capture(uuid)','d85ff2fb3a6d816e340d1cad6331df42a423f7569520e5eb1f2f1b40559f3aa1'),
  ('public.get_program_text_worker_roster_page(text,jsonb,text,integer)','765e1ffeb17e2492ba70d2469ba651c16b7b14ceb447f3502b37fd05c49da1dc'),
  ('public.prepare_program_text_source(jsonb,jsonb,text)','3c944e5acb117d1856f730f15680f2704b1501297e4516292bcd1eb3d1c5f7c7')
 ) as reviewed(signature,body_hash) loop
  select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual
   from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure;
  if actual is distinct from expected.body_hash then
   raise exception 'Combined composition combined_after_pappg function changed: %',expected.signature using errcode='40001';end if;
 end loop;
end $combined_after_pappg$;

-- BEGIN SMART-twelve composed approval successor
-- PRIVATE PROPOSED ONLY: no ledger name/date and no execution by preparer.
-- ROOT must fresh-read exact prosrc/ACLs, run full BEGIN/ROLLBACK workflows/late
-- atomic failure, and create its actual migration only after acceptance.
-- Functions only. No source/role/capture/baseline/fact/provider data mutation.

do $smart_twelve_preflight$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)','c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4'),
  ('private.awardping_program_source_pending_valid(jsonb)','bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e'),
  ('public.approve_program_text_source(jsonb,jsonb,text)','28f7fe0d9b6a950eae4fc06edc61e198bdedac1d20e6029629a0c54f6d9144e1'),
  ('private.awardping_program_text_reference_valid(jsonb)','72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027')
 ) as reviewed(signature,body_hash) loop
  select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure;
  if actual is distinct from expected.body_hash then raise exception 'SMART twelve preflight function changed; no new helper should be created.' using errcode='40001';end if;
  if exists(select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   where p.oid=expected.signature::regprocedure and a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,'service_role'::regrole))
  then raise exception 'SMART twelve preflight function ACL changed.' using errcode='42501';end if;
 end loop;
end $smart_twelve_preflight$;

create function private.awardping_program_smart_twelve_identity_valid(p_source jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(exists(select 1 from (values
  ('bfd3e15c-3905-4db6-ac2c-e0a5b1637872','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=071d5154db068300b67330ca7c961968','SMART Scholarship Award Details FAQ','requirements'),
  ('b29da726-dc73-4de6-a67b-1f536a58771e','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=33b85cb7db754300b67330ca7c961911','SMART','homepage'),
  ('87111fbf-0b03-43e1-bb6f-0f23359617d7','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=3ee85c60db8a8300ecc734cc7c9619dc','Application Requirements: Academic Background','requirements'),
  ('b4ad8c95-9410-4ceb-9fc4-0e077f34f612','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=5b3bd0e0db8a8300ecc734cc7c961930','Application Requirements: References','requirements'),
  ('e6b62753-2830-420b-b6f3-6af6f6ec704e','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=61a7fa06db1ac3006bb8f4b40f961980','DoW SMART Post Graduate Employment FAQ','requirements'),
  ('f7d55da4-9abb-4024-a423-d930573fb50f','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=78291c60db8a8300ecc734cc7c9619df','Application Requirements: Proposed Award','requirements'),
  ('2f1c3cc1-7309-481c-9c6b-4c5cba1f648f','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=9ddbd6e91bced4906b6a0e9ee54bcb74','Application Requirements: Letter of Support','requirements'),
  ('c3299a3b-f98f-4b65-abe1-c50dba35539d','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=b25b50e0db8a8300ecc734cc7c9619f1','Application Requirements: School Transcripts','requirements'),
  ('32728eb4-99f3-4a2f-a349-d8ab5f73271d','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=c6cd2a0edbd6c3006bb8f4b40f961952','DoW Summer Internship & Mentor FAQ','requirements'),
  ('bbe47dba-a910-4379-ba16-bc634ea4850c','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=cd881c60db8a8300ecc734cc7c96190f','Application Requirements: About Me','requirements'),
  ('a66df6fc-6fab-4e8c-8cdd-19fcd48e6015','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart?id=kb_article&sys_id=fca954a0db8a8300ecc734cc7c961903','Application Requirements: Personal Statement','requirements'),
  ('5f92d7f3-5b5d-41b1-97ec-16aa0e56be8d','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=30d91073dbb54300b67330ca7c96197c','CLEARANCE PROCESS','faq')
 ) as exact_source(id,owner_id,url,title,page_type) where
  p_source->>'id'=exact_source.id and p_source->>'shared_award_id'=exact_source.owner_id
  and p_source->>'url'=exact_source.url and p_source->>'title'=exact_source.title
  and p_source->>'page_type'=exact_source.page_type),false);
$$;
revoke all on function private.awardping_program_smart_twelve_identity_valid(jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_smart_twelve_identity_valid(jsonb) to service_role;

create function private.awardping_program_smart_twelve_body_link_valid(p_doc jsonb,p_link jsonb,p_proposal jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare src jsonb:=p_proposal->'source';r jsonb:=p_doc->'reference';b jsonb;c jsonb;
begin
 if not coalesce(p_proposal->>'cohort_key'='smart' and p_proposal->>'expected_canonical_shared_award_id'='d7d4d117-f312-456f-a75c-3dbd5d372c99' and src->>'expected_member_kind'='canonical' and private.awardping_program_smart_twelve_identity_valid(src),false)
  or private.awardping_program_source_approval_document_valid(p_doc) is distinct from true
  or not private.awardping_program_exact_object(p_link,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])
  or p_proposal->'authority_ref' is distinct from r or r->>'acquisition' is distinct from 'publisher_json'
  or r#>>'{extractor,name}' is distinct from 'smart-publisher-json'
  or p_link->>'source_id' is distinct from r#>>'{source,id}' or p_link->>'capture_id' is distinct from r->>'capture_id'
  or p_link->>'block_id' is distinct from p_proposal->>'link_block_id' or p_link->>'resolved_url' is distinct from src->>'url'
  or not exists(select 1 from (values
  ('203baaf3-2905-4fdf-b4af-af84998195a8','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc','FAQ','faq','smart-publisher-json-kb-v1'),
  ('2562f7c2-4709-4d63-ac25-c4638733a981','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7','How to Submit your SMART Application','application','smart-publisher-json-kb-v1'),
  ('39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956','application instructions','deadline','smart-publisher-json-kb-v1'),
  ('58aefec0-0d42-4b7b-9887-60d25940b3d0','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart','SMART','homepage','smart-publisher-json-v1'),
  ('92eebc07-7392-4136-ba13-d9cd5455c8f9','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart/en','SMART Scholarship Program','homepage','smart-publisher-json-v1'),
  ('c33cc2f4-2cbd-458c-b630-537eb3d50f72','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart/en?id=smart_eligibility','Eligibility','eligibility','smart-publisher-json-v1')
  ) as a(id,owner_id,url,title,page_type,version) where r#>>'{source,id}'=a.id
   and r#>>'{source,shared_award_id}'=a.owner_id and r#>>'{source,url}'=a.url
   and r#>>'{source,title}'=a.title and r#>>'{source,page_type}'=a.page_type
   and r#>>'{extractor,version}'=a.version and r->>'final_url'=a.url)
 then return false;end if;
 select value into strict b from jsonb_array_elements(p_doc->'blocks') where value->>'id'=p_link->>'block_id';
 c:=b->'context';
 if b->>'kind' is distinct from 'source_link' or b->'start_utf16' is distinct from p_link->'start_utf16'
  or b->'end_utf16' is distinct from p_link->'end_utf16' or b->>'text' is distinct from p_link->>'text'
  or c->>'schema' is distinct from 'awardping.smart-publisher-json-projection.v1'
  or c->>'representation' is distinct from 'publisher_attribute' or c->'verbatim' is distinct from 'false'::jsonb
  or c->>'source_attribute' is distinct from 'href' or c->>'source_representation' is distinct from 'publisher_json'
  or c->'base_hrefs' is distinct from '["/smart"]'::jsonb or c->>'base_url' is distinct from 'https://www.smartscholarship.org/smart'
  or c->>'navigation_source_url' is distinct from r#>>'{source,url}' or c->>'resolved_url' is distinct from src->>'url'
  or jsonb_typeof(c->'sources') is distinct from 'array'
  or not exists(select 1 from (values
  ('bfd3e15c-3905-4db6-ac2c-e0a5b1637872','203baaf3-2905-4fdf-b4af-af84998195a8','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=071d5154db068300b67330ca7c961968'),
  ('b29da726-dc73-4de6-a67b-1f536a58771e','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=33b85cb7db754300b67330ca7c961911'),
  ('87111fbf-0b03-43e1-bb6f-0f23359617d7','2562f7c2-4709-4d63-ac25-c4638733a981','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=3ee85c60db8a8300ecc734cc7c9619dc'),
  ('87111fbf-0b03-43e1-bb6f-0f23359617d7','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=3ee85c60db8a8300ecc734cc7c9619dc'),
  ('b4ad8c95-9410-4ceb-9fc4-0e077f34f612','2562f7c2-4709-4d63-ac25-c4638733a981','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=5b3bd0e0db8a8300ecc734cc7c961930'),
  ('b4ad8c95-9410-4ceb-9fc4-0e077f34f612','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=5b3bd0e0db8a8300ecc734cc7c961930'),
  ('e6b62753-2830-420b-b6f3-6af6f6ec704e','203baaf3-2905-4fdf-b4af-af84998195a8','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=61a7fa06db1ac3006bb8f4b40f961980'),
  ('f7d55da4-9abb-4024-a423-d930573fb50f','2562f7c2-4709-4d63-ac25-c4638733a981','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=78291c60db8a8300ecc734cc7c9619df'),
  ('f7d55da4-9abb-4024-a423-d930573fb50f','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=78291c60db8a8300ecc734cc7c9619df'),
  ('2f1c3cc1-7309-481c-9c6b-4c5cba1f648f','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=9ddbd6e91bced4906b6a0e9ee54bcb74'),
  ('c3299a3b-f98f-4b65-abe1-c50dba35539d','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=b25b50e0db8a8300ecc734cc7c9619f1'),
  ('32728eb4-99f3-4a2f-a349-d8ab5f73271d','203baaf3-2905-4fdf-b4af-af84998195a8','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=c6cd2a0edbd6c3006bb8f4b40f961952'),
  ('bbe47dba-a910-4379-ba16-bc634ea4850c','2562f7c2-4709-4d63-ac25-c4638733a981','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=cd881c60db8a8300ecc734cc7c96190f'),
  ('bbe47dba-a910-4379-ba16-bc634ea4850c','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=cd881c60db8a8300ecc734cc7c96190f'),
  ('a66df6fc-6fab-4e8c-8cdd-19fcd48e6015','2562f7c2-4709-4d63-ac25-c4638733a981','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=fca954a0db8a8300ecc734cc7c961903'),
  ('a66df6fc-6fab-4e8c-8cdd-19fcd48e6015','39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','/result/containers/3/rows/0/columns/0/widgets/0/widget/data/text','https://www.smartscholarship.org/smart?id=kb_article&sys_id=fca954a0db8a8300ecc734cc7c961903'),
  ('5f92d7f3-5b5d-41b1-97ec-16aa0e56be8d','c33cc2f4-2cbd-458c-b630-537eb3d50f72','/result/containers/0/rows/0/columns/0/widgets/1/widget/template','/smart/en?id=kb_article&sys_id=30d91073dbb54300b67330ca7c96197c')
  ) as w(target_id,source_id,pointer,href) where w.target_id=src->>'id'
    and w.source_id=r#>>'{source,id}' and w.pointer=c->>'pointer' and w.href=b->>'text')
 then return false;end if;
 -- SQL binds the complete projected document/current ref; normal server has
 -- cold-restored raw JSON and proved the literal programme-body anchor. The
 -- existing eligibility template's actual sources:[] is not fabricated.
 return true;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_program_smart_twelve_body_link_valid(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_program_smart_twelve_body_link_valid(jsonb,jsonb,jsonb) to service_role;

do $smart_twelve_0$
declare body text;definition text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from 'c9782ce356ac5c86295ffd78add78eae6577081f05d2c8c02f9bfd739a6e28a4' then
  raise exception 'Reviewed SMART twelve function preimage changed.' using errcode='40001';end if;
 if (length(definition)-length(replace(definition,body,'')))/length(body)<>1 then raise exception 'Function body replacement is ambiguous.' using errcode='40001';end if;
 execute replace(definition,body,$smart_twelve_body_0$
 select coalesce(p_ref->>'acquisition'='publisher_json'
  and p_ref#>>'{source,shared_award_id}'='d7d4d117-f312-456f-a75c-3dbd5d372c99'
  and p_ref#>>'{extractor,name}'='smart-publisher-json'
  and p_ref#>>'{extractor,version}'='smart-publisher-json-v1'
  and p_ref->>'final_url'=p_ref#>>'{source,url}'
  and ((p_ref#>>'{source,id}'='58aefec0-0d42-4b7b-9887-60d25940b3d0'
    and p_ref#>>'{source,url}'='https://www.smartscholarship.org/smart'
    and p_ref#>>'{source,page_type}'='homepage')
   or (p_ref#>>'{source,id}'='c33cc2f4-2cbd-458c-b630-537eb3d50f72'
    and p_ref#>>'{source,url}'='https://www.smartscholarship.org/smart/en?id=smart_eligibility'
    and p_ref#>>'{source,page_type}'='eligibility'))
  or (p_ref->>'acquisition'='publisher_json'
   and p_ref#>>'{extractor,name}'='smart-publisher-json'
   and p_ref->>'final_url'=p_ref#>>'{source,url}'
   and exists(select 1 from (values
   ('203baaf3-2905-4fdf-b4af-af84998195a8','d7d4d117-f312-456f-a75c-3dbd5d372c99','https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc','faq','smart-publisher-json-kb-v1'),
   ('2562f7c2-4709-4d63-ac25-c4638733a981','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7','application','smart-publisher-json-kb-v1'),
   ('39685b8a-3ad9-41c5-834b-b2aaafb2b0e5','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956','deadline','smart-publisher-json-kb-v1'),
   ('92eebc07-7392-4136-ba13-d9cd5455c8f9','1efa2a75-e6b8-4bf6-80be-85ef2f6b3108','https://www.smartscholarship.org/smart/en','homepage','smart-publisher-json-v1')
   ) as reviewed(id,owner_id,url,page_type,version)
   where p_ref#>>'{source,id}'=reviewed.id
    and p_ref#>>'{source,shared_award_id}'=reviewed.owner_id
    and p_ref#>>'{source,url}'=reviewed.url
    and p_ref#>>'{source,page_type}'=reviewed.page_type
    and p_ref#>>'{extractor,version}'=reviewed.version))
  or (p_ref->>'acquisition'='publisher_json' and p_ref#>>'{extractor,name}'='smart-publisher-json'
   and p_ref#>>'{extractor,version}'='smart-publisher-json-kb-v1' and p_ref->>'final_url'=p_ref#>>'{source,url}'
   and private.awardping_program_smart_twelve_identity_valid(p_ref->'source')),false);
$smart_twelve_body_0$);
end $smart_twelve_0$;

do $smart_twelve_1$
declare body text;definition text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='private.awardping_program_source_pending_valid(jsonb)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from 'bb77bdbde62ef0921512c04d7527d387ea29518f59e6d9d8d4db4e75f98ec48e' then
  raise exception 'Reviewed SMART twelve function preimage changed.' using errcode='40001';end if;
 if (length(definition)-length(replace(definition,body,'')))/length(body)<>1 then raise exception 'Function body replacement is ambiguous.' using errcode='40001';end if;
 execute replace(definition,body,$smart_twelve_body_1$
declare p jsonb:=p_validation->'proposal';src jsonb:=p->'source';d jsonb:=p_validation#>'{source_text,0}';l jsonb:=p_validation->'provider_link';
 raw_anchor boolean:=coalesce(p_validation->>'schema'='awardping.program-text-source-pending-proof.v2',false);
 r public.stage1_award_registry%rowtype;a public.shared_award_sources%rowtype;m public.program_text_source_roster%rowtype;
 b jsonb;c jsonb;expected_ids uuid[];next_ids uuid[];epoch_id uuid;href text;origin text;resolved text;part text;parts text[]:='{}';sid uuid;
begin
 if not private.awardping_program_exact_object(p_validation,array['schema','proposal','source_text','provider_link'])
  or p_validation->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-pending-proof.v2' else 'awardping.program-text-source-pending-proof.v1' end)
  or not private.awardping_program_exact_object(p,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','source','authority_ref',case when raw_anchor then 'link_proof' else 'link_block_id' end,'roles','registration_scope'])
  or p->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-pending-request.v2' else 'awardping.program-text-source-pending-request.v1' end)
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
   and not coalesce(src->>'page_type'='pdf' and private.awardping_program_public_drive_pdf_identity(src->>'url') is not null,false)
   and not coalesce(p->>'cohort_key'='smart' and p->>'expected_canonical_shared_award_id'='d7d4d117-f312-456f-a75c-3dbd5d372c99' and src->>'expected_member_kind'='canonical' and private.awardping_program_smart_twelve_identity_valid(src),false))
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
 then return false;end if;
 if raw_anchor then
  if not private.awardping_program_raw_anchor_provider_link_valid(d,l,p) then return false;end if;
 elsif coalesce(p->>'cohort_key'='smart' and p->>'expected_canonical_shared_award_id'='d7d4d117-f312-456f-a75c-3dbd5d372c99' and src->>'expected_member_kind'='canonical' and private.awardping_program_smart_twelve_identity_valid(src),false) then
  if a.title is distinct from d#>>'{reference,source,title}' or a.page_type::text is distinct from d#>>'{reference,source,page_type}'
   or private.awardping_program_smart_twelve_body_link_valid(d,l,p) is distinct from true then return false;end if;
 else
 if not private.awardping_program_exact_object(l,array['source_id','capture_id','block_id','start_utf16','end_utf16','text','resolved_url'])
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
 end if; -- unchanged v1 source_link branch
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
$smart_twelve_body_1$);
end $smart_twelve_1$;

do $smart_twelve_2$
declare body text;definition text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='public.approve_program_text_source(jsonb,jsonb,text)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from '28f7fe0d9b6a950eae4fc06edc61e198bdedac1d20e6029629a0c54f6d9144e1' then
  raise exception 'Reviewed SMART twelve function preimage changed.' using errcode='40001';end if;
 if (length(definition)-length(replace(definition,body,'')))/length(body)<>1 then raise exception 'Function body replacement is ambiguous.' using errcode='40001';end if;
 execute replace(definition,body,$smart_twelve_body_2$
declare
 src jsonb:=p_proposal->'source';link jsonb:=p_validation->'provider_link';doc jsonb;target jsonb;block jsonb;change jsonb;
 raw_anchor boolean:=coalesce(p_proposal->>'schema'='awardping.program-text-source-approval-request.v2',false);
 registry public.stage1_award_registry%rowtype;authority public.shared_award_sources%rowtype;s public.shared_award_sources%rowtype;
 role public.program_text_source_roster%rowtype;prior public.program_text_source_approvals%rowtype;
 pending public.program_text_source_pending_requests%rowtype;probe public.program_text_source_probe_receipts%rowtype;descriptor jsonb;normalized jsonb;
 approval_id uuid;source_id uuid;owner_id uuid;policy_epoch uuid;expected_ids uuid[];next_ids uuid[];sid uuid;
 href text;resolved text;origin text;part text;parts text[]:='{}';source_url text;proof_hash text;
 roles_result jsonb:='[]'::jsonb;bindings jsonb;updated_role jsonb;old_role jsonb;alias_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if not private.awardping_program_exact_object(p_proposal,array['schema','id','cohort_key','epoch','expected_canonical_shared_award_id','source','authority_ref',case when raw_anchor then 'link_proof' else 'link_block_id' end,'target_ref','roles','registration_scope'])
  or p_proposal->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end)
  or not private.awardping_program_exact_object(src,array['id','shared_award_id','url','title','page_type','create','expected_member_kind','expected_admin_review_status','expected_text_monitoring_state'])
  or not private.awardping_program_exact_object(p_validation,array['schema','proposal','source_text','provider_link'])
  or p_validation->>'schema' is distinct from (case when raw_anchor then 'awardping.program-text-source-approval-proof.v2' else 'awardping.program-text-source-approval-proof.v1' end)
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
   and not coalesce(src->>'page_type'='pdf' and private.awardping_program_public_drive_pdf_identity(source_url) is not null,false)
   and not coalesce(p_proposal->>'cohort_key'='smart' and p_proposal->>'expected_canonical_shared_award_id'='d7d4d117-f312-456f-a75c-3dbd5d372c99' and src->>'expected_member_kind'='canonical' and private.awardping_program_smart_twelve_identity_valid(src),false))
 then raise exception 'The current text epoch or exact public source URL changed.' using errcode='23514'; end if;
 proof_hash:=private.awardping_program_text_canonical_proof_hash(p_validation,coalesce((select request.url_alias_boundary from public.program_text_source_pending_requests request where request.id=approval_id),'[]'::jsonb));
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
 normalized:=(pending.validation->'proposal')||jsonb_build_object('schema',case when raw_anchor then 'awardping.program-text-source-approval-request.v2' else 'awardping.program-text-source-approval-request.v1' end,
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
 if raw_anchor then
  if not private.awardping_program_raw_anchor_provider_link_valid(doc,link,p_proposal) then
   raise exception 'Complete retained raw provider-link proof is invalid.' using errcode='23514';end if;
 elsif coalesce(p_proposal->>'cohort_key'='smart' and p_proposal->>'expected_canonical_shared_award_id'='d7d4d117-f312-456f-a75c-3dbd5d372c99' and src->>'expected_member_kind'='canonical' and private.awardping_program_smart_twelve_identity_valid(src),false) then
  if authority.title is distinct from doc#>>'{reference,source,title}' or authority.page_type::text is distinct from doc#>>'{reference,source,page_type}'
   or private.awardping_program_smart_twelve_body_link_valid(doc,link,p_proposal) is distinct from true then
   raise exception 'The finite SMART programme-body proof is unavailable.' using errcode='23514';end if;
 else
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
 end if; -- unchanged v1 source_link branch
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
 alias_boundary:=private.awardping_program_text_canonical_boundary_dispatch(source_id,registry.cohort_key,owner_id,source_url,false);
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
 if source_id='de868fe8-54ba-4fa0-8210-b27c8f182112' then
  update public.program_text_pappg_canonical_dispositions set approved_id=approval_id
   where pending_id=approval_id and selected_source_id=source_id and approved_id is null;
  if not found or private.awardping_pappg_canonical_boundary_current(approval_id,true) is distinct from true then
   raise exception 'Final finite PAPPG disposition did not bind its exact current approval.' using errcode='40001';end if;
 end if;
 return jsonb_build_object('id',approval_id,'source_id',source_id,'content_hash',proof_hash,'roles',roles_result,'idempotent',false);
end;
$smart_twelve_body_2$);
end $smart_twelve_2$;

do $smart_twelve_3$
declare body text;definition text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select p.prosrc,pg_catalog.pg_get_functiondef(p.oid) into strict body,definition from pg_catalog.pg_proc p where p.oid='private.awardping_program_text_reference_valid(jsonb)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from '72f406cdadedccd8f7c9c75036637df0bd1b0bebca4ee928fcfca1ac8fc9b027' then
  raise exception 'Reviewed SMART twelve function preimage changed.' using errcode='40001';end if;
 if (length(definition)-length(replace(definition,body,'')))/length(body)<>1 then raise exception 'Function body replacement is ambiguous.' using errcode='40001';end if;
 execute replace(definition,body,$smart_twelve_body_3$
declare v_artifact jsonb; v_role text; v_name text; v_prefix text; v_at timestamptz;
 v_pdf boolean; v_json boolean; v_limit integer;
begin
 if p_ref#>>'{source,id}' in ('bfd3e15c-3905-4db6-ac2c-e0a5b1637872','b29da726-dc73-4de6-a67b-1f536a58771e','87111fbf-0b03-43e1-bb6f-0f23359617d7','b4ad8c95-9410-4ceb-9fc4-0e077f34f612','e6b62753-2830-420b-b6f3-6af6f6ec704e','f7d55da4-9abb-4024-a423-d930573fb50f','2f1c3cc1-7309-481c-9c6b-4c5cba1f648f','c3299a3b-f98f-4b65-abe1-c50dba35539d','32728eb4-99f3-4a2f-a349-d8ab5f73271d','bbe47dba-a910-4379-ba16-bc634ea4850c','a66df6fc-6fab-4e8c-8cdd-19fcd48e6015','5f92d7f3-5b5d-41b1-97ec-16aa0e56be8d')
  and (p_ref->>'acquisition' is distinct from 'publisher_json' or private.awardping_smart_publisher_json_reference_metadata_valid(p_ref) is distinct from true)
 then return false;end if;
 if (p_ref->>'acquisition'='publisher_json' or p_ref#>>'{extractor,name}'='smart-publisher-json' or p_ref#>>'{extractor,version}' in ('smart-publisher-json-v1','smart-publisher-json-kb-v1'))
  and not private.awardping_smart_publisher_json_reference_metadata_valid(p_ref) then return false;end if;
 if p_ref#>>'{extractor,version}'='2.4.5/program-text-v1/public-drive-pdf-v1'
  and not private.awardping_program_public_drive_pdf_metadata_valid(p_ref) then return false;end if;
 if not private.awardping_program_exact_object(p_ref,array['schema','kind','capture_id','source','final_url',
   'captured_at','acquisition','extractor','text_sha256','text_length','blocks_sha256','completeness','artifacts'])
   or not coalesce(
     p_ref->>'schema'='awardping.program-text-reference.v1' and p_ref->>'kind'='program_text'
     and jsonb_typeof(p_ref->'capture_id')='string' and p_ref->>'capture_id' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'source')='object'
     and (p_ref->'source') ?& array['id','shared_award_id','url']
     and (p_ref->'source')-array['id','shared_award_id','url','title','page_type']='{}'::jsonb
     and p_ref#>>'{source,id}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     and p_ref#>>'{source,shared_award_id}' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     and jsonb_typeof(p_ref#>'{source,url}')='string' and p_ref#>>'{source,url}' ~ '^https?://[^[:space:]]+$'
     and jsonb_typeof(p_ref->'final_url')='string' and p_ref->>'final_url' ~ '^https?://[^[:space:]]+$'
     and jsonb_typeof(p_ref->'captured_at')='string'
     and p_ref->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     and jsonb_typeof(p_ref->'text_sha256')='string' and p_ref->>'text_sha256' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'blocks_sha256')='string' and p_ref->>'blocks_sha256' ~ '^[0-9a-f]{64}$'
     and jsonb_typeof(p_ref->'text_length')='number' and p_ref->>'text_length' ~ '^[1-9][0-9]*$'
     and (p_ref->>'text_length')::numeric between 1 and 1000000
     and p_ref->>'acquisition' in ('http_html','rendered_html','pdf_text','pdf_ocr','publisher_json')
   ,false) then return false; end if;
 if not private.awardping_program_exact_object(p_ref->'extractor',array['name','version'])
   or not coalesce(jsonb_typeof(p_ref#>'{extractor,name}')='string'
     and length(btrim(p_ref#>>'{extractor,name}')) between 1 and 160
     and jsonb_typeof(p_ref#>'{extractor,version}')='string'
     and length(btrim(p_ref#>>'{extractor,version}')) between 1 and 160,false)
   or not private.awardping_program_exact_object(p_ref->'completeness',array['status','reasons'])
   or p_ref#>>'{completeness,status}' is distinct from 'complete'
   or p_ref#>'{completeness,reasons}' is distinct from '[]'::jsonb
   or not private.awardping_program_exact_object(p_ref->'artifacts',array['raw','text','metadata'])
 then return false; end if;
 v_at:=(p_ref->>'captured_at')::timestamptz;
 if to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from p_ref->>'captured_at'
 then return false; end if;
 v_pdf:=p_ref->>'acquisition' in ('pdf_text','pdf_ocr');
 v_json:=p_ref->>'acquisition'='publisher_json';
 v_prefix:='program-text/sources/'||(p_ref#>>'{source,id}')||'/'||(p_ref->>'capture_id')||'/';
 foreach v_role in array array['raw','text','metadata'] loop
   v_artifact:=p_ref->'artifacts'->v_role;
   v_name:=case when v_role='metadata' then 'metadata.json' when v_role='text' then 'text.txt'
     when v_pdf then 'original.pdf' when v_json then 'original.json' else 'original.html' end;
   v_limit:=case when v_role='raw' and v_json then 524288 when v_role='raw' and v_pdf then 20971520 when v_role='raw' then 5242880
     when v_role='text' then 8388608 else 33554432 end;
   if not private.awardping_program_exact_object(v_artifact,array['object_key','sha256','byte_length','content_type'])
     or not coalesce(v_artifact->>'object_key'=v_prefix||v_name
       and jsonb_typeof(v_artifact->'sha256')='string' and v_artifact->>'sha256' ~ '^[0-9a-f]{64}$'
       and jsonb_typeof(v_artifact->'byte_length')='number'
       and v_artifact->>'byte_length' ~ '^[1-9][0-9]*$'
       and (v_artifact->>'byte_length')::numeric between 1 and v_limit
       and jsonb_typeof(v_artifact->'content_type')='string',false)
   then return false; end if;
   if v_role='text' and (v_artifact->>'content_type' is distinct from 'text/plain; charset=utf-8'
       or v_artifact->>'sha256' is distinct from p_ref->>'text_sha256'
       or (v_artifact->>'byte_length')::numeric < (p_ref->>'text_length')::numeric
       or (v_artifact->>'byte_length')::numeric > 3*(p_ref->>'text_length')::numeric)
     or v_role='metadata' and v_artifact->>'content_type' is distinct from 'application/json'
     or v_role='raw' and not coalesce(case when v_json then v_artifact->>'content_type'='application/json' when v_pdf then (v_artifact->>'content_type' ~* '^application/pdf(;|$)'
       or private.awardping_program_public_drive_pdf_metadata_valid(p_ref) and v_artifact->>'content_type' ~* '^application/octet-stream(;|$)')
       else v_artifact->>'content_type' ~* '^(text/html|application/xhtml[+]xml)(;|$)' end,false)
   then return false; end if;
 end loop;
 return true;
exception when others then return false;
end;
$smart_twelve_body_3$);
end $smart_twelve_3$;

-- END SMART-twelve
do $combined_after_smart$
declare expected record;actual text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 for expected in select * from (values
  ('private.awardping_guard_program_text_collection_failure()','4c4afefd555cdf9ce4bee98c18dc62deaa5a00d6d322aca139f4c68c50749dc3'),
  ('private.awardping_program_fact_source_ready(uuid)','fc6f20fad1d8ca97e144c564ebccfc2a28e97fa4c173bbb1117efc02c0203e96'),
  ('private.awardping_program_source_allowed(uuid)','f6085998475c55dc26e78ef6534096c80619957845abbf601904d3210cf436fc'),
  ('private.awardping_program_source_pending_valid(jsonb)','4aac1b764f4c2e233b2a4a2e8b3d8d25080287ed34d2e4c45edd448990eeb187'),
  ('private.awardping_program_text_reference_valid(jsonb)','c28403ba7a4424c89442bcb59f70081240b60dceca6b7a250928e6a5dbd40a30'),
  ('private.awardping_program_text_source_access(uuid,text,uuid)','70cd411e896ea60b273ada0650f8279c71f15a6711cf8c8f5d4df01aad9610f1'),
  ('private.awardping_program_text_source_alias_proof_hash(jsonb,jsonb)','2f3534abaf9eb254a0e9156ffcda9a1a0aa37b1a947c8126c337c2b9cbfa4f44'),
  ('private.awardping_program_text_source_approval_dto(uuid)','48ac75ccdff0cd64c206183d654d21db53edb566476e58acf37ddc192f28b7a6'),
  ('private.awardping_program_text_url_alias_boundary_current(uuid,text,uuid,text,jsonb)','3ce1fbde760edb6e3e34890321871ed873eeba16d64ccfc1ecfbfca638fd56a8'),
  ('private.awardping_program_text_url_alias_boundary(uuid,text,uuid,text,boolean)','8963fbde4b07680ed402161713a5ae705963c417a9026fc3eae8cca4594235bb'),
  ('private.awardping_smart_publisher_json_reference_metadata_valid(jsonb)','0d28be32cc4e1320f163a951da9fe42771c53651a7e6679c6b78c949f7fcd4b1'),
  ('public.approve_program_text_source(jsonb,jsonb,text)','29dcb4f0beaf19d7485e5f7417126c44c664556f51af0b99fdbcfcc06bdf78c0'),
  ('public.get_program_text_fact_review_batch()','eb3c1f639dd5e1ee72684d254169dde63a45e8a52b56bcb2c4b28e51eb1d5b51'),
  ('public.get_program_text_source_pending_capture(uuid)','d85ff2fb3a6d816e340d1cad6331df42a423f7569520e5eb1f2f1b40559f3aa1'),
  ('public.get_program_text_worker_roster_page(text,jsonb,text,integer)','765e1ffeb17e2492ba70d2469ba651c16b7b14ceb447f3502b37fd05c49da1dc'),
  ('public.prepare_program_text_source(jsonb,jsonb,text)','3c944e5acb117d1856f730f15680f2704b1501297e4516292bcd1eb3d1c5f7c7')
 ) as reviewed(signature,body_hash) loop
  select encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex') into strict actual
   from pg_catalog.pg_proc p where p.oid=expected.signature::regprocedure;
  if actual is distinct from expected.body_hash then
   raise exception 'Combined composition combined_after_smart function changed: %',expected.signature using errcode='40001';end if;
 end loop;
end $combined_after_smart$;
