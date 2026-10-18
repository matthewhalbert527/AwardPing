-- Explicit source-only HTML evidence on the existing review/publication/recovery lane.
-- No source approvals, selectors, candidate resolutions, baseline writes or live activation.
-- Existing browser/PDF branches, ownership and ACLs are preserved by CREATE OR REPLACE.
-- Source HTML has no screenshot/visibility/crop authority and is never served as executable HTML.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pure source-only parity for visualChangeSemanticManifest in
-- scripts/lib/visual-event-localization.mjs. Do not broaden legacy crop rules.
CREATE OR REPLACE FUNCTION private.awardping_source_html_normalize_exact_text(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path TO '' AS $function$
 SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
   pg_catalog.regexp_replace(pg_catalog.regexp_replace(
     normalize(coalesce(p_value,''), NFKC), '[‘’‚‛′]', '''', 'g'), '[“”„‟″]', '"', 'g'),
   U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'));
$function$;
REVOKE ALL ON FUNCTION private.awardping_source_html_normalize_exact_text(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.awardping_source_html_change_semantics_sha256(p_change_details jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO '' AS $function$
DECLARE
 v_details jsonb := CASE WHEN pg_catalog.jsonb_typeof(p_change_details)='object' THEN p_change_details ELSE '{}'::jsonb END;
 v_side text; v_exact text; v_direction text; v_fact_key text; v_fact jsonb;
 v_facts jsonb; v_groups jsonb; v_group jsonb; v_values jsonb; v_item jsonb;
 v_normalized text; v_source text; v_seen text[]; v_serialized text; v_separator text;
 v_current_sha text; v_previous_sha text; v_core text;
BEGIN
 FOREACH v_side IN ARRAY ARRAY['previous','current'] LOOP
   v_exact := CASE v_side WHEN 'previous' THEN 'exact_before' ELSE 'exact_after' END;
   v_direction := CASE v_side WHEN 'previous' THEN 'removed_text' ELSE 'added_text' END;
   v_groups := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
     'source','change_details.' || v_exact,'value',v_details -> v_exact));
   -- JS arrayValue preserves a single fact object as well as ordered arrays.
   FOREACH v_fact_key IN ARRAY ARRAY['changed_facts','changed_award_facts'] LOOP
     v_facts := v_details -> v_fact_key;
     IF v_facts IS NULL OR v_facts = 'null'::jsonb OR v_facts = '""'::jsonb THEN v_facts := '[]'::jsonb;
     ELSIF pg_catalog.jsonb_typeof(v_facts) <> 'array' THEN v_facts := pg_catalog.jsonb_build_array(v_facts);
     END IF;
     FOR v_fact IN SELECT value FROM pg_catalog.jsonb_array_elements(v_facts) LOOP
       -- objectValue ignores scalar/array fact entries in the existing JS contract.
       IF pg_catalog.jsonb_typeof(v_fact) = 'object' THEN
         v_groups := v_groups || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'source','change_details.changed_facts.' || v_direction,'value',v_fact -> v_direction));
       END IF;
     END LOOP;
   END LOOP;
   v_groups := v_groups || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
     'source','change_details.structured_diff.' || v_direction,'value',
     CASE WHEN pg_catalog.jsonb_typeof(v_details -> 'structured_diff')='object'
       THEN v_details -> 'structured_diff' -> v_direction ELSE NULL END));
   v_seen := ARRAY[]::text[]; v_serialized := '['; v_separator := '';
   FOR v_group IN SELECT value FROM pg_catalog.jsonb_array_elements(v_groups) LOOP
     v_source := v_group ->> 'source'; v_values := v_group -> 'value';
     IF v_values IS NULL OR v_values = 'null'::jsonb OR v_values = '""'::jsonb THEN v_values := '[]'::jsonb;
     ELSIF pg_catalog.jsonb_typeof(v_values) <> 'array' THEN v_values := pg_catalog.jsonb_build_array(v_values);
     END IF;
     FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_values) LOOP
       IF v_item = 'null'::jsonb THEN CONTINUE; END IF;
       -- Public exact wording is text. Arbitrary JS object/number coercion is not
       -- an evidence contract; reject it instead of silently dropping a value.
       IF pg_catalog.jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
         RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML semantic wording must be a string or array of strings.';
       END IF;
       v_normalized := private.awardping_source_html_normalize_exact_text(v_item #>> '{}');
       IF v_normalized = '' OR v_normalized = ANY(v_seen) THEN CONTINUE; END IF;
       v_seen := pg_catalog.array_append(v_seen,v_normalized);
       -- Fixed ASCII key order exactly matches JS stableJsonStringify. JSON string
       -- escaping is delegated to to_jsonb; whitespace inside strings is retained.
       v_serialized := v_serialized || v_separator || '{"normalized_text":' || pg_catalog.to_jsonb(v_normalized)::text ||
         ',"normalized_text_sha256":' || pg_catalog.to_jsonb(public.awardping_sha256_text(v_normalized))::text ||
         ',"source":' || pg_catalog.to_jsonb(v_source)::text || '}';
       v_separator := ',';
     END LOOP;
   END LOOP;
   v_serialized := v_serialized || ']';
   IF v_side = 'previous' THEN v_previous_sha := public.awardping_sha256_text(v_serialized);
   ELSE v_current_sha := public.awardping_sha256_text(v_serialized); END IF;
 END LOOP;
 v_core := '{"algorithm_version":3,"contract":"visual-exact-text-binding-v2","sides":{"current":{"candidates_sha256":' ||
   pg_catalog.to_jsonb(v_current_sha)::text || '},"previous":{"candidates_sha256":' || pg_catalog.to_jsonb(v_previous_sha)::text || '}}}';
 RETURN public.awardping_sha256_text(v_core);
END;
$function$;
REVOKE ALL ON FUNCTION private.awardping_source_html_change_semantics_sha256(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.awardping_source_html_capture_valid(p_capture jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $function$
DECLARE
  v_role text;
  v_artifact jsonb;
  v_prefix text;
  v_expected text;
  v_hash text;
BEGIN
  -- This is a typed three-artifact source record, never optional image evidence.
  IF pg_catalog.jsonb_typeof(p_capture) IS DISTINCT FROM 'object'
    OR p_capture ->> 'kind' IS DISTINCT FROM 'source_html'
    OR p_capture ->> 'capture_profile' IS DISTINCT FROM 'scrapling-source-html-v1'
    OR p_capture ->> 'acquisition' IS DISTINCT FROM 'ordinary_anonymous_http'
    OR p_capture -> 'visibility_verified' IS DISTINCT FROM 'false'::jsonb
    OR p_capture -> 'screenshot_available' IS DISTINCT FROM 'false'::jsonb
    OR p_capture -> 'state_id' IS DISTINCT FROM 'null'::jsonb
    OR NOT COALESCE(p_capture ->> 'source_id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false)
    OR NOT COALESCE(p_capture ->> 'shared_award_id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false)
    OR NOT COALESCE(p_capture ->> 'source_url' ~ '^https://[^/@:#[:space:]]+(/[^#[:space:]]*)?$', false)
    OR p_capture ->> 'source_url' IS DISTINCT FROM p_capture ->> 'final_url'
    OR NOT COALESCE(p_capture ->> 'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$', false)
    OR NOT pg_catalog.isfinite((p_capture ->> 'captured_at')::timestamptz)
    OR p_capture - ARRAY['kind','capture_profile','acquisition','source_id','shared_award_id','source_url','final_url',
       'captured_at','visibility_verified','screenshot_available','state_id','full','metadata','text','capture_hashes'] <> '{}'::jsonb
    OR pg_catalog.jsonb_typeof(p_capture -> 'capture_hashes') IS DISTINCT FROM 'object'
    OR p_capture #> '{capture_hashes,image_hash}' IS DISTINCT FROM 'null'::jsonb
    OR p_capture #> '{capture_hashes,file_hash}' IS DISTINCT FROM 'null'::jsonb
    OR p_capture #> '{capture_hashes,layout_hash}' IS DISTINCT FROM 'null'::jsonb
    OR (p_capture -> 'capture_hashes') - ARRAY['image_hash','file_hash','layout_hash','text_hash','html_sha256',
      'source_main_sha256','document_sha256','main_document_sha256'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH v_hash IN ARRAY ARRAY['text_hash','html_sha256','source_main_sha256','document_sha256','main_document_sha256'] LOOP
    IF NOT COALESCE(p_capture -> 'capture_hashes' ->> v_hash ~ '^[0-9a-f]{64}$', false) THEN RETURN false; END IF;
  END LOOP;
  v_prefix := pg_catalog.substring(p_capture #>> '{full,object_key}',
    '^(visual-snapshots/published/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/(previous|current)/)');
  IF v_prefix IS NULL THEN RETURN false; END IF;
  FOREACH v_role IN ARRAY ARRAY['full','metadata','text'] LOOP
    v_artifact := p_capture -> v_role;
    v_expected := CASE v_role WHEN 'full' THEN 'source-html/' WHEN 'metadata' THEN 'metadata/' ELSE 'text/' END;
    IF pg_catalog.jsonb_typeof(v_artifact) IS DISTINCT FROM 'object'
      OR v_artifact - ARRAY['object_key','sha256','byte_length','content_type'] <> '{}'::jsonb
      OR NOT COALESCE(v_artifact ->> 'sha256' ~ '^[0-9a-f]{64}$', false)
      OR pg_catalog.jsonb_typeof(v_artifact -> 'byte_length') IS DISTINCT FROM 'number'
      OR NOT COALESCE(v_artifact ->> 'byte_length' ~ '^[1-9][0-9]*$', false)
      OR (v_artifact ->> 'byte_length')::bigint > (CASE v_role WHEN 'full' THEN 5242880 WHEN 'text' THEN 6291457 ELSE 25165824 END)
      OR v_artifact ->> 'content_type' IS DISTINCT FROM (CASE WHEN v_role = 'metadata'
          THEN 'application/json; charset=utf-8' ELSE 'text/plain; charset=utf-8' END)
      OR v_artifact ->> 'object_key' IS DISTINCT FROM v_prefix || v_expected || (v_artifact ->> 'sha256') ||
        (CASE WHEN v_role = 'metadata' THEN '.json' ELSE '.txt' END) THEN RETURN false; END IF;
  END LOOP;
  RETURN p_capture #>> '{full,sha256}' IS NOT DISTINCT FROM p_capture #>> '{capture_hashes,html_sha256}';
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$function$;
REVOKE ALL ON FUNCTION private.awardping_source_html_capture_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.awardping_validate_source_html_capture_binding(
 p_capture jsonb, p_ref jsonb, p_candidate_id uuid, p_side text)
RETURNS void LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_role text; v_slot text; v_hash text;
BEGIN
  IF NOT private.awardping_source_html_capture_valid(p_capture)
    OR pg_catalog.jsonb_typeof(p_ref) IS DISTINCT FROM 'object'
    OR p_ref ->> 'kind' IS DISTINCT FROM 'webpage'
    OR p_ref ->> 'capture_profile' IS DISTINCT FROM 'scrapling-source-html-v1'
    OR p_ref #>> '{metadata,capture_profile}' IS DISTINCT FROM 'scrapling-source-html-v1'
    OR p_ref #>> '{metadata,source_html,schema}' IS DISTINCT FROM 'awardping.source-html-review-proof.v1'
    OR pg_catalog.jsonb_typeof(p_ref -> 'local_paths') IS DISTINCT FROM 'object'
    OR (p_ref -> 'local_paths') - ARRAY['html','meta','text'] <> '{}'::jsonb
    OR p_ref -> 'visual_states' IS DISTINCT FROM '[]'::jsonb
    OR p_ref ->> 'image_hash' IS NOT NULL OR p_ref ->> 'file_hash' IS NOT NULL OR p_ref ->> 'layout_hash' IS NOT NULL
    OR p_ref ->> 'captured_at' IS DISTINCT FROM p_capture ->> 'captured_at'
    OR p_ref ->> 'final_url' IS DISTINCT FROM p_capture ->> 'final_url'
    OR p_ref ->> 'text_hash' IS DISTINCT FROM p_capture #>> '{capture_hashes,text_hash}'
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['dimensions','text_geometry','html_capture','page_readiness','page_settle','browser','localization']) AS claimed(key)
      WHERE p_ref -> 'metadata' -> claimed.key IS NOT NULL AND p_ref -> 'metadata' -> claimed.key <> 'null'::jsonb)
  THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML capture requires exact source-only candidate identity.'; END IF;
  PERFORM public.awardping_validate_candidate_capture_prefix(p_capture,p_candidate_id,p_side);
  FOREACH v_hash IN ARRAY ARRAY['html_sha256','source_main_sha256','document_sha256','main_document_sha256'] LOOP
    IF p_ref -> 'metadata' -> 'source_html' ->> v_hash IS DISTINCT FROM p_capture -> 'capture_hashes' ->> v_hash
    THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML proof hash differs from the candidate.'; END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['full','metadata','text'] LOOP
    v_slot := CASE v_role WHEN 'full' THEN 'html' WHEN 'metadata' THEN 'meta' ELSE 'text' END;
    IF pg_catalog.jsonb_typeof(p_ref -> 'local_paths' -> v_slot) IS DISTINCT FROM 'object'
      OR p_ref -> 'local_paths' -> v_slot -> 'exists' IS DISTINCT FROM 'true'::jsonb
      OR p_ref -> 'local_paths' -> v_slot -> 'bytes' IS DISTINCT FROM p_ref -> 'local_paths' -> v_slot -> 'byte_length'
    THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML raw artifact reference is incomplete.'; END IF;
    PERFORM public.awardping_assert_candidate_artifact_matches(p_capture -> v_role,p_ref -> 'local_paths' -> v_slot,p_side || '.' || v_role,true);
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.awardping_validate_source_html_capture_binding(jsonb,jsonb,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.awardping_validate_source_html_evidence(
 p_evidence jsonb, p_candidate jsonb, p_change_details jsonb)
RETURNS void LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE
 v_side text; v_ref jsonb; v_capture jsonb; v_semantics jsonb; v_diff jsonb;
 v_binding jsonb; v_key text; v_text_key text; v_localization jsonb;
 v_fact jsonb; v_wording text; v_values jsonb; v_changed jsonb; v_count integer;
BEGIN
 IF pg_catalog.jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
   OR pg_catalog.jsonb_typeof(p_candidate) IS DISTINCT FROM 'object'
   OR pg_catalog.jsonb_typeof(p_change_details) IS DISTINCT FROM 'object'
   OR p_evidence ->> 'evidence_status' IS DISTINCT FROM 'not_applicable_source_html'
   OR p_evidence ->> 'evidence_schema_version' IS DISTINCT FROM 'source-html-event-evidence-v1'
   OR p_evidence ->> 'verified_at' IS NOT NULL OR p_evidence ->> 'backfilled_at' IS NOT NULL
   OR nullif(pg_catalog.btrim(p_evidence ->> 'bucket'),'') IS NULL
   OR NOT COALESCE(p_evidence ->> 'candidate_signature' ~ '^[0-9a-f]{64}$',false)
   OR p_evidence ->> 'candidate_signature' IS DISTINCT FROM p_candidate ->> 'candidate_signature'
   OR p_evidence ->> 'visual_review_candidate_id' IS DISTINCT FROM p_candidate ->> 'id'
   OR p_evidence ->> 'shared_award_id' IS DISTINCT FROM p_candidate ->> 'shared_award_id'
   OR p_evidence ->> 'shared_award_source_id' IS DISTINCT FROM p_candidate ->> 'shared_award_source_id'
   OR p_change_details ->> 'evidence_kind' IS DISTINCT FROM 'source_html'
   OR p_change_details ->> 'capture_profile' IS DISTINCT FROM 'scrapling-source-html-v1'
   OR p_change_details ->> 'candidate_signature' IS DISTINCT FROM p_candidate ->> 'candidate_signature'
   OR p_candidate ->> 'source_page_type' = 'pdf'
   OR NOT COALESCE(p_candidate ->> 'status' IN ('succeeded','published'),false)
   OR NOT COALESCE(p_candidate #>> '{worker_metadata,evidence_signature}' ~ '^[0-9a-f]{64}$',false)
   OR p_candidate #> '{prompt_payload,include_images}' IS DISTINCT FROM 'false'::jsonb
   OR p_candidate -> 'deterministic_diff' IS DISTINCT FROM p_candidate #> '{prompt_payload,deterministic_diff}'
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML evidence requires its explicit reviewed candidate contract.'; END IF;
 FOREACH v_key IN ARRAY ARRAY['previous_image_hash','new_image_hash','previous_file_hash','new_file_hash'] LOOP
   IF p_candidate ->> v_key IS NOT NULL OR p_candidate -> 'prompt_payload' -> 'hashes' ->> v_key IS NOT NULL
   THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML evidence cannot claim image or PDF hashes.'; END IF;
 END LOOP;
 v_diff := p_candidate -> 'deterministic_diff';
 v_semantics := v_diff -> 'scrapling_semantics';
 v_binding := v_semantics -> 'evidence';
 IF v_diff ->> 'candidate_scope' IS DISTINCT FROM 'scrapling_html_source'
   OR v_semantics -> 'complete' IS DISTINCT FROM 'true'::jsonb
   OR v_semantics ->> 'capture_profile' IS DISTINCT FROM 'scrapling-source-html-v1'
   OR v_semantics ->> 'acquisition' IS DISTINCT FROM 'ordinary_anonymous_http'
   OR v_semantics -> 'visibility_verified' IS DISTINCT FROM 'false'::jsonb
   OR v_semantics -> 'visible_prose_corroborated' IS DISTINCT FROM 'false'::jsonb
   OR v_semantics -> 'screenshot_available' IS DISTINCT FROM 'false'::jsonb
   OR v_semantics -> 'source_main_prose_corroborated' IS DISTINCT FROM 'true'::jsonb
   OR v_semantics ->> 'source_main_prose_rule' IS DISTINCT FROM 'unique_complete_changed_blocks_with_ordered_source_main_context'
   OR v_binding ->> 'capture_profile' IS DISTINCT FROM 'scrapling-source-html-v1'
   OR v_binding ->> 'source_id' IS DISTINCT FROM p_candidate ->> 'shared_award_source_id'
   OR v_binding ->> 'award_id' IS DISTINCT FROM p_candidate ->> 'shared_award_id'
   OR v_binding ->> 'final_url' IS DISTINCT FROM p_candidate ->> 'source_url'
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML paired comparison is incomplete or unbound.'; END IF;
 v_localization := p_evidence -> 'localization';
 IF pg_catalog.jsonb_typeof(v_localization) IS DISTINCT FROM 'object'
   OR v_localization ->> 'direction' IS DISTINCT FROM 'mixed'
   OR v_localization ->> 'semantic_contract' IS DISTINCT FROM 'visual-exact-text-binding-v2'
   OR NOT COALESCE(v_localization ->> 'change_semantics_sha256' ~ '^[0-9a-f]{64}$',false)
   OR v_localization ->> 'change_semantics_sha256' IS DISTINCT FROM private.awardping_source_html_change_semantics_sha256(p_change_details)
   OR v_localization - ARRAY['direction','semantic_contract','change_semantics_sha256','sides'] <> '{}'::jsonb
   OR pg_catalog.jsonb_typeof(v_localization -> 'sides') IS DISTINCT FROM 'object'
   OR (v_localization -> 'sides') - ARRAY['previous','current'] <> '{}'::jsonb
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML evidence has invalid nonvisual localization.'; END IF;
 FOREACH v_side IN ARRAY ARRAY['previous','current'] LOOP
   v_key := CASE v_side WHEN 'previous' THEN 'previous_snapshot_ref' ELSE 'new_snapshot_ref' END;
   v_text_key := CASE v_side WHEN 'previous' THEN 'previous_text_hash' ELSE 'new_text_hash' END;
   v_ref := p_candidate -> v_key;
   v_capture := p_evidence -> (v_side || '_capture');
   IF v_ref IS DISTINCT FROM p_candidate -> 'prompt_payload' -> v_key
     OR NOT private.awardping_source_html_capture_valid(v_capture)
     OR v_capture ->> 'source_id' IS DISTINCT FROM p_candidate ->> 'shared_award_source_id'
     OR v_capture ->> 'shared_award_id' IS DISTINCT FROM p_candidate ->> 'shared_award_id'
     OR v_capture ->> 'source_url' IS DISTINCT FROM p_candidate ->> 'source_url'
     OR v_capture ->> 'captured_at' IS DISTINCT FROM v_binding ->> (v_side || '_captured_at')
     OR v_capture #>> '{capture_hashes,html_sha256}' IS DISTINCT FROM v_binding ->> (v_side || '_html_sha256')
     OR v_capture #>> '{capture_hashes,source_main_sha256}' IS DISTINCT FROM v_binding ->> (v_side || '_source_main_sha256')
     OR v_capture #>> '{capture_hashes,text_hash}' IS DISTINCT FROM v_binding ->> (v_side || '_text_hash')
     OR v_capture #>> '{capture_hashes,text_hash}' IS DISTINCT FROM p_candidate ->> v_text_key
     OR p_candidate ->> v_text_key IS DISTINCT FROM p_candidate -> 'prompt_payload' -> 'hashes' ->> v_text_key
     OR v_localization -> 'sides' -> v_side IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'status','not_applicable_source_html','required',false,'exact_overlap',false,'semantic_verified',false,
       'reason','The official HTML response is retained. No screenshot was collected; visible placement is not verified.')
   THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML side does not match its immutable comparison.'; END IF;
   PERFORM public.awardping_validate_candidate_snapshot_manifest(v_ref,p_candidate -> 'prompt_payload' -> v_key,
     p_candidate -> 'prompt_payload' -> 'hashes' ->> CASE v_side WHEN 'previous' THEN 'previous_artifact_manifest_digest' ELSE 'new_artifact_manifest_digest' END,v_side);
   PERFORM public.awardping_validate_source_html_capture_binding(v_capture,v_ref,(p_candidate ->> 'id')::uuid,v_side);
   -- Public wording must occur on the corresponding side of the exact reviewed diff.
   -- Retained raw HTML/main-document containment is independently checked before upload.
   v_changed := v_diff -> CASE v_side WHEN 'previous' THEN 'removed_text' ELSE 'added_text' END;
   IF pg_catalog.jsonb_typeof(v_changed) IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML diff lacks directional wording.'; END IF;
   v_values := pg_catalog.jsonb_build_array(p_change_details -> CASE v_side WHEN 'previous' THEN 'exact_before' ELSE 'exact_after' END,
     p_change_details -> 'structured_diff' -> CASE v_side WHEN 'previous' THEN 'removed_text' ELSE 'added_text' END);
   FOR v_fact IN SELECT value FROM pg_catalog.jsonb_array_elements(
     CASE WHEN pg_catalog.jsonb_typeof(p_change_details -> 'changed_facts')='array' THEN p_change_details -> 'changed_facts'
       WHEN pg_catalog.jsonb_typeof(p_change_details -> 'changed_facts')='object' THEN pg_catalog.jsonb_build_array(p_change_details -> 'changed_facts') ELSE '[]'::jsonb END ||
     CASE WHEN pg_catalog.jsonb_typeof(p_change_details -> 'changed_award_facts')='array' THEN p_change_details -> 'changed_award_facts'
       WHEN pg_catalog.jsonb_typeof(p_change_details -> 'changed_award_facts')='object' THEN pg_catalog.jsonb_build_array(p_change_details -> 'changed_award_facts') ELSE '[]'::jsonb END)
   LOOP
     v_values := v_values || pg_catalog.jsonb_build_array(v_fact -> CASE v_side WHEN 'previous' THEN 'removed_text' ELSE 'added_text' END);
   END LOOP;
   v_count := 0;
   FOR v_fact IN SELECT value FROM pg_catalog.jsonb_array_elements(v_values) LOOP
     FOR v_wording IN SELECT value FROM public.awardping_visual_json_text_values(v_fact) AS wording(value) LOOP
       v_wording := private.awardping_source_html_normalize_exact_text(v_wording);
       IF v_wording <> '' THEN
         v_count := v_count + 1;
         IF NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_changed) AS block(value)
           WHERE pg_catalog.strpos(private.awardping_source_html_normalize_exact_text(block.value),v_wording) > 0)
         THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML public wording is outside the reviewed change.'; END IF;
       END IF;
     END LOOP;
   END LOOP;
   IF v_count = 0 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML change requires both exact wording sides.'; END IF;
 END LOOP;
 IF (p_evidence #>> '{previous_capture,captured_at}')::timestamptz >= (p_evidence #>> '{current_capture,captured_at}')::timestamptz THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Source HTML capture times must be ordered.'; END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.awardping_validate_source_html_evidence(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.awardping_validate_candidate_capture_binding(p_capture jsonb, p_candidate_snapshot_ref jsonb, p_candidate_main_image_hash text, p_candidate_id uuid, p_side text, p_require_complete boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_candidate_main_state_count integer := 0;
  v_candidate_state jsonb;
  v_candidate_state_count integer := 0;
  v_candidate_unique_state_count integer := 0;
  v_capture_main_state_count integer := 0;
  v_capture_state_count integer := 0;
  v_expected_geometry_hash text;
  v_expected_image_hash text;
  v_state jsonb;
begin
  perform public.awardping_validate_candidate_capture_prefix(
    p_capture,
    p_candidate_id,
    p_side
  );

  if p_capture ->> 'kind' = 'source_html'
    or p_capture ->> 'capture_profile' = 'scrapling-source-html-v1'
    or p_candidate_snapshot_ref ->> 'capture_profile' = 'scrapling-source-html-v1'
    or p_candidate_snapshot_ref #>> '{metadata,capture_profile}' = 'scrapling-source-html-v1' then
    if p_candidate_main_image_hash is not null then
      raise exception using errcode='23514', message='Source HTML candidate cannot claim a main image.';
    end if;
    perform public.awardping_validate_source_html_capture_binding(p_capture,p_candidate_snapshot_ref,p_candidate_id,p_side);
    return;
  end if;

  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'metadata',
    p_candidate_snapshot_ref #> '{local_paths,meta}',
    format('%s.metadata', p_side),
    p_require_complete
  );
  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'thumbnail',
    p_candidate_snapshot_ref #> '{local_paths,thumb}',
    format('%s.thumbnail', p_side),
    p_require_complete
      and jsonb_typeof(p_candidate_snapshot_ref #> '{local_paths,thumb}') = 'object'
  );
  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'text',
    p_candidate_snapshot_ref #> '{local_paths,text}',
    format('%s.text', p_side),
    p_require_complete
      and jsonb_typeof(p_candidate_snapshot_ref #> '{local_paths,text}') = 'object'
  );

  if p_capture #>> '{full,object_key}' is null then
    return;
  end if;
  if p_capture ->> 'kind' = 'pdf'
    or p_capture #>> '{full,content_type}' like 'application/pdf%' then
    perform public.awardping_assert_candidate_artifact_matches(
      p_capture -> 'full',
      p_candidate_snapshot_ref #> '{local_paths,pdf}',
      format('%s.document', p_side),
      p_require_complete
    );
    return;
  end if;

  perform public.awardping_assert_candidate_artifact_matches(
    p_capture -> 'main_full',
    p_candidate_snapshot_ref #> '{local_paths,page}',
    format('%s.main_full', p_side),
    p_require_complete
  );

  perform public.awardping_validate_capture_state_binding(p_capture, p_side);

  if p_require_complete and (
    jsonb_typeof(p_capture -> 'main_full') <> 'object'
    or jsonb_typeof(p_capture -> 'capture_hashes') <> 'object'
    or p_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_capture -> 'states') <> 'array'
    or jsonb_array_length(p_capture -> 'states') = 0
    or jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') <> 'array'
    or jsonb_array_length(p_candidate_snapshot_ref -> 'visual_states') = 0
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Visual evidence %s requires the complete candidate-bound main image and capture-state manifest.',
        p_side
      );
  end if;

  if jsonb_typeof(p_capture -> 'main_full') = 'object' then
    if p_capture #>> '{capture_hashes,image_hash}' is null
      or p_capture #>> '{main_full,sha256}' is distinct from
        p_capture #>> '{capture_hashes,image_hash}'
      or nullif(btrim(p_candidate_main_image_hash), '') is null
      or p_capture #>> '{main_full,sha256}' is distinct from p_candidate_main_image_hash then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s retained main image does not match its capture and candidate hashes.',
          p_side
        );
    end if;
  elsif p_require_complete then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s is missing its retained candidate main image.', p_side);
  end if;

  if jsonb_typeof(p_capture -> 'states') <> 'array' then
    return;
  end if;
  if jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') = 'array' then
    select
      count(*),
      count(distinct nullif(btrim(candidate_state.value ->> 'state_id'), '')),
      count(*) filter (where candidate_state.value ->> 'kind' = 'main')
    into
      v_candidate_state_count,
      v_candidate_unique_state_count,
      v_candidate_main_state_count
    from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value);
    if v_candidate_state_count <> v_candidate_unique_state_count then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s candidate snapshot has empty or duplicate visual state IDs.',
          p_side
        );
    end if;
    if v_candidate_main_state_count > 1 then
      raise exception using
        errcode = '23514',
        message = format('Visual evidence %s candidate snapshot has multiple main states.', p_side);
    end if;
  end if;
  select
    count(*),
    count(*) filter (where capture_state.value ->> 'kind' = 'main')
  into v_capture_state_count, v_capture_main_state_count
  from jsonb_array_elements(p_capture -> 'states') as capture_state(value);
  if v_capture_main_state_count > 1 then
    raise exception using
      errcode = '23514',
      message = format('Visual evidence %s capture has multiple main states.', p_side);
  end if;
  if p_require_complete and (
    v_capture_state_count <> v_candidate_state_count
    or v_candidate_main_state_count <> 1
    or exists (
      select 1
      from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_capture -> 'states') as capture_state(value)
        where capture_state.value ->> 'state_id' = candidate_state.value ->> 'state_id'
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_capture -> 'states') as capture_state(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
        where candidate_state.value ->> 'state_id' = capture_state.value ->> 'state_id'
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Visual evidence %s capture-state set does not equal its candidate snapshot-state set.',
        p_side
      );
  end if;

  for v_state in
    select state.value
    from jsonb_array_elements(p_capture -> 'states') as state(value)
  loop
    v_candidate_state := null;
    if jsonb_typeof(p_candidate_snapshot_ref -> 'visual_states') = 'array' then
      select candidate_state.value into v_candidate_state
      from jsonb_array_elements(p_candidate_snapshot_ref -> 'visual_states') as candidate_state(value)
      where candidate_state.value ->> 'state_id' = v_state ->> 'state_id';
    end if;
    if v_candidate_state is null
      and (p_require_complete or v_state ->> 'kind' <> 'main') then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s is absent from the immutable candidate snapshot reference.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;

    perform public.awardping_assert_candidate_artifact_matches(
      v_state -> 'image',
      v_candidate_state #> '{local_paths,image}',
      format('%s.states[%s].image', p_side, v_state ->> 'state_id'),
      true
    );
    perform public.awardping_assert_candidate_artifact_matches(
      v_state -> 'geometry',
      v_candidate_state #> '{local_paths,layout}',
      format('%s.states[%s].geometry', p_side, v_state ->> 'state_id'),
      p_require_complete
        and jsonb_typeof(v_candidate_state #> '{local_paths,layout}') = 'object'
    );

    v_expected_image_hash := coalesce(
      nullif(btrim(v_candidate_state ->> 'image_hash'), ''),
      nullif(btrim(v_candidate_state #>> '{metadata,screenshot,image_hash}'), ''),
      case
        when v_state ->> 'kind' = 'main' then nullif(btrim(p_candidate_main_image_hash), '')
        else null
      end
    );
    if v_expected_image_hash is null
      or v_expected_image_hash !~ '^[0-9a-f]{64}$'
      or v_state #>> '{image,sha256}' is distinct from v_expected_image_hash then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s image hash does not match its candidate snapshot reference.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;

    v_expected_geometry_hash := coalesce(
      nullif(btrim(v_candidate_state ->> 'geometry_hash'), ''),
      nullif(btrim(v_candidate_state #>> '{metadata,text_geometry,geometry_hash}'), '')
    );
    if v_expected_geometry_hash is not null then
      if v_expected_geometry_hash !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(v_state -> 'geometry') <> 'object'
        or v_state ->> 'geometry_hash' is distinct from v_expected_geometry_hash then
        raise exception using
          errcode = '23514',
          message = format(
            'Visual evidence %s state %s geometry hash does not match its candidate snapshot reference.',
            p_side,
            coalesce(v_state ->> 'state_id', '<missing>')
          );
      end if;
    elsif jsonb_typeof(v_state -> 'geometry') = 'object' then
      raise exception using
        errcode = '23514',
        message = format(
          'Visual evidence %s state %s geometry has no candidate snapshot hash binding.',
          p_side,
          coalesce(v_state ->> 'state_id', '<missing>')
        );
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.awardping_validate_visual_evidence_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_event public.shared_award_change_events%rowtype;
  v_direction text;
  v_previous_required boolean;
  v_current_required boolean;
  v_previous_localization jsonb;
  v_current_localization jsonb;
begin
  select * into strict v_event
  from public.shared_award_change_events event
  where event.id = new.change_event_id;

  if v_event.shared_award_id <> new.shared_award_id
    or v_event.shared_award_source_id is distinct from new.shared_award_source_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence award/source identity does not match its change event.';
  end if;

  if new.evidence_status = 'historical_artifact_unrecoverable' and (
    coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
    or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
    or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
    or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
    or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null
  ) then
    raise exception using errcode = '23514',
      message = 'Unrecoverable visual history requires explicit terminal artifact-loss confirmation.';
  end if;

  if new.visual_review_candidate_id is null then
    if new.backfilled_at is null
      or new.evidence_status <> 'historical_artifact_unrecoverable'
      or new.previous_capture <> '{}'::jsonb
      or new.current_capture <> '{}'::jsonb
      or new.bucket is not null
      or coalesce((new.localization ->> 'terminal_artifact_loss_confirmed')::boolean, false) is not true
      or nullif(btrim(new.localization ->> 'terminal_artifact_loss_reason'), '') is null
      or new.localization #>> '{sides,previous,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,previous,reason}'), '') is null
      or new.localization #>> '{sides,current,status}' is distinct from 'historical_artifact_unrecoverable'
      or nullif(btrim(new.localization #>> '{sides,current,reason}'), '') is null then
      raise exception using errcode = '23514',
        message = 'Candidate-free visual evidence is allowed only after explicit terminal artifact-loss confirmation.';
    end if;
    return new;
  end if;

  select * into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = new.visual_review_candidate_id;
  if v_candidate.shared_award_id <> new.shared_award_id
    or v_candidate.shared_award_source_id is distinct from new.shared_award_source_id
    or v_candidate.candidate_signature <> new.candidate_signature then
    raise exception using errcode = '23514',
      message = 'Visual evidence identity does not match its review candidate.';
  end if;
  if v_event.visual_review_candidate_id is distinct from new.visual_review_candidate_id then
    raise exception using errcode = '23514',
      message = 'Visual evidence candidate does not match its change event binding.';
  end if;

  if to_jsonb(new) ->> 'evidence_status' = 'not_applicable_source_html'
    or to_jsonb(new) ->> 'evidence_schema_version' = 'source-html-event-evidence-v1'
    or to_jsonb(new) #>> '{previous_capture,kind}' = 'source_html'
    or to_jsonb(new) #>> '{current_capture,kind}' = 'source_html'
    or to_jsonb(new) #>> '{previous_capture,capture_profile}' = 'scrapling-source-html-v1'
    or to_jsonb(new) #>> '{current_capture,capture_profile}' = 'scrapling-source-html-v1'
    or v_event.change_details ->> 'evidence_kind' = 'source_html'
    or v_event.change_details ->> 'capture_profile' = 'scrapling-source-html-v1' then
    perform public.awardping_validate_source_html_evidence(to_jsonb(new),to_jsonb(v_candidate),v_event.change_details);
  end if;

  if new.evidence_status = 'verified' then
    if new.evidence_schema_version <> 'visual-event-evidence-v2' then
      raise exception using errcode = '23514',
        message = 'New verified crops require visual-event-evidence-v2; v1 crops are full-screenshot fallback only.';
    end if;
    perform public.awardping_validate_exact_visual_evidence(
      new.previous_capture,
      new.current_capture,
      new.localization
    );
    v_direction := new.localization ->> 'direction';
    v_previous_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'previous');
    v_current_required := public.awardping_visual_event_has_semantic_side(v_event.change_details, 'current');
    if (v_previous_required and v_current_required and v_direction not in ('changed', 'mixed'))
      or (v_previous_required and not v_current_required and v_direction <> 'removed')
      or (v_current_required and not v_previous_required and v_direction <> 'added')
      or (not v_previous_required and not v_current_required) then
      raise exception using errcode = '23514',
        message = 'Verified crop direction does not match the exact directional wording in the event.';
    end if;
    v_previous_localization := new.localization #> '{sides,previous}';
    v_current_localization := new.localization #> '{sides,current}';
    if v_previous_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'previous',
      v_previous_localization #>> '{semantic_binding,wording_source}',
      v_previous_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Previous crop wording is not an exact removed value from this event.';
    end if;
    if v_current_required and not public.awardping_visual_semantic_text_allowed(
      v_event.change_details,
      'current',
      v_current_localization #>> '{semantic_binding,wording_source}',
      v_current_localization ->> 'exact_text'
    ) then
      raise exception using errcode = '23514',
        message = 'Current crop wording is not an exact added value from this event.';
    end if;
    if new.localization ->> 'change_semantics_sha256' is distinct from
        coalesce(v_previous_localization #>> '{semantic_binding,change_semantics_sha256}',
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}')
      or (v_previous_required and v_current_required and
        v_previous_localization #>> '{semantic_binding,change_semantics_sha256}' is distinct from
          v_current_localization #>> '{semantic_binding,change_semantics_sha256}') then
      raise exception using errcode = '23514',
        message = 'Required crop sides do not share the event semantic manifest hash.';
    end if;
  end if;
  return new;
exception
  when no_data_found then
    raise exception using errcode = '23503',
      message = 'Visual evidence references a missing event or candidate.';
end;
$function$;

CREATE OR REPLACE FUNCTION public.publish_shared_award_visual_event(p_event jsonb, p_evidence jsonb)
 RETURNS TABLE(change_event_id uuid, evidence_id uuid, inserted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_award public.shared_awards%rowtype;
  v_candidate public.shared_award_visual_review_candidates%rowtype;
  v_existing_event public.shared_award_change_events%rowtype;
  v_existing_evidence public.shared_award_change_event_visual_evidence%rowtype;
  v_candidate_id uuid;
  v_award_id uuid;
  v_source_id uuid;
  v_evidence_candidate_id uuid;
  v_evidence_award_id uuid;
  v_evidence_source_id uuid;
  v_event_id uuid;
  v_evidence_id uuid;
  v_candidate_signature text;
  v_source_url text;
  v_source public.shared_award_sources%rowtype;
  v_previous_hash text;
  v_new_hash text;
  v_status text;
  v_bucket text;
  v_schema_version text;
  v_previous_capture jsonb;
  v_current_capture jsonb;
  v_localization jsonb;
  v_event_inserted boolean := false;
  v_evidence_inserted boolean := false;
  v_previous_full_key text;
  v_current_full_key text;
  v_previous_metadata_key text;
  v_current_metadata_key text;
  v_direction text;
  v_previous_exact boolean := false;
  v_current_exact boolean := false;
  v_previous_state_bound boolean := false;
  v_current_state_bound boolean := false;
  v_source_title text;
  v_source_page_type text;
  v_previous_snapshot_id uuid;
  v_new_snapshot_id uuid;
  v_summary text;
  v_change_details jsonb;
  v_office_id uuid;
  v_monitor_id uuid;
  v_detected_at timestamptz;
  v_detected_at_supplied boolean := false;
begin
  if jsonb_typeof(p_event) <> 'object' or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'Event and evidence payloads must be JSON objects.';
  end if;

  begin
    v_candidate_id := nullif(p_event ->> 'visual_review_candidate_id', '')::uuid;
    v_award_id := nullif(p_event ->> 'shared_award_id', '')::uuid;
    v_source_id := nullif(p_event ->> 'shared_award_source_id', '')::uuid;
    v_previous_snapshot_id := nullif(p_event ->> 'previous_snapshot_id', '')::uuid;
    v_new_snapshot_id := nullif(p_event ->> 'new_snapshot_id', '')::uuid;
    v_office_id := nullif(p_event ->> 'first_reported_by_office_id', '')::uuid;
    v_monitor_id := nullif(p_event ->> 'first_reported_by_monitor_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Event identifiers must be valid UUIDs.';
  end;

  if v_candidate_id is null then
    raise exception using
      errcode = '23514',
      message = 'New visual publication requires visual_review_candidate_id.';
  end if;

  select * into strict v_candidate
  from public.shared_award_visual_review_candidates candidate
  where candidate.id = v_candidate_id
  for update;

  v_candidate_signature := v_candidate.candidate_signature;
  if v_candidate.shared_award_id <> v_award_id
    or v_candidate.shared_award_source_id is distinct from v_source_id then
    raise exception using
      errcode = '23514',
      message = 'Event identity does not match the visual review candidate.';
  end if;

  -- This lock is identical to source retirement's lock. Publication
  -- first is subsequently suppressed by retirement; retirement first causes
  -- publication to observe review_later and fail closed.
  select source.* into strict v_source
  from public.shared_award_sources source
  where source.id = v_source_id
  for update;
  if v_source.shared_award_id <> v_award_id
    or v_source.admin_review_status <> 'open' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires an open shared award source.';
  end if;

  select award.* into strict v_award
  from public.shared_awards award
  where award.id = v_award_id
  for share;
  if v_award.status <> 'active' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires an active shared award.';
  end if;
  if nullif(p_event ->> 'candidate_signature', '') is not null
    and p_event ->> 'candidate_signature' <> v_candidate_signature then
    raise exception using
      errcode = '23514',
      message = 'Event candidate signature does not match the visual review candidate.';
  end if;
  begin
    v_evidence_candidate_id := nullif(p_evidence ->> 'visual_review_candidate_id', '')::uuid;
    v_evidence_award_id := nullif(p_evidence ->> 'shared_award_id', '')::uuid;
    v_evidence_source_id := nullif(p_evidence ->> 'shared_award_source_id', '')::uuid;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Evidence candidate, award, and source IDs must be valid UUIDs.';
  end;
  if v_evidence_candidate_id is distinct from v_candidate_id
    or v_evidence_award_id is distinct from v_award_id
    or v_evidence_source_id is distinct from v_source_id
    or nullif(btrim(p_evidence ->> 'candidate_signature'), '') is distinct from v_candidate_signature then
    raise exception using
      errcode = '23514',
      message = 'Evidence candidate signature/award/source identity does not match the event.';
  end if;
  if v_candidate.status not in ('succeeded', 'published') then
    raise exception using
      errcode = '23514',
      message = 'Only a successfully reviewed visual candidate can be published.';
  end if;
  if v_candidate.worker_metadata ->> 'evidence_signature' is null
    or v_candidate.worker_metadata ->> 'evidence_signature' !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires the immutable candidate evidence signature.';
  end if;

  v_source_url := nullif(btrim(p_event ->> 'source_url'), '');
  v_source_title := nullif(btrim(p_event ->> 'source_title'), '');
  v_source_page_type := nullif(btrim(p_event ->> 'source_page_type'), '');
  v_previous_hash := nullif(btrim(p_event ->> 'previous_hash'), '');
  v_new_hash := nullif(btrim(p_event ->> 'new_hash'), '');
  v_summary := nullif(btrim(p_event ->> 'summary'), '');
  v_change_details := coalesce(p_event -> 'change_details', '{}'::jsonb);
  if v_source_url is null or v_previous_hash is null or v_new_hash is null
    or v_summary is null then
    raise exception using
      errcode = '23514',
      message = 'Visual publication requires source_url, previous_hash, new_hash, and summary.';
  end if;
  if v_source_url is distinct from v_candidate.source_url
    or v_source_url is distinct from v_source.url
    or v_source_title is distinct from v_candidate.source_title
    or v_source_page_type is distinct from v_candidate.source_page_type then
    raise exception using
      errcode = '23514',
      message = 'Published event source identity does not match its locked candidate and source.';
  end if;
  if jsonb_typeof(v_change_details) <> 'object' then
    raise exception using errcode = '22023', message = 'Event change_details must be a JSON object.';
  end if;
  v_change_details := v_change_details
    || jsonb_build_object('candidate_signature', v_candidate_signature);
  v_detected_at_supplied := nullif(p_event ->> 'detected_at', '') is not null;
  begin
    v_detected_at := coalesce(
      nullif(p_event ->> 'detected_at', '')::timestamptz,
      now()
    );
  exception
    when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Event detected_at must be a valid timestamp.';
  end;

  v_status := nullif(btrim(p_evidence ->> 'evidence_status'), '');
  v_bucket := nullif(btrim(p_evidence ->> 'bucket'), '');
  v_schema_version := coalesce(
    nullif(btrim(p_evidence ->> 'evidence_schema_version'), ''),
    'visual-event-evidence-v1'
  );
  v_previous_capture := coalesce(p_evidence -> 'previous_capture', '{}'::jsonb);
  v_current_capture := coalesce(p_evidence -> 'current_capture', '{}'::jsonb);
  v_localization := coalesce(p_evidence -> 'localization', '{}'::jsonb);

  if v_status is null or v_status not in (
    'verified',
    'unavailable_exact_text_missing',
    'unavailable_geometry_missing',
    'unavailable_ambiguous',
    'full_screenshot_fallback',
    'not_applicable_pdf',
    'not_applicable_source_html'
  ) then
    raise exception using
      errcode = '23514',
      message = 'New visual publication supplied an unavailable or historical-only evidence status.';
  end if;
  if jsonb_typeof(v_previous_capture) <> 'object'
    or jsonb_typeof(v_current_capture) <> 'object'
    or jsonb_typeof(v_localization) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'Capture and localization payloads must be JSON objects.';
  end if;
  -- Source-only evidence is an explicit complete contract, never a missing-image fallback.
  if p_evidence ->> 'evidence_status' = 'not_applicable_source_html'
    or p_evidence ->> 'evidence_schema_version' = 'source-html-event-evidence-v1'
    or p_evidence #>> '{previous_capture,kind}' = 'source_html'
    or p_evidence #>> '{current_capture,kind}' = 'source_html'
    or p_evidence #>> '{previous_capture,capture_profile}' = 'scrapling-source-html-v1'
    or p_evidence #>> '{current_capture,capture_profile}' = 'scrapling-source-html-v1'
    or v_change_details ->> 'evidence_kind' = 'source_html'
    or v_change_details ->> 'capture_profile' = 'scrapling-source-html-v1' then
    perform public.awardping_validate_source_html_evidence(p_evidence,to_jsonb(v_candidate),v_change_details);
  end if;
  perform public.awardping_validate_capture_artifact_references(v_previous_capture, 'previous');
  perform public.awardping_validate_capture_artifact_references(v_current_capture, 'current');
  perform public.awardping_validate_candidate_snapshot_manifest(
    v_candidate.previous_snapshot_ref,
    v_candidate.prompt_payload -> 'previous_snapshot_ref',
    v_candidate.prompt_payload #>> '{hashes,previous_artifact_manifest_digest}',
    'previous'
  );
  perform public.awardping_validate_candidate_snapshot_manifest(
    v_candidate.new_snapshot_ref,
    v_candidate.prompt_payload -> 'new_snapshot_ref',
    v_candidate.prompt_payload #>> '{hashes,new_artifact_manifest_digest}',
    'current'
  );
  perform public.awardping_validate_candidate_capture_binding(
    v_previous_capture,
    case
      when jsonb_typeof(v_candidate.previous_snapshot_ref) = 'object'
        and v_candidate.previous_snapshot_ref <> '{}'::jsonb
        then v_candidate.previous_snapshot_ref
      else coalesce(v_candidate.prompt_payload -> 'previous_snapshot_ref', '{}'::jsonb)
    end,
    coalesce(
      v_candidate.previous_image_hash,
      nullif(v_candidate.previous_snapshot_ref ->> 'image_hash', ''),
      nullif(v_candidate.prompt_payload #>> '{previous_snapshot_ref,image_hash}', ''),
      nullif(v_candidate.prompt_payload #>> '{hashes,previous_image_hash}', '')
    ),
    v_candidate_id,
    'previous',
    true
  );
  perform public.awardping_validate_candidate_capture_binding(
    v_current_capture,
    case
      when jsonb_typeof(v_candidate.new_snapshot_ref) = 'object'
        and v_candidate.new_snapshot_ref <> '{}'::jsonb
        then v_candidate.new_snapshot_ref
      else coalesce(v_candidate.prompt_payload -> 'new_snapshot_ref', '{}'::jsonb)
    end,
    coalesce(
      v_candidate.new_image_hash,
      nullif(v_candidate.new_snapshot_ref ->> 'image_hash', ''),
      nullif(v_candidate.prompt_payload #>> '{new_snapshot_ref,image_hash}', ''),
      nullif(v_candidate.prompt_payload #>> '{hashes,new_image_hash}', '')
    ),
    v_candidate_id,
    'current',
    true
  );
  if v_localization #>> '{sides,previous,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_previous_capture,
      v_localization #> '{sides,previous}',
      'previous'
    );
  end if;
  if v_localization #>> '{sides,current,status}' = 'verified' then
    perform public.awardping_validate_exact_visual_evidence_side(
      v_current_capture,
      v_localization #> '{sides,current}',
      'current'
    );
  end if;

  v_previous_full_key := nullif(v_previous_capture #>> '{full,object_key}', '');
  v_current_full_key := nullif(v_current_capture #>> '{full,object_key}', '');
  v_previous_metadata_key := nullif(v_previous_capture #>> '{metadata,object_key}', '');
  v_current_metadata_key := nullif(v_current_capture #>> '{metadata,object_key}', '');
  if v_status = 'not_applicable_source_html' then
    -- Fully validated above; source HTML makes no image/state/dimension claim.
    null;
  elsif v_status <> 'not_applicable_pdf' then
    if v_bucket is null
      or v_previous_full_key is null
      or v_current_full_key is null
      or v_previous_metadata_key is null
      or v_current_metadata_key is null
      or jsonb_typeof(v_previous_capture -> 'capture_hashes') <> 'object'
      or jsonb_typeof(v_current_capture -> 'capture_hashes') <> 'object' then
      raise exception using
        errcode = '23514',
        message = 'Published webpage evidence requires bucket and immutable previous/current full images, metadata, and capture hashes.';
    end if;
    if nullif(btrim(v_previous_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_current_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_previous_capture ->> 'state_id'), '') is null
      or nullif(btrim(v_current_capture ->> 'state_id'), '') is null then
      raise exception using
        errcode = '23514',
        message = 'Published webpage evidence requires captured_at and state_id on both immutable captures.';
    end if;
  else
    if v_bucket is null
      or v_previous_full_key is null
      or v_current_full_key is null
      or v_previous_metadata_key is null
      or v_current_metadata_key is null
      or jsonb_typeof(v_previous_capture -> 'capture_hashes') <> 'object'
      or jsonb_typeof(v_current_capture -> 'capture_hashes') <> 'object'
      or nullif(btrim(v_previous_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_current_capture ->> 'captured_at'), '') is null
      or nullif(btrim(v_previous_capture ->> 'state_id'), '') is null
      or nullif(btrim(v_current_capture ->> 'state_id'), '') is null then
      raise exception using
        errcode = '23514',
        message = 'Published PDF evidence requires bucket, previous/current documents, metadata, capture hashes, timestamps, and state IDs.';
    end if;
  end if;

  if (
      v_previous_full_key is not null
      and v_previous_full_key not like 'visual-snapshots/published/%'
    ) or (
      v_current_full_key is not null
      and v_current_full_key not like 'visual-snapshots/published/%'
    ) or (
      v_previous_metadata_key is not null
      and v_previous_metadata_key not like 'visual-snapshots/published/%'
    ) or (
      v_current_metadata_key is not null
      and v_current_metadata_key not like 'visual-snapshots/published/%'
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published evidence object keys must use the permanent published prefix.';
  end if;

  if v_status = 'not_applicable_source_html' then
    -- Fully validated above; source HTML makes no image/state/dimension claim.
    null;
  elsif v_status <> 'not_applicable_pdf' then
    if v_previous_capture #>> '{full,sha256}' is null
      or v_previous_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{full,sha256}' is null
      or v_current_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{metadata,sha256}' is null
      or v_previous_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{metadata,sha256}' is null
      or v_current_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{capture_hashes,image_hash}' is null
      or v_previous_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,image_hash}' is null
      or v_current_capture #>> '{capture_hashes,image_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{capture_hashes,text_hash}' is null
      or v_previous_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,text_hash}' is null
      or v_current_capture #>> '{capture_hashes,text_hash}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_previous_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_previous_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_previous_capture #>> '{full,height}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,width}')::integer, 0) <= 0
      or coalesce((v_current_capture #>> '{full,height}')::integer, 0) <= 0
      or nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'image/%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%' then
      raise exception using
        errcode = '23514',
        message = 'Published webpage artifacts require verified SHA-256, byte lengths, and full-image dimensions.';
    end if;
  else
    if v_previous_capture #>> '{full,sha256}' is null
      or v_previous_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{full,sha256}' is null
      or v_current_capture #>> '{full,sha256}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{full,byte_length}')::bigint, 0) <= 0
      or v_previous_capture #>> '{metadata,sha256}' is null
      or v_previous_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{metadata,sha256}' is null
      or v_current_capture #>> '{metadata,sha256}' !~ '^[0-9a-f]{64}$'
      or coalesce((v_previous_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or coalesce((v_current_capture #>> '{metadata,byte_length}')::bigint, 0) <= 0
      or nullif(btrim(v_previous_capture #>> '{full,content_type}'), '') is null
      or v_previous_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_current_capture #>> '{full,content_type}'), '') is null
      or v_current_capture #>> '{full,content_type}' not like 'application/pdf%'
      or nullif(btrim(v_previous_capture #>> '{metadata,content_type}'), '') is null
      or v_previous_capture #>> '{metadata,content_type}' not like 'application/json%'
      or nullif(btrim(v_current_capture #>> '{metadata,content_type}'), '') is null
      or v_current_capture #>> '{metadata,content_type}' not like 'application/json%'
      or v_previous_capture ->> 'kind' is distinct from 'pdf'
      or v_current_capture ->> 'kind' is distinct from 'pdf'
      or v_previous_capture ->> 'state_id' is distinct from 'document'
      or v_current_capture ->> 'state_id' is distinct from 'document'
      or v_previous_capture #>> '{capture_hashes,file_hash}' is null
      or v_previous_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_current_capture #>> '{capture_hashes,file_hash}' is null
      or v_current_capture #>> '{capture_hashes,file_hash}' !~ '^[0-9a-f]{64}$'
      or v_previous_capture #>> '{full,sha256}' is distinct from
        v_previous_capture #>> '{capture_hashes,file_hash}'
      or v_current_capture #>> '{full,sha256}' is distinct from
        v_current_capture #>> '{capture_hashes,file_hash}' then
      raise exception using
        errcode = '23514',
        message = 'Published PDF artifacts require verified SHA-256, byte lengths, content types, and file hashes.';
    end if;
  end if;

  if v_candidate.previous_image_hash is not null
    and v_previous_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.previous_image_hash then
    raise exception using errcode = '23514', message = 'Previous capture image hash does not match the review candidate.';
  end if;
  if v_candidate.new_image_hash is not null
    and v_current_capture #>> '{capture_hashes,image_hash}' is distinct from v_candidate.new_image_hash then
    raise exception using errcode = '23514', message = 'Current capture image hash does not match the review candidate.';
  end if;
  if v_candidate.previous_text_hash is not null
    and v_previous_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.previous_text_hash then
    raise exception using errcode = '23514', message = 'Previous capture text hash does not match the review candidate.';
  end if;
  if v_candidate.new_text_hash is not null
    and v_current_capture #>> '{capture_hashes,text_hash}' is distinct from v_candidate.new_text_hash then
    raise exception using errcode = '23514', message = 'Current capture text hash does not match the review candidate.';
  end if;
  if v_candidate.previous_file_hash is not null
    and v_previous_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.previous_file_hash then
    raise exception using errcode = '23514', message = 'Previous capture file hash does not match the review candidate.';
  end if;
  if v_candidate.new_file_hash is not null
    and v_current_capture #>> '{capture_hashes,file_hash}' is distinct from v_candidate.new_file_hash then
    raise exception using errcode = '23514', message = 'Current capture file hash does not match the review candidate.';
  end if;

  if v_status = 'verified' then
    perform public.awardping_validate_exact_visual_evidence(
      v_previous_capture,
      v_current_capture,
      v_localization
    );
    v_direction := nullif(btrim(v_localization ->> 'direction'), '');
    if v_direction is null or v_direction not in ('added', 'removed', 'changed', 'mixed') then
      raise exception using
        errcode = '23514',
        message = 'Verified evidence requires an added, removed, changed, or mixed localization direction.';
    end if;

    if jsonb_typeof(v_previous_capture -> 'states') = 'array' then
      select exists (
        select 1
        from jsonb_array_elements(v_previous_capture -> 'states') as state(value)
        where state.value ->> 'state_id' = v_previous_capture ->> 'state_id'
          and state.value #>> '{image,object_key}' = v_previous_capture #>> '{full,object_key}'
          and state.value #>> '{geometry,object_key}' = v_previous_capture #>> '{layout,object_key}'
      ) into v_previous_state_bound;
    end if;
    if jsonb_typeof(v_current_capture -> 'states') = 'array' then
      select exists (
        select 1
        from jsonb_array_elements(v_current_capture -> 'states') as state(value)
        where state.value ->> 'state_id' = v_current_capture ->> 'state_id'
          and state.value #>> '{image,object_key}' = v_current_capture #>> '{full,object_key}'
          and state.value #>> '{geometry,object_key}' = v_current_capture #>> '{layout,object_key}'
      ) into v_current_state_bound;
    end if;

    v_previous_exact :=
      jsonb_typeof(v_previous_capture -> 'crop') = 'object'
      and v_previous_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
      and v_previous_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_previous_capture #>> '{crop,byte_length}')::bigint, 0) > 0
      and coalesce((v_previous_capture #>> '{crop,width}')::integer, 0) > 0
      and coalesce((v_previous_capture #>> '{crop,height}')::integer, 0) > 0
      and jsonb_typeof(v_previous_capture #> '{crop,clip}') = 'object'
      and coalesce((v_previous_capture #>> '{crop,clip,x}')::integer, -1) >= 0
      and coalesce((v_previous_capture #>> '{crop,clip,y}')::integer, -1) >= 0
      and v_previous_capture #>> '{crop,clip,width}' = v_previous_capture #>> '{crop,width}'
      and v_previous_capture #>> '{crop,clip,height}' = v_previous_capture #>> '{crop,height}'
      and coalesce((v_previous_capture #>> '{crop,exact_overlap}')::boolean, false)
      and v_previous_capture #>> '{crop,state_id}' = v_previous_capture ->> 'state_id'
      and v_previous_capture #> '{crop,css_clip}' = v_localization #> '{sides,previous,crop_rect}'
      and jsonb_typeof(v_previous_capture -> 'layout') = 'object'
      and v_previous_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
      and v_previous_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_previous_capture #>> '{layout,byte_length}')::bigint, 0) > 0
      and v_previous_capture #>> '{layout,content_type}' like 'application/json%'
      and v_previous_capture #>> '{layout,state_id}' = v_previous_capture ->> 'state_id'
      and v_previous_state_bound
      and v_localization #>> '{sides,previous,status}' = 'verified'
      and nullif(btrim(v_localization #>> '{sides,previous,exact_text}'), '') is not null
      and jsonb_typeof(v_localization #> '{sides,previous,matched_rects}') = 'array'
      and jsonb_array_length(v_localization #> '{sides,previous,matched_rects}') > 0
      and jsonb_typeof(v_localization #> '{sides,previous,crop_rect}') = 'object'
      and coalesce((v_localization #>> '{sides,previous,exact_overlap}')::boolean, false)
      and nullif(btrim(v_localization #>> '{sides,previous,algorithm_version}'), '') is not null
      and nullif(btrim(v_localization #>> '{sides,previous,state_id}'), '') is not null
      and v_localization #>> '{sides,previous,state_id}' is not distinct from
        v_previous_capture ->> 'state_id';

    v_current_exact :=
      jsonb_typeof(v_current_capture -> 'crop') = 'object'
      and v_current_capture #>> '{crop,object_key}' like 'visual-snapshots/published/%'
      and v_current_capture #>> '{crop,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_current_capture #>> '{crop,byte_length}')::bigint, 0) > 0
      and coalesce((v_current_capture #>> '{crop,width}')::integer, 0) > 0
      and coalesce((v_current_capture #>> '{crop,height}')::integer, 0) > 0
      and jsonb_typeof(v_current_capture #> '{crop,clip}') = 'object'
      and coalesce((v_current_capture #>> '{crop,clip,x}')::integer, -1) >= 0
      and coalesce((v_current_capture #>> '{crop,clip,y}')::integer, -1) >= 0
      and v_current_capture #>> '{crop,clip,width}' = v_current_capture #>> '{crop,width}'
      and v_current_capture #>> '{crop,clip,height}' = v_current_capture #>> '{crop,height}'
      and coalesce((v_current_capture #>> '{crop,exact_overlap}')::boolean, false)
      and v_current_capture #>> '{crop,state_id}' = v_current_capture ->> 'state_id'
      and v_current_capture #> '{crop,css_clip}' = v_localization #> '{sides,current,crop_rect}'
      and jsonb_typeof(v_current_capture -> 'layout') = 'object'
      and v_current_capture #>> '{layout,object_key}' like 'visual-snapshots/published/%'
      and v_current_capture #>> '{layout,sha256}' ~ '^[0-9a-f]{64}$'
      and coalesce((v_current_capture #>> '{layout,byte_length}')::bigint, 0) > 0
      and v_current_capture #>> '{layout,content_type}' like 'application/json%'
      and v_current_capture #>> '{layout,state_id}' = v_current_capture ->> 'state_id'
      and v_current_state_bound
      and v_localization #>> '{sides,current,status}' = 'verified'
      and nullif(btrim(v_localization #>> '{sides,current,exact_text}'), '') is not null
      and jsonb_typeof(v_localization #> '{sides,current,matched_rects}') = 'array'
      and jsonb_array_length(v_localization #> '{sides,current,matched_rects}') > 0
      and jsonb_typeof(v_localization #> '{sides,current,crop_rect}') = 'object'
      and coalesce((v_localization #>> '{sides,current,exact_overlap}')::boolean, false)
      and nullif(btrim(v_localization #>> '{sides,current,algorithm_version}'), '') is not null
      and nullif(btrim(v_localization #>> '{sides,current,state_id}'), '') is not null
      and v_localization #>> '{sides,current,state_id}' is not distinct from
        v_current_capture ->> 'state_id';

    if v_direction = 'added' and v_current_exact is not true then
      raise exception using errcode = '23514', message = 'Added wording must be verified in the current crop.';
    end if;
    if v_direction = 'removed' and v_previous_exact is not true then
      raise exception using errcode = '23514', message = 'Removed wording must be verified in the previous crop.';
    end if;
    if v_direction in ('changed', 'mixed')
      and (v_previous_exact is not true or v_current_exact is not true) then
      raise exception using errcode = '23514', message = 'Changed wording must be verified in both event crops.';
    end if;
  end if;

  insert into public.shared_award_change_events (
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_page_type,
    previous_snapshot_id,
    new_snapshot_id,
    previous_hash,
    new_hash,
    summary,
    change_details,
    first_reported_by_office_id,
    first_reported_by_monitor_id,
    detected_at,
    visual_review_candidate_id
  ) values (
    v_award_id,
    v_source_id,
    v_source_url,
    v_source_title,
    v_source_page_type,
    v_previous_snapshot_id,
    v_new_snapshot_id,
    v_previous_hash,
    v_new_hash,
    v_summary,
    v_change_details,
    v_office_id,
    v_monitor_id,
    v_detected_at,
    v_candidate_id
  )
  on conflict (shared_award_id, source_url, previous_hash, new_hash) do nothing
  returning id into v_event_id;
  v_event_inserted := found;

  if v_event_id is null then
    select event.* into strict v_existing_event
    from public.shared_award_change_events event
    where event.shared_award_id = v_award_id
      and event.source_url = v_source_url
      and event.previous_hash = v_previous_hash
      and event.new_hash = v_new_hash
    for update;

    if v_existing_event.shared_award_source_id is distinct from v_source_id
      or v_existing_event.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_event.source_title is distinct from v_source_title
      or v_existing_event.source_page_type is distinct from v_source_page_type
      or v_existing_event.previous_snapshot_id is distinct from v_previous_snapshot_id
      or v_existing_event.new_snapshot_id is distinct from v_new_snapshot_id
      or v_existing_event.summary is distinct from v_summary
      or v_existing_event.change_details is distinct from v_change_details
      or v_existing_event.first_reported_by_office_id is distinct from v_office_id
      or v_existing_event.first_reported_by_monitor_id is distinct from v_monitor_id
      or (
        v_detected_at_supplied
        and v_existing_event.detected_at is distinct from v_detected_at
      ) then
      raise exception using
        errcode = '23514',
        message = 'Existing change event identity conflicts with this visual publication.';
    end if;
    v_event_id := v_existing_event.id;
  end if;

  insert into public.shared_award_change_event_visual_evidence (
    change_event_id,
    shared_award_id,
    shared_award_source_id,
    visual_review_candidate_id,
    candidate_signature,
    bucket,
    evidence_status,
    previous_capture,
    current_capture,
    localization,
    evidence_schema_version,
    verified_at,
    backfilled_at
  ) values (
    v_event_id,
    v_award_id,
    v_source_id,
    v_candidate_id,
    v_candidate_signature,
    v_bucket,
    v_status,
    v_previous_capture,
    v_current_capture,
    v_localization,
    v_schema_version,
    case when v_status = 'verified' then now() else null end,
    null
  )
  on conflict on constraint shared_award_change_event_visual_evidence_pkey do nothing
  returning id into v_evidence_id;
  v_evidence_inserted := found;

  if v_evidence_id is null then
    select evidence.* into strict v_existing_evidence
    from public.shared_award_change_event_visual_evidence evidence
    where evidence.change_event_id = v_event_id;

    if v_existing_evidence.shared_award_id <> v_award_id
      or v_existing_evidence.shared_award_source_id is distinct from v_source_id
      or v_existing_evidence.visual_review_candidate_id is distinct from v_candidate_id
      or v_existing_evidence.candidate_signature is distinct from v_candidate_signature
      or v_existing_evidence.bucket is distinct from v_bucket
      or v_existing_evidence.evidence_status <> v_status
      or v_existing_evidence.previous_capture <> v_previous_capture
      or v_existing_evidence.current_capture <> v_current_capture
      or v_existing_evidence.localization <> v_localization
      or v_existing_evidence.evidence_schema_version <> v_schema_version
      or v_existing_evidence.backfilled_at is not null then
      raise exception using
        errcode = '23514',
        message = 'Existing immutable visual evidence conflicts with this publication retry.';
    end if;
    v_evidence_id := v_existing_evidence.id;
  end if;

  change_event_id := v_event_id;
  evidence_id := v_evidence_id;
  inserted := v_event_inserted or v_evidence_inserted;
  return next;
exception
  when no_data_found then
    raise exception using
      errcode = '23503',
      message = 'Visual publication references a missing event or candidate.';
end;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_source_html_event_evidence_valid(p_event jsonb, p_evidence jsonb, p_candidate jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  if pg_catalog.jsonb_typeof(p_event) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
    or nullif(p_event ->> 'id', '') is null
    or nullif(p_evidence ->> 'id', '') is null
    or nullif(p_candidate ->> 'id', '') is null
    or p_evidence ->> 'change_event_id' is distinct from p_event ->> 'id'
    or p_evidence ->> 'visual_review_candidate_id' is distinct from p_candidate ->> 'id'
    or p_event ->> 'visual_review_candidate_id' is distinct from p_candidate ->> 'id'
    or p_event ->> 'shared_award_id' is distinct from p_evidence ->> 'shared_award_id'
    or p_event ->> 'shared_award_id' is distinct from p_candidate ->> 'shared_award_id'
    or p_event ->> 'shared_award_source_id' is distinct from p_evidence ->> 'shared_award_source_id'
    or p_event ->> 'shared_award_source_id' is distinct from p_candidate ->> 'shared_award_source_id'
    or p_event ->> 'source_url' is distinct from p_candidate ->> 'source_url'
    or coalesce(p_event ->> 'source_page_type', '') = 'pdf'
    or p_evidence ->> 'evidence_status' is distinct from 'not_applicable_source_html'
    or p_evidence ->> 'evidence_schema_version' is distinct from 'source-html-event-evidence-v1'
  then
    return false;
  end if;
  -- Publication's full source/semantic/candidate binding is the one authority.
  -- A malformed or missing candidate remains an explicit recovery failure.
  perform public.awardping_validate_source_html_evidence(
    p_evidence, p_candidate, p_event -> 'change_details'
  );
  return true;
exception when others then
  return false;
end;
$function$;
REVOKE ALL ON FUNCTION private.stage1_source_html_event_evidence_valid(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.stage1_published_capture_reference_graph_valid(p_capture jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_role text;
  v_value jsonb;
  v_state jsonb;
  v_selected_state jsonb;
  v_main_state jsonb;
  v_state_count bigint := 0;
  v_unique_state_count bigint := 0;
  v_main_state_count bigint := 0;
begin
  if pg_catalog.jsonb_typeof(p_capture) is distinct from 'object' then
    return false;
  end if;

  foreach v_role in array array[
    'full', 'metadata', 'crop', 'main_full', 'thumbnail', 'text', 'layout',
    'attestation'
  ] loop
    v_value := p_capture -> v_role;
    if v_value is not null
      and pg_catalog.jsonb_typeof(v_value) not in ('object', 'null') then
      return false;
    end if;
  end loop;

  if p_capture ? 'states'
    and pg_catalog.jsonb_typeof(p_capture -> 'states') not in ('array', 'null') then
    return false;
  end if;

  -- Source-only captures have no visual state or crop. Their separate typed
  -- contract must succeed before this graph can admit any references.
  if p_capture ->> 'kind' = 'source_html' then
    return private.awardping_source_html_capture_valid(p_capture) is true;
  end if;

  if p_capture ->> 'kind' = 'webpage' then
    if pg_catalog.jsonb_typeof(p_capture -> 'full') is distinct from 'object'
      or p_capture #>> array['full', 'content_type'] is distinct from 'image/jpeg'
      or pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'states') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_capture -> 'states') < 1 then
      return false;
    end if;
  elsif p_capture ->> 'kind' = 'pdf' then
    if pg_catalog.jsonb_typeof(p_capture -> 'full') is distinct from 'object'
      or p_capture #>> array['full', 'content_type'] is distinct from 'application/pdf'
      or pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') = 'object' then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array'
      and pg_catalog.jsonb_array_length(p_capture -> 'states') > 0 then
      return false;
    end if;
  elsif p_capture ->> 'kind' = 'first_observation_attestation' then
    if pg_catalog.jsonb_typeof(p_capture -> 'metadata') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'attestation') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'text') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'thumbnail') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
      or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array'
      and pg_catalog.jsonb_array_length(p_capture -> 'states') > 0 then
      return false;
    end if;
  else
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'states') = 'array' then
    select
      pg_catalog.count(*),
      pg_catalog.count(distinct state.value ->> 'state_id'),
      pg_catalog.count(*) filter (where state.value ->> 'kind' = 'main')
    into v_state_count, v_unique_state_count, v_main_state_count
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value);
    if v_state_count <> v_unique_state_count then
      return false;
    end if;
    for v_state in
      select state.value
      from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    loop
      if pg_catalog.jsonb_typeof(v_state) is distinct from 'object'
        or nullif(pg_catalog.btrim(v_state ->> 'state_id'), '') is null
        or v_state ->> 'state_id' !~ '^[A-Za-z0-9._-]+$'
        or v_state ->> 'kind' is null
        or v_state ->> 'kind' not in ('main', 'expansion_state') then
        return false;
      end if;
      foreach v_role in array array['image', 'geometry'] loop
        v_value := v_state -> v_role;
        if v_value is not null
          and pg_catalog.jsonb_typeof(v_value) not in ('object', 'null') then
          return false;
        end if;
      end loop;
      if p_capture ->> 'kind' = 'webpage'
        and (
          pg_catalog.jsonb_typeof(v_state -> 'image') is distinct from 'object'
          or pg_catalog.jsonb_typeof(v_state -> 'geometry') is distinct from 'object'
        ) then
        return false;
      end if;
    end loop;
  end if;

  if p_capture #>> array['full', 'content_type'] = 'image/jpeg' then
    if nullif(pg_catalog.btrim(p_capture ->> 'state_id'), '') is null
      or pg_catalog.jsonb_typeof(p_capture -> 'states') is distinct from 'array' then
      return false;
    end if;
    select state.value into v_selected_state
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    where state.value ->> 'state_id' = p_capture ->> 'state_id'
    limit 1;
    if v_selected_state is null
      or v_selected_state #>> array['image', 'object_key'] is distinct from
        p_capture #>> array['full', 'object_key']
      or v_selected_state #>> array['image', 'sha256'] is distinct from
        p_capture #>> array['full', 'sha256']
      or v_selected_state #>> array['image', 'byte_length'] is distinct from
        p_capture #>> array['full', 'byte_length']
      or v_selected_state #>> array['image', 'content_type'] is distinct from
        p_capture #>> array['full', 'content_type']
      or v_selected_state #>> array['image', 'width'] is distinct from
        p_capture #>> array['full', 'width']
      or v_selected_state #>> array['image', 'height'] is distinct from
        p_capture #>> array['full', 'height'] then
      return false;
    end if;

    if pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
      or pg_catalog.jsonb_typeof(v_selected_state -> 'geometry') = 'object' then
       if pg_catalog.jsonb_typeof(p_capture -> 'layout') is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_selected_state -> 'geometry') is distinct from 'object'
        or v_selected_state #>> array['geometry', 'object_key'] is distinct from
          p_capture #>> array['layout', 'object_key']
        or v_selected_state #>> array['geometry', 'sha256'] is distinct from
          p_capture #>> array['layout', 'sha256']
        or v_selected_state #>> array['geometry', 'byte_length'] is distinct from
          p_capture #>> array['layout', 'byte_length']
        or v_selected_state #>> array['geometry', 'content_type'] is distinct from
          p_capture #>> array['layout', 'content_type']
        or v_selected_state ->> 'geometry_hash' is distinct from
          p_capture #>> array['layout', 'geometry_hash'] then
        return false;
      end if;
    end if;
  elsif pg_catalog.jsonb_typeof(p_capture -> 'layout') = 'object'
    or pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object'
    or pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'main_full') = 'object' then
    if v_main_state_count <> 1 then
      return false;
    end if;
    select state.value into v_main_state
    from pg_catalog.jsonb_array_elements(p_capture -> 'states') state(value)
    where state.value ->> 'kind' = 'main'
    limit 1;
    if v_main_state #>> array['image', 'object_key'] is distinct from
        p_capture #>> array['main_full', 'object_key']
      or v_main_state #>> array['image', 'sha256'] is distinct from
        p_capture #>> array['main_full', 'sha256']
      or v_main_state #>> array['image', 'byte_length'] is distinct from
        p_capture #>> array['main_full', 'byte_length']
      or v_main_state #>> array['image', 'content_type'] is distinct from
        p_capture #>> array['main_full', 'content_type']
      or v_main_state #>> array['image', 'width'] is distinct from
        p_capture #>> array['main_full', 'width']
      or v_main_state #>> array['image', 'height'] is distinct from
        p_capture #>> array['main_full', 'height'] then
      return false;
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_capture -> 'crop') = 'object' then
    if p_capture #>> array['full', 'content_type'] is distinct from 'image/jpeg'
      or p_capture #>> array['crop', 'source_image_object_key'] is distinct from
        p_capture #>> array['full', 'object_key']
      or p_capture #>> array['crop', 'source_image_sha256'] is distinct from
        p_capture #>> array['full', 'sha256']
      or p_capture #>> array['crop', 'source_image_byte_length'] is distinct from
        p_capture #>> array['full', 'byte_length']
      or p_capture #>> array['crop', 'state_id'] is distinct from
        p_capture ->> 'state_id' then
      return false;
    end if;
  end if;
  return true;
exception when others then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_published_event_r2_reference_binding_valid(p_source_id uuid, p_candidate_id uuid, p_side_name text, p_logical_role text, p_state_id text, p_state_kind text, p_object_key text, p_sha256 text, p_hash_mode text, p_byte_length text, p_semantic_length text, p_content_type text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_prefix text;
  v_role text;
  v_extension text;
begin
  if p_source_id is not null
    or p_candidate_id is null
    or p_side_name is null
    or p_side_name not in ('previous', 'current')
    or nullif(pg_catalog.btrim(p_logical_role), '') is null
    or nullif(pg_catalog.btrim(p_object_key), '') is null
    or nullif(pg_catalog.btrim(p_content_type), '') is null
    or coalesce(p_object_key, '') ~* '(^|/)latest(/|$)'
    or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_byte_length, '') !~ '^[1-9][0-9]*$'
    or p_hash_mode is distinct from 'raw_sha256'
    or p_semantic_length is not null then
    return false;
  end if;
  v_prefix := 'visual-snapshots/published/' || p_candidate_id::text || '/' ||
    p_side_name || '/';

  case p_logical_role
    when 'full' then
      if p_content_type = 'application/pdf' then
        if p_state_id is not null or p_state_kind is not null then return false; end if;
        v_role := 'document';
        v_extension := 'pdf';
      elsif p_content_type = 'text/plain; charset=utf-8' then
        if p_state_id is not null or p_state_kind is not null then return false; end if;
        v_role := 'source-html';
        v_extension := 'txt';
      elsif p_content_type = 'image/jpeg'
        and p_state_kind in ('main', 'expansion_state')
        and coalesce(p_state_id, '') ~ '^[A-Za-z0-9._-]+$' then
        v_role := case
          when p_state_kind = 'main' then 'main-full'
          else pg_catalog.regexp_replace(
            pg_catalog.regexp_replace(
              'state-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
            ), '^-+|-+$', '', 'g'
          )
        end;
        v_extension := 'jpg';
      else return false;
      end if;
    when 'metadata' then
      if p_content_type is distinct from 'application/json; charset=utf-8'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_extension := 'json';
      if p_object_key = v_prefix || 'metadata/' || p_sha256 || '.json' then
        v_role := 'metadata';
      elsif p_object_key = v_prefix || 'recovery-metadata/' || p_sha256 || '.json' then
        v_role := 'recovery-metadata';
      elsif p_side_name = 'previous'
        and p_object_key = v_prefix || 'first-observation-attestation/' ||
          p_sha256 || '.json' then
        v_role := 'first-observation-attestation';
      else return false;
      end if;
    when 'crop' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'changed-section-crop';
      v_extension := 'jpg';
    when 'main_full' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_kind is distinct from 'main'
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := 'main-full';
      v_extension := 'jpg';
    when 'thumbnail' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'thumbnail';
      v_extension := 'jpg';
    when 'text' then
      if p_content_type is distinct from 'text/plain; charset=utf-8'
        or p_state_id is not null
        or p_state_kind is not null then return false; end if;
      v_role := 'text';
      v_extension := 'txt';
    when 'layout', 'state.geometry' then
      if p_content_type is distinct from 'application/json; charset=utf-8'
        or p_state_kind is null
        or p_state_kind not in ('main', 'expansion_state')
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          'geometry-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
        ), '^-+|-+$', '', 'g'
      );
      v_extension := 'json';
    when 'state.image', 'crop.source_image' then
      if p_content_type is distinct from 'image/jpeg'
        or p_state_kind is null
        or p_state_kind not in ('main', 'expansion_state')
        or coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$' then return false; end if;
      v_role := case
        when p_state_kind = 'main' then 'main-full'
        else pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            'state-' || p_state_id, '[^a-zA-Z0-9._-]', '-', 'g'
          ), '^-+|-+$', '', 'g'
        )
      end;
      v_extension := 'jpg';
    else return false;
  end case;

  if p_logical_role = 'metadata' then return true; end if;
  return coalesce(
    p_object_key = v_prefix || v_role || '/' || p_sha256 || '.' || v_extension,
    false
  );
exception when others then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_manifest_source_capture_binding_valid(p_source_id uuid, p_kind text, p_object_keys jsonb, p_hashes jsonb, p_metadata jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_max_safe_integer constant numeric := 9007199254740991;
  v_primary_key text;
  v_generation_prefix text;
  v_expansion_page_count integer := 0;
  v_expansion_layout_count integer := 0;
  v_layout_present boolean := false;
begin
  -- SOURCE_HTML_BRANCH_BEGIN: source-only proof cannot enter browser geometry.
  if p_metadata ->> 'capture_profile' = 'scrapling-source-html-v1'
    or p_metadata ? 'source_html'
    or p_metadata #>> '{retained_artifact_projection,schema}' = 'awardping.source-html-artifact-projection.v1'
  then
    declare
      v_record jsonb := p_metadata #> '{source_html,capture}';
      v_http jsonb := p_metadata #> '{source_html,capture,source_http}';
      v_slot text;
      v_binding jsonb;
      v_doc jsonb;
      v_expected_projection constant jsonb := '{"schema":"awardping.source-html-artifact-projection.v1","kind":"webpage","capture_profile":"scrapling-source-html-v1","acquisition":"ordinary_anonymous_http","visibility_verified":false,"screenshot_available":false,"artifact_slots":["html","meta","text"],"localization_status":"source_html_no_screenshot","authoritative":{"layout_retained":false,"layout_hash":null,"expansion_state_count":0}}'::jsonb;
    begin
      if p_source_id is null or p_kind is distinct from 'webpage'
        or pg_catalog.jsonb_typeof(p_object_keys) is distinct from 'object'
        or pg_catalog.jsonb_typeof(p_hashes) is distinct from 'object'
        or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
        or p_metadata ->> 'capture_profile' is distinct from 'scrapling-source-html-v1'
        or p_metadata ->> 'artifact_bindings_schema' is distinct from 'awardping.r2.capture-artifact-bindings.v1'
        or pg_catalog.jsonb_typeof(p_metadata -> 'artifact_bindings') is distinct from 'object'
        or not (p_object_keys ?& array['html','meta','text'])
        or p_object_keys - array['html','meta','text'] <> '{}'::jsonb
        or not ((p_metadata -> 'artifact_bindings') ?& array['html','meta','text'])
        or (p_metadata -> 'artifact_bindings') - array['html','meta','text'] <> '{}'::jsonb
        or p_metadata -> 'retained_artifact_projection' is distinct from v_expected_projection
        or pg_catalog.jsonb_typeof(p_metadata -> 'source_html') is distinct from 'object'
        or p_metadata #>> '{source_html,schema}' is distinct from 'awardping.source-html-evidence.v1'
        or (p_metadata -> 'source_html') - array['schema','capture'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(v_record) is distinct from 'object'
        or v_record ->> 'schema' is distinct from 'awardping.scrapling-capture.v1'
        or v_record ->> 'capture_profile' is distinct from 'scrapling-source-html-v1'
        or v_record ->> 'source_id' is distinct from p_source_id::text
        or v_record -> 'publishable' is distinct from 'false'::jsonb
        or v_record - array['schema','capture_profile','source_id','url','final_url','captured_at','status_code',
          'content_type','html_document','source_main_document','source_http','warnings','engine','integrity','publishable'] <> '{}'::jsonb
        or v_record -> 'status_code' is distinct from '200'::jsonb
        or p_metadata -> 'status_code' is distinct from '200'::jsonb
        or v_record ->> 'content_type' is distinct from p_metadata ->> 'content_type'
        or not coalesce(v_record ->> 'content_type' ~* '^(text/html|application/xhtml\+xml)(;|$)', false)
        or not coalesce(v_record ->> 'url' ~ '^https://[^/@:#[:space:]]+(/[^#[:space:]]*)?$', false)
        or v_record ->> 'url' is distinct from v_record ->> 'final_url'
        or v_record ->> 'final_url' is distinct from p_metadata ->> 'final_url'
        or not coalesce(v_record ->> 'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$', false)
        or not pg_catalog.isfinite((v_record ->> 'captured_at')::timestamptz)
        or p_metadata ?| array['page_bytes','thumb_bytes','file_bytes','expansion_state_count','expansion_state_screenshots',
          'expansion_state_failures','expansion_state_capture_coverage','localization','text_geometry','layout_hash','image_hash',
          'file_hash','browser','dimensions','screenshot','html_capture','page_readiness','page_settle','visible_html','visible_text']
      then return false; end if;

      if pg_catalog.jsonb_typeof(v_http) is distinct from 'object'
        or not (v_http ?& array['schema','method','response_complete','redirect_count','body_encoding','content_encoding',
          'body_byte_length','body_sha256','acquisition','visibility_verified','screenshot_available'])
        or v_http - array['schema','method','response_complete','redirect_count','body_encoding','content_encoding',
          'body_byte_length','body_sha256','acquisition','visibility_verified','screenshot_available'] <> '{}'::jsonb
        or v_http ->> 'schema' is distinct from 'awardping.scrapling-source-http.v1'
        or v_http ->> 'method' is distinct from 'GET'
        or v_http -> 'response_complete' is distinct from 'true'::jsonb
        or v_http -> 'redirect_count' is distinct from '0'::jsonb
        or v_http ->> 'body_encoding' is distinct from 'utf-8'
        or v_http ->> 'content_encoding' is distinct from 'identity'
        or v_http ->> 'acquisition' is distinct from 'ordinary_anonymous_http'
        or v_http -> 'visibility_verified' is distinct from 'false'::jsonb
        or v_http -> 'screenshot_available' is distinct from 'false'::jsonb
        or v_record -> 'engine' is distinct from '{"scrapling":"0.4.15","client":"Fetcher","adaptive":false,"stealth":false,"impersonation":false}'::jsonb
        or pg_catalog.jsonb_typeof(v_record -> 'warnings') is distinct from 'array'
        or not ((v_record -> 'warnings') @> '["source_html_only_not_browser_visible_or_screenshot_evidence","linked_documents_forms_and_client_loaded_content_not_fetched"]'::jsonb)
        or pg_catalog.jsonb_typeof(v_record -> 'integrity') is distinct from 'object'
        or (v_record -> 'integrity') - array['html_sha256','html_document_sha256','source_main_document_sha256','source_http_sha256','document_sha256','main_document_sha256'] <> '{}'::jsonb
      then return false; end if;
      foreach v_slot in array array['html_sha256','html_document_sha256','source_main_document_sha256','source_http_sha256','document_sha256','main_document_sha256'] loop
        if not coalesce(v_record -> 'integrity' ->> v_slot ~ '^[0-9a-f]{64}$', false) then return false; end if;
      end loop;
      foreach v_slot in array array['html_document','source_main_document'] loop
        v_doc := v_record -> v_slot;
        if pg_catalog.jsonb_typeof(v_doc) is distinct from 'object'
          or v_doc ->> 'schema' is distinct from 'awardping.scrapling-html-document.v1'
          or v_doc ->> 'scope' is distinct from (case v_slot when 'html_document' then 'html-source-main-document' else 'html-source-main-element' end)
          or v_doc ->> 'source_url' is distinct from v_record ->> 'url'
          or v_doc -> 'publishable' is distinct from 'false'::jsonb
          or v_doc -> 'visibility_verified' is distinct from 'false'::jsonb
          or pg_catalog.jsonb_typeof(v_doc -> 'title') is distinct from 'string'
          or pg_catalog.jsonb_typeof(v_doc -> 'text') is distinct from 'string'
          or pg_catalog.length(pg_catalog.btrim(v_doc ->> 'text')) < (case when v_slot = 'source_main_document' then 200 else 1 end)
          or pg_catalog.jsonb_typeof(v_doc -> 'blocks') is distinct from 'array'
          or pg_catalog.jsonb_array_length(v_doc -> 'blocks') not between 1 and 10000
          or pg_catalog.jsonb_typeof(v_doc -> 'links') is distinct from 'array'
          or pg_catalog.jsonb_typeof(v_doc -> 'base_hrefs') is distinct from 'array'
        then return false; end if;
      end loop;
      foreach v_slot in array array['text_hash','body_text_hash','main_content_hash'] loop
        if not coalesce(p_hashes ->> v_slot ~ '^[0-9a-f]{64}$', false)
          or p_hashes ->> v_slot is distinct from p_hashes ->> 'text_hash' then return false; end if;
      end loop;
      foreach v_slot in array array['image_hash','file_hash','layout_hash','nav_header_footer_hash','expansion_hash','expansion_states_hash'] loop
        if p_hashes -> v_slot is not null and p_hashes -> v_slot is distinct from 'null'::jsonb then return false; end if;
      end loop;
      if p_hashes ? 'capture_profile' and p_hashes ->> 'capture_profile' is distinct from 'scrapling-source-html-v1' then return false; end if;
      if p_hashes ? 'source_html_body_hash' and p_hashes ->> 'source_html_body_hash' is distinct from v_http ->> 'body_sha256' then return false; end if;
      foreach v_slot in array array['text_length','body_text_length','main_content_text_length','text_object_bytes'] loop
        if pg_catalog.jsonb_typeof(p_metadata -> v_slot) is distinct from 'number'
          or not coalesce(p_metadata ->> v_slot ~ '^[1-9][0-9]*$', false)
          or (p_metadata ->> v_slot)::numeric > 6291457 then return false; end if;
      end loop;
      if p_metadata -> 'body_text_length' is distinct from p_metadata -> 'text_length'
        or p_metadata -> 'main_content_text_length' is distinct from p_metadata -> 'text_length' then return false; end if;

      v_primary_key := p_object_keys ->> 'html';
      if not coalesce(v_primary_key ~ ('^visual-snapshots/sources/' || p_source_id::text || '/captures/[0-9a-f]{32}/page[.]html[.]txt$'), false) then return false; end if;
      v_generation_prefix := pg_catalog.left(v_primary_key, pg_catalog.length(v_primary_key) - pg_catalog.length('page.html.txt'));
      foreach v_slot in array array['html','meta','text'] loop
        v_binding := p_metadata -> 'artifact_bindings' -> v_slot;
        if pg_catalog.jsonb_typeof(v_binding) is distinct from 'object'
          or not (v_binding ?& array['sha256','byte_length','content_type','hash_mode'])
          or v_binding - array['sha256','byte_length','content_type','hash_mode'] <> '{}'::jsonb
          or not coalesce(v_binding ->> 'sha256' ~ '^[0-9a-f]{64}$', false)
          or pg_catalog.jsonb_typeof(v_binding -> 'byte_length') is distinct from 'number'
          or not coalesce(v_binding ->> 'byte_length' ~ '^[1-9][0-9]*$', false)
          or (v_binding ->> 'byte_length')::numeric > (case v_slot when 'html' then 5242880 when 'text' then 6291457 else 25165824 end)
          or v_binding ->> 'hash_mode' is distinct from 'raw_sha256'
          or v_binding ->> 'content_type' is distinct from (case v_slot when 'meta' then 'application/json; charset=utf-8' else 'text/plain; charset=utf-8' end)
          or pg_catalog.jsonb_typeof(p_object_keys -> v_slot) is distinct from 'string'
          or p_object_keys ->> v_slot is distinct from v_generation_prefix || (case v_slot when 'html' then 'page.html.txt' when 'meta' then 'meta.json' else 'text.txt' end)
        then return false; end if;
      end loop;
      return p_metadata #> '{artifact_bindings,html,byte_length}' is not distinct from v_http -> 'body_byte_length'
        and p_metadata #>> '{artifact_bindings,html,sha256}' is not distinct from v_http ->> 'body_sha256'
        and v_record #>> '{integrity,html_sha256}' is not distinct from v_http ->> 'body_sha256'
        and p_metadata #> '{artifact_bindings,text,byte_length}' is not distinct from p_metadata -> 'text_object_bytes';
    exception when others then return false;
    end;
  end if;
  -- SOURCE_HTML_BRANCH_END. Browser/PDF validation below is unchanged.
  if p_source_id is null
    or pg_catalog.jsonb_typeof(p_object_keys) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_hashes) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
    or p_metadata ->> 'artifact_bindings_schema' is distinct from
      'awardping.r2.capture-artifact-bindings.v1'
    or pg_catalog.jsonb_typeof(p_metadata -> 'artifact_bindings')
      is distinct from 'object'
    or pg_catalog.jsonb_typeof(
      p_metadata -> 'retained_artifact_projection'
    ) is distinct from 'object'
    or p_metadata #>> '{retained_artifact_projection,schema}' is distinct from
      'awardping.capture-retained-artifact-projection.v1'
    or p_metadata #>> '{retained_artifact_projection,kind}' is distinct from
      p_kind
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative}'
    ) is distinct from 'object'
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
    ) is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(
      p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
    ) is distinct from 'number'
    or coalesce(p_metadata #>>
      '{retained_artifact_projection,authoritative,expansion_state_count}', ''
    ) !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(
        p_metadata #> '{retained_artifact_projection,authoritative,expansion_state_count}'
      ) = 'number'
        then (p_metadata #>>
          '{retained_artifact_projection,authoritative,expansion_state_count}'
        )::numeric > v_max_safe_integer
      else false
    end)
    or not private.stage1_expansion_capture_coverage_valid(
      p_kind, p_metadata
    )
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes') = 'number'
        then (p_metadata ->> 'text_object_bytes')::numeric > v_max_safe_integer
      else false
    end)
    or pg_catalog.jsonb_typeof(p_metadata -> 'text_length')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_length') = 'number'
        then (p_metadata ->> 'text_length')::numeric > v_max_safe_integer
      else false
    end)
  then
    return false;
  end if;

  -- The artifact map is exact: it has neither missing nor additional slots.
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) object_slot(slot_name)
    where not ((p_metadata -> 'artifact_bindings') ? object_slot.slot_name)
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(
      p_metadata -> 'artifact_bindings'
    ) binding_slot(slot_name)
    where not (p_object_keys ? binding_slot.slot_name)
  ) then
    return false;
  end if;

  -- Every binding has exactly four typed fields and hashes the retained raw
  -- bytes. Content type is part of the signed contract, not inferred by R2.
  if exists (
    select 1
    from pg_catalog.jsonb_each(
      p_metadata -> 'artifact_bindings'
    ) binding(slot_name, value)
    where pg_catalog.jsonb_typeof(binding.value) is distinct from 'object'
      or not (binding.value ?& array[
        'sha256', 'byte_length', 'content_type', 'hash_mode'
      ])
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(
          case
            when pg_catalog.jsonb_typeof(binding.value) = 'object'
              then binding.value
            else '{}'::jsonb
          end
        ) binding_field(field_name)
      ) <> 4
      or pg_catalog.jsonb_typeof(binding.value -> 'sha256')
        is distinct from 'string'
      or coalesce(binding.value ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(binding.value -> 'byte_length')
        is distinct from 'number'
      or coalesce(binding.value ->> 'byte_length', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(binding.value -> 'byte_length') = 'number'
          then (binding.value ->> 'byte_length')::numeric > v_max_safe_integer
        else false
      end)
      or pg_catalog.jsonb_typeof(binding.value -> 'content_type')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(binding.value -> 'hash_mode')
        is distinct from 'string'
      or binding.value ->> 'hash_mode' is distinct from 'raw_sha256'
      or binding.value ->> 'content_type' is distinct from case
        when binding.slot_name in ('page', 'thumb')
          or binding.slot_name ~ '^expansion_state_[0-9]{2}$'
          then 'image/jpeg'
        when binding.slot_name = 'pdf' then 'application/pdf'
        when binding.slot_name = 'text' then 'text/plain; charset=utf-8'
        when binding.slot_name in ('layout', 'meta')
          or binding.slot_name ~ '^expansion_state_[0-9]{2}_layout$'
          then 'application/json; charset=utf-8'
        else null
      end
  ) then
    return false;
  end if;

  if p_kind = 'webpage' then
    v_primary_key := p_object_keys ->> 'page';
    if coalesce(v_primary_key, '') !~ (
      '^visual-snapshots/sources/' || p_source_id::text ||
      '/captures/[0-9a-f]{32}/page[.]jpg$'
    )
      or not (p_object_keys ?& array['page', 'thumb', 'text', 'meta'])
      or p_object_keys ? 'pdf'
      or coalesce(p_hashes ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_hashes ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(p_metadata -> 'page_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'page_bytes') = 'number'
          then (p_metadata ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'thumb_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes') = 'number'
          then (p_metadata ->> 'thumb_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or p_metadata #>> '{artifact_bindings,page,sha256}'
        is distinct from p_hashes ->> 'image_hash'
      or p_metadata #>> '{artifact_bindings,page,byte_length}'
        is distinct from p_metadata ->> 'page_bytes'
      or p_metadata #>> '{artifact_bindings,thumb,byte_length}'
        is distinct from p_metadata ->> 'thumb_bytes'
    then
      return false;
    end if;
    v_generation_prefix := pg_catalog.left(
      v_primary_key,
      pg_catalog.length(v_primary_key) - pg_catalog.length('page.jpg')
    );
  elsif p_kind = 'pdf' then
    v_primary_key := p_object_keys ->> 'pdf';
    if coalesce(v_primary_key, '') !~ (
      '^visual-snapshots/sources/' || p_source_id::text ||
      '/captures/[0-9a-f]{32}/document[.]pdf$'
    )
      or not (p_object_keys ?& array['pdf', 'text', 'meta'])
      or p_object_keys ?| array['page', 'thumb', 'layout']
      or exists (
        select 1
        from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
        where slot.slot_name ~ '^expansion_state_'
      )
      or coalesce(p_hashes ->> 'file_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_hashes ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(p_metadata -> 'file_bytes')
        is distinct from 'number'
      or coalesce(p_metadata ->> 'file_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'file_bytes') = 'number'
          then (p_metadata ->> 'file_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or p_metadata #>> '{artifact_bindings,pdf,sha256}'
        is distinct from p_hashes ->> 'file_hash'
      or p_metadata #>> '{artifact_bindings,pdf,byte_length}'
        is distinct from p_metadata ->> 'file_bytes'
    then
      return false;
    end if;
    v_generation_prefix := pg_catalog.left(
      v_primary_key,
      pg_catalog.length(v_primary_key) - pg_catalog.length('document.pdf')
    );
  else
    return false;
  end if;

  if p_object_keys ->> 'text' is distinct from
      (v_generation_prefix || 'text.txt')
    or p_metadata #>> '{artifact_bindings,text,byte_length}'
      is distinct from p_metadata ->> 'text_object_bytes'
  then
    return false;
  end if;

  -- Every object remains under the one immutable source/generation prefix and
  -- has the exact kind-aware filename for its slot.
  if exists (
    select 1
    from pg_catalog.jsonb_each(p_object_keys) object_entry(slot_name, value)
    where pg_catalog.jsonb_typeof(object_entry.value) is distinct from 'string'
      or pg_catalog.left(
        object_entry.value #>> '{}',
        pg_catalog.length(v_generation_prefix)
      ) is distinct from v_generation_prefix
      or object_entry.value #>> '{}' ~* '(^|/)(latest|previous)(/|$)'
      or object_entry.value #>> '{}' ~ '[\\]'
      or object_entry.value #>> '{}' ~ '(^|/)[.][.](/|$)'
      or (case
        when object_entry.slot_name = 'page' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'page.jpg'
        when object_entry.slot_name = 'thumb' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'thumb.jpg'
        when object_entry.slot_name = 'pdf' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'document.pdf'
        when object_entry.slot_name = 'text' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'text.txt'
        when object_entry.slot_name = 'layout' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'layout.json'
        when object_entry.slot_name = 'meta' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'meta.json'
        when object_entry.slot_name ~ '^expansion_state_[0-9]{2}$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.slot_name, '[0-9]{2}$') || '.jpg'
        when object_entry.slot_name ~ '^expansion_state_[0-9]{2}_layout$' then
          object_entry.value #>> '{}' is distinct from
            v_generation_prefix || 'expansion-state-' ||
            pg_catalog.substring(object_entry.slot_name, '[0-9]{2}') ||
            '-layout.json'
        else true
      end)
  ) then
    return false;
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_each_text(p_object_keys) object_entry
  ) <> (
    select pg_catalog.count(distinct object_entry.value)
    from pg_catalog.jsonb_each_text(p_object_keys) object_entry
  ) then
    return false;
  end if;

  if p_kind = 'pdf' then
    if p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'not_applicable_pdf'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'false'::jsonb
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from 'null'::jsonb
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from '0'
    then
      return false;
    end if;
    return true;
  end if;

  select pg_catalog.count(*)::integer
  into v_expansion_page_count
  from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
  where slot.slot_name ~ '^expansion_state_[0-9]{2}$';

  select pg_catalog.count(*)::integer
  into v_expansion_layout_count
  from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
  where slot.slot_name ~ '^expansion_state_[0-9]{2}_layout$';

  if v_expansion_page_count <> v_expansion_layout_count
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count')
      is distinct from 'number'
    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count') = 'number'
        then (p_metadata ->> 'expansion_state_count')::numeric > v_max_safe_integer
      else false
    end)
    or pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_screenshots')
      is distinct from 'array'
  then
    return false;
  end if;

  if p_metadata ->> 'expansion_state_count' is distinct from
      v_expansion_page_count::text
    or pg_catalog.jsonb_array_length(
      p_metadata -> 'expansion_state_screenshots'
    ) <> v_expansion_page_count
  then
    return false;
  end if;

  -- Pair every expanded screenshot with its layout and require 01..N without
  -- gaps. JSON object keys are unique, so membership in that range plus count
  -- equality proves contiguity.
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
    where slot.slot_name ~ '^expansion_state_[0-9]{2}$'
      and (
        not (p_object_keys ? (slot.slot_name || '_layout'))
        or pg_catalog.substring(slot.slot_name, '[0-9]{2}$')::integer < 1
        or pg_catalog.substring(slot.slot_name, '[0-9]{2}$')::integer
          > v_expansion_page_count
      )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_object_keys) slot(slot_name)
    where slot.slot_name ~ '^expansion_state_[0-9]{2}_layout$'
      and not (
        p_object_keys ? pg_catalog.regexp_replace(slot.slot_name, '_layout$', '')
      )
  ) then
    return false;
  end if;

  -- Expansion metadata binds each screenshot to its image hash and byte length,
  -- and each layout to its geometry hash. Every retained object also carries
  -- its own independent raw-byte artifact binding above.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_metadata -> 'expansion_state_screenshots'
    ) with ordinality state(value, array_index)
    cross join lateral (
      select pg_catalog.lpad(state.array_index::text, 2, '0') as suffix
    ) expected
    where pg_catalog.jsonb_typeof(state.value) is distinct from 'object'
      or state.value ->> 'state_id' is distinct from
        ('expansion-state-' || expected.suffix)
      or coalesce(state.value ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(state.value ->> 'layout_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(state.value ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(state.value -> 'page_bytes')
        is distinct from 'number'
      or coalesce(state.value ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'page_bytes') = 'number'
          then (state.value ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)
      or pg_catalog.jsonb_typeof(state.value -> 'text_length')
        is distinct from 'number'
      or coalesce(state.value ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'text_length') = 'number'
          then (state.value ->> 'text_length')::numeric > v_max_safe_integer
        else false
      end)
      or state.value #>> '{text_geometry,geometry_hash}'
        is distinct from state.value ->> 'layout_hash'
      or state.value #>> '{text_geometry,screenshot,image_hash}'
        is distinct from state.value ->> 'image_hash'
      or p_metadata #>> array[
        'artifact_bindings',
        'expansion_state_' || expected.suffix,
        'sha256'
      ] is distinct from state.value ->> 'image_hash'
      or p_metadata #>> array[
        'artifact_bindings',
        'expansion_state_' || expected.suffix,
        'byte_length'
      ] is distinct from state.value ->> 'page_bytes'
  ) then
    return false;
  end if;

  v_layout_present := p_object_keys ? 'layout';
  if v_layout_present then
    if coalesce(p_hashes ->> 'layout_hash', '') !~ '^[0-9a-f]{64}$'
      or p_metadata ->> 'layout_hash' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{text_geometry,geometry_hash}' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{text_geometry,screenshot,image_hash}' is distinct from
        p_hashes ->> 'image_hash'
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')
        is distinct from 'object'
      or p_metadata #>> '{localization,status}' is distinct from 'geometry_ready'
      or p_metadata #> '{localization,geometry_ready}' is distinct from
        'true'::jsonb
      or p_metadata #> '{localization,accounted_for}' is distinct from
        'true'::jsonb
      or nullif(pg_catalog.btrim(
        coalesce(p_metadata #>> '{localization,unavailable_reason}', '')
      ), '') is not null
      or p_metadata #>> '{localization,geometry_hash}' is distinct from
        p_hashes ->> 'layout_hash'
      or p_metadata #>> '{localization,bound_image_hash}' is distinct from
        p_hashes ->> 'image_hash'
      or p_metadata #>> '{localization,semantic_crop_contract}' is distinct from
        'visual-exact-text-binding-v2'
      or p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'exact_geometry_available'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'true'::jsonb
      or p_metadata #>> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from p_hashes ->> 'layout_hash'
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from v_expansion_page_count::text
    then
      return false;
    end if;
  else
    -- A missing main layout is accepted only as explicit, non-contradictory
    -- unavailability. Main-capture geometry/hash claims remain forbidden, but
    -- complete expansion screenshot/layout pairs retain independent authority.
    if nullif(pg_catalog.btrim(coalesce(p_hashes ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(p_metadata ->> 'layout_hash', '')), '')
        is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,geometry_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,file}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_ref}', ''
      )), '') is not null
      or (
        p_metadata #> '{text_geometry,node_count}' is not null
        and p_metadata #> '{text_geometry,node_count}' is distinct from
          'null'::jsonb
        and p_metadata #> '{text_geometry,node_count}' <> '0'::jsonb
      )
      or (
        p_metadata #> '{text_geometry,run_count}' is not null
        and p_metadata #> '{text_geometry,run_count}' is distinct from
          'null'::jsonb
        and p_metadata #> '{text_geometry,run_count}' <> '0'::jsonb
      )
      or (
        p_metadata ? 'text_geometry'
        and pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry')
          not in ('object', 'null')
      )
      or (
        pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry') = 'object'
        and not coalesce((
          p_metadata #>> '{text_geometry,status}' = 'unavailable'
          or p_metadata #>> '{text_geometry,status}' ~ '^unavailable_'
        ), false)
      )
      or (
        pg_catalog.jsonb_typeof(p_metadata -> 'text_geometry') = 'object'
        and nullif(pg_catalog.btrim(coalesce(
          p_metadata #>> '{text_geometry,unavailable_reason}', ''
        )), '') is null
      )
      or (
        nullif(pg_catalog.btrim(coalesce(
          p_metadata #>> '{text_geometry,availability_status}', ''
        )), '') is not null
        and not coalesce((
          p_metadata #>> '{text_geometry,availability_status}' = 'unavailable'
          or p_metadata #>> '{text_geometry,availability_status}' ~
            '^unavailable_'
        ), false)
      )
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')
        is distinct from 'object'
      or not coalesce((
        p_metadata #>> '{localization,status}' = 'unavailable'
        or p_metadata #>> '{localization,status}' ~ '^unavailable_'
        or p_metadata #>> '{localization,status}' =
          'capture_layout_unavailable'
        or p_metadata #>> '{localization,status}' =
          'evidence_only_geometry_unavailable'
      ), false)
      or p_metadata #> '{localization,exact}' is distinct from
        'false'::jsonb
      or p_metadata #> '{localization,geometry_ready}' is distinct from
        'false'::jsonb
      or p_metadata #> '{localization,accounted_for}' is distinct from
        'true'::jsonb
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,unavailable_reason}', ''
      )), '') is null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,geometry_hash}', ''
      )), '') is not null
      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,bound_image_hash}', ''
      )), '') is not null
      or p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'evidence_only_geometry_unavailable'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'false'::jsonb
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from 'null'::jsonb
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from v_expansion_page_count::text
    then
      return false;
    end if;
  end if;

  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_visual_r2_object_set_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with stage1_events as (
    select
      evidence.*,
      event.id as published_change_event_id,
      event.visual_review_candidate_id as published_candidate_id,
      event.suppressed_at is not null as event_suppressed,
      evidence.visual_review_candidate_id is distinct from
        event.visual_review_candidate_id as candidate_binding_invalid,
      case when
        evidence.evidence_status = 'not_applicable_source_html'
        or evidence.evidence_schema_version = 'source-html-event-evidence-v1'
        or evidence.previous_capture ->> 'kind' = 'source_html'
        or evidence.current_capture ->> 'kind' = 'source_html'
        or evidence.previous_capture ->> 'capture_profile' = 'scrapling-source-html-v1'
        or evidence.current_capture ->> 'capture_profile' = 'scrapling-source-html-v1'
      then private.stage1_source_html_event_evidence_valid(
        pg_catalog.to_jsonb(event), pg_catalog.to_jsonb(evidence),
        pg_catalog.to_jsonb(candidate)
      ) is not true else false end as source_html_binding_invalid
    from public.shared_award_change_event_visual_evidence evidence
    join public.shared_award_change_events event
      on event.id = evidence.change_event_id
    left join public.shared_award_visual_review_candidates candidate
      on candidate.id = event.visual_review_candidate_id
    -- Candidate-free historical_artifact_unrecoverable rows truthfully carry
    -- no R2 objects.  Crop coverage/quarantine retains that limitation; this
    -- manifest verifies only reference-bearing evidence.
    where evidence.visual_review_candidate_id is not null
      and exists (
      select 1
      from public.stage1_award_members member
      where member.shared_award_id = event.shared_award_id
    )
  ), event_sides as (
    select
      event.bucket,
      event.published_change_event_id as change_event_id,
      event.published_candidate_id as candidate_id,
      event.event_suppressed,
      event.candidate_binding_invalid,
      event.source_html_binding_invalid,
      side.side_name,
      side.capture,
      side.capture ->> 'state_id' as selected_state_id,
      (
        select state.value ->> 'kind'
        from pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
              then side.capture -> 'states'
            else '[]'::jsonb
          end
        ) state(value)
        where state.value ->> 'state_id' = side.capture ->> 'state_id'
        limit 1
      ) as selected_state_kind,
      (
        select state.value ->> 'state_id'
        from pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
              then side.capture -> 'states'
            else '[]'::jsonb
          end
        ) state(value)
        where state.value ->> 'kind' = 'main'
        limit 1
      ) as main_state_id
    from stage1_events event
    cross join lateral (values
      ('previous'::text, event.previous_capture),
      ('current'::text, event.current_capture)
    ) side(side_name, capture)
  ), event_fixed_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      reference.logical_role,
      reference.logical_path,
      reference.state_id,
      reference.state_kind,
      side.event_suppressed,
      reference.value ->> 'object_key' as object_key,
      reference.value ->> 'sha256' as sha256,
      'raw_sha256'::text as hash_mode,
      reference.value ->> 'byte_length' as byte_length,
      null::text as semantic_length,
      reference.value ->> 'content_type' as content_type,
      reference.value ->> 'width' as width,
      reference.value ->> 'height' as height,
      reference.value ->> 'geometry_hash' as geometry_hash,
      pg_catalog.jsonb_typeof(reference.value) = 'object'
        and reference.value ? 'object_key' as reference_key_present
    from event_sides side
    cross join lateral (values
      ('full'::text, '$.full.object_key'::text, side.capture -> 'full',
        case
          when side.capture #>> array['full', 'content_type'] = 'application/pdf'
            or side.capture ->> 'kind' = 'source_html'
            then null::text
          else side.selected_state_id
        end,
        case
          when side.capture #>> array['full', 'content_type'] = 'application/pdf'
            or side.capture ->> 'kind' = 'source_html'
            then null::text
          else side.selected_state_kind
        end),
      ('metadata'::text, '$.metadata.object_key'::text,
        side.capture -> 'metadata', null::text, null::text),
      ('crop'::text, '$.crop.object_key'::text, side.capture -> 'crop',
        null::text, null::text),
      ('main_full'::text, '$.main_full.object_key'::text,
        side.capture -> 'main_full', side.main_state_id, 'main'::text),
      ('thumbnail'::text, '$.thumbnail.object_key'::text,
        side.capture -> 'thumbnail', null::text, null::text),
      ('text'::text, '$.text.object_key'::text, side.capture -> 'text',
        null::text, null::text),
      ('layout'::text, '$.layout.object_key'::text, side.capture -> 'layout',
        side.selected_state_id, side.selected_state_kind)
    ) reference(logical_role, logical_path, value, state_id, state_kind)
    where reference.value is not null
      and pg_catalog.jsonb_typeof(reference.value) is distinct from 'null'
  ), event_state_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      reference.logical_role,
      pg_catalog.format(
        '$.states[%s].%s.object_key', state.ordinality - 1, reference.slot_name
      ) as logical_path,
      state.value ->> 'state_id' as state_id,
      state.value ->> 'kind' as state_kind,
      side.event_suppressed,
      reference.value ->> 'object_key' as object_key,
      reference.value ->> 'sha256' as sha256,
      'raw_sha256'::text as hash_mode,
      reference.value ->> 'byte_length' as byte_length,
      null::text as semantic_length,
      reference.value ->> 'content_type' as content_type,
      reference.value ->> 'width' as width,
      reference.value ->> 'height' as height,
      case
        when reference.slot_name = 'geometry' then state.value ->> 'geometry_hash'
        else null
      end as geometry_hash,
      pg_catalog.jsonb_typeof(reference.value) = 'object'
        and reference.value ? 'object_key' as reference_key_present
    from event_sides side
    cross join lateral pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(side.capture -> 'states') = 'array'
          then side.capture -> 'states'
        else '[]'::jsonb
      end
    ) with ordinality state(value, ordinality)
    cross join lateral (values
      ('state.image'::text, 'image'::text, state.value -> 'image'),
      ('state.geometry'::text, 'geometry'::text, state.value -> 'geometry')
    ) reference(logical_role, slot_name, value)
    where reference.value is not null
      and pg_catalog.jsonb_typeof(reference.value) is distinct from 'null'
  ), event_crop_source_references as (
    select
      side.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      side.change_event_id,
      side.candidate_id,
      side.side_name,
      'crop.source_image'::text as logical_role,
      '$.crop.source_image_object_key'::text as logical_path,
      side.selected_state_id as state_id,
      side.selected_state_kind as state_kind,
      side.event_suppressed,
      side.capture #>> array['crop', 'source_image_object_key'] as object_key,
      side.capture #>> array['crop', 'source_image_sha256'] as sha256,
      'raw_sha256'::text as hash_mode,
      side.capture #>> array['crop', 'source_image_byte_length'] as byte_length,
      null::text as semantic_length,
      'image/jpeg'::text as content_type,
      null::text as width,
      null::text as height,
      null::text as geometry_hash,
      side.capture -> 'crop' ? 'source_image_object_key' as reference_key_present
    from event_sides side
    where pg_catalog.jsonb_typeof(side.capture -> 'crop') = 'object'
      and side.capture -> 'crop' ?| array[
        'source_image_object_key', 'source_image_sha256',
        'source_image_byte_length'
      ]
  ), event_reference_rows as (
    select * from event_fixed_references
    union all
    select * from event_state_references
    union all
    select * from event_crop_source_references
  ), event_side_quality as (
    select
      pg_catalog.count(*) filter (
        where side.candidate_binding_invalid or side.source_html_binding_invalid
      ) as candidate_binding_error_count,
      pg_catalog.count(*) filter (
        where private.stage1_published_capture_reference_graph_valid(
          side.capture
        ) is not true
      ) as capture_alias_error_count,
      coalesce(pg_catalog.sum(
        private.stage1_jsonb_r2_reference_key_count(side.capture)
      ), 0) as recursive_reference_key_count
    from event_sides side
  ), event_reference_quality as (
    select
      pg_catalog.count(*) as logical_reference_count,
      pg_catalog.count(*) filter (where reference.event_suppressed)
        as suppressed_reference_count,
      pg_catalog.count(*) filter (where not reference.event_suppressed)
        as unsuppressed_reference_count,
      pg_catalog.count(*) filter (where reference.reference_key_present)
        as classified_reference_key_count,
      pg_catalog.count(*) filter (
        where private.stage1_published_event_r2_reference_binding_valid(
          reference.source_id,
          reference.candidate_id,
          reference.side_name,
          reference.logical_role,
          reference.state_id,
          reference.state_kind,
          reference.object_key,
          reference.sha256,
          reference.hash_mode,
          reference.byte_length,
          reference.semantic_length,
          reference.content_type
        ) is not true
      ) as reference_binding_error_count
    from event_reference_rows reference
  ), state_role_collisions as (
    select
      reference.candidate_id,
      reference.side_name,
      reference.logical_role,
      pg_catalog.split_part(reference.object_key, '/', 5) as storage_role
    from event_reference_rows reference
    where reference.logical_role in ('state.image', 'state.geometry')
      and nullif(pg_catalog.btrim(reference.object_key), '') is not null
    group by
      reference.candidate_id,
      reference.side_name,
      reference.logical_role,
      pg_catalog.split_part(reference.object_key, '/', 5)
    having pg_catalog.count(distinct reference.state_id) > 1
  ), state_role_quality as (
    select pg_catalog.count(*) as collision_count
    from state_role_collisions
  ), event_physical_groups as (
    select
      reference.bucket,
      reference.object_key,
      pg_catalog.min(reference.candidate_id::text)::uuid as candidate_id,
      pg_catalog.min(reference.side_name) as side_name,
      pg_catalog.split_part(reference.object_key, '/', 5) as artifact_name,
      pg_catalog.min(reference.sha256) as sha256,
      pg_catalog.min(reference.hash_mode) as hash_mode,
      pg_catalog.min(reference.byte_length) as byte_length,
      pg_catalog.min(reference.semantic_length) as semantic_length,
      pg_catalog.min(reference.content_type) as content_type,
      pg_catalog.count(*) as reference_count,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'scope', reference.object_scope,
          'change_event_id', reference.change_event_id,
          'source_id', reference.source_id,
          'candidate_id', reference.candidate_id,
          'side', reference.side_name,
          'role', reference.logical_role,
          'logical_path', reference.logical_path,
          'state_id', reference.state_id,
          'state_kind', reference.state_kind,
          'suppressed', reference.event_suppressed
        ) order by
          reference.change_event_id,
          reference.side_name,
          reference.logical_path,
          reference.logical_role,
          reference.state_id
      ) as references,
      (
        pg_catalog.count(distinct reference.candidate_id) <> 1
        or pg_catalog.count(distinct reference.side_name) <> 1
        or pg_catalog.count(distinct reference.sha256) <> 1
        or pg_catalog.count(distinct reference.hash_mode) <> 1
        or pg_catalog.count(distinct reference.byte_length) <> 1
        or pg_catalog.count(distinct reference.semantic_length) filter (
          where reference.semantic_length is not null
        ) > 1
        or pg_catalog.count(distinct reference.content_type) <> 1
        or pg_catalog.count(distinct reference.width) filter (
          where reference.width is not null
        ) > 1
        or pg_catalog.count(distinct reference.height) filter (
          where reference.height is not null
        ) > 1
        or pg_catalog.count(distinct reference.geometry_hash) filter (
          where reference.geometry_hash is not null
        ) > 1
      ) as descriptor_conflict
    from event_reference_rows reference
    where nullif(pg_catalog.btrim(reference.object_key), '') is not null
    group by reference.bucket, reference.object_key
  ), event_alias_quality as (
    select
      pg_catalog.count(*) filter (where physical.descriptor_conflict)
        as inconsistent_alias_count,
      pg_catalog.count(*) filter (where physical.reference_count > 1)
        as aliased_object_count
    from event_physical_groups physical
  ), event_object_rows as (
    select
      physical.bucket,
      'published_event'::text as object_scope,
      null::uuid as source_id,
      physical.candidate_id,
      physical.side_name,
      physical.artifact_name,
      physical.object_key,
      physical.sha256,
      physical.hash_mode,
      physical.byte_length,
      physical.semantic_length,
      physical.content_type,
      physical.reference_count,
      physical.references,
      null::text as capture_profile,
      null::jsonb as retained_artifact_projection
    from event_physical_groups physical
  ), manifest_bindings as (
    select distinct
      manifest.cohort_key,
      source_id,
      source.id is not null
        and exists (
          select 1
          from public.stage1_award_members member
          where member.cohort_key = manifest.cohort_key
            and member.shared_award_id = source.shared_award_id
        )
        and snapshot.shared_award_source_id is not null
        and snapshot.shared_award_id = source.shared_award_id
        and snapshot.source_url = source.url
        and case when snapshot.latest_metadata ->> 'capture_profile' = 'scrapling-source-html-v1' then
          snapshot.latest_metadata #>> '{source_html,capture,url}' = source.url
          and snapshot.latest_metadata #>> '{source_html,capture,final_url}' = source.url
          and private.stage1_safe_timestamptz(
            snapshot.latest_metadata #>> '{source_html,capture,captured_at}'
          ) = snapshot.latest_captured_at
        else true end
        and manifest.evidence #>> array[
          'source_bindings', source_id::text, 'source_url'
        ] = source.url
        and private.stage1_safe_timestamptz(
          manifest.evidence #>> array[
            'source_bindings', source_id::text, 'captured_at'
          ]
        ) = snapshot.latest_captured_at
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'object_keys'
        ] = snapshot.latest_object_keys
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'hashes'
        ] = snapshot.latest_hashes
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'metadata'
        ] = snapshot.latest_metadata
        and manifest.evidence #> array[
          'source_bindings', source_id::text, 'r2_hashes'
        ] = snapshot.latest_hashes
        and private.stage1_manifest_source_capture_binding_valid(
          source_id,
          snapshot.kind,
          snapshot.latest_object_keys,
          snapshot.latest_hashes,
          snapshot.latest_metadata
        ) as binding_valid,
      snapshot.bucket,
      snapshot.kind,
      snapshot.latest_object_keys as object_keys,
      snapshot.latest_metadata as metadata
    from public.stage1_award_source_manifest manifest
    cross join pg_catalog.unnest(manifest.source_ids) source_id
    left join public.shared_award_sources source
      on source.id = source_id
    left join public.shared_award_source_visual_snapshots snapshot
      on snapshot.shared_award_source_id = source_id
  ), manifest_binding_quality as (
    select pg_catalog.count(*) filter (where binding_valid is not true)
      as error_count
    from manifest_bindings
  ), manifest_sources as (
    select distinct source_id, bucket, kind, object_keys, metadata
    from manifest_bindings
    where binding_valid
  ), manifest_object_rows as (
    select
      source.bucket,
      'manifest_source'::text as object_scope,
      source.source_id,
      null::uuid as candidate_id,
      'current'::text as side_name,
      artifact.artifact_name,
      artifact.object_key,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'sha256'
      ] as sha256,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'hash_mode'
      ] as hash_mode,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'byte_length'
      ] as byte_length,
      null::text as semantic_length,
      source.metadata #>> array[
        'artifact_bindings', artifact.artifact_name, 'content_type'
      ] as content_type,
      1::bigint as reference_count,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'scope', 'manifest_source',
        'change_event_id', null,
        'source_id', source.source_id,
        'candidate_id', null,
        'side', 'current',
        'role', artifact.artifact_name,
        'logical_path', '$.object_keys.' || artifact.artifact_name,
        'state_id', null,
        'state_kind', null,
        'suppressed', null
      )) as references,
      source.metadata ->> 'capture_profile' as capture_profile,
      source.metadata -> 'retained_artifact_projection' as retained_artifact_projection
    from manifest_sources source
    cross join lateral pg_catalog.jsonb_each_text(source.object_keys)
      artifact(artifact_name, object_key)
  ), object_rows as (
    select * from event_object_rows
    union all
    select * from manifest_object_rows
  ), duplicate_object_keys as (
    select object_row.bucket, object_row.object_key
    from object_rows object_row
    where nullif(pg_catalog.btrim(object_row.object_key), '') is not null
    group by object_row.bucket, object_row.object_key
    having pg_catalog.count(*) > 1
  ), object_key_quality as (
    select pg_catalog.count(*) as duplicate_object_key_count
    from duplicate_object_keys
  ), object_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', object_row.bucket,
          'scope', object_row.object_scope,
          'source_id', object_row.source_id,
          'candidate_id', object_row.candidate_id,
          'side', object_row.side_name,
          'storage_role', object_row.artifact_name,
          'object_key', object_row.object_key,
          'sha256', object_row.sha256,
          'hash_mode', object_row.hash_mode,
          'byte_length', object_row.byte_length,
          'semantic_length', object_row.semantic_length,
          'content_type', object_row.content_type,
          'reference_count', object_row.reference_count,
          'references', object_row.references
        ) || case when object_row.object_scope = 'manifest_source'
          and object_row.capture_profile = 'scrapling-source-html-v1' then
          pg_catalog.jsonb_build_object(
            'capture_profile', object_row.capture_profile,
            'retained_artifact_projection', object_row.retained_artifact_projection
          )
        else '{}'::jsonb end order by
          object_row.object_scope,
          object_row.bucket,
          object_row.source_id,
          object_row.candidate_id,
          object_row.object_key
      ),
      '[]'::jsonb
    ) as value
    from object_rows object_row
  ), reference_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bucket', object_row.bucket,
          'object_key', object_row.object_key,
          'reference', reference.value
        ) order by
          object_row.object_scope,
          object_row.bucket,
          object_row.source_id,
          object_row.candidate_id,
          object_row.object_key,
          reference.ordinality
      ),
      '[]'::jsonb
    ) as value
    from object_rows object_row
    cross join lateral pg_catalog.jsonb_array_elements(object_row.references)
      with ordinality reference(value, ordinality)
  ), object_quality as (
    select
      pg_catalog.count(*) filter (
        where object_row.bucket is distinct from (
          private.stage1_release_production_target_snapshot() ->> 'r2_bucket'
        )
      ) as unexpected_bucket_count,
      pg_catalog.count(*) filter (
        where object_row.object_key is null
          or coalesce(object_row.sha256, '') !~ '^[0-9a-f]{64}$'
          or coalesce(object_row.byte_length, '') !~ '^[1-9][0-9]*$'
          or object_row.reference_count < 1
          or pg_catalog.jsonb_typeof(object_row.references) <> 'array'
          or pg_catalog.jsonb_array_length(object_row.references) < 1
          or case object_row.object_scope
            when 'published_event' then
              object_row.source_id is not null
              or object_row.candidate_id is null
              or object_row.hash_mode is distinct from 'raw_sha256'
              or object_row.semantic_length is not null
            when 'manifest_source' then
              object_row.source_id is null
              or object_row.candidate_id is not null
              or object_row.object_key !~ (
                '^visual-snapshots/sources/' || object_row.source_id::text ||
                '/captures/[0-9a-f]{32}/[^/]+$'
              )
              or object_row.object_key ~* '(^|/)(latest|previous)(/|$)'
              or object_row.hash_mode is distinct from 'raw_sha256'
              or object_row.semantic_length is not null
              or case
                when object_row.artifact_name = 'html' then
                  object_row.capture_profile is distinct from 'scrapling-source-html-v1'
                  or object_row.object_key !~ '/page[.]html[.]txt$'
                  or object_row.content_type <> 'text/plain; charset=utf-8'
                when object_row.artifact_name = 'page' then
                  object_row.object_key !~ '/page[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name = 'thumb' then
                  object_row.object_key !~ '/thumb[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name = 'pdf' then
                  object_row.object_key !~ '/document[.]pdf$'
                  or object_row.content_type <> 'application/pdf'
                when object_row.artifact_name = 'text' then
                  object_row.object_key !~ '/text[.]txt$'
                  or object_row.content_type <> 'text/plain; charset=utf-8'
                when object_row.artifact_name = 'layout' then
                  object_row.object_key !~ '/layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                when object_row.artifact_name = 'meta' then
                  object_row.object_key !~ '/meta[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}[.]jpg$'
                  or object_row.content_type <> 'image/jpeg'
                when object_row.artifact_name ~
                  '^expansion_state_[0-9]{2}_layout$' then
                  object_row.object_key !~
                    '/expansion-state-[0-9]{2}-layout[.]json$'
                  or object_row.content_type <>
                    'application/json; charset=utf-8'
                else true
              end
            else true
          end
      ) as base_malformed_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'published_event'
      ) as published_event_object_count,
      pg_catalog.count(*) filter (
        where object_row.object_scope = 'manifest_source'
      ) as manifest_source_object_count
    from object_rows object_row
  ), aggregate_quality as (
    select
      event_reference_quality.reference_binding_error_count,
      event_alias_quality.inconsistent_alias_count +
        event_side_quality.capture_alias_error_count +
        state_role_quality.collision_count as inconsistent_alias_count,
      greatest(
        event_side_quality.recursive_reference_key_count -
          event_reference_quality.classified_reference_key_count,
        0
      ) as unrecognized_reference_count,
      event_reference_quality.logical_reference_count,
      event_reference_quality.suppressed_reference_count,
      event_reference_quality.unsuppressed_reference_count,
      event_alias_quality.aliased_object_count,
      event_side_quality.candidate_binding_error_count
    from event_reference_quality
    cross join event_alias_quality
    cross join event_side_quality
    cross join state_role_quality
  )
  select pg_catalog.jsonb_build_object(
    'visual_object_count', pg_catalog.jsonb_array_length(object_payload.value),
    'visual_reference_count',
      aggregate_quality.logical_reference_count +
      object_quality.manifest_source_object_count,
    'published_event_object_count', object_quality.published_event_object_count,
    'published_event_reference_count', aggregate_quality.logical_reference_count,
    'suppressed_published_event_reference_count',
      aggregate_quality.suppressed_reference_count,
    'unsuppressed_published_event_reference_count',
      aggregate_quality.unsuppressed_reference_count,
    'alias_reference_count',
      aggregate_quality.logical_reference_count -
      object_quality.published_event_object_count,
    'aliased_object_count', aggregate_quality.aliased_object_count,
    'manifest_source_object_count', object_quality.manifest_source_object_count,
    'manifest_source_reference_count', object_quality.manifest_source_object_count,
    'duplicate_object_key_count', object_key_quality.duplicate_object_key_count,
    'reference_binding_error_count',
      aggregate_quality.reference_binding_error_count,
    'inconsistent_alias_count', aggregate_quality.inconsistent_alias_count,
    'unclassified_reference_count', aggregate_quality.unrecognized_reference_count,
    'reference_set_hash', public.stage1_publication_evidence_hash(
      reference_payload.value
    ),
    'visual_object_set_hash', public.stage1_publication_evidence_hash(
      object_payload.value
    ),
    'unexpected_bucket_count', object_quality.unexpected_bucket_count,
    'malformed_object_count',
      object_quality.base_malformed_object_count +
      manifest_binding_quality.error_count +
      object_key_quality.duplicate_object_key_count +
      aggregate_quality.reference_binding_error_count +
      aggregate_quality.inconsistent_alias_count +
      aggregate_quality.unrecognized_reference_count +
      aggregate_quality.candidate_binding_error_count,
    'manifest_binding_error_count', manifest_binding_quality.error_count,
    'objects', object_payload.value
  )
  from object_payload
  cross join reference_payload
  cross join object_quality
  cross join manifest_binding_quality
  cross join object_key_quality
  cross join aggregate_quality;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_visual_crop_coverage_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with coverage as (
    select private.stage1_crop_coverage_pre_r2_graph_20260810184524() as value
  ), objects as (
    select private.stage1_visual_r2_object_set_snapshot() as value
  ), pdf_events as (
    select
      event.id,
      event.visual_review_candidate_id,
      evidence.id as evidence_id,
      evidence.visual_review_candidate_id as evidence_candidate_id,
      evidence.evidence_status,
      evidence.evidence_schema_version,
      evidence.previous_capture,
      evidence.current_capture,
      evidence.localization,
      case
        when evidence.evidence_status = 'not_applicable_pdf' then
          evidence.id is not null
          and event.visual_review_candidate_id is not null
          and evidence.visual_review_candidate_id =
            event.visual_review_candidate_id
        when evidence.evidence_status = 'not_applicable_new_document' then
          private.stage1_initial_document_pdf_evidence_valid(event, evidence)
        else false
      end as pdf_evidence_valid,
      case
        when evidence.evidence_status = 'not_applicable_pdf'
          then 'candidate_bound_not_applicable_pdf'
        when evidence.evidence_status = 'not_applicable_new_document'
          then 'exact_initial_official_document'
        else 'invalid_pdf_evidence'
      end as pdf_evidence_kind
    from public.shared_award_change_events event
    left join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = event.id
    where event.suppressed_at is null
      and event.source_page_type = 'pdf'
      and exists (
        select 1
        from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
  ), pdf_payload as (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'event_id', pdf.id,
          'candidate_id', pdf.visual_review_candidate_id,
          'evidence_id', pdf.evidence_id,
          'evidence_candidate_id', pdf.evidence_candidate_id,
          'status', pdf.evidence_status,
          'schema', pdf.evidence_schema_version,
          'pdf_evidence_kind', pdf.pdf_evidence_kind,
          'pdf_evidence_valid', pdf.pdf_evidence_valid,
          'previous_kind', pdf.previous_capture ->> 'kind',
          'previous_state_id', pdf.previous_capture ->> 'state_id',
          'previous_sha256', pdf.previous_capture #>> '{metadata,sha256}',
          'current_kind', pdf.current_capture ->> 'kind',
          'current_state_id', pdf.current_capture ->> 'state_id',
          'current_sha256', pdf.current_capture #>> '{full,sha256}',
          'direction', pdf.localization ->> 'direction',
          'previous_localization_status',
            pdf.localization #>> '{sides,previous,status}',
          'current_localization_status',
            pdf.localization #>> '{sides,current,status}'
        ) order by pdf.id
      ),
      '[]'::jsonb
    ) as value
    from pdf_events pdf
  ), pdf_counts as (
    select
      pg_catalog.count(*) as pdf_event_count,
      pg_catalog.count(*) filter (where pdf_evidence_valid)
        as verified_pdf_events,
      pg_catalog.count(*) filter (where not pdf_evidence_valid)
        as pdf_evidence_failures,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
      ) as initial_document_pdf_events,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
          and pdf_evidence_valid
      ) as verified_initial_document_pdf_events,
      pg_catalog.count(*) filter (
        where evidence_status = 'not_applicable_new_document'
          and not pdf_evidence_valid
      ) as initial_document_pdf_failures
    from pdf_events
  ), source_html_events as (
    select event.id, event.visual_review_candidate_id,
      evidence.id as evidence_id, evidence.evidence_status,
      evidence.evidence_schema_version, evidence.previous_capture,
      evidence.current_capture, evidence.localization,
      private.stage1_source_html_event_evidence_valid(
        pg_catalog.to_jsonb(event), pg_catalog.to_jsonb(evidence),
        pg_catalog.to_jsonb(candidate)
      ) as source_html_evidence_valid
    from public.shared_award_change_events event
    left join public.shared_award_change_event_visual_evidence evidence
      on evidence.change_event_id = event.id
    left join public.shared_award_visual_review_candidates candidate
      on candidate.id = event.visual_review_candidate_id
    where event.suppressed_at is null
      and exists (
        select 1 from public.stage1_award_members member
        where member.shared_award_id = event.shared_award_id
      )
      and (
        evidence.evidence_status = 'not_applicable_source_html'
        or evidence.evidence_schema_version = 'source-html-event-evidence-v1'
        or evidence.previous_capture ->> 'kind' = 'source_html'
        or evidence.current_capture ->> 'kind' = 'source_html'
        or evidence.previous_capture ->> 'capture_profile' = 'scrapling-source-html-v1'
        or evidence.current_capture ->> 'capture_profile' = 'scrapling-source-html-v1'
      )
  ), source_html_payload as (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'event_id', source.id,
      'candidate_id', source.visual_review_candidate_id,
      'evidence_id', source.evidence_id,
      'status', source.evidence_status,
      'schema', source.evidence_schema_version,
      'source_html_evidence_valid', source.source_html_evidence_valid,
      'previous_capture', source.previous_capture,
      'current_capture', source.current_capture,
      'localization', source.localization
    ) order by source.id), '[]'::jsonb) as value
    from source_html_events source
  ), source_html_counts as (
    select pg_catalog.count(*) as source_html_event_count,
      pg_catalog.count(*) filter (where source_html_evidence_valid)
        as verified_source_html_events,
      pg_catalog.count(*) filter (where not source_html_evidence_valid)
        as source_html_evidence_failures
    from source_html_events
  )
  select coverage.value || pg_catalog.jsonb_build_object(
    -- Only source-only events that pass publication's full binding are removed
    -- from screenshot-specific eligibility. They never increment verified crops.
    'eligible_events', (coverage.value ->> 'eligible_events')::bigint -
      source_html_counts.verified_source_html_events,
    'unverified_publishable_events',
      (coverage.value ->> 'unverified_publishable_events')::bigint -
      source_html_counts.verified_source_html_events,
    'source_html_evidence_contract', 'awardping.stage1.source-html-evidence-coverage.v1',
    'source_html_event_count', source_html_counts.source_html_event_count,
    'verified_source_html_events', source_html_counts.verified_source_html_events,
    'source_html_evidence_failures', source_html_counts.source_html_evidence_failures,
    'reference_schema', 'awardping.r2.canonical-object-references.v1',
    'visual_object_count', objects.value -> 'visual_object_count',
    'visual_reference_count', objects.value -> 'visual_reference_count',
    'published_event_object_count',
      objects.value -> 'published_event_object_count',
    'published_event_reference_count',
      objects.value -> 'published_event_reference_count',
    'manifest_source_object_count',
      objects.value -> 'manifest_source_object_count',
    'manifest_source_reference_count',
      objects.value -> 'manifest_source_reference_count',
    'alias_reference_count', objects.value -> 'alias_reference_count',
    'aliased_object_count', objects.value -> 'aliased_object_count',
    'reference_set_hash', objects.value -> 'reference_set_hash',
    'visual_object_set_hash', objects.value -> 'visual_object_set_hash',
    'pdf_evidence_contract',
      'awardping.stage1.pdf-evidence-coverage.v1',
    'pdf_event_count', pdf_counts.pdf_event_count,
    'verified_pdf_events', pdf_counts.verified_pdf_events,
    'pdf_evidence_failures', pdf_counts.pdf_evidence_failures,
    'initial_document_pdf_events', pdf_counts.initial_document_pdf_events,
    'verified_initial_document_pdf_events',
      pdf_counts.verified_initial_document_pdf_events,
    'initial_document_pdf_failures',
      pdf_counts.initial_document_pdf_failures,
    'coverage_set_hash', public.stage1_publication_evidence_hash(
      pg_catalog.jsonb_build_object(
        'prior_coverage_set_hash', coverage.value ->> 'coverage_set_hash',
        'pdf_evidence_contract',
          'awardping.stage1.pdf-evidence-coverage.v1',
        'pdf_events', pdf_payload.value,
        'source_html_evidence_contract', 'awardping.stage1.source-html-evidence-coverage.v1',
        'source_html_events', source_html_payload.value
      )
    )
  )
  from coverage
  cross join objects
  cross join pdf_payload
  cross join pdf_counts
  cross join source_html_payload
  cross join source_html_counts;
$function$;

CREATE OR REPLACE FUNCTION private.stage1_visual_crop_derivation_contract_hash()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.stage1_publication_evidence_hash(
    pg_catalog.jsonb_build_object(
      'contract', 'awardping.stage1.visual-crop-db-derivation.v5',
      'event_scope', 'unsuppressed_stage1_change_events',
      'html_requirement', 'visual-event-evidence-v2-exact-text-overlap',
      'source_html_requirement',
        'candidate-bound-source-html-event-evidence-v1-no-visual-placement-claim',
      'source_html_evidence_contract',
        'awardping.stage1.source-html-evidence-coverage.v1',
      'pdf_requirement',
        'candidate-bound-not-applicable-pdf-or-exact-initial-document-v1',
      'object_requirement',
        'current-signed-r2-canonical-object-reference-graph-v4'
    )
  );
$function$;

CREATE OR REPLACE FUNCTION private.stage1_release_artifact_evidence_valid(p_artifact_kind text, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(
    p_artifact_kind, p_evidence
  )
  and case p_artifact_kind
    when 'r2_recovery_drill' then
      private.stage1_r2_recovery_evidence_matches_snapshot(
        p_evidence,
        pg_catalog.jsonb_build_object(
          'visual_object_count', p_evidence -> 'visual_objects_checked',
          'visual_reference_count', p_evidence -> 'visual_references_checked',
          'published_event_object_count',
            p_evidence -> 'published_event_objects_checked',
          'published_event_reference_count',
            p_evidence -> 'published_event_references_checked',
          'manifest_source_object_count',
            p_evidence -> 'manifest_source_objects_checked',
          'manifest_source_reference_count',
            p_evidence -> 'manifest_source_references_checked',
          'alias_reference_count', p_evidence -> 'alias_references_checked',
          'aliased_object_count', p_evidence -> 'aliased_objects_checked',
          'visual_object_set_hash', p_evidence -> 'visual_object_set_hash',
          'reference_set_hash', p_evidence -> 'reference_set_hash',
          'unexpected_bucket_count', 0,
          'malformed_object_count', 0,
          'manifest_binding_error_count', 0,
          'duplicate_object_key_count', 0,
          'reference_binding_error_count', 0,
          'inconsistent_alias_count', 0,
          'unclassified_reference_count', 0
        )
      )
    when 'visual_crop_coverage' then
      p_evidence ->> 'reference_schema' =
        'awardping.r2.canonical-object-references.v1'
      and p_evidence ->> 'pdf_evidence_contract' =
        'awardping.stage1.pdf-evidence-coverage.v1'
      and p_evidence ->> 'source_html_evidence_contract' =
        'awardping.stage1.source-html-evidence-coverage.v1'
      and pg_catalog.jsonb_typeof(p_evidence -> 'source_html_event_count') = 'number'
      and pg_catalog.jsonb_typeof(p_evidence -> 'verified_source_html_events') = 'number'
      and pg_catalog.jsonb_typeof(p_evidence -> 'source_html_evidence_failures') = 'number'
      and coalesce(p_evidence ->> 'source_html_event_count', '') ~ '^(0|[1-9][0-9]*)$'
      and coalesce(p_evidence ->> 'verified_source_html_events', '') ~ '^(0|[1-9][0-9]*)$'
      and p_evidence -> 'source_html_evidence_failures' = '0'::jsonb
      and p_evidence -> 'source_html_event_count' = p_evidence -> 'verified_source_html_events'
      and p_evidence ->> 'eligible_events' ~ '^(0|[1-9][0-9]*)$'
      and p_evidence ->> 'unverified_publishable_events' ~ '^(0|[1-9][0-9]*)$'
      and p_evidence ->> 'derivation_contract_hash' =
        private.stage1_visual_crop_derivation_contract_hash()
      and p_evidence ->> 'pdf_event_count' ~ '^[0-9]+$'
      and p_evidence ->> 'verified_pdf_events' ~ '^[0-9]+$'
      and p_evidence ->> 'initial_document_pdf_events' ~ '^[0-9]+$'
      and p_evidence ->> 'verified_initial_document_pdf_events'
        ~ '^[0-9]+$'
      and p_evidence ->> 'initial_document_pdf_failures' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'visual_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'published_event_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'manifest_source_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'alias_reference_count' ~ '^[0-9]+$'
      and p_evidence ->> 'aliased_object_count' ~ '^[0-9]+$'
      and p_evidence ->> 'reference_set_hash' ~ '^[0-9a-f]{64}$'
      and p_evidence ->> 'visual_object_set_hash' ~ '^[0-9a-f]{64}$'
    else true
  end;
$function$;

REVOKE ALL ON FUNCTION private.stage1_source_html_event_evidence_valid(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.shared_award_change_event_visual_evidence
  DROP CONSTRAINT shared_award_change_event_visual_evidence_evidence_status_check;
ALTER TABLE public.shared_award_change_event_visual_evidence
  ADD CONSTRAINT shared_award_change_event_visual_evidence_evidence_status_check
  CHECK (evidence_status IN ('verified','unavailable_exact_text_missing','unavailable_geometry_missing',
    'unavailable_image_missing','unavailable_ambiguous','historical_artifact_unrecoverable',
    'full_screenshot_fallback','not_applicable_pdf','not_applicable_new_document','not_applicable_source_html'));

