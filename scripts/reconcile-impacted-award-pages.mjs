#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditPublicAwardPage,
  buildAtomicCandidateChanges,
  buildAwardSummaryFromFacts,
  buildCandidateDispositionEntries,
  enqueueAwardReconciliation,
  planMissingFactCandidateMaterialization,
  preserveLastKnownGoodAmountFacts,
  reconcileAwardFacts,
  resolveStage1ReconciliationTarget,
} from "./lib/award-fact-reconciliation.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";
import {
  loadStablePaginatedRows,
} from "./lib/reconciliation-candidate-snapshot.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const limit = positiveInt(args.limit, 250);
const awardIdFilter = cleanNullable(args["award-id"]);
const slugFilter = cleanNullable(args.slug);
const onlyPending = boolArg(args["only-pending"], !awardIdFilter && !slugFilter);
const onlyFailed = boolArg(args["only-failed"], false);
const dryRun = boolArg(args["dry-run"], !boolArg(args.apply, false));
const apply = boolArg(args.apply, !dryRun);
const includeWarnings = boolArg(args["include-warnings"], true);
const processingTimeoutMinutes = positiveInt(args["processing-timeout-minutes"], 45);
const factCandidatePageSize = Math.min(
  1_000,
  positiveInt(args["fact-candidate-page-size"], 500),
);
const maxFactCandidates = Math.min(
  1_000_000,
  positiveInt(args["max-fact-candidates"], 100_000),
);
const json = boolArg(args.json, false);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `award-page-reconciliation-${timestampForPath(new Date().toISOString())}.json`);

const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  options: {
    limit,
    award_id: awardIdFilter,
    slug: slugFilter,
    only_pending: onlyPending,
    only_failed: onlyFailed,
    dry_run: dryRun,
    apply,
    include_warnings: includeWarnings,
    processing_timeout_minutes: processingTimeoutMinutes,
    fact_candidate_page_size: factCandidatePageSize,
    max_fact_candidates: maxFactCandidates,
  },
  queue_rows_loaded: 0,
  awards_checked: 0,
  awards_reconciled: 0,
  awards_audit_passed: 0,
  awards_audit_warnings: 0,
  awards_audit_failed: 0,
  awards_publication_blocked: 0,
  awards_used_last_known_good: 0,
  awards_amounts_preserved_for_review: 0,
  sibling_sources_rejected: 0,
  deadline_conflicts_detected: 0,
  stale_cycle_states_corrected: 0,
  facts_published: 0,
  facts_dry_run: 0,
  candidate_rows_loaded: 0,
  candidate_snapshot_verifications: 0,
  candidate_snapshot_pages_read: 0,
  candidate_snapshot_rows_observed: 0,
  candidate_snapshots: [],
  generated_candidates: 0,
  superseded_candidates: 0,
  candidate_source_owner_mismatches: 0,
  selected_candidates: 0,
  rejected_candidates: 0,
  source_rejections: 0,
  stale_processing_rows_requeued: 0,
  stage1_alias_queue_rows_canonicalized: 0,
  stage1_reviewed_queue_rows_deferred: 0,
  stage1_automatic_reconciliations_quarantined: 0,
  queue_claims_lost: 0,
  transient_conflicts_requeued: 0,
  errors: [],
  awards: [],
};

mkdirSync(reportDir, { recursive: true });
writeReport();

try {
  const queueRows = await targetQueueRows();
  report.queue_rows_loaded = queueRows.length;
  for (const queueRow of queueRows.slice(0, limit)) {
    await processQueueRow(queueRow);
    writeReport();
  }
  report.status = report.errors.length ? "completed_with_errors" : "succeeded";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  throw error;
} finally {
  try {
    report.finished_at = new Date().toISOString();
    writeReport();
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`AWARD_RECONCILIATION_REPORT ${reportPath}`);
  } finally {
    await closeSupabaseServiceTransport();
  }
}

