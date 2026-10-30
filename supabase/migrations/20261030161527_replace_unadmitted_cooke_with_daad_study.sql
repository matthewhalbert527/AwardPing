-- A candidate-only replacement before any rank-33 admission. Blocked Oxford
-- and declined Cooke histories remain private and unchanged; no source/fact rows.
do $guard$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.program_award_expansion_candidate(text)'::regprocedure),'UTF8'),'sha256'),'hex') <> '5939fcf9a1557fe3d805b258db6ba342b4dac94ac598e44cd5967cc5214aedc9'
 then raise exception 'Unadmitted expansion candidate preimage changed.' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.admit_program_award_expansion_batch(integer,jsonb,text,text)'::regprocedure),'UTF8'),'sha256'),'hex') <> '1a3036cdbb77813ceb88d68eed65b8b99acc0dd1d3c1fe6492193c331a589ecd'
 then raise exception 'Expansion admission preimage changed.' using errcode='40001';end if;
 if exists(select 1 from public.program_award_expansion_admissions where cohort_key in ('cooke_transfer','clarendon','daad_study'))
 or exists(select 1 from public.program_award_registry where cohort_key in ('cooke_transfer','clarendon','daad_study') or launch_rank=33)
 then raise exception 'An affected candidate is already admitted; preserve its identity and history.' using errcode='40001';end if;
end;$guard$;

create or replace function private.program_award_expansion_candidate(p_cohort text) returns jsonb language sql immutable set search_path='' as $$
 select value from jsonb_array_elements($candidates$[{"cohort_key":"ppia_jsi","batch":1,"launch_rank":26,"canonical_shared_award_id":"874d043a-3819-4032-a7c4-bb9582a1d51f","canonical_name":"Public Policy & International Affairs (PPIA) Junior Summer Institute","canonical_slug":"public-policy-and-international-affairs-junior-summer-institute","official_homepage":"https://www.ppiaprogram.org/JSI","source_urls":["https://www.ppiaprogram.org/","https://www.ppiaprogram.org/JSI"]},{"cohort_key":"daad_rise","batch":1,"launch_rank":27,"canonical_shared_award_id":"4a862735-6d67-4154-81ad-4bcc51ad0ec1","canonical_name":"DAAD RISE Germany","canonical_slug":"daad-rise","official_homepage":"https://www.daad.de/rise/en/rise-germany/","source_urls":["https://www.daad.de/rise/en/rise-germany/","https://www.daad.de/rise/en/rise-germany/find-an-internship/application-portal/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/faq/"]},{"cohort_key":"tillman","batch":1,"launch_rank":28,"canonical_shared_award_id":"cb8740aa-4585-4e1c-a939-35fc854cb12b","canonical_name":"Tillman Scholars Program","canonical_slug":"tillman-scholars-program","official_homepage":"https://pattillmanfoundation.org/apply/","source_urls":["https://pattillmanfoundation.org/apply/","https://pattillmanfoundation.org/eligibility-and-compensation/","https://pattillmanfoundation.org/frequently-asked-questions/","https://pattillmanfoundation.org/scholar-benefits/"]},{"cohort_key":"freeman_asia","batch":1,"launch_rank":29,"canonical_shared_award_id":"06713967-eaf6-49cf-aa8d-a12d6cf1ab51","canonical_name":"Freeman-ASIA Award","canonical_slug":"freeman-asia-award","official_homepage":"https://www.iie.org/programs/freeman-asia/","source_urls":["https://www.iie.org/programs/freeman-asia/","https://www.iie.org/programs/freeman-asia/about/award-details/","https://www.iie.org/programs/freeman-asia/apply/","https://www.iie.org/programs/freeman-asia/eligibility/"]},{"cohort_key":"james_madison","batch":1,"launch_rank":30,"canonical_shared_award_id":"592d1ab0-7eff-402a-82ba-90d19559aa7f","canonical_name":"James Madison Memorial Fellowship","canonical_slug":"james-madison-memorial-fellowship","official_homepage":"https://www.jamesmadison.gov/","source_urls":["https://www.jamesmadison.gov/","https://www.jamesmadison.gov/fellowship-information/faq","https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility"]},{"cohort_key":"rangel","batch":2,"launch_rank":31,"canonical_shared_award_id":"e6ebd346-0567-4464-85b1-92a555036992","canonical_name":"Charles B. Rangel International Affairs Fellowship","canonical_slug":"charles-b-rangel-international-affairs-fellowship","official_homepage":"https://rangelprogram.org/graduate-fellowship-program/","source_urls":["https://rangelprogram.org/graduate-fellowship-program/","https://rangelprogram.org/graduate-fellowship-program/application-requirements/","https://rangelprogram.org/graduate-fellowship-program/faqs/","https://rangelprogram.org/graduate-fellowship-program/overview-eligibility/","https://rangelprogram.org/graduate-fellowship-program/university-partners/"]},{"cohort_key":"pickering","batch":2,"launch_rank":32,"canonical_shared_award_id":"06b39341-8489-4c72-a555-dfd96d336f4b","canonical_name":"Pickering Foreign Affairs Fellowship","canonical_slug":"pickering-foreign-affairs-fellowship","official_homepage":"https://pickeringfellowship.org/","source_urls":["https://pickeringfellowship.org/","https://pickeringfellowship.org/approvedprograms/","https://pickeringfellowship.org/how-to-apply/","https://pickeringfellowship.org/overview-eligibility/","https://pickeringfellowship.org/overview-eligibility/faqs/"]},{"cohort_key":"daad_study","batch":2,"launch_rank":33,"canonical_shared_award_id":"440d6985-ece9-48c4-ac30-65a739f60d65","canonical_name":"DAAD Study Scholarships","canonical_slug":"master-studies-for-all-academic-disciplines","official_homepage":"https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200","source_urls":["https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/","https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=","https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200"]},{"cohort_key":"rotary_peace","batch":2,"launch_rank":34,"canonical_shared_award_id":"4f66e3fa-3924-4d0d-a04d-a32989f74c2e","canonical_name":"Rotary Peace Fellowship","canonical_slug":"rotary-peace-fellowship","official_homepage":"https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","source_urls":["https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-certificate-program","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-masters-degree-programs"]},{"cohort_key":"voyager","batch":2,"launch_rank":35,"canonical_shared_award_id":"10dda818-c922-47ac-8b56-55494c2c889f","canonical_name":"The Voyager Scholarship","canonical_slug":"the-voyager-scholarship","official_homepage":"https://www.obama.org/programs/voyager-scholarship/","source_urls":["https://www.obama.org/programs/voyager-scholarship/","https://www.obama.org/programs/voyager-scholarship/faq/"]}]$candidates$::jsonb) where value->>'cohort_key'=p_cohort;
