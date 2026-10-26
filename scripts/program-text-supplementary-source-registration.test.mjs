import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {parse} from "libpg-query";

const migrationName = "20261026163440_program_text_supplementary_source_registration.sql";
const sql=readFileSync(new URL("../supabase/migrations/"+migrationName,import.meta.url),"utf8");
const original=readFileSync(new URL("../supabase/migrations/20261025173726_program_text_source_registration.sql",import.meta.url),"utf8");
const ast=await parse(sql),originalAst=await parse(original);
const functionName=fn=>fn.funcname.map(x=>x.String.sval).join(".");
const option=(fn,name)=>fn.options.find(x=>x.DefElem.defname===name)?.DefElem.arg;
const body=fn=>option(fn,"as").List.items[0].String.sval;
const functions=ast.stmts.map(x=>x.stmt.CreateFunctionStmt).filter(Boolean);
const fn=functions[0],code=body(fn);
const oldBody=body(originalAst.stmts.map(x=>x.stmt.CreateFunctionStmt).find(Boolean));
export const supplementarySourcePins=[
  {
    "url": "https://clscholarship.org/about/program-overview",
    "cohort": "cls",
    "owner": "ba1a3c76-4868-42b4-994b-6cbae72a7044",
    "home": "https://clscholarship.org/",
    "origin": "https://clscholarship.org",
    "title": "Critical Language Scholarship Program — Program overview",
    "type": "other",
    "roles": [
      "funding"
    ],
    "authority": "https://clscholarship.org/",
    "href": "/about/program-overview"
  },
  {
    "url": "https://www.udall.gov/documents/PDF/2027sampleapplication.pdf",
    "cohort": "udall_undergraduate",
    "owner": "ef4c98ad-ffaa-4f15-9771-d9a94487bf0d",
    "home": "https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx",
    "origin": "https://www.udall.gov",
    "title": "Udall Undergraduate Scholarship — 2027 sample application",
    "type": "pdf",
    "roles": [
      "application_materials",
      "current_documents"
    ],
    "authority": "https://www.udall.gov/OurPrograms/Scholarship/HowToApply",
    "href": "/documents/PDF/2027sampleapplication.pdf"
  },
  {
    "url": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/online-application",
    "cohort": "knight_hennessy",
    "owner": "141944a8-fd04-4433-b0e4-8990fae56764",
    "home": "https://knight-hennessy.stanford.edu/",
    "origin": "https://knight-hennessy.stanford.edu",
    "title": "Knight-Hennessy Scholars — Online Application",
    "type": "application",
    "roles": [
      "application_materials"
    ],
    "authority": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications",
    "href": "/admission/preparing-your-applications/online-application"
  },
  {
    "url": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/policy-ai-use",
    "cohort": "knight_hennessy",
    "owner": "141944a8-fd04-4433-b0e4-8990fae56764",
    "home": "https://knight-hennessy.stanford.edu/",
    "origin": "https://knight-hennessy.stanford.edu",
    "title": "Knight-Hennessy Scholars — Policy on AI Use",
    "type": "application",
    "roles": [
      "application_materials"
    ],
    "authority": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications",
    "href": "/admission/preparing-your-applications/policy-ai-use"
  },
  {
    "url": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/resume",
    "cohort": "knight_hennessy",
    "owner": "141944a8-fd04-4433-b0e4-8990fae56764",
    "home": "https://knight-hennessy.stanford.edu/",
    "origin": "https://knight-hennessy.stanford.edu",
    "title": "Knight-Hennessy Scholars — Resume",
    "type": "application",
    "roles": [
      "application_materials"
    ],
    "authority": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications",
    "href": "/admission/preparing-your-applications/resume"
  },
  {
    "url": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/short-answers-essay",
    "cohort": "knight_hennessy",
    "owner": "141944a8-fd04-4433-b0e4-8990fae56764",
    "home": "https://knight-hennessy.stanford.edu/",
    "origin": "https://knight-hennessy.stanford.edu",
    "title": "Knight-Hennessy Scholars — Short Answers & Essay",
    "type": "application",
    "roles": [
      "application_materials"
    ],
    "authority": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications",
    "href": "/admission/preparing-your-applications/short-answers-essay"
  },
  {
    "url": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/transcripts-test-scores",
    "cohort": "knight_hennessy",
    "owner": "141944a8-fd04-4433-b0e4-8990fae56764",
    "home": "https://knight-hennessy.stanford.edu/",
    "origin": "https://knight-hennessy.stanford.edu",
    "title": "Knight-Hennessy Scholars — Transcripts & Test Scores",
    "type": "application",
    "roles": [
      "application_materials"
    ],
    "authority": "https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications",
    "href": "/admission/preparing-your-applications/transcripts-test-scores"
  }
];
export const supplementaryNegativeMutations=["unknown_key","arbitrary_url","original_three_pin","same_host_unreviewed","alias_destination_owner","wrong_cohort","wrong_homepage","arbitrary_authority","cross_cohort_authority","mismatched_authority_url","wrong_href","protocol_relative_href","credential_href","encoded_href","query_href","fragment_href","backslash_href","internal_double_slash_href","old_manual_review","future_manual_review","missing_role","extra_role","duplicate_role","stale_revision","invalid_revision","wrong_previous_ids","invalid_previous_ids","object_source_ids","missing_new_placeholder","duplicate_new_placeholder","foreign_retained_source","drop_existing","short_note","invalid_actor","oversized_proposal"];
// This is an explicitly synthetic, operator-reviewed rollback plan. The unit
// tests only parse/inspect its text. They have no DB, provider or capture client.
// Root may execute it ONCE only after reviewing/applying the actual migration,
// before registering any of its seven pages, and while source maintenance is idle.
export const supplementaryRegistrationRollbackRehearsalSql=String.raw`BEGIN;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='60s';
DO $supplementary_registration_rehearsal$
DECLARE spec record; registry public.stage1_award_registry%rowtype; authority public.shared_award_sources%rowtype;
 proposal jsonb; bad jsonb; result jsonb; role_change jsonb; acquisition public.shared_award_source_acquisitions%rowtype;
 snapshot_before jsonb; snapshot_after jsonb; all_before jsonb; next_id uuid; events_before bigint; failure boolean;
 public_events_before bigint; fact_reviews_before bigint; fact_events_before bigint; queue_before bigint;
 tests_passed integer:=0; original_role text:=current_user; mutation text; call_source public.shared_award_sources%rowtype;
 alias_registration record; role_before public.program_text_source_roster%rowtype;
 khs_documents_before jsonb; old_sources_before jsonb; old_sources_after jsonb; alias_owner uuid;
 source_count_before bigint; acquisition_count_before bigint;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('stage1-national-25-release',0)) THEN
  RAISE EXCEPTION 'TEST ONLY rehearsal refuses concurrent release/source maintenance.' USING errcode='55P03'; END IF;
 IF EXISTS(SELECT 1 FROM public.shared_award_sources WHERE lower(regexp_replace(split_part(url,'#',1),'/+$','')) IN
  ('https://clscholarship.org/about/program-overview','https://www.udall.gov/documents/pdf/2027sampleapplication.pdf','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/online-application','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/policy-ai-use','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/resume','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/short-answers-essay','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/transcripts-test-scores')) THEN
  RAISE EXCEPTION 'TEST ONLY rehearsal refuses preexisting supplementary sources; never delete them to run tests.'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.program_text_source_roster WHERE cohort_key='udall_undergraduate'
  AND source_role='current_documents' AND '876dbb68-cc15-4ced-8fa6-f20bc624830d'::uuid=ANY(source_ids)) THEN
  RAISE EXCEPTION 'TEST ONLY prerequisite: independently review/reuse the existing 2027 Udall criteria role first.'; END IF;
 SELECT to_jsonb(r) INTO khs_documents_before FROM public.program_text_source_roster r
  WHERE cohort_key='knight_hennessy' AND source_role='current_documents';
 ASSERT khs_documents_before->'source_ids' @> '["c79d5081-83bb-4384-8f42-31450e80025a"]'::jsonb,
  'TEST ONLY prerequisite: preserve the required KHS reference PDF and all history';
 SELECT jsonb_build_object(
  'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.shared_award_sources s
   JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy')),
  'acquisitions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.shared_award_source_acquisitions a
   JOIN public.shared_award_sources s ON s.id=a.shared_award_source_id JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
   WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy')),
  'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key,source_role) FROM public.program_text_source_roster r),
  'roster_events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_source_roster_events r),
  'legacy_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY cohort_key,source_role) FROM public.stage1_award_source_manifest m),
  'legacy_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key) FROM public.stage1_award_registry r),
  'text_queue',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.shared_award_visual_review_candidates q WHERE candidate_scope='program_text_change'),
  'fact_reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_fact_reviews r),
  'fact_release',(SELECT jsonb_agg(to_jsonb(r) ORDER BY release_key) FROM public.program_text_fact_release r)
 ) INTO all_before;

 FOR spec IN SELECT * FROM (VALUES
  ('cls','https://clscholarship.org/about/program-overview','https://clscholarship.org/',ARRAY['funding'],'/about/program-overview'),
  ('udall_undergraduate','https://www.udall.gov/documents/PDF/2027sampleapplication.pdf','https://www.udall.gov/OurPrograms/Scholarship/HowToApply',ARRAY['application_materials','current_documents'],'/documents/PDF/2027sampleapplication.pdf'),
  ('knight_hennessy','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/online-application','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications',ARRAY['application_materials'],'/admission/preparing-your-applications/online-application'),
  ('knight_hennessy','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/policy-ai-use','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications',ARRAY['application_materials'],'/admission/preparing-your-applications/policy-ai-use'),
  ('knight_hennessy','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/resume','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications',ARRAY['application_materials'],'/admission/preparing-your-applications/resume'),
  ('knight_hennessy','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/short-answers-essay','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications',ARRAY['application_materials'],'/admission/preparing-your-applications/short-answers-essay'),
  ('knight_hennessy','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/transcripts-test-scores','https://knight-hennessy.stanford.edu/admission/preparing-your-applications/your-applications',ARRAY['application_materials'],'/admission/preparing-your-applications/transcripts-test-scores')
 ) input(cohort,url,authority_url,roles,href) LOOP
  SELECT * INTO STRICT registry FROM public.stage1_award_registry WHERE cohort_key=spec.cohort;
  SELECT s.* INTO STRICT authority FROM public.shared_award_sources s
   WHERE s.shared_award_id=registry.canonical_shared_award_id AND s.url=spec.authority_url AND s.admin_review_status='open';
  SELECT jsonb_build_object('schema','awardping.program-text-source-registration.v1','cohort_key',spec.cohort,
   'expected_canonical_shared_award_id',registry.canonical_shared_award_id,'expected_official_homepage',registry.official_homepage,
   'source_url',spec.url,'authority',jsonb_build_object('source_id',authority.id,'source_url',authority.url,
    'link_href',spec.href,'link_text','TEST ONLY explicit manual link fixture',
    'checked_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'review_note','TEST ONLY synthetic ownership/link review; no real page review is asserted.'),
   'roles',(SELECT jsonb_agg(jsonb_build_object('source_role',source_role,'expected_revision',revision,
    'expected_source_ids',source_ids,'source_ids',to_jsonb(source_ids)||jsonb_build_array('$new'),
    'review_note','TEST ONLY add separate new-page monitoring; preserve all original page identities.') ORDER BY source_role)
    FROM public.program_text_source_roster WHERE cohort_key=spec.cohort AND source_role=ANY(spec.roles))) INTO proposal;

  -- Success, unchanged old sources, source/acquisition/role audit consistency,
  -- ADD-only retained memberships and empty state for each exact destination. The sentinel rolls back
  -- this fixture so no corrected source remains even inside the outer plan.
  BEGIN
   SELECT count(*) INTO events_before FROM public.program_text_source_roster_events;
   SELECT count(*) INTO public_events_before FROM public.shared_award_change_events;
   SELECT count(*) INTO fact_reviews_before FROM public.program_text_fact_reviews;
   SELECT count(*) INTO fact_events_before FROM public.program_text_fact_review_events;
   SELECT count(*) INTO queue_before FROM public.shared_award_visual_review_candidates WHERE candidate_scope='program_text_change';
   SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO old_sources_before FROM public.shared_award_sources s
    JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
    WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy');
   EXECUTE 'SET LOCAL ROLE service_role';
   result:=public.register_program_text_supplementary_source(proposal,'TEST ONLY rollback rehearsal');
   EXECUTE 'SET LOCAL ROLE '||quote_ident(original_role);
   -- Force deferred legacy/publication triggers before the intentional rollback;
   -- the savepoint rollback restores the caller's original constraint mode.
   SET CONSTRAINTS ALL IMMEDIATE;
   next_id:=(result->>'source_id')::uuid;
   SELECT * INTO STRICT call_source FROM public.shared_award_sources WHERE id=next_id;
   ASSERT result->>'schema'='awardping.program-text-source-registration-result.v1'
    AND result->>'notification_mode'='baseline_only'
    AND call_source.url=spec.url AND call_source.shared_award_id=registry.canonical_shared_award_id
    AND call_source.text_monitoring_state='{}'::jsonb,'New identity/state/result mismatch';
   SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) INTO old_sources_after FROM public.shared_award_sources s
    JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
    WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy') AND s.id<>next_id;
   ASSERT old_sources_after=old_sources_before,'Supplement changed a retained old source or its baseline';
   ASSERT (SELECT to_jsonb(r) FROM public.program_text_source_roster r WHERE cohort_key='knight_hennessy'
    AND source_role='current_documents')=khs_documents_before,'Supplement changed the held KHS PDF role';
   SELECT * INTO STRICT acquisition FROM public.shared_award_source_acquisitions WHERE shared_award_source_id=next_id;
   ASSERT acquisition.id=(result->>'acquisition_id')::uuid AND acquisition.acquisition_kind='admin_intake'
    AND acquisition.notification_mode='baseline_only' AND acquisition.review_seal='{}'::jsonb
    AND acquisition.onboarding_batch_id='program-text-supplementary-sources-v1'
    AND acquisition.metadata->'collection_only'='true'::jsonb
    AND acquisition.metadata->'public_fact_authority'='false'::jsonb
    AND acquisition.metadata->'fact_candidate_authority'='false'::jsonb,'Acquisition policy mismatch';
   ASSERT (SELECT count(*) FROM public.program_text_source_roster_events)=events_before+cardinality(spec.roles),'Per-role audit mismatch';
   ASSERT (SELECT count(*) FROM public.shared_award_change_events)=public_events_before
    AND (SELECT count(*) FROM public.program_text_fact_reviews)=fact_reviews_before
    AND (SELECT count(*) FROM public.program_text_fact_review_events)=fact_events_before
    AND (SELECT count(*) FROM public.shared_award_visual_review_candidates WHERE candidate_scope='program_text_change')=queue_before,
    'Collection-only registration created an update, fact decision, or paid-review candidate';
   FOR role_change IN SELECT value FROM jsonb_array_elements(proposal->'roles') LOOP
    ASSERT EXISTS(SELECT 1 FROM public.program_text_source_roster WHERE cohort_key=spec.cohort
     AND source_role=role_change->>'source_role' AND next_id=ANY(source_ids)
     AND source_ids @> ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(role_change->'expected_source_ids') x)
     AND cardinality(source_ids)=jsonb_array_length(role_change->'expected_source_ids')+1
     AND revision<>(role_change->>'expected_revision')::uuid),'Role did not atomically retain every prior source';
   END LOOP;
   -- A replay must hold, not mutate/re-acquire an existing page or add audits.
   failure:=false;
   BEGIN PERFORM public.register_program_text_supplementary_source(proposal,'TEST ONLY duplicate replay');
   EXCEPTION WHEN serialization_failure OR unique_violation THEN failure:=true; END;
   ASSERT failure,'Duplicate replay was not rejected';
   RAISE EXCEPTION 'TEST ONLY positive case rollback' USING errcode='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  tests_passed:=tests_passed+1;
  ASSERT NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Positive case did not roll back';

  FOR mutation IN SELECT unnest(ARRAY['unknown_key','arbitrary_url','original_three_pin','same_host_unreviewed','alias_destination_owner','wrong_cohort','wrong_homepage','arbitrary_authority','cross_cohort_authority','mismatched_authority_url','wrong_href','protocol_relative_href','credential_href','encoded_href','query_href','fragment_href','backslash_href','internal_double_slash_href','old_manual_review','future_manual_review','missing_role','extra_role','duplicate_role','stale_revision','invalid_revision','wrong_previous_ids','invalid_previous_ids','object_source_ids','missing_new_placeholder','duplicate_new_placeholder','foreign_retained_source','drop_existing','short_note','invalid_actor','oversized_proposal']) LOOP
   bad:=proposal;
   CASE mutation
    WHEN 'unknown_key' THEN bad:=bad||jsonb_build_object('notification_mode','first_capture_candidate');
    WHEN 'arbitrary_url' THEN bad:=jsonb_set(bad,'{source_url}',to_jsonb('https://unreviewed.example.org/page'::text));
    WHEN 'original_three_pin' THEN bad:=jsonb_set(bad,'{source_url}',to_jsonb('https://clscholarship.org/applicants'::text));
    WHEN 'same_host_unreviewed' THEN bad:=jsonb_set(bad,'{source_url}',to_jsonb(spec.url||'/unreviewed'));
    WHEN 'invalid_actor' THEN NULL;
    WHEN 'oversized_proposal' THEN bad:=jsonb_set(bad,'{authority,review_note}',to_jsonb(repeat('x',70000)));
    WHEN 'alias_destination_owner' THEN bad:=jsonb_set(bad,'{expected_canonical_shared_award_id}',to_jsonb('d58177b1-f41b-4c35-8699-87192cbd1d1b'::text));
    WHEN 'wrong_cohort' THEN bad:=jsonb_set(bad,'{cohort_key}',to_jsonb('other_program'::text));
    WHEN 'wrong_homepage' THEN bad:=jsonb_set(bad,'{expected_official_homepage}',to_jsonb('https://unreviewed.example.org/'::text));
    WHEN 'arbitrary_authority' THEN bad:=jsonb_set(bad,'{authority,source_url}',to_jsonb('https://unreviewed.example.org/'::text));
    WHEN 'cross_cohort_authority' THEN bad:=jsonb_set(bad,'{authority,source_id}',to_jsonb(CASE WHEN spec.cohort='cls'
     THEN 'ab2ae803-fb7f-40f5-9c93-ada63bea858b' ELSE '4a0fc8e1-ea62-4f22-81ab-33f1663bc9a7' END));
    WHEN 'mismatched_authority_url' THEN bad:=jsonb_set(bad,'{authority,source_url}',to_jsonb(registry.official_homepage||'not-the-stored-page'));
    WHEN 'wrong_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/wrong-program-page'::text));
    WHEN 'protocol_relative_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('//unreviewed.example.org/page'::text));
    WHEN 'credential_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('https://user:password@clscholarship.org/applicants'::text));
    WHEN 'encoded_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/%61pplicants'::text));
    WHEN 'query_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb(spec.url||'?unreviewed=1'));
    WHEN 'fragment_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb(spec.url||'#unreviewed'));
    WHEN 'backslash_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/untrusted'||chr(92)||'..'||chr(92)||'page'));
    WHEN 'internal_double_slash_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/untrusted-empty//../'||regexp_replace(spec.url,'^https://[^/]+/','')));
    WHEN 'old_manual_review' THEN bad:=jsonb_set(bad,'{authority,checked_at}',to_jsonb('2020-01-01T00:00:00.000Z'::text));
    WHEN 'future_manual_review' THEN bad:=jsonb_set(bad,'{authority,checked_at}',to_jsonb('2099-01-01T00:00:00.000Z'::text));
    WHEN 'missing_role' THEN bad:=jsonb_set(bad,'{roles}','[]'::jsonb);
    WHEN 'extra_role' THEN bad:=jsonb_set(bad,'{roles}',(bad->'roles')||jsonb_build_array((bad#>'{roles,0}')||jsonb_build_object('source_role','identity_home')));
    WHEN 'duplicate_role' THEN bad:=jsonb_set(bad,'{roles}',(bad->'roles')||jsonb_build_array(bad#>'{roles,0}'));
    WHEN 'stale_revision' THEN bad:=jsonb_set(bad,'{roles,0,expected_revision}',to_jsonb(gen_random_uuid()::text));
    WHEN 'invalid_revision' THEN bad:=jsonb_set(bad,'{roles,0,expected_revision}',to_jsonb('not-a-uuid'::text));
    WHEN 'invalid_previous_ids' THEN bad:=jsonb_set(bad,'{roles,0,expected_source_ids}',jsonb_build_array('not-a-uuid'));
    WHEN 'object_source_ids' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}','{}'::jsonb);
    WHEN 'wrong_previous_ids' THEN bad:=jsonb_set(bad,'{roles,0,expected_source_ids}',jsonb_build_array(gen_random_uuid()::text));
    WHEN 'missing_new_placeholder' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',bad#>'{roles,0,expected_source_ids}');
    WHEN 'duplicate_new_placeholder' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new','$new'));
    WHEN 'foreign_retained_source' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new',gen_random_uuid()::text));
    WHEN 'drop_existing' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new'));
    WHEN 'short_note' THEN bad:=jsonb_set(bad,'{authority,review_note}',to_jsonb('yes'::text));
   END CASE;
   failure:=false;
   BEGIN PERFORM public.register_program_text_supplementary_source(bad,CASE WHEN mutation='invalid_actor' THEN '' ELSE 'TEST ONLY negative fixture' END);
   EXCEPTION WHEN check_violation OR serialization_failure OR unique_violation OR foreign_key_violation THEN failure:=true; END;
   ASSERT failure,'Invalid registration was not rejected: '||mutation;
   ASSERT NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Invalid case left a source behind';
   tests_passed:=tests_passed+1;
  END LOOP;

  -- Anonymous/signed-in roles cannot execute even a correctly shaped request.
  FOR mutation IN SELECT unnest(ARRAY['anon','authenticated']) LOOP
   failure:=false;
   BEGIN
    EXECUTE 'SET LOCAL ROLE '||quote_ident(mutation);
    PERFORM public.register_program_text_supplementary_source(proposal,'TEST ONLY unauthorized fixture');
   EXCEPTION WHEN insufficient_privilege THEN failure:=true; END;
   EXECUTE 'SET LOCAL ROLE '||quote_ident(original_role);
   ASSERT failure,'Non-service role executed source registration'; tests_passed:=tests_passed+1;
  END LOOP;

  -- Force a late retained-binding failure only within this subtransaction.
  -- It must roll back the brand-new source and immutable acquisition together.
  BEGIN
   SELECT * INTO STRICT role_before FROM public.program_text_source_roster
    WHERE cohort_key=spec.cohort AND source_role=spec.roles[cardinality(spec.roles)];
   UPDATE public.program_text_source_roster SET evidence=jsonb_set(evidence,
    ARRAY['source_bindings',source_ids[1]::text,'review_note'],to_jsonb('x'::text))
    WHERE cohort_key=spec.cohort AND source_role=spec.roles[cardinality(spec.roles)];
   SELECT count(*) INTO source_count_before FROM public.shared_award_sources;
   SELECT count(*) INTO acquisition_count_before FROM public.shared_award_source_acquisitions;
   SELECT count(*) INTO events_before FROM public.program_text_source_roster_events;
   failure:=false;
   BEGIN PERFORM public.register_program_text_supplementary_source(proposal,'TEST ONLY late atomic failure');
   EXCEPTION WHEN check_violation THEN failure:=true; END;
   ASSERT failure AND NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url)
    AND (SELECT count(*) FROM public.shared_award_sources)=source_count_before
    AND (SELECT count(*) FROM public.shared_award_source_acquisitions)=acquisition_count_before
    AND (SELECT count(*) FROM public.program_text_source_roster_events)=events_before,
    'Late failure did not roll back source, acquisition and any earlier role update/audit';
   RAISE EXCEPTION 'TEST ONLY late-failure fixture rollback' USING errcode='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  tests_passed:=tests_passed+1;

  -- A normalized preexisting alias must be rejected before entering the old
  -- metadata-updating conflict branch. The alias fixture itself rolls back.
  IF spec.cohort IN ('cls','udall_undergraduate','knight_hennessy') THEN
   BEGIN
    alias_owner:=CASE spec.cohort WHEN 'cls' THEN 'd58177b1-f41b-4c35-8699-87192cbd1d1b'::uuid
     WHEN 'udall_undergraduate' THEN 'ae1010ac-d85f-49b8-8f12-61c9979cfa12'::uuid
     ELSE 'd395d355-1e27-4127-b24c-cfa486a32a37'::uuid END;
    SELECT * INTO STRICT alias_registration FROM public.register_shared_award_source_from_intake(
     jsonb_build_object('shared_award_id',alias_owner,'url',spec.url||'/#TEST-ONLY',
      'title','TEST ONLY normalized alias fixture','page_type','other','confidence',1,'reason','TEST ONLY rollback fixture',
      'source','admin','admin_review_status','open','page_metadata','{}'::jsonb,'consecutive_failures',0),
     jsonb_build_object('acquisition_kind','admin_intake','notification_mode','baseline_only','award_was_created',false,'review_seal','{}'::jsonb,'metadata','{}'::jsonb));
    SELECT to_jsonb(s) INTO snapshot_before FROM public.shared_award_sources s WHERE id=alias_registration.source_id;
    failure:=false;
    BEGIN PERFORM public.register_program_text_supplementary_source(proposal,'TEST ONLY normalized duplicate');
    EXCEPTION WHEN unique_violation THEN failure:=true; END;
    SELECT to_jsonb(s) INTO snapshot_after FROM public.shared_award_sources s WHERE id=alias_registration.source_id;
    ASSERT failure AND snapshot_before=snapshot_after,'Normalized alias was mutated or duplicated';
    RAISE EXCEPTION 'TEST ONLY alias fixture rollback' USING errcode='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
   tests_passed:=tests_passed+1;
  END IF;

  -- A held authority must fail before insertion, even with a syntactically valid
  -- fresh manual claim. The fixture status and any triggers roll back together.
  BEGIN
   UPDATE public.shared_award_sources SET admin_review_status='review_later' WHERE id=authority.id;
   failure:=false;
   BEGIN PERFORM public.register_program_text_supplementary_source(proposal,'TEST ONLY closed authority');
   EXCEPTION WHEN check_violation THEN failure:=true; END;
   ASSERT failure AND NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Closed authority was accepted';
   RAISE EXCEPTION 'TEST ONLY closed authority rollback' USING errcode='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  tests_passed:=tests_passed+1;

  -- For the sample PDF, simulate a valid matching CAS against an older-document
  -- role. Rejection must come from the mandatory 2027-reference guard, not just
  -- stale revisions. Keep this fixture wholly inside its rollback subtransaction.
  IF spec.cohort='udall_undergraduate' THEN
   BEGIN
    UPDATE public.program_text_source_roster SET source_ids=ARRAY['e58ac29c-e7af-403d-aa2d-8b5cb1f9f97c'::uuid],
     revision=gen_random_uuid() WHERE cohort_key=spec.cohort AND source_role='current_documents'
     RETURNING * INTO role_before;
    bad:=jsonb_set(proposal,'{roles}',(SELECT jsonb_agg(CASE WHEN x->>'source_role'='current_documents'
     THEN x||jsonb_build_object('expected_revision',role_before.revision,'expected_source_ids',role_before.source_ids,
      'source_ids',to_jsonb(role_before.source_ids)||jsonb_build_array('$new')) ELSE x END ORDER BY x->>'source_role')
     FROM jsonb_array_elements(proposal->'roles') x));
    failure:=false;
    BEGIN PERFORM public.register_program_text_supplementary_source(bad,'TEST ONLY missing 2027 reference');
    EXCEPTION WHEN check_violation THEN failure:=true; END;
    ASSERT failure AND NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Missing 2027 criteria was accepted';
    RAISE EXCEPTION 'TEST ONLY 2027 prerequisite rollback' USING errcode='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
   tests_passed:=tests_passed+1;
  END IF;
 END LOOP;

 SELECT jsonb_build_object(
  'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.shared_award_sources s
   JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy')),
  'acquisitions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.shared_award_source_acquisitions a
   JOIN public.shared_award_sources s ON s.id=a.shared_award_source_id JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
   WHERE m.cohort_key IN ('cls','udall_undergraduate','knight_hennessy')),
  'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key,source_role) FROM public.program_text_source_roster r),
  'roster_events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_source_roster_events r),
  'legacy_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY cohort_key,source_role) FROM public.stage1_award_source_manifest m),
  'legacy_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key) FROM public.stage1_award_registry r),
  'text_queue',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.shared_award_visual_review_candidates q WHERE candidate_scope='program_text_change'),
  'fact_reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_fact_reviews r),
  'fact_release',(SELECT jsonb_agg(to_jsonb(r) ORDER BY release_key) FROM public.program_text_fact_release r)
 ) INTO snapshot_after;
 ASSERT snapshot_after=all_before,'TEST ONLY rehearsal left source/provenance/roster/history/fact changes';
 ASSERT tests_passed=288,'TEST ONLY rehearsal case count drifted';
 RAISE NOTICE 'TEST ONLY registration rehearsal passed % cases; no retained capture or external call occurred.',tests_passed;
END;
$supplementary_registration_rehearsal$;
ROLLBACK;`;