async function targetQueueRows() {
  if (awardIdFilter || slugFilter) {
    const award = awardIdFilter ? await loadAwardById(awardIdFilter) : await loadAwardBySlug(slugFilter);
    if (!award) return [];
    if (apply) {
      const queued = await enqueueAwardReconciliation(supabase, {
        awardId: award.id,
        reason: awardIdFilter ? "manual_award_id" : "manual_slug",
        priority: 1,
        metadata: {
          requested_by: "reconcile-impacted-award-pages",
          manual_target: awardIdFilter ? "award_id" : "slug",
        },
      });
      if (!queued.id) {
        throw new Error("Manual reconciliation could not acquire a durable queue identity.");
      }
      const { data, error } = await supabase
        .from("shared_award_reconciliation_queue")
        .select("*")
        .eq("id", queued.id)
        .maybeSingle();
      if (error) throw new Error(`Load manual reconciliation queue row failed: ${error.message}`);
      return data ? [data] : [];
    }
    return [{
      id: null,
      shared_award_id: award.id,
      reason: awardIdFilter ? "manual_award_id" : "manual_slug",
      status: "pending",
      metadata: {},
    }];
  }

  if (apply && onlyPending) await recoverStaleProcessingQueueRows();

  let query = supabase
    .from("shared_award_reconciliation_queue")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (onlyFailed) query = query.eq("status", "failed");
  else if (onlyPending) query = query.eq("status", "pending");
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      report.errors.push({ message: "shared_award_reconciliation_queue is not configured yet." });
      return [];
    }
    throw new Error(`Load reconciliation queue failed: ${error.message}`);
  }
  return data || [];
}

async function recoverStaleProcessingQueueRows() {
  const cutoff = new Date(Date.now() - processingTimeoutMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .update({
      status: "pending",
      started_at: null,
      completed_at: null,
      error: "requeued_after_stale_processing_timeout",
    })
    .eq("status", "processing")
    .lt("started_at", cutoff)
    .select("id");
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(`Recover stale reconciliation rows failed: ${error.message}`);
  }
  report.stale_processing_rows_requeued = (data || []).length;
}

