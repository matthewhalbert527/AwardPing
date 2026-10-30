-- Additive text-only awards. The original Stage 1 registry, identity, cache,
-- signed manifests and exhaustive fact/variation approvals remain unchanged.
-- No awards/sources are admitted by this migration; only original identities mirror.
do $preimages$
begin
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_current_basic_fact_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'e3d11ea76e515e22906c67fd3e741a28625e0873cb45a3555203dd9cc74ec8e0' then raise exception 'Expansion function preimage changed: private.awardping_current_basic_fact_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_current_basic_source_ready(uuid, text, uuid, jsonb)'::regprocedure),'UTF8'),'sha256'),'hex') <> '06ea056b816293747ec8bc388a077214ed186f686526810d1d3843ee51a2cc23' then raise exception 'Expansion function preimage changed: private.awardping_current_basic_source_ready' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_current_basic_validation_valid(jsonb)'::regprocedure),'UTF8'),'sha256'),'hex') <> '17a1e7581633ec8512744893a65c506b9cab3fafa0077123ddfa2e79d4a91bd6' then raise exception 'Expansion function preimage changed: private.awardping_current_basic_validation_valid' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_source_allowed(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> '6f582ae1bfc0261bc27c840b1f22546a0fb6e3aab6ac54df3d6646a7d184bb27' then raise exception 'Expansion function preimage changed: private.awardping_program_source_allowed' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_text_source_access(uuid, text, uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> '5fc62431ace0a85d28cb4f23a25fd518cff864dd9653492e0b79d908cbbf0023' then raise exception 'Expansion function preimage changed: private.awardping_program_text_source_access' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_text_source_approval_dto(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'e6d1890165a8d56bd44ff46e607735709b658f7fbf5caaa77b6ad73a323c7db1' then raise exception 'Expansion function preimage changed: private.awardping_program_text_source_approval_dto' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.public_digest_events_are_current(jsonb)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'ce63713dbcdd0ecb1807e710db77e8a7694f3ab39d9dbc245e3c3a8b61f4a4fd' then raise exception 'Expansion function preimage changed: private.public_digest_events_are_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.public_digest_reviewed_text_source_current(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'ce0d987f84703fbbb56b6e1b1188f32d3dd40a81f298e5fbbbe462c0cced99e9' then raise exception 'Expansion function preimage changed: private.public_digest_reviewed_text_source_current' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.commit_current_program_basic_facts(uuid, text, uuid, jsonb, text, text)'::regprocedure),'UTF8'),'sha256'),'hex') <> '89817197a3a1545b01516d9fa2b145066580ea9cfdcb334e3131c96fab515f91' then raise exception 'Expansion function preimage changed: public.commit_current_program_basic_facts' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_text_public_alert_source_bindings(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> '4b6845adabde25f299270aa67263df6cea354033bb5f38a989eeea45e1b4828b' then raise exception 'Expansion function preimage changed: public.get_program_text_public_alert_source_bindings' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.get_program_text_worker_roster_page(text, jsonb, text, integer)'::regprocedure),'UTF8'),'sha256'),'hex') <> '2b8612783739090478dc46c0e1dd17b1e774c1d77954f80f284e7c47b99f180f' then raise exception 'Expansion function preimage changed: public.get_program_text_worker_roster_page' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.inspect_current_program_basic_award(text)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'd9788920bbf3120188aa2f9a9bad88a6c3680fa476c5fb6e1eca7102238a9a1e' then raise exception 'Expansion function preimage changed: public.inspect_current_program_basic_award' using errcode='40001';end if;
end;$preimages$;

