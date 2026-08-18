#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  stage1EvidenceSchemaUpgradeReviewedApplyTransactionId,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs";
import {
  assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs";
import {
  createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-recovery-runtime.mjs";
import {
  executeStage1EvidenceSchemaUpgradeReviewedRecovery,
  inspectStage1EvidenceSchemaUpgradeReviewedRecovery,
  sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const INSPECT = "inspect";
const SEAL = "seal";
const EXECUTE = "execute";
const PARENT_ARGS = Object.freeze([
  "apply-plan-file",
  "apply-plan-sha256",
  "manifest-file",
  "mode",
  "reviewed-dry-run-report-file",
]);
const RUNTIME_ARGS = Object.freeze([
  ...PARENT_ARGS,
  "archive-root",
  "env",
]);
const INSPECT_ARGS = Object.freeze([
  ...RUNTIME_ARGS,
  "recovery-inspection-output-file",
]);
const SEAL_ARGS = Object.freeze([
  ...PARENT_ARGS,
  "expires-at",
  "recovery-inspection-file",
  "recovery-inspection-file-sha256",
  "recovery-plan-output-file",
  "reviewed-at",
  "reviewer-id",
]);
const EXECUTE_ARGS = Object.freeze([
  ...RUNTIME_ARGS,
  "recovery-inspection-file",
  "recovery-inspection-file-sha256",
  "recovery-plan-file",
  "recovery-plan-file-sha256",
  "recovery-plan-sha256",
  "recovery-report-output-file",
]);

export async function runStage1EvidenceSchemaUpgradeReviewedRecoveryCli({
  argv = process.argv.slice(2),
  processEnvironment = process.env,
  dependencies = {},
} = {}) {
  const args = parseArgs(argv);
  if (args.help === true) return { exitCode: 0, help: helpText() };
  const mode = requiredChoice(args.mode, [INSPECT, SEAL, EXECUTE], "--mode");
  assertAllowedArgs(
    args,
    mode === INSPECT ? INSPECT_ARGS : mode === SEAL ? SEAL_ARGS : EXECUTE_ARGS,
  );
  const applyPlanPath = requiredPath(args["apply-plan-file"], "--apply-plan-file");
  const reportPath = requiredPath(
    args["reviewed-dry-run-report-file"],
    "--reviewed-dry-run-report-file",
  );
  const manifestPath = requiredPath(args["manifest-file"], "--manifest-file");
  const applyPlanBytes = readFileSync(applyPlanPath);
  const reviewedDryRunReportBytes = readFileSync(reportPath);
  const manifest = readJsonFile(manifestPath, "Stage 1 manifest");
  const expectedApplyPlanFileSha256 = requiredSha256(
    args["apply-plan-sha256"],
    "--apply-plan-sha256",
  );
  const historical =
    validateStage1EvidenceSchemaUpgradeReviewedApplyHistoricalEvidence({
      planBytes: applyPlanBytes,
      expectedPlanFileSha256: expectedApplyPlanFileSha256,
      reportBytes: reviewedDryRunReportBytes,
      manifest,
    });
  const sourceId = historical.selected_source_id;
  const transactionId = stage1EvidenceSchemaUpgradeReviewedApplyTransactionId({
    sourceId,
    planSha256: historical.plan_sha256,
  });
  const clock = dependencies.now || (() => new Date().toISOString());
  if (mode === SEAL) {
    const inspectionPath = requiredPath(
      args["recovery-inspection-file"],
      "--recovery-inspection-file",
    );
    const generated = sealStage1EvidenceSchemaUpgradeReviewedRecoveryPlan({
      inspectionBytes: readFileSync(inspectionPath),
      expectedInspectionFileSha256: requiredSha256(
        args["recovery-inspection-file-sha256"],
        "--recovery-inspection-file-sha256",
      ),
      applyPlanBytes,
      expectedApplyPlanFileSha256,
      reviewedDryRunReportBytes,
      manifest,
      reviewer: {
        reviewer_id: requiredText(args["reviewer-id"], "--reviewer-id"),
        reviewed_at: requiredTimestamp(args["reviewed-at"], "--reviewed-at"),
        expires_at: requiredTimestamp(args["expires-at"], "--expires-at"),
      },
      now: clock,
    });
    const outputPath = requiredPath(
      args["recovery-plan-output-file"],
      "--recovery-plan-output-file",
      { mustExist: false },
    );
    writeImmutableArtifact(outputPath, generated.plan_bytes);
    return deepFreeze({
      exitCode: 0,
      mode,
      outputPath,
      source_id: sourceId,
      transaction_id: transactionId,
      plan_file_sha256: generated.plan_file_sha256,
      plan_sha256: generated.plan.plan_sha256,
      expected_disposition: generated.plan.expected_disposition,
      mutation_performed: false,
      creates_api_charge: false,
    });
  }
  const envPath = resolveInput(args.env || ".env.worker.local");
  const env = {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...processEnvironment,
  };
  const archiveRoot = requiredText(
    args["archive-root"] || env.AWARDPING_VISUAL_ARCHIVE_ROOT || "D:\\AwardPingVisualSnapshots",
    "--archive-root",
  );
  const executionInputs = mode === EXECUTE
    ? loadReviewedRecoveryExecutionInputs(args, {
        applyPlanBytes,
        expectedApplyPlanFileSha256,
        reviewedDryRunReportBytes,
        manifest,
      })
    : null;

  let runtimeResources = null;
  try {
    runtimeResources = dependencies.createRuntime
      ? await dependencies.createRuntime({
          archiveRoot,
          env,
          historical,
          sourceId,
          transactionId,
          now: clock,
          reviewedRecoveryAuthority: executionInputs?.runtimeAuthority || null,
        })
      : createDefaultRuntime({
          archiveRoot,
          env,
          historical,
          sourceId,
          transactionId,
          now: clock,
          reviewedRecoveryAuthority: executionInputs?.runtimeAuthority || null,
          adapters: dependencies.defaultRuntimeAdapters || {},
        });
    const runtime = requiredObject(runtimeResources.runtime, "reviewed recovery runtime");
    if (mode === INSPECT) {
      const generated = await inspectStage1EvidenceSchemaUpgradeReviewedRecovery({
        applyPlanBytes,
        expectedApplyPlanFileSha256,
        reviewedDryRunReportBytes,
        manifest,
        interfaces: runtime.inspectionInterfaces,
        now: clock,
      });
      const outputPath = requiredPath(
        args["recovery-inspection-output-file"],
        "--recovery-inspection-output-file",
        { mustExist: false },
      );
      writeImmutableArtifact(outputPath, generated.inspection_bytes);
      return deepFreeze({
        exitCode: 0,
        mode,
        outputPath,
        source_id: sourceId,
        transaction_id: transactionId,
        inspection_file_sha256: generated.inspection_file_sha256,
        inspection_sha256: generated.inspection.inspection_sha256,
        evidence_observed_at: generated.inspection.evidence_observed_at,
        mutation_performed: false,
        creates_api_charge: false,
      });
    }

    const executionReport =
      assertStage1EvidenceSchemaUpgradeReviewedRecoveryExecutionReport(
        await executeStage1EvidenceSchemaUpgradeReviewedRecovery({
          recoveryPlanBytes: executionInputs.recoveryPlanBytes,
          expectedRecoveryPlanFileSha256:
            executionInputs.expectedRecoveryPlanFileSha256,
          expectedRecoveryPlanSha256: executionInputs.expectedRecoveryPlanSha256,
          inspectionBytes: executionInputs.inspectionBytes,
          expectedInspectionFileSha256:
            executionInputs.expectedInspectionFileSha256,
          applyPlanBytes,
          expectedApplyPlanFileSha256,
          reviewedDryRunReportBytes,
          manifest,
          interfaces: runtime.executionInterfaces,
          now: clock,
        }),
      );
    const outputPath = requiredPath(
      args["recovery-report-output-file"],
      "--recovery-report-output-file",
      { mustExist: false },
    );
    writeImmutableArtifact(
      outputPath,
      Buffer.from(`${JSON.stringify(executionReport, null, 2)}\n`, "utf8"),
    );
    return deepFreeze({
      exitCode: executionReport.status === "recovery_required" ? 2 : 0,
      mode,
      outputPath,
      source_id: sourceId,
      transaction_id: transactionId,
      report_sha256: executionReport.report_sha256,
      status: executionReport.status,
      disposition: executionReport.disposition,
      mutation_performed: executionReport.mutation_performed,
      creates_api_charge: false,
    });
  } finally {
    await runtimeResources?.close?.();
  }
}

export function createDefaultRuntime({
  archiveRoot,
  env,
  historical,
  sourceId,
  transactionId,
  now,
  reviewedRecoveryAuthority,
  adapters = {},
}) {
  const runtimeAdapters = requiredObject(adapters, "reviewed recovery default runtime adapters");
  const allowedRuntimeAdapters = new Set([
    "closeSupabaseTransport",
    "createR2Client",
    "createRecoveryRuntime",
    "createSupabaseClient",
  ]);
  const unexpectedAdapter = Object.keys(runtimeAdapters)
    .find((key) => !allowedRuntimeAdapters.has(key));
  if (unexpectedAdapter) {
    throw new Error(`Reviewed recovery default runtime adapter is forbidden: ${unexpectedAdapter}.`);
  }
  if (Object.values(runtimeAdapters).some((value) => typeof value !== "function")) {
    throw new Error("Reviewed recovery default runtime adapters must be functions.");
  }
  const createR2Client = runtimeAdapters.createR2Client
    || ((options) => new S3Client(options));
  const createSupabaseClient = runtimeAdapters.createSupabaseClient
    || createSupabaseServiceClient;
  const createRecoveryRuntime = runtimeAdapters.createRecoveryRuntime
    || createStage1EvidenceSchemaUpgradeReviewedRecoveryRuntime;
  const closeSupabaseTransport = runtimeAdapters.closeSupabaseTransport
    || closeSupabaseServiceTransport;
  const supabaseUrl = requiredText(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredText(
    env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const r2Bucket = requiredText(env.R2_BUCKET || "awardping-snapshots", "R2_BUCKET");
  const r2AccountId = cleanText(env.R2_ACCOUNT_ID);
  const r2Endpoint = requiredText(
    env.R2_ENDPOINT
      || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ""),
    "R2_ENDPOINT or R2_ACCOUNT_ID",
  );
  const r2 = createR2Client({
    region: "auto",
    endpoint: r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredText(env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredText(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
    },
  });
  const supabase = createSupabaseClient(supabaseUrl, serviceRoleKey);
  const readR2Object = async (request) => {
    assertExactKeys(request, [
      "bucket",
      "creates_api_charge",
      "expected_byte_length",
      "key",
      "mutation_performed",
    ], "reviewed recovery R2 read request");
    if (
      request.bucket !== r2Bucket
      || request.creates_api_charge !== false
      || request.mutation_performed !== false
      || !Number.isSafeInteger(request.expected_byte_length)
      || request.expected_byte_length < 0
    ) throw new Error("Reviewed recovery R2 read request exceeds exact read authority.");
    const response = await r2.send(new GetObjectCommand({
      Bucket: request.bucket,
      Key: request.key,
    }));
    if (
      Number.isSafeInteger(response?.ContentLength)
      && response.ContentLength !== request.expected_byte_length
    ) throw new Error("Reviewed recovery R2 response length differs from its sealed binding.");
    const body = await stage1EvidenceSchemaUpgradeReviewedRecoveryR2ResponseBody(
      response?.Body,
      { expectedByteLength: request.expected_byte_length },
    );
    return {
      bucket: request.bucket,
      key: request.key,
      body,
      expected_byte_length: request.expected_byte_length,
      content_type: cleanText(response?.ContentType) || null,
      byte_length: Number.isSafeInteger(response?.ContentLength)
        ? response.ContentLength
        : body.byteLength,
      mutation_performed: false,
      creates_api_charge: false,
    };
  };
  return {
    runtime: createRecoveryRuntime({
      supabase,
      archiveRoot,
      readR2Object,
      r2Bucket,
      reviewedApplyPlan: historical,
      sourceId,
      transactionId,
      reviewedRecoveryAuthority,
      visualSourceCheckMinutes: positiveInteger(
        env.AWARDPING_VISUAL_SOURCE_CHECK_MINUTES,
        24 * 60,
      ),
      now,
    }),
    async close() {
      r2.destroy();
      await closeSupabaseTransport();
    },
  };
}

function loadReviewedRecoveryExecutionInputs(args, parentEvidence) {
  const recoveryPlanPath = requiredPath(
    args["recovery-plan-file"],
    "--recovery-plan-file",
  );
  const recoveryPlanBytes = readFileSync(recoveryPlanPath);
  const expectedRecoveryPlanFileSha256 = requiredSha256(
    args["recovery-plan-file-sha256"],
    "--recovery-plan-file-sha256",
  );
  const expectedRecoveryPlanSha256 = requiredSha256(
    args["recovery-plan-sha256"],
    "--recovery-plan-sha256",
  );
  const inspectionPath = requiredPath(
    args["recovery-inspection-file"],
    "--recovery-inspection-file",
  );
  const inspectionBytes = readFileSync(inspectionPath);
  const expectedInspectionFileSha256 = requiredSha256(
    args["recovery-inspection-file-sha256"],
    "--recovery-inspection-file-sha256",
  );
  return {
    recoveryPlanBytes,
    expectedRecoveryPlanFileSha256,
    expectedRecoveryPlanSha256,
    inspectionBytes,
    expectedInspectionFileSha256,
    runtimeAuthority: {
      recoveryPlanBytes,
      expectedRecoveryPlanFileSha256,
      expectedRecoveryPlanSha256,
      inspectionBytes,
      expectedInspectionFileSha256,
      ...parentEvidence,
    },
  };
}

export async function stage1EvidenceSchemaUpgradeReviewedRecoveryR2ResponseBody(
  body,
  { expectedByteLength } = {},
) {
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
    throw new Error("Reviewed recovery R2 expected byte length is invalid.");
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const bytes = Buffer.from(body);
    if (bytes.byteLength !== expectedByteLength) {
      throw new Error("Reviewed recovery R2 body length differs from its sealed binding.");
    }
    return bytes;
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let observed = 0;
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk);
      observed += bytes.byteLength;
      if (observed > expectedByteLength) {
        body.destroy?.();
        throw new Error("Reviewed recovery R2 body exceeded its sealed byte length.");
      }
      chunks.push(bytes);
    }
    if (observed !== expectedByteLength) {
      throw new Error("Reviewed recovery R2 body length differs from its sealed binding.");
    }
    return Buffer.concat(chunks, observed);
  }
  throw new Error("Reviewed recovery R2 response body lacks a bounded stream interface.");
}

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      if (Object.hasOwn(args, "help")) throw new Error("Duplicate --help argument.");
      args.help = true;
      continue;
    }
    if (!token.startsWith("--") || !token.includes("=")) {
      throw new Error(`Recovery CLI requires --name=value arguments; received ${token}.`);
    }
    const index = token.indexOf("=");
    const key = token.slice(2, index).trim();
    const value = token.slice(index + 1).trim();
    if (!key || !value || Object.hasOwn(args, key)) {
      throw new Error(`Recovery CLI argument is empty or duplicated: --${key}.`);
    }
    args[key] = value;
  }
  return args;
}

