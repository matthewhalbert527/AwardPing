import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260810194427_complete_published_event_r2_reference_graph.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(signature, revokeSignature) {
  const start = migration.indexOf(`create or replace function ${signature}`);
  const end = migration.indexOf(`revoke all on function ${revokeSignature}`, start);
  if (start < 0 || end <= start) return "";
  return migration.slice(start, end);
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSql(value) {
  return compact(value)
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ");
}

function sqlOutsideFunctionDefinitions(value) {
  return value.replace(
    /create\s+or\s+replace\s+function\b[\s\S]*?\bas\s+(\$[A-Za-z0-9_]*\$)[\s\S]*?\1\s*;/gi,
    "",
  );
}

const eventBinding = functionBody(
  "private.stage1_published_event_r2_reference_binding_valid(",
  "private.stage1_published_event_r2_reference_binding_valid(",
);
const recursiveReferenceAudit = functionBody(
  "private.stage1_jsonb_r2_reference_key_count(",
  "private.stage1_jsonb_r2_reference_key_count(",
);
const captureReferenceGraph = functionBody(
  "private.stage1_published_capture_reference_graph_valid(",
  "private.stage1_published_capture_reference_graph_valid(",
);
const objectSet = functionBody(
  "private.stage1_visual_r2_object_set_snapshot()",
  "private.stage1_visual_r2_object_set_snapshot()",
);
const manifest = functionBody(
  "public.get_stage1_release_r2_verification_manifest()",
  "public.get_stage1_release_r2_verification_manifest()",
);
const recoveryEvidenceMatcher = functionBody(
  "private.stage1_r2_recovery_evidence_matches_snapshot(",
  "private.stage1_r2_recovery_evidence_matches_snapshot(",
);
const artifactValidator = functionBody(
  "private.stage1_release_artifact_evidence_valid(",
  "private.stage1_release_artifact_evidence_valid(",
);
const r2Recorder = functionBody(
  "public.record_stage1_r2_recovery_drill_artifact(",
  "public.record_stage1_r2_recovery_drill_artifact(",
);
const cropCoverageSnapshot = functionBody(
  "private.stage1_visual_crop_coverage_snapshot()",
  "private.stage1_visual_crop_coverage_snapshot()",
);
const cropDerivationHash = functionBody(
  "private.stage1_visual_crop_derivation_contract_hash()",
  "private.stage1_visual_crop_derivation_contract_hash()",
);
const cropRecorder = functionBody(
  "public.record_stage1_visual_crop_coverage_artifact(",
  "public.record_stage1_visual_crop_coverage_artifact(",
);
const effectivePublication = functionBody(
  "public.list_stage1_effective_publication()",
  "public.list_stage1_effective_publication()",
);
const releaseGate = functionBody(
  "private.stage1_release_gate_snapshot(",
  "private.stage1_release_gate_snapshot(",
);

describe("complete published-event R2 reference graph migration", () => {
  it("enumerates every fixed, state, and crop-source reference on both sides", () => {
    expect(objectSet).not.toBe("");
    expect(objectSet).toContain("event.previous_capture");
    expect(objectSet).toContain("event.current_capture");

    for (const role of [
      "full",
      "metadata",
      "crop",
      "layout",
      "main_full",
      "thumbnail",
      "text",
    ]) {
      expect(objectSet, role).toContain(`'${role}'`);
      expect(objectSet, role).toContain(`capture -> '${role}'`);
      expect(objectSet, role).toContain(`$.${role}.object_key`);
    }

    for (const contract of [
      "capture -> 'states'",
      "jsonb_array_elements",
      "with ordinality",
      "state.image",
      "state.geometry",
      "$.states[%s].%s.object_key",
      "'image'::text",
      "'geometry'::text",
      "crop.source_image",
      "source_image_object_key",
      "source_image_sha256",
      "source_image_byte_length",
      "$.crop.source_image_object_key",
    ]) {
      expect(objectSet).toContain(contract);
    }
  });

  it("rejects incomplete or unsafe published capture graphs", () => {
    expect(captureReferenceGraph).not.toBe("");
    for (const contract of [
      "if p_capture ->> 'kind' = 'webpage' then",
      "elsif p_capture ->> 'kind' = 'pdf' then",
      "elsif p_capture ->> 'kind' = 'first_observation_attestation' then",
      "p_capture -> 'full'",
      "p_capture -> 'metadata'",
      "p_capture -> 'main_full'",
      "p_capture -> 'thumbnail'",
      "p_capture -> 'text'",
      "p_capture -> 'layout'",
      "p_capture -> 'states'",
      "p_capture -> 'attestation'",
      "'attestation'",
      "pg_catalog.jsonb_array_length(p_capture -> 'states') < 1",
      "pg_catalog.jsonb_typeof(v_state -> 'image') is distinct from 'object'",
      "pg_catalog.jsonb_typeof(v_state -> 'geometry') is distinct from 'object'",
      "^[A-Za-z0-9._-]+$",
    ]) {
      expect(captureReferenceGraph, contract).toContain(contract);
    }
    expect(eventBinding).toContain("coalesce(p_state_id, '') ~ '^[A-Za-z0-9._-]+$'");
    expect(eventBinding).toContain("coalesce(p_state_id, '') !~ '^[A-Za-z0-9._-]+$'");
    expect(eventBinding).toContain("return coalesce(");
    expect(objectSet).toMatch(
      /stage1_published_capture_reference_graph_valid\([\s\S]{0,100}\) is not true/,
    );
    expect(objectSet).toMatch(
      /stage1_published_event_r2_reference_binding_valid\([\s\S]{0,800}\) is not true/,
    );
  });

  it("normalizes exact bucket/key aliases while retaining deterministic references", () => {
    const normalized = compact(objectSet);
    expect(objectSet).not.toContain("pg_catalog.greatest(");
    expect(objectSet).toContain("greatest(");
    for (const contract of [
      "reference_count",
      "references",
      "visual_reference_count",
      "alias_reference_count",
      "aliased_object_count",
      "inconsistent_alias_count",
      "reference_set_hash",
      "visual_object_set_hash",
    ]) {
      expect(objectSet).toContain(contract);
    }

    expect(normalized).toMatch(
      /group by [^;]*object[^;]*\.bucket\s*,\s*[^;]*object[^;]*\.object_key/,
    );
    expect(normalized).toMatch(/jsonb_agg\([^;]*order by[^;]*\)/);
    expect(normalized).toMatch(/'references'\s*,/);
    expect(normalized).toMatch(/'reference_count'\s*,/);

    // Aliases are expected in raw references. Only inconsistent claims or a
    // duplicate in the canonical object payload are release failures.
    expect(objectSet).not.toMatch(
      /having\s+pg_catalog\.count\(\*\)\s*>\s*1[\s\S]{0,500}malformed_object_count/i,
    );
    expect(objectSet).toContain("duplicate_object_key_count");
  });

  it("fails closed on unknown recursive object-key references", () => {
    expect(recursiveReferenceAudit).not.toBe("");
    expect(recursiveReferenceAudit).toMatch(/with\s+recursive/i);
    expect(recursiveReferenceAudit).toContain("jsonb_each");
    expect(recursiveReferenceAudit).toContain("jsonb_array_elements");
    expect(recursiveReferenceAudit).toContain("entry.key = 'object_key'");
    expect(recursiveReferenceAudit).toContain("'_object_key'");
    expect(objectSet).toContain("unclassified_reference_count");
    expect(objectSet).toContain("logical_path");

    // The key-only crop source is classified explicitly; all other recursively
    // discovered object-key paths must be accounted for or close the manifest.
    expect(objectSet).toContain("source_image_object_key");
    expect(objectSet).toContain("recursive_reference_key_count");
    expect(objectSet).toContain("classified_reference_key_count");
    expect(objectSet).toMatch(
      /recursive_reference_key_count\s*-\s*[\s\S]{0,100}classified_reference_key_count/,
    );
  });

  it("retains suppressed published evidence in the permanent recovery set", () => {
    expect(objectSet).toContain("event.suppressed_at");
    expect(objectSet).toContain("suppressed");
    expect(objectSet).toContain("evidence.visual_review_candidate_id is not null");
    expect(objectSet).toContain("historical_artifact_unrecoverable");
    expect(objectSet).not.toMatch(
      /where\s+event\.suppressed_at\s+is\s+null/i,
    );
    expect(objectSet).not.toMatch(
      /and\s+event\.suppressed_at\s+is\s+null/i,
    );
  });

  it("publishes a v4 canonical-object manifest with complete object and reference counts", () => {
    for (const contract of [
      "awardping.stage1.r2-verification-manifest.v4",
      "reference_schema",
      "awardping.r2.canonical-object-references.v1",
      "artifact_bindings_schema",
      "awardping.r2.capture-artifact-bindings.v1",
      "visual_object_count",
      "visual_reference_count",
      "published_event_object_count",
      "published_event_reference_count",
      "manifest_source_object_count",
      "manifest_source_reference_count",
      "alias_reference_count",
      "aliased_object_count",
      "inconsistent_alias_count",
      "unclassified_reference_count",
      "reference_set_hash",
      "visual_object_set_hash",
      "unexpected_bucket_count",
      "malformed_object_count",
      "manifest_binding_error_count",
      "duplicate_object_key_count",
      "objects",
    ]) {
      expect(manifest, contract).toContain(contract);
    }

    for (const field of [
      "bucket",
      "scope",
      "source_id",
      "candidate_id",
      "storage_role",
      "object_key",
      "sha256",
      "hash_mode",
      "byte_length",
      "semantic_length",
      "content_type",
      "reference_count",
      "references",
    ]) {
      expect(objectSet, field).toContain(`'${field}'`);
    }

    for (const field of [
      "scope",
      "change_event_id",
      "source_id",
      "candidate_id",
      "side",
      "role",
      "logical_path",
      "state_id",
      "state_kind",
      "suppressed",
    ]) {
      expect(objectSet, `reference.${field}`).toContain(`'${field}'`);
    }
  });

  it("binds physical roles and logical references to exact candidate, side, MIME, and extension", () => {
    expect(eventBinding).not.toBe("");
    for (const contract of [
      "p_source_id is not null",
      "p_candidate_id is null",
      "p_side_name is null",
      "nullif(pg_catalog.btrim(p_logical_role), '') is null",
      "nullif(pg_catalog.btrim(p_object_key), '') is null",
      "nullif(pg_catalog.btrim(p_content_type), '') is null",
      "previous",
      "current",
      "p_candidate_id::text",
      "p_side_name",
      "p_sha256",
      "^[0-9a-f]{64}$",
      "raw_sha256",
      "main-full",
      "state-",
      "changed-section-crop",
      "thumbnail",
      "geometry-",
      "metadata",
      "recovery-metadata",
      "first-observation-attestation",
      "document",
      "text",
      "image/jpeg",
      "application/pdf",
      "application/json; charset=utf-8",
      "text/plain; charset=utf-8",
      "p_content_type is distinct from 'image/jpeg'",
      "p_content_type is distinct from 'application/json; charset=utf-8'",
      "p_content_type is distinct from 'text/plain; charset=utf-8'",
      "v_extension := 'jpg'",
      "v_extension := 'pdf'",
      "v_extension := 'json'",
      "v_extension := 'txt'",
    ]) {
      expect(eventBinding, contract).toContain(contract);
    }

    for (const contract of [
      "change_event_id",
      "candidate_id",
      "side",
      "role",
      "logical_path",
      "state_id",
      "state_kind",
      "crop.source_image",
      "state.image",
      "state.geometry",
    ]) {
      expect(objectSet, contract).toContain(contract);
    }
  });

  it("preserves the existing immutable manifest-source contract", () => {
    for (const contract of [
      "private.stage1_manifest_source_capture_binding_valid(",
      "snapshot.latest_object_keys",
      "snapshot.latest_hashes",
      "snapshot.latest_metadata",
      "jsonb_each_text(source.object_keys)",
      "artifact_bindings",
      "manifest_source",
      "$.object_keys.",
      "page[.]jpg",
      "thumb[.]jpg",
      "document[.]pdf",
      "text[.]txt",
      "layout[.]json",
      "meta[.]json",
      "expansion-state-[0-9]{2}",
      "raw_sha256",
    ]) {
      expect(objectSet, contract).toContain(contract);
    }
  });

  it("uses one fail-closed v4 evidence matcher in the artifact validator", () => {
    expect(recoveryEvidenceMatcher).not.toBe("");
    for (const contract of [
      "awardping.stage1.r2-recovery-drill.v1",
      "awardping.r2.canonical-object-references.v1",
      "r2_full_get_sha256_v1",
      "db_manifest_declared_hash_modes_v1",
      "hash_verified",
      "failed_objects",
      "refused_objects",
      "failure_count",
      "failure_set_hash",
      "visual_object_set_hash",
      "reference_set_hash",
      "unexpected_bucket_count",
      "malformed_object_count",
      "manifest_binding_error_count",
      "duplicate_object_key_count",
      "reference_binding_error_count",
      "inconsistent_alias_count",
      "unclassified_reference_count",
      "visual_objects_checked",
      "visual_references_checked",
      "published_event_objects_checked",
      "published_event_references_checked",
      "manifest_source_objects_checked",
      "manifest_source_references_checked",
      "alias_references_checked",
      "aliased_objects_checked",
    ]) {
      expect(recoveryEvidenceMatcher, contract).toContain(contract);
    }
    expect(recoveryEvidenceMatcher).toContain(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(recoveryEvidenceMatcher).toContain(
      "pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'",
    );
    expect(recoveryEvidenceMatcher).toContain(
      "pg_catalog.jsonb_typeof(p_snapshot) is distinct from 'object'",
    );
    for (const field of [
      "unexpected_bucket_count",
      "malformed_object_count",
      "manifest_binding_error_count",
      "duplicate_object_key_count",
      "reference_binding_error_count",
      "inconsistent_alias_count",
      "unclassified_reference_count",
    ]) {
      expect(recoveryEvidenceMatcher).toContain(
        `p_snapshot ->> '${field}' is distinct from '0'`,
      );
    }
    expect(recoveryEvidenceMatcher).toContain(
      "coalesce(p_snapshot ->> 'visual_object_set_hash', '') !~",
    );
    expect(recoveryEvidenceMatcher).toContain(
      "coalesce(p_snapshot ->> 'reference_set_hash', '') !~",
    );
    for (const invariant of [
      "v_visual_objects = v_published_objects + v_source_objects",
      "v_visual_references = v_published_references + v_source_references",
      "v_alias_references = v_visual_references - v_visual_objects",
      "p_evidence ->> 'visual_object_set_hash' =",
      "p_evidence ->> 'reference_set_hash' =",
    ]) {
      expect(recoveryEvidenceMatcher, invariant).toContain(invariant);
    }
    expect(recoveryEvidenceMatcher).toContain("exception when others then");
    expect(recoveryEvidenceMatcher).toContain("immutable");
    expect(recoveryEvidenceMatcher).toContain("set search_path = ''");

    expect(artifactValidator).not.toBe("");
    for (const contract of [
      "private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(",
      "when 'r2_recovery_drill' then",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "when 'visual_crop_coverage' then",
      "awardping.r2.canonical-object-references.v1",
      "visual_object_count",
      "visual_reference_count",
      "published_event_object_count",
      "published_event_reference_count",
      "manifest_source_object_count",
      "manifest_source_reference_count",
      "alias_reference_count",
      "aliased_object_count",
      "reference_set_hash",
      "visual_object_set_hash",
      "unexpected_bucket_count', 0",
      "malformed_object_count', 0",
      "manifest_binding_error_count', 0",
      "duplicate_object_key_count', 0",
      "reference_binding_error_count', 0",
      "inconsistent_alias_count', 0",
      "unclassified_reference_count', 0",
    ]) {
      expect(artifactValidator, contract).toContain(contract);
    }
    expect(artifactValidator).toContain("immutable");
    expect(artifactValidator).toContain("set search_path = ''");
  });

  it("binds passed R2 recovery artifacts to the current app revision and v4 graph", () => {
    expect(r2Recorder).not.toBe("");
    for (const contract of [
      "security definer",
      "set search_path = ''",
      "if p_status = 'passed' then",
      "private.stage1_current_valid_release_artifact(",
      "'hosted_runtime_identity'",
      "v_runtime.app_revision <> pg_catalog.btrim(p_app_revision)",
      "private.stage1_visual_r2_object_set_snapshot()",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "private.insert_stage1_external_release_artifact(",
      "'r2_recovery_drill'",
      "'production'",
    ]) {
      expect(r2Recorder, contract).toContain(contract);
    }
    expect(r2Recorder).toContain(
      "R2 proof did not verify the complete current Stage 1 canonical object-reference graph.",
    );
  });

  it("propagates the v4 graph through crop snapshot, hash, and recorder evidence", () => {
    expect(cropCoverageSnapshot).not.toBe("");
    for (const contract of [
      "private.stage1_crop_coverage_pre_r2_graph_20260810184524()",
      "private.stage1_visual_r2_object_set_snapshot()",
      "awardping.r2.canonical-object-references.v1",
      "visual_object_count",
      "visual_reference_count",
      "published_event_object_count",
      "published_event_reference_count",
      "manifest_source_object_count",
      "manifest_source_reference_count",
      "alias_reference_count",
      "aliased_object_count",
      "reference_set_hash",
      "visual_object_set_hash",
    ]) {
      expect(cropCoverageSnapshot, contract).toContain(contract);
    }
    expect(cropCoverageSnapshot).toContain("security definer");
    expect(cropCoverageSnapshot).toContain("set search_path = ''");

    expect(cropDerivationHash).not.toBe("");
    for (const contract of [
      "public.stage1_publication_evidence_hash(",
      "awardping.stage1.visual-crop-db-derivation.v3",
      "unsuppressed_stage1_change_events",
      "visual-event-evidence-v2-exact-text-overlap",
      "candidate-bound-not-applicable-pdf",
      "current-signed-r2-canonical-object-reference-graph-v4",
    ]) {
      expect(cropDerivationHash, contract).toContain(contract);
    }
    expect(cropDerivationHash).toContain("security definer");
    expect(cropDerivationHash).toContain("set search_path = ''");

    expect(cropRecorder).not.toBe("");
    for (const contract of [
      "security definer",
      "set search_path = ''",
      "v_target ->> 'configured' <> 'true'",
      "'hosted_runtime_identity'",
      "v_runtime.completed_at < v_now - interval '1 hour'",
      "private.stage1_visual_r2_object_set_snapshot()",
      "'r2_recovery_drill'",
      "artifact.app_revision = v_runtime.app_revision",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "private.stage1_visual_crop_coverage_snapshot()",
      "awardping.stage1.database-derived-release-evidence.v2",
      "private.stage1_visual_crop_derivation_contract_hash()",
      "r2_hashes_verified",
      "r2_artifact_id",
      "unverified_publishable_events",
      "terminal_failures",
      "pdf_evidence_failures",
      "insert into public.stage1_release_acceptance_artifacts",
      "public.stage1_publication_evidence_hash(v_evidence)",
    ]) {
      expect(cropRecorder, contract).toContain(contract);
    }
  });

  it("makes effective publication and the canonical release gate fail closed on stale v4 evidence", () => {
    expect(effectivePublication).not.toBe("");
    for (const contract of [
      "public.stage1_effective_pub_pre_r2_graph_20260810184524()",
      "private.stage1_visual_r2_object_set_snapshot()",
      "private.stage1_current_valid_release_artifact(",
      "'hosted_runtime_identity'",
      "'r2_recovery_drill'",
      "'visual_crop_coverage'",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "private.stage1_visual_crop_coverage_snapshot()",
      "private.stage1_visual_crop_derivation_contract_hash()",
      "artifact.producer_kind = 'database_derived'",
      "artifact.app_revision = runtime.app_revision",
      "artifact.evidence ->> 'r2_artifact_id' = r2.id::text",
      "base.effectively_verified",
      "and r2_release_proof.current",
      "and crop_release_proof.current",
      "signed_r2_recovery_artifact_not_current",
      "database_derived_crop_artifact_not_current",
      "stable",
      "security definer",
      "set search_path = ''",
    ]) {
      expect(effectivePublication, contract).toContain(contract);
    }
    expect(effectivePublication).not.toContain(
      "private.stage1_release_gate_snapshot(",
    );

    expect(releaseGate).not.toBe("");
    for (const contract of [
      "private.stage1_gate_without_contact_fence_20260717123000(",
      "private.personal_data_legacy_contact_gate_snapshot()",
      "private.stage1_vault_access_contract_safe()",
      "vault_profile_http_status",
      "vault_profile_postgrest_code",
      "vault_profile_exposed",
      "vault_profile_redirected",
      "v_failures := v_failures - 'vault_access_contract_failed'",
      "'vault_security', pg_catalog.jsonb_build_object(",
      "private.stage1_visual_r2_object_set_snapshot()",
      "private.stage1_visual_crop_coverage_snapshot()",
      "'hosted_runtime_identity'",
      "'r2_recovery_drill'",
      "'visual_crop_coverage'",
      "v_r2.app_revision = v_runtime.app_revision",
      "private.stage1_r2_recovery_evidence_matches_snapshot(",
      "v_r2_bound := coalesce((",
      "v_crop_bound := coalesce((",
      "v_crop.producer_kind = 'database_derived'",
      "v_crop.app_revision = v_runtime.app_revision",
      "private.stage1_visual_crop_derivation_contract_hash()",
      "v_crop.evidence ->> 'r2_hashes_verified' = 'true'",
      "v_crop.evidence ->> 'r2_artifact_id' = v_r2.id::text",
      "signed_r2_recovery_or_object_set_failed",
      "database_derived_exact_crop_coverage_failed",
      "release_artifact_set_failed",
      "legacy_contact_ciphertext_not_safe",
      "v_contact ->> 'state' is distinct from 'SAFE'",
      "inherited_release_gate_invalid",
      "pg_catalog.jsonb_typeof(v_inner) is distinct from 'object'",
      "v_inner := '{}'::jsonb",
      "when pg_catalog.jsonb_array_length(v_failures) = 0 then 'READY'",
      "else 'HOLD'",
      "public.stage1_publication_evidence_hash(v_basis)",
      "security definer",
      "set search_path = ''",
    ]) {
      expect(releaseGate, contract).toContain(contract);
    }
    for (const field of [
      "reference_schema",
      "visual_object_count",
      "visual_reference_count",
      "published_event_object_count",
      "published_event_reference_count",
      "manifest_source_object_count",
      "manifest_source_reference_count",
      "alias_reference_count",
      "aliased_object_count",
      "reference_set_hash",
      "visual_object_set_hash",
    ]) {
      expect(releaseGate, field).toContain(`v_crop.evidence ->> '${field}'`);
    }
  });

  it("is a forward-only function replacement with hardened private and service-role ACLs", () => {
    const topLevelSql = sqlOutsideFunctionDefinitions(migration);
    const aclSql = normalizeSql(migration);
    const executeGrants = migration.match(/grant\s+execute\b[^;]*;/gi) ?? [];
    expect(migration).not.toMatch(/^\s*(?:create|alter|drop)\s+table\b/im);
    expect(topLevelSql).not.toMatch(/^\s*(?:insert|update|delete)\s+/im);
    expect(executeGrants.length).toBeGreaterThan(0);
    for (const grant of executeGrants) {
      expect(grant).not.toMatch(/\bto\s+(?:public|anon|authenticated)\b/i);
      expect(grant).toMatch(/\bto\s+service_role\b/i);
    }

    expect(recursiveReferenceAudit).toContain("immutable");
    expect(recursiveReferenceAudit).toContain("set search_path = ''");
    expect(captureReferenceGraph).toContain("immutable");
    expect(captureReferenceGraph).toContain("set search_path = ''");
    expect(eventBinding).toContain("immutable");
    expect(eventBinding).toContain("set search_path = ''");
    expect(objectSet).toContain("stable");
    expect(objectSet).toContain("security definer");
    expect(objectSet).toContain("set search_path = ''");
    expect(manifest).toContain("stable");
    expect(manifest).toContain("security definer");
    expect(manifest).toContain("set search_path = ''");

    expect(migration).toMatch(
      /revoke all on function private\.stage1_jsonb_r2_reference_key_count\(jsonb\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_published_capture_reference_graph_valid\(jsonb\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_published_event_r2_reference_binding_valid\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function private\.stage1_visual_r2_object_set_snapshot\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.get_stage1_release_r2_verification_manifest\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_stage1_release_r2_verification_manifest\(\)\s+to service_role;/,
    );

    const internalFunctions = [
      "private.stage1_jsonb_r2_reference_key_count(jsonb)",
      "private.stage1_published_capture_reference_graph_valid(jsonb)",
      "private.stage1_published_event_r2_reference_binding_valid(uuid, uuid, text, text, text, text, text, text, text, text, text, text)",
      "private.stage1_visual_r2_object_set_snapshot()",
      "private.stage1_r2_recovery_evidence_matches_snapshot(jsonb, jsonb)",
      "private.stage1_crop_coverage_pre_r2_graph_20260810184524()",
      "private.stage1_visual_crop_coverage_snapshot()",
      "private.stage1_visual_crop_derivation_contract_hash()",
      "private.stage1_release_artifact_valid_pre_r2_graph_20260810184524(text, jsonb)",
      "private.stage1_release_artifact_evidence_valid(text, jsonb)",
      "public.stage1_effective_pub_pre_r2_graph_20260810184524()",
      "private.stage1_release_gate_snapshot(timestamptz)",
    ];
    for (const signature of internalFunctions) {
      expect(aclSql, signature).toContain(
        `revoke all on function ${signature} from public, anon, authenticated, service_role;`,
      );
      expect(aclSql, signature).not.toContain(
        `grant execute on function ${signature}`,
      );
    }

    const serviceRoleEntrypoints = [
      "public.get_stage1_release_r2_verification_manifest()",
      "public.record_stage1_r2_recovery_drill_artifact(text, text, jsonb, text, text, text, text, timestamptz, timestamptz, timestamptz, text)",
      "public.record_stage1_visual_crop_coverage_artifact(text)",
      "public.list_stage1_effective_publication()",
    ];
    for (const signature of serviceRoleEntrypoints) {
      expect(aclSql, signature).toContain(
        `revoke all on function ${signature} from public, anon, authenticated, service_role;`,
      );
      expect(aclSql, signature).toContain(
        `grant execute on function ${signature} to service_role;`,
      );
    }
  });
});