describe("finite ADD-only supplementary text-source registration",()=>{
 it("is a separate additive RPC and leaves the original three-source operation intact",()=>{
  expect(ast.stmts).toHaveLength(4);
  expect(functions).toHaveLength(1);
  expect(fn.replace).not.toBe(true);
  expect(functionName(fn)).toBe("public.register_program_text_supplementary_source");
  expect(original).toContain("create function public.register_program_text_source(");
  expect(sql).not.toMatch(/\b(?:alter\s+table|create\s+table|drop|delete\s+from|update\s+public\.)\b/i);
 });
 it("keeps the audited original non-scope guards byte-for-byte",()=>{
  // Permitted differences are the finite URL switch, ADD-only guard, mandatory
  // Udall reference, distinct acquisition-batch label and missing-reference error.
  const start=code.indexOf(" -- Exact finite supplementary pages only.");
  const end=code.indexOf(" end case;",start)+" end case;".length;
  const oldStart=oldBody.indexOf(" -- Deliberately not a general hostname allowlist.");
  const oldEnd=oldBody.indexOf(" end case;",oldStart)+" end case;".length;
  expect(start).toBeGreaterThan(-1);expect(oldStart).toBeGreaterThan(-1);
  let normalized=code.slice(0,start)+oldBody.slice(oldStart,oldEnd)+code.slice(end);
  normalized=normalized.replace(/  -- Supplementary means ADD ONLY:[\s\S]*?(?=  select \* into strict v_role)/,"");
  normalized=normalized.replace(/  -- The current 2027 criteria[\s\S]*?\n  end if;\n(?= end loop;)/,"");
  normalized=normalized.replace("'program-text-supplementary-sources-v1'","'program-text-three-source-correction-v1'");
  normalized=normalized.replace("'The reviewed registry, authority source, required reference, or role no longer exists.'","'The reviewed registry, authority source, or role no longer exists.'");
  expect(normalized).toBe(oldBody);
 });
 it("requires service-only execution with the original justified definer and empty search_path",()=>{
  expect(option(fn,"security").Boolean.boolval).toBe(true);
  expect(fn.options.some(x=>x.DefElem.defname==="set"&&x.DefElem.arg.VariableSetStmt.name==="search_path"&&
   x.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval==="")).toBe(true);
  expect(sql).toContain("service_role intentionally has SELECT only");
  expect(sql).toContain("revoke all on function public.register_program_text_supplementary_source(jsonb,text) from public,anon,authenticated");
  expect(sql).toContain("grant execute on function public.register_program_text_supplementary_source(jsonb,text) to service_role");
  expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete|execute)[^;]+\bto\s+(?:public|anon|authenticated)\b/i);
 });
 it("pins exactly seven full URLs, canonical owners, homes and page-specific role sets",()=>{
  expect([...code.matchAll(/^  when '(https:[^']+)' then/gm)].map(x=>x[1])).toEqual(supplementarySourcePins.map(x=>x.url));
  expect(supplementarySourcePins).toHaveLength(7);
  for(const pin of supplementarySourcePins){
   const at=code.indexOf("  when '"+pin.url+"' then"),next=code.indexOf("\n  when ",at+1);
   const section=code.slice(at,next<0?code.indexOf("\n  else raise",at):next);
   expect(section).toContain("v_cohort:='"+pin.cohort+"'");
   expect(section).toContain("v_owner:='"+pin.owner+"'");
   expect(section).toContain("v_home:='"+pin.home+"'");
   expect(section).toContain("v_required_roles:=array["+pin.roles.map(x=>"'"+x+"'").join(",")+"]");
  }
  const destinationSwitch=code.slice(code.indexOf(" case v_url"),code.indexOf(" end case;"));
  expect(destinationSwitch).not.toMatch(/v_url\s+(?:like|~)|(?:ends_with|starts_with)\s*\(\s*v_url/i);
  expect(code).toContain("else raise exception 'This page is outside the reviewed seven-source supplement.'");
 });
 it("preserves every current role member instead of allowing replacement or retirement",()=>{
  const insert=code.indexOf("from public.register_shared_award_source_from_intake");
  for(const guard of ["cardinality(v_source_refs)<>cardinality(v_expected)+1",
   "exists(select 1 from unnest(v_expected) x where not x::text=any(v_source_refs))",
   "Supplementary registration must retain every prior source identity.",
   "count(*) from unnest(v_source_refs) x where x='$new'","only retain prior identities"]){
   expect(code.indexOf(guard)).toBeGreaterThan(-1);
   expect(code.indexOf(guard)).toBeLessThan(insert);
  }
  expect(sql).toContain("Five KHS detail pages: application_materials only");
 });
 it("requires the exact already-reviewed 2027 Udall criteria without changing legacy homepage or PDF history",()=>{
  expect(code).toContain("v_cohort='udall_undergraduate' and v_change->>'source_role'='current_documents'");
  for(const guard of ["'876dbb68-cc15-4ced-8fa6-f20bc624830d'::uuid=any(v_expected)",
   "https://www.udall.gov/documents/pdf/2027%20SIF%20Eligibility%20Criteria_FINAL.pdf",
   "v_source.shared_award_id<>v_owner","v_source.admin_review_status is distinct from 'open'"]){
   expect(code).toContain(guard);
  }
  expect(code.indexOf("Retain the reviewed 2027 Udall eligibility document")).toBeLessThan(code.indexOf("from public.register_shared_award_source_from_intake"));
  const udall=supplementarySourcePins.find(x=>x.cohort==="udall_undergraduate");
  expect(udall.home).toBe("https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx");
  expect(udall.roles).toEqual(["application_materials","current_documents"]);
  expect(code).not.toMatch(/update\s+public\.stage1_award_registry|set_stage1_award_manifest_entry/);
 });
 it("retains exact canonical, current manual-link, alias and approval guards",()=>{
  for(const guard of ["v_registry.canonical_shared_award_id<>v_owner","v_registry.official_homepage<>v_home",
   "m.member_kind='canonical'","a.status='active'","'link_href','link_text','checked_at','review_note'",
   "v_authority_source.url is distinct from v_authority->>'source_url'",
   "v_authority_source.admin_review_status is distinct from 'open'","m.shared_award_id=v_authority_source.shared_award_id",
   "v_resolved is distinct from v_url","position('//' in v_href)>0","interval '5 minutes'","interval '7 days'",
   "stage1_award_source_identity_rules","lower(regexp_replace(split_part(s.url,'#',1),'/+$',''))"]){
   expect(code).toContain(guard);
  }
  const duplicate=code.indexOf("lower(regexp_replace(split_part(s.url,'#',1),'/+$',''))");
  expect(code.slice(duplicate,code.indexOf("if exists(select 1 from public.stage1_award_source_identity_rules",duplicate))).not.toContain("s.shared_award_id=");
 });
 it("acquires the original global lock and all deterministic role CAS locks before any insertion",()=>{
  const lock=code.indexOf("perform pg_catalog.pg_advisory_xact_lock"),insert=code.indexOf("from public.register_shared_award_source_from_intake");
  expect(lock).toBeLessThan(code.indexOf("if private.awardping_program_exact_object"));
  for(const guard of ["order by value->>'source_role'","for update","v_roles is distinct from v_required_roles",
   "v_role.revision<>(v_change->>'expected_revision')::uuid","is distinct from v_expected"]){
   expect(code.indexOf(guard)).toBeGreaterThan(lock);
   expect(code.indexOf(guard)).toBeLessThan(insert);
  }
 });
 it("keeps original immutable silent provenance and collection-only result shape",()=>{
  for(const marker of ["'schema','awardping.program-text-source-registration-result.v1'","'notification_mode','baseline_only'",
   "'review_seal','{}'::jsonb","'collection_only',true","'public_fact_authority',false","'fact_candidate_authority',false",
   "'program-text-supplementary-sources-v1'","v_registration.source_inserted is not true",
   "v_registration.acquisition_id is null","v_source.text_monitoring_state<>'{}'::jsonb",
   "public.replace_program_text_source_role","v_roles_result:=v_roles_result||jsonb_build_array(v_result)"]){
   expect(code).toContain(marker);
  }
  expect(code).not.toMatch(/\b(?:enqueue|publish_program|approve_program|set_program_text_source_state|http_post|http_get)\b/);
  expect(code).not.toContain("baseline_facts");
 });
 it("provides 288 meaningful rollback-only runtime cases without executing any",async()=>{
  const plan=await parse(supplementaryRegistrationRollbackRehearsalSql);
  expect(plan.stmts[0].stmt.TransactionStmt.kind).toBe("TRANS_STMT_BEGIN");
  expect(plan.stmts.at(-1).stmt.TransactionStmt.kind).toBe("TRANS_STMT_ROLLBACK");
  expect(supplementaryRegistrationRollbackRehearsalSql.match(/\bROLLBACK;/g)).toHaveLength(1);
  expect(supplementaryRegistrationRollbackRehearsalSql).not.toMatch(/\bCOMMIT\b/);
  expect(supplementaryNegativeMutations).toHaveLength(35);
  expect(7*(supplementaryNegativeMutations.length+6)+1).toBe(288);
  for(const mutation of supplementaryNegativeMutations){
   expect(supplementaryRegistrationRollbackRehearsalSql).toContain("'"+mutation+"'");
   expect(supplementaryRegistrationRollbackRehearsalSql).toContain("WHEN '"+mutation+"'");
  }
  for(const required of ["SET LOCAL ROLE service_role","ARRAY['anon','authenticated']","SET CONSTRAINTS ALL IMMEDIATE",
   "old_sources_after=old_sources_before","khs_documents_before","source_ids @> ARRAY",
   "Missing 2027 criteria was accepted","Late failure did not roll back source, acquisition and any earlier role update/audit",
   "Normalized alias was mutated or duplicated","Closed authority was accepted","ASSERT snapshot_after=all_before","tests_passed=288"]){
   expect(supplementaryRegistrationRollbackRehearsalSql).toContain(required);
  }
 });
 it("keeps every negative JSON path literal and contains no database execution client",()=>{
  const paths=[...supplementaryRegistrationRollbackRehearsalSql.matchAll(/jsonb_set\([^,]+,'(\{[^']*\})'/g)].map(x=>x[1]);
  expect(paths.length).toBeGreaterThan(25);
  for(const path of paths)expect(path).toMatch(/^\{[a-z0-9_,]+\}$/);
  const own=readFileSync(new URL(import.meta.url),"utf8");
  expect([...own.matchAll(/^import.*?from "([^"]+)";/gm)].map(x=>x[1])).toEqual(["node:fs","vitest","libpg-query"]);
 });
});
