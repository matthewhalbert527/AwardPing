import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "libpg-query";

const migrationName = "20261025173726_program_text_source_registration.sql";
const sql = readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8");
const ast = await parse(sql);
const functions = ast.stmts.map(row => row.stmt.CreateFunctionStmt).filter(Boolean);
const name = fn => fn.funcname.map(part => part.String.sval).join(".");
const option = (fn, key) => fn.options.find(part => part.DefElem.defname === key)?.DefElem.arg;
const body = fn => option(fn, "as").List.items[0].String.sval;
const register = functions.find(fn => name(fn) === "public.register_program_text_source");
const code = body(register);

// Operator payload fixture. These are synthetic review notes, not a claim that
// these links were manually checked in the real site. Never submit this fixture
// outside the explicitly reviewed rollback-only rehearsal below.
const fixtureProposal = {
  schema: "awardping.program-text-source-registration.v1", cohort_key: "cls",
  expected_canonical_shared_award_id: "ba1a3c76-4868-42b4-994b-6cbae72a7044",
  expected_official_homepage: "https://clscholarship.org/", source_url: "https://clscholarship.org/applicants",
  authority: { source_id: "4a0fc8e1-ea62-4f22-81ab-33f1663bc9a7", source_url: "https://clscholarship.org/",
    link_href: "/applicants", link_text: "TEST ONLY applicant link", checked_at: "2026-10-25T17:37:26.000Z",
    review_note: "TEST ONLY manual link/ownership fixture, not a real authority approval." },
  roles: ["application_materials", "dates_cycle"].map(source_role => ({ source_role,
    expected_revision: "11111111-1111-4111-8111-111111111111",
    expected_source_ids: ["cb980b70-0938-4bbe-a32a-091ec44420d7"], source_ids: ["$new"],
    review_note: "TEST ONLY replacement of an obsolete page with a separate silent baseline." })),
};

