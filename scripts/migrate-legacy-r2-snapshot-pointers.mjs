#!/usr/bin/env node
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEGACY_R2_POINTER_RECEIPT_SCHEMA,
  applyLegacyR2SnapshotPointerItem,
  assertReviewedQuarantinePrecondition,
  assertLegacyR2PointerMigrationPlan,
  blockedLegacyR2MigrationItem,
  buildLegacyR2PointerMigrationPlan,
  inspectLegacyR2SnapshotPointer,
  migrationFailureQuarantineEvidence,
  sha256Bytes,
  stableJson,
} from "./lib/legacy-r2-snapshot-pointer-migration.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotSelect = [
  "shared_award_source_id",
  "shared_award_id",
  "source_url",
  "source_title",
  "source_page_type",
  "kind",
  "bucket",
  "latest_captured_at",
  "latest_object_keys",
  "latest_hashes",
  "latest_metadata",
  "previous_captured_at",
  "previous_object_keys",
  "previous_hashes",
  "previous_metadata",
  "updated_at",
].join(",");
const sourceSelect = "id,shared_award_id,url,title,display_title,page_type,admin_review_status";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maxBatchSize = 500;
const maxObjectBytes = 100 * 1024 * 1024;
let transportOpened = false;

if (isDirectRun()) {
  try {
    await runLegacyR2PointerMigrationCli(process.argv.slice(2));
  } catch (error) {
    console.error(`LEGACY_R2_POINTER_MIGRATION_FAILED_CLOSED ${safeError(error)}`);
    console.error(
      "Legacy objects deleted: 0; live fetches: 0; public event writes: 0; paid API calls: 0.",
    );
    process.exitCode = 1;
  } finally {
    if (transportOpened) {
      try {
        await closeSupabaseServiceTransport();
      } catch {
        // Preserve the primary command result during terminal transport cleanup.
      }
    }
  }
}

export async function runLegacyR2PointerMigrationCli(argv, dependencies = {}) {
  const args = parseLegacyR2PointerMigrationArgs(argv);
  if (args.help) {
    printHelp();
    return null;
  }
  if (args.apply) return applyReviewedPlan(args, dependencies);
  return buildDryRunPlan(args, dependencies);
}

export function parseLegacyR2PointerMigrationArgs(argv) {
  const parsed = { sourceIds: [] };
  const flags = new Set(["apply", "help"]);
  const values = new Set([
    "source-id",
    "source-ids-file",
    "limit",
    "after-source-id",
    "ttl-minutes",
    "env",
    "output",
    "plan",
    "confirm",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw cliError("unexpected_argument", `Unexpected argument ${raw}.`);
    const [key, ...inline] = raw.slice(2).split("=");
    if (!flags.has(key) && !values.has(key)) throw cliError("unknown_option", `Unknown option --${key}.`);
    if (flags.has(key)) {
      if (inline.length) throw cliError("flag_value_forbidden", `--${key} does not accept a value.`);
      parsed[key] = true;
      continue;
    }
    let value;
    if (inline.length) value = inline.join("=");
    else {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) throw cliError("option_value_missing", `--${key} requires a value.`);
      index += 1;
    }
    if (key === "source-id") parsed.sourceIds.push(requiredUuid(value, "--source-id"));
    else parsed[key] = value;
  }
  parsed.sourceIds = unique(parsed.sourceIds);
  if (parsed.help) return parsed;

  if (parsed.apply) {
    if (!parsed.plan || !parsed.confirm) {
      throw cliError("apply_plan_required", "--apply requires --plan and --confirm.");
    }
    if (
      parsed.sourceIds.length
      || parsed["source-ids-file"]
      || parsed.limit
      || parsed["after-source-id"]
      || parsed["ttl-minutes"]
    ) {
      throw cliError(
        "apply_selector_forbidden",
        "Apply accepts only the exact reviewed plan; source selectors belong in a new dry-run.",
      );
    }
    return parsed;
  }
  if (parsed.plan || parsed.confirm) {
    throw cliError("preview_apply_option_forbidden", "--plan and --confirm are apply-only options.");
  }
  const hasExplicit = Boolean(parsed.sourceIds.length || parsed["source-ids-file"]);
  const hasLimit = parsed.limit != null;
  if (hasExplicit === hasLimit) {
    throw cliError(
      "selector_required",
      "Choose an exact --source-id/--source-ids-file allowlist or one bounded --limit, but not both.",
    );
  }
  if (hasExplicit && parsed["after-source-id"]) {
    throw cliError("cursor_with_allowlist", "--after-source-id is accepted only with --limit.");
  }
  if (parsed.limit != null) parsed.limit = boundedInteger(parsed.limit, "--limit", 1, maxBatchSize);
  if (parsed["after-source-id"]) {
    parsed["after-source-id"] = requiredUuid(parsed["after-source-id"], "--after-source-id");
  }
  parsed.ttlMinutes = parsed["ttl-minutes"] == null
    ? 120
    : boundedInteger(parsed["ttl-minutes"], "--ttl-minutes", 5, 1_440);
  return parsed;
}

