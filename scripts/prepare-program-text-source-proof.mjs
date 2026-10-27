#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { createSupabaseServiceClient, closeSupabaseServiceTransport } from "./supabase-service-client.mjs";
import { captureProgramTextSource, validateProgramTextCapture } from "./lib/program-text-capture.mjs";
import { retainProgramTextCapture, uploadProgramTextCapture, loadProgramTextCapture,
  programTextReference, validateProgramTextReference } from "./lib/program-text-storage.mjs";
import { verifyScraplingRuntimeBinding } from "./lib/scrapling-runtime-binding.mjs";
import { findProgramTextBrowserExecutable } from "./lib/program-text-browser.mjs";
import { isProgramTextPublicDrivePdfMetadata } from "./lib/program-text-public-drive-pdf.mjs";

const root = resolve(import.meta.dirname, "..");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const pathIdentity = value => process.platform === "win32" ? value.toLowerCase() : value;
const fail = reason => { throw Object.assign(new Error("Pending source proof is held."), { proofCode: reason }); };
const safeHttps = value => {
  try { const url = new URL(value); return typeof value === "string" && value.length <= 4096 && url.href === value &&
    url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash; } catch { return false; }
};

/** No source, URL, inventory, mode, retry, publication or arbitrary-config flags. */
export function parseProgramTextSourceProofArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const match = /^--(pending-id|env)(?:=(.+))?$/.exec(argv[index]);
    if (!match || Object.hasOwn(options, match[1])) fail("invalid_arguments");
    const value = match[2] ?? argv[++index];
    if (typeof value !== "string" || !value || value.startsWith("--") || /[\0\r\n]/.test(value) || value.length > 4096) fail("invalid_arguments");
    options[match[1]] = value;
  }
  if (!uuid(options["pending-id"])) fail("invalid_pending_id");
  return { pendingId: options["pending-id"], envPath: options.env ? resolve(root, options.env) : resolve(root, ".env.worker.local") };
}

function sourceBound(ref, source) {
  try { validateProgramTextReference(ref); } catch { fail("invalid_proof_reference"); }
  if (ref.final_url !== source.url && !isProgramTextPublicDrivePdfMetadata(ref) ||
      ["id", "shared_award_id", "url", "title", "page_type"].some(key => ref.source[key] !== source[key])) fail("proof_source_mismatch");
  return ref;
}

export function validateProgramTextSourcePendingDescriptor(value, { pendingId, epoch }) {
  if (!exact(value, ["schema", "id", "content_hash", "epoch", "source", "registration_scope", "role_revisions", "proof"]) ||
      value.schema !== "awardping.program-text-source-pending-capture.v1" || value.id !== pendingId || !uuid(value.id) ||
      value.epoch !== epoch || !uuid(value.epoch) || !hash(value.content_hash) || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) fail("invalid_pending_descriptor");
  const source = value.source;
  if (!exact(source, ["id", "shared_award_id", "url", "title", "page_type", "admin_review_status", "text_monitoring_state"]) ||
      !uuid(source.id) || !uuid(source.shared_award_id) || !safeHttps(source.url) ||
      typeof source.title !== "string" || !source.title.trim() || source.title.length > 10000 ||
      typeof source.page_type !== "string" || !source.page_type || source.page_type.length > 100 ||
      typeof source.admin_review_status !== "string" || !source.admin_review_status || source.admin_review_status.length > 100 ||
      !plain(source.text_monitoring_state)) fail("invalid_pending_source");
  const scope = value.registration_scope;
  const legacy = exact(scope, ["kind"]) && scope.kind === "legacy_roles";
  const variation = exact(scope, ["kind", "inventory_id", "revision"]) && scope.kind === "variation_inventory" && uuid(scope.inventory_id) && uuid(scope.revision);
  if ((!legacy && !variation) || !Array.isArray(value.role_revisions) || value.role_revisions.length > 50 ||
      (legacy ? value.role_revisions.length < 1 : value.role_revisions.length !== 0) ||
      value.role_revisions.some(role => !exact(role, ["source_role", "revision"]) || !/^[a-z0-9_]{1,80}$/.test(role.source_role || "") || !uuid(role.revision)) ||
      new Set(value.role_revisions.map(role => role.source_role)).size !== value.role_revisions.length) fail("invalid_pending_registration_scope");
  if (value.proof !== null) {
    if (!exact(value.proof, ["reference", "content_hash"]) || !hash(value.proof.content_hash)) fail("invalid_saved_proof");
    sourceBound(value.proof.reference, source);
  }
  return structuredClone(value);
}