// Root may extract this literal after review and execute it ONCE after applying
// the migration. This test file never opens a database or executes the plan.
// Every temporary source/provenance/role change is rolled back. No retained
// capture, model request, fact approval, event publication or scheduler exists.
export const registrationRollbackRehearsalSql = String.raw`BEGIN;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='60s';
DO $registration_rehearsal$
DECLARE spec record; registry public.stage1_award_registry%rowtype; authority public.shared_award_sources%rowtype;
 proposal jsonb; bad jsonb; result jsonb; role_change jsonb; acquisition public.shared_award_source_acquisitions%rowtype;
 snapshot_before jsonb; snapshot_after jsonb; all_before jsonb; next_id uuid; events_before bigint; failure boolean;
 public_events_before bigint; fact_reviews_before bigint; fact_events_before bigint; queue_before bigint;
 tests_passed integer:=0; original_role text:=current_user; mutation text; call_source public.shared_award_sources%rowtype;
 alias_registration record; role_before public.program_text_source_roster%rowtype;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('stage1-national-25-release',0)) THEN
  RAISE EXCEPTION 'TEST ONLY rehearsal refuses concurrent release/source maintenance.' USING errcode='55P03'; END IF;
 IF EXISTS(SELECT 1 FROM public.shared_award_sources WHERE lower(regexp_replace(split_part(url,'#',1),'/+$','')) IN
  ('https://clscholarship.org/applicants','https://clscholarship.org/applicants/selection-process',
   'https://beineckescholarship.org/beinecke-scholarship/scholarship-conditions')) THEN
  RAISE EXCEPTION 'TEST ONLY rehearsal refuses existing corrected sources; do not remove or reset them.'; END IF;
 SELECT jsonb_build_object(
  'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.shared_award_sources s
   JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id WHERE m.cohort_key IN ('cls','beinecke')),
  'acquisitions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.shared_award_source_acquisitions a
   JOIN public.shared_award_sources s ON s.id=a.shared_award_source_id JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
   WHERE m.cohort_key IN ('cls','beinecke')),
  'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key,source_role) FROM public.program_text_source_roster r),
  'roster_events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_source_roster_events r),
  'legacy_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY cohort_key,source_role) FROM public.stage1_award_source_manifest m),
  'legacy_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key) FROM public.stage1_award_registry r),
  'text_queue',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.shared_award_visual_review_candidates q WHERE candidate_scope='program_text_change'),
  'fact_reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_fact_reviews r),
  'fact_release',(SELECT jsonb_agg(to_jsonb(r) ORDER BY release_key) FROM public.program_text_fact_release r)
 ) INTO all_before;

 FOR spec IN SELECT * FROM (VALUES
  ('cls','https://clscholarship.org/applicants','https://clscholarship.org/',ARRAY['application_materials','dates_cycle'],'/applicants'),
  ('cls','https://clscholarship.org/applicants/selection-process','https://clscholarship.org/applicants/applicant-faq',ARRAY['selection_interviews'],'selection-process'),
  ('beinecke','https://beineckescholarship.org/beinecke-scholarship/scholarship-conditions/',
    'https://beineckescholarship.org/beinecke-scholarship/',ARRAY['funding'],
    'https://beineckescholarship.org/beinecke-scholarship/scholarship-conditions/')
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

  -- Success, source/acquisition/role audit consistency, and empty independent
  -- state for each of the exact three destinations. The sentinel rolls back
  -- this fixture so no corrected source remains even inside the outer plan.
  BEGIN
   SELECT count(*) INTO events_before FROM public.program_text_source_roster_events;
   SELECT count(*) INTO public_events_before FROM public.shared_award_change_events;
   SELECT count(*) INTO fact_reviews_before FROM public.program_text_fact_reviews;
   SELECT count(*) INTO fact_events_before FROM public.program_text_fact_review_events;
   SELECT count(*) INTO queue_before FROM public.shared_award_visual_review_candidates WHERE candidate_scope='program_text_change';
   result:=public.register_program_text_source(proposal,'TEST ONLY rollback rehearsal');
   -- Force deferred legacy/publication triggers before the intentional rollback;
   -- the savepoint rollback restores the caller's original constraint mode.
   SET CONSTRAINTS ALL IMMEDIATE;
   next_id:=(result->>'source_id')::uuid;
   SELECT * INTO STRICT call_source FROM public.shared_award_sources WHERE id=next_id;
   ASSERT call_source.url=spec.url AND call_source.shared_award_id=registry.canonical_shared_award_id
    AND call_source.text_monitoring_state='{}'::jsonb,'New identity/state mismatch';
   SELECT * INTO STRICT acquisition FROM public.shared_award_source_acquisitions WHERE shared_award_source_id=next_id;
   ASSERT acquisition.id=(result->>'acquisition_id')::uuid AND acquisition.acquisition_kind='admin_intake'
    AND acquisition.notification_mode='baseline_only' AND acquisition.review_seal='{}'::jsonb
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
     AND revision<>(role_change->>'expected_revision')::uuid),'Role was not atomically replaced';
   END LOOP;
   -- A replay must hold, not mutate/re-acquire an existing page or add audits.
   failure:=false;
   BEGIN PERFORM public.register_program_text_source(proposal,'TEST ONLY duplicate replay');
   EXCEPTION WHEN serialization_failure OR unique_violation THEN failure:=true; END;
   ASSERT failure,'Duplicate replay was not rejected';
   RAISE EXCEPTION 'TEST ONLY positive case rollback' USING errcode='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  tests_passed:=tests_passed+1;
  ASSERT NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Positive case did not roll back';

  FOR mutation IN SELECT unnest(ARRAY['unknown_key','arbitrary_url','alias_destination_owner','wrong_cohort','wrong_homepage',
   'arbitrary_authority','cross_cohort_authority','mismatched_authority_url','wrong_href','protocol_relative_href',
   'credential_href','encoded_href','internal_double_slash_href','old_manual_review','future_manual_review','missing_role','stale_revision',
   'wrong_previous_ids','missing_new_placeholder','duplicate_new_placeholder','foreign_retained_source','short_note']) LOOP
   bad:=proposal;
   CASE mutation
    WHEN 'unknown_key' THEN bad:=bad||jsonb_build_object('notification_mode','first_capture_candidate');
    WHEN 'arbitrary_url' THEN bad:=jsonb_set(bad,'{source_url}',to_jsonb('https://unreviewed.example.org/page'::text));
    WHEN 'alias_destination_owner' THEN bad:=jsonb_set(bad,'{expected_canonical_shared_award_id}',to_jsonb('d58177b1-f41b-4c35-8699-87192cbd1d1b'::text));
    WHEN 'wrong_cohort' THEN bad:=jsonb_set(bad,'{cohort_key}',to_jsonb('other_program'::text));
    WHEN 'wrong_homepage' THEN bad:=jsonb_set(bad,'{expected_official_homepage}',to_jsonb('https://unreviewed.example.org/'::text));
    WHEN 'arbitrary_authority' THEN bad:=jsonb_set(bad,'{authority,source_url}',to_jsonb('https://unreviewed.example.org/'::text));
    WHEN 'cross_cohort_authority' THEN bad:=jsonb_set(bad,'{authority,source_id}',to_jsonb(CASE WHEN spec.cohort='cls'
     THEN '20ea00ce-6835-4eb0-bcce-e42d542f12df' ELSE '4a0fc8e1-ea62-4f22-81ab-33f1663bc9a7' END));
    WHEN 'mismatched_authority_url' THEN bad:=jsonb_set(bad,'{authority,source_url}',to_jsonb(registry.official_homepage||'not-the-stored-page'));
    WHEN 'wrong_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/wrong-program-page'::text));
    WHEN 'protocol_relative_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('//unreviewed.example.org/page'::text));
    WHEN 'credential_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('https://user:password@clscholarship.org/applicants'::text));
    WHEN 'encoded_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/%61pplicants'::text));
    WHEN 'internal_double_slash_href' THEN bad:=jsonb_set(bad,'{authority,link_href}',to_jsonb('/untrusted-empty//../'||regexp_replace(spec.url,'^https://[^/]+/','')));
    WHEN 'old_manual_review' THEN bad:=jsonb_set(bad,'{authority,checked_at}',to_jsonb('2020-01-01T00:00:00.000Z'::text));
    WHEN 'future_manual_review' THEN bad:=jsonb_set(bad,'{authority,checked_at}',to_jsonb('2099-01-01T00:00:00.000Z'::text));
    WHEN 'missing_role' THEN bad:=jsonb_set(bad,'{roles}','[]'::jsonb);
    WHEN 'stale_revision' THEN bad:=jsonb_set(bad,'{roles,0,expected_revision}',to_jsonb(gen_random_uuid()::text));
    WHEN 'wrong_previous_ids' THEN bad:=jsonb_set(bad,'{roles,0,expected_source_ids}',jsonb_build_array(gen_random_uuid()::text));
    WHEN 'missing_new_placeholder' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',bad#>'{roles,0,expected_source_ids}');
    WHEN 'duplicate_new_placeholder' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new','$new'));
    WHEN 'foreign_retained_source' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new',gen_random_uuid()::text));
    WHEN 'short_note' THEN bad:=jsonb_set(bad,'{authority,review_note}',to_jsonb('yes'::text));
   END CASE;
   failure:=false;
   BEGIN PERFORM public.register_program_text_source(bad,'TEST ONLY negative fixture');
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
    PERFORM public.register_program_text_source(proposal,'TEST ONLY unauthorized fixture');
   EXCEPTION WHEN insufficient_privilege THEN failure:=true; END;
   EXECUTE 'SET LOCAL ROLE '||quote_ident(original_role);
   ASSERT failure,'Non-service role executed source registration'; tests_passed:=tests_passed+1;
  END LOOP;

  -- Force a late retained-binding failure only within this subtransaction.
  -- It must roll back the brand-new source and immutable acquisition together.
  BEGIN
   SELECT * INTO STRICT role_before FROM public.program_text_source_roster
    WHERE cohort_key=spec.cohort AND source_role=spec.roles[1];
   UPDATE public.program_text_source_roster SET evidence=jsonb_set(evidence,
    ARRAY['source_bindings',source_ids[1]::text,'review_note'],to_jsonb('x'::text))
    WHERE cohort_key=spec.cohort AND source_role=spec.roles[1];
   failure:=false;
   BEGIN PERFORM public.register_program_text_source(proposal,'TEST ONLY late atomic failure');
   EXCEPTION WHEN check_violation THEN failure:=true; END;
   ASSERT failure AND NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE url=spec.url),'Late failure did not roll back registration';
   RAISE EXCEPTION 'TEST ONLY late-failure fixture rollback' USING errcode='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
  tests_passed:=tests_passed+1;

  -- A normalized preexisting alias must be rejected before entering the old
  -- metadata-updating conflict branch. The alias fixture itself rolls back.
  IF spec.cohort='cls' THEN
   BEGIN
    SELECT * INTO STRICT alias_registration FROM public.register_shared_award_source_from_intake(
     jsonb_build_object('shared_award_id','d58177b1-f41b-4c35-8699-87192cbd1d1b','url',spec.url||'/#TEST-ONLY',
      'title','TEST ONLY normalized alias fixture','page_type','other','confidence',1,'reason','TEST ONLY rollback fixture',
      'source','admin','admin_review_status','open','page_metadata','{}'::jsonb,'consecutive_failures',0),
     jsonb_build_object('acquisition_kind','admin_intake','notification_mode','baseline_only','award_was_created',false,'review_seal','{}'::jsonb,'metadata','{}'::jsonb));
    SELECT to_jsonb(s) INTO snapshot_before FROM public.shared_award_sources s WHERE id=alias_registration.source_id;
    failure:=false;
    BEGIN PERFORM public.register_program_text_source(proposal,'TEST ONLY normalized duplicate');
    EXCEPTION WHEN unique_violation THEN failure:=true; END;
    SELECT to_jsonb(s) INTO snapshot_after FROM public.shared_award_sources s WHERE id=alias_registration.source_id;
    ASSERT failure AND snapshot_before=snapshot_after,'Normalized alias was mutated or duplicated';
    RAISE EXCEPTION 'TEST ONLY alias fixture rollback' USING errcode='ZX001';
   EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL; END;
   tests_passed:=tests_passed+1;
  END IF;
 END LOOP;

 SELECT jsonb_build_object(
  'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.shared_award_sources s
   JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id WHERE m.cohort_key IN ('cls','beinecke')),
  'acquisitions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.shared_award_source_acquisitions a
   JOIN public.shared_award_sources s ON s.id=a.shared_award_source_id JOIN public.stage1_award_members m ON m.shared_award_id=s.shared_award_id
   WHERE m.cohort_key IN ('cls','beinecke')),
  'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key,source_role) FROM public.program_text_source_roster r),
  'roster_events',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_source_roster_events r),
  'legacy_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY cohort_key,source_role) FROM public.stage1_award_source_manifest m),
  'legacy_registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY cohort_key) FROM public.stage1_award_registry r),
  'text_queue',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.shared_award_visual_review_candidates q WHERE candidate_scope='program_text_change'),
  'fact_reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.program_text_fact_reviews r),
  'fact_release',(SELECT jsonb_agg(to_jsonb(r) ORDER BY release_key) FROM public.program_text_fact_release r)
 ) INTO snapshot_after;
 ASSERT snapshot_after=all_before,'TEST ONLY rehearsal left source/provenance/roster/history/fact changes';
 ASSERT tests_passed=80,'TEST ONLY rehearsal case count drifted';
 RAISE NOTICE 'TEST ONLY registration rehearsal passed % cases; no retained capture or external call occurred.',tests_passed;
END;
$registration_rehearsal$;
ROLLBACK;`;