async function processQueueRow(queueRow) {
  // The explicit-review command owns its exact pending queue. The automatic
  // worker must neither claim it nor broaden its source/candidate identities.
  if (isExplicitReviewedStage1Queue(queueRow)) {
    report.stage1_reviewed_queue_rows_deferred += 1;
    return;
  }
  const startedAt = new Date().toISOString();
  if (apply && queueRow.id) {
    const claimed = await claimQueueRow(queueRow, startedAt);
    if (!claimed) {
      report.queue_claims_lost += 1;
      return;
    }
    queueRow = { ...queueRow, ...claimed };
  }

  try {
    const stage1Scope = await resolveStage1ReconciliationTarget(
      supabase,
      queueRow.shared_award_id,
    );
    if (stage1Scope.canonicalized && queueRow.id) {
      report.stage1_alias_queue_rows_canonicalized += 1;
      if (apply) {
        const canonicalQueue = await enqueueAwardReconciliation(supabase, {
          awardId: queueRow.shared_award_id,
          reason: `stage1_canonicalized:${queueRow.reason || "member_reconciliation"}`,
          sourceIds: queueRow.source_ids || [],
          candidateIds: queueRow.candidate_ids || [],
          priority: queueRow.priority || 100,
          metadata: {
            ...(queueRow.metadata && typeof queueRow.metadata === "object"
              ? queueRow.metadata
              : {}),
            canonicalized_from_queue_id: queueRow.id,
            canonicalized_from_member_award_id: queueRow.shared_award_id,
            stage1_explicit_review_required: true,
            automatic_reconciliation_blocked: true,
          },
        });
        await finishOwnedQueue(
          queueRow,
          startedAt,
          "skipped",
          `canonicalized_to:${stage1Scope.canonicalAwardId}:${canonicalQueue.id || "pending"}`,
        );
      }
      return;
    }

    // Stage 1 publication is rooted in one versioned human review artifact.
    // New automatic work remains durable and invalidates readiness, but it may
    // not rank/materialize candidates or overwrite the last reviewed choice.
    if (stage1Scope.cohortKey) {
      report.stage1_automatic_reconciliations_quarantined += 1;
      if (apply && queueRow.id) {
        // 'skipped', not 'failed': declining to auto-reconcile a human-reviewed
        // cohort is a deliberate outcome, not a failure. The quarantine sync
        // keys terminal public-page quarantines on status = 'failed', so a
        // failed outcome opened (and every 15 minutes re-opened) an actionable
        // quarantine per Stage 1 award each night. The error text still carries
        // the re-verification signal; the RPC treats both statuses alike.
        await finishOwnedQueue(
          queueRow,
          startedAt,
          "skipped",
          `stage1_explicit_review_required:${stage1Scope.cohortKey}`,
        );
      }
      return;
    }

    const award = await loadAwardById(stage1Scope.canonicalAwardId);
    if (!award) {
      if (apply && queueRow.id) {
        await finishOwnedQueue(
          queueRow,
          startedAt,
          "skipped",
          "award_not_found",
        );
      }
      return;
    }

    report.awards_checked += 1;
    const reconciliationAwardIds = stage1Scope.memberAwardIds.length
      ? stage1Scope.memberAwardIds
      : [award.id];
    const sources = await loadAwardSources(reconciliationAwardIds);
    const loadedCandidates = await loadAwardFactCandidates(reconciliationAwardIds);
    const {
      usableLoadedCandidates,
      generatedCandidates,
      sourceOwnerMismatches,
    } = planMissingFactCandidateMaterialization(award, sources, loadedCandidates);
    report.candidate_source_owner_mismatches += sourceOwnerMismatches.length;
    report.generated_candidates += generatedCandidates.length;
    const preparedGeneratedCandidates = prepareGeneratedFactCandidateRows(
      generatedCandidates,
    );
    const materializedCandidates = preparedGeneratedCandidates.map(
      (prepared) => prepared.candidate,
    );
    const candidates = [...usableLoadedCandidates, ...materializedCandidates];
    const reconciliation = reconcileAwardFacts(award, sources, candidates, { now: new Date() });
    const audit = auditPublicAwardPage(award, reconciliation.selectedFacts, sources, { reconciliation, now: new Date() });
    const publishableFacts = preserveLastKnownGoodAmountFacts(reconciliation.selectedFacts, award.public_facts);
    const preservedAmountFields = (publishableFacts.reconciliation.preserved_fields || [])
      .filter((field) => ["award_amounts", "stipend", "travel_research_allowance"].includes(field));
    const amountPreservedForReview = preservedAmountFields.length > 0;
    const shouldPublish = !amountPreservedForReview &&
      !audit.should_block_publication &&
      (audit.audit_status === "passed" || includeWarnings);
    const conflictFields = new Set(reconciliation.conflicts.map((conflict) => conflict.field_name));
    const candidateDispositions = buildCandidateDispositionEntries(
      reconciliation,
      conflictFields,
    );
    const supersededCandidateCount = candidateDispositions.filter(
      (disposition) => disposition.candidate_status === "superseded",
    ).length;

    report.selected_candidates += Object.keys(reconciliation.selected).length;
    report.rejected_candidates += reconciliation.rejected.length;
    report.superseded_candidates += supersededCandidateCount;
    report.source_rejections += reconciliation.sourceRejections.length;
    report.sibling_sources_rejected += reconciliation.rejected.filter((item) => item.reason.includes("sibling")).length;
    report.deadline_conflicts_detected += reconciliation.conflicts.filter((conflict) => conflict.field_name === "deadline").length;
    report.stale_cycle_states_corrected += reconciliation.selectedFacts.cycle_status === "deadline_passed" ? 1 : 0;
    if (amountPreservedForReview) {
      report.awards_amounts_preserved_for_review += 1;
    }
    if (audit.audit_status === "passed") report.awards_audit_passed += 1;
    else if (audit.audit_status === "warnings") report.awards_audit_warnings += 1;
    else report.awards_audit_failed += 1;

    const awardSummary = {
      award_id: award.id,
      award_name: award.name,
      queue_reason: queueRow.reason,
      stage1_cohort_key: stage1Scope.cohortKey,
      reconciled_member_award_ids: reconciliationAwardIds,
      source_count: sources.length,
      candidate_count: candidates.length,
      selected_count: Object.keys(reconciliation.selected).length,
      rejected_count: reconciliation.rejected.length,
      superseded_count: supersededCandidateCount,
      conflicts: reconciliation.conflicts.map((conflict) => ({ field_name: conflict.field_name, severity: conflict.severity, reason: conflict.reason })),
      audit_status: audit.audit_status,
      severity: audit.severity,
      findings: audit.findings,
      amount_preserved_for_review: amountPreservedForReview,
      preserved_amount_fields: preservedAmountFields,
      published: false,
      blocked: audit.should_block_publication || amountPreservedForReview,
    };
    report.awards.push(awardSummary);

    if (shouldPublish) {
      report.awards_reconciled += 1;
      if (apply) {
        const selectedCandidateIds = uniqueIds(
          Object.values(reconciliation.selected).map(
            (selection) => selection.candidate.id,
          ),
        );
        const acceptedSourceIds = uniqueIds(
          Object.values(reconciliation.selected).map(
            (selection) => selection.candidate.shared_award_source_id,
          ),
        );
        if (!queueRow.id) {
          throw new Error("Applied reconciliation requires a durable queue identity.");
        }
        const evidenceRows = buildReconciledFactEvidenceRows({
          award,
          queueRow,
          reconciliation,
          publishableFacts,
        });
        const candidateChanges = buildAtomicCandidateChanges({
          preparedGeneratedCandidates,
          reconciliation,
          conflictFields,
        });
        const auditRow = buildAuditRow(award, audit, publishableFacts);
        const committed = await commitQueuedAwardReconciliation({
          award,
          queueRow,
          startedAt,
          publishableFacts,
          evidenceRows,
          acceptedSourceIds,
          selectedCandidateIds,
          generatedCandidateRows: candidateChanges.generatedCandidateRows,
          candidateStatusUpdates: candidateChanges.candidateStatusUpdates,
          auditRow,
        });
        if (!committed) {
          report.queue_claims_lost += 1;
          awardSummary.requeued_after_new_trigger = true;
          return;
        }
        awardSummary.published = true;
        report.facts_published += 1;
      } else {
        report.facts_dry_run += 1;
      }
    } else {
      report.awards_publication_blocked += 1;
      report.awards_used_last_known_good += 1;
      if (apply && queueRow.id) {
        const candidateChanges = buildAtomicCandidateChanges({
          preparedGeneratedCandidates,
          reconciliation,
          conflictFields,
        });
        const failureReason = amountPreservedForReview
          ? `preserved_amount_requires_exact_evidence:${preservedAmountFields.join(",")}`
          : `audit_${audit.audit_status}_${audit.severity}`;
        const blockedAudit = auditForBlockedDisposition(audit, failureReason);
        awardSummary.audit_status = blockedAudit.audit_status;
        awardSummary.severity = blockedAudit.severity;
        awardSummary.findings = blockedAudit.findings;
        const blockedStatus = await commitBlockedAwardReconciliation({
          award,
          queueRow,
          startedAt,
          generatedCandidateRows: candidateChanges.generatedCandidateRows,
          candidateStatusUpdates: candidateChanges.candidateStatusUpdates,
          auditRow: buildAuditRow(award, blockedAudit, publishableFacts),
          failureReason,
        });
        if (blockedStatus !== "failed") {
          report.queue_claims_lost += 1;
          awardSummary.requeued_after_new_trigger = true;
        }
      }
    }
  } catch (error) {
    report.errors.push({ award_id: queueRow.shared_award_id, message: errorMessage(error) });
    if (apply && queueRow.id) {
      const retryableConflict = isRetryableReconciliationConflict(error);
      const finished = await finishOwnedQueue(
        queueRow,
        startedAt,
        retryableConflict ? "pending" : "failed",
        retryableConflict
          ? `requeued_after_transient_reconciliation_conflict:${errorMessage(error)}`
          : errorMessage(error),
      );
      if (retryableConflict && finished?.status === "pending") {
        report.transient_conflicts_requeued += 1;
      }
    }
  }
}

