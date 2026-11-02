-- Exactly ten reviewed additions in two bounded batches. Structural preparation ONLY.
do $next_ten_pre$ begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_candidate(text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='d7530eaf4026b46265f072886cd80bd7905792d198a6a29a9d2c00aa3cd3ecdb' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='i' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_candidate' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_follow_source(text,uuid,uuid,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1ffea04e48927e761b9b9740a4eaeb7b4d31ffbc17a3833d44e2240a96a15f9c' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_follow_source' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_get_form_authority(text,text,text,jsonb)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e9acf61df0f2fe9d2728ac9d9735d961de0ae96acf445750f3b25651ffcb546f' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='i' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_get_form_authority' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_initial_ready(text,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='0ba18b32cb7c3dddb0c0b054df68a1927af90119d143ea08f34edf4c10adcb81' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_initial_ready' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_source_boundary(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='22ef90bb752c0eb505b99919215592810717c9a487e1c6dde43d4648921b07cf' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_source_boundary' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_source_proof(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='a66e722a6887d86005cb0cb865033d525d2ffe82137fa11233d36d3150b04933' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_source_proof' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.activate_program_award_expansion_batch(integer,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='077f9b61afeab1b5334cccaa319580d4f93b69a2ea1e116d89ec7bf3daed0655' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: activate_program_award_expansion_batch' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.admit_program_award_expansion_batch(integer,jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='563f4aff0732a41ab8414235d5dd2f5132ab200b00a085a8f05aa96e6dded9c6' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: admit_program_award_expansion_batch' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.create_program_award_expansion_batch_five_owners(jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='560ac045fedb2fbeb1a38f1d5184697fe49376edf27ce6e1e3d27f57ade5b8f2' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: create_program_award_expansion_batch_five_owners' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.create_program_award_expansion_batch_four_owners(jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='5cf2fbf5e370263a93e07a3afb6ff4f54c25db52fa70f967b59c4bd061237e89' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: create_program_award_expansion_batch_four_owners' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_identities(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='d276bf6f177bd19475b40009e4838ae59504d7a64a403cf2bfba6ab6b91522c6' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_identities' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_publication(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e9c93bd73186e61c6fd82644a047fa3a956849a1aa0f783b2609655871fe8f47' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_publication' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_tracking_context(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='ede6a0a7524b63e3808d8eef4a8fd0058836fc0e95f9469e18f78a4e58ef4a80' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_tracking_context' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='f5d9357548e0fafcabcb92720357d4f706c712eabbf474e0f0c420452c7de978' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Reviewed expansion authority changed: track_office_program_expansion_atomic' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1ee024df84264916ebb921439ffc5b2ca546347c6d0589599a04fef9bc8bb7d3' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Reviewed expansion authority changed: untrack_office_program_expansion_atomic' using errcode='40001';end if;
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>50 or (select count(*) from public.program_award_expansion_admissions)<>25 or exists(select 1 from generate_series(1,5) b(batch) where (select count(*) from public.program_award_expansion_admissions a where a.batch=b.batch and a.status='active')<>5) then raise exception 'Preserve all50 and five active expansion batches.' using errcode='40001';end if;
 if (select encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_agg(private.program_award_expansion_candidate(r.cohort_key) order by r.launch_rank)),'UTF8'),'sha256'),'hex') from public.program_award_registry r where r.launch_rank between 26 and 50)<>'b932d9905ec08245ad9fd4aa205a887557bbaf125914c703fb596179a43b3e9e' then raise exception 'Accepted25 candidates changed.' using errcode='40001';end if;
 if pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conrelid='public.program_award_registry'::regclass and conname='program_award_registry_launch_rank_check')) is distinct from 'CHECK (((launch_rank >= 1) AND (launch_rank <= 50)))' or pg_get_constraintdef((select oid from pg_catalog.pg_constraint where conrelid='public.program_award_expansion_admissions'::regclass and conname='program_award_expansion_admissions_batch_check')) is distinct from 'CHECK ((batch = ANY (ARRAY[1, 2, 3, 4, 5])))' or to_regprocedure('public.create_program_award_expansion_batch_six_owners(jsonb,text,text)') is not null then raise exception 'Reviewed structural boundaries changed.' using errcode='40001';end if;