describe("narrow manual text-source registration boundary", () => {
  it("parses the additive operation without altering old tables/functions", () => {
    expect(ast.stmts).toHaveLength(4);
    expect(functions).toHaveLength(1);
    expect(register.replace).not.toBe(true);
    expect(name(register)).toBe("public.register_program_text_source");
    expect(sql).not.toMatch(/\b(?:alter\s+table|drop|delete\s+from|create\s+table|update\s+public\.)\b/i);
  });
  it("has a justified service-only definer and no new table grants", () => {
    expect(option(register, "security").Boolean.boolval).toBe(true);
    expect(register.options.some(part => part.DefElem.defname === "set" && part.DefElem.arg.VariableSetStmt.name === "search_path" &&
      part.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === "")).toBe(true);
    expect(sql).toContain("service_role intentionally has SELECT only");
    expect(sql).toContain("revoke all on function public.register_program_text_source(jsonb,text) from public,anon,authenticated");
    expect(sql).toContain("grant execute on function public.register_program_text_source(jsonb,text) to service_role");
    expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete|execute)[^;]+\bto\s+(?:public|anon|authenticated)\b/i);
  });
  it("pins exactly three destinations, owners, homes and page-specific role sets", () => {
    expect([...code.matchAll(/^  when '(https:[^']+)' then/gm)].map(match => match[1])).toEqual([
      "https://clscholarship.org/applicants", "https://clscholarship.org/applicants/selection-process",
      "https://beineckescholarship.org/beinecke-scholarship/scholarship-conditions/",
    ]);
    for (const guard of ["v_registry.canonical_shared_award_id<>v_owner", "v_registry.official_homepage<>v_home", "m.member_kind='canonical'",
      "a.status='active'", "v_roles is distinct from v_required_roles", "array['application_materials','dates_cycle']", "array['selection_interviews']", "array['funding']"])
      expect(code).toContain(guard);
    expect(fixtureProposal.expected_canonical_shared_award_id).toBe("ba1a3c76-4868-42b4-994b-6cbae72a7044");
  });
  it("requires an explicit fresh same-cohort manual authority review, not an arbitrary HTTPS claim", () => {
    for (const guard of ["'link_href','link_text','checked_at','review_note'", "v_authority_source.url is distinct from v_authority->>'source_url'",
      "v_authority_source.admin_review_status is distinct from 'open'", "m.shared_award_id=v_authority_source.shared_award_id",
      "v_resolved is distinct from v_url", "position('//' in v_href)>0", "interval '5 minutes'", "interval '7 days'", "stage1_award_source_identity_rules"])
      expect(code).toContain(guard);
    expect(code).not.toMatch(/authority[^\n]*(?:capture_hash|raw_sha256|exact_evidence_verified|sealed)/);
    expect(sql).toContain("not automated officialness inference or");
    expect(sql).toContain("cryptographic page proof");
  });
  it("locks first and rejects every stale/extra role before invoking registration", () => {
    const lock = code.indexOf("perform pg_catalog.pg_advisory_xact_lock"), insert = code.indexOf("from public.register_shared_award_source_from_intake");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(code.indexOf("if private.awardping_program_exact_object"));
    for (const guard of ["order by value->>'source_role'", "for update", "v_role.revision<>(v_change->>'expected_revision')::uuid",
      "is distinct from v_expected", "count(*) from unnest(v_source_refs) x where x='$new'", "only retain prior identities"]) {
      expect(code.indexOf(guard)).toBeGreaterThan(lock);
      expect(code.indexOf(guard)).toBeLessThan(insert);
    }
    expect(code).toContain("case when x='$new' then false else not x::uuid=any(v_expected) end");
  });
  it("rejects normalized aliases before the legacy existing-row metadata branch", () => {
    const guard = code.indexOf("lower(regexp_replace(split_part(s.url,'#',1),'/+$',''))");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(code.indexOf("from public.register_shared_award_source_from_intake"));
    expect(code.slice(guard, code.indexOf("if exists(select 1 from public.stage1_award_source_identity_rules", guard))).not.toContain("s.shared_award_id=");
    expect(code).toContain("v_registration.source_inserted is not true");
    expect(code).toContain("v_registration.acquisition_id is null");
  });
  it("creates only silent immutable provenance and independent empty state", () => {
    for (const policy of ["'acquisition_kind','admin_intake'", "'notification_mode','baseline_only'", "'review_seal','{}'::jsonb",
      "'public_fact_authority',false", "'fact_candidate_authority',false", "v_source.text_monitoring_state<>'{}'::jsonb",
      "public.replace_program_text_source_role", "v_roles_result:=v_roles_result||jsonb_build_array(v_result)"])
      expect(code).toContain(policy);
    expect(code).not.toMatch(/\b(?:enqueue|publish_program|approve_program|set_program_text_source_state|set_stage1_award_manifest_entry|http_post|http_get)\b/);
    expect(code).not.toContain("baseline_facts");
  });
  it("provides a parseable rollback-only runtime plan without any execution authority", async () => {
    const plan = await parse(registrationRollbackRehearsalSql);
    expect(plan.stmts[0].stmt.TransactionStmt.kind).toBe("TRANS_STMT_BEGIN");
    expect(plan.stmts.at(-1).stmt.TransactionStmt.kind).toBe("TRANS_STMT_ROLLBACK");
    expect(registrationRollbackRehearsalSql).not.toMatch(/\bCOMMIT\b/);
    for (const negative of ["arbitrary_url", "alias_destination_owner", "arbitrary_authority", "cross_cohort_authority", "wrong_href", "stale_revision",
      "wrong_previous_ids", "duplicate_new_placeholder", "foreign_retained_source", "internal_double_slash_href", "normalized alias", "late atomic failure", "SET LOCAL ROLE"])
      expect(registrationRollbackRehearsalSql).toContain(negative);
    expect(registrationRollbackRehearsalSql).toContain("ASSERT snapshot_after=all_before");
    expect(registrationRollbackRehearsalSql).toContain("tests_passed=80");
    expect(registrationRollbackRehearsalSql).toContain("SET CONSTRAINTS ALL IMMEDIATE;");
    expect(registrationRollbackRehearsalSql).toContain("Collection-only registration created an update, fact decision, or paid-review candidate");
    expect(registrationRollbackRehearsalSql).toContain("ARRAY['application_materials','dates_cycle'],'/applicants'");
    expect(registrationRollbackRehearsalSql).toContain("ARRAY['selection_interviews'],'selection-process'");
    const ownCode = readFileSync(new URL(import.meta.url), "utf8");
    expect([...ownCode.matchAll(/^import\s+.*?from\s+["']([^"']+)["'];/gm)].map(match => match[1])).toEqual(["node:fs", "vitest", "libpg-query"]);
  });
  it("binds every negative mutation to a literal JSON path without embedded whitespace", () => {
    const paths = [...registrationRollbackRehearsalSql.matchAll(/jsonb_set\([^,]+,'(\{[^']*\})'/g)].map(match => match[1]);
    expect(paths.length).toBeGreaterThan(15);
    for (const path of paths) expect(path).toMatch(/^\{[a-z0-9_,]+\}$/);
    expect(registrationRollbackRehearsalSql).toContain("WHEN 'foreign_retained_source' THEN bad:=jsonb_set(bad,'{roles,0,source_ids}',jsonb_build_array('$new',gen_random_uuid()::text));");
  });
});
