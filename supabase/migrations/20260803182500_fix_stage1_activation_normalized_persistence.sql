-- Bind Stage 1 activation to both the immutable raw capture bytes and the
-- normalized text identity reviewed by the operator. The original validator
-- compared those two distinct hashes directly, which rejected valid captures.

create or replace function private.stage1_activation_persistence_evidence_valid(
  p_evidence jsonb,
  p_source_id uuid,
  p_acquisition_id uuid,
  p_request_id uuid,
  p_guard_sha256 text,
  p_observed_normalized_text_sha256 text
)
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_local jsonb := p_evidence -> 'local_baseline';
  v_r2 jsonb := p_evidence -> 'r2';
begin
  if private.stage1_jsonb_has_exact_keys(p_evidence, array[
      'acquisition_id',
      'creates_api_charge',
      'guard_sha256',
      'local_baseline',
      'local_baseline_written',
      'observed_normalized_text_sha256',
      'persisted_at',
      'r2',
      'r2_sync_succeeded',
      'request_id',
      'schema_version',
      'source_id'
    ]) is not true
    or p_evidence ->> 'schema_version' is distinct from
      'awardping.stage1.baseline-activation-persistence-evidence.v2'
    or nullif(p_evidence ->> 'source_id', '')::uuid is distinct from p_source_id
    or nullif(p_evidence ->> 'acquisition_id', '')::uuid
      is distinct from p_acquisition_id
    or nullif(p_evidence ->> 'request_id', '')::uuid is distinct from p_request_id
    or p_evidence ->> 'guard_sha256' is distinct from p_guard_sha256
    or p_evidence ->> 'observed_normalized_text_sha256'
      is distinct from p_observed_normalized_text_sha256
    or p_evidence -> 'local_baseline_written' is distinct from 'true'::jsonb
    or p_evidence -> 'r2_sync_succeeded' is distinct from 'true'::jsonb
    or p_evidence -> 'creates_api_charge' is distinct from 'false'::jsonb
    or (p_evidence ->> 'persisted_at')::timestamptz >
      pg_catalog.statement_timestamp() + interval '5 minutes'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_local, array[
      'activation_guard_sha256',
      'activation_status',
      'archive_relative_path',
      'capture_meta_path',
      'captured_at',
      'file_hash',
      'image_hash',
      'kind',
      'layout_hash',
      'normalized_text_sha256',
      'text_hash'
    ]) is not true
    or nullif(pg_catalog.btrim(v_local ->> 'archive_relative_path'), '') is null
    or nullif(pg_catalog.btrim(v_local ->> 'capture_meta_path'), '') is null
    or nullif(pg_catalog.btrim(v_local ->> 'kind'), '') is null
    or (v_local ->> 'captured_at')::timestamptz >
      pg_catalog.statement_timestamp() + interval '5 minutes'
    or coalesce(v_local ->> 'text_hash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_local ->> 'normalized_text_sha256', '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_local ->> 'image_hash', '') !~ '^[0-9a-f]{64}$'
    or not (
      v_local -> 'file_hash' = 'null'::jsonb
      or coalesce(v_local ->> 'file_hash', '') ~ '^[0-9a-f]{64}$'
    )
    or not (
      v_local -> 'layout_hash' = 'null'::jsonb
      or coalesce(v_local ->> 'layout_hash', '') ~ '^[0-9a-f]{64}$'
    )
    or v_local ->> 'normalized_text_sha256' is distinct from
      p_observed_normalized_text_sha256
    or v_local ->> 'activation_guard_sha256' is distinct from p_guard_sha256
    or v_local ->> 'activation_status' is distinct from 'server_prepare_recorded'
  then
    return false;
  end if;

  if private.stage1_jsonb_has_exact_keys(v_r2, array[
      'activation_guard_sha256',
      'bucket',
      'latest_captured_at',
      'latest_hashes',
      'latest_object_keys',
      'uploaded_object_count'
    ]) is not true
    or nullif(pg_catalog.btrim(v_r2 ->> 'bucket'), '') is null
    or (v_r2 ->> 'latest_captured_at')::timestamptz is distinct from
      (v_local ->> 'captured_at')::timestamptz
    or pg_catalog.jsonb_typeof(v_r2 -> 'latest_hashes') is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_r2 -> 'latest_object_keys') is distinct from 'object'
    or v_r2 -> 'latest_object_keys' = '{}'::jsonb
    or nullif(v_r2 #>> array['latest_object_keys', 'text'], '') is null
    or v_r2 #>> array['latest_hashes', 'text_hash'] is distinct from
      v_local ->> 'text_hash'
    or v_r2 #>> array['latest_hashes', 'image_hash'] is distinct from
      v_local ->> 'image_hash'
    or v_r2 ->> 'activation_guard_sha256' is distinct from p_guard_sha256
    or pg_catalog.jsonb_typeof(v_r2 -> 'uploaded_object_count')
      is distinct from 'number'
    or (v_r2 ->> 'uploaded_object_count')::integer <= 0
  then
    return false;
  end if;

  return true;
exception
  when invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
    or numeric_value_out_of_range
  then
    return false;
end;
$$;

revoke all on function private.stage1_activation_persistence_evidence_valid(
  jsonb, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

comment on function private.stage1_activation_persistence_evidence_valid(
  jsonb, uuid, uuid, uuid, text, text
) is
  'Validates v2 Stage 1 persistence proof: raw local/R2 capture identity plus the separately normalized operator-reviewed text identity.';
