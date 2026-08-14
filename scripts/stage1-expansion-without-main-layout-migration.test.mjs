import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const priorMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260810162124_complete_stage1_r2_artifact_manifest.sql",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814141049_allow_expansion_evidence_without_main_layout.sql",
    import.meta.url,
  ),
  "utf8",
);

function bindingFunction(sql) {
  const signature =
    "private.stage1_manifest_source_capture_binding_valid(";
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf(`revoke all on function ${signature}`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const priorBindingFunction = bindingFunction(priorMigration);
const updatedBindingFunction = bindingFunction(migration);

describe("expansion evidence without main layout migration", () => {
  it("removes the obsolete dependency while tightening unavailable-main claims", () => {
    let expected = priorBindingFunction
      .replace(
        `  -- Expansion metadata binds its page bytes and geometry identity. Layout JSON
  -- itself is recovered by its independent raw-byte artifact binding.`,
        `  -- Expansion metadata binds each screenshot to its image hash and byte length,
  -- and each layout to its geometry hash. Every retained object also carries
  -- its own independent raw-byte artifact binding above.`,
      )
      .replace(
        `    -- A missing main layout is accepted only as explicit, non-contradictory
    -- unavailability. It cannot coexist with expansion layouts or geometry/hash
    -- claims that imply retained localization evidence exists.
    if v_expansion_page_count <> 0
      or nullif(pg_catalog.btrim(coalesce(p_hashes ->> 'layout_hash', '')), '')`,
        `    -- A missing main layout is accepted only as explicit, non-contradictory
    -- unavailability. Main-capture geometry/hash claims remain forbidden, but
    -- complete expansion screenshot/layout pairs retain independent authority.
    if nullif(pg_catalog.btrim(coalesce(p_hashes ->> 'layout_hash', '')), '')`,
      )
      .replace(
        `      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{text_geometry,screenshot,image_hash}', ''
      )), '') is not null
      or (
        p_metadata ? 'text_geometry'`,
        `      or nullif(pg_catalog.btrim(coalesce(
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
        p_metadata ? 'text_geometry'`,
      )
      .replace(
        `          or p_metadata #>> '{text_geometry,status}' ~ '^unavailable_'
        ), false)
      )
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')`,
        `          or p_metadata #>> '{text_geometry,status}' ~ '^unavailable_'
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
      or pg_catalog.jsonb_typeof(p_metadata -> 'localization')`,
      )
      .replace(
        `          'evidence_only_geometry_unavailable'
      ), false)
      or p_metadata #> '{localization,geometry_ready}'`,
        `          'evidence_only_geometry_unavailable'
      ), false)
      or p_metadata #> '{localization,exact}' is distinct from
        'false'::jsonb
      or p_metadata #> '{localization,geometry_ready}'`,
      );

    const safeIntegerGuards = [
      [
        `declare
  v_primary_key text;`,
        `declare
  v_max_safe_integer constant numeric := 9007199254740991;
  v_primary_key text;`,
      ],
      [
        `    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'`,
        `    or coalesce(p_metadata ->> 'text_object_bytes', '') !~ '^[1-9][0-9]*$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_object_bytes') = 'number'
        then (p_metadata ->> 'text_object_bytes')::numeric > v_max_safe_integer
      else false
    end)`,
      ],
      [
        `    or coalesce(p_metadata ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'`,
        `    or coalesce(p_metadata ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'text_length') = 'number'
        then (p_metadata ->> 'text_length')::numeric > v_max_safe_integer
      else false
    end)`,
      ],
      [
        `      or coalesce(binding.value ->> 'byte_length', '') !~ '^[1-9][0-9]*$'`,
        `      or coalesce(binding.value ->> 'byte_length', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(binding.value -> 'byte_length') = 'number'
          then (binding.value ->> 'byte_length')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
      [
        `      or coalesce(p_metadata ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'`,
        `      or coalesce(p_metadata ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'page_bytes') = 'number'
          then (p_metadata ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
      [
        `      or coalesce(p_metadata ->> 'thumb_bytes', '') !~ '^[1-9][0-9]*$'`,
        `      or coalesce(p_metadata ->> 'thumb_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'thumb_bytes') = 'number'
          then (p_metadata ->> 'thumb_bytes')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
      [
        `      or coalesce(p_metadata ->> 'file_bytes', '') !~ '^[1-9][0-9]*$'`,
        `      or coalesce(p_metadata ->> 'file_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(p_metadata -> 'file_bytes') = 'number'
          then (p_metadata ->> 'file_bytes')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
      [
        `    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'`,
        `    or coalesce(p_metadata ->> 'expansion_state_count', '')
      !~ '^(0|[1-9][0-9]*)$'
    or (case
      when pg_catalog.jsonb_typeof(p_metadata -> 'expansion_state_count') = 'number'
        then (p_metadata ->> 'expansion_state_count')::numeric > v_max_safe_integer
      else false
    end)`,
      ],
      [
        `      or coalesce(state.value ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'`,
        `      or coalesce(state.value ->> 'page_bytes', '') !~ '^[1-9][0-9]*$'
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'page_bytes') = 'number'
          then (state.value ->> 'page_bytes')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
      [
        `      or coalesce(state.value ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'`,
        `      or coalesce(state.value ->> 'text_length', '') !~ '^(0|[1-9][0-9]*)$'
      or (case
        when pg_catalog.jsonb_typeof(state.value -> 'text_length') = 'number'
          then (state.value ->> 'text_length')::numeric > v_max_safe_integer
        else false
      end)`,
      ],
    ];
    for (const [needle, replacement] of safeIntegerGuards) {
      expect(expected).toContain(needle);
      expected = expected.replace(needle, () => replacement);
    }

    const projectionGuards = [
      [
        `    or pg_catalog.jsonb_typeof(p_metadata -> 'artifact_bindings')
      is distinct from 'object'`,
        `    or pg_catalog.jsonb_typeof(p_metadata -> 'artifact_bindings')
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
    end)`,
      ],
      [
        `  if p_kind = 'pdf' then
    return true;
  end if;`,
        `  if p_kind = 'pdf' then
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
  end if;`,
      ],
      [
        `      or p_metadata #>> '{localization,semantic_crop_contract}' is distinct from
        'visual-exact-text-binding-v2'`,
        `      or p_metadata #>> '{localization,semantic_crop_contract}' is distinct from
        'visual-exact-text-binding-v2'
      or p_metadata #>> '{retained_artifact_projection,localization_status}'
        is distinct from 'exact_geometry_available'
      or p_metadata #> '{retained_artifact_projection,authoritative,layout_retained}'
        is distinct from 'true'::jsonb
      or p_metadata #>> '{retained_artifact_projection,authoritative,layout_hash}'
        is distinct from p_hashes ->> 'layout_hash'
      or p_metadata #>>
        '{retained_artifact_projection,authoritative,expansion_state_count}'
        is distinct from v_expansion_page_count::text`,
      ],
      [
        `      or nullif(pg_catalog.btrim(coalesce(
        p_metadata #>> '{localization,bound_image_hash}', ''
      )), '') is not null`,
        `      or nullif(pg_catalog.btrim(coalesce(
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
        is distinct from v_expansion_page_count::text`,
      ],
    ];
    for (const [needle, replacement] of projectionGuards) {
      expect(expected).toContain(needle);
      expected = expected.replace(needle, () => replacement);
    }

    const unparenthesizedObjectPathCase = `      or case
        when object_entry.slot_name = 'page' then`;
    expect(expected).toContain(unparenthesizedObjectPathCase);
    expected = expected
      .replace(
        unparenthesizedObjectPathCase,
        `      or (case
        when object_entry.slot_name = 'page' then`,
      )
      .replace(
        `        else true
      end
  ) then`,
        `        else true
      end)
  ) then`,
      );

    expect(updatedBindingFunction).toBe(expected);
    expect(updatedBindingFunction).not.toMatch(/^\s+or case$/mu);
    expect(updatedBindingFunction).not.toContain(
      "if v_expansion_page_count <> 0",
    );
  });

  it("keeps every expansion pair fail-closed and independently hash-bound", () => {
    for (const contract of [
      "v_expansion_page_count <> v_expansion_layout_count",
      "p_metadata ->> 'expansion_state_count' is distinct from",
      "p_metadata -> 'expansion_state_screenshots'",
      "p_object_keys ? (slot.slot_name || '_layout')",
      "> v_expansion_page_count",
      "p_object_keys ? pg_catalog.regexp_replace(slot.slot_name, '_layout$', '')",
      "state.value ->> 'state_id' is distinct from",
      "state.value #>> '{text_geometry,geometry_hash}'",
      "state.value #>> '{text_geometry,screenshot,image_hash}'",
      "'expansion_state_' || expected.suffix",
      "'sha256'",
      "state.value ->> 'image_hash'",
      "'byte_length'",
      "state.value ->> 'page_bytes'",
      "binding.value ->> 'hash_mode' is distinct from 'raw_sha256'",
      "binding.slot_name ~ '^expansion_state_[0-9]{2}_layout$'",
      "v_max_safe_integer constant numeric := 9007199254740991",
      "(binding.value ->> 'byte_length')::numeric > v_max_safe_integer",
      "(state.value ->> 'page_bytes')::numeric > v_max_safe_integer",
      "(state.value ->> 'text_length')::numeric > v_max_safe_integer",
      "awardping.capture-retained-artifact-projection.v1",
      "'{retained_artifact_projection,authoritative,expansion_state_count}'",
    ]) {
      expect(updatedBindingFunction).toContain(contract);
    }
  });

  it("preserves explicit main-layout unavailability and private privileges", () => {
    for (const contract of [
      "p_hashes ->> 'layout_hash'",
      "p_metadata ->> 'layout_hash'",
      "p_metadata #>> '{text_geometry,geometry_hash}'",
      "p_metadata #>> '{text_geometry,screenshot,image_hash}'",
      "p_metadata #>> '{text_geometry,file}'",
      "p_metadata #>> '{text_geometry,screenshot,image_ref}'",
      "p_metadata #> '{text_geometry,node_count}'",
      "p_metadata #> '{text_geometry,run_count}'",
      "p_metadata #>> '{text_geometry,availability_status}'",
      "p_metadata #>> '{text_geometry,unavailable_reason}'",
      "'{localization,status}' =\n          'evidence_only_geometry_unavailable'",
      "'{localization,exact}' is distinct from\n        'false'::jsonb",
      "'{localization,geometry_ready}' is distinct from\n        'false'::jsonb",
      "'{localization,accounted_for}' is distinct from\n        'true'::jsonb",
      "'{localization,unavailable_reason}'",
      "'{localization,geometry_hash}'",
      "'{localization,bound_image_hash}'",
    ]) {
      expect(updatedBindingFunction).toContain(contract);
    }

    expect(migration).toMatch(
      /revoke all on function private\.stage1_manifest_source_capture_binding_valid\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).not.toMatch(/^\s*(?:create|alter|drop)\s+table\b/im);
    expect(migration).not.toMatch(/^\s*(?:insert|update|delete)\s+/im);
    expect(migration).not.toMatch(/grant execute/i);
  });
});