async function loadAwardById(id) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,public_facts,status,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load award failed: ${error.message}`);
  return data;
}

async function loadAwardBySlug(slug) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,public_facts,status,updated_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Load award by slug failed: ${error.message}`);
  return data;
}

async function loadAwardSources(awardIds) {
  const ids = Array.isArray(awardIds) ? awardIds : [awardIds];
  const { data, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_award_id,url,title,display_title,page_description,page_type,source,reason,submitted_by_user_id,admin_review_status,page_metadata,page_metadata_generated_at,page_metadata_model,confidence")
    .in("shared_award_id", ids)
    .eq("admin_review_status", "open")
    .order("page_type", { ascending: true });
  if (error) throw new Error(`Load award sources failed: ${error.message}`);
  return data || [];
}

async function loadAwardFactCandidates(awardIds) {
  const ids = Array.isArray(awardIds) ? awardIds : [awardIds];
  const statuses = [
    "pending",
    "selected",
    "conflicted",
    "rejected",
    "superseded",
  ];
  const snapshot = await loadStablePaginatedRows({
    pageSize: factCandidatePageSize,
    maxRows: maxFactCandidates,
    countRows: async () => {
      const { count, error } = await supabase
        .from("shared_award_fact_candidates")
        .select("id", { count: "exact", head: true })
        .in("shared_award_id", ids)
        .in("candidate_status", statuses);
      if (error) {
        if (isMissingTableError(error)) return 0;
        throw new Error(`Count fact candidates failed: ${error.message}`);
      }
      return count;
    },
    loadPage: async ({ offset, limit: pageLimit }) => {
      const { data, error } = await supabase
        .from("shared_award_fact_candidates")
        .select("*")
        .in("shared_award_id", ids)
        .in("candidate_status", statuses)
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(offset, offset + pageLimit - 1);
      if (error) {
        if (isMissingTableError(error)) return [];
        throw new Error(`Load fact candidates failed: ${error.message}`);
      }
      return data || [];
    },
  });
  report.candidate_rows_loaded += snapshot.exactCount;
  report.candidate_snapshot_verifications += 1;
  report.candidate_snapshot_pages_read += snapshot.pagesRead;
  report.candidate_snapshot_rows_observed += snapshot.rowsObserved;
  report.candidate_snapshots.push({
    shared_award_ids: ids,
    exact_count: snapshot.exactCount,
    revision_sha256: snapshot.revisionSha256,
    pages_read: snapshot.pagesRead,
  });
  return snapshot.rows.map((row) => ({
    ...row,
    raw_value: rawValueFromCandidateRow(row),
  }));
}

function prepareGeneratedFactCandidateRows(candidates) {
  return candidates.map((candidate) => {
    const normalizedValue = candidate.normalized_value ?? candidate.raw_value ?? null;
    const intakeValueSha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(stableAuditSignatureValue({
        source_id: candidate.shared_award_source_id || null,
        field_name: candidate.field_name,
        normalized_value: normalizedValue,
        evidence_quote: candidate.evidence_quote || null,
        evidence_location: candidate.evidence_location || null,
      })))
      .digest("hex");
    const row = {
      id: crypto.randomUUID(),
      shared_award_id: candidate.shared_award_id,
      shared_award_source_id: candidate.shared_award_source_id || null,
      source_url: candidate.source_url || null,
      source_title: candidate.source_title || null,
      source_role: candidate.source_role || null,
      source_quality_decision:
        candidate.metadata?.source_quality_decision || {},
      field_name: candidate.field_name,
      raw_value: typeof candidate.raw_value === "string"
        ? candidate.raw_value
        : JSON.stringify(candidate.raw_value),
      normalized_value: normalizedValue,
      evidence_quote: candidate.evidence_quote || null,
      evidence_location: candidate.evidence_location || null,
      extracted_at: candidate.extracted_at || null,
      model: candidate.model || "award-fact-reconciliation-materializer",
      confidence: candidate.confidence || null,
      candidate_status: "pending",
      source_page_request_id: null,
      // This is a reconciliation materialization, not a retained paid-intake
      // request. The durable digest lives in metadata; the source-intake
      // identity columns must remain paired null by database constraint.
      intake_value_sha256: null,
      metadata: {
        ...(candidate.metadata || {}),
        generated_evidence_sha256: intakeValueSha256,
        materialized_by: "reconcile-impacted-award-pages",
        materialization_version: 1,
      },
    };
    return {
      row,
      candidate: {
        ...candidate,
        ...row,
        raw_value: candidate.raw_value,
        created_at: null,
        updated_at: null,
      },
    };
  });
}

