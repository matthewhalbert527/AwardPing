-- Exercise the retained-source validator directly. The fixture intentionally
-- omits the main layout while retaining one complete accordion image/layout
-- pair with separate raw-byte and semantic geometry hashes.
do $smoke$
declare
  v_source_id uuid := '00000000-0000-4000-8000-000000000401';
  v_prefix text :=
    'visual-snapshots/sources/00000000-0000-4000-8000-000000000401/' ||
    'captures/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
  v_object_keys jsonb;
  v_hashes jsonb;
  v_bindings jsonb;
  v_complete_coverage jsonb;
  v_metadata jsonb;
  v_invalid jsonb;
begin
  v_object_keys := pg_catalog.jsonb_build_object(
    'page', v_prefix || 'page.jpg',
    'thumb', v_prefix || 'thumb.jpg',
    'text', v_prefix || 'text.txt',
    'meta', v_prefix || 'meta.json',
    'expansion_state_01', v_prefix || 'expansion-state-01.jpg',
    'expansion_state_01_layout',
      v_prefix || 'expansion-state-01-layout.json'
  );
  v_hashes := pg_catalog.jsonb_build_object(
    'image_hash', pg_catalog.repeat('1', 64),
    'text_hash', pg_catalog.repeat('2', 64)
  );
  v_bindings := pg_catalog.jsonb_build_object(
    'page', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('1', 64),
      'byte_length', 100,
      'content_type', 'image/jpeg',
      'hash_mode', 'raw_sha256'
    ),
    'thumb', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('3', 64),
      'byte_length', 50,
      'content_type', 'image/jpeg',
      'hash_mode', 'raw_sha256'
    ),
    'text', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('4', 64),
      'byte_length', 75,
      'content_type', 'text/plain; charset=utf-8',
      'hash_mode', 'raw_sha256'
    ),
    'meta', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('5', 64),
      'byte_length', 125,
      'content_type', 'application/json; charset=utf-8',
      'hash_mode', 'raw_sha256'
    ),
    'expansion_state_01', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('6', 64),
      'byte_length', 200,
      'content_type', 'image/jpeg',
      'hash_mode', 'raw_sha256'
    ),
    'expansion_state_01_layout', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('7', 64),
      'byte_length', 300,
      'content_type', 'application/json; charset=utf-8',
      'hash_mode', 'raw_sha256'
    )
  );
  v_complete_coverage := pg_catalog.jsonb_build_object(
    'schema', 'awardping.expansion-state-capture-coverage.v1',
    'complete', true,
    'status', 'verified_complete',
    'raw_candidate_count', 1,
    'raw_candidate_count_exact', true,
    'logical_candidate_count', 1,
    'logical_candidate_count_exact', true,
    'attempted_count', 1,
    'retained_state_count', 1,
    'capture_limit', 24,
    'truncated', false,
    'truncated_count', 0,
    'truncated_count_exact', true,
    'failure_count', 0
  );
  v_metadata := pg_catalog.jsonb_build_object(
    'artifact_bindings_schema',
      'awardping.r2.capture-artifact-bindings.v1',
    'artifact_bindings', v_bindings,
    'expansion_state_capture_coverage', v_complete_coverage,
    'retained_artifact_projection', pg_catalog.jsonb_build_object(
      'schema', 'awardping.capture-retained-artifact-projection.v1',
      'kind', 'webpage',
      'localization_status', 'evidence_only_geometry_unavailable',
      'authoritative', pg_catalog.jsonb_build_object(
        'layout_retained', false,
        'layout_hash', null,
        'expansion_state_count', 1
      )
    ),
    'text_object_bytes', 75,
    'text_length', 20,
    'page_bytes', 100,
    'thumb_bytes', 50,
    'expansion_state_count', 1,
    'expansion_state_screenshots', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'state_id', 'expansion-state-01',
        'image_hash', pg_catalog.repeat('6', 64),
        'layout_hash', pg_catalog.repeat('8', 64),
        'text_hash', pg_catalog.repeat('9', 64),
        'page_bytes', 200,
        'text_length', 30,
        'text_geometry', pg_catalog.jsonb_build_object(
          'geometry_hash', pg_catalog.repeat('8', 64),
          'screenshot', pg_catalog.jsonb_build_object(
            'image_hash', pg_catalog.repeat('6', 64)
          )
        )
      )
    ),
    'text_geometry', pg_catalog.jsonb_build_object(
      'status', 'unavailable_capture_fingerprint_mismatch',
      'availability_status', 'unavailable_capture_fingerprint_mismatch',
      'unavailable_reason', 'main layout moved during capture',
      'file', null,
      'node_count', 0,
      'run_count', 0,
      'screenshot', pg_catalog.jsonb_build_object(
        'image_hash', null,
        'image_ref', null
      )
    ),
    'localization', pg_catalog.jsonb_build_object(
      'status', 'evidence_only_geometry_unavailable',
      'exact', false,
      'geometry_ready', false,
      'accounted_for', true,
      'unavailable_reason', 'main layout was not retained',
      'geometry_hash', null,
      'bound_image_hash', null
    )
  );

  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_metadata
    ) is not true then
    raise exception
      'A complete expansion pair was rejected when main geometry was explicitly unavailable.';
  end if;

  v_invalid := v_metadata - 'expansion_state_capture_coverage';
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A webpage without canonical expansion coverage was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_metadata,
      '{expansion_state_capture_coverage,complete}',
      'false'::jsonb
    ),
    '{expansion_state_capture_coverage,status}',
    '"incomplete_discovery"'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'An incomplete expansion coverage verdict satisfied Stage 1.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{expansion_state_capture_coverage,retained_state_count}',
    '0'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'Contradictory retained-state coverage was accepted.';
  end if;

  v_invalid := v_metadata - 'retained_artifact_projection';
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A capture without its retained-artifact projection was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{retained_artifact_projection,authoritative,layout_retained}',
    'true'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A contradictory retained main-layout projection was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{retained_artifact_projection,authoritative,expansion_state_count}',
    '0'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A retained expansion-count projection mismatch was accepted.';
  end if;

  -- The raw layout-object hash is intentionally different from the semantic
  -- geometry hash. Both identities are retained independently.
  if v_metadata #>>
      '{artifact_bindings,expansion_state_01_layout,sha256}' =
      v_metadata #>>
      '{expansion_state_screenshots,0,layout_hash}' then
    raise exception 'The fixture did not exercise independent layout hashes.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{artifact_bindings}',
    v_bindings - 'expansion_state_01_layout'
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys - 'expansion_state_01_layout',
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'An expansion screenshot without its layout was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{expansion_state_screenshots,0,image_hash}',
    pg_catalog.to_jsonb(pg_catalog.repeat('a', 64))
  );
  v_invalid := pg_catalog.jsonb_set(
    v_invalid,
    '{expansion_state_screenshots,0,text_geometry,screenshot,image_hash}',
    pg_catalog.to_jsonb(pg_catalog.repeat('a', 64))
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'An expansion screenshot with a mismatched raw hash was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{artifact_bindings}',
    (v_bindings - 'expansion_state_01' - 'expansion_state_01_layout') ||
      pg_catalog.jsonb_build_object(
        'expansion_state_02', v_bindings -> 'expansion_state_01',
        'expansion_state_02_layout',
          v_bindings -> 'expansion_state_01_layout'
      )
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      (v_object_keys - 'expansion_state_01' - 'expansion_state_01_layout') ||
        pg_catalog.jsonb_build_object(
          'expansion_state_02', v_prefix || 'expansion-state-02.jpg',
          'expansion_state_02_layout',
            v_prefix || 'expansion-state-02-layout.json'
        ),
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A non-contiguous expansion pair was accepted.';
  end if;

  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes || pg_catalog.jsonb_build_object(
        'layout_hash', pg_catalog.repeat('8', 64)
      ),
      v_metadata
    ) is not false then
    raise exception
      'Missing main geometry was accepted with a contradictory layout hash.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{localization,exact}',
    'true'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception
      'Missing main geometry was accepted with exact localization claimed.';
  end if;

  v_invalid := v_metadata #- '{localization,exact}';
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception
      'Missing main geometry was accepted without explicit non-exact localization.';
  end if;

  v_invalid := v_metadata #- '{text_geometry,unavailable_reason}';
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception
      'Missing main geometry was accepted without a geometry failure reason.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{text_geometry,file}',
    pg_catalog.to_jsonb('/stale/layout.json'::text)
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception
      'Missing main geometry was accepted with a retained layout file claim.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{expansion_state_count}',
    '-1'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A negative expansion count was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{artifact_bindings,page,byte_length}',
    '9007199254740992'::jsonb
  );
  v_invalid := pg_catalog.jsonb_set(
    v_invalid,
    '{page_bytes}',
    '9007199254740992'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A byte length above the JavaScript safe-integer limit was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_metadata,
      '{artifact_bindings}',
      v_bindings - 'expansion_state_01' - 'expansion_state_01_layout'
    ),
    '{expansion_state_count}',
    '0'::jsonb
  );
  v_invalid := pg_catalog.jsonb_set(
    v_invalid,
    '{expansion_state_screenshots}',
    '[]'::jsonb
  );
  v_invalid := pg_catalog.jsonb_set(
    v_invalid,
    '{retained_artifact_projection,authoritative,expansion_state_count}',
    '0'::jsonb
  );
  v_invalid := pg_catalog.jsonb_set(
    v_invalid,
    '{expansion_state_capture_coverage}',
    v_complete_coverage
      || pg_catalog.jsonb_build_object(
        'raw_candidate_count', 0,
        'logical_candidate_count', 0,
        'attempted_count', 0,
        'retained_state_count', 0
      )
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'webpage',
      v_object_keys - 'expansion_state_01' - 'expansion_state_01_layout',
      v_hashes,
      v_invalid
    ) is not true then
    raise exception
      'The canonical zero-expansion explicit-unavailability shape no longer validates.';
  end if;

  v_object_keys := pg_catalog.jsonb_build_object(
    'pdf', v_prefix || 'document.pdf',
    'text', v_prefix || 'text.txt',
    'meta', v_prefix || 'meta.json'
  );
  v_hashes := pg_catalog.jsonb_build_object(
    'file_hash', pg_catalog.repeat('a', 64),
    'text_hash', pg_catalog.repeat('b', 64)
  );
  v_bindings := pg_catalog.jsonb_build_object(
    'pdf', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('a', 64),
      'byte_length', 400,
      'content_type', 'application/pdf',
      'hash_mode', 'raw_sha256'
    ),
    'text', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('c', 64),
      'byte_length', 80,
      'content_type', 'text/plain; charset=utf-8',
      'hash_mode', 'raw_sha256'
    ),
    'meta', pg_catalog.jsonb_build_object(
      'sha256', pg_catalog.repeat('d', 64),
      'byte_length', 140,
      'content_type', 'application/json; charset=utf-8',
      'hash_mode', 'raw_sha256'
    )
  );
  v_metadata := pg_catalog.jsonb_build_object(
    'artifact_bindings_schema',
      'awardping.r2.capture-artifact-bindings.v1',
    'artifact_bindings', v_bindings,
    'retained_artifact_projection', pg_catalog.jsonb_build_object(
      'schema', 'awardping.capture-retained-artifact-projection.v1',
      'kind', 'pdf',
      'localization_status', 'not_applicable_pdf',
      'authoritative', pg_catalog.jsonb_build_object(
        'layout_retained', false,
        'layout_hash', null,
        'expansion_state_count', 0
      )
    ),
    'text_object_bytes', 80,
    'text_length', 22,
    'file_bytes', 400
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'pdf',
      v_object_keys,
      v_hashes,
      v_metadata
    ) is not true then
    raise exception 'A canonical PDF retained-artifact projection was rejected.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{expansion_state_capture_coverage}',
    v_complete_coverage
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'pdf',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A PDF carrying webpage expansion coverage was accepted.';
  end if;

  v_invalid := pg_catalog.jsonb_set(
    v_metadata,
    '{retained_artifact_projection,authoritative,expansion_state_count}',
    '1'::jsonb
  );
  if private.stage1_manifest_source_capture_binding_valid(
      v_source_id,
      'pdf',
      v_object_keys,
      v_hashes,
      v_invalid
    ) is not false then
    raise exception 'A PDF projection with retained expansion evidence was accepted.';
  end if;
end;
$smoke$;
