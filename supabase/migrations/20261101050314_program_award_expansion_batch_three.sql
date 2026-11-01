-- One additional reviewed batch of five. No admission, collection, facts or publication occurs in this migration.
-- Service-only admission, authenticated office boundaries, DAAD form proof and original25 release remain intact.
do $batch_three_preconditions$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.activate_program_award_expansion_batch(integer,text,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='5280a086d5e083c033295f381153885c562260df055b6227dbdfe454830a6bb4' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.activate_program_award_expansion_batch(integer,text,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.admit_program_award_expansion_batch(integer,jsonb,text,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='c4e0debb78bd28b5dc1fa64c83818db535ebde4c7132a4bd32727d26070430ae' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.admit_program_award_expansion_batch(integer,jsonb,text,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_publication(uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e8e26924214349c37b24a7bddccbe392ad65bd014deb8776eb5405c185b4fff3' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.get_program_award_expansion_publication(uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_candidate(text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='fe1d7de4be4c4162e60dc856f05ee70a76d6564b17747b65844bd32519f3a186' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_candidate(text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_get_form_authority(text,text,text,jsonb)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e9acf61df0f2fe9d2728ac9d9735d961de0ae96acf445750f3b25651ffcb546f' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_get_form_authority(text,text,text,jsonb)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_tracking_context(uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='d9f25b79e1d485a247ea5bb93497fb9788a40d024fc5022b573636cadab21e53' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.get_program_award_expansion_tracking_context(uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_follow_source(text,uuid,uuid,uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='785cff7103f5a289bc117a668da196f060f068577cff2361144027fb56bf1e15' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_follow_source(text,uuid,uuid,uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e07eebb507920ad7ddce93b652d94eb3973b9659ba26e7e98c2b95ec3befacbf' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Batch-three function authority changed: public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1ee024df84264916ebb921439ffc5b2ca546347c6d0589599a04fef9bc8bb7d3' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Batch-three function authority changed: public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)' using errcode='40001';end if;
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>35 or
 (select count(*) from public.program_award_expansion_admissions)<>10 or exists(select 1 from generate_series(1,2) previous(batch) where
 (select count(*) from public.program_award_expansion_admissions a where a.batch=previous.batch and a.status='active')<>5)
 then raise exception 'The accepted original25 and active first ten must be preserved.' using errcode='40001';end if;
 if (select encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_agg(private.program_award_expansion_candidate(r.cohort_key) order by r.launch_rank)),'UTF8'),'sha256'),'hex')
 from public.program_award_registry r where r.launch_rank between 26 and 35)<>'0dbfe89c9dc2d1b1e82398733e786dc080dc047ace7317e2c50224eda9b1ada4'
 then raise exception 'Accepted first ten candidate values changed.' using errcode='40001';end if;
 if pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conrelid='public.program_award_registry'::regclass and conname='program_award_registry_launch_rank_check')) is distinct from 'CHECK (((launch_rank >= 1) AND (launch_rank <= 35)))' or
 pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conrelid='public.program_award_expansion_admissions'::regclass and conname='program_award_expansion_admissions_batch_check')) is distinct from 'CHECK ((batch = ANY (ARRAY[1, 2])))'
 then raise exception 'Existing bounded constraints changed.' using errcode='40001';end if;
end;$batch_three_preconditions$;

alter table public.program_award_registry drop constraint program_award_registry_launch_rank_check;
alter table public.program_award_registry add constraint program_award_registry_launch_rank_check check(launch_rank between 1 and 40);
alter table public.program_award_expansion_admissions drop constraint program_award_expansion_admissions_batch_check;
alter table public.program_award_expansion_admissions add constraint program_award_expansion_admissions_batch_check check(batch in (1,2,3));