$$;
-- Existing private function owner, ACL and other metadata are preserved.

-- This is one exact reviewed public GET form, not a generic URL/query grant.
-- Ordered controls and the retained official raw bytes bind its USA graduate scope.
create function private.program_award_expansion_get_form_authority(p_cohort text,p_source text,p_authority text,p_proof jsonb)
returns boolean language sql immutable set search_path='' as $form$
 select coalesce(p_cohort='daad_study' and p_source='https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=' and p_authority='https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200'
 and p_proof=$observed${"schema":"awardping.program-award-expansion-get-form.v1","selector":"#applicationreq form","method":"get","action":null,"action_url":"https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200","controls":[{"name":"origin","value":"44"},{"name":"status","value":"3"},{"name":"type","value":"a"},{"name":"q","value":""},{"name":"onlydaad","value":"1"},{"name":"language","value":"en"},{"name":"detail_to_show","value":"50026200"},{"name":"tab","value":""}],"selected_scope":{"origin":"44","origin_label":"USA","status":"3","status_label":"Graduates"},"authority_capture_id":"0a1e31d365c34d5acbeb77118251d099b2c1d72a0adb7e528be37071e42a7825","authority_raw_sha256":"9598035df554a4e41428d2a1582e3fb5368fcd0268d1433b38c5589f7cabddb9"}$observed$::jsonb,false);
$form$;
revoke all on function private.program_award_expansion_get_form_authority(text,text,text,jsonb) from public,anon,authenticated,service_role;

