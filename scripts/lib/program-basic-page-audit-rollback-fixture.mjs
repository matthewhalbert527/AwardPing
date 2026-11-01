/** Native rehearsal only. Caller supplies the reviewed migration verbatim.
 * Every journal/schema write is enclosed by an unconditional transaction rollback.
 */
export function programBasicPageAuditRollbackFixture(migration) {
  if (typeof migration !== "string" || !migration.includes("create table private.program_basic_page_audit_observations") ||
      /\b(?:begin|commit|rollback)\s*;/i.test(migration)) throw Error("Exact additive audit migration without transaction control required.");
  return `begin isolation level repeatable read;
set local statement_timeout='90s';
create temporary table basic_audit_fixture_before as select
 public.stage1_publication_evidence_hash((select jsonb_agg(to_jsonb(h) order by cohort_key) from public.program_basic_fact_heads h)) heads,
 public.stage1_publication_evidence_hash((select jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,
  'state',s.text_monitoring_state,'quality',s.text_collection_quality) order by s.id) from public.shared_award_sources s)) sources,
 (select count(*) from public.program_basic_fact_snapshots) snapshots,
 (select count(*) from public.program_text_alert_reviews) alerts,
 (select count(*) from public.shared_award_change_events) events;
${migration}
do $fixture$
declare award uuid;context jsonb;basis jsonb;result jsonb;first jsonb;second jsonb;blocked boolean;roster jsonb;
 field_total integer;value_total integer;capture_total integer;
begin
 select canonical_shared_award_id into strict award from public.program_award_registry order by (canonical_slug like '%rhodes%') desc,launch_rank limit 1;
 context:=public.inspect_program_basic_page_audit(award);basis:=context->'basis';
 if context->>'schema'<>'awardping.program-basic-page-audit-context.v1' or basis#>>'{award,id}'<>award::text
  or jsonb_array_length(basis->'published')<>1 or basis#>>'{snapshot,id}' is null then raise exception 'Actual getter context malformed';end if;
 roster:=public.list_program_basic_page_audit_awards(25,null);
 if jsonb_array_length(roster->'registered_award_ids')<>(select count(*) from public.program_award_registry)
  or jsonb_array_length(roster->'awards')<>least(25,(select count(*) from public.program_award_registry r join public.shared_awards a on a.id=r.canonical_shared_award_id where a.status='active'))
 then raise exception 'Bounded modern roster incomplete';end if;
 result:=jsonb_build_object('schema','awardping.program-basic-page-audit-result.v1','award_id',award,'cohort_key',basis->'cohort_key',
  'snapshot_id',basis#>'{snapshot,id}','evaluation_revision',context->'revision','evaluated_at',context->'selected_at',
  'audit_status','failed','severity','error','findings',jsonb_build_array(jsonb_build_object('code','rollback_fixture')),
  'field_count',0,'value_count',0,'capture_count',0,'applied_to_public',false,'observation_only',true);
 first:=public.record_program_basic_page_audit(award,context->>'revision',result);
 second:=public.record_program_basic_page_audit(award,context->>'revision',result||jsonb_build_object('evaluated_at',context->'selected_at'));
 if first->>'inserted'<>'true' or second->>'inserted'<>'false' or first->>'audit_id'<>second->>'audit_id'
  or (select check_count from private.program_basic_page_audit_observations where id=(first->>'audit_id')::uuid)<>2
 then raise exception 'Observation deduplication failed';end if;
 blocked:=false;begin
  perform public.record_program_basic_page_audit(award,repeat('0',64),result);
 exception when serialization_failure then blocked:=true;end;
 if not blocked then raise exception 'Stale CAS revision accepted';end if;
 blocked:=false;begin
  perform public.record_program_basic_page_audit(award,context->>'revision',jsonb_set(result,'{observation_only}','false'));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'Publication mutation flag accepted';end if;
 blocked:=false;begin
  perform public.record_program_basic_page_audit(award,context->>'revision',jsonb_set(result,'{field_count}','"1"'));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'String counter accepted';end if;
 blocked:=false;begin
  perform public.record_program_basic_page_audit(award,context->>'revision',jsonb_set(result,'{snapshot_id}',to_jsonb(award)));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'Changed snapshot pointer accepted';end if;
 blocked:=false;begin
  perform public.record_program_basic_page_audit(award,context->>'revision',jsonb_set(result,'{evaluated_at}',to_jsonb('2000-01-01T00:00:00.000Z'::text)));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'Expired observation accepted';end if;
 if basis#>'{published,0,current}'='true'::jsonb then
  field_total:=jsonb_array_length(basis#>'{snapshot,receipt,selected_fields}');
  select sum(jsonb_array_length(f->'items')) into value_total from jsonb_array_elements(basis#>'{draft,review,fields}') f
   where basis#>'{snapshot,receipt,selected_fields}' ? (f->>'field');
  capture_total:=jsonb_array_length(basis#>'{snapshot,receipt,supporting_capture_refs}');
  result:=result||jsonb_build_object('audit_status','passed','severity','none','findings','[]'::jsonb,
   'field_count',field_total,'value_count',value_total,'capture_count',capture_total);
  perform public.record_program_basic_page_audit(award,context->>'revision',result);
 end if;
 if has_function_privilege('anon','public.inspect_program_basic_page_audit(uuid)','EXECUTE')
  or has_function_privilege('authenticated','public.list_program_basic_page_audit_awards(integer,text[])','EXECUTE')
  or has_function_privilege('authenticated','public.record_program_basic_page_audit(uuid,text,jsonb)','EXECUTE')
  or has_table_privilege('anon','private.program_basic_page_audit_observations','SELECT')
  or has_table_privilege('service_role','private.program_basic_page_audit_observations','INSERT')
  or not has_function_privilege('service_role','public.record_program_basic_page_audit(uuid,text,jsonb)','EXECUTE')
 then raise exception 'Audit service boundary changed';end if;
 if exists(select 1 from basic_audit_fixture_before b where
  b.heads is distinct from public.stage1_publication_evidence_hash((select jsonb_agg(to_jsonb(h) order by cohort_key) from public.program_basic_fact_heads h))
  or b.sources is distinct from public.stage1_publication_evidence_hash((select jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,
   'state',s.text_monitoring_state,'quality',s.text_collection_quality) order by s.id) from public.shared_award_sources s))
  or b.snapshots<>(select count(*) from public.program_basic_fact_snapshots)
  or b.alerts<>(select count(*) from public.program_text_alert_reviews)
  or b.events<>(select count(*) from public.shared_award_change_events))
 then raise exception 'Audit changed public facts, sources, alerts or events';end if;
end;$fixture$;
select jsonb_build_object('ok',true,'observation_only',true,'registry_count',(select count(*) from public.program_award_registry),
 'observations',(select count(*) from private.program_basic_page_audit_observations)) fixture_result,
 public.inspect_program_basic_page_audit((select canonical_shared_award_id from public.program_award_registry order by (canonical_slug like '%rhodes%') desc,launch_rank limit 1)) audit_context;
rollback;
`;
}