async function buildDryRunPlan(args, dependencies) {
  const env = loadEnvironment(args.env);
  const supabase = dependencies.supabase || serviceClient(env);
  const objectStore = dependencies.objectStore || createR2ObjectStore(env);
  const ownsObjectStore = !dependencies.objectStore;
  try {
  const selector = await resolveSelector(args);
  const selected = await loadSelectedState(supabase, selector);
  const items = [];
  for (const sourceId of selected.sourceIds) {
    const row = selected.rowsById.get(sourceId) || null;
    const source = selected.sourcesById.get(sourceId) || null;
    if (!row || !source) {
      items.push(blockedLegacyR2MigrationItem({
        sourceId,
        source,
        row,
        error: cliError(
          !row ? "snapshot_pointer_missing" : "source_row_missing",
          !row
            ? "No visual snapshot pointer row exists for the selected source."
            : "The selected pointer has no source row.",
        ),
      }));
      continue;
    }
    try {
      const inspected = await inspectLegacyR2SnapshotPointer({
        row,
        source,
        objectStore,
        maxObjectBytes,
      });
      items.push(inspected.item);
    } catch (error) {
      items.push(blockedLegacyR2MigrationItem({ sourceId, source, row, error }));
    }
  }
  const builtAt = new Date().toISOString();
  const plan = buildLegacyR2PointerMigrationPlan({
    items,
    selector: selector.description,
    continuation: selected.continuation,
    builtAt,
    ttlMs: args.ttlMinutes * 60_000,
  });
  const outputPath = safeWorkspacePath(
    args.output || `reports/legacy-r2-pointer-migration-plan-${fileTimestamp(builtAt)}.json`,
    "plan output",
  );
  writeJsonExclusive(outputPath, plan);
  console.log(`LEGACY_R2_POINTER_MIGRATION_DRY_RUN ${outputPath}`);
  console.log(JSON.stringify({
    plan_sha256: plan.confirmation.plan_sha256,
    expires_at: plan.expires_at,
    summary: plan.summary,
    continuation: plan.continuation,
    apply_command:
      `node scripts/migrate-legacy-r2-snapshot-pointers.mjs --apply --plan="${outputPath}" --confirm=${plan.confirmation.plan_sha256}`,
    remote_writes: 0,
    legacy_objects_deleted: 0,
    live_fetches: 0,
    public_event_writes: 0,
    paid_api_calls: 0,
  }, null, 2));
  return { plan, outputPath };
  } finally {
    if (ownsObjectStore) await objectStore.destroy?.();
  }
}