-- Preserve the original first-batch shape, replay, locks, collision boundaries and ACL.
create or replace function public.admit_program_award_expansion_batch(p_batch integer,p_awards jsonb,p_actor text,p_plan_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e uuid;w jsonb;c jsonb;q jsonb;src public.shared_award_sources%rowtype;owner public.shared_awards%rowtype;
 ids uuid[];bindings jsonb;rows jsonb:='[]';v_plan text;checked timestamptz;source_id uuid;existing integer;actual_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if p_batch not in (1,2) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
  or jsonb_typeof(p_awards) is distinct from 'array' or jsonb_array_length(p_awards)<>5 or octet_length(p_awards::text)>262144
 then raise exception 'An exact reviewed five-award expansion batch is required.' using errcode='23514';end if;
 v_plan:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_build_object('batch',p_batch,'awards',p_awards)),'UTF8'),'sha256'),'hex');
 if v_plan<>p_plan_hash then raise exception 'Expansion plan hash differs.' using errcode='23514';end if;
 select count(*) into existing from public.program_award_expansion_admissions where batch=p_batch;
 if existing<>0 then
  if existing<>5 or exists(select 1 from public.program_award_expansion_admissions a where a.batch=p_batch and
    (a.plan_hash<>p_plan_hash or not exists(select 1 from jsonb_array_elements(p_awards) x where x=a.proof)))
  then raise exception 'Expansion batch already has a different immutable admission.' using errcode='40001';end if;
  return jsonb_build_object('schema','awardping.program-award-expansion-admission.v1','batch',p_batch,'plan_hash',p_plan_hash,'already_applied',true,
   'notification_mode','baseline_only','awards',(select jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'admission_id',id,'source_ids',source_ids) order by cohort_key) from public.program_award_expansion_admissions where batch=p_batch));
 end if;
 if p_batch=2 and (select count(*) from public.program_award_expansion_admissions where batch=1 and status='active')<>5
 then raise exception 'Verify and activate the first five before admitting the second five.' using errcode='23514';end if;
 if (select count(*) from public.program_award_expansion_admissions)+5>10 then raise exception 'Expansion is bounded to ten awards.' using errcode='23514';end if;
 select epoch into strict e from public.program_text_source_authority_epochs where active for share;
 if e<>'ec349339-ff62-4d2e-a610-8c361b4044ec'::uuid then raise exception 'Reviewed monitoring epoch changed.' using errcode='40001';end if;
 if (select count(distinct x->>'cohort_key') from jsonb_array_elements(p_awards) x)<>5
 or (select count(*) from jsonb_array_elements(p_awards) x cross join lateral jsonb_array_elements(x->'sources') s)<>
    (select count(distinct s->>'id') from jsonb_array_elements(p_awards) x cross join lateral jsonb_array_elements(x->'sources') s)
 then raise exception 'Duplicate expansion award or source identities.' using errcode='23514';end if;

 -- Validate all five plans and all current rows before creating anything.
 for w in select value from jsonb_array_elements(p_awards) order by value->>'cohort_key' loop
  c:=private.program_award_expansion_candidate(w->>'cohort_key');
  if c is null or not coalesce(private.awardping_program_exact_object(w,array['cohort_key','canonical_shared_award_id','reviewed_at','sources']),false)
   or exists(select 1 from unnest(array['cohort_key','canonical_shared_award_id','reviewed_at']) key where jsonb_typeof(w->key) is distinct from 'string')
   or (c->>'batch')::integer is distinct from p_batch or w->>'canonical_shared_award_id' is distinct from c->>'canonical_shared_award_id'
   or jsonb_typeof(w->'sources') is distinct from 'array' or jsonb_array_length(w->'sources') not between 1 and 6
   or (select jsonb_agg(to_jsonb(s->>'url') order by s->>'url') from jsonb_array_elements(w->'sources') s) is distinct from c->'source_urls'
  then raise exception 'Award/source selection differs from the reviewed expansion.' using errcode='23514';end if;
  checked:=(w->>'reviewed_at')::timestamptz;
  if not coalesce(checked between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
  then raise exception 'A fresh official identity and link review is required.' using errcode='23514';end if;
  select * into strict owner from public.shared_awards where id=(c->>'canonical_shared_award_id')::uuid for share;
  if owner.status<>'active' or owner.slug<>c->>'canonical_slug'
   or exists(select 1 from public.program_award_registry where canonical_shared_award_id=owner.id or cohort_key=w->>'cohort_key' or canonical_slug=c->>'canonical_slug')
  then raise exception 'Expansion owner is inactive, already admitted or has changed identity.' using errcode='40001';end if;
  for q in select value from jsonb_array_elements(w->'sources') order by value->>'id' loop
   if not coalesce(private.awardping_program_exact_object(q,array['id','create','url','title','page_type','expected_text_monitoring_state','authority_url','authority_href','review_note','url_alias_boundary'])
     or private.awardping_program_exact_object(q,array['id','create','url','title','page_type','expected_text_monitoring_state','authority_url','authority_href','review_note','url_alias_boundary','authority_form']),false)
    or exists(select 1 from unnest(array['id','url','title','page_type','authority_url','authority_href','review_note']) key where jsonb_typeof(q->key) is distinct from 'string')
    or coalesce(q->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or q->>'id'='00000000-0000-0000-0000-000000000000'
    or jsonb_typeof(q->'create') is distinct from 'boolean' or q->'expected_text_monitoring_state' is distinct from '{}'::jsonb
    or q->>'url' !~ '^https://[^/?#@:[:space:]]+/' or q->>'url' ~ '[[:space:]#\\]'
    or length(btrim(coalesce(q->>'title',''))) not between 1 and 1000
    or q->>'page_type' not in ('homepage','deadline','application','eligibility','requirements','pdf','faq','other')
    or length(btrim(coalesce(q->>'review_note',''))) not between 20 and 2000
    or jsonb_typeof(q->'url_alias_boundary') is distinct from 'array' or jsonb_array_length(q->'url_alias_boundary')>10
   then raise exception 'Invalid exact-source identity or review.' using errcode='23514';end if;
   source_id:=(q->>'id')::uuid;
   if q->>'url'='https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=' and not (q ? 'authority_form')
   then raise exception 'The reviewed USA graduate form proof is required for this application source.' using errcode='23514';end if;
   if q ? 'authority_form' and (q->>'authority_href' is distinct from ''
    or not private.program_award_expansion_get_form_authority(w->>'cohort_key',q->>'url',q->>'authority_url',q->'authority_form'))
   then raise exception 'Exact reviewed public GET form required.' using errcode='23514';end if;
   if q->>'url'=c->>'official_homepage' then
    if q->>'authority_url' is distinct from c->>'official_homepage' or q->>'authority_href' is distinct from c->>'official_homepage'
    then raise exception 'The exact reviewed homepage is required.' using errcode='23514';end if;
   elsif q ? 'authority_form' then
    if not exists(select 1 from jsonb_array_elements(w->'sources') a where a->>'url'=q->>'authority_url')
    then raise exception 'The observed form must belong to an included official source.' using errcode='23514';end if;
   else
    if not exists(select 1 from jsonb_array_elements(w->'sources') a where a->>'url'=q->>'authority_url')
     or private.awardping_basic_href(q->>'authority_href',q->>'authority_url') is distinct from q->>'url'
    then raise exception 'Actual included-provider link does not resolve to this source.' using errcode='23514';end if;
   end if;
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner.id::text||E'\n'||(q->>'url'),0));
   -- These are collision records, not aliases or approval grants. Existing
   -- misassigned sources remain untouched and gain no membership/permission.
   perform 1 from public.shared_award_sources x where lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(q->>'url','/+$','')) order by x.id for share;
   select coalesce(jsonb_agg(jsonb_build_object('source_id',x.id,'shared_award_id',x.shared_award_id,'source_url',x.url,
    'memberships',(select coalesce(jsonb_agg(jsonb_build_object('cohort_key',m.cohort_key,'member_kind',m.member_kind) order by m.cohort_key),'[]'::jsonb)
     from public.program_award_members m where m.shared_award_id=x.shared_award_id)) order by x.id),'[]'::jsonb) into actual_boundary
   from public.shared_award_sources x where x.id<>source_id and lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(q->>'url','/+$',''));
   if actual_boundary is distinct from q->'url_alias_boundary' or exists(select 1 from jsonb_array_elements(actual_boundary) b,
    lateral jsonb_array_elements(b->'memberships') m where m->>'cohort_key' is distinct from w->>'cohort_key')
   then raise exception 'Review the exact current collision boundary; registered other-program sources cannot be reused.' using errcode='40001';end if;
   select * into src from public.shared_award_sources where id=source_id for update;
   if (q->>'create')::boolean then
    if found or exists(select 1 from public.shared_award_sources x where x.shared_award_id=owner.id and lower(regexp_replace(split_part(x.url,'#',1),'/+$',''))=lower(regexp_replace(q->>'url','/+$','')))
    then raise exception 'A source already exists for this owner; preserve and reuse its identity.' using errcode='23505';end if;
   elsif not found or src.shared_award_id<>owner.id or src.url<>q->>'url' or src.title<>q->>'title' or src.page_type<>q->>'page_type'
     or src.text_monitoring_state is distinct from q->'expected_text_monitoring_state' or src.admin_review_status not in ('open','review_later')
   then raise exception 'Existing source identity, history or permission changed.' using errcode='40001';end if;
  end loop;
 end loop;

 for w in select value from jsonb_array_elements(p_awards) order by value->>'cohort_key' loop
  c:=private.program_award_expansion_candidate(w->>'cohort_key');ids:='{}';bindings:='{}';
  insert into public.program_award_registry(cohort_key,launch_rank,canonical_name,canonical_shared_award_id,canonical_slug,official_homepage,publication_state,state_reason,policy_version)
  values(c->>'cohort_key',(c->>'launch_rank')::integer,c->>'canonical_name',(c->>'canonical_shared_award_id')::uuid,c->>'canonical_slug',c->>'official_homepage',
   'pending','Text-only expansion admitted for silent collection; basic details are not yet public.','program-basic-expansion-v1');
  insert into public.program_award_members(shared_award_id,cohort_key,member_kind,reason)
  values((c->>'canonical_shared_award_id')::uuid,c->>'cohort_key','canonical','Reviewed basic-information and text-monitoring expansion; no legacy complete-program approval.');
  for q in select value from jsonb_array_elements(w->'sources') order by value->>'id' loop
   source_id:=(q->>'id')::uuid;
   if (q->>'create')::boolean then
    insert into public.shared_award_sources(id,shared_award_id,url,title,page_type,source,confidence,reason,admin_review_status,text_monitoring_state)
    values(source_id,(c->>'canonical_shared_award_id')::uuid,q->>'url',q->>'title',q->>'page_type','admin',1,
     'Reviewed text-only expansion; silent initial coverage and independent repeat required.','review_later','{}');
    insert into public.shared_award_source_acquisitions(shared_award_source_id,acquisition_kind,notification_mode,onboarding_batch_id,review_seal,metadata)
    values(source_id,'admin_intake','baseline_only','program-basic-expansion-20261030-batch-'||p_batch,'{}',
     jsonb_build_object('schema','awardping.program-award-expansion-source-acquisition.v1','plan_hash',p_plan_hash,'collection_only',true,
      'requested_notification_mode','baseline_only','effective_notification_mode','baseline_only','server_first_capture_eligible',false));
   end if;
   ids:=array_append(ids,source_id);bindings:=bindings||jsonb_build_object(source_id::text,jsonb_build_object('source_url',q->>'url','shared_award_id',c->>'canonical_shared_award_id',
    'authority_url',q->>'authority_url','review_note',q->>'review_note'));
  end loop;
  insert into public.program_text_source_roster(cohort_key,source_role,source_ids,evidence,reviewed_by)
  values(c->>'cohort_key','program_details',ids,jsonb_build_object('schema','awardping.program-text-source-role.v1','source_bindings',bindings),btrim(p_actor));
  insert into public.program_award_expansion_admissions(cohort_key,batch,epoch,plan_hash,proof,source_ids,admitted_by)
  values(c->>'cohort_key',p_batch,e,p_plan_hash,w,ids,btrim(p_actor));
  rows:=rows||jsonb_build_array(jsonb_build_object('cohort_key',c->>'cohort_key','source_ids',ids));
 end loop;
 return jsonb_build_object('schema','awardping.program-award-expansion-admission.v1','batch',p_batch,'plan_hash',p_plan_hash,'already_applied',false,'notification_mode','baseline_only','awards',rows);
end;$$;
