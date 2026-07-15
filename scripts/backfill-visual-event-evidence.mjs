#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createPublishedVisualArtifactStore,
  preparePublishedVisualEventEvidence,
} from "./lib/visual-event-evidence.mjs";
import {
  backfillEvidenceRpcPayload,
  candidateSignatureFromEvent,
  createDryRunPublishedArtifactStore,
  createImmutablePublishedArtifactStore,
  executeHistoricalBackfillStep,
  historicalArtifactUnrecoverableEvidence,
  historicalBackfillRepairPlan,
  isSnapshottedLegacyVisualEvidenceBackfill,
  matchHistoricalTerminalLossConfirmation,
  normalizePreparedHistoricalEvidence,
  parseHistoricalTerminalLossConfirmations,
  requiresLegacyVisualEvidenceBackfill,
  resolveHistoricalEventCandidate,
} from "./lib/visual-event-evidence-backfill.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const args = parseArgs(process.argv.slice(2));
const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = boolArg(args.apply, false);
const resume = boolArg(args.resume, false);
const limit = positiveInt(args.limit, 100_000);
const pageSize = boundedInt(args["page-size"], 100, 1, 500);
const reverseLookupConcurrency = boundedInt(args.concurrency, 12, 1, 30);
const archiveRoot = resolve(String(
  args["archive-dir"] || env.AWARDPING_VISUAL_SNAPSHOT_DIR || defaultArchiveRoot,
));
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `visual-event-evidence-backfill-${timestampForPath(new Date().toISOString())}.json`);
const checkpointPath = args.checkpoint
  ? resolve(root, String(args.checkpoint))
  : join(reportDir, "visual-event-evidence-backfill-checkpoint.json");
const checkpoint = resume ? readJson(checkpointPath) : null;
const initialAfterId = cleanText(args["after-id"] || checkpoint?.last_event_id) || null;
const terminalLossConfirmationsPath = args["terminal-loss-confirmations"]
  ? resolve(root, String(args["terminal-loss-confirmations"]))
  : null;
const terminalLossConfirmations = loadTerminalLossConfirmations(terminalLossConfirmationsPath);

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const r2AccountId = cleanText(args["r2-account-id"] || env.R2_ACCOUNT_ID);
const r2Endpoint = cleanText(
  args["r2-endpoint"] || env.R2_ENDPOINT ||
  (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ""),
);
const r2Bucket = cleanText(args["r2-bucket"] || env.R2_BUCKET || "awardping-snapshots");
const r2AccessKeyId = cleanText(args["r2-access-key-id"] || env.R2_ACCESS_KEY_ID);
const r2SecretAccessKey = cleanText(args["r2-secret-access-key"] || env.R2_SECRET_ACCESS_KEY);