async function applyReviewedPlan(args, dependencies) {
  const planPath = safeWorkspacePath(args.plan, "reviewed plan");
  const plan = assertLegacyR2PointerMigrationPlan(
    readJson(planPath, "reviewed legacy R2 migration plan"),
    args.confirm,
  );
  const env = loadEnvironment(args.env);
  const supabase = dependencies.supabase || serviceClient(env);
  const objectStore = dependencies.objectStore || createR2ObjectStore(env);
  const ownsObjectStore = !dependencies.objectStore;
  try {
  const receipts = [];
  let failures = 0;
  let quarantines = 0;
  let quarantineFailures = 0;

  for (const item of plan.items) {
    if (item.action === "already_immutable") {
      receipts.push({
        schema_version: LEGACY_R2_POINTER_RECEIPT_SCHEMA,
        status: "already_immutable_no_action",
        source_id: item.source_id,
        legacy_objects_deleted: 0,
        live_fetches: 0,
        public_event_writes: 0,
        baseline_refreshes: 0,
        paid_api_calls: 0,
      });
      continue;
    }
    if (item.action === "quarantine_only") {
      try {
        const [currentRow, currentSource] = await Promise.all([
          loadSnapshotRow(supabase, item.source_id),
          loadSourceRow(supabase, item.source_id),
        ]);
        assertReviewedQuarantinePrecondition(item, {
          row: currentRow,
          source: currentSource,
        });
      } catch (preconditionError) {
        failures += 1;
        receipts.push({
          schema_version: LEGACY_R2_POINTER_RECEIPT_SCHEMA,
          status: reasonCode(preconditionError) === "quarantine_precondition_stale"
            ? "stale_quarantine_plan_no_write"
            : "quarantine_precondition_check_failed_no_write",
          source_id: item.source_id,
          reason_code: reasonCode(preconditionError),
          message: safeError(preconditionError),
          recommended_action: "Rebuild and review a new dry-run plan; do not persist this stale failure.",
          quarantine_id: null,
          legacy_objects_deleted: 0,
          live_fetches: 0,
          public_event_writes: 0,
          baseline_refreshes: 0,
          paid_api_calls: 0,
        });
        continue;
      }
      failures += 1;
      const quarantine = await recordFailureQuarantine({
        supabase,
        plan,
        item,
        error: cliError(item.failure?.reason_code, item.failure?.message || "Plan item is blocked."),
      });
      if (quarantine.id) quarantines += 1;
      else quarantineFailures += 1;
      receipts.push({
        schema_version: LEGACY_R2_POINTER_RECEIPT_SCHEMA,
        status: quarantine.id ? "quarantined_without_pointer_change" : "quarantine_persistence_failed",
        source_id: item.source_id,
        reason_code: item.failure?.reason_code || null,
        quarantine_id: quarantine.id,
        quarantine_error: quarantine.error,
        post_cas_state: quarantine.evidence.post_cas_state,
        protection: quarantine.evidence.protection,
        immutable_objects_uploaded:
          quarantine.evidence.post_cas_state?.immutable_objects_uploaded || 0,
        legacy_objects_deleted: 0,
        live_fetches: 0,
        public_event_writes: 0,
        baseline_refreshes: 0,
        paid_api_calls: 0,
      });
      continue;
    }

    try {
      const [currentRow, source] = await Promise.all([
        loadSnapshotRow(supabase, item.source_id),
        loadSourceRow(supabase, item.source_id),
      ]);
      if (!currentRow || !source) {
        throw cliError("apply_state_missing", "The reviewed source or pointer row no longer exists.");
      }
      const receipt = await applyLegacyR2SnapshotPointerItem({
        planItem: item,
        currentRow,
        source,
        objectStore,
        compareAndSetObjectKeys: (input) => compareAndSetObjectKeys(supabase, input),
        loadCurrentRow: (sourceId) => loadSnapshotRow(supabase, sourceId),
      });
      receipts.push(receipt);
    } catch (error) {
      failures += 1;
      const quarantine = await recordFailureQuarantine({ supabase, plan, item, error });
      if (quarantine.id) quarantines += 1;
      else quarantineFailures += 1;
      receipts.push({
        schema_version: LEGACY_R2_POINTER_RECEIPT_SCHEMA,
        status: quarantine.id ? "failed_closed_and_quarantined" : "failed_closed_quarantine_persistence_failed",
        source_id: item.source_id,
        reason_code: reasonCode(error),
        message: safeError(error),
        quarantine_id: quarantine.id,
        quarantine_error: quarantine.error,
        post_cas_state: quarantine.evidence.post_cas_state,
        protection: quarantine.evidence.protection,
        immutable_objects_uploaded:
          quarantine.evidence.post_cas_state?.immutable_objects_uploaded || 0,
        legacy_objects_deleted: 0,
        live_fetches: 0,
        public_event_writes: 0,
        baseline_refreshes: 0,
        paid_api_calls: 0,
      });
    }
  }

  const completedAt = new Date().toISOString();
  const receipt = {
    schema_version: "awardping.legacy-r2-snapshot-pointer-migration-batch-receipt.v5",
    status: failures ? "completed_with_protected_failures" : "applied",
    plan_sha256: plan.confirmation.plan_sha256,
    completed_at: completedAt,
    summary: {
      selected: plan.items.length,
      applied: receipts.filter((entry) => entry.status === "applied").length,
      already_applied: receipts.filter((entry) => entry.status.startsWith("already_")).length,
      failures,
      quarantines,
      quarantine_persistence_failures: quarantineFailures,
      legacy_objects_deleted: 0,
      live_fetches: 0,
      public_event_writes: 0,
      baseline_refreshes: 0,
      paid_api_calls: 0,
    },
    items: receipts,
  };
  receipt.receipt_sha256 = sha256Bytes(Buffer.from(stableJson(receipt), "utf8"));
  const outputPath = safeWorkspacePath(
    args.output || `reports/legacy-r2-pointer-migration-receipt-${fileTimestamp(completedAt)}.json`,
    "apply receipt output",
  );
  writeJsonExclusive(outputPath, receipt);
  console.log(`LEGACY_R2_POINTER_MIGRATION_APPLY_RECEIPT ${outputPath}`);
  console.log(JSON.stringify(receipt.summary, null, 2));
  if (failures || quarantineFailures) process.exitCode = 1;
  return { receipt, outputPath };
  } finally {
    if (ownsObjectStore) await objectStore.destroy?.();
  }
}