end;$next_ten_pre$;
alter table public.program_award_registry drop constraint program_award_registry_launch_rank_check;
alter table public.program_award_registry add constraint program_award_registry_launch_rank_check check(launch_rank between 1 and 60);
alter table public.program_award_expansion_admissions drop constraint program_award_expansion_admissions_batch_check;
alter table public.program_award_expansion_admissions add constraint program_award_expansion_admissions_batch_check check(batch in (1,2,3,4,5,6,7));
CREATE OR REPLACE FUNCTION private.program_award_expansion_candidate(p_cohort text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 select value from jsonb_array_elements($candidates$[{"batch":1,"cohort_key":"ppia_jsi","launch_rank":26,"source_urls":["https://www.ppiaprogram.org/","https://www.ppiaprogram.org/JSI"],"canonical_name":"Public Policy & International Affairs (PPIA) Junior Summer Institute","canonical_slug":"public-policy-and-international-affairs-junior-summer-institute","official_homepage":"https://www.ppiaprogram.org/JSI","canonical_shared_award_id":"874d043a-3819-4032-a7c4-bb9582a1d51f"},{"batch":1,"cohort_key":"daad_rise","launch_rank":27,"source_urls":["https://www.daad.de/rise/en/rise-germany/","https://www.daad.de/rise/en/rise-germany/find-an-internship/application-portal/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/faq/"],"canonical_name":"DAAD RISE Germany","canonical_slug":"daad-rise","official_homepage":"https://www.daad.de/rise/en/rise-germany/","canonical_shared_award_id":"4a862735-6d67-4154-81ad-4bcc51ad0ec1"},{"batch":1,"cohort_key":"tillman","launch_rank":28,"source_urls":["https://pattillmanfoundation.org/apply/","https://pattillmanfoundation.org/eligibility-and-compensation/","https://pattillmanfoundation.org/frequently-asked-questions/","https://pattillmanfoundation.org/scholar-benefits/"],"canonical_name":"Tillman Scholars Program","canonical_slug":"tillman-scholars-program","official_homepage":"https://pattillmanfoundation.org/apply/","canonical_shared_award_id":"cb8740aa-4585-4e1c-a939-35fc854cb12b"},{"batch":1,"cohort_key":"freeman_asia","launch_rank":29,"source_urls":["https://www.iie.org/programs/freeman-asia/","https://www.iie.org/programs/freeman-asia/about/award-details/","https://www.iie.org/programs/freeman-asia/apply/","https://www.iie.org/programs/freeman-asia/eligibility/"],"canonical_name":"Freeman-ASIA Award","canonical_slug":"freeman-asia-award","official_homepage":"https://www.iie.org/programs/freeman-asia/","canonical_shared_award_id":"06713967-eaf6-49cf-aa8d-a12d6cf1ab51"},{"batch":1,"cohort_key":"james_madison","launch_rank":30,"source_urls":["https://www.jamesmadison.gov/","https://www.jamesmadison.gov/fellowship-information/faq","https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility"],"canonical_name":"James Madison Memorial Fellowship","canonical_slug":"james-madison-memorial-fellowship","official_homepage":"https://www.jamesmadison.gov/","canonical_shared_award_id":"592d1ab0-7eff-402a-82ba-90d19559aa7f"},{"batch":2,"cohort_key":"rangel","launch_rank":31,"source_urls":["https://rangelprogram.org/graduate-fellowship-program/","https://rangelprogram.org/graduate-fellowship-program/application-requirements/","https://rangelprogram.org/graduate-fellowship-program/faqs/","https://rangelprogram.org/graduate-fellowship-program/overview-eligibility/","https://rangelprogram.org/graduate-fellowship-program/university-partners/"],"canonical_name":"Charles B. Rangel International Affairs Fellowship","canonical_slug":"charles-b-rangel-international-affairs-fellowship","official_homepage":"https://rangelprogram.org/graduate-fellowship-program/","canonical_shared_award_id":"e6ebd346-0567-4464-85b1-92a555036992"},{"batch":2,"cohort_key":"pickering","launch_rank":32,"source_urls":["https://pickeringfellowship.org/","https://pickeringfellowship.org/approvedprograms/","https://pickeringfellowship.org/how-to-apply/","https://pickeringfellowship.org/overview-eligibility/","https://pickeringfellowship.org/overview-eligibility/faqs/"],"canonical_name":"Pickering Foreign Affairs Fellowship","canonical_slug":"pickering-foreign-affairs-fellowship","official_homepage":"https://pickeringfellowship.org/","canonical_shared_award_id":"06b39341-8489-4c72-a555-dfd96d336f4b"},{"batch":2,"cohort_key":"daad_study","launch_rank":33,"source_urls":["https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/","https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab=","https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200"],"canonical_name":"DAAD Study Scholarships","canonical_slug":"master-studies-for-all-academic-disciplines","official_homepage":"https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200","canonical_shared_award_id":"440d6985-ece9-48c4-ac30-65a739f60d65"},{"batch":2,"cohort_key":"rotary_peace","launch_rank":34,"source_urls":["https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-certificate-program","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-masters-degree-programs"],"canonical_name":"Rotary Peace Fellowship","canonical_slug":"rotary-peace-fellowship","official_homepage":"https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","canonical_shared_award_id":"4f66e3fa-3924-4d0d-a04d-a32989f74c2e"},{"batch":2,"cohort_key":"voyager","launch_rank":35,"source_urls":["https://www.obama.org/programs/voyager-scholarship/","https://www.obama.org/programs/voyager-scholarship/faq/"],"canonical_name":"The Voyager Scholarship","canonical_slug":"the-voyager-scholarship","official_homepage":"https://www.obama.org/programs/voyager-scholarship/","canonical_shared_award_id":"10dda818-c922-47ac-8b56-55494c2c889f"},{"batch":3,"cohort_key":"nih_oxcam","launch_rank":36,"source_urls":["https://oxcam.gpp.nih.gov/prospective-students","https://oxcam.gpp.nih.gov/prospective-students/how-apply"],"canonical_name":"NIH Oxford-Cambridge Scholars Program","canonical_slug":"national-institutes-of-health-oxford-cambridge-scholars-program","official_homepage":"https://oxcam.gpp.nih.gov/prospective-students","canonical_shared_award_id":"dc1674f0-0bd2-4546-afc8-1034ea213274"},{"batch":3,"cohort_key":"fait","launch_rank":37,"source_urls":["https://www.faitfellowship.org/fellowship/","https://www.faitfellowship.org/fellowship/eligibility-requirements/","https://www.faitfellowship.org/fellowship/u-s-department-of-state-clearance-processes/","https://www.faitfellowship.org/frequently-asked-questions/","https://www.faitfellowship.org/how-to-apply/"],"canonical_name":"Foreign Affairs Information Technology (FAIT) Fellowship","canonical_slug":"foreign-affairs-information-technology-fellowship","official_homepage":"https://www.faitfellowship.org/fellowship/","canonical_shared_award_id":"fe11c501-8d14-41bf-8cc8-a7a2edb2ca50"},{"batch":3,"cohort_key":"princeton_asia","launch_rank":38,"source_urls":["https://www.princetoninasia.org/fellowship-applications","https://www.princetoninasia.org/fellowship-eligibility","https://www.princetoninasia.org/fellowship-faq","https://www.princetoninasia.org/fellowships"],"canonical_name":"Princeton in Asia Fellowships","canonical_slug":"princeton-in-asia-fellowship","official_homepage":"https://www.princetoninasia.org/fellowships","canonical_shared_award_id":"d80105aa-41c2-454d-9afa-a8639d63ce0a"},{"batch":3,"cohort_key":"blakemore_freeman","launch_rank":39,"source_urls":["https://www.blakemorefoundation.org/fellowships","https://www.blakemorefoundation.org/language-programs"],"canonical_name":"Blakemore Freeman Fellowships","canonical_slug":"blakemore-freeman-fellowship","official_homepage":"https://www.blakemorefoundation.org/fellowships","canonical_shared_award_id":"f7cea269-67b7-4372-bd68-4a995c096db4"},{"batch":3,"cohort_key":"princeton_africa","launch_rank":40,"source_urls":["https://www.princetoninafrica.org/applicants/frequently-asked-questions/","https://www.princetoninafrica.org/applicants/how-to-apply/","https://www.princetoninafrica.org/nexus/"],"canonical_name":"Princeton in Africa Fellowships","canonical_slug":"princeton-in-africa-fellowship","official_homepage":"https://www.princetoninafrica.org/applicants/how-to-apply/","canonical_shared_award_id":"ecc92ab9-beac-4771-8bd4-c7e305519dfc"},{"batch":4,"cohort_key":"astronaut","launch_rank":41,"source_urls":["https://www.astronautscholarship.org/assets/2026-major-fields-of-study.pdf","https://www.astronautscholarship.org/programs/astronaut-scholarship/","https://www.astronautscholarship.org/universities/university-partners/"],"canonical_name":"Astronaut Scholarship","canonical_slug":"astronaut-scholarship","official_homepage":"https://www.astronautscholarship.org/programs/astronaut-scholarship/","canonical_shared_award_id":"9880eddb-203a-4474-88b1-a3a877b398a3"},{"batch":4,"cohort_key":"watson","launch_rank":42,"source_urls":["https://watson.foundation/fellowships/tj","https://watson.foundation/fellowships/tj/faqs","https://watson.foundation/fellowships/tj/partners"],"canonical_name":"Thomas J. Watson Fellowship","canonical_slug":"watson-fellowship","official_homepage":"https://watson.foundation/fellowships/tj","canonical_shared_award_id":"80424f3b-1b94-4cb1-977c-b6cfdd5a8381"},{"batch":4,"cohort_key":"mccall_macbain","launch_rank":43,"source_urls":["https://mccallmacbainscholars.org/apply/","https://mccallmacbainscholars.org/faq/","https://mccallmacbainscholars.org/program/"],"canonical_name":"McCall MacBain Scholarships","canonical_slug":"mccall-macbain-scholarships","official_homepage":"https://mccallmacbainscholars.org/program/","canonical_shared_award_id":"109337e6-5309-4ac8-8647-1bb6c67e9b38"},{"batch":4,"cohort_key":"ellison_graduate","launch_rank":44,"source_urls":["https://eit.org/education-and-scholarships/faqs","https://eit.org/education-and-scholarships/graduate","https://eit.org/education-and-scholarships/graduate-research-areas"],"canonical_name":"Graduate Ellison Scholars","canonical_slug":"graduate-ellison-scholars","official_homepage":"https://eit.org/education-and-scholarships/graduate","canonical_shared_award_id":"3ed2ee95-7e6c-4f75-800e-6d42f5288dbb"},{"batch":4,"cohort_key":"rales","launch_rank":45,"source_urls":["https://www.cmu.edu/graduate/rales-fellows/","https://www.cmu.edu/graduate/rales-fellows/admission","https://www.cmu.edu/graduate/rales-fellows/faqs"],"canonical_name":"Carnegie Mellon Rales Fellows","canonical_slug":"carnegie-mellon-rales-fellows","official_homepage":"https://www.cmu.edu/graduate/rales-fellows/","canonical_shared_award_id":"56f2136d-1ecf-44e3-be75-61e49c93f571"},{"batch":5,"cohort_key":"doe_csgf","launch_rank":46,"source_urls":["https://www.krellinst.org/csgf/","https://www.krellinst.org/csgf/about-doe-csgf/benefits-opportunities","https://www.krellinst.org/csgf/about-doe-csgf/eligibility-program-requirements","https://www.krellinst.org/csgf/how-apply"],"canonical_name":"DOE Computational Science Graduate Fellowship","canonical_slug":"doe-computational-science-graduate-fellowship","official_homepage":"https://www.krellinst.org/csgf/","canonical_shared_award_id":"cd2f7cf3-6751-4b42-8a23-891788da30e9"},{"batch":5,"cohort_key":"amgen_us","launch_rank":47,"source_urls":["https://amgenscholars.com/us-program/"],"canonical_name":"Amgen Scholars — U.S. Program","canonical_slug":"amgen-scholars-program","official_homepage":"https://amgenscholars.com/us-program/","canonical_shared_award_id":"9592a089-dd1d-4e5b-b7d1-74e766906830"},{"batch":5,"cohort_key":"fulbright_uk_summer","launch_rank":48,"source_urls":["https://fulbright.org.uk/our-programmes/undergraduate-and-pre-university-programmes/uk-summer-institutes/"],"canonical_name":"Fulbright UK Summer Institutes","canonical_slug":"fuksi","official_homepage":"https://fulbright.org.uk/our-programmes/undergraduate-and-pre-university-programmes/uk-summer-institutes/","canonical_shared_award_id":"797be24a-f4d7-45cc-8767-9f0bc2453599"},{"batch":5,"cohort_key":"suli","launch_rank":49,"source_urls":["https://science.osti.gov/wdts/suli","https://science.osti.gov/wdts/suli/Benefits","https://science.osti.gov/wdts/suli/Eligibility","https://science.osti.gov/wdts/suli/Key-Dates"],"canonical_name":"DOE Science Undergraduate Laboratory Internships (SULI)","canonical_slug":"suli","official_homepage":"https://science.osti.gov/wdts/suli","canonical_shared_award_id":"5a47fc09-4d3a-47b5-8a9a-6fd4a4031a56"},{"batch":5,"cohort_key":"chevening","launch_rank":50,"source_urls":["https://chevening.org/resource-hub/guidance/eligibility/","https://www.chevening.org/apply/","https://www.chevening.org/scholarships/","https://www.chevening.org/scholarships/application-timeline/","https://www.chevening.org/scholarships/who-can-apply/"],"canonical_name":"Chevening Scholarships","canonical_slug":"chevening-scholarships","official_homepage":"https://www.chevening.org/scholarships/","canonical_shared_award_id":"60d68065-a9ee-4ef5-9096-1467c299538e"},{"cohort_key":"michel_david_weill","batch":6,"launch_rank":51,"canonical_shared_award_id":"26a0ac65-4d92-4974-a2bc-f5c6342127d3","canonical_name":"Michel David-Weill Scholarship","canonical_slug":"michel-david-weill-scholarship","official_homepage":"https://www.sciencespo.fr/students/en/fees-funding/bursaries-financial-aid/david-weill-scholarship/","source_urls":["https://www.sciencespo.fr/students/en/fees-funding/bursaries-financial-aid/david-weill-scholarship/"]},{"cohort_key":"ertegun","batch":6,"launch_rank":52,"canonical_shared_award_id":"df1c758d-595f-47fc-a2ac-33b27c2217f9","canonical_name":"Ertegun Graduate Scholarship Programme in the Humanities","canonical_slug":"ertegun-graduate-scholarship-programme-in-the-humanities","official_homepage":"https://www.ertegun.ox.ac.uk/","source_urls":["https://www.ertegun.ox.ac.uk/","https://www.ertegun.ox.ac.uk/scholarships"]},{"cohort_key":"eth_esop","batch":6,"launch_rank":53,"canonical_shared_award_id":"06bc1a46-84be-44cb-b26c-c16e627da468","canonical_name":"ETH Zurich Excellence Scholarship & Opportunity Programme","canonical_slug":"eth-zurich-excellence-scholarship-opportunity-programme","official_homepage":"https://ethz.ch/students/en/studies/financial/scholarships/excellencescholarship.html","source_urls":["https://ethz.ch/students/en/studies/financial/scholarships/excellencescholarship.html"]},{"cohort_key":"nnsa_ssgf","batch":6,"launch_rank":54,"canonical_shared_award_id":"f71f5cb2-5c3f-4d6e-a7e2-db0452e24bfa","canonical_name":"DOE NNSA Stockpile Science Graduate Fellowship","canonical_slug":"ssgf","official_homepage":"https://www.krellinst.org/ssgf/","source_urls":["https://www.krellinst.org/ssgf/","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/benefits-opportunities","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/eligibility-program-requirements","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/fields-study","https://www.krellinst.org/ssgf/how-apply"]},{"cohort_key":"cbyx_young_professionals","batch":6,"launch_rank":55,"canonical_shared_award_id":"c7194f44-c221-4cb7-a625-a718fae92011","canonical_name":"Congress-Bundestag Youth Exchange for Young Professionals","canonical_slug":"congress-bundestag-youth-exchange-for-young-professionals","official_homepage":"https://culturalvistas.org/our-programs/internships-fellowships/congress-bundestag-youth-exchange-for-young-professionals-cbyx","source_urls":["https://culturalvistas.org/our-programs/internships-fellowships/congress-bundestag-youth-exchange-for-young-professionals-cbyx"]},{"cohort_key":"daad_summer","batch":7,"launch_rank":56,"canonical_shared_award_id":"a122feec-a344-40f2-bd0b-1f1d5967f8fb","canonical_name":"DAAD University Summer Course Grant","canonical_slug":"university-summer-course-grant","official_homepage":"https://www.daad.org/en/find-funding/scholarship-database/?detail_to_show=0&detail_to_show=50035295&onlydaad=1&origin=44&pg=2&q=&status=0&subject=0&target=44&type=a","source_urls":["https://www.daad.org/en/find-funding/scholarship-database/?detail_to_show=0&detail_to_show=50035295&onlydaad=1&origin=44&pg=2&q=&status=0&subject=0&target=44&type=a"]},{"cohort_key":"princeton_latin_america","batch":7,"launch_rank":57,"canonical_shared_award_id":"99e55844-4652-4014-ac8a-50ac46a1306b","canonical_name":"Princeton in Latin America Fellowship","canonical_slug":"princeton-in-latin-america-fellowship","official_homepage":"https://princetoninlatinamerica.org/","source_urls":["https://princetoninlatinamerica.org/","https://princetoninlatinamerica.org/apply","https://princetoninlatinamerica.org/how-apply"]},{"cohort_key":"quad","batch":7,"launch_rank":58,"canonical_shared_award_id":"191aefc3-b4d8-4792-b53b-2511afeb36d9","canonical_name":"Quad Fellowship","canonical_slug":"the-quad-fellowship","official_homepage":"https://www.quadfellowship.org/","source_urls":["https://www.quadfellowship.org/","https://www.quadfellowship.org/apply"]},{"cohort_key":"nnsa_lrgf","batch":7,"launch_rank":59,"canonical_shared_award_id":"798ed087-dbe4-4e8f-b1ea-1b84aaae6e82","canonical_name":"DOE NNSA Laboratory Residency Graduate Fellowship","canonical_slug":"laboratory-residency-graduate-fellowship-doe-nnsa-lrgf","official_homepage":"https://www.krellinst.org/lrgf/","source_urls":["https://www.krellinst.org/lrgf/","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/benefits-opportunities","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/eligibility-program-requirements","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/fields-study","https://www.krellinst.org/lrgf/how-apply"]},{"cohort_key":"projects_for_peace","batch":7,"launch_rank":60,"canonical_shared_award_id":"0859c2de-0f88-45b3-bd7b-98a404dbaf85","canonical_name":"Projects for Peace","canonical_slug":"projects-for-peace","official_homepage":"https://www.middlebury.edu/projects-for-peace","source_urls":["https://www.middlebury.edu/projects-for-peace","https://www.middlebury.edu/projects-for-peace/summer-grants","https://www.middlebury.edu/projects-for-peace/summer-grants/guidance"]}]$candidates$::jsonb) where value->>'cohort_key'=p_cohort;
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
 if p_batch not in (1,2,3,4,5,6,7) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
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
 if (select count(*) from public.program_award_expansion_admissions)+5>35 then raise exception 'Expansion is bounded to thirty-five awards.' using errcode='23514';end if;
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
 if p_batch not in(1,2,3,4,5,6,7) or not coalesce(p_expected_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
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
 with active_awards as materialized (
  select r as registry,a.source_ids,a.proof
  from public.program_award_expansion_admissions a
  join public.program_award_registry r on r.cohort_key=a.cohort_key
  where a.status='active' and a.epoch=p_epoch
 ), basic_snapshot as materialized (
  select public.get_program_basic_facts(array(
   select distinct (selected.registry).canonical_shared_award_id
   from active_awards selected order by (selected.registry).canonical_shared_award_id
  )) as facts
  where exists(select 1 from active_awards)
 )
 select coalesce(jsonb_agg(jsonb_build_object('registry',to_jsonb(selected.registry),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.program_award_members m where m.cohort_key=(selected.registry).cohort_key),
  'source_ids',selected.source_ids,'reviewed_homepage',jsonb_build_object('source_id',
   (select q->>'id' from jsonb_array_elements(selected.proof->'sources') q where q->>'url'=(selected.registry).official_homepage),
   'url',(selected.registry).official_homepage),
  'basic_fact',(select value from jsonb_array_elements(basics.facts)
   where value->>'cohort_key'=(selected.registry).cohort_key
    and value->>'award_id'=(selected.registry).canonical_shared_award_id::text))
  order by (selected.registry).launch_rank),'[]'::jsonb) into result
 from active_awards selected cross join basic_snapshot basics;
 if jsonb_array_length(result) not in(0,5,10,15,20,25,30,35) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-publication.v1','epoch',p_epoch,'awards',result);
end;$function$;

CREATE OR REPLACE FUNCTION public.get_program_award_expansion_identities(p_epoch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_epoch is null or not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
 then raise exception 'The current monitoring epoch is required.' using errcode='40001';end if;
 select coalesce(jsonb_agg(jsonb_build_object('registry',to_jsonb(r),
  'members',(select jsonb_agg(to_jsonb(m) order by m.shared_award_id) from public.program_award_members m where m.cohort_key=r.cohort_key),
  'source_ids',a.source_ids,'reviewed_homepage',jsonb_build_object('source_id',
   (select q->>'id' from jsonb_array_elements(a.proof->'sources') q where q->>'url'=r.official_homepage),'url',r.official_homepage))
  order by r.launch_rank),'[]'::jsonb) into result
 from public.program_award_expansion_admissions a join public.program_award_registry r on r.cohort_key=a.cohort_key
 where a.status='active' and a.epoch=p_epoch;
 if jsonb_array_length(result) not in(0,5,10,15,20,25,30,35) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-identities.v1','epoch',p_epoch,'awards',result);
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
 and r.launch_rank between 26 and 60 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended'
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
 where registry.canonical_shared_award_id=p_shared_award_id and registry.launch_rank between 26 and 60
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
 and r.launch_rank between 26 and 60 and r.policy_version='program-basic-expansion-v1' and r.publication_state<>'suspended' for share;
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

CREATE OR REPLACE FUNCTION public.create_program_award_expansion_batch_six_owners(p_plan jsonb, p_plan_hash text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare fixed jsonb:='[{"cohort_key":"eth_esop","id":"06bc1a46-84be-44cb-b26c-c16e627da468","name":"ETH Zurich Excellence Scholarship & Opportunity Programme","slug":"eth-zurich-excellence-scholarship-opportunity-programme","search_key":"eth zurich excellence scholarship and opportunity programme","official_homepage":"https://ethz.ch/students/en/studies/financial/scholarships/excellencescholarship.html"},{"cohort_key":"projects_for_peace","id":"0859c2de-0f88-45b3-bd7b-98a404dbaf85","name":"Projects for Peace","slug":"projects-for-peace","search_key":"projects for peace","official_homepage":"https://www.middlebury.edu/projects-for-peace"},{"cohort_key":"michel_david_weill","id":"26a0ac65-4d92-4974-a2bc-f5c6342127d3","name":"Michel David-Weill Scholarship","slug":"michel-david-weill-scholarship","search_key":"michel david-weill scholarship","official_homepage":"https://www.sciencespo.fr/students/en/fees-funding/bursaries-financial-aid/david-weill-scholarship/"}]'::jsonb;v_owner jsonb;v_existing integer;v_exact integer;v_now timestamptz:=clock_timestamp();
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if not coalesce(private.awardping_program_exact_object(p_plan,array['schema','batch','reviewed_at','owners']),false)
 or p_plan->>'schema' is distinct from 'awardping.batch6-owner-creation-plan.v1' or p_plan->'batch' is distinct from '6'::jsonb
 or p_plan->'owners' is distinct from fixed or jsonb_typeof(p_plan->'reviewed_at') is distinct from 'string'
 or not coalesce((p_plan->>'reviewed_at')::timestamptz between v_now-interval '15 minutes' and v_now,false)
 or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
 or encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(p_plan),'UTF8'),'sha256'),'hex') is distinct from p_plan_hash
 then raise exception 'An exact fresh reviewed blank-owner plan is required.' using errcode='23514';end if;
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>50
 or (select count(*) from public.program_award_expansion_admissions)<>25 or exists(select 1 from generate_series(1,5) prior_batch(batch)
 where (select count(*) from public.program_award_expansion_admissions admission where admission.batch=prior_batch.batch and admission.status='active')<>5)
 then raise exception 'Preserve the accepted50 and all five active prior batches before creating the selected blank owners.' using errcode='40001';end if;

 -- Check the reviewed insert behavior. No UPDATE path or old-owner alias exists.
 if (select relacl::text from pg_catalog.pg_class where oid='public.shared_awards'::regclass) is distinct from '{postgres=arwdDxtm/postgres,service_role=arwdxm/postgres}'
 or (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='public.shared_awards'::regclass and not t.tgisinternal and (t.tgtype::integer&4)<>0)<>1
 or not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.shared_awards'::regclass and not t.tgisinternal and
  t.tgname='set_shared_award_slug' and t.tgtype=23 and t.tgenabled='O' and t.tgfoid='public.set_shared_award_slug()'::regprocedure and
  t.tgnargs=0 and octet_length(t.tgargs)=0 and t.tgqual is null and t.tgconstraint=0 and
  (select array_agg(attribute.attname::text order by column_number.ordinality) from unnest(t.tgattr::smallint[]) with ordinality column_number(attnum,ordinality)
   join pg_catalog.pg_attribute attribute on attribute.attrelid=t.tgrelid and attribute.attnum=column_number.attnum and not attribute.attisdropped)
  is not distinct from array['name','slug']::text[])
 or encode(extensions.digest(convert_to(pg_get_functiondef('public.set_shared_award_slug()'::regprocedure),'UTF8'),'sha256'),'hex')<>'24d3c1d71c4527c0d9ba704a277f553919d41e8ee1a9ceac9f42713cb3c23ef8'
 then raise exception 'Reviewed blank-owner insertion authority changed.' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_index i where i.indexrelid=to_regclass('public.shared_awards_pkey') and i.indisunique and i.indisvalid and i.indisready and pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX shared_awards_pkey ON public.shared_awards USING btree (id)') then raise exception 'Reviewed owner uniqueness changed: shared_awards_pkey' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_index i where i.indexrelid=to_regclass('public.shared_awards_search_key_key') and i.indisunique and i.indisvalid and i.indisready and pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX shared_awards_search_key_key ON public.shared_awards USING btree (search_key)') then raise exception 'Reviewed owner uniqueness changed: shared_awards_search_key_key' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_index i where i.indexrelid=to_regclass('public.shared_awards_slug_key') and i.indisunique and i.indisvalid and i.indisready and pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX shared_awards_slug_key ON public.shared_awards USING btree (slug) WHERE (slug IS NOT NULL)') then raise exception 'Reviewed owner uniqueness changed: shared_awards_slug_key' using errcode='40001';end if;

 -- A short table lock closes the absent-row / slug-trigger race for only the selected
 -- identity inserts. It never changes rows belonging to any existing program.
 lock table public.shared_awards in share row exclusive mode;
 select count(*) into v_existing from public.shared_awards existing where existing.id in(select (o->>'id')::uuid from jsonb_array_elements(fixed) o);
 if v_existing<>0 then
  select count(*) into v_exact from jsonb_array_elements(fixed) o join public.shared_awards existing on existing.id=(o->>'id')::uuid
  where existing.name=o->>'name' and existing.slug=o->>'slug' and existing.search_key=o->>'search_key' and existing.official_homepage=o->>'official_homepage'
  and existing.source='admin' and existing.status='active' and existing.confidence=0 and existing.summary is null and existing.public_facts='{}'::jsonb
  and existing.public_facts_generated_at is null and existing.public_facts_model is null and existing.submitted_by_user_id is null
  and not exists(select 1 from public.program_award_members member where member.shared_award_id=existing.id)
  and not exists(select 1 from public.shared_award_sources source where source.shared_award_id=existing.id);
  if v_existing=3 and v_exact=3 then return jsonb_build_object('schema','awardping.batch6-owner-creation-receipt.v1','ok',true,'already_applied',true,'owners',fixed,'plan_hash',p_plan_hash,'actor',btrim(p_actor));end if;
  raise exception 'Planned owner identity already exists or has acquired history; inspect without modifying it.' using errcode='40001';
 end if;
 for v_owner in select value from jsonb_array_elements(fixed) loop
  if exists(select 1 from public.shared_awards existing where existing.search_key=v_owner->>'search_key' or existing.slug=v_owner->>'slug'
   or lower(btrim(existing.name))=lower(btrim(v_owner->>'name')) or
   lower(rtrim(split_part(existing.official_homepage,'#',1),'/'))=lower(rtrim(split_part(v_owner->>'official_homepage','#',1),'/')))
  then raise exception 'A canonical owner name, slug, search key or exact homepage collision requires review.' using errcode='40001';end if;
 end loop;
 insert into public.shared_awards(id,search_key,name,official_homepage,slug,status,source,summary,confidence,public_facts,public_facts_generated_at,public_facts_model,submitted_by_user_id)
 select (o->>'id')::uuid,o->>'search_key',o->>'name',o->>'official_homepage',o->>'slug','active','admin',null,0,'{}'::jsonb,null,null,null from jsonb_array_elements(fixed) o;
 select count(*) into v_exact from jsonb_array_elements(fixed) o join public.shared_awards inserted on inserted.id=(o->>'id')::uuid
 where inserted.name=o->>'name' and inserted.slug=o->>'slug' and inserted.search_key=o->>'search_key' and inserted.official_homepage=o->>'official_homepage'
 and inserted.source='admin' and inserted.status='active' and inserted.confidence=0 and inserted.summary is null and inserted.public_facts='{}'::jsonb
 and inserted.public_facts_generated_at is null and inserted.public_facts_model is null and inserted.submitted_by_user_id is null;
 if v_exact<>3 then raise exception 'Insert trigger changed a planned identity; the entire blank-owner operation is rolled back.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.batch6-owner-creation-receipt.v1','ok',true,'already_applied',false,'owners',fixed,'plan_hash',p_plan_hash,'actor',btrim(p_actor),'created_at',v_now);
