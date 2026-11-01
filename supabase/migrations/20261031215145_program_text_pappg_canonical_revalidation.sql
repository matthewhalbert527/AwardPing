-- Service-only, append-only revalidation of the one existing canonical PAPPG
-- admission. No source, role, baseline, candidate, spend or public fact writes.
-- This increment permits only the observed duplicate footer-address removal.
create table public.program_text_pappg_canonical_revalidations (
 id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'),
 disposition_revision uuid not null references public.program_text_pappg_canonical_dispositions(revision),
 pending_id uuid not null references public.program_text_pappg_canonical_dispositions(pending_id),
 previous_revision uuid not null,
 epoch uuid not null references public.program_text_source_authority_epochs(epoch),
 source_id uuid not null check(source_id='de868fe8-54ba-4fa0-8210-b27c8f182112'),
 actor_id uuid not null check(actor_id<>'00000000-0000-0000-0000-000000000000'),
 content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 proposal jsonb not null,validation jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(disposition_revision,previous_revision),
 check(id<>previous_revision and jsonb_typeof(proposal)='object' and jsonb_typeof(validation)='object'
  and octet_length(validation::text)<=16777216)
);
alter table public.program_text_pappg_canonical_revalidations enable row level security;
revoke all on public.program_text_pappg_canonical_revalidations from public,anon,authenticated,service_role;
grant select on public.program_text_pappg_canonical_revalidations to service_role;

create function private.awardping_pappg_revalidation_immutable()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception 'PAPPG revalidations are immutable history.' using errcode='23514';end;
$$;
revoke all on function private.awardping_pappg_revalidation_immutable() from public,anon,authenticated,service_role;
create trigger pappg_revalidation_immutable before update or delete on public.program_text_pappg_canonical_revalidations
 for each row execute function private.awardping_pappg_revalidation_immutable();

