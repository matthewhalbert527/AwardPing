import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import {
  measureStage1HostedRuntimeIdentity,
  measureStage1NonCohortLeakCrawl,
  measureStage1R2RecoveryDrill,
  measureStage1RollbackDrill,
  validateStage1ReleaseProducerTarget,
} from "./lib/stage1-release-evidence-producers.mjs";
import {
  signStage1ReleaseEvidencePayload,
  stage1ExternalReleasePreflightName,
  stage1ExternalReleaseRecorderName,
} from "./lib/stage1-release-evidence-signing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const kind = required(args.kind, "--kind");
const signerKeyId = required(args["signer-key-id"], "--signer-key-id");
const actor = required(args.actor, "--actor");
const supabaseUrl = required(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  "SUPABASE_URL",
);
const serviceRoleKey = required(
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  "SUPABASE_SERVICE_ROLE_KEY",
);
const supabaseAnonKey = required(
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  "SUPABASE_ANON_KEY",
);
requireKeyPrefix(serviceRoleKey, "sb_secret_", "SUPABASE_SERVICE_ROLE_KEY");
requireKeyPrefix(supabaseAnonKey, "sb_publishable_", "SUPABASE_ANON_KEY");
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

const { data: targetRow, error: targetError } = await supabase.rpc(
  "get_stage1_release_producer_target",
);
if (targetError) throw new Error(`Production-target lookup failed: ${targetError.message}`);
const target = validateStage1ReleaseProducerTarget(targetRow);
if (supabaseUrl !== target.supabaseOrigin) {
  throw new Error(
    "SUPABASE_URL is not the exact administrator-owned production Supabase origin; refusing measurement and signing.",
  );
}

const startedAt = new Date().toISOString();
const measurement = await produceMeasurement({
  kind,
  targetRow,
  target,
  supabase,
  supabaseAnonKey,
  args,
});
const completedAt = new Date().toISOString();
const validUntil = new Date(
  Date.parse(completedAt) + validityMilliseconds(kind),
).toISOString();
const preflightArgs = {
  p_status: measurement.status,
  p_app_revision: measurement.appRevision,
  p_evidence: measurement.evidence,
  p_signer_key_id: signerKeyId,
  p_started_at: startedAt,
  p_completed_at: completedAt,
  p_valid_until: validUntil,
  p_actor: actor,
};
const { data: signingPayload, error: signingError } = await supabase.rpc(
  stage1ExternalReleasePreflightName(kind),
  preflightArgs,
);
if (signingError) throw new Error(`Kind-specific signing preflight failed: ${signingError.message}`);
const evidenceHash = required(signingPayload?.evidence_hash, "preflight evidence hash");
const signedPayloadHash = required(
  signingPayload?.signed_payload_hash,
  "preflight signing-payload hash",
);
if (
  Number(signingPayload?.target_config_version) !== target.configVersion ||
  text(signingPayload?.target_config_hash) !== target.targetConfigHash ||
  text(signingPayload?.artifact_kind) !== kind
) {
  throw new Error("Signing preflight changed the measured kind or production target binding.");
}

if (args.apply !== true) {
  console.log(JSON.stringify({
    apply: false,
    kind,
    measurement_status: measurement.status,
    production_origin: target.appOrigin,
    supabase_project_ref: target.supabaseProjectRef,
    target_config_version: target.configVersion,
    target_config_hash: target.targetConfigHash,
    evidence_hash: evidenceHash,
    signed_payload_hash: signedPayloadHash,
    recorder: stage1ExternalReleaseRecorderName(kind),
    note: "Producer-owned measurement and DB preflight completed. No signing secret was read and no artifact was retained.",
  }, null, 2));
  process.exit(0);
}

const signingSecret = required(
  process.env.AWARDPING_STAGE1_RELEASE_EVIDENCE_HMAC_SECRET,
  "AWARDPING_STAGE1_RELEASE_EVIDENCE_HMAC_SECRET",
);
const signature = signStage1ReleaseEvidencePayload({
  payloadHash: signedPayloadHash,
  secret: signingSecret,
});
const { data: artifact, error: recordError } = await supabase.rpc(
  stage1ExternalReleaseRecorderName(kind),
  {
    ...preflightArgs,
    p_expected_evidence_hash: evidenceHash,
    p_expected_signed_payload_hash: signedPayloadHash,
    p_signature: signature,
  },
);
if (recordError) throw new Error(`Signed artifact import failed: ${recordError.message}`);
console.log(JSON.stringify({
  apply: true,
  artifact_id: artifact?.id || null,
  artifact_kind: artifact?.artifact_kind || kind,
  status: artifact?.status || measurement.status,
  target_config_hash: artifact?.target_config_hash || target.targetConfigHash,
  evidence_hash: artifact?.evidence_hash || evidenceHash,
  valid_until: artifact?.valid_until || validUntil,
}, null, 2));