CREATE OR REPLACE FUNCTION private.program_award_expansion_candidate(p_cohort text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 select value from jsonb_array_elements($candidates$[{"cohort_key":"ppia_jsi","batch":1,"launch_rank":26,"canonical_shared_award_id":"874d043a-3819-4032-a7c4-bb9582a1d51f","canonical_name":"Public Policy & International Affairs (PPIA) Junior Summer Institute","canonical_slug":"public-policy-and-international-affairs-junior-summer-institute","official_homepage":"https://www.ppiaprogram.org/JSI","source_urls":["https://www.ppiaprogram.org/","https://www.ppiaprogram.org/JSI"]},{"cohort_key":"daad_rise","batch":1,"launch_rank":27,"canonical_shared_award_id":"4a862735-6d67-4154-81ad-4bcc51ad0ec1","canonical_name":"DAAD RISE Germany","canonical_slug":"daad-rise","official_homepage":"https://www.daad.de/rise/en/rise-germany/","source_urls":["https://www.daad.de/rise/en/rise-germany/","https://www.daad.de/rise/en/rise-germany/find-an-internship/application-portal/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/faq/"]},{"cohort_key":"tillman","batch":1,"launch_rank":28,"canonical_shared_award_id":"cb8740aa-4585-4e1c-a939-35fc854cb12b","canonical_name":"Tillman Scholars Program","canonical_slug":"tillman-scholars-program","official_homepage":"https://pattillmanfoundation.org/apply/","source_urls":["https://pattillmanfoundation.org/apply/","https://pattillmanfoundation.org/eligibility-and-compensation/","https://pattillmanfoundation.org/frequently-asked-questions/","https://pattillmanfoundation.org/scholar-benefits/"]},{"cohort_key":"freeman_asia","batch":1,"launch_rank":29,"canonical_shared_award_id":"06713967-eaf6-49cf-aa8d-a12d6cf1ab51","canonical_name":"Freeman-ASIA Award","canonical_slug":"freeman-asia-award","official_homepage":"https://www.iie.org/programs/freeman-asia/","source_urls":["https://www.iie.org/programs/freeman-asia/","https://www.iie.org/programs/freeman-asia/about/award-details/","https://www.iie.org/programs/freeman-asia/apply/","https://www.iie.org/programs/freeman-asia/eligibility/"]},{"cohort_key":"james_madison","batch":1,"launch_rank":30,"canonical_shared_award_id":"592d1ab0-7eff-402a-82ba-90d19559aa7f","canonical_name":"James Madison Memorial Fellowship","canonical_slug":"james-madison-memorial-fellowship","official_homepage":"https://www.jamesmadison.gov/","source_urls":["https://www.jamesmadison.gov/","https://www.jamesmadison.gov/fellowship-information/faq","https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility"]},{"cohort_key":"rangel","batch":2,"launch_rank":31,"canonical_shared_award_id":"e6ebd346-0567-4464-85b1-92a555036992","canonical_name":"Charles B. Rangel International Affairs Fellowship","canonical_slug":"charles-b-rangel-international-affairs-fellowship","official_homepage":"https://rangelprogram.org/graduate-fellowship-program/","source_urls":["https://rangelprogram.org/graduate-fellowship-program/","https://rangelprogram.org/graduate-fellowship-program/application-requirements/","https://rangelprogram.org/graduate-fellowship-program/faqs/","https://rangelprogram.org/graduate-fellowship-program/overview-eligibility/","https://rangelprogram.org/graduate-fellowship-program/university-partners/"]},{"cohort_key":"pickering","batch":2,"launch_rank":32,"canonical_shared_award_id":"06b39341-8489-4c72-a555-dfd96d336f4b","canonical_name":"Pickering Foreign Affairs Fellowship","canonical_slug":"pickering-foreign-affairs-fellowship","official_homepage":"https://pickeringfellowship.org/","source_urls":["https://pickeringfellowship.org/","https://pickeringfellowship.org/approvedprograms/","https://pickeringfellowship.org/how-to-apply/","https://pickeringfellowship.org/overview-eligibility/","https://pickeringfellowship.org/overview-eligibility/faqs/"]},{"cohort_key":"daad_study","batch":2,"launch_rank":33,"canonical_shared_award_id":"440d6985-ece9-48c4-ac30-65a739f60d65","canonical_name":"DAAD Study Scholarships","canonical_slug":"master-studies-for-all-academic-disciplines","official_homepage":"https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200","source_urls":["https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/","https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=","https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200"]},{"cohort_key":"rotary_peace","batch":2,"launch_rank":34,"canonical_shared_award_id":"4f66e3fa-3924-4d0d-a04d-a32989f74c2e","canonical_name":"Rotary Peace Fellowship","canonical_slug":"rotary-peace-fellowship","official_homepage":"https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","source_urls":["https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-certificate-program","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-masters-degree-programs"]},{"cohort_key":"voyager","batch":2,"launch_rank":35,"canonical_shared_award_id":"10dda818-c922-47ac-8b56-55494c2c889f","canonical_name":"The Voyager Scholarship","canonical_slug":"the-voyager-scholarship","official_homepage":"https://www.obama.org/programs/voyager-scholarship/","source_urls":["https://www.obama.org/programs/voyager-scholarship/","https://www.obama.org/programs/voyager-scholarship/faq/"]},{"cohort_key":"nih_oxcam","batch":3,"launch_rank":36,"canonical_shared_award_id":"dc1674f0-0bd2-4546-afc8-1034ea213274","canonical_name":"NIH Oxford-Cambridge Scholars Program","official_homepage":"https://oxcam.gpp.nih.gov/prospective-students","canonical_slug":"national-institutes-of-health-oxford-cambridge-scholars-program","source_urls":["https://oxcam.gpp.nih.gov/prospective-students","https://oxcam.gpp.nih.gov/prospective-students/how-apply"]},{"cohort_key":"fait","batch":3,"launch_rank":37,"canonical_shared_award_id":"fe11c501-8d14-41bf-8cc8-a7a2edb2ca50","canonical_name":"Foreign Affairs Information Technology (FAIT) Fellowship","official_homepage":"https://www.faitfellowship.org/fellowship/","canonical_slug":"foreign-affairs-information-technology-fellowship","source_urls":["https://www.faitfellowship.org/fellowship/","https://www.faitfellowship.org/fellowship/eligibility-requirements/","https://www.faitfellowship.org/fellowship/u-s-department-of-state-clearance-processes/","https://www.faitfellowship.org/frequently-asked-questions/","https://www.faitfellowship.org/how-to-apply/"]},{"cohort_key":"princeton_asia","batch":3,"launch_rank":38,"canonical_shared_award_id":"d80105aa-41c2-454d-9afa-a8639d63ce0a","canonical_name":"Princeton in Asia Fellowships","official_homepage":"https://www.princetoninasia.org/fellowships","canonical_slug":"princeton-in-asia-fellowship","source_urls":["https://www.princetoninasia.org/fellowship-applications","https://www.princetoninasia.org/fellowship-eligibility","https://www.princetoninasia.org/fellowship-faq","https://www.princetoninasia.org/fellowships"]},{"cohort_key":"blakemore_freeman","batch":3,"launch_rank":39,"canonical_shared_award_id":"f7cea269-67b7-4372-bd68-4a995c096db4","canonical_name":"Blakemore Freeman Fellowships","official_homepage":"https://www.blakemorefoundation.org/fellowships","canonical_slug":"blakemore-freeman-fellowship","source_urls":["https://www.blakemorefoundation.org/fellowships","https://www.blakemorefoundation.org/language-programs"]},{"cohort_key":"princeton_africa","batch":3,"launch_rank":40,"canonical_shared_award_id":"ecc92ab9-beac-4771-8bd4-c7e305519dfc","canonical_name":"Princeton in Africa Fellowships","official_homepage":"https://www.princetoninafrica.org/applicants/how-to-apply/","canonical_slug":"princeton-in-africa-fellowship","source_urls":["https://www.princetoninafrica.org/applicants/frequently-asked-questions/","https://www.princetoninafrica.org/applicants/how-to-apply/","https://www.princetoninafrica.org/nexus/"]}]$candidates$::jsonb) where value->>'cohort_key'=p_cohort;
$function$;

CREATE OR REPLACE FUNCTION public.admit_program_award_expansion_batch(p_batch integer, p_awards jsonb, p_actor text, p_plan_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e uuid;w jsonb;c jsonb;q jsonb;src public.shared_award_sources%rowtype;owner public.shared_awards%rowtype;
 ids uuid[];bindings jsonb;rows jsonb:='[]';v_plan text;checked timestamptz;source_id uuid;existing integer;actual_boundary jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if p_batch not in (1,2,3) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
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
 if exists(select 1 from generate_series(1,p_batch-1) previous(batch) where
  (select count(*) from public.program_award_expansion_admissions a where a.batch=previous.batch and a.status='active')<>5)
 then raise exception 'Verify and activate each earlier five-award batch before admitting the next five.' using errcode='23514';end if;
 if (select count(*) from public.program_award_expansion_admissions)+5>15 then raise exception 'Expansion is bounded to fifteen awards.' using errcode='23514';end if;
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
end;$function$;

CREATE OR REPLACE FUNCTION public.activate_program_award_expansion_batch(p_batch integer, p_expected_plan_hash text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.program_award_expansion_admissions%rowtype;e uuid;receipt jsonb;at_time timestamptz:=clock_timestamp();
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if p_batch not in(1,2,3) or not coalesce(p_expected_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
 then raise exception 'An exact reviewed expansion activation is required.' using errcode='23514';end if;
 select epoch into strict e from public.program_text_source_authority_epochs where active for share;
 if (select count(*) from public.program_award_expansion_admissions where batch=p_batch and plan_hash=p_expected_plan_hash and epoch=e)<>5
 or exists(select 1 from generate_series(1,p_batch-1) previous(batch) where
  (select count(*) from public.program_award_expansion_admissions previous_admission where previous_admission.batch=previous.batch and previous_admission.status='active')<>5)
 then raise exception 'A complete admitted five-award batch and previous batch are required.' using errcode='23514';end if;
 if (select count(*) from public.program_award_expansion_admissions where batch=p_batch and status='active')=5
 then return jsonb_build_object('ok',true,'batch',p_batch,'already_applied',true);end if;
 for a in select * from public.program_award_expansion_admissions where batch=p_batch order by cohort_key for update loop
  perform 1 from public.program_award_registry where cohort_key=a.cohort_key for share;
  perform 1 from public.program_text_source_roster where cohort_key=a.cohort_key for share;
  perform 1 from public.shared_award_sources where id=any(a.source_ids) order by id for share;
  perform 1 from public.program_basic_fact_heads where cohort_key=a.cohort_key for share;
  if not private.program_award_expansion_initial_ready(a.cohort_key,e)
  then raise exception 'Each of the five awards needs complete repeats and current supported basic details.' using errcode='23514';end if;
 end loop;
 for a in select * from public.program_award_expansion_admissions where batch=p_batch order by cohort_key loop
  select jsonb_build_object('schema','awardping.program-award-expansion-activation.v1','epoch',e,'plan_hash',a.plan_hash,'activated_by',btrim(p_actor),'activated_at',at_time,
   'basic_snapshot_id',(select snapshot_id from public.program_basic_fact_heads where cohort_key=a.cohort_key),
   'source_refs',(select jsonb_agg(jsonb_build_object('source_id',s.id,'reference',s.text_monitoring_state->'latest_ref') order by s.id) from public.shared_award_sources s where s.id=any(a.source_ids)))
  into receipt;
  update public.program_award_expansion_admissions set status='active',activated_at=at_time,activation_receipt=receipt where id=a.id;
 end loop;
 return jsonb_build_object('ok',true,'batch',p_batch,'already_applied',false,'activated_at',at_time);
end;$function$;

CREATE OR REPLACE FUNCTION public.get_program_award_expansion_publication(p_epoch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_epoch is null or not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
 then raise exception 'The current monitoring epoch is required.' using errcode='40001';end if;
 select coalesce(jsonb_agg(jsonb_build_object('registry',to_jsonb(r),'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.program_award_members m where m.cohort_key=r.cohort_key),
  'source_ids',a.source_ids,'reviewed_homepage',jsonb_build_object('source_id',(select q->>'id' from jsonb_array_elements(a.proof->'sources') q where q->>'url'=r.official_homepage),'url',r.official_homepage),
  'basic_fact',(select value from jsonb_array_elements(public.get_program_basic_facts(array[r.canonical_shared_award_id])) where value->>'cohort_key'=r.cohort_key))
  order by r.launch_rank),'[]'::jsonb) into result
 from public.program_award_expansion_admissions a join public.program_award_registry r on r.cohort_key=a.cohort_key
 where a.status='active' and a.epoch=p_epoch;
 if jsonb_array_length(result) not in(0,5,10,15) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-publication.v1','epoch',p_epoch,'awards',result);
end;$function$;

CREATE OR REPLACE FUNCTION private.program_award_expansion_follow_source(p_cohort text, p_admission uuid, p_epoch uuid, p_source uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select exists(select 1 from public.program_award_expansion_admissions a
 join public.program_award_registry r on r.cohort_key=a.cohort_key
 join public.program_award_members m on m.cohort_key=r.cohort_key and m.shared_award_id=r.canonical_shared_award_id and m.member_kind='canonical'
 join public.shared_award_sources s on s.shared_award_id=r.canonical_shared_award_id and s.id=any(a.source_ids)
 join public.program_text_source_authority_epochs e on e.active and e.epoch=a.epoch
 where a.id=p_admission and a.cohort_key=p_cohort and a.epoch=p_epoch and a.status='active'
 and r.launch_rank between 26 and 40 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended'
 and s.id=p_source and s.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
 and s.text_monitoring_state->>'epoch'=p_epoch::text
 and private.program_award_expansion_source_proof(s.id) is not null
 and private.awardping_program_text_source_access(s.id,p_cohort,p_epoch)
 and private.awardping_program_source_allowed(s.id));
$function$;

CREATE OR REPLACE FUNCTION public.get_program_award_expansion_tracking_context(p_shared_award_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.program_award_expansion_admissions%rowtype;r public.program_award_registry%rowtype;v_sources jsonb;
begin
 select registry.* into strict r from public.program_award_registry registry
 where registry.canonical_shared_award_id=p_shared_award_id and registry.launch_rank between 26 and 40
 and registry.policy_version='program-basic-expansion-v1';
 select admission.* into strict a from public.program_award_expansion_admissions admission
 where admission.cohort_key=r.cohort_key;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,
  'page_type',s.page_type,'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) order by s.id),'[]')
 into v_sources from public.shared_award_sources s where s.id=any(a.source_ids);
 return jsonb_build_object('schema','awardping.program-award-expansion-tracking.v1','cohort_key',a.cohort_key,
  'canonical_shared_award_id',r.canonical_shared_award_id,'admission_id',a.id,'epoch',a.epoch,
  'source_ids',(select jsonb_agg(id order by id) from unnest(a.source_ids) id),'sources',v_sources);
exception when no_data_found or too_many_rows then
 raise exception 'An admitted expansion identity is required.' using errcode='P0002';
end;$function$;

CREATE OR REPLACE FUNCTION public.track_office_program_expansion_atomic(p_office_id uuid, p_cohort_key text, p_expected_admission_id uuid, p_expected_epoch uuid, p_expected_source_bindings jsonb, p_cadence text DEFAULT 'daily'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor_user_id uuid:=(select auth.uid());v_registry public.program_award_registry%rowtype;
 v_admission public.program_award_expansion_admissions%rowtype;v_shared_award public.shared_awards%rowtype;
 p_canonical_shared_award_id uuid;v_current_member_ids uuid[];v_selected_source_ids uuid[];v_database_source_bindings jsonb;
 v_canonical_office_award_id uuid;v_summary text;v_was_tracked boolean:=false;
 v_source public.shared_award_sources%rowtype;v_source_row_id uuid;v_monitor_id uuid;v_result jsonb;v_binding jsonb;
begin
 if v_actor_user_id is null then raise exception 'Authentication is required.' using errcode='28000';end if;
 if p_office_id is null or p_cohort_key is null or p_expected_admission_id is null or p_expected_epoch is null
 or p_cadence is distinct from 'daily' or jsonb_typeof(p_expected_source_bindings) is distinct from 'array'
 or jsonb_array_length(p_expected_source_bindings) not between 1 and 6 or octet_length(p_expected_source_bindings::text)>32768
 then raise exception 'A bounded exact expansion tracking identity is required.' using errcode='22023';end if;
 perform 1 from public.office_members m where m.office_id=p_office_id and m.user_id=v_actor_user_id
 and m.status='active' and m.role in ('owner','admin') for share;
 if not found then raise exception 'Office owner or admin access is required.' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('program-award-expansion',0));
 select * into v_admission from public.program_award_expansion_admissions a
 where a.cohort_key=p_cohort_key and a.id=p_expected_admission_id for share;
 if not found or v_admission.status<>'active' or v_admission.epoch<>p_expected_epoch
 then raise exception 'Expansion admission is not currently active.' using errcode='40001';end if;
 perform 1 from public.program_text_source_authority_epochs e where e.active and e.epoch=p_expected_epoch for share;
 if not found then raise exception 'Text source authority epoch changed.' using errcode='40001';end if;
 select * into v_registry from public.program_award_registry r where r.cohort_key=p_cohort_key
 and r.launch_rank between 26 and 40 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended' for share;
 if not found then raise exception 'Expansion award is not currently released.' using errcode='40001';end if;
 p_canonical_shared_award_id:=v_registry.canonical_shared_award_id;
 v_current_member_ids:=array[p_canonical_shared_award_id];
 perform 1 from public.program_award_members m where m.cohort_key=p_cohort_key order by m.shared_award_id for share;
 if (select count(*) from public.program_award_members m where m.cohort_key=p_cohort_key)<>1
 or not exists(select 1 from public.program_award_members m where m.cohort_key=p_cohort_key
 and m.shared_award_id=p_canonical_shared_award_id and m.member_kind='canonical')
 then raise exception 'Expansion canonical membership changed.' using errcode='40001';end if;
 select * into v_shared_award from public.shared_awards a where a.id=p_canonical_shared_award_id and a.status='active' for share;
 if not found then raise exception 'Canonical award changed before tracking.' using errcode='40001';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('office-award-tracking:'||p_office_id::text||':'||p_canonical_shared_award_id::text,0));
 for v_binding in select value from jsonb_array_elements(p_expected_source_bindings) loop
  if not coalesce(private.awardping_program_exact_object(v_binding,array['id','shared_award_id','url','title','page_type','confidence','reason','admin_review_status','updated_at']),false)
  or jsonb_typeof(v_binding->'id') is distinct from 'string' or (v_binding->>'id') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  then raise exception 'Exact source metadata bindings are required.' using errcode='22023';end if;
 end loop;
 select array_agg(id order by id) into v_selected_source_ids from
 (select distinct (x->>'id')::uuid id from jsonb_array_elements(p_expected_source_bindings) x) ids;
 if cardinality(v_selected_source_ids)<>jsonb_array_length(p_expected_source_bindings)
 or not v_selected_source_ids<@v_admission.source_ids
 then raise exception 'Selected expansion source identity changed.' using errcode='40001';end if;
 perform 1 from public.shared_award_sources s where s.id=any(v_selected_source_ids) order by s.id for share;
 perform 1 from public.program_text_source_roster r where r.cohort_key=p_cohort_key order by r.source_role for share;
 if exists(select 1 from unnest(v_selected_source_ids) id
 where not private.program_award_expansion_follow_source(p_cohort_key,p_expected_admission_id,p_expected_epoch,id))
 then raise exception 'Selected expansion source authority changed.' using errcode='40001';end if;
 if (select count(*) from public.shared_award_sources s where s.id=any(v_selected_source_ids))<>
 (select count(distinct private.office_tracking_source_url_key(s.url)) from public.shared_award_sources s where s.id=any(v_selected_source_ids))
 then raise exception 'Selected expansion source URL is duplicated.' using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,'title',s.title,'page_type',s.page_type,
 'confidence',s.confidence,'reason',s.reason,'admin_review_status',s.admin_review_status,'updated_at',s.updated_at) order by s.id)
 into v_database_source_bindings from public.shared_award_sources s where s.id=any(v_selected_source_ids);
 if v_database_source_bindings is distinct from p_expected_source_bindings
 then raise exception 'Source rows changed before tracking.' using errcode='40001';end if;

  perform 1
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by award.id
  for update;

  select exists (
    select 1
    from public.awards award
    where award.office_id = p_office_id
      and award.shared_award_id = any(v_current_member_ids)
      and award.status = 'active'
  ) into v_was_tracked;

  select award.id into v_canonical_office_award_id
  from public.awards award
  where award.office_id = p_office_id
    and award.shared_award_id = any(v_current_member_ids)
  order by
    (award.shared_award_id = p_canonical_shared_award_id) desc,
    (award.status = 'active') desc,
    award.created_at,
    award.id
  limit 1;

  -- A stale basic snapshot does not prevent following. It contributes no
  -- unsupported local summary while the genuine change awaits reconciliation.
  select case when private.awardping_basic_fact_current(s.id) then s.public_facts->>'overview' else null end
  into v_summary from public.program_basic_fact_heads h
  join public.program_basic_fact_snapshots s on s.id=h.snapshot_id
  where h.cohort_key=p_cohort_key;

  if v_canonical_office_award_id is null then
    insert into public.awards (
      office_id,
      user_id,
      shared_award_id,
      name,
      official_homepage,
      summary,
      confidence,
      status
    ) values (
      p_office_id,
      v_actor_user_id,
      p_canonical_shared_award_id,
      v_registry.canonical_name,
      v_registry.official_homepage,
      v_summary,
      v_shared_award.confidence,
      'active'
    ) returning id into v_canonical_office_award_id;
  else
    perform private.consolidate_office_award_tracking(
      p_office_id,
      v_canonical_office_award_id,
      p_canonical_shared_award_id,
      v_current_member_ids,
      v_selected_source_ids
    );
  end if;

  update public.awards award
  set shared_award_id = p_canonical_shared_award_id,
      name = v_registry.canonical_name,
      official_homepage = v_registry.official_homepage,
      summary = v_summary,
      confidence = v_shared_award.confidence,
      status = 'active',
      updated_at = statement_timestamp()
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;
  if not found then
    raise exception using errcode = '40001', message = 'Canonical office award changed while tracking.';
  end if;

  for v_source in
    select source.*
    from public.shared_award_sources source
    where source.id = any(v_selected_source_ids)
    order by source.id
  loop
    select source.id into v_source_row_id
    from public.award_sources source
    where source.office_id = p_office_id
      and source.award_id = v_canonical_office_award_id
      and private.office_tracking_source_url_key(source.url)
        = private.office_tracking_source_url_key(v_source.url)
    order by source.created_at, source.id
    limit 1
    for update;

    if v_source_row_id is null then
      insert into public.award_sources (
        award_id,
        office_id,
        user_id,
        shared_award_source_id,
        url,
        title,
        page_type,
        confidence,
        reason,
        selected
      ) values (
        v_canonical_office_award_id,
        p_office_id,
        v_actor_user_id,
        v_source.id,
        v_source.url,
        v_source.title,
        v_source.page_type,
        v_source.confidence,
        v_source.reason,
        true
      ) returning id into v_source_row_id;
    else
      update public.award_sources source
      set shared_award_source_id = v_source.id,
          url = v_source.url,
          title = v_source.title,
          page_type = v_source.page_type,
          confidence = v_source.confidence,
          reason = v_source.reason,
          selected = true,
          updated_at = statement_timestamp()
      where source.id = v_source_row_id
        and source.office_id = p_office_id;
    end if;

    v_monitor_id := null;
    select monitor.id into v_monitor_id
    from public.monitors monitor
    where monitor.office_id = p_office_id
      and monitor.award_id = v_canonical_office_award_id
      and private.office_tracking_source_url_key(monitor.url)
        = private.office_tracking_source_url_key(v_source.url)
    order by monitor.created_at, monitor.id
    limit 1
    for update;

    if v_monitor_id is null then
      insert into public.monitors (
        office_id,
        user_id,
        award_id,
        shared_award_source_id,
        label,
        url,
        content_type,
        cadence,
        page_type,
        source_label,
        status,
        next_check_at
      ) values (
        p_office_id,
        v_actor_user_id,
        v_canonical_office_award_id,
        v_source.id,
        v_registry.canonical_name || ' - ' || case v_source.page_type
          when 'homepage' then 'Homepage'
          when 'deadline' then 'Deadline'
          when 'application' then 'Application'
          when 'eligibility' then 'Eligibility'
          when 'requirements' then 'Award conditions'
          when 'pdf' then 'PDF guide'
          when 'faq' then 'FAQ'
          else 'Other source'
        end,
        v_source.url,
        case
          when v_source.page_type = 'pdf'
            or pg_catalog.lower(pg_catalog.split_part(v_source.url, '?', 1)) like '%.pdf'
            then 'pdf'
          else 'auto'
        end,
        p_cadence,
        v_source.page_type,
        v_source.title,
        'active',
        statement_timestamp()
      ) returning id into v_monitor_id;
    else
      update public.monitors monitor
      set shared_award_source_id = v_source.id,
          label = v_registry.canonical_name || ' - ' || case v_source.page_type
            when 'homepage' then 'Homepage'
            when 'deadline' then 'Deadline'
            when 'application' then 'Application'
            when 'eligibility' then 'Eligibility'
            when 'requirements' then 'Award conditions'
            when 'pdf' then 'PDF guide'
            when 'faq' then 'FAQ'
            else 'Other source'
          end,
          url = v_source.url,
          content_type = case
            when v_source.page_type = 'pdf'
              or pg_catalog.lower(pg_catalog.split_part(v_source.url, '?', 1)) like '%.pdf'
              then 'pdf'
            else 'auto'
          end,
          cadence = p_cadence,
          page_type = v_source.page_type,
          source_label = v_source.title,
          status = case when monitor.status = 'paused' then 'active' else monitor.status end,
          next_check_at = case
            when monitor.status = 'paused' then statement_timestamp()
            else monitor.next_check_at
          end,
          updated_at = statement_timestamp()
      where monitor.id = v_monitor_id
        and monitor.office_id = p_office_id;
    end if;
  end loop;

  select pg_catalog.jsonb_build_object(
    'award', pg_catalog.to_jsonb(award),
    'sources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(source) order by source.created_at, source.id)
      from public.award_sources source
      where source.office_id = p_office_id
        and source.award_id = v_canonical_office_award_id
        and source.selected
    ), '[]'::jsonb),
    'monitors', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(monitor) order by monitor.created_at, monitor.id)
      from public.monitors monitor
      where monitor.office_id = p_office_id
        and monitor.award_id = v_canonical_office_award_id
        and monitor.status <> 'paused'
    ), '[]'::jsonb),
    'alreadyTracked', v_was_tracked
  ) into v_result
  from public.awards award
  where award.id = v_canonical_office_award_id
    and award.office_id = p_office_id;

  return v_result;
