-- Finite reviewed additions only: three observed Schwarzman mailing-list
-- hidden label pairs and the exact DAAD country-guide eleven-card ad widget.
-- Full retained originals, normal terminal review/provenance, raw DOM witnesses,
-- exact residual text and unchanged public full support blocks remain required.
do $schwarzman_hidden_profiles$
declare before_def text;after_def text;
begin
 before_def:=pg_get_functiondef('private.awardping_reviewed_repeat_rules_valid(jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(before_def,'UTF8'),'sha256'),'hex')<>'ac8f4a1553dfe107eca3b2b7647be3adca656e0b862b8b0e9a0e0458c204838a' then raise exception 'Finite repeat profile preimage changed.' using errcode='40001';end if;
 after_def:=before_def;
 after_def:=replace(after_def,$schwarzman_hidden_profiles_0_old$or v->>'source_id' is distinct from 'f322a07c-f78c-47fd-aafb-ab6422a4248f' or before_b->>'kind' is distinct from 'li'$schwarzman_hidden_profiles_0_old$,$schwarzman_hidden_profiles_0_new$or not coalesce(v->>'source_id' in('f322a07c-f78c-47fd-aafb-ab6422a4248f','434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2','5bf1f780-ffc1-49e1-88d7-7da3ebd943cf'),false) or before_b->>'kind' is distinct from 'li'$schwarzman_hidden_profiles_0_new$);
 after_def:=replace(after_def,$schwarzman_hidden_profiles_1_old$if old_m->>'label' not in('URL','LinkedIn') or new_m->>'label' not in('URL','LinkedIn') or old_m->>'label'=new_m->>'label'$schwarzman_hidden_profiles_1_old$,$schwarzman_hidden_profiles_1_new$if not coalesce(case v->>'source_id'
     when 'f322a07c-f78c-47fd-aafb-ab6422a4248f' then old_m->>'label' in('URL','LinkedIn') and new_m->>'label' in('URL','LinkedIn')
     when '434c57c2-4f87-4c5e-bc88-24cb59f4b1e7' then old_m->>'label' in('LinkedIn','Company') and new_m->>'label' in('LinkedIn','Company')
     when 'db04bc7a-d0fd-40a5-8922-30921b02a7e2' then old_m->>'label' in('LinkedIn','Company') and new_m->>'label' in('LinkedIn','Company')
     when '5bf1f780-ffc1-49e1-88d7-7da3ebd943cf' then old_m->>'label' in('Facebook','Instagram') and new_m->>'label' in('Facebook','Instagram')
     else false end,false) or old_m->>'label'=new_m->>'label'$schwarzman_hidden_profiles_1_new$);
 after_def:=replace(after_def,$schwarzman_hidden_profiles_2_old$    foreach side in array array['repeat','current'] loop
     m:=case when side='repeat' then old_m else new_m end;raw_text:=convert_from$schwarzman_hidden_profiles_2_old$,$schwarzman_hidden_profiles_2_new$    if v->>'source_id' in('434c57c2-4f87-4c5e-bc88-24cb59f4b1e7','db04bc7a-d0fd-40a5-8922-30921b02a7e2','5bf1f780-ffc1-49e1-88d7-7da3ebd943cf') then
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
     m:=case when side='repeat' then old_m else new_m end;raw_text:=convert_from$schwarzman_hidden_profiles_2_new$);
 if encode(extensions.digest(convert_to(after_def,'UTF8'),'sha256'),'hex')<>'4d9f645e76c1138323993c71c75ead28d11ed2034e0910a335fc87bb2567c7d0' then raise exception 'Finite repeat profile postimage differs.' using errcode='40001';end if;
 execute after_def;
end;
$schwarzman_hidden_profiles$;

do $daad_country_ad_profile$
declare before_def text;after_def text;
begin
 before_def:=pg_get_functiondef('private.awardping_reviewed_marker_valid(jsonb,jsonb,text,uuid,jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(before_def,'UTF8'),'sha256'),'hex')<>'414d748034203d41348c4598a6b7ef686aafb28b6f12c3930f77c7dc7dc4199e' then raise exception 'Finite repeat profile preimage changed.' using errcode='40001';end if;
 after_def:=before_def;
 after_def:=replace(after_def,$daad_country_ad_profile_0_old$p_profile='daad_sponsored_university_carousel.v1' and p_source='56aa30ee-164e-489a-ae5c-f2902dbb0db5'$daad_country_ad_profile_0_old$,$daad_country_ad_profile_0_new$p_profile='daad_sponsored_university_carousel.v1' and p_source in('56aa30ee-164e-489a-ae5c-f2902dbb0db5','8d654c9d-e572-4488-94a3-e4238e7b1155')$daad_country_ad_profile_0_new$);
 after_def:=replace(after_def,$daad_country_ad_profile_1_old$p_profile='soros_featured_fellows.v1' and p_source in('bd79bc43-dd42-4f0b-8323-7c981587b261','c2affec3-e89a-4ada-b1eb-955ad72e7646')$daad_country_ad_profile_1_old$,$daad_country_ad_profile_1_new$p_profile='soros_featured_fellows.v1' and p_source in('bd79bc43-dd42-4f0b-8323-7c981587b261','c2affec3-e89a-4ada-b1eb-955ad72e7646','47c05c1b-05bd-4a39-821f-2d6c1420c197','4e4cfa3e-fb2a-4ea7-a792-6da5df9ee6b4')$daad_country_ad_profile_1_new$);
 if encode(extensions.digest(convert_to(after_def,'UTF8'),'sha256'),'hex')<>'03660e953e7f9c5dcbc81c7c4809da73ada613661f1eec10c1b2fa0cb336a4a6' then raise exception 'Finite repeat profile postimage differs.' using errcode='40001';end if;
 execute after_def;
end;
$daad_country_ad_profile$;
