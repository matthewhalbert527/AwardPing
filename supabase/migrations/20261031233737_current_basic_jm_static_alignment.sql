-- One conserved footer paragraph on the exact reviewed James Madison page.
-- It remains outside the rotating testimonial widget and outside fact support.
-- All original bytes, normal terminal review, widget checks and full-page
-- residual equality remain required; no observation or owner outcome is made.
create function private.awardping_reviewed_jm_static_alignment_valid(v jsonb)
returns boolean language plpgsql immutable set search_path='' as $jm_static$
declare rules jsonb;first_rule jsonb;r jsonb;wp jsonb;changes jsonb:=v#>'{candidate,prompt_payload,comparison,changed_blocks}';
 side text;d jsonb;m jsonb;w jsonb;b jsonb;old_b jsonb;new_b jsonb;raw_text text;h jsonb;paths jsonb;prefix jsonb;tail text;at_index integer;change jsonb;part jsonb;coupled jsonb;
 selector text:='footer.flex-grow-0.bg-blue-dark.border-blue.border-top-3.text-center.text-lg-left #jmf1-social-links-container > p';
 profile text:='james_madison_conserved_follow_us.v1';url text:='https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility';
begin
 if v->>'source_id' is distinct from '0f217532-3638-4cc4-8548-7ae9f4eec489'
  or jsonb_typeof(v->'rules') is distinct from 'array' or jsonb_typeof(changes) is distinct from 'array'
  or jsonb_typeof(v->'widget_proofs') is distinct from 'array' or jsonb_array_length(v->'widget_proofs')<>1 then return false;end if;
 select coalesce(jsonb_agg(x order by x->>'change_id'),'[]'::jsonb) into rules from jsonb_array_elements(v->'rules') x where x->>'kind'='raw_bound_static_alignment';
 if jsonb_array_length(rules)<>2 then return false;end if;first_rule:=rules->0;wp:=v#>'{widget_proofs,0}';
 if wp->>'profile' is distinct from 'james_madison_sidebar_testimonials.v1'
  or jsonb_typeof(first_rule->'change_ids') is distinct from 'array' or jsonb_array_length(first_rule->'change_ids')<>2
  or (select count(distinct x) from jsonb_array_elements(first_rule->'change_ids') x)<>2
  or first_rule->'change_ids' is distinct from (select jsonb_agg(x->'change_id' order by x->>'change_id') from jsonb_array_elements(rules) x) then return false;end if;
 for r in select value from jsonb_array_elements(rules) loop
  if private.awardping_program_exact_object(r,array['change_id','kind','profile','previous_marker','current_marker','change_ids']) is distinct from true
   or r->>'profile' is distinct from profile or (r-'change_id') is distinct from (first_rule-'change_id') then return false;end if;
 end loop;
 foreach side in array array['repeat','current'] loop
  d:=v->(side||'_document');m:=first_rule->case when side='repeat' then 'previous_marker' else 'current_marker' end;
  w:=wp->case when side='repeat' then 'previous_marker' else 'current_marker' end;
  if d#>>'{reference,source,id}' is distinct from v->>'source_id'
   or d#>>'{reference,source,shared_award_id}' is distinct from '592d1ab0-7eff-402a-82ba-90d19559aa7f'
   or d#>>'{reference,source,url}' is distinct from url or d#>>'{reference,final_url}' is distinct from url
   or private.awardping_program_exact_object(m,array['profile','selector','block_id','start_utf16','end_utf16','html','html_sha256','inherited_headings','heading_prefix']) is distinct from true
   or m->>'profile' is distinct from profile or m->>'selector' is distinct from selector
   or m->>'html' is distinct from '<p>Follow Us</p>'
   or m->>'html_sha256' is distinct from '6665b2d0032d66b78ce6a8a77c88d65fc29dfa9cba389bd1b1747c0c68f0957a'
   or jsonb_typeof(m->'inherited_headings') is distinct from 'array' or jsonb_array_length(m->'inherited_headings')<>2
   or jsonb_typeof(m->'heading_prefix') is distinct from 'array'
   or (w->'excluded_support_block_ids') ? (m->>'block_id') then return false;end if;
  select value into strict b from jsonb_array_elements(d->'blocks') where value->>'id'=m->>'block_id';
  if b->>'kind' is distinct from 'p' or coalesce(b->'page','null'::jsonb)<>'null'::jsonb or b->>'text' is distinct from 'Follow Us'
   or (select count(*) from jsonb_array_elements(d->'blocks') x where x->>'kind'='p' and x->>'text'='Follow Us')<>1
   or private.awardping_program_utf16_slice(d->>'text',(b->>'start_utf16')::integer,(b->>'end_utf16')::integer) is distinct from 'Follow Us'
   or jsonb_typeof(b->'context') is distinct from 'object' or jsonb_typeof(b#>'{context,heading_path}') is distinct from 'array' then return false;end if;
  paths:=b#>'{context,heading_path}';prefix:=m->'heading_prefix';
  if jsonb_array_length(paths)<>jsonb_array_length(prefix)+2
   or b->>'heading' is distinct from (select string_agg(x->>'text',' > ' order by ord) from jsonb_array_elements(paths) with ordinality p(x,ord)) then return false;end if;
  raw_text:=convert_from(decode(v#>>array[side||'_raw','raw_base64'],'base64'),'UTF8');
  if (m->>'start_utf16')::integer<(w->>'end_utf16')::integer
   or private.awardping_program_utf16_slice(raw_text,(m->>'start_utf16')::integer,(m->>'end_utf16')::integer) is distinct from m->>'html'
   or (length(raw_text)-length(replace(raw_text,'<p>Follow Us</p>','')))/length('<p>Follow Us</p>')<>1 then return false;end if;
  at_index:=0;
  for h in select value from jsonb_array_elements(m->'inherited_headings') loop
   if private.awardping_program_exact_object(h,array['level','text','start_utf16','end_utf16','html','html_sha256']) is distinct from true
    or (h->>'level')::integer<>4+at_index or coalesce(length(h->>'text'),0)=0
    or (h->>'start_utf16')::integer<(w->>'start_utf16')::integer or (h->>'end_utf16')::integer>(w->>'end_utf16')::integer
    or private.awardping_program_utf16_slice(raw_text,(h->>'start_utf16')::integer,(h->>'end_utf16')::integer) is distinct from h->>'html'
    or encode(extensions.digest(convert_to(h->>'html','UTF8'),'sha256'),'hex') is distinct from h->>'html_sha256'
    or h->>'html' !~ ('^<h'||(4+at_index)::text||'>.*</h'||(4+at_index)::text||'>$')
    or regexp_replace(h->>'html','<[^>]*>','','g') is distinct from h->>'text'
    or paths->(jsonb_array_length(prefix)+at_index) is distinct from jsonb_build_object('level',4+at_index,'text',h->>'text') then return false;end if;
   at_index:=at_index+1;
  end loop;
  if (m#>>'{inherited_headings,0,end_utf16}')::integer>(m#>>'{inherited_headings,1,start_utf16}')::integer then return false;end if;
  tail:=private.awardping_program_utf16_slice(raw_text,(m#>>'{inherited_headings,1,end_utf16}')::integer,(w->>'end_utf16')::integer);
  if tail is null or tail ~* '<h[45]([[:space:]>])' then return false;end if;
  if prefix is distinct from (select coalesce(jsonb_agg(x order by ord),'[]'::jsonb) from jsonb_array_elements(paths) with ordinality p(x,ord) where ord<=jsonb_array_length(prefix)) then return false;end if;
  if side='repeat' then old_b:=b;else new_b:=b;end if;
 end loop;
 if first_rule#>'{previous_marker,heading_prefix}' is distinct from first_rule#>'{current_marker,heading_prefix}'
  or ((old_b-'id'-'start_utf16'-'end_utf16'-'heading'-'context')||jsonb_build_object('context',(old_b->'context')-'heading_path'))
   is distinct from ((new_b-'id'-'start_utf16'-'end_utf16'-'heading'-'context')||jsonb_build_object('context',(new_b->'context')-'heading_path')) then return false;end if;
 select coalesce(jsonb_agg(x->'id' order by x->>'id'),'[]'::jsonb) into coupled from jsonb_array_elements(changes) x
  where x#>>'{previous,id}'=old_b->>'id' or x#>>'{current,id}'=new_b->>'id';
 if coupled is distinct from first_rule->'change_ids'
  or (select count(*) from jsonb_array_elements(changes) x where x#>>'{previous,id}'=old_b->>'id')<>1
  or (select count(*) from jsonb_array_elements(changes) x where x#>>'{current,id}'=new_b->>'id')<>1 then return false;end if;
 for change in select value from jsonb_array_elements(changes) where (first_rule->'change_ids') ? (value->>'id') loop
  foreach side in array array['repeat','current'] loop
   part:=change->case when side='repeat' then 'previous' else 'current' end;
   b:=case when side='repeat' then old_b else new_b end;w:=wp->case when side='repeat' then 'previous_marker' else 'current_marker' end;
   if part<>'null'::jsonb and part->>'id' is distinct from b->>'id' and not (w->'excluded_support_block_ids') ? (part->>'id') then return false;end if;
  end loop;
 end loop;
 return true;
exception when others then return false;end;
$jm_static$;
revoke all on function private.awardping_reviewed_jm_static_alignment_valid(jsonb) from public,anon,authenticated,service_role;

-- Pinned additive rules/residual dispatch is appended by the offline renderer.

-- BEGIN JM STATIC DISPATCH rules
do $jm_static_dispatch_rules$
declare before_def text;after_def text;begin
 before_def:=pg_get_functiondef('private.awardping_reviewed_repeat_rules_valid(jsonb)'::regprocedure);
 if encode(extensions.digest(convert_to(before_def,'UTF8'),'sha256'),'hex')<>'4d9f645e76c1138323993c71c75ead28d11ed2034e0910a335fc87bb2567c7d0' then raise exception 'JM static rules preimage changed.' using errcode='40001';end if;
 after_def:=replace(before_def,$jm_old_rules$  if rule->>'kind'='raw_marked_ancillary_widget' then$jm_old_rules$,$jm_new_rules$  if rule->>'kind'='raw_bound_static_alignment' then
   if not coalesce(private.awardping_reviewed_jm_static_alignment_valid(v),false) then return false;end if;
  elsif rule->>'kind'='raw_marked_ancillary_widget' then$jm_new_rules$);
 if encode(extensions.digest(convert_to(after_def,'UTF8'),'sha256'),'hex')<>'d5b7f5719483208d8a7838af73cdfdb058dc0f1b3a00a05e960f738b6f6eb8da' then raise exception 'JM static rules replacement differs.' using errcode='40001';end if;
 execute after_def;
end;
$jm_static_dispatch_rules$;

-- BEGIN JM STATIC DISPATCH residual
do $jm_static_dispatch_residual$
declare before_def text;after_def text;begin
 before_def:=pg_get_functiondef('private.awardping_reviewed_repeat_residual(jsonb,text)'::regprocedure);
 if encode(extensions.digest(convert_to(before_def,'UTF8'),'sha256'),'hex')<>'e9162f7f03a484d4dade9248aff8eefb7c9677fbf7ebda771362c787bde06bbd' then raise exception 'JM static residual preimage changed.' using errcode='40001';end if;
 after_def:=replace(before_def,$jm_old_residual$where value->>'kind'<>'raw_marked_ancillary_widget' loop$jm_old_residual$,$jm_new_residual$where value->>'kind' not in('raw_marked_ancillary_widget','raw_bound_static_alignment') loop$jm_new_residual$);
 if encode(extensions.digest(convert_to(after_def,'UTF8'),'sha256'),'hex')<>'5fa693ac961bda783c8b92a8a5cc66770c59be6b89895ef5da9929bc1ddc9ba7' then raise exception 'JM static residual replacement differs.' using errcode='40001';end if;
 execute after_def;
end;
$jm_static_dispatch_residual$;
