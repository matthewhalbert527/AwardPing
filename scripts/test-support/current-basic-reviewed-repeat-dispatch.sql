-- Additive dispatcher fragment. Append after reviewed-repeat ledger/helpers.
-- Exact production function-definition preimages are pinned from the immutable
-- read-only 2026-10-31T21:54 receipt; old byte-proof statements stay unchanged.
-- This file contains no transaction wrapper or migration-history operation.

do $dispatch_proofs$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_proofs_valid(jsonb,jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'d14cd8e0d32c8fc7341255444399cd019b95b1bff00a8fdc002dab079c071196' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: proofs.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_proofs_0_before$  if not private.awardping_program_exact_object(p,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash']) then return false;end if;$dispatch_proofs_0_before$,$dispatch_proofs_0_after$  if p ? 'kind' then
   if p->>'kind' is distinct from 'reviewed_no_program_change' or not coalesce(private.awardping_reviewed_repeat_proof_valid(v_review,p,r,null),false) then return false;end if;
   continue;
  end if;
  if not private.awardping_program_exact_object(p,array['source_id','repeat_observation_id','pending_alert_review_id','pending_alert_review_hash']) then return false;end if;$dispatch_proofs_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'f4a67c8284665ef8734373e584f385ee888ce19ca92eba2520d361fbe8c74896' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: proofs.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_proofs$;

do $dispatch_context$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.inspect_current_program_basic_award(text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'76e6ed96c7f624f671eda62538d404490b815facb6697255c8b2a310ffec5a89' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: context.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_context_0_before$head uuid;pending jsonb;observations jsonb;$dispatch_context_0_before$,$dispatch_context_0_after$head uuid;pending jsonb;observations jsonb;reviewed_observations jsonb;$dispatch_context_0_after$);
 v_after:=replace(v_after,$dispatch_context_1_before$ select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;$dispatch_context_1_before$,$dispatch_context_1_after$ select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',o.id,'kind',o.kind,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'expected_head',o.expected_head,
  'candidate_id',o.candidate_id,'candidate_hash',o.candidate_hash,'current_ref',o.current_ref,'repeat_ref',o.repeat_ref,
  'support_hash',o.support_hash,'content_hash',o.content_hash,'verified_at',o.verified_at,'actor',o.actor,
  'candidate',o.validation->'candidate','paid_reservation',o.validation->'paid_reservation','rules',o.validation->'rules',
  'widget_proofs',o.validation->'widget_proofs','support_projection',o.validation->'support_projection') order by o.created_at desc,o.id),'[]'::jsonb)
 into reviewed_observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_reviewed_repeat_observations z
  where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id and z.expected_head is not distinct from head
   and z.current_ref=x.text_monitoring_state->'latest_ref' and private.awardping_reviewed_repeat_row_current(z.id)
  order by z.created_at desc,z.id limit 2
 ) limited where x.id=any(ids)) o;$dispatch_context_1_after$);
 v_after:=replace(v_after,$dispatch_context_2_before$'pending_alert_reviews',pending,'repeat_observations',observations)$dispatch_context_2_before$,$dispatch_context_2_after$'pending_alert_reviews',pending,'repeat_observations',observations,'basic_fact_head_id',head,'reviewed_repeat_observations',reviewed_observations)$dispatch_context_2_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'89043af512a1103dd6c4e2e5ce2f974ab096240419a8e354b189ba8c9cd4cd3f' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: context.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_context$;

do $dispatch_commit$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('public.commit_current_program_basic_facts(uuid,text,uuid,jsonb,text,text)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'4df0cd318e6e3d9ced7e79228ba4b66a463a7f88dfcb5e66845820825aa81ff0' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: commit.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_commit_0_before$ if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)$dispatch_commit_0_before$,$dispatch_commit_0_after$ if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)
 or not coalesce(private.awardping_reviewed_repeat_commit_heads_valid(d.validation,p_expected_head_id),false)$dispatch_commit_0_after$);
 v_after:=replace(v_after,$dispatch_commit_1_before$'pending_alert_review_hash',p->'pending_alert_review_hash') order by r#>>'{source,id}') into versions$dispatch_commit_1_before$,$dispatch_commit_1_after$'pending_alert_review_hash',p->'pending_alert_review_hash')
 ||case when p->>'kind'='reviewed_no_program_change' then jsonb_build_object('kind','reviewed_no_program_change',
  'reviewed_repeat_observation_id',p->'reviewed_repeat_observation_id','reviewed_repeat_hash',p->'reviewed_repeat_hash') else '{}'::jsonb end
 order by r#>>'{source,id}') into versions$dispatch_commit_1_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'6bd79591ad413ae6875414fa32d49ccecc85b0ee031591b29a1d138d3e947d31' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: commit.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_commit$;

do $dispatch_currentness$
declare v_before text;v_after text;
begin
 v_before:=pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure);
 if encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'2a217b35fe7884cdf7ec5740c7b1d4b61976e854af791a1fa217821ca8e0c223' then
  raise exception 'Reviewed-repeat dispatcher preimage changed: currentness.' using errcode='40001';
 end if;
 v_after:=v_before;
 v_after:=replace(v_after,$dispatch_currentness_0_before$  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;$dispatch_currentness_0_before$,$dispatch_currentness_0_after$  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;
  if v ? 'kind' then
   if v->>'kind' is distinct from 'reviewed_no_program_change' or not coalesce(private.awardping_reviewed_repeat_version_valid(x.id,v),false) then return false;end if;
   continue;
  end if;$dispatch_currentness_0_after$);
 if encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'d130ce8def118e6297b13b578cbf048641a290e579a68f22caf17c28888c053d' then
  raise exception 'Reviewed-repeat dispatcher replacement differs: currentness.' using errcode='40001';
 end if;
 execute v_after;
end;
$dispatch_currentness$;