-- Preserve every line of the reviewed guard in a separate private evaluator.
-- Only its pinned authority reference becomes an explicit optional argument.
do $guard_preimage$
declare body text;needle text:=$needle$ref:=d.proposal->'authority_ref';$needle$;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select prosrc into strict body from pg_catalog.pg_proc where oid='private.awardping_pappg_canonical_boundary_current(uuid,boolean)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from
  'aeb1036eec522865fb3bddec4596cfa86c0e893b99d1ce16f5973baed95ab929'
  or (length(body)-length(replace(body,needle,'')))/length(needle)<>1
 then raise exception 'Reviewed PAPPG guard preimage changed.' using errcode='40001';end if;
 body:=replace(body,needle,$replacement$ref:=coalesce(p_effective_ref,d.proposal->'authority_ref');$replacement$);
 execute format('create function private.awardping_pappg_boundary_with_authority(p_pending uuid,p_approved boolean,p_effective_ref jsonb)
  returns boolean language plpgsql stable security invoker set search_path='''' as %L',body);
 select prosrc into strict body from pg_catalog.pg_proc where oid='private.awardping_program_text_canonical_url_admission(uuid,uuid)'::regprocedure;
 if encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex') is distinct from
  '905382f8f285e43a4287c15c339b6ad0ce5d60f665322e7953a9b11e877ce950'
 then raise exception 'Reviewed PAPPG admission DTO preimage changed.' using errcode='40001';end if;
end;
$guard_preimage$;
revoke all on function private.awardping_pappg_boundary_with_authority(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_pappg_boundary_with_authority(uuid,boolean,jsonb) to service_role;

create function private.awardping_pappg_revalidation_leaf(p_revision uuid)
returns public.program_text_pappg_canonical_revalidations language sql stable security invoker set search_path='' as $$
 select r from public.program_text_pappg_canonical_revalidations r where r.disposition_revision=p_revision
  and not exists(select 1 from public.program_text_pappg_canonical_revalidations child
   where child.disposition_revision=p_revision and child.previous_revision=r.id);
$$;
revoke all on function private.awardping_pappg_revalidation_leaf(uuid) from public,anon,authenticated;
grant execute on function private.awardping_pappg_revalidation_leaf(uuid) to service_role;

create function private.awardping_pappg_revalidation_hash(p_proposal jsonb,p_validation jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('schema','awardping.pappg-canonical-revalidation-receipt.v1',
  'proposal',p_proposal,'validation',p_validation)::text,'UTF8'),'sha256'),'hex');
$$;
revoke all on function private.awardping_pappg_revalidation_hash(jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_pappg_revalidation_hash(jsonb,jsonb) to service_role;

create or replace function private.awardping_pappg_canonical_boundary_current(p_pending uuid,p_approved boolean default false)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;r public.program_text_pappg_canonical_revalidations%rowtype;
 authority public.shared_award_sources%rowtype;
begin
 select * into strict d from public.program_text_pappg_canonical_dispositions where pending_id=p_pending;
 select * into r from private.awardping_pappg_revalidation_leaf(d.revision);
 if r.id is null then return private.awardping_pappg_boundary_with_authority(p_pending,p_approved,null);end if;
 -- A successor takes precedence: never fall back to the original boundary if
 -- current authority later happens to resemble an older retained capture.
 if p_approved is distinct from true or r.pending_id is distinct from d.pending_id or r.epoch is distinct from d.epoch
  or r.source_id is distinct from d.selected_source_id or r.disposition_revision is distinct from d.revision
  or r.content_hash is distinct from private.awardping_pappg_revalidation_hash(r.proposal,r.validation)
  or r.proposal->>'id' is distinct from r.id::text or r.validation->'proposal' is distinct from r.proposal
 then return false;end if;
 select * into strict authority from public.shared_award_sources where id='c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
 if authority.text_monitoring_state#>'{latest_ref,source}' is distinct from r.proposal#>'{authority_ref,source}'
  or authority.text_monitoring_state#>>'{latest_ref,blocks_sha256}' is distinct from r.proposal#>>'{authority_ref,blocks_sha256}'
 then return false;end if;
 return private.awardping_pappg_boundary_with_authority(p_pending,true,r.proposal->'authority_ref');
exception when others then return false;
end;
$$;

create or replace function private.awardping_program_text_canonical_url_admission(p_source uuid,p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s public.shared_award_sources%rowtype;d public.program_text_pappg_canonical_dispositions%rowtype;
 r public.program_text_pappg_canonical_revalidations%rowtype;
begin
 select * into strict s from public.shared_award_sources where id=p_source;
 if not private.awardping_pappg_canonical_known(s.id,s.url) then return null;end if;
 select * into d from public.program_text_pappg_canonical_dispositions where source_url='https://www.nsf.gov/policies/pappg';
 select * into r from private.awardping_pappg_revalidation_leaf(d.revision);
 return jsonb_build_object('schema','awardping.program-text-canonical-url-admission.v1','source_id',s.id,'shared_award_id',s.shared_award_id,'source_url',s.url,
  'cohort_key','nsf_grfp','epoch',p_epoch,'selected_source_id','de868fe8-54ba-4fa0-8210-b27c8f182112',
  'revision',coalesce(r.id,d.revision),'content_hash',coalesce(r.content_hash,d.content_hash),
  'current',private.awardping_pappg_canonical_admission_allowed(s.id,'nsf_grfp',p_epoch));
end;
$$;

create function public.inspect_program_text_pappg_revalidation(p_epoch uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare d public.program_text_pappg_canonical_dispositions%rowtype;r public.program_text_pappg_canonical_revalidations%rowtype;i jsonb;
begin
 select * into strict d from public.program_text_pappg_canonical_dispositions where selected_source_id='de868fe8-54ba-4fa0-8210-b27c8f182112';
 if p_epoch is null or p_epoch is distinct from d.epoch or d.approved_id is null then
  raise exception 'Existing approved current-epoch PAPPG disposition required.' using errcode='40001';end if;
 i:=public.inspect_program_text_pappg_canonical(p_epoch);
 select * into r from private.awardping_pappg_revalidation_leaf(d.revision);
 return jsonb_build_object('schema','awardping.pappg-canonical-revalidation-inspection.v1','epoch',p_epoch,
  'disposition_revision',d.revision,'previous_revision',coalesce(r.id,d.revision),
  'original_authority_ref',d.proposal->'authority_ref','inspection',i);
end;
$$;
revoke all on function public.inspect_program_text_pappg_revalidation(uuid) from public,anon,authenticated;
grant execute on function public.inspect_program_text_pappg_revalidation(uuid) to service_role;

create function private.awardping_pappg_revalidation_documents_valid(p jsonb,v jsonb,p_original_ref jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare before_doc jsonb:=v->'previous_document';after_doc jsonb:=v->'authority_document';old_text text;new_text text;
 old_blocks jsonb;new_blocks jsonb;b jsonb;a jsonb;n integer;changes integer:=0;expected_text text;
 removed text:='Randolph Building, 401 Dulany Street, Alexandria, VA 22314 ';link_proposal jsonb;
begin
 if private.awardping_program_exact_object(v,array['schema','proposal','previous_document','authority_document','provider_link']) is distinct from true
  or v->>'schema' is distinct from 'awardping.pappg-canonical-revalidation-validation.v1' or v->'proposal' is distinct from p
  or octet_length(v::text)>16777216
  or private.awardping_program_source_approval_document_valid(before_doc) is distinct from true
  or private.awardping_program_source_approval_document_valid(after_doc) is distinct from true
  or before_doc->'reference' is distinct from p_original_ref or after_doc->'reference' is distinct from p->'authority_ref'
  or before_doc#>'{reference,source}' is distinct from after_doc#>'{reference,source}'
  or before_doc#>>'{reference,final_url}' is distinct from after_doc#>>'{reference,final_url}'
  or before_doc#>>'{reference,acquisition}' is distinct from after_doc#>>'{reference,acquisition}'
  or before_doc#>'{reference,extractor}' is distinct from after_doc#>'{reference,extractor}'
  or (after_doc#>>'{reference,captured_at}')::timestamptz<=(before_doc#>>'{reference,captured_at}')::timestamptz
 then return false;end if;
 old_text:=before_doc->>'text';new_text:=after_doc->>'text';old_blocks:=before_doc->'blocks';new_blocks:=after_doc->'blocks';
 if old_text is not distinct from new_text or jsonb_array_length(old_blocks)<>jsonb_array_length(new_blocks)
 then return false;end if;
 for n in 0..jsonb_array_length(old_blocks)-1 loop
  b:=old_blocks->n;a:=new_blocks->n;
  if b->>'id' is distinct from a->>'id' or (b-'id'-'start_utf16'-'end_utf16'-'text') is distinct from (a-'id'-'start_utf16'-'end_utf16'-'text') then return false;end if;
  if b->>'text' is distinct from a->>'text' then
   changes:=changes+1;
   if (length(b->>'text')-length(replace(b->>'text',removed,'')))/length(removed)<>1
    or replace(b->>'text',removed,'') is distinct from a->>'text'
    or position('Print: Required Policy Links' in b->>'text')=0 or position('Publication date:' in b->>'text')=0
    or position('Last updated:' in b->>'text')=0 or position('Footer About Us' in b->>'text')=0 then return false;end if;
   expected_text:=(case when (b->>'start_utf16')::integer=0 then '' else
     private.awardping_program_utf16_slice(old_text,0,(b->>'start_utf16')::integer) end)||(a->>'text')||
    (case when (b->>'end_utf16')::integer=(before_doc#>>'{reference,text_length}')::integer then '' else
     private.awardping_program_utf16_slice(old_text,(b->>'end_utf16')::integer,(before_doc#>>'{reference,text_length}')::integer) end);
  end if;
 end loop;
 if changes<>1 or expected_text is distinct from new_text then return false;end if;
 link_proposal:=jsonb_build_object('cohort_key','nsf_grfp','expected_canonical_shared_award_id','d955a846-cee1-4c01-932e-e3cb7215f3fb',
  'source',jsonb_build_object('id','de868fe8-54ba-4fa0-8210-b27c8f182112','shared_award_id','d955a846-cee1-4c01-932e-e3cb7215f3fb',
   'url','https://www.nsf.gov/policies/pappg','page_type','other','expected_member_kind','canonical'),
  'authority_ref',p->'authority_ref','link_proof',p->'link_proof');
 return private.awardping_program_raw_anchor_provider_link_valid(after_doc,v->'provider_link',link_proposal) is true;
exception when others then return false;
end;
$$;
revoke all on function private.awardping_pappg_revalidation_documents_valid(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.awardping_pappg_revalidation_documents_valid(jsonb,jsonb,jsonb) to service_role;

create function public.revalidate_program_text_pappg_canonical(p_proposal jsonb,p_validation jsonb,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb:=p_proposal;d public.program_text_pappg_canonical_dispositions%rowtype;
 old public.program_text_pappg_canonical_revalidations%rowtype;fresh jsonb;h text;review_time timestamptz;capture_time timestamptz;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 if private.awardping_program_exact_object(p,array['schema','id','epoch','cohort_key','source_id','disposition_revision','expected_previous_revision','expected_context','authority_ref','link_proof','review']) is distinct from true
  or p->>'schema' is distinct from 'awardping.pappg-canonical-revalidation.v1' or octet_length(p::text)>1258291
  or p->>'cohort_key' is distinct from 'nsf_grfp' or p->>'source_id' is distinct from 'de868fe8-54ba-4fa0-8210-b27c8f182112'
  or coalesce(p->>'id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  or p->>'id'='00000000-0000-0000-0000-000000000000' or p_actor is null
  or private.awardping_program_exact_object(p->'review',array['actor_id','reason','reviewed_at']) is distinct from true
  or p#>>'{review,actor_id}' is distinct from p_actor::text
  or jsonb_typeof(p#>'{review,reason}') is distinct from 'string' or length(btrim(p#>>'{review,reason}')) not between 40 and 2000
 then raise exception 'Exact finite PAPPG revalidation request and real actor required.' using errcode='23514';end if;
 perform 1 from auth.users where id=p_actor for key share;
 if not found then raise exception 'Existing authenticated review actor required.' using errcode='23514';end if;
 -- No source or role can change between the complete snapshot CAS and receipt.
 lock table public.shared_award_sources in share mode nowait;
 lock table public.program_text_source_roster in share mode nowait;
 lock table public.stage1_award_members in share mode nowait;
 lock table public.program_text_source_approval_events in share mode nowait;
 lock table public.shared_award_source_snapshots,public.shared_award_source_visual_snapshots,
  public.shared_award_visual_review_candidates,public.shared_award_change_events,public.shared_award_change_event_visual_evidence,
  public.shared_award_source_acquisitions,public.program_text_source_approvals,public.program_text_source_pending_requests,
  public.stage1_award_source_manifest,public.program_variation_scopes,public.program_text_fact_reviews,
  public.program_variation_unit_reviews,public.monitors,public.stage1_award_source_identity_rules in share mode nowait;
 perform 1 from public.shared_awards where id in(select c.owner_id from private.awardping_pappg_canonical_catalogue() c
  union select 'd955a846-cee1-4c01-932e-e3cb7215f3fb'::uuid) for share nowait;
 perform 1 from public.stage1_award_registry where cohort_key='nsf_grfp' for share nowait;
 perform 1 from public.program_text_source_authority_epochs where active for share nowait;
 select * into strict d from public.program_text_pappg_canonical_dispositions where selected_source_id='de868fe8-54ba-4fa0-8210-b27c8f182112' for update nowait;
 if p->>'epoch' is distinct from d.epoch::text or p->>'disposition_revision' is distinct from d.revision::text
  or p->'authority_ref' is null or private.awardping_pappg_revalidation_documents_valid(p,p_validation,d.proposal->'authority_ref') is distinct from true
 then raise exception 'Current disposition or complete retained authority proof changed.' using errcode='23514';end if;
 h:=private.awardping_pappg_revalidation_hash(p,p_validation);
 select * into old from public.program_text_pappg_canonical_revalidations where id=(p->>'id')::uuid;
 if found then
  if old.proposal is distinct from p or old.validation is distinct from p_validation or old.actor_id is distinct from p_actor
   or old.content_hash is distinct from h or private.awardping_pappg_canonical_boundary_current(d.pending_id,true) is distinct from true
   or (select leaf.id from private.awardping_pappg_revalidation_leaf(d.revision) leaf) is distinct from old.id
  then raise exception 'Revalidation replay changed, superseded or revoked.' using errcode='40001';end if;
  return jsonb_build_object('id',old.id,'source_id',old.source_id,'content_hash',h,'idempotent',true);
 end if;
 fresh:=public.inspect_program_text_pappg_revalidation(d.epoch);
 if p->'expected_context' is distinct from fresh or p->>'expected_previous_revision' is distinct from fresh->>'previous_revision'
  or p->'authority_ref' is distinct from fresh#>'{inspection,context,authority,text_monitoring_state,latest_ref}'
  or private.awardping_pappg_boundary_with_authority(d.pending_id,true,p->'authority_ref') is distinct from true
  or private.awardping_pappg_canonical_boundary_current(d.pending_id,true) is true
 then raise exception 'Exact stale-admission, catalogue, role or current-authority CAS failed.' using errcode='40001';end if;
 review_time:=(p#>>'{review,reviewed_at}')::timestamptz;capture_time:=(p#>>'{authority_ref,captured_at}')::timestamptz;
 if jsonb_typeof(p#>'{review,reviewed_at}') is distinct from 'string' or review_time is null or capture_time is null
  or review_time>clock_timestamp() or review_time<clock_timestamp()-interval '15 minutes'
  or capture_time>review_time or capture_time<clock_timestamp()-interval '7 days'
 then raise exception 'Fresh review after current complete capture required.' using errcode='23514';end if;
 insert into public.program_text_pappg_canonical_revalidations(id,disposition_revision,pending_id,previous_revision,epoch,source_id,actor_id,content_hash,proposal,validation)
 values((p->>'id')::uuid,d.revision,d.pending_id,(p->>'expected_previous_revision')::uuid,d.epoch,d.selected_source_id,p_actor,h,p,p_validation);
 if private.awardping_pappg_canonical_boundary_current(d.pending_id,true) is distinct from true then
  raise exception 'Inserted successor did not restore the complete strict boundary.' using errcode='40001';end if;
 return jsonb_build_object('id',p->'id','source_id',d.selected_source_id,'content_hash',h,'idempotent',false);
end;
$$;
revoke all on function public.revalidate_program_text_pappg_canonical(jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.revalidate_program_text_pappg_canonical(jsonb,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