if (!supabaseUrl || !serviceRoleKey) fail("Supabase worker configuration is required.");
if (apply && (!r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey)) {
  fail("Cloudflare R2 worker configuration is required with --apply.");
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const baseStore = apply
  ? createPublishedVisualArtifactStore({
      bucket: r2Bucket,
      endpoint: r2Endpoint,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    })
  : null;
const artifactStore = apply
  ? createImmutablePublishedArtifactStore(baseStore)
  : createDryRunPublishedArtifactStore(r2Bucket);
const candidateSelect = [
  "id", "shared_award_id", "shared_award_source_id", "candidate_signature",
  "source_url", "source_title", "source_page_type", "previous_snapshot_ref",
  "new_snapshot_ref", "previous_text_hash", "new_text_hash", "previous_image_hash",
  "new_image_hash", "previous_file_hash", "new_file_hash", "deterministic_diff",
  "prompt_payload", "worker_metadata", "status",
  "created_at",
].join(",");
const startedAt = new Date().toISOString();
const report = {
  version: 1,
  mode: apply ? "apply" : "dry_run",
  apply,
  resume,
  archive_root: archiveRoot,
  started_at: startedAt,
  initial_after_id: initialAfterId,
  last_event_id: initialAfterId,
  last_scanned_event_id: initialAfterId,
  terminal_loss_confirmations_path: terminalLossConfirmationsPath,
  terminal_loss_confirmations_available: terminalLossConfirmations.size,
  terminal_loss_confirmations_applied: 0,
  scanned_events: 0,
  existing_evidence_events: 0,
  candidate_bound_events: 0,
  partial_retained_events: 0,
  historical_unrecoverable_events: 0,
  unavailable_geometry_events: 0,
  verified_events: 0,
  inserted_events: 0,
  equivalent_existing_events: 0,
  resolution_methods: {},
  unresolved_reasons: {},
  pending_linkage_events: 0,
  blocked: false,
  blocked_event_id: null,
  blocked_reason_code: null,
  blocked_solution: null,
  pending_linkage_event_ids: [],
  noncontiguous_completed_events: 0,
  repair_plan: {},
  samples: [],
  failure_samples: [],
};

let activeEventId = null;
let contiguousCheckpointBlocked = false;
try {
  let cursor = initialAfterId;
  while (report.scanned_events < limit) {
    const page = await loadEventPage(cursor, Math.min(pageSize, limit - report.scanned_events));
    if (!page.length) break;
    const existingEvidenceIds = await loadExistingEvidenceIds(page.map((event) => event.id));
    const pendingEvents = page.filter((event) => !existingEvidenceIds.has(event.id));
    const candidateInputs = await loadCandidateInputs(pendingEvents, reverseLookupConcurrency);

    for (const event of page) {
      activeEventId = event.id;
      report.scanned_events += 1;
      report.last_scanned_event_id = event.id;
      if (existingEvidenceIds.has(event.id)) {
        report.existing_evidence_events += 1;
        advanceCompletedEvent(event.id);
        activeEventId = null;
        continue;
      }

      const inputs = candidateInputs.get(event.id) || {};
      const resolution = resolveHistoricalEventCandidate({ event, ...inputs });
      const legacyContractMissing = resolution.resolved &&
        requiresLegacyVisualEvidenceBackfill(resolution.candidate);
      const legacyFallback = resolution.resolved && isSnapshottedLegacyVisualEvidenceBackfill({
        event,
        candidate: resolution.candidate,
        resolutionMethods: resolution.methods,
        eligibility: inputs.legacyEligibility,
      });
      const resolutionTerminalLossConfirmation = matchHistoricalTerminalLossConfirmation({
        confirmation: terminalLossConfirmations.get(event.id),
        currentReasonCode: resolution.reason_code,
      });
      const step = await executeHistoricalBackfillStep({
        createEvidence: async () => {
          if (!resolution.resolved) {
            if (resolutionTerminalLossConfirmation.accepted) {
              return {
                evidence: historicalArtifactUnrecoverableEvidence({
                  event,
                  reason: resolutionTerminalLossConfirmation.confirmation.reason,
                  terminalArtifactLossConfirmed: true,
                  terminalArtifactLossConfirmation: resolutionTerminalLossConfirmation.confirmation,
                }),
                outcome: "terminal_artifact_loss_confirmed",
                issue_reason: resolutionTerminalLossConfirmation.confirmation.reason,
                repair_reason_code: null,
                count_unresolved: false,
                terminal_loss_confirmed: true,
                resolution_methods: ["operator_terminal_loss_confirmation"],
              };
            }
            return {
              evidence: null,
              outcome: resolutionTerminalLossConfirmation.reason_code || resolution.reason_code,
              issue_reason: resolutionTerminalLossConfirmation.reason || resolution.reason,
              repair_reason_code: resolutionTerminalLossConfirmation.reason_code || resolution.reason_code,
              count_unresolved: true,
              retryable: true,
              publishable: false,
              resolution_methods: [],
            };
          }
          if (legacyContractMissing && !legacyFallback) {
            return {
              evidence: null,
              outcome: "legacy_eligibility_snapshot_missing",
              issue_reason: "This pre-manifest candidate lacks the exact signature, reverse binding, or one-time eligibility snapshot required by the legacy compatibility contract.",
              repair_reason_code: "legacy_eligibility_snapshot_missing",
              count_unresolved: true,
              retryable: true,
              publishable: false,
              resolution_methods: resolution.methods,
            };
          }
          const candidate = resolution.candidate;
          const prepared = await preparePublishedVisualEventEvidence({
            candidate,
            source: sourceFromEvent(event),
            changeDetails: event.change_details,
            archiveRoot,
            artifactStore,
            historical: true,
            legacyFallback,
            now: startedAt,
          });
          const normalized = normalizePreparedHistoricalEvidence({ event, candidate, evidence: prepared });
          if (!normalized.recoverable) {
            const confirmation = matchHistoricalTerminalLossConfirmation({
              confirmation: terminalLossConfirmations.get(event.id),
              currentReasonCode: normalized.reason_code,
            });
            if (confirmation.accepted) {
              return {
                evidence: historicalArtifactUnrecoverableEvidence({
                  event,
                  candidate,
                  reason: confirmation.confirmation.reason,
                  terminalArtifactLossConfirmed: true,
                  terminalArtifactLossConfirmation: confirmation.confirmation,
                }),
                outcome: "terminal_artifact_loss_confirmed",
                issue_reason: confirmation.confirmation.reason,
                repair_reason_code: null,
                count_unresolved: false,
                terminal_loss_confirmed: true,
                resolution_methods: [...resolution.methods, "operator_terminal_loss_confirmation"],
              };
            }
            return {
              evidence: null,
              outcome: confirmation.reason_code || normalized.reason_code,
              issue_reason: confirmation.reason || normalized.reason,
              repair_reason_code: confirmation.reason_code || normalized.reason_code,
              count_unresolved: true,
              retryable: true,
              publishable: false,
              resolution_methods: resolution.methods,
            };
          }
          return {
            evidence: normalized.evidence,
            outcome: normalized.reason_code || (normalized.recoverable ? "candidate_bound" : "unrecoverable"),
            issue_reason: normalized.reason || null,
            repair_reason_code: normalized.reason_code || null,
            count_unresolved: !normalized.recoverable,
            partial: normalized.partial === true,
            resolution_methods: legacyFallback
              ? [...resolution.methods, "legacy_eligibility_registry"]
              : resolution.methods,
          };
        },
        recoverDeterministicFailure: async (error) => {
          const candidate = resolution.candidate;
          const failure = historicalArtifactFailure(error);
          const confirmation = matchHistoricalTerminalLossConfirmation({
            confirmation: terminalLossConfirmations.get(event.id),
            currentReasonCode: failure.reason_code,
          });
          if (!confirmation.accepted) {
            return {
              evidence: null,
              outcome: confirmation.reason_code || failure.reason_code,
              issue_reason: confirmation.reason || failure.reason,
              repair_reason_code: confirmation.reason_code || failure.reason_code,
              count_unresolved: true,
              retryable: true,
              publishable: false,
              resolution_methods: resolution.methods,
            };
          }
          return {
            evidence: historicalArtifactUnrecoverableEvidence({
              event,
              candidate,
              reason: confirmation.confirmation.reason,
              terminalArtifactLossConfirmed: true,
              terminalArtifactLossConfirmation: confirmation.confirmation,
            }),
            outcome: "terminal_artifact_loss_confirmed",
            issue_reason: confirmation.confirmation.reason,
            repair_reason_code: null,
            count_unresolved: false,
            terminal_loss_confirmed: true,
            resolution_methods: [...resolution.methods, "operator_terminal_loss_confirmation"],
          };
        },
        publishEvidence: apply
          ? (evidence) => backfillEvidence(event.id, evidence, legacyFallback)
          : null,
        advance: () => advanceCompletedEvent(event.id),
      });
      const {
        evidence,
        outcome,
        issue_reason: issueReason,
        repair_reason_code: repairReasonCode,
        publication,
      } = step;
      for (const method of step.resolution_methods) increment(report.resolution_methods, method);
      if (step.terminal_loss_confirmed) report.terminal_loss_confirmations_applied += 1;
      if (step.partial) report.partial_retained_events += 1;
      if (step.count_unresolved) increment(report.unresolved_reasons, repairReasonCode);
      const repair = repairReasonCode ? recordRepair(repairReasonCode) : null;

      if (step.retryable) report.pending_linkage_events += 1;
      if (evidence?.visual_review_candidate_id) report.candidate_bound_events += 1;
      if (evidence?.evidence_status === "historical_artifact_unrecoverable") {
        report.historical_unrecoverable_events += 1;
      }
      if (evidence?.evidence_status === "unavailable_geometry_missing") {
        report.unavailable_geometry_events += 1;
      }
      if (evidence?.evidence_status === "verified") report.verified_events += 1;

      if (apply && publication) {
        if (publication.inserted === false) report.equivalent_existing_events += 1;
        else report.inserted_events += 1;
      }
      if (report.samples.length < 30) {
        report.samples.push({
          event_id: event.id,
          suppressed: Boolean(event.suppressed_at),
          outcome,
          evidence_status: evidence?.evidence_status || "pending_operator_linkage",
          candidate_id: evidence?.visual_review_candidate_id || null,
          solution: repair?.solution || null,
        });
      }
      if (repair && report.failure_samples.length < 30) {
        report.failure_samples.push({
          event_id: event.id,
          suppressed: Boolean(event.suppressed_at),
          reason_code: outcome,
          reason: issueReason,
          evidence_status: evidence?.evidence_status || "pending_operator_linkage",
          candidate_id: evidence?.visual_review_candidate_id || null,
          repair_category: repair.category,
          solution: repair.solution,
        });
      }
      if (step.retryable) {
        if (apply) {
          report.blocked = true;
          report.blocked_event_id ||= event.id;
          report.blocked_reason_code ||= repairReasonCode;
          report.blocked_solution ||= repair?.solution || null;
          report.pending_linkage_event_ids.push(event.id);
          contiguousCheckpointBlocked = true;
        } else {
          // Dry runs are discovery-only, so keep scanning and report every repairable
          // linkage issue without creating evidence or a durable checkpoint.
          advance(event.id);
        }
      }
      activeEventId = null;
    }

    cursor = page.at(-1).id;
    console.log(
      `VISUAL_EVENT_EVIDENCE_BACKFILL_PAGE mode=${report.mode} scanned=${report.scanned_events} last_event_id=${cursor}`,
    );
    if (page.length < pageSize) break;
  }

  report.finished_at = new Date().toISOString();
  report.complete = apply ? !report.blocked : true;
  atomicWriteJson(reportPath, report);
  console.log(`VISUAL_EVENT_EVIDENCE_BACKFILL_REPORT ${reportPath}`);
  console.log(JSON.stringify(report));
  if (report.blocked) process.exitCode = 2;
} catch (error) {
  const failure = operationalBackfillFailure(error) || {
    reason_code: "backfill_execution_failure",
    reason: "The backfill stopped before the active event was durably completed.",
  };
  const repair = recordRepair(failure.reason_code);
  increment(report.unresolved_reasons, failure.reason_code);
  report.finished_at = new Date().toISOString();
  report.complete = false;
  report.error = errorMessage(error);
  report.error_reason_code = failure.reason_code;
  report.error_solution = repair.solution;
  if (report.failure_samples.length < 30) {
    report.failure_samples.push({
      event_id: activeEventId,
      reason_code: failure.reason_code,
      reason: failure.reason,
      repair_category: repair.category,
      solution: repair.solution,
    });
  }
  atomicWriteJson(reportPath, report);
  console.error(`VISUAL_EVENT_EVIDENCE_BACKFILL_FAILED ${report.error}`);
  process.exitCode = 1;
} finally {
  artifactStore.destroy?.();
}

function advance(eventId) {
  report.last_event_id = eventId;
  if (apply) {
    atomicWriteJson(checkpointPath, {
      version: 1,
      last_event_id: eventId,
      updated_at: new Date().toISOString(),
      report_path: reportPath,
      scanned_events: report.scanned_events,
    });
  }
}

function advanceCompletedEvent(eventId) {
  if (apply && contiguousCheckpointBlocked) {
    report.noncontiguous_completed_events += 1;
    return;
  }
  advance(eventId);
}

async function loadEventPage(afterId, count) {
  let query = supabase
    .from("shared_award_change_events")
    .select(
      "id,shared_award_id,shared_award_source_id,source_url,source_title,source_page_type,previous_hash,new_hash,change_details,suppressed_at,detected_at,visual_review_candidate_id",
    )
    .order("id", { ascending: true })
    .limit(count);
  if (afterId) query = query.gt("id", afterId);
  const { data, error } = await query;
  if (error) throw new Error(`Load change-event page failed: ${error.message}`);
  return data || [];
}

async function loadExistingEvidenceIds(eventIds) {
  const ids = new Set();
  for (const chunk of chunks(eventIds, 100)) {
    const { data, error } = await supabase
      .from("shared_award_change_event_visual_evidence")
      .select("change_event_id")
      .in("change_event_id", chunk);
    if (error) throw new Error(`Load existing event evidence failed: ${error.message}`);
    for (const row of data || []) ids.add(row.change_event_id);
  }
  return ids;
}

async function loadCandidateInputs(events, concurrency) {
  const directIds = unique(events.map((event) => cleanText(event.visual_review_candidate_id)).filter(Boolean));
  const signatures = unique(events.map(candidateSignatureFromEvent).filter(Boolean));
  const [directRows, signatureRows, eligibilityRows] = await Promise.all([
    loadCandidatesBy("id", directIds),
    loadCandidatesBy("candidate_signature", signatures),
    loadLegacyEligibility(events.map((event) => event.id)),
  ]);
  const byId = groupBy(directRows, (candidate) => candidate.id);
  const bySignature = groupBy(signatureRows, (candidate) => candidate.candidate_signature);
  const reverseByEvent = new Map();
  const eligibilityByEvent = new Map(
    eligibilityRows.map((row) => [row.change_event_id, row]),
  );
  await promisePool(events, concurrency, async (event) => {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .select(candidateSelect)
      .contains("worker_metadata", { change_event_id: event.id })
      .limit(3);
    if (error) throw new Error(`Reverse candidate lookup failed for ${event.id}: ${error.message}`);
    reverseByEvent.set(event.id, data || []);
  });

  return new Map(events.map((event) => [event.id, {
    directCandidates: byId.get(event.visual_review_candidate_id) || [],
    signatureCandidates: bySignature.get(candidateSignatureFromEvent(event)) || [],
    reverseCandidates: reverseByEvent.get(event.id) || [],
    legacyEligibility: eligibilityByEvent.get(event.id) || null,
  }]));
}

async function loadLegacyEligibility(eventIds) {
  const rows = [];
  for (const chunk of chunks(eventIds, 100)) {
    const { data, error } = await supabase
      .from("shared_award_legacy_visual_evidence_eligibility")
      .select("change_event_id,visual_review_candidate_id,candidate_signature,eligibility_seal_sha256")
      .in("change_event_id", chunk);
    if (error) throw new Error(`Legacy eligibility lookup failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function loadCandidatesBy(column, values) {
  if (!values.length) return [];
  const rows = [];
  for (const chunk of chunks(values, 100)) {
    const { data, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .select(candidateSelect)
      .in(column, chunk);
    if (error) throw new Error(`Candidate ${column} lookup failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function backfillEvidence(eventId, evidence, legacyFallback) {
  const legacyRecoverableStatuses = new Set([
    "full_screenshot_fallback",
    "unavailable_exact_text_missing",
    "unavailable_geometry_missing",
    "unavailable_image_missing",
    "unavailable_ambiguous",
  ]);
  const rpc = legacyFallback && legacyRecoverableStatuses.has(evidence?.evidence_status)
    ? "backfill_legacy_shared_award_visual_event_evidence"
    : "backfill_shared_award_visual_event_evidence";
  const { data, error } = await supabase.rpc(rpc, {
    p_event_id: eventId,
    p_evidence: backfillEvidenceRpcPayload(evidence),
  });
  if (error) throw new Error(`Historical event evidence RPC failed for ${eventId}: ${error.message}`);
  const result = Array.isArray(data) ? data[0] || null : data || null;
  if (!result?.evidence_id || result.change_event_id !== eventId) {
    throw new Error(`Historical event evidence RPC returned no durable binding for ${eventId}.`);
  }
  return result;
}

function sourceFromEvent(event) {
  return {
    id: event.shared_award_source_id,
    shared_award_id: event.shared_award_id,
    url: event.source_url,
    title: event.source_title,
    page_type: event.source_page_type,
  };
}

function historicalArtifactFailure(error) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("hash mismatch") || message.includes("sha")) {
    return {
      reason_code: "historical_artifact_hash_mismatch",
      reason: "A retained historical artifact failed its stored hash identity check.",
    };
  }
  if (message.includes("ambiguous")) {
    return {
      reason_code: "historical_artifact_ambiguous",
      reason: "The retained historical artifact binding is ambiguous and cannot be published safely.",
    };
  }
  return {
    reason_code: "historical_artifact_unavailable",
    reason: "The retained historical artifacts cannot be verified without reconstructing evidence.",
  };
}

function operationalBackfillFailure(error) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("historical event evidence rpc")) {
    return {
      reason_code: "backfill_rpc_dependency_failure",
      reason: "The idempotent historical evidence RPC did not durably complete the active event.",
    };
  }
  if (
    message.includes("load change-event page failed") ||
    message.includes("load existing event evidence failed") ||
    message.includes("candidate id lookup failed") ||
    message.includes("candidate candidate_signature lookup failed") ||
    message.includes("reverse candidate lookup failed") ||
    message.includes("legacy eligibility lookup failed")
  ) {
    return {
      reason_code: "backfill_database_dependency_failure",
      reason: "A required database read failed before the active event could be durably completed.",
    };
  }
  if (
    /\b(r2|s3|headobject|putobject|accessdenied|credentials?)\b/.test(message) ||
    /\b(econnreset|econnrefused|enotfound|etimedout)\b/.test(message) ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("permanent visual evidence verification failed")
  ) {
    return {
      reason_code: "backfill_r2_dependency_failure",
      reason: "The immutable artifact store could not durably verify the active event's retained evidence.",
    };
  }
  return null;
}