function acquisitionOptions(config, source) {
  const override = config.sources?.[source.id] || {};
  if (!plain(override) || Object.keys(override).some(key => !["source_url", "shared_award_id", "acquisition", "pdf_transport", "allowed_final_urls", "publisher_json_profile"].includes(key)) ||
      Object.keys(override).length && (override.source_url !== source.url || override.shared_award_id !== source.shared_award_id)) fail("source_configuration_changed");
  const acquisition = override.acquisition || (source.page_type === "pdf" || /\.pdf(?:\?|$)/i.test(source.url) ? "pdf_text" : "http_html");
  const transport = override.pdf_transport || "http";
  // OCR needs a separately verified reading-order process; never use it as a fallback.
  if (!["http_html", "rendered_html", "pdf_text", "publisher_json"].includes(acquisition) || !["http", "browser"].includes(transport) ||
      transport === "browser" && acquisition !== "pdf_text" ||
      override.allowed_final_urls !== undefined && (!Array.isArray(override.allowed_final_urls) || override.allowed_final_urls.length > 20 || !override.allowed_final_urls.every(safeHttps))) fail("invalid_acquisition_configuration");
  return { acquisition, pdf_transport: transport, allowedFinalUrls: override.allowed_final_urls || [], timeoutMs: 90000,
    ...(override.publisher_json_profile === undefined ? {} : { publisher_json_profile: override.publisher_json_profile }) };
}

