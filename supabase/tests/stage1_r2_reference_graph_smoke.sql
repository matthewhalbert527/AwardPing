do $smoke$
declare
  v_snapshot jsonb;
  v_gate jsonb;
begin
  if pg_catalog.to_regprocedure(
      'private.stage1_published_capture_reference_graph_valid(jsonb)'
    ) is null
    or pg_catalog.to_regprocedure(
      'private.stage1_r2_reference_set_hash_input(jsonb)'
    ) is null
    or pg_catalog.to_regprocedure(
      'public.get_stage1_release_r2_verification_manifest()'
    ) is null then
    raise exception 'Stage 1 R2 reference-graph functions are missing.';
  end if;

  if not pg_catalog.has_function_privilege(
      'service_role',
      'public.get_stage1_release_r2_verification_manifest()',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'public.get_stage1_release_r2_verification_manifest()',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',
      'public.get_stage1_release_r2_verification_manifest()',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'service_role',
      'private.stage1_visual_r2_object_set_snapshot()',
      'EXECUTE'
    ) then
    raise exception 'Stage 1 R2 function privileges are unsafe.';
  end if;

  v_snapshot := private.stage1_visual_r2_object_set_snapshot();
  if pg_catalog.jsonb_typeof(v_snapshot) is distinct from 'object'
    or private.stage1_r2_reference_set_hash_input(
      v_snapshot -> 'objects'
    ) is null then
    raise exception 'Stage 1 R2 snapshot read path failed.';
  end if;

  perform private.stage1_visual_crop_coverage_snapshot();
  perform * from public.list_stage1_effective_publication();
  v_gate := public.get_stage1_release_gate_snapshot();
  if pg_catalog.jsonb_typeof(v_gate) is distinct from 'object'
    or v_gate ->> 'state' is distinct from 'HOLD' then
    raise exception 'A fresh database must keep the Stage 1 release gate on HOLD.';
  end if;
end;
$smoke$;

-- Exercise the graph against real, non-empty capture shapes. The fixtures are
-- deterministic, trigger-free test data and are always rolled back.
begin;
set local session_replication_role = replica;

do $fixtures$
declare
  v_award_id uuid;
  v_bucket text := 'awardping-smoke-r2';
  v_web_source uuid := '00000000-0000-4000-8000-000000000101';
  v_pdf_source uuid := '00000000-0000-4000-8000-000000000102';
  v_first_source uuid := '00000000-0000-4000-8000-000000000103';
  v_web_candidate uuid := '00000000-0000-4000-8000-000000000201';
  v_pdf_candidate uuid := '00000000-0000-4000-8000-000000000202';
  v_first_candidate uuid := '00000000-0000-4000-8000-000000000203';
  v_web_event uuid := '00000000-0000-4000-8000-000000000301';
  v_pdf_event uuid := '00000000-0000-4000-8000-000000000302';
  v_first_event uuid := '00000000-0000-4000-8000-000000000303';
  v_prefix text;
  v_full jsonb;
  v_layout jsonb;
  v_web_previous jsonb;
  v_web_current jsonb;
  v_pdf_previous jsonb;
  v_pdf_current jsonb;
  v_first_previous jsonb;
  v_first_current jsonb;
  v_manifest jsonb;
  v_count bigint;
