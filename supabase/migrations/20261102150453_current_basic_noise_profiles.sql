-- Preserve every source, capture, comparison, fact, grant and historical record.
-- Only independently reviewed pure noise-profile checks change.
DO $guard_0$
DECLARE p oid:='private.awardping_reviewed_repeat_rules_valid(jsonb)'::regprocedure; old_acl text; old_owner oid; old_config text[]; old_def text;
BEGIN
 SELECT proacl::text,proowner,proconfig INTO old_acl,old_owner,old_config FROM pg_proc WHERE oid=p;
 old_def:=pg_get_functiondef(p);
 IF encode(extensions.digest(convert_to(old_def,'UTF8'),'sha256'),'hex')<>'d5b7f5719483208d8a7838af73cdfdb058dc0f1b3a00a05e960f738b6f6eb8da' THEN RAISE EXCEPTION 'Noise profile preimage 0 differs'; END IF;
 EXECUTE $approved_0$CREATE OR REPLACE FUNCTION private.awardping_reviewed_repeat_rules_valid(v jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare changes jsonb:=v#>'{candidate,prompt_payload,comparison,changed_blocks}';rule jsonb;change jsonb;wp jsonb;before_b jsonb;after_b jsonb;side text;m jsonb;raw_text text;old_m jsonb;new_m jsonb;
begin
 if jsonb_typeof(v->'rules') is distinct from 'array' or jsonb_typeof(changes) is distinct from 'array'
  or jsonb_array_length(changes) not between 1 and 256 or jsonb_array_length(changes)<>jsonb_array_length(v->'rules')
  or (select count(distinct x->>'change_id') from jsonb_array_elements(v->'rules') x)<>jsonb_array_length(changes)
  or jsonb_typeof(v->'widget_proofs') is distinct from 'array' or jsonb_array_length(v->'widget_proofs')>1 then return false;end if;
 for wp in select value from jsonb_array_elements(v->'widget_proofs') loop
  if private.awardping_program_exact_object(wp,array['profile','previous_marker','current_marker']) is distinct from true
   or private.awardping_reviewed_marker_valid(wp->'previous_marker',v->'repeat_raw',wp->>'profile',(v->>'source_id')::uuid,v->'repeat_document') is distinct from true
   or private.awardping_reviewed_marker_valid(wp->'current_marker',v->'current_raw',wp->>'profile',(v->>'source_id')::uuid,v->'current_document') is distinct from true
   or wp#>'{previous_marker,container_attributes}' is distinct from wp#>'{current_marker,container_attributes}' then return false;end if;
 end loop;
 for rule in select value from jsonb_array_elements(v->'rules') loop
  select value into strict change from jsonb_array_elements(changes) where value->>'id'=rule->>'change_id';before_b:=change->'previous';after_b:=change->'current';
  if rule->>'kind'='raw_bound_static_alignment' then
   if not coalesce(private.awardping_reviewed_jm_static_alignment_valid(v),false) then return false;end if;
  elsif rule->>'kind'='raw_marked_ancillary_widget' then
   if private.awardping_program_exact_object(rule,array['change_id','kind','profile']) is distinct from true then return false;end if;
   select value into strict wp from jsonb_array_elements(v->'widget_proofs') where value->>'profile'=rule->>'profile';
   if before_b<>'null'::jsonb and not (wp#>'{previous_marker,excluded_support_block_ids}') ? (before_b->>'id')
    or after_b<>'null'::jsonb and not (wp#>'{current_marker,excluded_support_block_ids}') ? (after_b->>'id') then return false;end if;
  else
   if before_b='null'::jsonb or after_b='null'::jsonb or (before_b-'id'-'text'-'start_utf16'-'end_utf16') is distinct from (after_b-'id'-'text'-'start_utf16'-'end_utf16') then return false;end if;
   if rule->>'kind'='identical_protected_email_destination' then
    if private.awardping_program_exact_object(rule,array['change_id','kind','decoded_hex']) is distinct from true
     or before_b->>'kind' is distinct from 'source_link' or before_b#>>'{context,source_attribute}' is distinct from 'href'
     or private.awardping_reviewed_cf_hex(before_b->>'text') is distinct from rule->>'decoded_hex'
     or private.awardping_reviewed_cf_hex(after_b->>'text') is distinct from rule->>'decoded_hex' or rule->>'decoded_hex' is null then return false;end if;
   elsif rule->>'kind'='hidden_gravityforms_honeypot_label' then
    if private.awardping_program_exact_object(rule,array['change_id','kind','previous_marker','current_marker']) is distinct from true
     or not coalesce(v->>'source_id' in('f322a07c-f78c-47fd-aafb-ab6422a4248f','434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2','5bf1f780-ffc1-49e1-88d7-7da3ebd943cf'),false) or before_b->>'kind' is distinct from 'li' then return false;end if;
    if (select count(*) from jsonb_array_elements(v#>'{repeat_document,blocks}') b where b->>'kind'='li' and b->>'text'=before_b->>'text')<>1
     or (select count(*) from jsonb_array_elements(v#>'{current_document,blocks}') b where b->>'kind'='li' and b->>'text'=after_b->>'text')<>1 then return false;end if;
    old_m:=rule->'previous_marker';new_m:=rule->'current_marker';
    if not coalesce(case v->>'source_id'
     when 'f322a07c-f78c-47fd-aafb-ab6422a4248f' then old_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter') and new_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')
     when '434c57c2-4f87-4c5e-bc88-24cb59f4b1e7' then old_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter') and new_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')
     when 'db04bc7a-d0fd-40a5-8922-30921b02a7e2' then old_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter') and new_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')
     when '5bf1f780-ffc1-49e1-88d7-7da3ebd943cf' then old_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter') and new_m->>'label' in('Company','Facebook','Instagram','LinkedIn','URL','X/Twitter')
     else false end,false) or old_m->>'label'=new_m->>'label'
     or replace(old_m->>'html','>'||(old_m->>'label')||'</span>','>'||(new_m->>'label')||'</span>') is distinct from new_m->>'html'
     or before_b->>'text' is distinct from (old_m->>'label')||' This field is for validation purposes and should be left unchanged.'
     or after_b->>'text' is distinct from (new_m->>'label')||' This field is for validation purposes and should be left unchanged.' then return false;end if;
    if v->>'source_id' in('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2','5bf1f780-ffc1-49e1-88d7-7da3ebd943cf') then
     foreach side in array array['repeat','current'] loop
      m:=case when side='repeat' then old_m else new_m end;
      if v#>>array[side||'_document','reference','source','id'] is distinct from v->>'source_id'
       or v#>>array[side||'_document','reference','source','shared_award_id'] is distinct from (case when v->>'source_id'='db04bc7a-d0fd-40a5-8922-30921b02a7e2' then 'dd23afbb-299e-489f-8a0b-e4d7506848de' else '19135163-d9dd-4fc2-b2ae-7d0bb8449735' end)
       or v#>>array[side||'_document','reference','source','url'] is distinct from (case when v->>'source_id' in('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2') then 'https://www.schwarzmanscholars.org/admissions/' else 'https://www.schwarzmanscholars.org/' end)
       or v#>>array[side||'_document','reference','final_url'] is distinct from v#>>array[side||'_document','reference','source','url']
       or not coalesce(position('action='''||(case when v->>'source_id' in('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2') then '/admissions/#gf_5' else '/#gf_5' end)||'''' in m->>'form_start_tag')>0
        or position('action="'||(case when v->>'source_id' in('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2') then '/admissions/#gf_5' else '/#gf_5' end)||'"' in m->>'form_start_tag')>0,false)
      then return false;end if;
     end loop;
    end if;
    foreach side in array array['repeat','current'] loop
     m:=case when side='repeat' then old_m else new_m end;raw_text:=convert_from(decode(v#>>array[side||'_raw','raw_base64'],'base64'),'UTF8');
     if private.awardping_program_exact_object(m,array['start_utf16','end_utf16','html','html_sha256','wrapper_start_utf16','wrapper_start_tag','form_start_utf16','form_start_tag','label']) is distinct from true
      or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
      or encode(extensions.digest(convert_to(m->>'html','UTF8'),'sha256'),'hex') is distinct from m->>'html_sha256'
      or private.awardping_program_utf16_slice(raw_text,(m->>'wrapper_start_utf16')::integer,(m->>'wrapper_start_utf16')::integer+private.awardping_program_utf16_length(m->>'wrapper_start_tag')) is distinct from m->>'wrapper_start_tag'
      or private.awardping_program_utf16_slice(raw_text,(m->>'form_start_utf16')::integer,(m->>'form_start_utf16')::integer+private.awardping_program_utf16_length(m->>'form_start_tag')) is distinct from m->>'form_start_tag'
      or position('gform_wrapper_5' in m->>'wrapper_start_tag')=0 or position('gform_5' in m->>'form_start_tag')=0
      or position('gfield--type-honeypot' in m->>'html')=0 then return false;end if;
    end loop;
   else return false;end if;
  end if;
  foreach side in array array['repeat','current'] loop
   m:=case when side='repeat' then before_b else after_b end;
   if m<>'null'::jsonb and not exists(select 1 from jsonb_array_elements(v#>array[side||'_document','blocks']) b where b->>'id'=m->>'id'
    and b->>'text'=m->>'text' and b->'start_utf16'=m->'start_utf16' and b->'end_utf16'=m->'end_utf16') then return false;end if;
  end loop;
 end loop;return true;
exception when others then return false;end;$function$
$approved_0$;
 IF encode(extensions.digest(convert_to(pg_get_functiondef(p),'UTF8'),'sha256'),'hex')<>'08ca989552a6666a01a792bec28ee8883a187720655d72a374b7728a0a6a6b51' OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND (proacl::text IS DISTINCT FROM old_acl OR proowner IS DISTINCT FROM old_owner OR proconfig IS DISTINCT FROM old_config OR prosecdef)) THEN RAISE EXCEPTION 'Noise profile postimage/security 0 differs'; END IF;
END $guard_0$;

DO $guard_1$
DECLARE p oid:='private.awardping_reviewed_marker_valid(jsonb,jsonb,text,uuid,jsonb)'::regprocedure; old_acl text; old_owner oid; old_config text[]; old_def text;
BEGIN
 SELECT proacl::text,proowner,proconfig INTO old_acl,old_owner,old_config FROM pg_proc WHERE oid=p;
 old_def:=pg_get_functiondef(p);
 IF encode(extensions.digest(convert_to(old_def,'UTF8'),'sha256'),'hex')<>'03660e953e7f9c5dcbc81c7c4809da73ada613661f1eec10c1b2fa0cb336a4a6' THEN RAISE EXCEPTION 'Noise profile preimage 1 differs'; END IF;
 EXECUTE $approved_1$CREATE OR REPLACE FUNCTION private.awardping_reviewed_marker_valid(m jsonb, r jsonb, p_profile text, p_source uuid, p_side jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare raw_text text:=convert_from(decode(r->>'raw_base64','base64'),'UTF8');expected_selector text;expected_count integer;expected_heading jsonb;
begin
 if private.awardping_program_exact_object(m,array['profile','selector','start_utf16','end_utf16','html','html_sha256','container_attributes','raw_container_attributes','card_count','heading','excluded_support_block_ids']) is distinct from true
  or m->>'profile' is distinct from p_profile or jsonb_typeof(m->'start_utf16') is distinct from 'number'
  or jsonb_typeof(m->'end_utf16') is distinct from 'number'
  or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
  or encode(extensions.digest(convert_to(m->>'html','UTF8'),'sha256'),'hex') is distinct from m->>'html_sha256'
  or jsonb_typeof(m->'container_attributes') is distinct from 'object' or jsonb_typeof(m->'raw_container_attributes') is distinct from 'object'
  or jsonb_typeof(m->'excluded_support_block_ids') is distinct from 'array' or jsonb_array_length(m->'excluded_support_block_ids') not between 1 and 20000
  or exists(select 1 from jsonb_array_elements_text(m->'excluded_support_block_ids') id where not exists(select 1 from jsonb_array_elements(p_side->'blocks') b where b->>'id'=id))
 then return false;end if;
 if p_profile='james_madison_sidebar_testimonials.v1' and p_source='0f217532-3638-4cc4-8548-7ae9f4eec489' then
  expected_selector:='div#block-views-block-testimonial-block-block-1.views-element-container';expected_count:=3;expected_heading:='null'::jsonb;
 elsif p_profile='soros_featured_fellows.v1' and p_source in('bd79bc43-dd42-4f0b-8323-7c981587b261','c2affec3-e89a-4ada-b1eb-955ad72e7646','47c05c1b-05bd-4a39-821f-2d6c1420c197','4e4cfa3e-fb2a-4ea7-a792-6da5df9ee6b4') then
  expected_selector:='div.wp-block-acf-featured-fellows';expected_count:=2;expected_heading:='"Featured Fellows"'::jsonb;
 elsif p_profile='daad_sponsored_university_carousel.v1' and p_source in('56aa30ee-164e-489a-ae5c-f2902dbb0db5','8d654c9d-e572-4488-94a3-e4238e7b1155','88906939-65e7-492d-a671-da56678dfecd') then
  expected_selector:='div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]';expected_count:=11;expected_heading:='"Advertisements by German Universities"'::jsonb;
 else return false;end if;
 return m->>'selector'=expected_selector and case when p_profile='daad_sponsored_university_carousel.v1' then jsonb_typeof(m->'card_count')='number' and m->>'card_count' ~ '^([1-9]|[12][0-9]|3[0-2])$' else m->'card_count'=to_jsonb(expected_count) end and m->'heading'=expected_heading
  and case when p_profile='daad_sponsored_university_carousel.v1' then
   m->'container_attributes'=(m->'raw_container_attributes')-'aria-labelledby' and m#>>'{raw_container_attributes,aria-labelledby}' ~ '^headline-[a-f0-9]{8,32}$'
   else m->'container_attributes'=m->'raw_container_attributes' end;
exception when others then return false;end;$function$
$approved_1$;
 IF encode(extensions.digest(convert_to(pg_get_functiondef(p),'UTF8'),'sha256'),'hex')<>'bd18bb0e6db7951306c679869196c80d33a9c30dcbf1e86ef256232986f18a5d' OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND (proacl::text IS DISTINCT FROM old_acl OR proowner IS DISTINCT FROM old_owner OR proconfig IS DISTINCT FROM old_config OR prosecdef)) THEN RAISE EXCEPTION 'Noise profile postimage/security 1 differs'; END IF;
END $guard_1$;

DO $guard_2$
DECLARE p oid:='private.awardping_technical_repeat_marker_valid(jsonb,jsonb,text,uuid,jsonb)'::regprocedure; old_acl text; old_owner oid; old_config text[]; old_def text;
BEGIN
 SELECT proacl::text,proowner,proconfig INTO old_acl,old_owner,old_config FROM pg_proc WHERE oid=p;
 old_def:=pg_get_functiondef(p);
 IF encode(extensions.digest(convert_to(old_def,'UTF8'),'sha256'),'hex')<>'928a4eb026a137ff1aa1a0162394e5a68acb4a4a75ae8adb16b13ff200019a07' THEN RAISE EXCEPTION 'Noise profile preimage 2 differs'; END IF;
 EXECUTE $approved_2$CREATE OR REPLACE FUNCTION private.awardping_technical_repeat_marker_valid(m jsonb, r jsonb, p_profile text, p_source uuid, p_side jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare raw_text text:=convert_from(decode(r->>'raw_base64','base64'),'UTF8');expected_selector text;expected_count integer;expected_heading jsonb;
begin
 if private.awardping_program_exact_object(m,array['profile','selector','start_utf16','end_utf16','html','html_sha256','container_attributes','raw_container_attributes','card_count','heading','excluded_support_block_ids']) is distinct from true
  or m->>'profile' is distinct from p_profile or jsonb_typeof(m->'start_utf16') is distinct from 'number'
  or jsonb_typeof(m->'end_utf16') is distinct from 'number'
  or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
  or encode(extensions.digest(convert_to(m->>'html','UTF8'),'sha256'),'hex') is distinct from m->>'html_sha256'
  or jsonb_typeof(m->'container_attributes') is distinct from 'object' or jsonb_typeof(m->'raw_container_attributes') is distinct from 'object'
  or jsonb_typeof(m->'excluded_support_block_ids') is distinct from 'array' or jsonb_array_length(m->'excluded_support_block_ids') not between 1 and 20000
  or exists(select 1 from jsonb_array_elements_text(m->'excluded_support_block_ids') id where not exists(select 1 from jsonb_array_elements(p_side->'blocks') b where b->>'id'=id))
 then return false;end if;
 if p_profile='daad889_sponsored_university_carousel.v1' and p_source='88906939-65e7-492d-a671-da56678dfecd' then
  expected_selector:='div.bg-lightgrey.u-p-medium.js-ad-slider.is-relative[role="region"][aria-roledescription="Karussell"]';expected_count:=11;expected_heading:='"Advertisements by German Universities"'::jsonb;
 else return false;end if;
 return m->>'selector'=expected_selector and case when p_profile='daad889_sponsored_university_carousel.v1' then jsonb_typeof(m->'card_count')='number' and m->>'card_count' ~ '^([1-9]|[12][0-9]|3[0-2])$' else m->'card_count'=to_jsonb(expected_count) end and m->'heading'=expected_heading
  and case when p_profile='daad889_sponsored_university_carousel.v1' then
   m->'container_attributes'=(m->'raw_container_attributes')-'aria-labelledby' and m#>>'{raw_container_attributes,aria-labelledby}' ~ '^headline-[a-f0-9]{8,32}$'
   else m->'container_attributes'=m->'raw_container_attributes' end;
exception when others then return false;end;$function$
$approved_2$;
 IF encode(extensions.digest(convert_to(pg_get_functiondef(p),'UTF8'),'sha256'),'hex')<>'2980befa0a657127bee5f54d0130c7a38dcd54ef0670ee56760911d3740df3d8' OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=p AND (proacl::text IS DISTINCT FROM old_acl OR proowner IS DISTINCT FROM old_owner OR proconfig IS DISTINCT FROM old_config OR prosecdef)) THEN RAISE EXCEPTION 'Noise profile postimage/security 2 differs'; END IF;
END $guard_2$;