async function resolveSelector(args) {
  if (args.limit != null) {
    return {
      mode: "bounded_cursor",
      limit: args.limit,
      afterSourceId: args["after-source-id"] || null,
      description: {
        mode: "bounded_cursor",
        limit: args.limit,
        after_source_id: args["after-source-id"] || null,
      },
    };
  }
  const fileIds = args["source-ids-file"]
    ? parseSourceIdsFile(safeWorkspacePath(args["source-ids-file"], "source ID allowlist"))
    : [];
  const sourceIds = unique([...args.sourceIds, ...fileIds]);
  if (!sourceIds.length || sourceIds.length > maxBatchSize) {
    throw cliError(
      "source_allowlist_size_invalid",
      `The exact source allowlist must contain 1 through ${maxBatchSize} unique UUIDs.`,
    );
  }
  return {
    mode: "exact_allowlist",
    sourceIds,
    description: {
      mode: "exact_allowlist",
      source_ids: sourceIds,
      source_count: sourceIds.length,
    },
  };
}

async function loadSelectedState(supabase, selector) {
  let rows;
  let hasMore = false;
  if (selector.mode === "bounded_cursor") {
    let query = supabase
      .from("shared_award_source_visual_snapshots")
      .select(snapshotSelect)
      .order("shared_award_source_id", { ascending: true })
      .limit(selector.limit + 1);
    if (selector.afterSourceId) query = query.gt("shared_award_source_id", selector.afterSourceId);
    const result = await query;
    if (result.error) throw cliError("snapshot_scan_failed", `Snapshot scan failed: ${result.error.message}`);
    rows = result.data || [];
    hasMore = rows.length > selector.limit;
    rows = rows.slice(0, selector.limit);
  } else {
    rows = await loadSnapshotRowsByIds(supabase, selector.sourceIds);
  }
  const rowsById = new Map(rows.map((row) => [row.shared_award_source_id, row]));
  const sourceIds = selector.mode === "exact_allowlist"
    ? selector.sourceIds
    : rows.map((row) => row.shared_award_source_id);
  if (!sourceIds.length) throw cliError("selector_empty", "The bounded selector returned no snapshot rows.");
  const sources = await loadSourceRowsByIds(supabase, sourceIds);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const lastSourceId = sourceIds.at(-1) || null;
  return {
    sourceIds,
    rowsById,
    sourcesById,
    continuation: selector.mode === "bounded_cursor"
      ? {
          has_more: hasMore,
          next_after_source_id: hasMore ? lastSourceId : null,
          processed_through_source_id: lastSourceId,
        }
      : { has_more: false, next_after_source_id: null },
  };
}