do $basic_preimages$
begin
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_program_fact_validation_valid(jsonb, boolean)'::regprocedure),'UTF8'),'sha256'),'hex') <> '83fba381a2d013c462a6d6d08ae7a5fd7f51ba6618338620e2df8dc8f8d06727' then raise exception 'Expansion basic function preimage changed: private.awardping_program_fact_validation_valid' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('private.awardping_basic_fact_current_v1(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'e329aba69e727ac8e557d82fec12579cceeb485e094e130db9bab201dbbd8b1a' then raise exception 'Expansion basic function preimage changed: private.awardping_basic_fact_current_v1' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.commit_program_basic_facts(uuid, text, uuid, jsonb, text, text)'::regprocedure),'UTF8'),'sha256'),'hex') <> 'ef0d46f41fef2d6c0ed8b332b179f16a9e108b62731c700c8b936dc2df70c2f5' then raise exception 'Expansion basic function preimage changed: public.commit_program_basic_facts' using errcode='40001';end if;
 if encode(extensions.digest(convert_to(pg_get_functiondef('public.inspect_program_basic_fact_draft(uuid)'::regprocedure),'UTF8'),'sha256'),'hex') <> '1538c4d4f088f3e89afe4b17f3f90b7afa23a382944fe08817cb0fb29010c4b5' then raise exception 'Expansion basic function preimage changed: public.inspect_program_basic_fact_draft' using errcode='40001';end if;
end;$basic_preimages$;

create table public.program_award_registry (like public.stage1_award_registry including defaults);
alter table public.program_award_registry add primary key(cohort_key),
 add unique(launch_rank), add unique(canonical_shared_award_id), add unique(canonical_slug),
 add foreign key(canonical_shared_award_id) references public.shared_awards(id),
 add check(cohort_key ~ '^[a-z0-9_]{1,80}$'), add check(launch_rank between 1 and 35),
 add check(canonical_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'), add check(official_homepage ~ '^https://'),
 add check(publication_state in ('pending','verified_beta','revalidation_pending','suspended'));
create table public.program_award_members (like public.stage1_award_members including defaults);
alter table public.program_award_members add primary key(shared_award_id),
 add foreign key(shared_award_id) references public.shared_awards(id),
 add foreign key(cohort_key) references public.program_award_registry(cohort_key),
 add check(member_kind in ('canonical','alias'));
create unique index program_award_members_canonical on public.program_award_members(cohort_key) where member_kind='canonical';
create index program_award_members_cohort on public.program_award_members(cohort_key,shared_award_id);
alter table public.program_award_registry enable row level security;
alter table public.program_award_members enable row level security;
revoke all on public.program_award_registry,public.program_award_members from public,anon,authenticated,service_role;
grant select on public.program_award_registry,public.program_award_members to service_role;
insert into public.program_award_registry select * from public.stage1_award_registry;
insert into public.program_award_members select * from public.stage1_award_members;

create function private.sync_program_award_registry() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.program_award_registry select new.*
 on conflict(cohort_key) do update set
 (launch_rank,canonical_name,canonical_shared_award_id,canonical_slug,official_homepage,publication_state,state_reason,policy_version,
 fact_ledger_batch_id,release_epoch,evidence_checked_at,last_verified_at,created_at,updated_at)=
 (excluded.launch_rank,excluded.canonical_name,excluded.canonical_shared_award_id,excluded.canonical_slug,excluded.official_homepage,
 excluded.publication_state,excluded.state_reason,excluded.policy_version,excluded.fact_ledger_batch_id,excluded.release_epoch,
 excluded.evidence_checked_at,excluded.last_verified_at,excluded.created_at,excluded.updated_at);
 return new;
end;$$;
create trigger program_award_registry_mirror after insert or update on public.stage1_award_registry for each row execute function private.sync_program_award_registry();
create function private.sync_program_award_members() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then delete from public.program_award_members where shared_award_id=old.shared_award_id;return old;end if;
 insert into public.program_award_members select new.* on conflict(shared_award_id) do update set
 (cohort_key,member_kind,reason,created_at,updated_at)=(excluded.cohort_key,excluded.member_kind,excluded.reason,excluded.created_at,excluded.updated_at);
 return new;
end;$$;
create trigger program_award_members_mirror after insert or update or delete on public.stage1_award_members for each row execute function private.sync_program_award_members();
revoke all on function private.sync_program_award_registry(),private.sync_program_award_members() from public,anon,authenticated,service_role;

-- Only modern monitoring/basic tables move to the unified identity parent.
-- The retired complete-program and variation tables keep their original parent.
alter table public.program_text_source_roster drop constraint program_text_source_roster_cohort_key_fkey;
alter table public.program_text_source_roster add constraint program_text_source_roster_cohort_key_fkey foreign key(cohort_key) references public.program_award_registry(cohort_key);
alter table public.program_text_fact_reviews drop constraint program_text_fact_reviews_cohort_key_fkey;
alter table public.program_text_fact_reviews add constraint program_text_fact_reviews_cohort_key_fkey foreign key(cohort_key) references public.program_award_registry(cohort_key);
alter table public.program_basic_fact_heads drop constraint program_basic_fact_heads_cohort_key_fkey;
alter table public.program_basic_fact_heads add constraint program_basic_fact_heads_cohort_key_fkey foreign key(cohort_key) references public.program_award_registry(cohort_key);
alter table public.program_basic_fact_snapshots drop constraint program_basic_fact_snapshots_cohort_key_fkey;
alter table public.program_basic_fact_snapshots add constraint program_basic_fact_snapshots_cohort_key_fkey foreign key(cohort_key) references public.program_award_registry(cohort_key);
alter table public.program_basic_repeat_observations drop constraint program_basic_repeat_observations_cohort_key_fkey;
alter table public.program_basic_repeat_observations add constraint program_basic_repeat_observations_cohort_key_fkey foreign key(cohort_key) references public.program_award_registry(cohort_key);

create function private.program_award_expansion_candidate(p_cohort text) returns jsonb language sql immutable set search_path='' as $$
 select value from jsonb_array_elements($candidates$[{"cohort_key":"ppia_jsi","batch":1,"launch_rank":26,"canonical_shared_award_id":"874d043a-3819-4032-a7c4-bb9582a1d51f","canonical_name":"Public Policy & International Affairs (PPIA) Junior Summer Institute","canonical_slug":"public-policy-and-international-affairs-junior-summer-institute","official_homepage":"https://www.ppiaprogram.org/JSI","source_urls":["https://www.ppiaprogram.org/","https://www.ppiaprogram.org/JSI"]},{"cohort_key":"daad_rise","batch":1,"launch_rank":27,"canonical_shared_award_id":"4a862735-6d67-4154-81ad-4bcc51ad0ec1","canonical_name":"DAAD RISE Germany","canonical_slug":"daad-rise","official_homepage":"https://www.daad.de/rise/en/rise-germany/","source_urls":["https://www.daad.de/rise/en/rise-germany/","https://www.daad.de/rise/en/rise-germany/find-an-internship/application-portal/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/","https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/faq/"]},{"cohort_key":"tillman","batch":1,"launch_rank":28,"canonical_shared_award_id":"cb8740aa-4585-4e1c-a939-35fc854cb12b","canonical_name":"Tillman Scholars Program","canonical_slug":"tillman-scholars-program","official_homepage":"https://pattillmanfoundation.org/apply/","source_urls":["https://pattillmanfoundation.org/apply/","https://pattillmanfoundation.org/eligibility-and-compensation/","https://pattillmanfoundation.org/frequently-asked-questions/","https://pattillmanfoundation.org/scholar-benefits/"]},{"cohort_key":"freeman_asia","batch":1,"launch_rank":29,"canonical_shared_award_id":"06713967-eaf6-49cf-aa8d-a12d6cf1ab51","canonical_name":"Freeman-ASIA Award","canonical_slug":"freeman-asia-award","official_homepage":"https://www.iie.org/programs/freeman-asia/","source_urls":["https://www.iie.org/programs/freeman-asia/","https://www.iie.org/programs/freeman-asia/about/award-details/","https://www.iie.org/programs/freeman-asia/apply/","https://www.iie.org/programs/freeman-asia/eligibility/"]},{"cohort_key":"james_madison","batch":1,"launch_rank":30,"canonical_shared_award_id":"592d1ab0-7eff-402a-82ba-90d19559aa7f","canonical_name":"James Madison Memorial Fellowship","canonical_slug":"james-madison-memorial-fellowship","official_homepage":"https://www.jamesmadison.gov/","source_urls":["https://www.jamesmadison.gov/","https://www.jamesmadison.gov/fellowship-information/faq","https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility"]},{"cohort_key":"rangel","batch":2,"launch_rank":31,"canonical_shared_award_id":"e6ebd346-0567-4464-85b1-92a555036992","canonical_name":"Charles B. Rangel International Affairs Fellowship","canonical_slug":"charles-b-rangel-international-affairs-fellowship","official_homepage":"https://rangelprogram.org/graduate-fellowship-program/","source_urls":["https://rangelprogram.org/graduate-fellowship-program/","https://rangelprogram.org/graduate-fellowship-program/application-requirements/","https://rangelprogram.org/graduate-fellowship-program/faqs/","https://rangelprogram.org/graduate-fellowship-program/overview-eligibility/","https://rangelprogram.org/graduate-fellowship-program/university-partners/"]},{"cohort_key":"pickering","batch":2,"launch_rank":32,"canonical_shared_award_id":"06b39341-8489-4c72-a555-dfd96d336f4b","canonical_name":"Pickering Foreign Affairs Fellowship","canonical_slug":"pickering-foreign-affairs-fellowship","official_homepage":"https://pickeringfellowship.org/","source_urls":["https://pickeringfellowship.org/","https://pickeringfellowship.org/approvedprograms/","https://pickeringfellowship.org/how-to-apply/","https://pickeringfellowship.org/overview-eligibility/","https://pickeringfellowship.org/overview-eligibility/faqs/"]},{"cohort_key":"aauw_international","batch":2,"launch_rank":33,"canonical_shared_award_id":"cd625d2b-417a-4dd1-a11c-040b1e2ce4fa","canonical_name":"AAUW International Fellowships","canonical_slug":"aauw-international-fellowships","official_homepage":"https://www.aauw.org/resources/programs/fellowships-grants/aauw-international-fellowships/","source_urls":["https://www.aauw.org/resources/programs/fellowships-grants/","https://www.aauw.org/resources/programs/fellowships-grants/aauw-international-fellowships/"]},{"cohort_key":"rotary_peace","batch":2,"launch_rank":34,"canonical_shared_award_id":"4f66e3fa-3924-4d0d-a04d-a32989f74c2e","canonical_name":"Rotary Peace Fellowship","canonical_slug":"rotary-peace-fellowship","official_homepage":"https://www.rotary.org/en/our-programs/peace-fellowships","source_urls":["https://www.rotary.org/en/get-involved/our-programs/peace-fellowships","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-certificate-program","https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-masters-degree-programs","https://www.rotary.org/en/our-programs/peace-fellowships"]},{"cohort_key":"voyager","batch":2,"launch_rank":35,"canonical_shared_award_id":"10dda818-c922-47ac-8b56-55494c2c889f","canonical_name":"The Voyager Scholarship","canonical_slug":"the-voyager-scholarship","official_homepage":"https://www.obama.org/programs/voyager-scholarship/","source_urls":["https://www.obama.org/programs/voyager-scholarship/","https://www.obama.org/programs/voyager-scholarship/faq/"]}]$candidates$::jsonb) where value->>'cohort_key'=p_cohort;
$$;
revoke all on function private.program_award_expansion_candidate(text) from public,anon,authenticated,service_role;

create table public.program_award_expansion_admissions (
 id uuid primary key default gen_random_uuid(),cohort_key text not null unique references public.program_award_registry(cohort_key),
 batch integer not null check(batch in (1,2)),epoch uuid not null references public.program_text_source_authority_epochs(epoch),
 plan_hash text not null check(plan_hash ~ '^[a-f0-9]{64}$'),proof jsonb not null,
 source_ids uuid[] not null check(cardinality(source_ids) between 1 and 6),
 status text not null default 'monitoring' check(status in ('monitoring','active')),
 activation_receipt jsonb,admitted_by text not null,admitted_at timestamptz not null default now(),activated_at timestamptz,
 check((status='monitoring' and activation_receipt is null and activated_at is null) or
       (status='active' and activation_receipt is not null and activated_at is not null))
);
alter table public.program_award_expansion_admissions enable row level security;
revoke all on public.program_award_expansion_admissions from public,anon,authenticated,service_role;
grant select on public.program_award_expansion_admissions to service_role;

-- Permission derives from an immutable reviewed exact-source plan, not from a
-- hostname match, admin-review label, client flag or the presence of a new row.
create function private.program_award_expansion_source_proof(p_source uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare s public.shared_award_sources%rowtype;a public.program_award_expansion_admissions%rowtype;q jsonb;
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 select x.* into strict a from public.program_award_expansion_admissions x
 join public.program_award_members m on m.cohort_key=x.cohort_key and m.shared_award_id=s.shared_award_id and m.member_kind='canonical'
 where s.id=any(x.source_ids) and x.epoch=(select epoch from public.program_text_source_authority_epochs where active);
 select value into strict q from jsonb_array_elements(a.proof->'sources') where value->>'id'=s.id::text;
 if s.shared_award_id::text is distinct from a.proof->>'canonical_shared_award_id' or s.url is distinct from q->>'url' or s.title is distinct from q->>'title' or s.page_type is distinct from q->>'page_type'
  or s.admin_review_status not in ('open','review_later') or not exists(select 1 from public.shared_awards w where w.id=s.shared_award_id and w.status='active')
  or (s.text_monitoring_state<>'{}'::jsonb and s.text_monitoring_state->>'epoch' is distinct from a.epoch::text)
 then return null;end if;
 return jsonb_build_object('schema','awardping.program-text-source-approval.v1','id',a.id,'source_id',s.id,
  'shared_award_id',s.shared_award_id,'source_url',s.url,'cohort_key',a.cohort_key,'epoch',a.epoch,'content_hash',a.plan_hash,'current',true);
exception when no_data_found or too_many_rows then return null;end;$$;
create function private.program_award_expansion_source_boundary(p_source uuid) returns boolean language sql stable set search_path='' as $$
 select not exists(select 1 from public.shared_award_sources s join public.program_award_members m on m.shared_award_id=s.shared_award_id
 join public.program_award_registry r on r.cohort_key=m.cohort_key and r.launch_rank>25 where s.id=p_source)
 or private.program_award_expansion_source_proof(p_source) is not null;
$$;
create function private.program_award_identity_is_public(p_cohort text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.program_award_registry r where r.cohort_key=p_cohort and
  (r.launch_rank<=25 or exists(select 1 from public.program_award_expansion_admissions a where a.cohort_key=r.cohort_key and a.status='active')));
$$;
revoke all on function private.program_award_expansion_source_proof(uuid),private.program_award_expansion_source_boundary(uuid),private.program_award_identity_is_public(text) from public,anon,authenticated,service_role;

-- Exact accepted Stage 1 DTO remains separate; expansion proofs are additive.
CREATE OR REPLACE FUNCTION private.awardping_program_text_source_approval_dto_stage1(p_source_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select coalesce(jsonb_agg(jsonb_build_object('schema','awardping.program-text-source-approval.v1','id',a.id,
  'source_id',a.source_id,'shared_award_id',a.shared_award_id,'source_url',a.source_url,'cohort_key',a.cohort_key,
  'epoch',a.epoch,'content_hash',a.content_hash,'current',true) order by a.cohort_key),'[]'::jsonb)
 from (select distinct on (approval.cohort_key) approval.* from public.program_text_source_approvals approval
  where approval.source_id=p_source_id and approval.epoch=(select epoch from public.program_text_source_authority_epochs where active)
   and not exists(select 1 from public.program_text_source_approval_events e where e.approval_id=approval.id and e.action='revoked')
   and private.awardping_program_text_approval_context_current(approval.cohort_key,approval.source_id,approval.shared_award_id,approval.source_url,
    approval.validation#>'{proposal,registration_scope}')
  order by approval.cohort_key,approval.approved_at desc,approval.id desc) a
 join public.shared_award_sources s on s.id=a.source_id and s.shared_award_id=a.shared_award_id and s.url=a.source_url
 join public.shared_awards award on award.id=s.shared_award_id and award.status='active'
 where private.awardping_pappg_canonical_admission_allowed(s.id,a.cohort_key,a.epoch)
  and s.admin_review_status in ('open','review_later')
  and s.title=a.validation#>>'{proposal,source,title}' and s.page_type=a.validation#>>'{proposal,source,page_type}'
  and (s.text_monitoring_state='{}'::jsonb or s.text_monitoring_state->>'epoch'=a.epoch::text)
  and exists(select 1 from public.stage1_award_members m where m.cohort_key=a.cohort_key and m.shared_award_id=s.shared_award_id)
  and not exists(select 1 from public.program_text_source_approval_events e where e.approval_id=a.id and e.action='revoked')
  and private.awardping_program_text_canonical_boundary_current(a.source_id,a.cohort_key,a.shared_award_id,a.source_url,a.url_alias_boundary)
  and not exists(select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=a.cohort_key and
   ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)));
$function$
;
revoke all on function private.awardping_program_text_source_approval_dto_stage1(uuid) from public,anon,authenticated,service_role;
grant execute on function private.awardping_program_text_source_approval_dto_stage1(uuid) to service_role;


create or replace function private.awardping_program_text_source_approval_dto(p_source_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare proof jsonb;
begin
 proof:=private.program_award_expansion_source_proof(p_source_id);
 return private.awardping_program_text_source_approval_dto_stage1(p_source_id)||case when proof is null then '[]'::jsonb else jsonb_build_array(proof) end;
end;$$;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION private.awardping_current_basic_fact_current(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare x public.program_basic_fact_snapshots%rowtype;v jsonb;s public.shared_award_sources%rowtype;r public.program_text_alert_reviews%rowtype;c public.shared_award_visual_review_candidates%rowtype;actual_roster jsonb;
begin
 select * into strict x from public.program_basic_fact_snapshots where id=p_id;
 if x.receipt->>'schema'<>'awardping.current-basic-award-fact-review.v1' or not exists(select 1 from public.program_award_registry z where z.cohort_key=x.cohort_key and z.canonical_shared_award_id=x.award_id) then return false;end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role) into actual_roster from public.program_text_source_roster where cohort_key=x.cohort_key;
 if actual_roster is distinct from (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(x.receipt->'roster')) then return false;end if;
 for v in select value from jsonb_array_elements(x.source_versions) loop
  select * into strict s from public.shared_award_sources where id=(v->>'source_id')::uuid;
  if s.shared_award_id::text<>v->>'owner_id' or s.url<>v->>'url' or not private.awardping_current_basic_source_ready(s.id,x.cohort_key,(v->>'epoch')::uuid,s.text_monitoring_state->'latest_ref')
   or private.awardping_basic_content_identity(s.text_monitoring_state->'latest_ref') is distinct from v->'content_identity'
   or not exists(select 1 from public.program_basic_repeat_observations o where o.id=(v->>'repeat_observation_id')::uuid and o.source_id=s.id and o.cohort_key=x.cohort_key and o.epoch=(v->>'epoch')::uuid and o.content_identity=v->'content_identity') then return false;end if;
  if v->'pending_alert_review_id'<>'null'::jsonb then
   select * into strict r from public.program_text_alert_reviews where id=(v->>'pending_alert_review_id')::uuid;
   select * into strict c from public.shared_award_visual_review_candidates where id=r.id;
   if r.content_hash<>v->>'pending_alert_review_hash' or r.content_hash<>private.program_text_alert_hash(c,r.details,r.localization)
    or c.shared_award_source_id<>s.id or c.shared_award_id<>s.shared_award_id or c.source_url<>s.url
    or private.awardping_basic_content_identity(c.new_snapshot_ref) is distinct from v->'content_identity'
    or not ((r.status='pending' and c.status='succeeded') or (r.status='approved' and c.status='published') or (r.status='dismissed' and c.status='rejected' and c.rejection_reason='admin_dismissed_program_change')) then return false;end if;
  elsif s.text_monitoring_state->>'status'='awaiting_review' then return false;
  end if;
 end loop;return true;
exception when others then return false;end;$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION private.awardping_current_basic_source_ready(p_source uuid, p_cohort text, p_epoch uuid, p_ref jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare s public.shared_award_sources%rowtype;v jsonb;
begin
 select * into strict s from public.shared_award_sources where id=p_source;v:=s.text_monitoring_state;
 if not private.awardping_program_text_reference_valid(p_ref) or not private.awardping_program_text_source_access(s.id,p_cohort,p_epoch)
  or not private.awardping_program_text_collection_quality_ready(s.id,p_epoch)
  or not exists(select 1 from public.program_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id)
  or not exists(select 1 from public.program_text_source_roster r where r.cohort_key=p_cohort and s.id=any(r.source_ids))
  or not exists(select 1 from public.program_text_source_authority_epochs e where e.active and e.epoch=p_epoch)
  or exists(select 1 from public.program_text_source_roster r where r.cohort_key=p_cohort and s.id=any(r.source_ids) and
   (r.manifest_status is distinct from 'reviewed_text' or r.evidence->>'schema' is distinct from 'awardping.program-text-source-role.v1'
    or r.evidence#>>array['source_bindings',s.id::text,'source_url'] is distinct from s.url
    or r.evidence#>>array['source_bindings',s.id::text,'shared_award_id'] is distinct from s.shared_award_id::text))
  or v->>'schema' is distinct from 'awardping.program-text-state.v1' or v->>'epoch' is distinct from p_epoch::text
  or not coalesce((v->>'successful_checks')::integer>=2,false) or v->'latest_ref' is distinct from p_ref
  or p_ref#>>'{source,id}' is distinct from s.id::text or p_ref#>>'{source,shared_award_id}' is distinct from s.shared_award_id::text
  or p_ref#>>'{source,url}' is distinct from s.url
  or not coalesce((v->>'first_captured_at')::timestamptz<(p_ref->>'captured_at')::timestamptz
    and (p_ref->>'captured_at')::timestamptz<=(v->>'last_checked_at')::timestamptz,false) then return false;end if;
 if v->>'status'='baseline_ready' then return coalesce(v->'baseline_ref'=v->'latest_ref',false);end if;
 return coalesce(v->>'status'='awaiting_review' and private.awardping_current_basic_pending_review(s.id) is not null,false);
exception when others then return false;end;$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION private.awardping_current_basic_validation_valid(p_validation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare p_approval boolean:=false; v_review jsonb:=p_validation->'review'; v_registry public.program_award_registry%rowtype;
 v_roster jsonb; v_ids uuid[]; v_doc jsonb; v_ref jsonb; v_source public.shared_award_sources%rowtype;
 v_state jsonb; v_field jsonb; v_item jsonb; v_quote jsonb; v_block jsonb; v_cursor integer; v_start integer; v_end integer; v_supported_years text[];
 v_fields text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship',
 'academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','requirements',
 'application_materials','how_to_apply','documents','selection','application_url','contacts'];
begin
 if not private.awardping_program_exact_object(p_validation,array['schema','review','blockers','source_text','public_facts','current_source_proofs'])
  or p_validation->>'schema' is distinct from 'awardping.current-basic-fact-validation.v1'
  or octet_length(p_validation::text)>33554432
  or not private.awardping_program_exact_object(v_review,array['schema','cohort_key','award_id','epoch','cycle','reviewed_all_sources','roster','capture_refs','fields'])
  or v_review->>'schema' is distinct from 'awardping.program-fact-review.v1'
  or jsonb_typeof(v_review->'cycle') is distinct from 'string' or length(btrim(v_review->>'cycle')) not between 1 and 120
  or v_review->'reviewed_all_sources' is distinct from 'false'::jsonb
  or not coalesce(v_review->>'epoch' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false)
  or jsonb_typeof(v_review->'roster') is distinct from 'array' or jsonb_typeof(v_review->'capture_refs') is distinct from 'array'
  or jsonb_typeof(v_review->'fields') is distinct from 'array' or jsonb_array_length(v_review->'fields')<>21
  or jsonb_typeof(p_validation->'blockers') is distinct from 'array' or jsonb_typeof(p_validation->'source_text') is distinct from 'array'
 then return false; end if;
 select * into strict v_registry from public.program_award_registry where cohort_key=v_review->>'cohort_key';
 if v_review->>'award_id' is distinct from v_registry.canonical_shared_award_id::text then return false; end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role)
 into v_roster from public.program_text_source_roster where cohort_key=v_registry.cohort_key;
 if v_roster is null or v_roster is distinct from
  (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(v_review->'roster')) then return false; end if;
 select array_agg(distinct id order by id) into v_ids from public.program_text_source_roster r,
  lateral unnest(r.source_ids) id where r.cohort_key=v_registry.cohort_key;
 if cardinality(v_ids) not between 1 and 500 or jsonb_array_length(v_review->'capture_refs')<>cardinality(v_ids)
  or jsonb_array_length(p_validation->'source_text')<>cardinality(v_ids)
  or (select count(distinct value#>>'{reference,source,id}') from jsonb_array_elements(p_validation->'source_text'))<>cardinality(v_ids)
  or (select count(distinct value#>>'{source,id}') from jsonb_array_elements(v_review->'capture_refs'))<>cardinality(v_ids)
 then return false; end if;
 for v_doc in select value from jsonb_array_elements(p_validation->'source_text') loop
  v_ref:=v_doc->'reference';
  if not private.awardping_program_exact_object(v_doc,array['reference','text','blocks','blocks_json'])
   or not private.awardping_program_text_reference_valid(v_ref)
   or not (v_ref#>>'{source,id}')::uuid=any(v_ids)
   or not exists(select 1 from jsonb_array_elements(v_review->'capture_refs') ref where ref=v_ref)
   or jsonb_typeof(v_doc->'text') is distinct from 'string'
   or private.awardping_program_utf16_length(v_doc->>'text')<>(v_ref->>'text_length')::integer
   or encode(extensions.digest(convert_to(v_doc->>'text','UTF8'),'sha256'),'hex') is distinct from v_ref->>'text_sha256'
   or jsonb_typeof(v_doc->'blocks') is distinct from 'array'
   or jsonb_typeof(v_doc->'blocks_json') is distinct from 'string'
   or (v_doc->>'blocks_json')::jsonb is distinct from v_doc->'blocks'
   or encode(extensions.digest(convert_to(v_doc->>'blocks_json','UTF8'),'sha256'),'hex') is distinct from v_ref->>'blocks_sha256'
   or jsonb_array_length(v_doc->'blocks') not between 1 and 20000
   or (select count(distinct value->>'id') from jsonb_array_elements(v_doc->'blocks'))<>jsonb_array_length(v_doc->'blocks')
  then return false; end if;
  select * into strict v_source from public.shared_award_sources where id=(v_ref#>>'{source,id}')::uuid;
  v_state:=v_source.text_monitoring_state;
  if not private.awardping_current_basic_source_ready(v_source.id,v_registry.cohort_key,(v_review->>'epoch')::uuid,v_ref) then return false;end if;
  v_cursor:=0;
  for v_block in select value from jsonb_array_elements(v_doc->'blocks') loop
   -- Keep the original optional-key representation for the immutable hash.
   -- Null defaults belong only to the legacy exact-eight-key slice validator.
   if not private.awardping_program_block_valid('{"heading":null,"page":null,"kind":null,"context":null}'::jsonb||v_block,v_doc->>'text') then return false; end if;
   v_start:=(v_block->>'start_utf16')::integer; v_end:=(v_block->>'end_utf16')::integer;
   if v_start<v_cursor or v_start>v_cursor and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,v_start) ~ '[^[:space:]]' then return false; end if;
   v_cursor:=v_end;
  end loop;
  if v_cursor<(v_ref->>'text_length')::integer and private.awardping_program_utf16_slice(v_doc->>'text',v_cursor,(v_ref->>'text_length')::integer) ~ '[^[:space:]]' then return false; end if;
 end loop;
 if (select count(distinct value->>'field') from jsonb_array_elements(v_review->'fields'))<>21 then return false; end if;
 for v_field in select value from jsonb_array_elements(v_review->'fields') loop
  if v_field->>'status'='not_published' or v_field->>'status'='verified' and not v_field->>'field'=any(array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship','academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','application_url']) then return false;end if;
  if not private.awardping_program_exact_object(v_field,array['field','status','items','note'])
   or not coalesce(v_field->>'field'=any(v_fields),false)
   or not coalesce(v_field->>'status' in ('verified','not_published','unresolved'),false)
   or jsonb_typeof(v_field->'note') is distinct from 'string' or length(v_field->>'note')>2000
   or jsonb_typeof(v_field->'items') is distinct from 'array' or jsonb_array_length(v_field->'items')>64
   or v_field->>'status'='verified' and jsonb_array_length(v_field->'items')=0
   or v_field->>'status'<>'verified' and (jsonb_array_length(v_field->'items')<>0 or length(btrim(v_field->>'note'))<20)
   or p_approval and v_field->>'status'='unresolved' then return false; end if;
  if p_approval and v_field->>'field'='overview' and (v_field->>'status'<>'verified'
   or jsonb_array_length(v_field->'items')<>1 or v_field#>>'{items,0,track}' is not null) then return false; end if;
  if (select count(distinct jsonb_build_array(value->'track',value->'value')) from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items') then return false; end if;
  for v_item in select value from jsonb_array_elements(v_field->'items') loop
   if not private.awardping_program_exact_object(v_item,array['value','track','support'])
    or jsonb_typeof(v_item->'value') is distinct from 'string' or length(btrim(v_item->>'value'))=0
    or private.awardping_program_utf16_length(v_item->>'value')>2400
    or not coalesce(jsonb_typeof(v_item->'track')='null' or jsonb_typeof(v_item->'track')='string' and length(btrim(v_item->>'track')) between 1 and 200,false)
    or jsonb_typeof(v_item->'support') is distinct from 'array' or jsonb_array_length(v_item->'support') not between 1 and 12
    or v_field->>'field'='application_url' and not coalesce(v_item->>'value' ~ '^https://[^/@\\?#[:space:]]+([/?#][^[:space:]]*)?$',false)
   then return false; end if;
   for v_quote in select value from jsonb_array_elements(v_item->'support') loop
    if not private.awardping_program_exact_object(v_quote,array['source_id','capture_id','block_id','start_utf16','end_utf16','text'])
     or jsonb_typeof(v_quote->'text') is distinct from 'string' or length(btrim(v_quote->>'text'))=0
     or private.awardping_program_utf16_length(v_quote->>'text')>1600
     or jsonb_typeof(v_quote->'start_utf16') is distinct from 'number' or jsonb_typeof(v_quote->'end_utf16') is distinct from 'number'
     or not coalesce(v_quote->>'start_utf16' ~ '^[0-9]+$' and v_quote->>'end_utf16' ~ '^[1-9][0-9]*$',false)
    then return false; end if;
    select value into strict v_doc from jsonb_array_elements(p_validation->'source_text')
     where value#>>'{reference,source,id}'=v_quote->>'source_id' and value#>>'{reference,capture_id}'=v_quote->>'capture_id';
    select value into strict v_block from jsonb_array_elements(v_doc->'blocks') where value->>'id'=v_quote->>'block_id';
    v_start:=(v_quote->>'start_utf16')::integer; v_end:=(v_quote->>'end_utf16')::integer;
    if v_start<(v_block->>'start_utf16')::integer or v_end>(v_block->>'end_utf16')::integer or v_start>=v_end
     or private.awardping_program_utf16_length(v_quote->>'text')<>v_end-v_start
     or private.awardping_program_utf16_slice(v_doc->>'text',v_start,v_end) is distinct from v_quote->>'text'
    then return false; end if;
   end loop;
   if v_field->>'field' in ('deadline','opening_date') then
    select array_agg(matches[1]) into v_supported_years from regexp_matches(
     (select string_agg(value->>'text',' ') from jsonb_array_elements(v_item->'support')),'\m((?:19|20)[0-9]{2})\M','g') matches;
    if cardinality(v_supported_years)>0 and exists(select 1 from regexp_matches(v_item->>'value','\m((?:19|20)[0-9]{2})\M','g') matches
     where not matches[1]=any(v_supported_years)) then return false; end if;
   end if;
  end loop;
  if v_field->>'field' in ('deadline','opening_date','cycle_status') and jsonb_array_length(v_field->'items')>1
   and (exists(select 1 from jsonb_array_elements(v_field->'items') where value->>'track' is null)
    or (select count(distinct value->>'track') from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items'))
  then return false; end if;
 end loop;
 if not private.awardping_current_basic_proofs_valid(v_review,p_validation->'current_source_proofs') then return false;end if;
 return (not p_approval or (v_review->>'reviewed_all_sources')::boolean and p_validation->'blockers'='[]'::jsonb)
  and p_validation->'public_facts'=private.awardping_program_fact_public_values(v_review);
exception when others then return false;
end;
$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION private.awardping_program_source_allowed(p_source_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select private.program_award_expansion_source_boundary(p_source_id) and private.awardping_pappg_canonical_admission_allowed(p_source_id) and (exists(select 1 from public.shared_award_sources s join public.shared_awards a on a.id=s.shared_award_id and a.status='active'
 join public.program_award_members member on member.shared_award_id=s.shared_award_id
 where s.id=p_source_id and private.awardping_program_text_source_access(s.id,member.cohort_key) and not exists(
 select 1 from public.stage1_award_source_identity_rules r where r.cohort_key=member.cohort_key and
 ((r.url_pattern is not null and s.url ~* r.url_pattern) or (r.title_pattern is not null and concat_ws(' ',s.title,s.display_title) ~* r.title_pattern)))
 and (exists(select 1 from public.program_text_source_roster m where m.cohort_key=member.cohort_key and s.id=any(m.source_ids)
 and not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i on i.id=h.inventory_id
  and i.revision=h.revision and i.status='sealed' where h.cohort_key=member.cohort_key)
 and m.evidence#>>array['source_bindings',s.id::text,'source_url']=s.url
 and m.evidence#>>array['source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)
 or exists(select 1 from public.program_variation_inventories i join public.program_variation_scopes v on v.inventory_id=i.id and not v.retired
 cross join lateral jsonb_array_elements(v.source_roles) role where i.status='sealed' and i.cohort_key=member.cohort_key and role->'source_ids' ? s.id::text
 and (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.revision=i.revision and h.cohort_key=i.cohort_key)
 or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
 on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 and role#>>array['evidence','source_bindings',s.id::text,'source_url']=s.url
 and role#>>array['evidence','source_bindings',s.id::text,'shared_award_id']=s.shared_award_id::text)))
 or private.awardping_program_text_source_registration_allowed(p_source_id));
$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION private.awardping_program_text_source_access(p_source_id uuid, p_cohort text DEFAULT NULL::text, p_epoch uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select private.program_award_expansion_source_boundary(p_source_id) and private.awardping_pappg_canonical_admission_allowed(p_source_id,p_cohort,p_epoch) and exists(select 1 from public.shared_award_sources s where s.id=p_source_id and
  (s.admin_review_status='open' and (p_cohort is null or exists(select 1 from public.program_award_members m where m.cohort_key=p_cohort and m.shared_award_id=s.shared_award_id))
   or exists(select 1 from jsonb_array_elements(private.awardping_program_text_source_approval_dto(s.id)) a
    where (p_cohort is null or a->>'cohort_key'=p_cohort) and a->>'epoch'=coalesce(p_epoch,
      (select epoch from public.program_text_source_authority_epochs where active))::text)));
$function$
;

-- Reviewed current function; change only modern identity/membership scope and activation admission.
CREATE OR REPLACE FUNCTION private.public_digest_events_are_current(p_event_bindings jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with bindings as (
    select binding.value
    from pg_catalog.jsonb_array_elements(p_event_bindings) binding(value)
  ), validated as (
    select change_event.id
    from bindings binding
    join public.shared_award_change_events change_event
      on change_event.id = (binding.value ->> 'eventId')::uuid
    join public.shared_award_sources source
      on source.id = change_event.shared_award_source_id
      and source.shared_award_id = change_event.shared_award_id
    join public.program_award_members member
      on member.shared_award_id = change_event.shared_award_id
    join public.program_award_registry registry
      on registry.cohort_key = member.cohort_key
    join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = change_event.id
    where private.program_award_identity_is_public(member.cohort_key)
      and change_event.shared_award_id = (binding.value ->> 'memberAwardId')::uuid
      and registry.canonical_shared_award_id = (binding.value ->> 'awardId')::uuid
      and registry.canonical_name = binding.value ->> 'awardName'
      and change_event.shared_award_source_id = (binding.value ->> 'sourceId')::uuid
      and change_event.source_url = binding.value ->> 'sourceUrl'
      and coalesce(pg_catalog.to_jsonb(change_event.source_title), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourceTitle', 'null'::jsonb)
      and coalesce(pg_catalog.to_jsonb(change_event.source_page_type), 'null'::jsonb) =
        coalesce(binding.value -> 'eventSourcePageType', 'null'::jsonb)
      and change_event.summary = binding.value ->> 'eventSummary'
      and coalesce(change_event.change_details, 'null'::jsonb) =
        coalesce(binding.value -> 'eventChangeDetails', 'null'::jsonb)
      and source.url = change_event.source_url
      and change_event.detected_at = (binding.value ->> 'detectedAt')::timestamptz
      and change_event.suppressed_at is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppressed_at'), '') is null
      and nullif(pg_catalog.btrim(change_event.change_details ->> 'suppression_reason'), '') is null
      and change_event.visual_review_candidate_id is not distinct from
        nullif(binding.value ->> 'visualReviewCandidateId', '')::uuid
      and evidence.id = (binding.value ->> 'visualEvidenceId')::uuid
      and evidence.shared_award_id = change_event.shared_award_id
      and evidence.shared_award_source_id is not distinct from change_event.shared_award_source_id
      and evidence.visual_review_candidate_id is not distinct from
        change_event.visual_review_candidate_id
      and evidence.evidence_status = binding.value ->> 'visualEvidenceStatus'
      and evidence.evidence_schema_version = binding.value ->> 'visualEvidenceSchemaVersion'
      and evidence.candidate_signature is not distinct from
        nullif(binding.value ->> 'visualEvidenceCandidateSignature', '')
      and (
        (source.admin_review_status = 'open' and exists (
          select 1
          from public.stage1_award_source_manifest manifest
          where manifest.cohort_key = registry.cohort_key
            and change_event.shared_award_source_id = any(manifest.source_ids)
        ))
        or private.public_digest_reviewed_text_source_current(change_event.id)
      )
  )
  select coalesce(
    pg_catalog.jsonb_typeof(p_event_bindings) = 'array'
    and pg_catalog.jsonb_array_length(p_event_bindings) between 1 and 12
    and (select count(*) from bindings) =
      (select count(distinct binding.value ->> 'eventId') from bindings binding)
    and (select count(*) from validated) = (select count(*) from bindings),
    false
  );
$function$
;

-- Reviewed current function; change only modern identity/membership scope and activation admission.
CREATE OR REPLACE FUNCTION private.public_digest_reviewed_text_source_current(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare event public.shared_award_change_events%rowtype;source public.shared_award_sources%rowtype;
 candidate public.shared_award_visual_review_candidates%rowtype;evidence public.shared_award_change_event_visual_evidence%rowtype;
 review public.program_text_alert_reviews%rowtype;active_epoch uuid;cohort text;
begin
 select * into strict event from public.shared_award_change_events where id=p_event_id;
 select * into strict source from public.shared_award_sources where id=event.shared_award_source_id;
 select * into strict candidate from public.shared_award_visual_review_candidates where id=event.visual_review_candidate_id;
 select * into strict evidence from public.shared_award_change_event_visual_evidence where change_event_id=event.id;
 select * into strict review from public.program_text_alert_reviews where id=candidate.id;
 select epoch into strict active_epoch from public.program_text_source_authority_epochs where active;
 select member.cohort_key into strict cohort from public.program_award_members member
 join public.program_award_registry registry on registry.cohort_key=member.cohort_key
 join public.program_award_members canonical_member on canonical_member.cohort_key=registry.cohort_key
  and canonical_member.shared_award_id=registry.canonical_shared_award_id and canonical_member.member_kind='canonical'
 join public.shared_awards owner on owner.id=member.shared_award_id and owner.status='active'
 join public.shared_awards canonical on canonical.id=registry.canonical_shared_award_id and canonical.status='active'
 where member.shared_award_id=source.shared_award_id;
 if not private.program_award_identity_is_public(cohort) then return false;end if;
 if source.shared_award_id is distinct from event.shared_award_id or source.url is distinct from event.source_url
  or not coalesce(source.admin_review_status in ('open','review_later'),false)
  or candidate.candidate_scope is distinct from 'program_text_change' or candidate.status is distinct from 'published'
  or candidate.published_at is null or candidate.shared_award_id is distinct from event.shared_award_id
  or candidate.shared_award_source_id is distinct from source.id or candidate.source_url is distinct from source.url
  or candidate.worker_metadata->>'change_event_id' is distinct from event.id::text
  or candidate.worker_metadata->>'admin_alert_review_id' is distinct from candidate.id::text
  or candidate.worker_metadata->>'epoch' is distinct from active_epoch::text
  or source.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
  or source.text_monitoring_state->>'epoch' is distinct from active_epoch::text
  or evidence.evidence_status is distinct from 'verified_text'
  or evidence.evidence_schema_version is distinct from 'program-text-event-evidence-v1'
  or evidence.shared_award_id is distinct from event.shared_award_id
  or evidence.shared_award_source_id is distinct from source.id
  or evidence.visual_review_candidate_id is distinct from candidate.id
  or evidence.candidate_signature is distinct from candidate.candidate_signature
  or evidence.previous_capture is distinct from candidate.previous_snapshot_ref
  or evidence.current_capture is distinct from candidate.new_snapshot_ref
  or review.status is distinct from 'approved' or review.event_id is distinct from event.id
  or review.reviewed_at is null or review.reviewed_by is null
  or review.candidate_signature is distinct from candidate.candidate_signature
  or review.details is distinct from event.change_details or review.localization is distinct from evidence.localization
  or review.content_hash is distinct from private.program_text_alert_hash(candidate,review.details,review.localization)
 then return false;end if;
 if not coalesce(private.awardping_program_source_allowed(source.id),false) then return false;end if;
 -- Reuse current common/registered/scoped authority. Public eligibility does
 -- not claim that every provider role or application variation is complete.
 -- Reuse the complete production validator: exact quote/block/source/epoch and
 -- accepted saved-response bindings stay in force. A claimed visual/text row
 -- without this immutable evidence and approved owner decision cannot pass.
 perform public.awardping_validate_program_text_evidence(to_jsonb(evidence),to_jsonb(candidate),event.change_details);
 return true;
exception when others then return false;
end;
$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION public.commit_current_program_basic_facts(p_draft_id uuid, p_expected_draft_hash text, p_expected_head_id uuid, p_receipt jsonb, p_receipt_hash text, p_plan_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.program_text_fact_reviews%rowtype;h uuid;v public.program_basic_fact_snapshots%rowtype;projection jsonb;expected jsonb;refs jsonb;versions jsonb;vh text;
begin
 if not coalesce(p_expected_draft_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_receipt_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false)
 or p_receipt is null or octet_length(p_receipt::text)>8388608 or not private.awardping_program_exact_object(p_receipt,array['schema','cohort_key','award_id','epoch','cycle','input_review_id','input_review_hash','selected_fields','reviewed_at','roster','supporting_capture_refs','current_capture_refs','public_facts','current_source_proofs'])
 then raise exception 'Exact bounded current basic snapshot required.' using errcode='23514';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict d from public.program_text_fact_reviews where id=p_draft_id for share;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||d.cohort_key,0));
 perform 1 from public.program_award_registry where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_roster where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_authority_epochs where active for share;
 perform 1 from public.shared_award_sources where id in(select (value#>>'{source,id}')::uuid from jsonb_array_elements(d.validation#>'{review,capture_refs}')) order by id for share;
 if d.content_hash is distinct from p_expected_draft_hash or not private.awardping_current_basic_validation_valid(d.validation)
 or not coalesce((p_receipt->>'reviewed_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false)
 then raise exception 'Saved current basic sources or fresh review changed.' using errcode='40001';end if;
 projection:=private.awardping_basic_fact_selection(d.validation,p_receipt->'selected_fields');refs:=d.validation#>'{review,capture_refs}';
 expected:=jsonb_build_object('schema','awardping.current-basic-award-fact-review.v1','cohort_key',d.cohort_key,'award_id',d.validation#>'{review,award_id}','epoch',d.validation#>'{review,epoch}','cycle',d.validation#>'{review,cycle}',
 'input_review_id',d.id,'input_review_hash',d.content_hash,'selected_fields',p_receipt->'selected_fields','reviewed_at',p_receipt->'reviewed_at','roster',d.validation#>'{review,roster}',
 'supporting_capture_refs',refs,'current_capture_refs',refs,'public_facts',projection,'current_source_proofs',d.validation->'current_source_proofs');
 vh:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(expected),'UTF8'),'sha256'),'hex');
 if expected is distinct from p_receipt or vh is distinct from p_receipt_hash then raise exception 'Independent current basic projection differs.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('source_id',r#>>'{source,id}','owner_id',r#>>'{source,shared_award_id}','url',r#>>'{source,url}','epoch',d.validation#>>'{review,epoch}',
 'content_identity',private.awardping_basic_content_identity(r),'repeat_observation_id',p->'repeat_observation_id','pending_alert_review_id',p->'pending_alert_review_id','pending_alert_review_hash',p->'pending_alert_review_hash') order by r#>>'{source,id}') into versions
 from jsonb_array_elements(refs) r join jsonb_array_elements(d.validation->'current_source_proofs') p on p->>'source_id'=r#>>'{source,id}';
 select snapshot_id into h from public.program_basic_fact_heads where cohort_key=d.cohort_key for update;
 if h is not null and exists(select 1 from public.program_basic_fact_snapshots x where x.id=h and x.content_hash=vh and x.input_review_id=d.id and x.input_review_hash=d.content_hash and x.previous_snapshot_id is not distinct from p_expected_head_id and x.root_plan_hash=p_plan_hash)
 then return jsonb_build_object('ok',true,'snapshot_id',h,'already_applied',true,'kind','automated_source_verified_basics');end if;
 if h is distinct from p_expected_head_id then raise exception 'Basic head changed.' using errcode='40001';end if;
 insert into public.program_basic_fact_snapshots(cohort_key,award_id,input_review_id,input_review_hash,previous_snapshot_id,receipt,content_hash,root_plan_hash,source_versions,public_facts)
 values(d.cohort_key,(d.validation#>>'{review,award_id}')::uuid,d.id,d.content_hash,h,expected,vh,p_plan_hash,versions,projection) returning * into v;
 insert into public.program_basic_fact_heads(cohort_key,snapshot_id) values(d.cohort_key,v.id) on conflict(cohort_key) do update set snapshot_id=excluded.snapshot_id,updated_at=now();
 return jsonb_build_object('ok',true,'snapshot_id',v.id,'already_applied',false,'kind',v.kind);
end;$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION public.get_program_text_public_alert_source_bindings(p_epoch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_active_epoch uuid; v_input_count integer; v_bindings jsonb;
begin
 if p_epoch is null or p_epoch='00000000-0000-0000-0000-000000000000'::uuid then
  raise exception 'A current text monitoring epoch is required.' using errcode='23514';
 end if;
 select epoch into strict v_active_epoch from public.program_text_source_authority_epochs where active;
 if p_epoch is distinct from v_active_epoch then
  raise exception 'Text source authority epoch changed.' using errcode='40001';
 end if;

 -- Bound actual current text observations before invoking source authority.
 -- The existing helper already covers common, registered and active scoped
 -- sources, URL ownership, current approvals and finite canonical fences.
 select count(*)::integer into v_input_count from (
  select source.id from public.shared_award_sources source
  join public.program_award_members member on member.shared_award_id=source.shared_award_id
  where source.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
   and source.text_monitoring_state->>'epoch'=p_epoch::text
   and source.admin_review_status in ('open','review_later')
  limit 50001
 ) bounded;
 if v_input_count>50000 then
  raise exception 'Public alert source scope exceeds its bounded limit.' using errcode='23514';
 end if;
 with eligible as (
  select member.cohort_key,source.id as source_id,source.shared_award_id,source.url
  from public.shared_award_sources source
  join public.program_award_members member on member.shared_award_id=source.shared_award_id
  join public.program_award_registry registry on registry.cohort_key=member.cohort_key
  join public.program_award_members canonical_member on canonical_member.cohort_key=registry.cohort_key
   and canonical_member.shared_award_id=registry.canonical_shared_award_id and canonical_member.member_kind='canonical'
  join public.shared_awards owner on owner.id=source.shared_award_id and owner.status='active'
  join public.shared_awards canonical on canonical.id=registry.canonical_shared_award_id and canonical.status='active'
  where source.text_monitoring_state->>'schema'='awardping.program-text-state.v1'
   and source.text_monitoring_state->>'epoch'=p_epoch::text
   and source.admin_review_status in ('open','review_later')
   and private.awardping_program_source_allowed(source.id)
   and private.program_award_identity_is_public(member.cohort_key)
 )
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'source_id',source_id,
  'shared_award_id',shared_award_id,'url',url,'epoch',p_epoch)
  order by cohort_key collate "C",source_id),'[]'::jsonb) into v_bindings from eligible;
 if jsonb_array_length(v_bindings)>50000 then
  raise exception 'Public alert source output exceeds its bounded limit.' using errcode='23514';
 end if;
 return jsonb_build_object('schema','awardping.program-text-public-alert-sources.v1','epoch',p_epoch,
  'source_count',jsonb_array_length(v_bindings),'bindings',v_bindings);
end;
$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION public.get_program_text_worker_roster_page(p_kind text, p_after jsonb DEFAULT NULL::jsonb, p_expected_roster_seal text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
 v_roles jsonb; v_sources jsonb; v_ids uuid[]; v_seal text; v_entries jsonb; v_next jsonb;
 v_role_count integer; v_source_count integer; v_cohort_count integer;
begin
 if p_kind is null or p_kind not in ('roles','sources','check') or p_limit is null or p_limit not between 1 and 100
  or p_expected_roster_seal is not null and p_expected_roster_seal !~ '^[a-f0-9]{64}$'
  or p_kind='check' and (p_after is not null or p_expected_roster_seal is null)
 then raise exception 'Invalid worker roster page request.' using errcode='23514'; end if;
 if p_after is not null then
  if p_expected_roster_seal is null then raise exception 'Roster cursor requires its identity seal.' using errcode='23514'; end if;
  if p_kind='roles' then
   if jsonb_typeof(p_after) is distinct from 'array' or jsonb_array_length(p_after)<>3 then
    raise exception 'Invalid worker role cursor.' using errcode='23514'; end if;
   if exists(select 1 from jsonb_array_elements(p_after) item
    where jsonb_typeof(item)<>'string' or item#>>'{}' !~ '^[a-z0-9_-]{1,200}$')
    or length(p_after->>0)>80 or length(p_after->>2)>80 then
    raise exception 'Invalid worker role cursor.' using errcode='23514'; end if;
  elsif p_kind='sources' and (jsonb_typeof(p_after) is distinct from 'string'
   or p_after#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
   raise exception 'Invalid worker source cursor.' using errcode='23514';
  end if;
 end if;

 with active_inventories as (
  select i.* from public.program_variation_inventories i where i.status='sealed' and
   (exists(select 1 from public.program_variation_inventory_heads h where h.inventory_id=i.id and h.cohort_key=i.cohort_key and h.revision=i.revision)
    or exists(select 1 from public.program_variation_release release join public.program_variation_award_approvals approval
     on approval.id::text=release.approval_ids->>i.cohort_key where release.is_active and approval.inventory_id=i.id and approval.cohort_key=i.cohort_key))
 ),roles as (
  select r.cohort_key,'legacy_common'::text as scope_key,r.source_role,r.source_ids,r.manifest_status,r.evidence,r.revision,
   null::uuid as inventory_id,null::uuid as inventory_revision,null::text as cycle,null::text as variation_scope_key
  from public.program_text_source_roster r
  where not exists(select 1 from public.program_variation_inventory_heads h join public.program_variation_inventories i
   on i.id=h.inventory_id and i.cohort_key=h.cohort_key and i.revision=h.revision and i.status='sealed' where h.cohort_key=r.cohort_key)
  union all
  select i.cohort_key,'inventory_'||replace(i.id::text,'-','')||'_'||s.scope_key,role->>'source_role',
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),
   role->>'manifest_status',role->'evidence',(role->>'revision')::uuid,i.id,i.revision,i.cycle,s.scope_key
  from active_inventories i
  join public.program_variation_scopes s on s.inventory_id=i.id and not s.retired
  cross join lateral jsonb_array_elements(s.source_roles) role
  union all
  select role->>'cohort_key',role->>'scope_key',role->>'source_role',
   array(select source_ids.source_id::uuid from jsonb_array_elements_text(role->'source_ids') as source_ids(source_id)),role->>'manifest_status',role->'evidence',
   (role->>'revision')::uuid,(role->>'inventory_id')::uuid,(role->>'inventory_revision')::uuid,role->>'cycle',role->>'variation_scope_key'
  from jsonb_array_elements(private.awardping_program_text_registered_source_roles()) role
 )
 select coalesce(jsonb_agg(jsonb_build_object('cohort_key',cohort_key,'scope_key',scope_key,'source_role',source_role,
  'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence,'revision',revision,
  'inventory_id',inventory_id,'inventory_revision',inventory_revision,'cycle',cycle,'variation_scope_key',variation_scope_key)
  order by cohort_key collate "C",scope_key collate "C",source_role collate "C"),'[]'::jsonb)
 into v_roles from roles;
 if exists(select 1 from jsonb_array_elements(v_roles) role
  group by role->>'cohort_key',role->>'scope_key',role->>'source_role' having count(*)<>1) then
  raise exception 'Worker roster has duplicate role identities.' using errcode='23514'; end if;
 select array_agg(distinct source_ids.source_id::uuid order by source_ids.source_id::uuid) into v_ids
 from jsonb_array_elements(v_roles) as role_rows(role_entry)
 cross join lateral jsonb_array_elements_text(role_rows.role_entry->'source_ids') as source_ids(source_id);
 v_role_count:=jsonb_array_length(v_roles); v_source_count:=coalesce(cardinality(v_ids),0);
 -- Registry membership is independent of page enumeration: omitting a whole
 -- award's roles must fail the worker's exact cohort-union check as well.
 select count(*)::integer into v_cohort_count from public.program_award_registry;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'shared_award_id',s.shared_award_id,'url',s.url,
  'title',s.title,'page_type',s.page_type,'admin_review_status',s.admin_review_status,
  'text_source_approvals',private.awardping_program_text_source_approval_dto(s.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(s.id,(select epoch from public.program_text_source_authority_epochs where active))) order by s.id),'[]'::jsonb)
 into v_sources from public.shared_award_sources s where s.id=any(v_ids);
 if jsonb_array_length(v_sources)<>v_source_count then
  raise exception 'Worker roster source identities are incomplete.' using errcode='23514'; end if;
 v_seal:=encode(extensions.digest(convert_to(jsonb_build_object('roles',v_roles,'sources',v_sources)::text,'UTF8'),'sha256'),'hex');
 if p_expected_roster_seal is not null and v_seal<>p_expected_roster_seal then
  raise exception 'Worker roster identity changed during enumeration.' using errcode='40001'; end if;

 if p_kind='roles' then
  select coalesce(jsonb_agg(entry order by ordinal),'[]'::jsonb) into v_entries
  from (select entry,ordinal from jsonb_array_elements(v_roles) with ordinality role(entry,ordinal)
   where p_after is null or row((entry->>'cohort_key') collate "C",(entry->>'scope_key') collate "C",(entry->>'source_role') collate "C")>
    row((p_after->>0) collate "C",(p_after->>1) collate "C",(p_after->>2) collate "C")
   order by ordinal limit p_limit+1) page;
 elsif p_kind='sources' then
  select coalesce(jsonb_agg(entry order by id),'[]'::jsonb) into v_entries
  from (select s.id,identity.entry || jsonb_build_object(
   'text_monitoring_state',s.text_monitoring_state,
   'text_collection_quality',private.awardping_program_text_collection_quality(s.id)) as entry
   from jsonb_array_elements(v_sources) as identity(entry)
   join public.shared_award_sources s on s.id=(identity.entry->>'id')::uuid
   where p_after is null or s.id>(p_after#>>'{}')::uuid
   order by s.id limit p_limit+1) page;
 else v_entries:='[]'::jsonb;
 end if;
 v_next:=null;
 if jsonb_array_length(v_entries)>p_limit then
  v_entries:=v_entries-(p_limit);
  v_next:=case when p_kind='roles' then jsonb_build_array(v_entries->(p_limit-1)->>'cohort_key',
   v_entries->(p_limit-1)->>'scope_key',v_entries->(p_limit-1)->>'source_role')
   else v_entries->(p_limit-1)->'id' end;
 end if;
 return jsonb_build_object('schema','awardping.program-text-worker-roster-page.v1','roster_seal',v_seal,
  'role_count',v_role_count,'source_count',v_source_count,'cohort_count',v_cohort_count,'entries',v_entries,'next_cursor',v_next);
end;
$function$
;

-- Reviewed current function; change only modern identity/membership scope.
CREATE OR REPLACE FUNCTION public.inspect_current_program_basic_award(p_cohort_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e uuid;ids uuid[];r jsonb;s jsonb;m jsonb;registry jsonb;head uuid;pending jsonb;observations jsonb;
begin
 select epoch into strict e from public.program_text_source_authority_epochs where active;
 select jsonb_build_object('cohort_key',cohort_key,'canonical_shared_award_id',canonical_shared_award_id) into strict registry from public.program_award_registry where cohort_key=p_cohort_key;
 select array_agg(distinct id) into ids from public.program_text_source_roster x cross join lateral unnest(x.source_ids) id where x.cohort_key=p_cohort_key;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence) order by source_role) into r from public.program_text_source_roster where cohort_key=p_cohort_key;
 if not coalesce(cardinality(ids) between 1 and 500,false) or not coalesce(jsonb_array_length(r) between 1 and 100,false) then raise exception 'Bounded full source set required.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('id',x.id,'shared_award_id',x.shared_award_id,'url',x.url,'title',x.title,'page_type',x.page_type,'admin_review_status',x.admin_review_status,'text_monitoring_state',x.text_monitoring_state,
  'text_collection_quality',private.awardping_program_text_collection_quality(x.id),'text_source_approvals',private.awardping_program_text_source_approval_dto(x.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(x.id,e)) order by x.id) into s from public.shared_award_sources x where x.id=any(ids);
 select jsonb_agg(shared_award_id order by shared_award_id) into m from public.program_award_members where cohort_key=p_cohort_key;
 if not coalesce(jsonb_array_length(m) between 1 and 100,false) or jsonb_array_length(s)<>cardinality(ids) then raise exception 'Source identity/membership incomplete.' using errcode='23514';end if;
 select coalesce(jsonb_agg(p order by id),'[]'::jsonb) into pending from (select id,private.awardping_current_basic_pending_review(id) p from unnest(ids) id) x where p is not null;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'cohort_key',o.cohort_key,'source_id',o.source_id,'epoch',o.epoch,'current_ref',o.current_ref,'repeat_ref',o.repeat_ref,'content_identity',o.content_identity,'verified_at',o.verified_at) order by o.created_at desc,o.id),'[]'::jsonb)
 into observations from (select limited.* from public.shared_award_sources x cross join lateral (
  select z.* from public.program_basic_repeat_observations z where z.cohort_key=p_cohort_key and z.epoch=e and z.source_id=x.id
   and z.content_identity=private.awardping_basic_content_identity(x.text_monitoring_state->'latest_ref') order by z.created_at desc,z.id limit 8
 ) limited where x.id=any(ids)) o;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=p_cohort_key;
 return jsonb_build_object('schema','awardping.current-basic-award-context.v1','head_id',head,'context',jsonb_build_object('registry',registry,'roles',r,'sources',s,'memberIds',m,'epoch',e,'pending_alert_reviews',pending,'repeat_observations',observations));
end;$function$
;

grant execute on function private.program_award_expansion_source_proof(uuid),private.program_award_expansion_source_boundary(uuid),private.program_award_identity_is_public(text) to service_role;

-- Existing baseline-ready basic snapshots remain independent of full approval.
CREATE OR REPLACE FUNCTION private.awardping_program_fact_validation_valid(p_validation jsonb, p_approval boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_review jsonb:=p_validation->'review'; v_registry public.program_award_registry%rowtype;
 v_roster jsonb; v_ids uuid[]; v_doc jsonb; v_ref jsonb; v_source public.shared_award_sources%rowtype;
 v_state jsonb; v_field jsonb; v_item jsonb; v_quote jsonb; v_block jsonb; v_cursor integer; v_start integer; v_end integer; v_supported_years text[];
 v_fields text[]:=array['overview','opening_date','deadline','cycle_status','important_dates','eligibility','citizenship',
 'academic_levels','disciplines','award_amounts','stipend','tuition','travel_research_allowance','tenure','requirements',
 'application_materials','how_to_apply','documents','selection','application_url','contacts'];
begin
 if exists(select 1 from public.program_award_registry r where r.cohort_key=v_review->>'cohort_key' and r.launch_rank>25)
  and coalesce(p_approval,true) then return false;end if;
 if not private.awardping_program_exact_object(p_validation,array['schema','review','blockers','source_text','public_facts'])
  or p_validation->>'schema' is distinct from 'awardping.program-fact-validation.v1'
  or octet_length(p_validation::text)>33554432
  or not private.awardping_program_exact_object(v_review,array['schema','cohort_key','award_id','epoch','cycle','reviewed_all_sources','roster','capture_refs','fields'])
  or v_review->>'schema' is distinct from 'awardping.program-fact-review.v1'
  or jsonb_typeof(v_review->'cycle') is distinct from 'string' or length(btrim(v_review->>'cycle')) not between 1 and 120
  or jsonb_typeof(v_review->'reviewed_all_sources') is distinct from 'boolean'
  or not coalesce(v_review->>'epoch' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false)
  or jsonb_typeof(v_review->'roster') is distinct from 'array' or jsonb_typeof(v_review->'capture_refs') is distinct from 'array'
  or jsonb_typeof(v_review->'fields') is distinct from 'array' or jsonb_array_length(v_review->'fields')<>21
  or jsonb_typeof(p_validation->'blockers') is distinct from 'array' or jsonb_typeof(p_validation->'source_text') is distinct from 'array'
 then return false; end if;
 select * into strict v_registry from public.program_award_registry where cohort_key=v_review->>'cohort_key';
 if v_review->>'award_id' is distinct from v_registry.canonical_shared_award_id::text then return false; end if;
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids) order by source_role)
 into v_roster from public.program_text_source_roster where cohort_key=v_registry.cohort_key;
 if v_roster is null or v_roster is distinct from
  (select jsonb_agg(value order by value->>'source_role') from jsonb_array_elements(v_review->'roster')) then return false; end if;
 select array_agg(distinct id order by id) into v_ids from public.program_text_source_roster r,
  lateral unnest(r.source_ids) id where r.cohort_key=v_registry.cohort_key;
 if cardinality(v_ids) not between 1 and 500 or jsonb_array_length(v_review->'capture_refs')<>cardinality(v_ids)
  or jsonb_array_length(p_validation->'source_text')<>cardinality(v_ids)
  or (select count(distinct value#>>'{reference,source,id}') from jsonb_array_elements(p_validation->'source_text'))<>cardinality(v_ids)
  or (select count(distinct value#>>'{source,id}') from jsonb_array_elements(v_review->'capture_refs'))<>cardinality(v_ids)
 then return false; end if;
 for v_doc in select value from jsonb_array_elements(p_validation->'source_text') loop
  v_ref:=v_doc->'reference';
  if not private.awardping_program_exact_object(v_doc,array['reference','text','blocks','blocks_json'])
   or not private.awardping_program_text_reference_valid(v_ref)
   or not (v_ref#>>'{source,id}')::uuid=any(v_ids)
   or not exists(select 1 from jsonb_array_elements(v_review->'capture_refs') ref where ref=v_ref)
   or jsonb_typeof(v_doc->'text') is distinct from 'string'
   or private.awardping_program_utf16_length(v_doc->>'text')<>(v_ref->>'text_length')::integer
   or encode(extensions.digest(convert_to(v_doc->>'text','UTF8'),'sha256'),'hex') is distinct from v_ref->>'text_sha256'
   or jsonb_typeof(v_doc->'blocks') is distinct from 'array'
   or jsonb_typeof(v_doc->'blocks_json') is distinct from 'string'
   or (v_doc->>'blocks_json')::jsonb is distinct from v_doc->'blocks'
   or encode(extensions.digest(convert_to(v_doc->>'blocks_json','UTF8'),'sha256'),'hex') is distinct from v_ref->>'blocks_sha256'
   or jsonb_array_length(v_doc->'blocks') not between 1 and 20000
   or (select count(distinct value->>'id') from jsonb_array_elements(v_doc->'blocks'))<>jsonb_array_length(v_doc->'blocks')
  then return false; end if;
  select * into strict v_source from public.shared_award_sources where id=(v_ref#>>'{source,id}')::uuid;
  v_state:=v_source.text_monitoring_state;
  if private.awardping_program_fact_known_html_shell(v_ref)
   or private.awardping_program_fact_known_footer_only_pdf(v_ref)
   or not private.awardping_program_source_allowed(v_source.id)
   or v_ref#>>'{source,shared_award_id}' is distinct from v_source.shared_award_id::text
   or v_ref#>>'{source,url}' is distinct from v_source.url
   or not exists(select 1 from public.program_award_members m where m.shared_award_id=v_source.shared_award_id and m.cohort_key=v_registry.cohort_key)
   or v_state->>'schema' is distinct from 'awardping.program-text-state.v1' or v_state->>'epoch' is distinct from v_review->>'epoch'
   or v_state->>'status' is distinct from 'baseline_ready' or not coalesce((v_state->>'successful_checks')::integer>=2,false)
   or v_state->'baseline_ref' is distinct from v_state->'latest_ref'
   or v_state#>>'{latest_ref,text_sha256}' is distinct from v_ref->>'text_sha256'
   or v_state#>>'{latest_ref,final_url}' is distinct from v_ref->>'final_url'
   or v_state#>>'{latest_ref,acquisition}' is distinct from v_ref->>'acquisition'
   or v_state#>'{latest_ref,extractor}' is distinct from v_ref->'extractor'
   or not coalesce((v_state->>'first_captured_at')::timestamptz<(v_state#>>'{latest_ref,captured_at}')::timestamptz
    and (v_ref->>'captured_at')::timestamptz<=(v_state->>'last_checked_at')::timestamptz,false)
  then return false; end if;
  -- Reuse the already-applied strict cached document proof. Source/currentness,
  -- roles, metadata hashes, fields/quotes and approval gates stay unchanged.
  if private.awardping_program_source_approval_document_valid(v_doc) is distinct from true then return false;end if;
 end loop;
 if (select count(distinct value->>'field') from jsonb_array_elements(v_review->'fields'))<>21 then return false; end if;
 for v_field in select value from jsonb_array_elements(v_review->'fields') loop
  if not private.awardping_program_exact_object(v_field,array['field','status','items','note'])
   or not coalesce(v_field->>'field'=any(v_fields),false)
   or not coalesce(v_field->>'status' in ('verified','not_published','unresolved'),false)
   or jsonb_typeof(v_field->'note') is distinct from 'string' or length(v_field->>'note')>2000
   or jsonb_typeof(v_field->'items') is distinct from 'array' or jsonb_array_length(v_field->'items')>64
   or v_field->>'status'='verified' and jsonb_array_length(v_field->'items')=0
   or v_field->>'status'<>'verified' and (jsonb_array_length(v_field->'items')<>0 or length(btrim(v_field->>'note'))<20)
   or p_approval and v_field->>'status'='unresolved' then return false; end if;
  if p_approval and v_field->>'field'='overview' and (v_field->>'status'<>'verified'
   or jsonb_array_length(v_field->'items')<>1 or v_field#>>'{items,0,track}' is not null) then return false; end if;
  if (select count(distinct jsonb_build_array(value->'track',value->'value')) from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items') then return false; end if;
  for v_item in select value from jsonb_array_elements(v_field->'items') loop
   if not private.awardping_program_exact_object(v_item,array['value','track','support'])
    or jsonb_typeof(v_item->'value') is distinct from 'string' or length(btrim(v_item->>'value'))=0
    or private.awardping_program_utf16_length(v_item->>'value')>2400
    or not coalesce(jsonb_typeof(v_item->'track')='null' or jsonb_typeof(v_item->'track')='string' and length(btrim(v_item->>'track')) between 1 and 200,false)
    or jsonb_typeof(v_item->'support') is distinct from 'array' or jsonb_array_length(v_item->'support') not between 1 and 12
    or v_field->>'field'='application_url' and not coalesce(v_item->>'value' ~ '^https://[^/@\\?#[:space:]]+([/?#][^[:space:]]*)?$',false)
   then return false; end if;
   for v_quote in select value from jsonb_array_elements(v_item->'support') loop
    if not private.awardping_program_exact_object(v_quote,array['source_id','capture_id','block_id','start_utf16','end_utf16','text'])
     or jsonb_typeof(v_quote->'text') is distinct from 'string' or length(btrim(v_quote->>'text'))=0
     or private.awardping_program_utf16_length(v_quote->>'text')>1600
     or jsonb_typeof(v_quote->'start_utf16') is distinct from 'number' or jsonb_typeof(v_quote->'end_utf16') is distinct from 'number'
     or not coalesce(v_quote->>'start_utf16' ~ '^[0-9]+$' and v_quote->>'end_utf16' ~ '^[1-9][0-9]*$',false)
    then return false; end if;
    select value into strict v_doc from jsonb_array_elements(p_validation->'source_text')
     where value#>>'{reference,source,id}'=v_quote->>'source_id' and value#>>'{reference,capture_id}'=v_quote->>'capture_id';
    select value into strict v_block from jsonb_array_elements(v_doc->'blocks') where value->>'id'=v_quote->>'block_id';
    if v_block->>'kind'='publisher_data' or v_block#>>'{context,representation}'='publisher_data' then return false;end if;
    v_start:=(v_quote->>'start_utf16')::integer; v_end:=(v_quote->>'end_utf16')::integer;
    if v_start<(v_block->>'start_utf16')::integer or v_end>(v_block->>'end_utf16')::integer or v_start>=v_end
     or private.awardping_program_utf16_length(v_quote->>'text')<>v_end-v_start
     or private.awardping_program_utf16_slice(v_doc->>'text',v_start,v_end) is distinct from v_quote->>'text'
    then return false; end if;
   end loop;
   if v_field->>'field' in ('deadline','opening_date') then
    select array_agg(matches[1]) into v_supported_years from regexp_matches(
     (select string_agg(value->>'text',' ') from jsonb_array_elements(v_item->'support')),'\m((?:19|20)[0-9]{2})\M','g') matches;
    if cardinality(v_supported_years)>0 and exists(select 1 from regexp_matches(v_item->>'value','\m((?:19|20)[0-9]{2})\M','g') matches
     where not matches[1]=any(v_supported_years)) then return false; end if;
   end if;
  end loop;
  if v_field->>'field' in ('deadline','opening_date','cycle_status') and jsonb_array_length(v_field->'items')>1
   and (exists(select 1 from jsonb_array_elements(v_field->'items') where value->>'track' is null)
    or (select count(distinct value->>'track') from jsonb_array_elements(v_field->'items'))<>jsonb_array_length(v_field->'items'))
  then return false; end if;
 end loop;
 return (not p_approval or (v_review->>'reviewed_all_sources')::boolean and p_validation->'blockers'='[]'::jsonb)
  and p_validation->'public_facts'=private.awardping_program_fact_public_values(v_review);
exception when others then return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.awardping_basic_fact_current_v1(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare s public.program_basic_fact_snapshots%rowtype;r jsonb;src public.shared_award_sources%rowtype;
begin
 select * into strict s from public.program_basic_fact_snapshots where id=p_id;
 if not exists(select 1 from public.program_award_registry x where x.cohort_key=s.cohort_key and x.canonical_shared_award_id=s.award_id)
  or not exists(select 1 from public.program_text_source_authority_epochs x where x.active and x.epoch::text=s.receipt->>'epoch') then return false;end if;
 for r in select value from jsonb_array_elements(s.source_versions) loop
  select * into strict src from public.shared_award_sources where id=(r->>'source_id')::uuid;
  if not private.awardping_program_fact_source_ready(src.id) or not private.awardping_program_text_collection_quality_ready(src.id,(r->>'epoch')::uuid)
   or not private.awardping_program_text_source_access(src.id,s.cohort_key,(r->>'epoch')::uuid)
   or src.shared_award_id::text is distinct from r->>'owner_id' or src.url is distinct from r->>'url'
   or not exists(select 1 from public.program_award_members m where m.cohort_key=s.cohort_key and m.shared_award_id=src.shared_award_id)
   or src.text_monitoring_state->>'schema' is distinct from 'awardping.program-text-state.v1'
   or src.text_monitoring_state->>'epoch' is distinct from r->>'epoch'
   or coalesce(src.text_monitoring_state->'last_program_update_at','null'::jsonb) is distinct from r->'program_version'
   or private.awardping_basic_source_decision_version(src.id) is distinct from r->'admin_decision_version'
  then return false;end if;
 end loop;
 return true;
exception when others then return false;
end;$function$
;

CREATE OR REPLACE FUNCTION public.commit_program_basic_facts(p_draft_id uuid, p_expected_draft_hash text, p_expected_head_id uuid, p_receipt jsonb, p_receipt_hash text, p_plan_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.program_text_fact_reviews%rowtype;head uuid;v_saved public.program_basic_fact_snapshots%rowtype;r jsonb;src public.shared_award_sources%rowtype;current_refs jsonb:='[]';source_versions jsonb;projection jsonb;expected jsonb;v_hash text;
begin
 if not coalesce(p_expected_draft_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_receipt_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(p_plan_hash ~ '^[a-f0-9]{64}$',false)
  or p_receipt is null or octet_length(p_receipt::text)>8388608 or not private.awardping_program_exact_object(p_receipt,array['schema','cohort_key','award_id','epoch','cycle','input_review_id','input_review_hash','selected_fields','reviewed_at','roster','supporting_capture_refs','current_capture_refs','public_facts'])
 then raise exception 'Exact bounded basic snapshot required.' using errcode='23514';end if;
 -- Existing source/roster/authority writers take the exclusive form of this
 -- guard. A shared read barrier keeps their lock order while different awards
 -- may publish basics independently through their own CAS/head lock below.
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict d from public.program_text_fact_reviews where id=p_draft_id for share;
 if d.content_hash is distinct from p_expected_draft_hash then raise exception 'Saved draft changed.' using errcode='40001';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('awardping-basic-facts:'||d.cohort_key,0));
 perform 1 from public.program_award_registry where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_roster where cohort_key=d.cohort_key for share;
 perform 1 from public.program_text_source_authority_epochs where active for share;
 perform 1 from public.shared_award_sources where id in(select (value#>>'{source,id}')::uuid from jsonb_array_elements(d.validation#>'{review,capture_refs}')) order by id for share;
 if not exists(select 1 from public.program_text_source_authority_epochs x where x.active and x.epoch::text=d.validation#>>'{review,epoch}')
  or not private.awardping_program_fact_validation_valid(d.validation,false) then raise exception 'Saved support/current source checks failed.' using errcode='23514';end if;
 if not coalesce((p_receipt->>'reviewed_at')::timestamptz between clock_timestamp()-interval '15 minutes' and clock_timestamp(),false) then raise exception 'Fresh cold verification required.' using errcode='40001';end if;
 for r in select value from jsonb_array_elements(d.validation#>'{review,capture_refs}') loop
  select * into strict src from public.shared_award_sources where id=(r#>>'{source,id}')::uuid;
  if not private.awardping_program_text_collection_quality_ready(src.id,(d.validation#>>'{review,epoch}')::uuid)
   or not private.awardping_program_text_source_access(src.id,d.cohort_key,(d.validation#>>'{review,epoch}')::uuid)
   or src.text_monitoring_state#>'{latest_ref,blocks_sha256}' is distinct from r->'blocks_sha256' then raise exception 'Current source quality/context changed.' using errcode='40001';end if;
  current_refs:=current_refs||jsonb_build_array(src.text_monitoring_state->'latest_ref');
 end loop;
 projection:=private.awardping_basic_fact_selection(d.validation,p_receipt->'selected_fields');
 expected:=jsonb_build_object('schema','awardping.basic-award-fact-review.v1','cohort_key',d.cohort_key,'award_id',d.validation#>'{review,award_id}','epoch',d.validation#>'{review,epoch}','cycle',d.validation#>'{review,cycle}',
  'input_review_id',d.id,'input_review_hash',d.content_hash,'selected_fields',p_receipt->'selected_fields','reviewed_at',p_receipt->'reviewed_at','roster',d.validation#>'{review,roster}',
  'supporting_capture_refs',d.validation#>'{review,capture_refs}','current_capture_refs',current_refs,'public_facts',projection);
 v_hash:=encode(extensions.digest(convert_to(private.monitoring_feedback_canonical_json(expected),'UTF8'),'sha256'),'hex');
 if expected is distinct from p_receipt or v_hash is distinct from p_receipt_hash then raise exception 'Independent basic projection differs.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('source_id',s.id,'owner_id',s.shared_award_id,'url',s.url,'epoch',s.text_monitoring_state->'epoch',
  'program_version',coalesce(s.text_monitoring_state->'last_program_update_at','null'::jsonb),
  'admin_decision_version',private.awardping_basic_source_decision_version(s.id)) order by s.id) into source_versions
 from public.shared_award_sources s where s.id in (
  select distinct (q->>'source_id')::uuid from jsonb_array_elements(d.validation#>'{review,fields}') f,
  lateral jsonb_array_elements(f->'items') i,lateral jsonb_array_elements(i->'support') q
  where p_receipt->'selected_fields' ? (f->>'field'));
 if source_versions is null or jsonb_array_length(source_versions) not between 1 and 500 then raise exception 'Selected support versions are missing.' using errcode='23514';end if;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=d.cohort_key for update;
 if head is not null and exists(select 1 from public.program_basic_fact_snapshots x where x.id=head and x.content_hash=v_hash
  and x.input_review_id=p_draft_id and x.input_review_hash=p_expected_draft_hash and x.previous_snapshot_id is not distinct from p_expected_head_id and x.root_plan_hash=p_plan_hash)
 then return jsonb_build_object('ok',true,'snapshot_id',head,'already_applied',true,'kind','automated_source_verified_basics');end if;
 if head is distinct from p_expected_head_id then raise exception 'Basic head changed.' using errcode='40001';end if;
 insert into public.program_basic_fact_snapshots(cohort_key,award_id,input_review_id,input_review_hash,previous_snapshot_id,receipt,content_hash,root_plan_hash,source_versions,public_facts)
 values(d.cohort_key,(d.validation#>>'{review,award_id}')::uuid,d.id,d.content_hash,head,expected,v_hash,p_plan_hash,source_versions,projection) returning * into v_saved;
 insert into public.program_basic_fact_heads(cohort_key,snapshot_id) values(d.cohort_key,v_saved.id)
 on conflict(cohort_key) do update set snapshot_id=excluded.snapshot_id,updated_at=now();
 return jsonb_build_object('ok',true,'snapshot_id',v_saved.id,'already_applied',false,'kind',v_saved.kind);
end;$function$
;

CREATE OR REPLACE FUNCTION public.inspect_program_basic_fact_draft(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.program_text_fact_reviews%rowtype;e uuid;ids uuid[];r jsonb;s jsonb;m jsonb;registry jsonb;head uuid;
begin
 select * into strict d from public.program_text_fact_reviews where id=p_id;
 select epoch into strict e from public.program_text_source_authority_epochs where active;
 select jsonb_build_object('cohort_key',cohort_key,'canonical_shared_award_id',canonical_shared_award_id) into strict registry from public.program_award_registry where cohort_key=d.cohort_key;
 select array_agg(distinct id) into ids from public.program_text_source_roster x cross join lateral unnest(x.source_ids) id where x.cohort_key=d.cohort_key;
 -- Aggregate roles separately: each role appears once even when it has many sources.
 select jsonb_agg(jsonb_build_object('source_role',source_role,'revision',revision,'source_ids',source_ids,'manifest_status',manifest_status,'evidence',evidence) order by source_role) into r from public.program_text_source_roster where cohort_key=d.cohort_key;
 if not coalesce(cardinality(ids) between 1 and 500,false) or not coalesce(jsonb_array_length(r) between 1 and 100,false) then raise exception 'Bounded source set required.' using errcode='23514';end if;
 select jsonb_agg(jsonb_build_object('id',x.id,'shared_award_id',x.shared_award_id,'url',x.url,'title',x.title,'page_type',x.page_type,'admin_review_status',x.admin_review_status,'text_monitoring_state',x.text_monitoring_state,
  'text_collection_quality',private.awardping_program_text_collection_quality(x.id),'text_source_approvals',private.awardping_program_text_source_approval_dto(x.id),'canonical_url_admission',private.awardping_program_text_canonical_url_admission(x.id,e)) order by x.id) into s from public.shared_award_sources x where x.id=any(ids);
 select jsonb_agg(shared_award_id order by shared_award_id) into m from public.program_award_members where cohort_key=d.cohort_key;
 if not coalesce(jsonb_array_length(m) between 1 and 100,false) or jsonb_array_length(s) is distinct from cardinality(ids) then raise exception 'Bounded source identity/membership context required.' using errcode='23514';end if;
 select snapshot_id into head from public.program_basic_fact_heads where cohort_key=d.cohort_key;
 return jsonb_build_object('schema','awardping.basic-fact-draft-context.v1','draft',jsonb_build_object('id',d.id,'content_hash',d.content_hash,'validation',d.validation),
  'context',jsonb_build_object('registry',registry,'roles',r,'sources',s,'memberIds',m,'epoch',e),'head_id',head);
end;$function$
;

-- Five-at-a-time admission. Fresh reviewed plans grant collection only.
-- Every initial source state remains independent and silent.
create function public.admit_program_award_expansion_batch(p_batch integer,p_awards jsonb,p_actor text,p_plan_hash text)
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
   if not coalesce(private.awardping_program_exact_object(q,array['id','create','url','title','page_type','expected_text_monitoring_state','authority_url','authority_href','review_note','url_alias_boundary']),false)
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
   if q->>'url'=c->>'official_homepage' then
    if q->>'authority_url' is distinct from c->>'official_homepage' or q->>'authority_href' is distinct from c->>'official_homepage'
    then raise exception 'The exact reviewed homepage is required.' using errcode='23514';end if;
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
revoke all on function public.admit_program_award_expansion_batch(integer,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.admit_program_award_expansion_batch(integer,jsonb,text,text) to service_role;

create function private.program_award_expansion_initial_ready(p_cohort text,p_epoch uuid) returns boolean language plpgsql stable set search_path='' as $$
declare a public.program_award_expansion_admissions%rowtype;s public.shared_award_sources%rowtype;sid uuid;head uuid;
begin
 select * into strict a from public.program_award_expansion_admissions where cohort_key=p_cohort and epoch=p_epoch;
 if not exists(select 1 from public.program_text_source_authority_epochs where active and epoch=p_epoch)
 or cardinality(a.source_ids) not between 1 and 6 then return false;end if;
 foreach sid in array a.source_ids loop
  select * into strict s from public.shared_award_sources where id=sid;
  if private.program_award_expansion_source_proof(sid) is null or not private.awardping_program_fact_source_ready(sid)
   or s.text_monitoring_state->>'epoch' is distinct from p_epoch::text then return false;end if;
 end loop;
 select snapshot_id into strict head from public.program_basic_fact_heads where cohort_key=p_cohort;
 return private.awardping_basic_fact_current(head);
exception when no_data_found or too_many_rows then return false;end;$$;
revoke all on function private.program_award_expansion_initial_ready(text,uuid) from public,anon,authenticated,service_role;
grant execute on function private.program_award_expansion_initial_ready(text,uuid) to service_role;

create function public.activate_program_award_expansion_batch(p_batch integer,p_expected_plan_hash text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.program_award_expansion_admissions%rowtype;e uuid;receipt jsonb;at_time timestamptz:=clock_timestamp();
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('program-award-expansion',0));
 if p_batch not in(1,2) or not coalesce(p_expected_plan_hash ~ '^[a-f0-9]{64}$',false) or length(btrim(coalesce(p_actor,''))) not between 3 and 320
 then raise exception 'An exact reviewed expansion activation is required.' using errcode='23514';end if;
 select epoch into strict e from public.program_text_source_authority_epochs where active for share;
 if (select count(*) from public.program_award_expansion_admissions where batch=p_batch and plan_hash=p_expected_plan_hash and epoch=e)<>5
 or p_batch=2 and (select count(*) from public.program_award_expansion_admissions where batch=1 and status='active')<>5
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
end;$$;
revoke all on function public.activate_program_award_expansion_batch(integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.activate_program_award_expansion_batch(integer,text,text) to service_role;

-- Activation is durable identity admission. Later source changes may stale the
-- basic snapshot; keep the award and its alert-review pathway visible.
create function public.get_program_award_expansion_publication(p_epoch uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
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
 if jsonb_array_length(result) not in(0,5,10) then raise exception 'Expansion publication has a partial activated batch.' using errcode='23514';end if;
 return jsonb_build_object('schema','awardping.program-award-expansion-publication.v1','epoch',p_epoch,'awards',result);
end;$$;
revoke all on function public.get_program_award_expansion_publication(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_program_award_expansion_publication(uuid) to service_role;

-- Reporting reads source-verified basic snapshots, not retired full inventories.
create function public.get_program_award_monitoring_basics() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema','awardping.program-award-monitoring-basics.v1','awards',
  coalesce(jsonb_agg(jsonb_build_object('cohort_key',r.cohort_key,'award_id',r.canonical_shared_award_id,
   'snapshot_id',h.snapshot_id,'basic_details_current',case when h.snapshot_id is null then false else private.awardping_basic_fact_current(h.snapshot_id) end) order by r.cohort_key),'[]'::jsonb))
 from public.program_award_registry r left join public.program_basic_fact_heads h on h.cohort_key=r.cohort_key;
$$;
revoke all on function public.get_program_award_monitoring_basics() from public,anon,authenticated,service_role;
grant execute on function public.get_program_award_monitoring_basics() to service_role;
notify pgrst,'reload schema';