end;
$function$;
revoke all on function public.create_program_award_expansion_batch_six_owners(jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.create_program_award_expansion_batch_six_owners(jsonb,text,text) to service_role;
do $next_ten_post$ begin
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_candidate(text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='60c41f36103ec3b262853f5cdc2dd3f447f66a5191cc8e6a0401b771acd60431' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='i' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_candidate' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_follow_source(text,uuid,uuid,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='4e385b656202043d793955572a9bc49aa6dddf7927539e273eb7f54a09889fd1' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_follow_source' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_get_form_authority(text,text,text,jsonb)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e9acf61df0f2fe9d2728ac9d9735d961de0ae96acf445750f3b25651ffcb546f' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='i' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_get_form_authority' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_initial_ready(text,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='0ba18b32cb7c3dddb0c0b054df68a1927af90119d143ea08f34edf4c10adcb81' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_initial_ready' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_source_boundary(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='22ef90bb752c0eb505b99919215592810717c9a487e1c6dde43d4648921b07cf' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_source_boundary' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('private.program_award_expansion_source_proof(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='a66e722a6887d86005cb0cb865033d525d2ffe82137fa11233d36d3150b04933' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: program_award_expansion_source_proof' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.activate_program_award_expansion_batch(integer,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='f6b5a70b341792edfbf8e819eb5cb3f560c991053e25284b5fac6113f425e2ce' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: activate_program_award_expansion_batch' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.admit_program_award_expansion_batch(integer,jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='8a16fb404cb9b6a149709b31aa938243a3641be06faaa9b0e92ac85895dfb2b5' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: admit_program_award_expansion_batch' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.create_program_award_expansion_batch_five_owners(jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='560ac045fedb2fbeb1a38f1d5184697fe49376edf27ce6e1e3d27f57ade5b8f2' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: create_program_award_expansion_batch_five_owners' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.create_program_award_expansion_batch_four_owners(jsonb,text,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='5cf2fbf5e370263a93e07a3afb6ff4f54c25db52fa70f967b59c4bd061237e89' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: create_program_award_expansion_batch_four_owners' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_identities(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='5b5f8f554c6e8df942b70a9e854b0cbabbc1e93c4858d38fa53ed4b7281dc757' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=false and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_identities' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_publication(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='0986d03574c9a37004c07f20f8766e9e3ef563f7388f45d2d3867a293d899f68' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_publication' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.get_program_award_expansion_tracking_context(uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='e198cd78b1c517d09abf4d14cf31bb0c222db5571c604739ce17e2d3ae8e1190' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='s' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}') then raise exception 'Reviewed expansion authority changed: get_program_award_expansion_tracking_context' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.track_office_program_expansion_atomic(uuid,text,uuid,uuid,jsonb,text)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='b91dce0d6a718fd06054be74b9b832aba3f88f6f77b55575a6bf9e95665284a2' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Reviewed expansion authority changed: track_office_program_expansion_atomic' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.untrack_office_program_expansion_atomic(uuid,text,uuid,uuid,uuid)') and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='1ee024df84264916ebb921439ffc5b2ca546347c6d0589599a04fef9bc8bb7d3' and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef=true and p.provolatile::text='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'Reviewed expansion authority changed: untrack_office_program_expansion_atomic' using errcode='40001';end if;
 if (select count(*) from public.stage1_award_registry)<>25 or (select count(*) from public.program_award_registry)<>50 or (select count(*) from public.program_award_expansion_admissions)<>25 or exists(select 1 from generate_series(1,5) b(batch) where (select count(*) from public.program_award_expansion_admissions a where a.batch=b.batch and a.status='active')<>5) then raise exception 'Preserve all50 and five active expansion batches.' using errcode='40001';end if;
 if (select encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(jsonb_agg(private.program_award_expansion_candidate(r.cohort_key) order by r.launch_rank)),'UTF8'),'sha256'),'hex') from public.program_award_registry r where r.launch_rank between 26 and 50)<>'b932d9905ec08245ad9fd4aa205a887557bbaf125914c703fb596179a43b3e9e' then raise exception 'Accepted25 candidates changed.' using errcode='40001';end if;
 if (select count(*) from jsonb_array_elements('[{"cohort_key":"michel_david_weill","batch":6,"launch_rank":51,"canonical_shared_award_id":"26a0ac65-4d92-4974-a2bc-f5c6342127d3","canonical_name":"Michel David-Weill Scholarship","canonical_slug":"michel-david-weill-scholarship","official_homepage":"https://www.sciencespo.fr/students/en/fees-funding/bursaries-financial-aid/david-weill-scholarship/","source_urls":["https://www.sciencespo.fr/students/en/fees-funding/bursaries-financial-aid/david-weill-scholarship/"]},{"cohort_key":"ertegun","batch":6,"launch_rank":52,"canonical_shared_award_id":"df1c758d-595f-47fc-a2ac-33b27c2217f9","canonical_name":"Ertegun Graduate Scholarship Programme in the Humanities","canonical_slug":"ertegun-graduate-scholarship-programme-in-the-humanities","official_homepage":"https://www.ertegun.ox.ac.uk/","source_urls":["https://www.ertegun.ox.ac.uk/","https://www.ertegun.ox.ac.uk/scholarships"]},{"cohort_key":"eth_esop","batch":6,"launch_rank":53,"canonical_shared_award_id":"06bc1a46-84be-44cb-b26c-c16e627da468","canonical_name":"ETH Zurich Excellence Scholarship & Opportunity Programme","canonical_slug":"eth-zurich-excellence-scholarship-opportunity-programme","official_homepage":"https://ethz.ch/students/en/studies/financial/scholarships/excellencescholarship.html","source_urls":["https://ethz.ch/students/en/studies/financial/scholarships/excellencescholarship.html"]},{"cohort_key":"nnsa_ssgf","batch":6,"launch_rank":54,"canonical_shared_award_id":"f71f5cb2-5c3f-4d6e-a7e2-db0452e24bfa","canonical_name":"DOE NNSA Stockpile Science Graduate Fellowship","canonical_slug":"ssgf","official_homepage":"https://www.krellinst.org/ssgf/","source_urls":["https://www.krellinst.org/ssgf/","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/benefits-opportunities","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/eligibility-program-requirements","https://www.krellinst.org/ssgf/about-doe-nnsa-ssgf/fields-study","https://www.krellinst.org/ssgf/how-apply"]},{"cohort_key":"cbyx_young_professionals","batch":6,"launch_rank":55,"canonical_shared_award_id":"c7194f44-c221-4cb7-a625-a718fae92011","canonical_name":"Congress-Bundestag Youth Exchange for Young Professionals","canonical_slug":"congress-bundestag-youth-exchange-for-young-professionals","official_homepage":"https://culturalvistas.org/our-programs/internships-fellowships/congress-bundestag-youth-exchange-for-young-professionals-cbyx","source_urls":["https://culturalvistas.org/our-programs/internships-fellowships/congress-bundestag-youth-exchange-for-young-professionals-cbyx"]},{"cohort_key":"daad_summer","batch":7,"launch_rank":56,"canonical_shared_award_id":"a122feec-a344-40f2-bd0b-1f1d5967f8fb","canonical_name":"DAAD University Summer Course Grant","canonical_slug":"university-summer-course-grant","official_homepage":"https://www.daad.org/en/find-funding/scholarship-database/?detail_to_show=0&detail_to_show=50035295&onlydaad=1&origin=44&pg=2&q=&status=0&subject=0&target=44&type=a","source_urls":["https://www.daad.org/en/find-funding/scholarship-database/?detail_to_show=0&detail_to_show=50035295&onlydaad=1&origin=44&pg=2&q=&status=0&subject=0&target=44&type=a"]},{"cohort_key":"princeton_latin_america","batch":7,"launch_rank":57,"canonical_shared_award_id":"99e55844-4652-4014-ac8a-50ac46a1306b","canonical_name":"Princeton in Latin America Fellowship","canonical_slug":"princeton-in-latin-america-fellowship","official_homepage":"https://princetoninlatinamerica.org/","source_urls":["https://princetoninlatinamerica.org/","https://princetoninlatinamerica.org/apply","https://princetoninlatinamerica.org/how-apply"]},{"cohort_key":"quad","batch":7,"launch_rank":58,"canonical_shared_award_id":"191aefc3-b4d8-4792-b53b-2511afeb36d9","canonical_name":"Quad Fellowship","canonical_slug":"the-quad-fellowship","official_homepage":"https://www.quadfellowship.org/","source_urls":["https://www.quadfellowship.org/","https://www.quadfellowship.org/apply"]},{"cohort_key":"nnsa_lrgf","batch":7,"launch_rank":59,"canonical_shared_award_id":"798ed087-dbe4-4e8f-b1ea-1b84aaae6e82","canonical_name":"DOE NNSA Laboratory Residency Graduate Fellowship","canonical_slug":"laboratory-residency-graduate-fellowship-doe-nnsa-lrgf","official_homepage":"https://www.krellinst.org/lrgf/","source_urls":["https://www.krellinst.org/lrgf/","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/benefits-opportunities","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/eligibility-program-requirements","https://www.krellinst.org/lrgf/about-doe-nnsa-lrgf/fields-study","https://www.krellinst.org/lrgf/how-apply"]},{"cohort_key":"projects_for_peace","batch":7,"launch_rank":60,"canonical_shared_award_id":"0859c2de-0f88-45b3-bd7b-98a404dbaf85","canonical_name":"Projects for Peace","canonical_slug":"projects-for-peace","official_homepage":"https://www.middlebury.edu/projects-for-peace","source_urls":["https://www.middlebury.edu/projects-for-peace","https://www.middlebury.edu/projects-for-peace/summer-grants","https://www.middlebury.edu/projects-for-peace/summer-grants/guidance"]}]'::jsonb) c where private.program_award_expansion_candidate(c->>'cohort_key')=c)<>10 then raise exception 'Exact ten candidate catalog mismatch.' using errcode='40001';end if;
 if not exists(select 1 from pg_catalog.pg_proc p where p.oid=to_regprocedure('public.create_program_award_expansion_batch_six_owners(jsonb,text,text)') and pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='v' and p.proconfig is not distinct from array['search_path=""']::text[] and p.proacl::text is not distinct from '{postgres=X/postgres,service_role=X/postgres}' and encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')='cfc0735827afe13dbd2c075ac7fd21e97677c422ba99c11c1b59009ad55ae733') then raise exception 'Fixed new owner authority mismatch.' using errcode='40001';end if;
end;$next_ten_post$;