function buildReconciledFactEvidenceRows({
  award,
  queueRow,
  reconciliation,
  publishableFacts,
}) {
  const allowedFields = [
    "overview",
    "deadline",
    "opening_date",
    "award_amounts",
    "eligibility",
    "requirements",
    "application_materials",
    "how_to_apply",
    "important_dates",
    "documents",
    "contacts",
    "academic_levels",
    "disciplines",
    "citizenship",
    "confidence",
  ];
  const allSelections = Object.values(reconciliation.selected);
  const rows = [];
  for (const fieldName of allowedFields) {
    const publicValue = publishableFacts[fieldName];
    if (!hasPublicFactValue(publicValue)) continue;
    const contributors = fieldName === "confidence"
      ? allSelections
      : reconciliation.selected[fieldName]
        ? [reconciliation.selected[fieldName]]
        : [];
    const candidateIds = uniqueIds(
      contributors.map((selection) => selection.candidate.id),
    );
    const sourceIds = uniqueIds(
      contributors.map((selection) => selection.candidate.shared_award_source_id),
    );
    if (!candidateIds.length || !sourceIds.length) continue;
    const candidateBindings = Object.fromEntries(
      contributors
        .filter((selection) => selection.candidate.id)
        .map((selection) => [selection.candidate.id, {
          source_id: selection.candidate.shared_award_source_id || null,
          source_role: selection.candidate.source_role || null,
          field_name:
            selection.candidate.metadata?.stored_field_name ||
            selection.candidate.field_name,
          canonical_field_name: selection.candidate.field_name,
          contributes_to_field: fieldName,
          contribution_kind:
            fieldName === "confidence"
              ? "aggregate_confidence"
              : "direct_selected_value",
          normalized_value: selection.candidate.normalized_value ?? null,
          selected_value: publicValue,
          evidence_quote: selection.candidate.evidence_quote || null,
          evidence_location: selection.candidate.evidence_location || null,
          intake_value_sha256: selection.candidate.intake_value_sha256 || null,
          extracted_at: selection.candidate.extracted_at || null,
          model: selection.candidate.model || null,
        }]),
    );
    const evidence = stableAuditSignatureValue({
      schema_version: 1,
      award_id: award.id,
      reconciliation_id: queueRow.id,
      field_name: fieldName,
      public_value: publicValue,
      candidate_ids: candidateIds,
      source_ids: sourceIds,
      candidate_bindings: candidateBindings,
      materialized_by: "reconcile-impacted-award-pages",
    });
    rows.push({
      field_name: fieldName,
      public_value: publicValue,
      candidate_ids: candidateIds,
      source_ids: sourceIds,
      evidence,
    });
  }
  return rows;
}

