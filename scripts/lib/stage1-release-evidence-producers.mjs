import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const stage1ReleaseEvidenceProducerContract =
  "awardping.stage1.release-evidence-producer.v2";
export const stage1ReleaseEvidenceProducerSourceSha256 = sha256(
  readFileSync(fileURLToPath(import.meta.url)),
);

const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateStage1ReleaseProducerTarget(value) {
  const target = objectValue(value);
  if (
    target.schema_version !== "awardping.stage1.production-target.v1" ||
    target.configured !== true ||
    target.release_key !== "stage1-national-25" ||
    !Number.isSafeInteger(target.config_version) ||
    Number(target.config_version) < 1 ||
    !sha256Pattern.test(cleanText(target.target_config_hash))
  ) {
    throw new Error("The database did not return a configured Stage 1 production target.");
  }

  const appOrigin = exactHttpsOrigin(target.app_origin, "production app origin");
  const supabaseOrigin = exactHttpsOrigin(target.supabase_origin, "Supabase origin");
  const supabaseProjectRef = cleanText(target.supabase_project_ref);
  if (
    !/^[a-z0-9]{20}$/.test(supabaseProjectRef) ||
    supabaseOrigin !== `https://${supabaseProjectRef}.supabase.co`
  ) {
    throw new Error("The database production target has an invalid Supabase project identity.");
  }

  const deploymentProvider = cleanText(target.deployment_provider);
  const deploymentProjectId = cleanText(target.deployment_project_id);
  const deploymentTeamSlug = cleanText(target.deployment_team_slug);
  const r2AccountId = cleanText(target.r2_account_id);
  const r2Bucket = cleanText(target.r2_bucket);
  if (
    deploymentProvider !== "vercel" ||
    deploymentProjectId.length < 8 ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(deploymentTeamSlug) ||
    !/^[a-f0-9]{32}$/.test(r2AccountId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(r2Bucket)
  ) {
    throw new Error("The database production target has an invalid deployment or R2 identity.");
  }

  return Object.freeze({
    schemaVersion: target.schema_version,
    releaseKey: target.release_key,
    configVersion: Number(target.config_version),
    targetConfigHash: cleanText(target.target_config_hash),
    appOrigin,
    supabaseOrigin,
    supabaseProjectRef,
    deploymentProvider,
    deploymentProjectId,
    deploymentTeamSlug,
    r2AccountId,
    r2Bucket,
  });
}

export async function measureStage1HostedRuntimeIdentity({
  target: targetValue,
  supabaseAnonKey,
  supabaseServiceRoleKey,
  fetchImpl = globalThis.fetch,
  measuredAt = new Date().toISOString(),
  measurementId = randomUUID(),
} = {}) {
  const target = validateStage1ReleaseProducerTarget(targetValue);
  assertMeasurementIdentity({ measuredAt, measurementId });
  const anonKey = cleanText(supabaseAnonKey);
  const serviceRoleKey = cleanText(supabaseServiceRoleKey);
  if (!anonKey) throw new Error("A production Supabase anon key is required for the Auth probe.");
  if (!serviceRoleKey) {
    throw new Error("A production Supabase service key is required for the Vault Data API probe.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const identityUrl = `${target.appOrigin}/api/monitoring-policy-identity`;
  const authSettingsUrl = `${target.supabaseOrigin}/auth/v1/settings`;
  const vaultProfileUrl =
    `${target.supabaseOrigin}/rest/v1/decrypted_secrets?select=id&limit=1`;
  const [identityResponse, authResponse, vaultProfileResponse] = await Promise.all([
    fetchJsonWithoutRedirect(identityUrl, {
      fetchImpl,
      headers: { accept: "application/json" },
    }),
    fetchJsonWithoutRedirect(authSettingsUrl, {
      fetchImpl,
      headers: {
        accept: "application/json",
        apikey: anonKey,
      },
    }),
    fetchJsonWithoutRedirect(vaultProfileUrl, {
      fetchImpl,
      headers: {
        accept: "application/json",
        "accept-profile": "vault",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
    }),
  ]);
  const identity = objectValue(identityResponse.json);
  const auth = objectValue(authResponse.json);
  if (
    identityResponse.status !== 200 ||
    identity.schemaVersion !== "monitoring-promotion-app-identity-v1" ||
    !cleanText(identity.revision) ||
    !cleanText(identity.policy_hash) ||
    !cleanText(identity.batch_policy_hash) ||
    !cleanText(identity.suppression_policy_hash) ||
    !sha256Pattern.test(cleanText(identity.matcher_hash))
  ) {
    throw new Error("The exact production identity endpoint returned invalid runtime identity evidence.");
  }
  if (authResponse.status !== 200 || auth.disable_signup !== true) {
    throw new Error("The exact production Supabase Auth project does not report disable_signup=true.");
  }
  if (
    vaultProfileResponse.status !== 406 ||
    objectValue(vaultProfileResponse.json).code !== "PGRST106"
  ) {
    throw new Error(
      "The production service key was not denied access to the Vault Data API profile.",
    );
  }

  const evidence = {
    ...producerEnvelope(target, { measuredAt, measurementId }),
    schema_version: "awardping.stage1.hosted-runtime-identity.v2",
    measurement_method: "direct_no_redirect_https_and_vault_profile_get_v2",
    base_url: target.appOrigin,
    identity_url: identityUrl,
    auth_settings_url: authSettingsUrl,
    vault_profile_url: vaultProfileUrl,
    deployment_provider: target.deploymentProvider,
    deployment_project_id: target.deploymentProjectId,
    app_revision: cleanText(identity.revision),
    policy_hash: cleanText(identity.policy_hash),
    batch_policy_hash: cleanText(identity.batch_policy_hash),
    suppression_policy_hash: cleanText(identity.suppression_policy_hash),
    matcher_hash: cleanText(identity.matcher_hash),
    disable_signup: true,
    identity_http_status: identityResponse.status,
    auth_http_status: authResponse.status,
    vault_profile_http_status: vaultProfileResponse.status,
    vault_profile_postgrest_code: "PGRST106",
    vault_profile_exposed: false,
    identity_redirected: false,
    auth_redirected: false,
    vault_profile_redirected: false,
    identity_response_sha256: identityResponse.sha256,
    auth_response_sha256: authResponse.sha256,
    vault_profile_response_sha256: vaultProfileResponse.sha256,
    observed_at: measuredAt,
  };
  return {
    status: "passed",
    appRevision: evidence.app_revision,
    evidence,
    runtimeStateHash: runtimeStateHash(evidence),
  };
}

export async function measureStage1NonCohortLeakCrawl({
  target: targetValue,
  manifest: manifestValue,
  supabaseAnonKey,
  supabaseServiceRoleKey,
  fetchImpl = globalThis.fetch,
  measuredAt = new Date().toISOString(),
  measurementId = randomUUID(),
  concurrency = 6,
} = {}) {
  const target = validateStage1ReleaseProducerTarget(targetValue);
  const manifest = validateLeakManifest(manifestValue, target);
  const runtime = await measureStage1HostedRuntimeIdentity({
    target: targetValue,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    fetchImpl,
    measuredAt,
    measurementId,
  });
  const routes = [
    ...manifest.stage1Routes.map((route) => ({ ...route, group: "stage1" })),
    ...manifest.nonCohortRoutes.map((route) => ({ ...route, group: "non_cohort" })),
  ];
  const observations = await mapWithConcurrency(routes, concurrency, async (route) => {
    const url = `${target.appOrigin}${route.path}`;
    try {
      const response = await fetchCrawlObservation(url, {
        fetchImpl,
        appOrigin: target.appOrigin,
      });
      return {
        group: route.group,
        path: route.path,
        status: response.status,
        redirected: response.redirected,
        redirect_location: response.redirectLocation,
        body_sha256: response.sha256,
        under_verification: /\bunder verification\b/i.test(response.text),
        error_code: null,
      };
    } catch (error) {
      return {
        group: route.group,
        path: route.path,
        status: null,
        redirected: false,
        redirect_location: null,
        body_sha256: null,
        under_verification: false,
        error_code: safeErrorCode(error),
      };
    }
  });
  const stage1 = observations.filter((row) => row.group === "stage1");
  const nonCohort = observations.filter((row) => row.group === "non_cohort");
  const stage1UnderVerification = stage1.filter(
    (row) => row.status === 200 && !row.redirected && row.under_verification,
  ).length;
  const failures = observations
    .map(crawlFailureDiagnostic)
    .filter(Boolean)
    .sort((left, right) => compareFailureKey(
      `${left.group}\n${left.path}`,
      `${right.group}\n${right.path}`,
    ));
  const unexpectedStage1Leaks = failures.filter(
    (row) => row.group === "stage1",
  ).length;
  const nonCohortLeaks = failures.filter(
    (row) => row.group === "non_cohort",
  ).length;
  const failureSetHash = sha256(stableJson(failures.map(crawlFailureIdentity)));
  const responseSetSha256 = sha256(stableJson(observations));
  const passed =
    manifest.stage1Routes.length === 25 &&
    manifest.nonCohortRoutes.length > 0 &&
    unexpectedStage1Leaks === 0 &&
    nonCohortLeaks === 0;

  return {
    status: passed ? "passed" : "failed",
    appRevision: runtime.appRevision,
    evidence: {
      ...producerEnvelope(target, { measuredAt, measurementId }),
      schema_version: "awardping.stage1.non-cohort-leak-crawl.v1",
      measurement_method: "anonymous_exact_origin_crawl_v1",
      anonymous: true,
      redirects_followed: false,
      authorization_header_sent: false,
      cookie_header_sent: false,
      base_url: target.appOrigin,
      routes_checked: observations.length,
      non_cohort_awards_sampled: nonCohort.length,
      stage1_awards_observed: stage1.length,
      stage1_under_verification_pages: stage1UnderVerification,
      non_cohort_leaks: nonCohortLeaks,
      unexpected_stage1_leaks: unexpectedStage1Leaks,
      failure_count: failures.length,
      failure_set_hash: failureSetHash,
      route_manifest_sha256: manifest.routeManifestSha256,
      response_set_sha256: responseSetSha256,
      runtime_identity_response_sha256: runtime.evidence.identity_response_sha256,
    },
    diagnostics: {
      schema_version: "awardping.stage1.non-cohort-leak-diagnostics.v1",
      total_observations: observations.length,
      failure_count: failures.length,
      failure_set_hash: failureSetHash,
      failures,
    },
  };
}

export async function measureStage1R2RecoveryDrill({
  target: targetValue,
  manifest: manifestValue,
  appRevision,
  r2Client,
  measuredAt = new Date().toISOString(),
  measurementId = randomUUID(),
  concurrency = 4,
} = {}) {
  const target = validateStage1ReleaseProducerTarget(targetValue);
  assertMeasurementIdentity({ measuredAt, measurementId });
  const revision = requiredText(appRevision, "A measured production app revision is required");
  if (!r2Client || typeof r2Client.send !== "function") {
    throw new Error("A production R2 client is required.");
  }
  const manifest = validateR2Manifest(manifestValue, target);
  if (manifest.objects.length === 0) {
    throw new Error("The DB-owned Stage 1 R2 manifest is empty; no recovery proof can pass.");
  }

  const observations = await mapWithConcurrency(
    manifest.objects,
    concurrency,
    async (object) => {
      try {
        const response = await r2Client.send(new GetObjectCommand({
          Bucket: target.r2Bucket,
          Key: object.objectKey,
        }));
        const body = await responseBodyBytes(response?.Body);
        const measuredHash = measureR2ObjectHash(body, object);
        const actualSha256 = measuredHash?.sha256 || null;
        const actualLength = body.length;
        const actualContentType = cleanText(response?.ContentType).toLowerCase();
        const expectedContentType = object.contentType.toLowerCase();
        const contentTypeMatches = actualContentType === expectedContentType;
        const verified =
          actualSha256 === object.sha256 &&
          actualLength === object.byteLength &&
          (
            object.semanticLength === null ||
            measuredHash?.semanticLength === object.semanticLength
          ) &&
          contentTypeMatches;
        return {
          object_scope: object.scope,
          source_id: object.sourceId,
          artifact: object.artifact,
          object_key: object.objectKey,
          hash_mode: object.hashMode,
          expected_sha256: object.sha256,
          actual_sha256: actualSha256,
          expected_byte_length: object.byteLength,
          actual_byte_length: actualLength,
          expected_semantic_length: object.semanticLength,
          actual_semantic_length: measuredHash?.semanticLength ?? null,
          expected_content_type: expectedContentType,
          actual_content_type: actualContentType,
          outcome: verified ? "verified" : "mismatch",
        };
      } catch (error) {
        return {
          object_scope: object.scope,
          source_id: object.sourceId,
          artifact: object.artifact,
          object_key: object.objectKey,
          hash_mode: object.hashMode,
          expected_sha256: object.sha256,
          actual_sha256: null,
          expected_byte_length: object.byteLength,
          actual_byte_length: null,
          expected_semantic_length: object.semanticLength,
          actual_semantic_length: null,
          expected_content_type: object.contentType,
          actual_content_type: null,
          outcome: r2AccessRefused(error) ? "refused" : "failed",
          error_code: safeErrorCode(error),
        };
      }
    },
  );
  const recovered = observations.filter((row) => row.outcome === "verified").length;
  const refused = observations.filter((row) => row.outcome === "refused").length;
  const failed = observations.length - recovered - refused;
  const failures = observations
    .filter((row) => row.outcome !== "verified")
    .map(r2FailureDiagnostic)
    .sort((left, right) => compareFailureKey(
      `${left.object_scope}\n${left.source_id || ""}\n${left.artifact}\n${left.object_key}`,
      `${right.object_scope}\n${right.source_id || ""}\n${right.artifact}\n${right.object_key}`,
    ));
  const failureSetHash = sha256(stableJson(failures.map(r2FailureIdentity)));
  const passed = recovered === observations.length && failed === 0 && refused === 0;
  return {
    status: passed ? "passed" : "failed",
    appRevision: revision,
    evidence: {
      ...producerEnvelope(target, { measuredAt, measurementId }),
      schema_version: "awardping.stage1.r2-recovery-drill.v1",
      // Kept at v1 for the immutable acceptance-envelope contract. "sha256"
      // means every object is fully GET and checked with its DB-declared hash
      // mode; it does not mean every expected hash is over unmodified bytes.
      measurement_method: "r2_full_get_sha256_v1",
      hash_mode_contract: "db_manifest_declared_hash_modes_v1",
      r2_account_id: target.r2AccountId,
      r2_bucket: target.r2Bucket,
      r2_endpoint: `https://${target.r2AccountId}.r2.cloudflarestorage.com`,
      hash_verified: passed,
      recovered_objects: recovered,
      failed_objects: failed,
      refused_objects: refused,
      failure_count: failures.length,
      failure_set_hash: failureSetHash,
      visual_objects_checked: observations.length,
      published_event_objects_checked: manifest.publishedEventObjectCount,
      manifest_source_objects_checked: manifest.manifestSourceObjectCount,
      visual_object_set_hash: manifest.visualObjectSetHash,
      recovery_manifest_sha256: sha256(stableJson(observations)),
    },
    diagnostics: {
      schema_version: "awardping.stage1.r2-recovery-diagnostics.v1",
      total_observations: observations.length,
      failure_count: failures.length,
      failure_set_hash: failureSetHash,
      failures,
    },
  };
}

export async function measureStage1RollbackDrill({
  target: targetValue,
  contractStateHash,
  rollbackDeployment,
  restoreDeployment,
  confirmProductionOrigin,
  executeProductionRollback = false,
  deploymentController,
  supabaseAnonKey,
  supabaseServiceRoleKey,
  fetchImpl = globalThis.fetch,
  measuredAt = new Date().toISOString(),
  measurementId = randomUUID(),
  pollAttempts = 60,
  pollIntervalMs = 3_000,
  sleep = defaultSleep,
} = {}) {
  const target = validateStage1ReleaseProducerTarget(targetValue);
  assertMeasurementIdentity({ measuredAt, measurementId });
  if (!executeProductionRollback || cleanText(confirmProductionOrigin) !== target.appOrigin) {
    throw new Error(
      "Rollback measurement requires explicit execution and confirmation of the DB-owned production origin.",
    );
  }
  const rollbackRef = deploymentReference(rollbackDeployment, "rollback deployment");
  const restoreRef = deploymentReference(restoreDeployment, "restore deployment");
  if (rollbackRef === restoreRef) {
    throw new Error("Rollback and restore deployments must be different.");
  }
  if (
    !deploymentController ||
    typeof deploymentController.assertProjectIdentity !== "function" ||
    typeof deploymentController.rollback !== "function" ||
    typeof deploymentController.restore !== "function"
  ) {
    throw new Error("A kind-specific Vercel deployment controller is required.");
  }
  const contractHash = requiredHash(contractStateHash, "release contract state hash");
  await deploymentController.assertProjectIdentity(target);
  const probe = () => measureStage1HostedRuntimeIdentity({
    target: targetValue,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    fetchImpl,
    measuredAt: new Date().toISOString(),
    measurementId: randomUUID(),
  });
  const before = await probe();
  let rollbackResult;
  let rollbackState;
  let restoreResult;
  let restoredState;
  let rollbackRequested = false;
  try {
    rollbackRequested = true;
    rollbackResult = await deploymentController.rollback({
      target,
      deployment: rollbackRef,
    });
    rollbackState = await pollRuntimeState({
      probe,
      predicate: (state) => state.appRevision !== before.appRevision,
      attempts: pollAttempts,
      intervalMs: pollIntervalMs,
      sleep,
      label: "rolled-back production revision",
    });
  } finally {
    if (rollbackRequested) {
      try {
        restoreResult = await deploymentController.restore({
          target,
          deployment: restoreRef,
        });
        restoredState = await pollRuntimeState({
          probe,
          predicate: (state) => state.appRevision === before.appRevision,
          attempts: pollAttempts,
          intervalMs: pollIntervalMs,
          sleep,
          label: "restored production revision",
        });
      } catch (restoreError) {
        throw new Error(
          `EMERGENCY: production rollback was requested but verified restoration failed: ${errorMessage(restoreError)}`,
          { cause: restoreError },
        );
      }
    }
  }
  if (!rollbackState || !restoredState) {
    throw new Error("The rollback drill did not observe both rollback and restoration states.");
  }

  const beforeStateHash = before.runtimeStateHash;
  const rollbackStateHash = rollbackState.runtimeStateHash;
  const restoredStateHash = restoredState.runtimeStateHash;
  const passed =
    rollbackState.appRevision !== before.appRevision &&
    restoredState.appRevision === before.appRevision &&
    rollbackStateHash !== beforeStateHash &&
    restoredStateHash === beforeStateHash;
  return {
    status: passed ? "passed" : "failed",
    appRevision: before.appRevision,
    evidence: {
      ...producerEnvelope(target, { measuredAt, measurementId }),
      schema_version: "awardping.stage1.rollback-drill.v1",
      measurement_method: "vercel_cli_rollback_restore_probe_v1",
      deployment_provider: target.deploymentProvider,
      deployment_project_id: target.deploymentProjectId,
      deployment_team_slug: target.deploymentTeamSlug,
      rollback_deployment: rollbackRef,
      restore_deployment: restoreRef,
      rollback_succeeded: rollbackState.appRevision !== before.appRevision,
      restore_succeeded: restoredState.appRevision === before.appRevision,
      before_revision: before.appRevision,
      rollback_revision: rollbackState.appRevision,
      restored_revision: restoredState.appRevision,
      before_state_hash: beforeStateHash,
      rollback_state_hash: rollbackStateHash,
      restored_state_hash: restoredStateHash,
      rollback_command_sha256: commandResultHash(rollbackResult),
      restore_command_sha256: commandResultHash(restoreResult),
      contract_state_hash: contractHash,
      transition_events_checked: 2,
    },
  };
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function producerEnvelope(target, { measuredAt, measurementId }) {
  assertMeasurementIdentity({ measuredAt, measurementId });
  return {
    producer_contract: stage1ReleaseEvidenceProducerContract,
    producer_source_sha256: stage1ReleaseEvidenceProducerSourceSha256,
    measurement_id: measurementId,
    measured_at: measuredAt,
    target_config_version: target.configVersion,
    target_config_hash: target.targetConfigHash,
    production_app_origin: target.appOrigin,
    supabase_origin: target.supabaseOrigin,
    supabase_project_ref: target.supabaseProjectRef,
  };
}

function validateLeakManifest(value, target) {
  const manifest = objectValue(value);
  const embeddedTarget = validateStage1ReleaseProducerTarget(manifest.target);
  const stage1Routes = arrayValue(manifest.stage1_routes).map(normalizeCrawlRoute);
  const nonCohortRoutes = arrayValue(manifest.non_cohort_routes).map(normalizeCrawlRoute);
  const routeManifestSha256 = requiredHash(
    manifest.route_manifest_sha256,
    "DB-owned route manifest hash",
  );
  if (
    embeddedTarget.targetConfigHash !== target.targetConfigHash ||
    Number(manifest.stage1_route_count) !== stage1Routes.length ||
    Number(manifest.non_cohort_route_count) !== nonCohortRoutes.length ||
    stage1Routes.length !== 25 ||
    nonCohortRoutes.length < 1
  ) {
    throw new Error("The DB-owned anonymous crawl manifest is incomplete or target-mismatched.");
  }
  return { stage1Routes, nonCohortRoutes, routeManifestSha256 };
}

function validateR2Manifest(value, target) {
  const manifest = objectValue(value);
  const embeddedTarget = validateStage1ReleaseProducerTarget(manifest.target);
  const objects = arrayValue(manifest.objects).map((value) => {
    const object = objectValue(value);
    const scope = requiredText(object.scope, "R2 object scope");
    const sourceId = cleanText(object.source_id).toLowerCase() || null;
    const candidateId = cleanText(object.candidate_id).toLowerCase() || null;
    const artifact = requiredText(object.artifact, "R2 object artifact");
    const side = cleanText(object.side);
    const objectKey = requiredText(object.object_key, "R2 object key");
    const bucket = requiredText(object.bucket, "R2 object bucket");
    const objectSha256 = requiredHash(object.sha256, "R2 object SHA-256");
    const byteLength = Number(object.byte_length);
    const hashMode = requiredText(object.hash_mode, "R2 object hash mode");
    const declaredContentType = requiredText(
      object.content_type,
      "R2 object content type",
    );
    const contentType = declaredContentType.toLowerCase();
    const semanticLength = object.semantic_length === null || object.semantic_length === undefined
      ? null
      : Number(object.semantic_length);
    const publishedEvent = scope === "published_event";
    const manifestSource = scope === "manifest_source";
    const sourceUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const sourcePrefix = manifestSource && sourceUuidPattern.test(sourceId || "")
      ? `visual-snapshots/sources/${sourceId}/captures/`
      : null;
    const sourceGenerationMatch = sourcePrefix
      ? objectKey.match(new RegExp(`^${escapeRegExp(sourcePrefix)}([0-9a-f]{32})/`))
      : null;
    const sourceArtifactContract = manifestSourceArtifactContract(artifact);
    const sourceBindingValid = Boolean(
      manifestSource
      && candidateId === null
      && side === "current"
      && sourceGenerationMatch
      && sourceArtifactContract
      && objectKey === `${sourcePrefix}${sourceGenerationMatch[1]}/${sourceArtifactContract.fileName}`
      && !/(^|\/)latest(\/|$)/i.test(objectKey)
      && hashMode === "raw_sha256"
      && semanticLength === null
      && declaredContentType === sourceArtifactContract.contentType
    );
    const eventBindingValid = Boolean(
      publishedEvent
      && sourceId === null
      && uuidPattern.test(candidateId || "")
      && !/(^|\/)latest(\/|$)/i.test(objectKey)
      && hashMode === "raw_sha256"
      && semanticLength === null
      && publishedEventArtifactBindingValid({
        artifact,
        candidateId,
        contentType: declaredContentType,
        objectKey,
        sha256: objectSha256,
        side,
      })
    );
    if (
      bucket !== target.r2Bucket ||
      (!sourceBindingValid && !eventBindingValid) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1
    ) {
      throw new Error("The DB-owned R2 manifest contains an invalid object binding.");
    }
    return {
      scope,
      sourceId,
      candidateId,
      artifact,
      bucket,
      objectKey,
      sha256: objectSha256,
      hashMode,
      byteLength,
      semanticLength,
      contentType,
      generationId: sourceGenerationMatch?.[1] || null,
    };
  });
  const uniqueObjectKeys = new Set(objects.map((object) => `${object.bucket}\n${object.objectKey}`));
  const publishedEventObjectCount = objects.filter(
    (object) => object.scope === "published_event",
  ).length;
  const manifestSourceObjectCount = objects.filter(
    (object) => object.scope === "manifest_source",
  ).length;
  const manifestSourceGroups = new Map();
  for (const object of objects.filter((entry) => entry.scope === "manifest_source")) {
    manifestSourceGroups.set(
      object.sourceId,
      [...(manifestSourceGroups.get(object.sourceId) || []), object],
    );
  }
  const manifestSourceSetsValid = [...manifestSourceGroups.values()]
    .every(manifestSourceObjectSetValid);
  if (
    manifest.schema_version !== "awardping.stage1.r2-verification-manifest.v3" ||
    manifest.artifact_bindings_schema
      !== "awardping.r2.capture-artifact-bindings.v1" ||
    embeddedTarget.targetConfigHash !== target.targetConfigHash ||
    Number(manifest.unexpected_bucket_count) !== 0 ||
    Number(manifest.malformed_object_count) !== 0 ||
    Number(manifest.manifest_binding_error_count) !== 0 ||
    Number(manifest.duplicate_object_key_count) !== 0 ||
    Number(manifest.visual_object_count) !== objects.length ||
    Number(manifest.published_event_object_count) !== publishedEventObjectCount ||
    Number(manifest.manifest_source_object_count) !== manifestSourceObjectCount ||
    uniqueObjectKeys.size !== objects.length ||
    !manifestSourceSetsValid
  ) {
    throw new Error("The DB-owned R2 verification manifest is incomplete or target-mismatched.");
  }
  return {
    objects,
    publishedEventObjectCount,
    manifestSourceObjectCount,
    visualObjectSetHash: requiredHash(
      manifest.visual_object_set_hash,
      "visual object-set hash",
    ),
  };
}

function publishedEventArtifactBindingValid({
  artifact,
  candidateId,
  contentType,
  objectKey,
  sha256,
  side,
}) {
  if (side !== "previous" && side !== "current") return false;
  const prefix = `visual-snapshots/published/${candidateId}/${side}/`;
  if (!objectKey.startsWith(prefix)) return false;
  const match = objectKey.slice(prefix.length).match(
    /^([A-Za-z0-9._-]+)\/([0-9a-f]{64})[.]([a-z0-9]+)$/,
  );
  if (!match || match[2] !== sha256) return false;
  const [, role, , extension] = match;

  switch (artifact) {
    case "full":
      return (
        contentType === "application/pdf"
        && role === "document"
        && extension === "pdf"
      ) || (
        contentType === "image/jpeg"
        && (role === "main-full" || /^state-[A-Za-z0-9._-]+$/.test(role))
        && extension === "jpg"
      );
    case "crop":
      return contentType === "image/jpeg"
        && role === "changed-section-crop"
        && extension === "jpg";
    case "layout":
      return contentType === "application/json; charset=utf-8"
        && /^geometry-[A-Za-z0-9._-]+$/.test(role)
        && extension === "json";
    case "metadata":
      return contentType === "application/json; charset=utf-8"
        && extension === "json"
        && (
          role === "metadata"
          || role === "recovery-metadata"
          || (role === "first-observation-attestation" && side === "previous")
        );
    default:
      return false;
  }
}

function manifestSourceArtifactContract(artifact) {
  const fixed = {
    page: { fileName: "page.jpg", contentType: "image/jpeg" },
    thumb: { fileName: "thumb.jpg", contentType: "image/jpeg" },
    pdf: { fileName: "document.pdf", contentType: "application/pdf" },
    text: { fileName: "text.txt", contentType: "text/plain; charset=utf-8" },
    meta: { fileName: "meta.json", contentType: "application/json; charset=utf-8" },
    layout: { fileName: "layout.json", contentType: "application/json; charset=utf-8" },
  };
  if (fixed[artifact]) return fixed[artifact];
  const page = artifact.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)$/);
  if (page) {
    return {
      fileName: `expansion-state-${page[1]}.jpg`,
      contentType: "image/jpeg",
    };
  }
  const layout = artifact.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/);
  if (layout) {
    return {
      fileName: `expansion-state-${layout[1]}-layout.json`,
      contentType: "application/json; charset=utf-8",
    };
  }
  return null;
}

function manifestSourceObjectSetValid(entries) {
  if (!entries.length) return false;
  const generations = new Set(entries.map((entry) => entry.generationId));
  const artifacts = new Set(entries.map((entry) => entry.artifact));
  if (generations.size !== 1 || generations.has(null) || artifacts.size !== entries.length) {
    return false;
  }

  const pdf = artifacts.has("pdf");
  const required = pdf
    ? ["meta", "pdf", "text"]
    : ["meta", "page", "text", "thumb"];
  if (required.some((artifact) => !artifacts.has(artifact))) return false;
  if (pdf) return entries.length === required.length;
  if (artifacts.has("pdf")) return false;

  const expansionPages = new Set();
  const expansionLayouts = new Set();
  for (const artifact of artifacts) {
    if (required.includes(artifact) || artifact === "layout") continue;
    const page = artifact.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)$/);
    const layout = artifact.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/);
    if (page) expansionPages.add(Number(page[1]));
    else if (layout) expansionLayouts.add(Number(layout[1]));
    else return false;
  }
  if (expansionPages.size !== expansionLayouts.size) return false;
  if (expansionPages.size > 0 && !artifacts.has("layout")) return false;
  const indexes = [...expansionPages].sort((left, right) => left - right);
  return indexes.every(
    (index, offset) => index === offset + 1 && expansionLayouts.has(index),
  );
}

