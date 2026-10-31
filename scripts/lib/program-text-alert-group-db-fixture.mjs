import {readFileSync} from 'node:fs';

const sql=name=>readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
const review=sql('20261029141114_manual_alert_review.sql');
const expansion=sql('20261030151153_program_award_expansion_registry.sql');
const between=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));

/** In-memory PostgreSQL fixture only. Production evidence/source gates are NOT
 * replaced by this fixture: bounded stand-ins let the real group transaction,
 * original decision and publisher exercise both success and injected failure.
 */
export function programTextAlertGroupDbFixture(){return `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$select pg_catalog.sha256(convert_to($1,'UTF8'))$$;
CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$select pg_catalog.sha256($1)$$;
CREATE TABLE auth.users(id uuid primary key);
CREATE TABLE public.shared_awards(id uuid primary key,status text not null default 'active');
CREATE TABLE public.program_award_registry(cohort_key text primary key,canonical_shared_award_id uuid references public.shared_awards(id));
CREATE TABLE public.program_award_members(shared_award_id uuid primary key references public.shared_awards(id),cohort_key text,member_kind text);
CREATE TABLE public.program_text_source_authority_epochs(epoch uuid primary key,active boolean);
CREATE TABLE public.shared_award_sources(id uuid primary key,shared_award_id uuid references public.shared_awards(id),url text,admin_review_status text default 'open',text_monitoring_state jsonb,fixture_allowed boolean default true);
CREATE TABLE public.shared_award_visual_review_candidates(id uuid primary key,shared_award_id uuid references public.shared_awards(id),shared_award_source_id uuid references public.shared_award_sources(id),
 candidate_scope text,status text,candidate_signature text,source_url text,source_title text,source_page_type text,
 previous_snapshot_ref jsonb,new_snapshot_ref jsonb,previous_text_hash text,new_text_hash text,worker_metadata jsonb,
 prompt_payload jsonb,ai_result jsonb,created_at timestamptz,updated_at timestamptz,published_at timestamptz,rejection_reason text);
CREATE TABLE public.shared_award_change_events(id uuid primary key,shared_award_id uuid,shared_award_source_id uuid,source_url text,source_title text,source_page_type text,
 previous_hash text,new_hash text,summary text,change_details jsonb,visual_review_candidate_id uuid,detected_at timestamptz default clock_timestamp(),suppressed_at timestamptz);
CREATE TABLE public.shared_award_change_event_visual_evidence(id uuid primary key default gen_random_uuid(),change_event_id uuid unique,
 shared_award_id uuid,shared_award_source_id uuid,visual_review_candidate_id uuid,candidate_signature text,bucket text,evidence_status text,
 previous_capture jsonb,current_capture jsonb,localization jsonb,evidence_schema_version text,verified_at timestamptz);
${between(review,'create table public.program_text_alert_reviews (','CREATE OR REPLACE FUNCTION private.publish_reviewed_program_text_event(')}
${between(review,'CREATE OR REPLACE FUNCTION private.publish_reviewed_program_text_event(','revoke all on function private.publish_reviewed_program_text_event(')}
${between(review,'create function private.program_text_alert_hash(','revoke all on function private.program_text_alert_hash(')}
${between(review,'create function public.decide_program_text_alert(','revoke all on function public.decide_program_text_alert(')}
CREATE FUNCTION private.program_award_identity_is_public(text) RETURNS boolean LANGUAGE sql STABLE AS $$select exists(select 1 from public.program_award_registry where cohort_key=$1)$$;
CREATE FUNCTION private.awardping_program_source_allowed(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$select coalesce((select fixture_allowed from public.shared_award_sources where id=$1),false)$$;
CREATE FUNCTION public.awardping_validate_program_text_evidence(e jsonb,c jsonb,d jsonb) RETURNS void LANGUAGE plpgsql AS $$begin
 if e->>'visual_review_candidate_id' is distinct from c->>'id' or e->'previous_capture' is distinct from c->'previous_snapshot_ref'
  or e->'current_capture' is distinct from c->'new_snapshot_ref' or d->>'schema' is distinct from 'awardping.program-text-change-details.v1'
  or c#>>'{prompt_payload,fixture_fail}'='true' then raise exception 'Fixture evidence rejected' using errcode='23514';end if;
end$$;
${between(expansion,'CREATE OR REPLACE FUNCTION private.public_digest_reviewed_text_source_current(','-- Reviewed current function; change only modern identity/membership scope.\nCREATE OR REPLACE FUNCTION public.commit_current_program_basic_facts(')}
GRANT USAGE ON SCHEMA public TO service_role;
`;
}

export function programTextAlertGroupFixtureSeed(){return `
INSERT INTO auth.users VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO public.shared_awards VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','active');
INSERT INTO public.program_award_registry VALUES('fixture','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('other','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.program_award_members VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fixture','canonical'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','other','canonical');
INSERT INTO public.program_text_source_authority_epochs VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
INSERT INTO public.shared_award_sources(id,shared_award_id,url,text_monitoring_state)
SELECT ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'https://fixture.invalid/source-'||i,jsonb_build_object('schema','awardping.program-text-state.v1','epoch','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 'baseline_ref',jsonb_build_object('capture','previous-'||i),'latest_ref',jsonb_build_object('capture','current-'||i),'status','awaiting_review') FROM generate_series(1,12)i;
INSERT INTO public.shared_award_visual_review_candidates(id,shared_award_id,shared_award_source_id,candidate_scope,status,candidate_signature,source_url,
source_title,source_page_type,previous_snapshot_ref,new_snapshot_ref,previous_text_hash,new_text_hash,worker_metadata,prompt_payload,ai_result,created_at)
SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'program_text_change','succeeded',repeat('f',64),'https://fixture.invalid/source-'||i,
'Fixture page','eligibility',jsonb_build_object('capture','previous-'||i),jsonb_build_object('capture','current-'||i),repeat('1',64),repeat('2',64),
jsonb_build_object('bucket','fixture','epoch','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','evidence_signature',repeat('e',64),'admin_alert_review_id','10000000-0000-4000-8000-'||lpad(i::text,12,'0')),
jsonb_build_object('comparison',jsonb_build_object('context',jsonb_build_object('award_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
'source_id','20000000-0000-4000-8000-'||lpad(i::text,12,'0'),'epoch','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','cycle_id',null))),
'{}'::jsonb,clock_timestamp()-interval '1 hour'*i FROM generate_series(1,12)i;
INSERT INTO public.program_text_alert_reviews(id,content_hash,candidate_signature,details,localization)
SELECT c.id,private.program_text_alert_hash(c,jsonb_build_object('schema','awardping.program-text-change-details.v1','summary','Fixture change '||c.id), '{}'::jsonb),
c.candidate_signature,jsonb_build_object('schema','awardping.program-text-change-details.v1','summary','Fixture change '||c.id),'{}'::jsonb
FROM public.shared_award_visual_review_candidates c;
`;}