async function defaultRuntime({ envPath }) {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const env = process.env;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY ||
      (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID)) fail("runtime_credentials_missing");
  const config = JSON.parse(readFileSync(resolve(root, "config/program-text-monitoring.json"), "utf8"));
  const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const client = new S3Client({ region: "auto", endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  return { config, supabase, storage: { client, bucket: env.R2_BUCKET || "awardping-snapshots" },
    prepareCapture: async options => {
      const pythonPath = env.AWARDPING_SCRAPLING_PYTHON, manifestPath = env.AWARDPING_SCRAPLING_MANIFEST;
      if (!pythonPath || !manifestPath || !env.AWARDPING_PROGRAM_TEXT_ARCHIVE) fail("owned_capture_runtime_missing");
      verifyScraplingRuntimeBinding({ appDir: root, manifestPath, pythonPath });
      const archiveRoot = realpathSync.native(env.AWARDPING_PROGRAM_TEXT_ARCHIVE);
      if (pathIdentity(archiveRoot) !== pathIdentity(realpathSync.native(resolve(dirname(root), "runtime/program-text-archive")))) fail("private_archive_identity_changed");
      const browserRequired = ["rendered_html", "publisher_json"].includes(options.acquisition) || options.pdf_transport === "browser";
      const executablePath = browserRequired ? findProgramTextBrowserExecutable() : undefined;
      if (browserRequired && !executablePath) fail("owned_browser_unavailable");
      return { pythonPath, executablePath, archiveRoot };
    },
    close: async () => { client.destroy(); await closeSupabaseServiceTransport(); } };
}

/** One pending request, one guarded capture at most. Never runs monitoring or AI. */
export async function runPrepareProgramTextSourceProof(argv = process.argv.slice(2), adapters = {}) {
  const args = parseProgramTextSourceProofArgs(argv);
  const runtime = await (adapters.createRuntime || defaultRuntime)(args);
  const load = adapters.loadCapture || loadProgramTextCapture;
  async function rpc(name, payload) {
    const result = await runtime.supabase.rpc(name, payload);
    if (result.error) fail("pending_request_rejected");
    return result.data;
  }
  function restored(capture, ref, source) {
    try { validateProgramTextCapture(capture); } catch { fail("invalid_restored_capture"); }
    sourceBound(programTextReference(capture), source);
    if (!equal(programTextReference(capture), ref)) fail("cold_original_mismatch");
  }
  try {
    const config = runtime.config;
    if (!plain(config) || config.schema !== "awardping.program-text-monitoring.v1" || !uuid(config.epoch) ||
        config.sources !== undefined && !plain(config.sources)) fail("invalid_monitoring_configuration");
    const pending = validateProgramTextSourcePendingDescriptor(await rpc("get_program_text_source_pending_capture", { p_id: args.pendingId }),
      { pendingId: args.pendingId, epoch: config.epoch });
    if (pending.proof) {
      const capture = await load(pending.proof.reference, runtime.storage);
      restored(capture, pending.proof.reference, pending.source);
      // The server's immutable JSONB digest is opaque; do not recompute it using JS serialization.
      return { schema: "awardping.program-text-source-probe-receipt.v1", pending_id: pending.id,
        reference: pending.proof.reference, content_hash: pending.proof.content_hash, reused: true };
    }
    const options = acquisitionOptions(config, pending.source);
    const resources = await runtime.prepareCapture(options);
    const capture = await (adapters.captureSource || captureProgramTextSource)({ source: pending.source, ...options,
      pythonPath: resources.pythonPath, executablePath: resources.executablePath });
    try { validateProgramTextCapture(capture); } catch { fail("invalid_captured_text"); }
    if (capture.acquisition !== options.acquisition) fail("capture_acquisition_mismatch");
    if (capture.completeness.status !== "complete") fail("capture_incomplete");
    const expected = sourceBound(programTextReference(capture), pending.source);
    const retained = (adapters.retainCapture || retainProgramTextCapture)(capture, resources.archiveRoot);
    if (!equal(retained.reference, expected)) fail("local_reference_mismatch");
    const reference = await (adapters.uploadCapture || uploadProgramTextCapture)(capture, runtime.storage);
    if (!equal(reference, expected)) fail("uploaded_reference_mismatch");
    // Independent raw/text/metadata restoration is required before the only DB mutator.
    const cold = await load(reference, runtime.storage);
    restored(cold, reference, pending.source);
    const document = { reference, text: cold.text, blocks: cold.blocks, blocks_json: JSON.stringify(canonical(cold.blocks)) };
    const receipt = await rpc("record_program_text_source_probe", { p_pending_id: pending.id, p_expected_hash: pending.content_hash, p_document: document });
    if (!exact(receipt, ["schema", "pending_id", "reference", "content_hash"]) || receipt.schema !== "awardping.program-text-source-probe-receipt.v1" ||
        receipt.pending_id !== pending.id || !hash(receipt.content_hash) || !equal(receipt.reference, reference)) fail("invalid_probe_receipt");
    return { ...receipt, reused: false };
  } finally { await runtime.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPrepareProgramTextSourceProof().then(receipt => {
    console.log(JSON.stringify({ schema: receipt.schema, status: receipt.reused ? "existing_proof_verified" : "proof_prepared",
      pending_id: receipt.pending_id, source_id: receipt.reference.source.id, capture_id: receipt.reference.capture_id,
      content_hash: receipt.content_hash, approved: false, provider_calls: 0, monitoring_state_writes: 0, publications: 0 }));
  }).catch(error => {
    console.error(JSON.stringify({ status: "held", reason: /^[a-z_]+$/.test(error?.proofCode || "") ? error.proofCode : "source_proof_failed",
      approved: false, provider_calls: 0, monitoring_state_writes: 0, publications: 0 }));
    process.exitCode = 1;
  });
}