end;
$function$;

do $batch_three_postconditions$
begin
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.activate_program_award_expansion_batch(integer,text,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='51769ce88266cd9ffc3fbdbcf23e99f08dbeb89577ba326dc18e6e596142d898' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.activate_program_award_expansion_batch(integer,text,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.admit_program_award_expansion_batch(integer,jsonb,text,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1b82de8bf491caa243c5bdbfa10c37d41e01f10260afa3aff811a091d8ffb305' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.admit_program_award_expansion_batch(integer,jsonb,text,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_publication(uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='aad8837222654d6d0e84dae2b1c54be1972a732caac8cc8ddd16eb57949116e2' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.get_program_award_expansion_publication(uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_candidate(text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='9c074e4741b93bb770f643e2f145825fd8231b7594267889e9a00c07bcfedeea' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_candidate(text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_get_form_authority(text,text,text,jsonb)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e9acf61df0f2fe9d2728ac9d9735d961de0ae96acf445750f3b25651ffcb546f' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_get_form_authority(text,text,text,jsonb)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_tracking_context(uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='623a5b96b51af98120ff1ab762f105fc1c4af3564df95025226c36fbd6084756' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Batch-three function authority changed: public.get_program_award_expansion_tracking_context(uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_follow_source(text,uuid,uuid,uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='b4cd6431c7432dae709203dd6d13530d66c1ce9fcd6e34681c37e558149f6116' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Batch-three function authority changed: private.program_award_expansion_follow_source(text,uuid,uuid,uuid)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='f2450fa7c5dce66d6eefa38c425d9ee771d77c494e595d633a1348bbf970ea85' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Batch-three function authority changed: public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)') and
  encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1ee024df84264916ebb921439ffc5b2ca546347c6d0589599a04fef9bc8bb7d3' and
  pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.proconfig is not distinct from array['search_path=""']::text[] and
  p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Batch-three function authority changed: public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)' using errcode='40001';end if;
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>35 or
 (select count(*) from public.program_award_expansion_admissions)<>10 or exists(select 1 from generate_series(1,2) previous(batch) where
 (select count(*) from public.program_award_expansion_admissions a where a.batch=previous.batch and a.status='active')<>5)
 then raise exception 'The accepted original25 and active first ten must be preserved.' using errcode='40001';end if;
 if (select encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_agg(private.program_award_expansion_candidate(r.cohort_key) order by r.launch_rank)),'UTF8'),'sha256'),'hex')
 from public.program_award_registry r where r.launch_rank between 26 and 35)<>'0dbfe89c9dc2d1b1e82398733e786dc080dc047ace7317e2c50224eda9b1ada4'
 then raise exception 'Accepted first ten candidate values changed.' using errcode='40001';end if;
 if (select count(*) from jsonb_array_elements('[{"cohort_key":"nih_oxcam","batch":3,"launch_rank":36,"canonical_shared_award_id":"dc1674f0-0bd2-4546-afc8-1034ea213274","canonical_name":"NIH Oxford-Cambridge Scholars Program","official_homepage":"https://oxcam.gpp.nih.gov/prospective-students","canonical_slug":"national-institutes-of-health-oxford-cambridge-scholars-program","source_urls":["https://oxcam.gpp.nih.gov/prospective-students","https://oxcam.gpp.nih.gov/prospective-students/how-apply"]},{"cohort_key":"fait","batch":3,"launch_rank":37,"canonical_shared_award_id":"fe11c501-8d14-41bf-8cc8-a7a2edb2ca50","canonical_name":"Foreign Affairs Information Technology (FAIT) Fellowship","official_homepage":"https://www.faitfellowship.org/fellowship/","canonical_slug":"foreign-affairs-information-technology-fellowship","source_urls":["https://www.faitfellowship.org/fellowship/","https://www.faitfellowship.org/fellowship/eligibility-requirements/","https://www.faitfellowship.org/fellowship/u-s-department-of-state-clearance-processes/","https://www.faitfellowship.org/frequently-asked-questions/","https://www.faitfellowship.org/how-to-apply/"]},{"cohort_key":"princeton_asia","batch":3,"launch_rank":38,"canonical_shared_award_id":"d80105aa-41c2-454d-9afa-a8639d63ce0a","canonical_name":"Princeton in Asia Fellowships","official_homepage":"https://www.princetoninasia.org/fellowships","canonical_slug":"princeton-in-asia-fellowship","source_urls":["https://www.princetoninasia.org/fellowship-applications","https://www.princetoninasia.org/fellowship-eligibility","https://www.princetoninasia.org/fellowship-faq","https://www.princetoninasia.org/fellowships"]},{"cohort_key":"blakemore_freeman","batch":3,"launch_rank":39,"canonical_shared_award_id":"f7cea269-67b7-4372-bd68-4a995c096db4","canonical_name":"Blakemore Freeman Fellowships","official_homepage":"https://www.blakemorefoundation.org/fellowships","canonical_slug":"blakemore-freeman-fellowship","source_urls":["https://www.blakemorefoundation.org/fellowships","https://www.blakemorefoundation.org/language-programs"]},{"cohort_key":"princeton_africa","batch":3,"launch_rank":40,"canonical_shared_award_id":"ecc92ab9-beac-4771-8bd4-c7e305519dfc","canonical_name":"Princeton in Africa Fellowships","official_homepage":"https://www.princetoninafrica.org/applicants/how-to-apply/","canonical_slug":"princeton-in-africa-fellowship","source_urls":["https://www.princetoninafrica.org/applicants/frequently-asked-questions/","https://www.princetoninafrica.org/applicants/how-to-apply/","https://www.princetoninafrica.org/nexus/"]}]'::jsonb) c where private.program_award_expansion_candidate(c->>'cohort_key')=c)<>5
 or private.program_award_expansion_candidate('unreviewed_batch_four') is not null then raise exception 'Only the exact reviewed next five may be admitted.' using errcode='40001';end if;
end;$batch_three_postconditions$;
notify pgrst,'reload schema';