function uniqueIds(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function hasPublicFactValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function rawValueFromCandidateRow(row) {
  if (row.normalized_value !== null && row.normalized_value !== undefined) return row.normalized_value;
  return row.raw_value;
}

function auditForBlockedDisposition(audit, failureReason) {
  if (audit.audit_status !== "passed") return audit;
  return {
    ...audit,
    audit_status: "needs_review",
    severity: audit.severity === "info" ? "warning" : audit.severity,
    findings: [
      ...(Array.isArray(audit.findings) ? audit.findings : []),
      {
        code: "reconciliation_blocked_after_passing_field_audit",
        severity: "warning",
        message: "The deterministic field audit passed, but the reconciliation disposition still requires review.",
        reason: failureReason,
      },
    ],
    suggested_fixes: [
      ...(Array.isArray(audit.suggested_fixes) ? audit.suggested_fixes : []),
      {
        reason: "resolve_blocking_reconciliation_disposition",
        value: failureReason,
      },
    ],
    should_block_publication: true,
  };
}

function buildAuditRow(award, audit, publicPageSnapshot) {
  const reconciliationAuditSignature = crypto
    .createHash("sha256")
    .update(JSON.stringify(stableAuditSignatureValue({
      award_id: award.id,
      audit_status: audit.audit_status,
      severity: audit.severity,
      findings: audit.findings,
      suggested_fixes: audit.suggested_fixes,
      field_conflicts: audit.field_conflicts,
      source_rejections: audit.source_rejections,
      selected_fact_summary: audit.selected_fact_summary,
      public_page_snapshot: publicPageSnapshot,
    })))
    .digest("hex");
  const storedSnapshot = {
    ...(publicPageSnapshot && typeof publicPageSnapshot === "object" ? publicPageSnapshot : {}),
    reconciliation_audit_signature: reconciliationAuditSignature,
  };
  return {
    shared_award_id: award.id,
    audit_kind: "deterministic",
    audit_status: audit.audit_status,
    severity: audit.severity,
    findings: audit.findings,
    suggested_fixes: audit.suggested_fixes,
    field_conflicts: audit.field_conflicts,
    source_rejections: audit.source_rejections,
    selected_fact_summary: audit.selected_fact_summary,
    public_page_snapshot: storedSnapshot,
    model: "award-fact-reconciliation",
  };
}

async function commitQueuedAwardReconciliation({
  award,
  queueRow,
  startedAt,
  publishableFacts,
  evidenceRows,
  acceptedSourceIds,
  selectedCandidateIds,
  generatedCandidateRows,
  candidateStatusUpdates,
  auditRow,
}) {
  const { data, error } = await supabase.rpc(
    "commit_award_reconciliation_publication",
    {
      p_reconciliation_id: queueRow.id,
      p_shared_award_id: award.id,
      p_expected_started_at: startedAt,
      p_expected_queue_generation: queueRow.generation,
      p_expected_award_updated_at: award.updated_at,
      p_expected_public_facts: award.public_facts,
      p_summary: buildAwardSummaryFromFacts(award, publishableFacts),
      p_public_facts: publishableFacts,
      p_confidence: confidenceScore(publishableFacts.confidence),
      p_evidence_rows: evidenceRows,
      p_source_ids: acceptedSourceIds,
      p_candidate_ids: selectedCandidateIds,
      p_generated_candidates: generatedCandidateRows,
      p_candidate_status_updates: candidateStatusUpdates,
      p_audit_row: auditRow,
    },
  );
  if (error) {
    throw reconciliationRpcError(
      "Atomic reconciliation publication failed",
      error,
    );
  }
  return data?.status === "succeeded";
}

async function commitBlockedAwardReconciliation({
  award,
  queueRow,
  startedAt,
  generatedCandidateRows,
  candidateStatusUpdates,
  auditRow,
  failureReason,
}) {
  const { data, error } = await supabase.rpc(
    "commit_award_reconciliation_blocked",
    {
      p_reconciliation_id: queueRow.id,
      p_shared_award_id: award.id,
      p_expected_started_at: startedAt,
      p_expected_queue_generation: queueRow.generation,
      p_expected_award_updated_at: award.updated_at,
      p_expected_public_facts: award.public_facts,
      p_generated_candidates: generatedCandidateRows,
      p_candidate_status_updates: candidateStatusUpdates,
      p_audit_row: auditRow,
      p_failure_reason: failureReason,
    },
  );
  if (error) {
    throw reconciliationRpcError("Atomic blocked reconciliation failed", error);
  }
  return data?.status || null;
}

async function claimQueueRow(queueRow, startedAt) {
  if (!queueRow?.id || !["pending", "failed"].includes(queueRow.status)) {
    return false;
  }
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .update({
      status: "processing",
      started_at: startedAt,
      completed_at: null,
      error: null,
    })
    .eq("id", queueRow.id)
    .eq("status", queueRow.status)
    .select("*");
  if (error) throw new Error(`Claim reconciliation queue row failed: ${error.message}`);
  return (data || []).length === 1 ? data[0] : null;
}

async function finishOwnedQueue(queueRow, startedAt, terminalStatus, errorText) {
  const { data, error } = await supabase.rpc(
    "finish_or_requeue_award_reconciliation_claim",
    {
      p_reconciliation_id: queueRow.id,
      p_shared_award_id: queueRow.shared_award_id,
      p_expected_started_at: startedAt,
      p_expected_queue_generation: queueRow.generation,
      p_terminal_status: terminalStatus,
      p_error: errorText,
    },
  );
  if (error) throw new Error(`Finish reconciliation queue claim failed: ${error.message}`);
  if (
    !data ||
    (data.status === "pending" && terminalStatus !== "pending")
  ) {
    report.queue_claims_lost += 1;
  }
  return data || null;
}

function isExplicitReviewedStage1Queue(queueRow) {
  const metadata = queueRow?.metadata;
  return Boolean(
    metadata
    && typeof metadata === "object"
    && metadata.processor === "reconcile-reviewed-stage1-selection"
    && metadata.selection_mode === "explicit_human_review"
  );
}

function confidenceScore(value) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  return 0.5;
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[withoutPrefix] = next;
        index += 1;
      } else parsed[withoutPrefix] = "true";
    }
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isMissingTableError(error) {
  return /does not exist|schema cache|relation .* not found/i.test(error?.message || "");
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function reconciliationRpcError(prefix, error) {
  const wrapped = new Error(`${prefix}: ${error?.message || "unknown Supabase error"}`);
  if (error?.code) wrapped.code = String(error.code);
  return wrapped;
}

function isRetryableReconciliationConflict(error) {
  return ["40001", "40P01"].includes(String(error?.code || ""));
}

function stableAuditSignatureValue(value) {
  if (Array.isArray(value)) return value.map(stableAuditSignatureValue);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set([
    "captured_at",
    "checked_at",
    "created_at",
    "generated_at",
    "reconciliation_audit_signature",
    "updated_at",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableAuditSignatureValue(nested)]),
  );
}

function printHelp() {
  console.log(`Reconcile impacted AwardPing public award pages.

Options:
  --limit=250
  --award-id=<uuid>
  --slug=<award-slug>
  --only-pending=true
  --only-failed=false
  --dry-run=true
  --apply=false
  --include-warnings=true
  --processing-timeout-minutes=45
  --fact-candidate-page-size=500
  --max-fact-candidates=100000
  --json=false
`);
}