begin
  select member.shared_award_id into v_award_id
  from public.stage1_award_members member
  join public.stage1_award_registry registry
    on registry.cohort_key = member.cohort_key
  where member.member_kind = 'canonical'
  order by registry.launch_rank
  limit 1;
  if v_award_id is null then
    raise exception 'The migrated database did not seed a canonical Stage 1 member.';
  end if;

  insert into private.stage1_release_production_targets (
    release_key,
    config_version,
    app_origin,
    supabase_origin,
    supabase_project_ref,
    deployment_provider,
    deployment_project_id,
    deployment_team_slug,
    r2_account_id,
    r2_bucket,
    configured_by
  ) values (
    'stage1-national-25',
    1,
    'https://smoke.awardping.test',
    'https://abcdefghijklmnopqrst.supabase.co',
    'abcdefghijklmnopqrst',
    'vercel',
    'smoke-project',
    'awardping-smoke',
    pg_catalog.repeat('a', 32),
    v_bucket,
    'supabase-migration-smoke'
  ) on conflict (release_key) do update set
    config_version = excluded.config_version,
    app_origin = excluded.app_origin,
    supabase_origin = excluded.supabase_origin,
    supabase_project_ref = excluded.supabase_project_ref,
    deployment_provider = excluded.deployment_provider,
    deployment_project_id = excluded.deployment_project_id,
    deployment_team_slug = excluded.deployment_team_slug,
    r2_account_id = excluded.r2_account_id,
    r2_bucket = excluded.r2_bucket,
    configured_by = excluded.configured_by,
    configured_at = pg_catalog.clock_timestamp();

  insert into public.shared_award_sources (
    id, shared_award_id, url, title, page_type, confidence, source
  ) values
    (
      v_web_source, v_award_id, 'https://smoke.invalid/webpage',
      'R2 smoke webpage', 'homepage', 1, 'admin'
    ),
    (
      v_pdf_source, v_award_id, 'https://smoke.invalid/document.pdf',
      'R2 smoke PDF', 'pdf', 1, 'admin'
    ),
    (
      v_first_source, v_award_id, 'https://smoke.invalid/first.pdf',
      'R2 smoke first observation', 'pdf', 1, 'admin'
    );

  insert into public.shared_award_visual_review_candidates (
    id,
    shared_award_id,
    shared_award_source_id,
    candidate_signature,
    source_url,
    source_title,
    source_page_type,
    status
  ) values
    (
      v_web_candidate, v_award_id, v_web_source, 'r2-smoke-web-v4',
      'https://smoke.invalid/webpage', 'R2 smoke webpage', 'homepage',
      'published'
    ),
    (
      v_pdf_candidate, v_award_id, v_pdf_source, 'r2-smoke-pdf-v4',
      'https://smoke.invalid/document.pdf', 'R2 smoke PDF', 'pdf',
      'published'
    ),
    (
      v_first_candidate, v_award_id, v_first_source, 'r2-smoke-first-v4',
      'https://smoke.invalid/first.pdf', 'R2 smoke first observation', 'pdf',
      'published'
    );

  insert into public.shared_award_change_events (
    id,
    shared_award_id,
    shared_award_source_id,
    source_url,
    source_title,
    source_page_type,
    previous_hash,
    new_hash,
    summary,
    visual_review_candidate_id
  ) values
    (
      v_web_event, v_award_id, v_web_source,
      'https://smoke.invalid/webpage', 'R2 smoke webpage', 'homepage',
      pg_catalog.repeat('1', 64), pg_catalog.repeat('2', 64),
      'Transactional webpage reference-graph fixture.', v_web_candidate
    ),
    (
      v_pdf_event, v_award_id, v_pdf_source,
      'https://smoke.invalid/document.pdf', 'R2 smoke PDF', 'pdf',
      pg_catalog.repeat('3', 64), pg_catalog.repeat('4', 64),
      'Transactional PDF reference-graph fixture.', v_pdf_candidate
    ),
    (
      v_first_event, v_award_id, v_first_source,
      'https://smoke.invalid/first.pdf', 'R2 smoke first observation', 'pdf',
      pg_catalog.repeat('5', 64), pg_catalog.repeat('6', 64),
      'Transactional first-observation reference-graph fixture.',
      v_first_candidate
    );

  -- One webpage side has six physical objects and ten logical references.
  -- full/main_full/state.image/crop.source_image and
  -- layout/state.geometry intentionally alias exact immutable keys.
  v_prefix := 'visual-snapshots/published/' || v_web_candidate::text ||
    '/previous/';
  v_full := pg_catalog.jsonb_build_object(
    'object_key', v_prefix || 'main-full/' || pg_catalog.repeat('a', 64) || '.jpg',
    'sha256', pg_catalog.repeat('a', 64),
    'byte_length', 101,
    'content_type', 'image/jpeg',
    'width', 1200,
    'height', 1800
  );
  v_layout := pg_catalog.jsonb_build_object(
    'object_key', v_prefix || 'geometry-main/' || pg_catalog.repeat('b', 64) || '.json',
    'sha256', pg_catalog.repeat('b', 64),
    'byte_length', 102,
    'content_type', 'application/json; charset=utf-8',
    'geometry_hash', pg_catalog.repeat('9', 64)
  );
  v_web_previous := pg_catalog.jsonb_build_object(
    'kind', 'webpage',
    'state_id', 'main',
    'full', v_full,
    'metadata', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'metadata/' || pg_catalog.repeat('f', 64) || '.json',
      'sha256', pg_catalog.repeat('f', 64),
      'byte_length', 106,
      'content_type', 'application/json; charset=utf-8'
    ),
    'crop', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'changed-section-crop/' || pg_catalog.repeat('e', 64) || '.jpg',
      'sha256', pg_catalog.repeat('e', 64),
      'byte_length', 105,
      'content_type', 'image/jpeg',
      'state_id', 'main',
      'exact_overlap', true,
      'source_image_object_key', v_full ->> 'object_key',
      'source_image_sha256', v_full ->> 'sha256',
      'source_image_byte_length', v_full ->> 'byte_length'
    ),
    'main_full', v_full,
    'thumbnail', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'thumbnail/' || pg_catalog.repeat('c', 64) || '.jpg',
      'sha256', pg_catalog.repeat('c', 64),
      'byte_length', 103,
      'content_type', 'image/jpeg'
    ),
    'text', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'text/' || pg_catalog.repeat('d', 64) || '.txt',
      'sha256', pg_catalog.repeat('d', 64),
      'byte_length', 104,
      'content_type', 'text/plain; charset=utf-8'
    ),
    'layout', v_layout,
    'states', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'state_id', 'main',
      'kind', 'main',
      'image', v_full,
      'geometry', v_layout,
      'geometry_hash', v_layout ->> 'geometry_hash'
    ))
  );
  v_web_current := pg_catalog.replace(
    v_web_previous::text, '/previous/', '/current/'
  )::jsonb;

  -- A PDF side has exactly document, metadata, and text. The second migration
  -- must continue to reject a webpage thumbnail on this shape.
  v_prefix := 'visual-snapshots/published/' || v_pdf_candidate::text ||
    '/previous/';
  v_pdf_previous := pg_catalog.jsonb_build_object(
    'kind', 'pdf',
    'full', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'document/' || pg_catalog.repeat('1', 64) || '.pdf',
      'sha256', pg_catalog.repeat('1', 64),
      'byte_length', 201,
      'content_type', 'application/pdf'
    ),
    'metadata', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'metadata/' || pg_catalog.repeat('2', 64) || '.json',
      'sha256', pg_catalog.repeat('2', 64),
      'byte_length', 202,
      'content_type', 'application/json; charset=utf-8'
    ),
    'text', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'text/' || pg_catalog.repeat('3', 64) || '.txt',
      'sha256', pg_catalog.repeat('3', 64),
      'byte_length', 203,
      'content_type', 'text/plain; charset=utf-8'
    )
  );
  v_pdf_current := pg_catalog.replace(
    v_pdf_previous::text, '/previous/', '/current/'
  )::jsonb;
  if private.stage1_published_capture_reference_graph_valid(
    v_pdf_previous || pg_catalog.jsonb_build_object(
      'thumbnail', pg_catalog.jsonb_build_object(
        'object_key', v_prefix || 'thumbnail/' || pg_catalog.repeat('4', 64) || '.jpg',
        'sha256', pg_catalog.repeat('4', 64),
        'byte_length', 204,
        'content_type', 'image/jpeg'
      )
    )
  ) then
    raise exception 'The PDF capture contract admitted a webpage thumbnail.';
  end if;

  v_prefix := 'visual-snapshots/published/' || v_first_candidate::text ||
    '/previous/';
  v_first_previous := pg_catalog.jsonb_build_object(
    'kind', 'first_observation_attestation',
    'metadata', pg_catalog.jsonb_build_object(
      'object_key', v_prefix || 'first-observation-attestation/' ||
        pg_catalog.repeat('4', 64) || '.json',
      'sha256', pg_catalog.repeat('4', 64),
      'byte_length', 301,
      'content_type', 'application/json; charset=utf-8'
    ),
    'attestation', pg_catalog.jsonb_build_object(
      'schema_version', 'awardping.first_observation.v1',
      'prior_evidence_state', 'no_prior_baseline_supplied'
    )
  );
  v_first_current := pg_catalog.replace(
    pg_catalog.replace(
      v_pdf_previous::text,
      v_pdf_candidate::text,
      v_first_candidate::text
    ),
    '/previous/',
    '/current/'
  )::jsonb;

  if private.stage1_published_capture_reference_graph_valid(v_web_previous)
      is not true
    or private.stage1_published_capture_reference_graph_valid(v_web_current)
      is not true
    or private.stage1_published_capture_reference_graph_valid(v_pdf_previous)
      is not true
    or private.stage1_published_capture_reference_graph_valid(v_pdf_current)
      is not true
    or private.stage1_published_capture_reference_graph_valid(v_first_previous)
      is not true
    or private.stage1_published_capture_reference_graph_valid(v_first_current)
      is not true then
    raise exception 'A valid Stage 1 capture fixture failed graph validation.';
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
    evidence_schema_version
  ) values
    (
      v_web_event, v_award_id, v_web_source, v_web_candidate,
      'r2-smoke-web-v4', v_bucket, 'full_screenshot_fallback',
      v_web_previous, v_web_current, '{}'::jsonb, 'visual-event-evidence-v2'
    ),
    (
      v_pdf_event, v_award_id, v_pdf_source, v_pdf_candidate,
      'r2-smoke-pdf-v4', v_bucket, 'not_applicable_pdf',
      v_pdf_previous, v_pdf_current, '{}'::jsonb, 'visual-event-evidence-v2'
    ),
    (
      v_first_event, v_award_id, v_first_source, v_first_candidate,
      'r2-smoke-first-v4', v_bucket, 'not_applicable_new_document',
      v_first_previous, v_first_current, '{}'::jsonb,
      'visual-event-evidence-v2'
    );

  v_manifest := public.get_stage1_release_r2_verification_manifest();
  if v_manifest ->> 'schema_version' is distinct from
      'awardping.stage1.r2-verification-manifest.v4'
    or v_manifest ->> 'visual_object_count' is distinct from '22'
    or v_manifest ->> 'visual_reference_count' is distinct from '30'
    or v_manifest ->> 'published_event_object_count' is distinct from '22'
    or v_manifest ->> 'published_event_reference_count' is distinct from '30'
    or v_manifest ->> 'manifest_source_object_count' is distinct from '0'
    or v_manifest ->> 'manifest_source_reference_count' is distinct from '0'
    or v_manifest ->> 'alias_reference_count' is distinct from '8'
    or v_manifest ->> 'aliased_object_count' is distinct from '4'
    or v_manifest ->> 'unexpected_bucket_count' is distinct from '0'
    or v_manifest ->> 'malformed_object_count' is distinct from '0'
    or v_manifest ->> 'manifest_binding_error_count' is distinct from '0'
    or v_manifest ->> 'duplicate_object_key_count' is distinct from '0'
    or v_manifest ->> 'reference_binding_error_count' is distinct from '0'
    or v_manifest ->> 'inconsistent_alias_count' is distinct from '0'
    or v_manifest ->> 'unclassified_reference_count' is distinct from '0' then
    raise exception 'The non-empty Stage 1 R2 manifest counts are invalid: %',
      v_manifest;
  end if;
  if pg_catalog.jsonb_typeof(v_manifest -> 'objects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_manifest -> 'objects') <> 22
    or public.stage1_publication_evidence_hash(
      (v_manifest ->> 'reference_set_hash_input')::jsonb
    ) is distinct from v_manifest ->> 'reference_set_hash'
    or public.stage1_publication_evidence_hash(
      (v_manifest ->> 'visual_object_set_hash_input')::jsonb
    ) is distinct from v_manifest ->> 'visual_object_set_hash' then
    raise exception 'The public v4 manifest did not bind its canonical hash inputs.';
  end if;

  select pg_catalog.count(*) into v_count
  from pg_catalog.jsonb_array_elements(v_manifest -> 'objects') object(value)
  where object.value ->> 'storage_role' = 'main-full'
    and object.value ->> 'reference_count' = '4';
  if v_count <> 2 then
    raise exception 'The webpage alias fixture was not canonicalized once per side.';
  end if;
  select pg_catalog.count(*) into v_count
  from pg_catalog.jsonb_array_elements(v_manifest -> 'objects') object(value)
  where object.value ->> 'storage_role' = 'document';
  if v_count <> 3 then
    raise exception 'The PDF fixtures did not expose all three document sides.';
  end if;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_manifest -> 'objects') object(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      object.value -> 'references'
    ) reference(value)
    where object.value ->> 'storage_role' = 'first-observation-attestation'
      and object.value ->> 'side' = 'previous'
      and reference.value ->> 'role' = 'metadata'
      and reference.value ->> 'logical_path' = '$.metadata.object_key'
  ) then
    raise exception 'The first-observation attestation was not retained.';
  end if;

  -- Add one unclassified object-key field and require the public manifest to
  -- report it fail-closed without silently adding it to the canonical graph.
  update public.shared_award_change_event_visual_evidence
  set previous_capture = pg_catalog.jsonb_set(
    previous_capture,
    '{rogue}',
    pg_catalog.jsonb_build_object(
      'object_key', 'visual-snapshots/published/' || v_web_candidate::text ||
        '/previous/rogue/' || pg_catalog.repeat('0', 64) || '.bin',
      'sha256', pg_catalog.repeat('0', 64),
      'byte_length', 1,
      'content_type', 'application/octet-stream'
    ),
    true
  )
  where change_event_id = v_web_event;
  v_manifest := public.get_stage1_release_r2_verification_manifest();
  if v_manifest ->> 'unclassified_reference_count' is distinct from '1'
    or v_manifest ->> 'malformed_object_count' is distinct from '1'
    or v_manifest ->> 'visual_object_count' is distinct from '22'
    or v_manifest ->> 'visual_reference_count' is distinct from '30' then
    raise exception 'The public v4 manifest did not reject an unknown reference: %',
      v_manifest;
  end if;

  update public.shared_award_change_event_visual_evidence
  set previous_capture = v_web_previous
  where change_event_id = v_web_event;
  v_manifest := public.get_stage1_release_r2_verification_manifest();
  if v_manifest ->> 'malformed_object_count' is distinct from '0'
    or v_manifest ->> 'unclassified_reference_count' is distinct from '0' then
    raise exception 'The valid graph did not recover after removing the invalid fixture.';
  end if;
end;
$fixtures$;

rollback;
