// Generates a rollback-only native rehearsal from a real cold-restored proposal.
// No database is opened and no statement is executed by this module.
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
export function explicitSourceAdmissionRollbackSql({proposal,document,actor}){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(actor||''))throw Error('Real actor UUID required');
 const p=literal(proposal),d=literal(document);
 return `
-- BEGIN/ROLLBACK is unconditional; caller may put the unapplied migration after BEGIN.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='120s';
DO $explicit_admission_rehearsal$
DECLARE p jsonb:=${p};doc jsonb:=${d};actor uuid:='${actor}';bad jsonb;result jsonb;replay jsonb;
 sid uuid:=(p#>>'{source,id}')::uuid;aid uuid:=(p->>'id')::uuid;old_count bigint;failure boolean;case_name text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.shared_award_sources WHERE id=sid) OR
    EXISTS(SELECT 1 FROM public.program_text_source_approvals WHERE id=aid) THEN
   RAISE EXCEPTION 'Native rehearsal refuses existing real operation identities.';
 END IF;
 SELECT count(*) INTO old_count FROM public.shared_award_change_events;
 FOR case_name IN SELECT unnest(ARRAY['schema','origin','stale_role','remove_role','replace_member','existing_source','review_before_capture','document_hash','actor']) LOOP
  bad:=p;
  CASE case_name
   WHEN 'schema' THEN bad:=jsonb_set(bad,'{schema}','"awardping.program-text-source-approval-request.v1"');
   WHEN 'origin' THEN bad:=jsonb_set(bad,'{source,url}','"https://unrelated.example/eligibility"');
   WHEN 'stale_role' THEN bad:=jsonb_set(bad,'{roles,0,expected_revision}',to_jsonb(gen_random_uuid()::text));
   WHEN 'remove_role' THEN bad:=bad#-'{roles,0}';
   WHEN 'replace_member' THEN bad:=jsonb_set(bad,'{roles,0,next_source_ids}',jsonb_build_array(sid));
   WHEN 'existing_source' THEN bad:=jsonb_set(bad,'{source,id}',bad#>'{roles,0,expected_source_ids,0}');
   WHEN 'review_before_capture' THEN bad:=jsonb_set(bad,'{review,reviewed_at}',to_jsonb(to_char((doc#>>'{reference,captured_at}')::timestamptz-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
   WHEN 'document_hash' THEN NULL;
   WHEN 'actor' THEN bad:=jsonb_set(bad,'{review,actor_id}',to_jsonb(gen_random_uuid()::text));
  END CASE;
  failure:=false;
  BEGIN
   PERFORM public.admit_reviewed_official_program_text_source(bad,
     CASE WHEN case_name='document_hash' THEN jsonb_set(doc,'{text}',to_jsonb((doc->>'text')||' tampered')) ELSE doc END,actor);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '40001' OR SQLSTATE '23505' OR SQLSTATE 'P0002' THEN failure:=true;
  END;
  ASSERT failure,'Negative admission case accepted: '||case_name;
  ASSERT NOT EXISTS(SELECT 1 FROM public.shared_award_sources WHERE id=sid),'Negative case left source';
  ASSERT NOT EXISTS(SELECT 1 FROM public.program_text_source_approvals WHERE id=aid),'Negative case left approval';
 END LOOP;
 result:=public.admit_reviewed_official_program_text_source(p,doc,actor);
 ASSERT result->>'source_id'=sid::text AND result->>'id'=aid::text AND result->'idempotent'='false'::jsonb,'Admission receipt mismatch';
 ASSERT EXISTS(SELECT 1 FROM public.shared_award_sources s WHERE s.id=sid AND s.admin_review_status='review_later' AND s.text_monitoring_state='{}'::jsonb),'New source must have empty history and no legacy approval';
 ASSERT EXISTS(SELECT 1 FROM public.program_text_source_approvals a WHERE a.id=aid AND a.validation#>>'{schema}'='awardping.explicit-official-source-admission-validation.v1'
  AND a.validation->'target_document'=doc AND NOT a.validation ? 'provider_link'),'Explicit evidence schema mismatch';
 ASSERT private.awardping_program_text_source_access(sid,p->>'cohort_key',(p->>'epoch')::uuid),'Standard DTO access rejected';
 ASSERT private.awardping_program_source_allowed(sid),'Worker roster admission rejected';
 ASSERT NOT EXISTS(SELECT 1 FROM public.program_text_source_pending_requests q WHERE q.id=aid),'Unlinked review fabricated pending hyperlink proof';
 ASSERT (SELECT count(*) FROM public.shared_award_change_events)=old_count,'Initial source admission created public event';
 replay:=public.admit_reviewed_official_program_text_source(p,doc,actor);
 ASSERT replay->'idempotent'='true'::jsonb AND replay->>'content_hash'=result->>'content_hash','Exact replay mismatch';
 PERFORM public.revoke_program_text_source_approval(aid,result->>'content_hash','Rollback-only rehearsal of explicit source revocation.',actor::text);
 ASSERT NOT private.awardping_program_text_source_access(sid,p->>'cohort_key',(p->>'epoch')::uuid),'Revoked DTO retained collection access';
 ASSERT NOT private.awardping_program_source_allowed(sid),'Revoked source remained worker eligible';
 failure:=false;
 BEGIN PERFORM public.admit_reviewed_official_program_text_source(p,doc,actor);
 EXCEPTION WHEN SQLSTATE '40001' THEN failure:=true;END;
 ASSERT failure,'Revoked admission was silently reactivated';
 -- Force all deferred source/publication constraints before outer rollback.
 SET CONSTRAINTS ALL IMMEDIATE;
 RAISE NOTICE 'PASS explicit admission:9 negatives,new empty source,standard DTO/worker authority,exact replay,revocation,no event';
END;
$explicit_admission_rehearsal$;
SET LOCAL ROLE authenticated;
DO $deny$ BEGIN
 BEGIN PERFORM public.admit_reviewed_official_program_text_source(NULL,NULL,NULL);RAISE EXCEPTION 'Authenticated unexpectedly admitted source';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;$deny$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $deny$ BEGIN
 BEGIN PERFORM public.admit_reviewed_official_program_text_source(NULL,NULL,NULL);RAISE EXCEPTION 'Anon unexpectedly admitted source';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END;$deny$;
RESET ROLE;
ROLLBACK;
`;
}