function measureR2ObjectHash(body, object) {
  if (object.hashMode === "raw_sha256") {
    return { sha256: sha256(body), semanticLength: null };
  }
  if (object.hashMode !== "utf8_text_single_trailing_newline_v1") return null;
  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const semanticText = rawText.endsWith("\r\n")
      ? rawText.slice(0, -2)
      : rawText.endsWith("\n")
        ? rawText.slice(0, -1)
        : null;
    if (semanticText === null) return null;
    return {
      sha256: sha256(Buffer.from(semanticText, "utf8")),
      semanticLength: semanticText.length,
    };
  } catch {
    return null;
  }
}

async function fetchJsonWithoutRedirect(url, { fetchImpl, headers }) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    headers,
  });
  assertNoRedirect(response, url);
  const bytes = Buffer.from(await response.arrayBuffer());
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Expected JSON from ${url}.`);
  }
  return { status: response.status, sha256: sha256(bytes), json };
}

async function fetchCrawlObservation(url, { fetchImpl, appOrigin }) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "AwardPing-Stage1-Anonymous-Leak-Probe/1.0",
    },
  });
  if (!response || typeof response.status !== "number") {
    throw new Error("NoHttpResponse");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const redirected = Boolean(
    response.redirected ||
    response.status >= 300 && response.status < 400 ||
    response.url && response.url !== url
  );
  return {
    status: response.status,
    redirected,
    redirectLocation: sanitizeRedirectLocation(
      response.headers?.get?.("location"),
      appOrigin,
    ),
    sha256: sha256(bytes),
    text: bytes.toString("utf8"),
  };
}

function crawlFailureDiagnostic(row) {
  let reason = null;
  let recommendedSafeAction = null;
  if (row.error_code) {
    reason = "request_failed";
    recommendedSafeAction =
      "Repair anonymous route availability, TLS, or network access, then rerun the exact crawl path.";
  } else if (row.redirected) {
    reason = "redirect_refused";
    recommendedSafeAction =
      "Remove the redirect and serve the expected response at this exact canonical path before rerunning.";
  } else if (row.group === "stage1" && row.status !== 200) {
    reason = "unexpected_stage1_status";
    recommendedSafeAction =
      "Restore this Stage 1 path to an HTTP 200 Under verification page, then rerun the crawl.";
  } else if (row.group === "stage1" && !row.under_verification) {
    reason = "under_verification_marker_missing";
    recommendedSafeAction =
      "Restore the Under verification marker on this Stage 1 path, then rerun the crawl.";
  } else if (row.group === "non_cohort" && row.status !== 404) {
    reason = "non_cohort_route_publicly_visible";
    recommendedSafeAction =
      "Remove this non-cohort path from anonymous publication and verify it returns HTTP 404 before rerunning.";
  }
  if (!reason) return null;
  return {
    group: row.group,
    path: row.path,
    http_status: row.status,
    redirected: row.redirected,
    redirect_location: row.redirect_location,
    under_verification: row.under_verification,
    reason,
    error_code: row.error_code,
    recommended_safe_action: recommendedSafeAction,
  };
}

function crawlFailureIdentity(row) {
  return {
    group: row.group,
    path: row.path,
    http_status: row.http_status,
    redirected: row.redirected,
    redirect_location: row.redirect_location,
    under_verification: row.under_verification,
    reason: row.reason,
    error_code: row.error_code,
  };
}

function r2FailureDiagnostic(row) {
  const recommendedSafeAction = row.outcome === "mismatch"
    ? "Restore or recapture this exact immutable object generation, rebuild the DB-owned manifest, then rerun the R2 drill."
    : row.outcome === "refused"
      ? "Repair read-only R2 credential or bucket access, keep the immutable manifest unchanged, then rerun the drill."
      : "Confirm this exact immutable object exists in the authoritative bucket, repair retrieval, then rerun the drill.";
  return {
    object_scope: row.object_scope,
    source_id: row.source_id,
    artifact: row.artifact,
    object_key: row.object_key,
    hash_mode: row.hash_mode,
    outcome: row.outcome,
    error_code: row.error_code || null,
    expected_sha256: row.expected_sha256 || null,
    actual_sha256: row.actual_sha256 || null,
    expected_byte_length: row.expected_byte_length ?? null,
    actual_byte_length: row.actual_byte_length ?? null,
    expected_semantic_length: row.expected_semantic_length ?? null,
    actual_semantic_length: row.actual_semantic_length ?? null,
    expected_content_type: row.expected_content_type || null,
    actual_content_type: row.actual_content_type || null,
    recommended_safe_action: recommendedSafeAction,
  };
}

function r2FailureIdentity(row) {
  const identity = { ...row };
  delete identity.recommended_safe_action;
  return identity;
}

function sanitizeRedirectLocation(value, appOrigin) {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const location = new URL(raw, appOrigin);
    return location.origin === appOrigin
      ? `${location.pathname}`
      : `${location.origin}${location.pathname}`;
  } catch {
    return "[invalid-location]";
  }
}

function safeErrorCode(error) {
  const value = cleanText(error?.Code || error?.name || "unknown")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 120);
  return value || "unknown";
}

function compareFailureKey(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNoRedirect(response, expectedUrl) {
  if (!response || typeof response.status !== "number") {
    throw new Error(`No HTTP response was returned for ${expectedUrl}.`);
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    throw new Error(`The production measurement refused a redirect from ${expectedUrl}.`);
  }
  if (response.url && response.url !== expectedUrl) {
    throw new Error(`The production measurement response URL changed from ${expectedUrl}.`);
  }
}

function exactHttpsOrigin(value, label) {
  const text = requiredText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== text
  ) {
    throw new Error(`${label} must be one exact HTTPS origin with no path or credentials.`);
  }
  return url.origin;
}

function normalizeCrawlRoute(value) {
  const route = objectValue(value);
  const path = requiredText(route.path, "crawl route path");
  if (!/^\/[a-z0-9][a-z0-9-]*$/.test(path)) {
    throw new Error(`The DB-owned crawl route is invalid: ${path}.`);
  }
  return { path };
}

async function mapWithConcurrency(values, requestedConcurrency, task) {
  const concurrency = Math.max(1, Math.min(16, Number(requestedConcurrency) || 1));
  const output = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await task(values[index], index);
    }
  }));
  return output;
}

async function responseBodyBytes(body) {
  if (!body) throw new Error("R2 returned an empty response body.");
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (Symbol.asyncIterator in Object(body)) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error("R2 returned an unsupported response body.");
}

function r2AccessRefused(error) {
  const status = Number(error?.$metadata?.httpStatusCode);
  const code = cleanText(error?.name || error?.Code).toLowerCase();
  return status === 401 || status === 403 || /accessdenied|forbidden|unauthorized/.test(code);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pollRuntimeState({ probe, predicate, attempts, intervalMs, sleep, label }) {
  const count = Math.max(1, Math.min(120, Number(attempts) || 1));
  for (let attempt = 0; attempt < count; attempt += 1) {
    const state = await probe();
    if (predicate(state)) return state;
    if (attempt + 1 < count) await sleep(Math.max(0, Number(intervalMs) || 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function runtimeStateHash(evidence) {
  return sha256(stableJson({
    app_revision: evidence.app_revision,
    policy_hash: evidence.policy_hash,
    batch_policy_hash: evidence.batch_policy_hash,
    suppression_policy_hash: evidence.suppression_policy_hash,
    matcher_hash: evidence.matcher_hash,
    disable_signup: evidence.disable_signup,
    production_app_origin: evidence.production_app_origin,
    supabase_project_ref: evidence.supabase_project_ref,
  }));
}

function commandResultHash(result) {
  const value = objectValue(result);
  return sha256(stableJson({
    exit_code: Number.isInteger(value.exitCode) ? value.exitCode : null,
    stdout_sha256: sha256(cleanText(value.stdout)),
    stderr_sha256: sha256(cleanText(value.stderr)),
  }));
}

function deploymentReference(value, label) {
  const text = requiredText(value, label);
  if (/^dpl_[A-Za-z0-9]+$/.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a Vercel deployment ID or HTTPS vercel.app URL.`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".vercel.app") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== text
  ) {
    throw new Error(`${label} must be a Vercel deployment ID or HTTPS vercel.app URL.`);
  }
  return url.origin;
}

function assertMeasurementIdentity({ measuredAt, measurementId }) {
  if (!Number.isFinite(Date.parse(measuredAt)) || !uuidPattern.test(measurementId)) {
    throw new Error("Producer measurements require an ISO timestamp and UUID measurement ID.");
  }
}

function requiredHash(value, label) {
  const text = cleanText(value);
  if (!sha256Pattern.test(text)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  return text;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label}.`);
  return text;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
