-- Separate DAAD889 retained technical-probe dispatcher. Append after its
-- ledger/helpers. Actual applied first-feature function definitions are pinned;
-- reviewed-no-change and byte-repeat branches retain their original statements.
-- No transaction wrapper, source writes or migration-history operation here.

do $technical_dispatch_proofs$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_proofs_valid(jsonb,jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'f4a67c8284665ef8734373e584f385ee888ce19ca92eba2520d361fbe8c74896' then
  raise exception 'Technical-probe dispatcher preimage changed: proofs.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_proofs_0_before$  if p ? 'kind' then$technical_proofs_0_before$,$technical_proofs_0_after$  if p->>'kind'='retained_technical_repeat' then
   if p->>'provenance_kind' is distinct from 'post_change_technical_probe'
    or p->>'source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd'
    or v_review->>'cohort_key' is distinct from 'daad_study'
    or not coalesce(private.awardping_technical_repeat_proof_valid(v_review,p,r,null),false) then return false;end if;
   continue;
  end if;
  if p ? 'kind' then$technical_proofs_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'7e7fae5bb65720ba2ef469f99c35036877870b517efee5c0fdd1dc0e5d7c8d0d' then
  raise exception 'Technical-probe dispatcher replacement differs: proofs.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_proofs$;

do $technical_dispatch_context$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.inspect_current_program_basic_award(text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'89043af512a1103dd6c4e2e5ce2f974ab096240419a8e354b189ba8c9cd4cd3f' then
  raise exception 'Technical-probe dispatcher preimage changed: context.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_context_0_before$observations jsonb;reviewed_observations jsonb;$technical_context_0_before$,$technical_context_0_after$observations jsonb;reviewed_observations jsonb;technical_observations jsonb;$technical_context_0_after$);
 v_after:=replace(v_after,$technical_context_1_before$ return jsonb_build_object('schema','awardping.current-basic-award-context.v1'$technical_context_1_before$,$technical_context_1_after$ select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'kind',o.kind,'provenance_kind',o.provenance_kind,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'expected_head',o.expected_head,
  'causal_candidate_id',o.causal_candidate_id,'causal_candidate_hash',o.causal_candidate_hash,
  'owner_review_id',o.owner_review_id,'owner_review_hash',o.owner_review_hash,
  'causal_previous_ref',o.causal_previous_ref,'current_ref',o.current_ref,'probe_ref',o.probe_ref,
  'support_hash',o.support_hash,'content_hash',o.content_hash,'verified_at',o.verified_at,'actor',o.actor,
  'causal_candidate',o.validation->'causal_candidate','owner_review',o.validation->'owner_review',
  'published_event',o.validation->'published_event','published_evidence',o.validation->'published_evidence',
  'paid_reservation',o.validation->'paid_reservation','technical_comparison',o.validation->'technical_comparison',
  'rules',o.validation->'rules','widget_proofs',o.validation->'widget_proofs','support_projection',o.validation->'support_projection') order by o.created_at desc,o.id),'[]'::jsonb)
 into technical_observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_technical_repeat_observations z
  where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id and z.expected_head is not distinct from head
   and z.kind='retained_technical_repeat' and z.provenance_kind='post_change_technical_probe'
   and z.current_ref=x.text_monitoring_state->'latest_ref' and private.awardping_technical_repeat_row_current(z.id)
  order by z.created_at desc,z.id limit 2
 ) limited where p_cohort_key='daad_study' and x.id=any(ids) and x.id='88906939-65e7-492d-a671-da56678dfecd'::uuid) o;
 return jsonb_build_object('schema','awardping.current-basic-award-context.v1'$technical_context_1_after$);
 v_after:=replace(v_after,$technical_context_2_before$'reviewed_repeat_observations',reviewed_observations))$technical_context_2_before$,$technical_context_2_after$'reviewed_repeat_observations',reviewed_observations,'technical_repeat_observations',technical_observations))$technical_context_2_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'1b54a499a9bcbb8c9698c5991d68d4beef4979193c4384494c1caa9da362e1c4' then
  raise exception 'Technical-probe dispatcher replacement differs: context.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_context$;

do $technical_dispatch_commit$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'6bd79591ad413ae6875414fa32d49ccecc85b0ee031591b29a1d138d3e947d31' then
  raise exception 'Technical-probe dispatcher preimage changed: commit.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_commit_0_before$ or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$technical_commit_0_before$,$technical_commit_0_after$ or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)
 or not coalesce(private.awardping_technical_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$technical_commit_0_after$);
 v_after:=replace(v_after,$technical_commit_1_before$  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$technical_commit_1_before$,$technical_commit_1_after$  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 ||case when p->>'kind'='retained_technical_repeat' then jsonb_build_object('kind','retained_technical_repeat',
  'provenance_kind','post_change_technical_probe','technical_repeat_observation_id',p->'technical_repeat_observation_id','technical_repeat_hash',p->'technical_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$technical_commit_1_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'fd52d9df42c8ab586c06559316095748d252541c345ff5da9801b3b7c243e443' then
  raise exception 'Technical-probe dispatcher replacement differs: commit.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_commit$;

do $technical_dispatch_currentness$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'d130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then
  raise exception 'Technical-probe dispatcher preimage changed: currentness.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$technical_currentness_0_before$  if v ? 'kind' then$technical_currentness_0_before$,$technical_currentness_0_after$  if v->>'kind'='retained_technical_repeat' then
   if v->>'provenance_kind' is distinct from 'post_change_technical_probe'
    or v->>'source_id' is distinct from '88906939-65e7-492d-a671-da56678dfecd'
    or x.cohort_key is distinct from 'daad_study'
    or not coalesce(private.awardping_technical_repeat_version_valid(x.id,v),false) then return false;end if;
   continue;
  end if;
  if v ? 'kind' then$technical_currentness_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'e330f3507e260ca734806c166f48a59d4821cbfbf370338919b6ed6634707c23' then
  raise exception 'Technical-probe dispatcher replacement differs: currentness.' using errcode='40001';
 end if;
 execute v_after;
end;
$technical_dispatch_currentness$;