function recordRepair(reasonCode) {
  const code = cleanText(reasonCode) || "unknown";
  const guidance = historicalBackfillRepairPlan(code);
  const existing = report.repair_plan[code];
  report.repair_plan[code] = {
    category: guidance.category,
    solution: guidance.solution,
    count: Number(existing?.count || 0) + 1,
  };
  return guidance;
}

function groupBy(values, picker) {
  const result = new Map();
  for (const value of values) {
    const key = picker(value);
    if (!key) continue;
    const rows = result.get(key) || [];
    rows.push(value);
    result.set(key, rows);
  }
  return result;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function promisePool(items, concurrency, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function increment(record, key) {
  const cleanKey = cleanText(key) || "unknown";
  record[cleanKey] = (record[cleanKey] || 0) + 1;
}

function unique(values) {
  return [...new Set(values)];
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const argument = value.slice(2);
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) parsed[argument.slice(0, equalsIndex)] = argument.slice(equalsIndex + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[argument] = values[index + 1];
      index += 1;
    } else parsed[argument] = "true";
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadTerminalLossConfirmations(path) {
  if (!path) return new Map();
  if (!existsSync(path)) throw new Error(`Terminal-loss confirmations file does not exist: ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Terminal-loss confirmations file is not valid JSON: ${errorMessage(error)}`);
  }
  return parseHistoricalTerminalLossConfirmations(parsed);
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundedInt(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function timestampForPath(value) {
  return String(value).replace(/[:.]/g, "-");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