async function produceMeasurement({
  kind: requestedKind,
  targetRow: rawTarget,
  target: normalizedTarget,
  supabase: client,
  supabaseAnonKey: anonKey,
  args: values,
}) {
  if (requestedKind === "hosted_runtime_identity") {
    return measureStage1HostedRuntimeIdentity({
      target: rawTarget,
      supabaseAnonKey: anonKey,
    });
  }
  if (requestedKind === "non_cohort_leak_crawl") {
    const manifest = await requiredRpc(
      client,
      "get_stage1_release_leak_crawl_manifest",
      "anonymous crawl manifest",
    );
    return measureStage1NonCohortLeakCrawl({
      target: rawTarget,
      manifest,
      supabaseAnonKey: anonKey,
      concurrency: integer(values.concurrency, 6, 1, 16),
    });
  }
  if (requestedKind === "r2_recovery_drill") {
    const runtime = await measureStage1HostedRuntimeIdentity({
      target: rawTarget,
      supabaseAnonKey: anonKey,
    });
    const manifest = await requiredRpc(
      client,
      "get_stage1_release_r2_verification_manifest",
      "R2 verification manifest",
    );
    return measureStage1R2RecoveryDrill({
      target: rawTarget,
      manifest,
      appRevision: runtime.appRevision,
      r2Client: productionR2Client(normalizedTarget),
      concurrency: integer(values.concurrency, 4, 1, 16),
    });
  }
  if (requestedKind === "rollback_drill") {
    if (values.apply !== true) {
      throw new Error(
        "A production rollback drill requires --apply plus the separate explicit rollback confirmation flags.",
      );
    }
    const contractStateHash = await requiredRpc(
      client,
      "get_stage1_release_contract_state_hash",
      "release contract state hash",
    );
    return measureStage1RollbackDrill({
      target: rawTarget,
      contractStateHash,
      rollbackDeployment: required(
        values["rollback-deployment"] || process.env.AWARDPING_STAGE1_ROLLBACK_DEPLOYMENT,
        "--rollback-deployment",
      ),
      restoreDeployment: required(
        values["restore-deployment"] || process.env.AWARDPING_STAGE1_RESTORE_DEPLOYMENT,
        "--restore-deployment",
      ),
      confirmProductionOrigin: required(
        values["confirm-production-origin"],
        "--confirm-production-origin",
      ),
      executeProductionRollback: values["execute-production-rollback"] === true,
      deploymentController: vercelDeploymentController(normalizedTarget),
      supabaseAnonKey: anonKey,
      pollAttempts: integer(values["poll-attempts"], 60, 1, 120),
      pollIntervalMs: integer(values["poll-interval-ms"], 3_000, 0, 30_000),
    });
  }
  throw new Error(`Unsupported Stage 1 external evidence kind: ${requestedKind}.`);
}

function productionR2Client(targetValue) {
  const accessKeyId = required(process.env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID");
  const secretAccessKey = required(
    process.env.R2_SECRET_ACCESS_KEY,
    "R2_SECRET_ACCESS_KEY",
  );
  return new S3Client({
    region: "auto",
    endpoint: `https://${targetValue.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

function vercelDeploymentController(targetValue) {
  const token = required(process.env.VERCEL_TOKEN, "VERCEL_TOKEN");
  const cliPath = text(process.env.VERCEL_CLI_PATH) || "vercel";
  const projectPath = resolve(root, ".vercel", "project.json");
  return {
    async assertProjectIdentity(target) {
      if (!existsSync(projectPath)) {
        throw new Error("The producer checkout is not linked to a Vercel project.");
      }
      const project = JSON.parse(readFileSync(projectPath, "utf8"));
      if (text(project.projectId) !== target.deploymentProjectId) {
        throw new Error("The linked Vercel project does not match the DB-owned production project ID.");
      }
    },
    rollback({ deployment }) {
      return runVercel(cliPath, token, targetValue, [
        "rollback",
        deployment,
        "--timeout",
        "3m",
      ]);
    },
    restore({ deployment }) {
      return runVercel(cliPath, token, targetValue, [
        "promote",
        deployment,
        "--yes",
        "--timeout",
        "3m",
      ]);
    },
  };
}

function runVercel(cliPath, token, target, commandArgs) {
  const cliArgs = [
    ...commandArgs,
    "--non-interactive",
    "--no-color",
    "--scope",
    target.deploymentTeamSlug,
    "--cwd",
    root,
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cliPath, cliArgs, {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, VERCEL_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      const result = {
        exitCode: Number(exitCode),
        stdout: stdout.slice(-20_000),
        stderr: stderr.slice(-20_000),
      };
      if (exitCode === 0) resolvePromise(result);
      else rejectPromise(new Error(`Vercel command failed with exit code ${exitCode}.`));
    });
  });
}

async function requiredRpc(client, name, label) {
  const { data, error } = await client.rpc(name);
  if (error) throw new Error(`${label} lookup failed: ${error.message}`);
  if (data === null || data === undefined) throw new Error(`${label} is missing.`);
  return data;
}

function validityMilliseconds(artifactKind) {
  if (artifactKind === "hosted_runtime_identity") return 60 * 60 * 1_000;
  if (artifactKind === "non_cohort_leak_crawl") return 24 * 60 * 60 * 1_000;
  if (artifactKind === "r2_recovery_drill") return 24 * 60 * 60 * 1_000;
  return 7 * 24 * 60 * 60 * 1_000;
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (["--apply", "--execute-production-rollback"].includes(value)) {
      parsed[value.slice(2)] = true;
      continue;
    }
    if (!value.startsWith("--") || !value.includes("=")) continue;
    const [rawKey, ...parts] = value.slice(2).split("=");
    parsed[rawKey] = parts.join("=");
  }
  return parsed;
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function required(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requireKeyPrefix(value, prefix, label) {
  if (!value.startsWith(prefix)) {
    throw new Error(
      `${label} must contain a current ${prefix} Supabase key; legacy JWT API keys are not accepted by the production release-evidence runner.`,
    );
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