async function loadSnapshotRowsByIds(supabase, sourceIds) {
  const rows = [];
  for (const ids of chunks(sourceIds, 100)) {
    const { data, error } = await supabase
      .from("shared_award_source_visual_snapshots")
      .select(snapshotSelect)
      .in("shared_award_source_id", ids);
    if (error) throw cliError("snapshot_load_failed", `Snapshot load failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function loadSourceRowsByIds(supabase, sourceIds) {
  const rows = [];
  for (const ids of chunks(sourceIds, 100)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select(sourceSelect)
      .in("id", ids);
    if (error) throw cliError("source_load_failed", `Source load failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function loadSnapshotRow(supabase, sourceId) {
  const { data, error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .select(snapshotSelect)
    .eq("shared_award_source_id", sourceId)
    .maybeSingle();
  if (error) throw cliError("snapshot_load_failed", `Snapshot load failed: ${error.message}`);
  return data || null;
}

async function loadSourceRow(supabase, sourceId) {
  const { data, error } = await supabase
    .from("shared_award_sources")
    .select(sourceSelect)
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw cliError("source_load_failed", `Source load failed: ${error.message}`);
  return data || null;
}

async function compareAndSetObjectKeys(supabase, {
  sourceId,
  expectedUpdatedAt,
  latestObjectKeys,
  previousObjectKeys,
  metadataUpdates = {},
}) {
  const nextUpdatedAt = new Date().toISOString();
  const metadataPatch = validateMetadataUpdates(metadataUpdates);
  const { data, error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .update({
      latest_object_keys: latestObjectKeys,
      previous_object_keys: previousObjectKeys,
      ...metadataPatch,
      updated_at: nextUpdatedAt,
    })
    .eq("shared_award_source_id", sourceId)
    .eq("updated_at", expectedUpdatedAt)
    .select(snapshotSelect)
    .maybeSingle();
  if (error) throw cliError("snapshot_pointer_cas_failed", `Pointer CAS failed: ${error.message}`);
  return { advanced: Boolean(data), row: data || null };
}

function validateMetadataUpdates(value) {
  const updates = jsonObject(value);
  for (const field of Object.keys(updates)) {
    if (!new Set(["latest_metadata", "previous_metadata"]).has(field)) {
      throw cliError("metadata_update_field_invalid", `Unsupported metadata update field ${field}.`);
    }
    if (!updates[field] || typeof updates[field] !== "object" || Array.isArray(updates[field])) {
      throw cliError("metadata_update_value_invalid", `${field} must be a JSON object.`);
    }
  }
  return updates;
}

async function recordFailureQuarantine({ supabase, plan, item, error }) {
  const evidence = migrationFailureQuarantineEvidence({ plan, item, error });
  try {
    const { data, error: rpcError } = await supabase.rpc("record_r2_baseline_recovery_quarantine", {
      p_source_id: item.source_id,
      p_reason_code: reasonCode(error),
      p_evidence: evidence,
    });
    if (rpcError || !data) {
      return {
        id: null,
        error: rpcError?.message || "quarantine RPC returned no ID",
        evidence,
      };
    }
    return { id: data, error: null, evidence };
  } catch (quarantineError) {
    return { id: null, error: safeError(quarantineError), evidence };
  }
}

export function createR2ObjectStore(env, { client = null } = {}) {
  const bucket = requiredText(env.R2_BUCKET, "R2_BUCKET");
  const endpoint = cleanText(env.R2_ENDPOINT)
    || `https://${requiredText(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const owned = !client;
  const r2 = client || new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredText(env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredText(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
    },
  });
  return {
    bucket,
    destroy() {
      if (owned) r2.destroy();
    },
    async readObject({ key, maxBytes = maxObjectBytes }) {
      const safeKey = safeR2Key(key);
      const head = await sendR2(r2, () => new HeadObjectCommand({
        Bucket: bucket,
        Key: safeKey,
        ChecksumMode: "ENABLED",
      }), `HEAD ${safeKey}`);
      const headLength = Number(head.ContentLength);
      if (!Number.isSafeInteger(headLength) || headLength < 0 || headLength > maxBytes) {
        throw cliError("r2_object_size_invalid", `R2 object ${safeKey} has an unsafe byte length.`);
      }
      const get = await sendR2(r2, () => new GetObjectCommand({
        Bucket: bucket,
        Key: safeKey,
        IfMatch: head.ETag,
        ChecksumMode: "ENABLED",
      }), `GET ${safeKey}`);
      const body = await bodyBuffer(get.Body, maxBytes, safeKey);
      if (headLength !== body.length || Number(get.ContentLength) !== body.length) {
        throw cliError("r2_object_length_mismatch", `R2 object ${safeKey} changed length during verification.`);
      }
      if (normalizeEtag(head.ETag) !== normalizeEtag(get.ETag)) {
        throw cliError("r2_object_etag_changed", `R2 object ${safeKey} changed between HEAD and GET.`);
      }
      const headMetadata = jsonObject(head.Metadata);
      const getMetadata = jsonObject(get.Metadata);
      if (stableJson(headMetadata) !== stableJson(getMetadata)) {
        throw cliError("r2_object_metadata_changed", `R2 object ${safeKey} metadata changed during verification.`);
      }
      if ((head.ChecksumSHA256 || null) !== (get.ChecksumSHA256 || null)) {
        throw cliError("r2_object_checksum_changed", `R2 object ${safeKey} checksum changed during verification.`);
      }
      if (mediaType(head.ContentType) !== mediaType(get.ContentType)) {
        throw cliError("r2_object_content_type_changed", `R2 object ${safeKey} content type changed during verification.`);
      }
      return {
        key: safeKey,
        body,
        byte_length: body.length,
        content_type: get.ContentType || head.ContentType || null,
        etag: get.ETag || head.ETag,
        metadata: getMetadata,
        checksum_sha256: get.ChecksumSHA256 || head.ChecksumSHA256 || null,
      };
    },
    async putObjectIfAbsent({ key, body, contentType, sha256 }) {
      const safeKey = safeR2Key(key);
      if (!Buffer.isBuffer(body)) throw cliError("put_body_invalid", "Immutable R2 PUT requires a Buffer.");
      const actualSha256 = sha256Bytes(body);
      if (actualSha256 !== requiredSha256(sha256, "immutable object SHA-256")) {
        throw cliError("put_sha256_mismatch", `Immutable R2 PUT bytes do not match ${safeKey}.`);
      }
      try {
        await sendR2(r2, () => new PutObjectCommand({
          Bucket: bucket,
          Key: safeKey,
          Body: body,
          ContentLength: body.length,
          ContentType: requiredText(contentType, "immutable object content type"),
          Metadata: { sha256: actualSha256 },
          ChecksumSHA256: Buffer.from(actualSha256, "hex").toString("base64"),
          IfNoneMatch: "*",
        }), `PUT-IF-ABSENT ${safeKey}`, { attempts: 1 });
        return { created: true };
      } catch (error) {
        if (isPreconditionFailed(error)) return { created: false };
        throw error;
      }
    },
  };
}

async function sendR2(client, createCommand, label, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.send(createCommand());
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryableR2Error(error)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (2 ** (attempt - 1))));
    }
  }
  const wrapped = cliError(reasonCode(lastError) || "r2_operation_failed", `${label} failed: ${safeError(lastError)}`);
  wrapped.cause = lastError;
  throw wrapped;
}

async function bodyBuffer(body, maxBytes, key) {
  if (!body) throw cliError("r2_object_body_missing", `R2 object ${key} returned no body.`);
  let bytes;
  if (Buffer.isBuffer(body)) bytes = body;
  else if (body instanceof Uint8Array) bytes = Buffer.from(body);
  else if (typeof body.transformToByteArray === "function") {
    bytes = Buffer.from(await body.transformToByteArray());
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let length = 0;
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > maxBytes) throw cliError("r2_object_too_large", `R2 object ${key} exceeded its byte limit.`);
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } else throw cliError("r2_object_body_unreadable", `R2 object ${key} body is unreadable.`);
  if (bytes.length > maxBytes) throw cliError("r2_object_too_large", `R2 object ${key} exceeded its byte limit.`);
  return bytes;
}

function loadEnvironment(pathValue) {
  const envPath = resolve(root, String(pathValue || defaultEnvFile()));
  if (!existsSync(envPath)) throw cliError("env_file_missing", `Environment file does not exist: ${envPath}`);
  const env = { ...loadEnvFile(envPath), ...process.env };
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]) requiredText(env[name], name);
  if (!cleanText(env.R2_ENDPOINT)) requiredText(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID");
  return env;
}

function serviceClient(env) {
  transportOpened = true;
  return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function loadEnvFile(path) {
  const output = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    output[key] = value;
  }
  return output;
}

function defaultEnvFile() {
  return existsSync(resolve(root, ".env.worker.local")) ? ".env.worker.local" : ".env.local";
}

function parseSourceIdsFile(path) {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  let values;
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    values = Array.isArray(parsed) ? parsed : parsed.source_ids;
    if (!Array.isArray(values)) throw cliError("source_ids_file_invalid", "Source ID JSON must be an array or contain source_ids.");
  } else {
    values = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  }
  return unique(values.map((value) => requiredUuid(value, "source ID allowlist entry")));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw cliError("json_read_failed", `Cannot read ${label} ${path}: ${safeError(error)}`);
  }
}

function writeJsonExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function safeWorkspacePath(pathValue, label) {
  const path = resolve(root, requiredText(pathValue, label));
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw cliError("workspace_path_escape", `${label} must remain inside the workspace.`);
  }
  return path;
}

function safeR2Key(value) {
  const key = requiredText(value, "R2 object key");
  if (key.startsWith("/") || key.includes("\\") || key.includes("..") || /[\u0000-\u001f]/u.test(key)) {
    throw cliError("r2_key_unsafe", "R2 object key is unsafe.");
  }
  return key;
}

function retryableR2Error(error) {
  const status = Number(error?.$metadata?.httpStatusCode);
  const code = cleanText(error?.name || error?.code).toLowerCase();
  return status === 429 || status >= 500 || /timeout|throttl|slowdown|econn|network|socket/u.test(code);
}

function isPreconditionFailed(error) {
  const status = Number(error?.$metadata?.httpStatusCode || error?.cause?.$metadata?.httpStatusCode);
  const identity = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.name,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(" ");
  return status === 412 || /preconditionfailed/iu.test(identity);
}

function reasonCode(error) {
  return cleanText(error?.code || error?.name || "legacy_r2_pointer_migration_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 200) || "legacy_r2_pointer_migration_failed";
}

function cliError(code, message) {
  const error = new Error(message);
  error.code = reasonCode({ code });
  return error;
}

function requiredUuid(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!uuidPattern.test(text)) throw cliError("uuid_invalid", `${label} is not a UUID.`);
  return text;
}

function requiredSha256(value, label) {
  const text = cleanText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw cliError("sha256_invalid", `${label} is not SHA-256.`);
  return text;
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw cliError("text_missing", `${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw cliError("integer_invalid", `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function unique(values) {
  return [...new Set(values)];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeEtag(value) {
  return cleanText(value).replace(/^W\//iu, "").replace(/^"|"$/gu, "").toLowerCase();
}

function mediaType(value) {
  return cleanText(value).split(";", 1)[0].toLowerCase();
}

function fileTimestamp(value) {
  return value.replace(/[:.]/gu, "-");
}

function safeError(error) {
  return String(error?.message || error || "unknown failure")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/gu, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/gu, "[redacted-key]")
    .slice(0, 2_000);
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function printHelp() {
  console.log(`Usage:
  node scripts/migrate-legacy-r2-snapshot-pointers.mjs --source-id=<uuid> [--source-id=<uuid> ...]
  node scripts/migrate-legacy-r2-snapshot-pointers.mjs --source-ids-file=<path>
  node scripts/migrate-legacy-r2-snapshot-pointers.mjs --limit=<1-${maxBatchSize}> [--after-source-id=<uuid>]
  node scripts/migrate-legacy-r2-snapshot-pointers.mjs --apply --plan=<plan.json> --confirm=<plan-sha256>

Dry-run options (default; remote reads only):
  --source-id=<uuid>       Repeatable exact source allowlist
  --source-ids-file=<path> JSON array/object with source_ids, or newline list
  --limit=<number>         Bounded source-ID cursor batch; never unbounded
  --after-source-id=<uuid> Resume the bounded scan after this exact ID
  --ttl-minutes=<5-1440>   Plan validity, default 120 minutes
  --env=<path>             Defaults to .env.worker.local, then .env.local
  --output=<path>          Write-once plan path inside the workspace

Apply options:
  --apply                  Enable reviewed R2/DB writes
  --plan=<path>            Exact write-once dry-run plan
  --confirm=<sha-or-phrase> Exact immutable plan hash or confirmation phrase
  --output=<path>          Write-once apply receipt inside the workspace

Safety contract:
  Dry-run performs only Supabase SELECT and R2 HEAD/conditional GET operations.
  Apply writes byte-identical content to deterministic immutable generation keys,
  using destination-if-absent, SHA-256 metadata/checksum, and post-write HEAD/GET.
  It CAS-updates the two object-key fields and updated_at. When the reviewed
  retained text bytes prove that an older generation lacks text_object_bytes,
  it may also add only that derived field to the corresponding metadata JSON.
  It may add the shared artifact-bindings schema and exact raw SHA/length/type
  map for every already-verified object referenced by that generation.
  For a generation with no layout or expansion claim, it may add only truthful
  zero-expansion and evidence-only geometry-unavailable accounting. Existing
  metadata values are never overwritten; conflicts fail closed to quarantine.
  It never deletes legacy objects, fetches a live page, refreshes a baseline,
  writes a public event, or calls a paid API. Failed reviewed items are placed in
  the durable no-charge R2 recovery quarantine and keep their old pointer.`);
}