function assertAllowedArgs(args, allowed) {
  const supported = new Set(allowed);
  const unexpected = Object.keys(args).filter((key) => !supported.has(key)).sort();
  if (unexpected.length) {
    throw new Error(`Recovery CLI forbids arguments in this mode: ${unexpected.join(",")}.`);
  }
}

function requiredChoice(value, allowed, label) {
  const text = requiredText(value, label);
  if (!allowed.includes(text)) throw new Error(`${label} must be ${allowed.join(" or ")}.`);
  return text;
}

function requiredPath(value, label, { mustExist = true } = {}) {
  const path = resolveInput(requiredText(value, label));
  if (mustExist && !existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return path;
}

function resolveInput(value) {
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

function readJsonFile(path, label) {
  try {
    return requiredObject(JSON.parse(readFileSync(path, "utf8")), label);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

function writeImmutableArtifact(path, bytes) {
  const body = Buffer.from(bytes);
  if (existsSync(path)) {
    if (readFileSync(path).equals(body)) return;
    throw new Error(`Refusing to replace a different reviewed recovery artifact: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, body, { flag: "wx" });
  renameSync(temporary, path);
}

function loadEnvFile(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function helpText() {
  return [
    "Reviewed Stage 1 exact-transaction recovery (never performs live capture).",
    "",
    "Inspect and write a self-sealed, read-only evidence artifact:",
    "  --mode=inspect --apply-plan-file=... --apply-plan-sha256=<64hex>",
    "  --reviewed-dry-run-report-file=... --manifest-file=...",
    "  --recovery-inspection-output-file=...",
    "",
    "After external review, seal that exact inspection into a bounded plan (no runtime I/O):",
    "  --mode=seal --apply-plan-file=... --apply-plan-sha256=<64hex>",
    "  --reviewed-dry-run-report-file=... --manifest-file=...",
    "  --recovery-inspection-file=... --recovery-inspection-file-sha256=<64hex>",
    "  --reviewer-id=... --reviewed-at=<ISO> --expires-at=<ISO>",
    "  --recovery-plan-output-file=...",
    "",
    "Execute only after separately reviewing both printed plan hashes:",
    "  --mode=execute --apply-plan-file=... --apply-plan-sha256=<64hex>",
    "  --reviewed-dry-run-report-file=... --manifest-file=...",
    "  --recovery-plan-file=... --recovery-plan-file-sha256=<64hex>",
    "  --recovery-plan-sha256=<64hex> --recovery-report-output-file=...",
    "  --recovery-inspection-file=... --recovery-inspection-file-sha256=<64hex>",
    "",
    "This command has no browser, capture, AI, R2 upload, pointer CAS, candidate,",
    "quarantine, public-fact, hold-clearing, generic audit, or supersession mode.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStage1EvidenceSchemaUpgradeReviewedRecoveryCli()
    .then((result) => {
      if (result.help) console.log(result.help);
      else console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    });
}
