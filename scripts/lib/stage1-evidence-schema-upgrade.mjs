import { createHash } from "node:crypto";
import {
  evaluateStage1FirstVisualBaselineActivation,
} from "./stage1-baseline-activation-guard.mjs";
import {
  STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
  stage1BaselinePlannedSourceId,
} from "./stage1-baseline-source-disposition.mjs";
import {
  assertStage1EvidenceSchemaUpgradeMutationAccounting,
  sealStage1EvidenceSchemaUpgradeMutationAccounting,
} from "./stage1-evidence-schema-upgrade-mutation-accounting.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA =
  "awardping.stage1.reviewed-source-capture-allowlist.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-source-result.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-report.v1";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT =
  "stage1_evidence_schema_upgrade";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID =
  "c5961d93-9f1f-504e-8dd4-c4ec06a833a2";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_REQUEST_ID =
  "b7dd586b-ac5e-5da7-abe7-8478a353b865";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID =
  stage1BaselinePlannedSourceId(STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_REQUEST_ID);

const evidencePacketSha256 = STAGE1_BASELINE_EVIDENCE_PACKET_SHA256;
const appliedDispositionBundleSha256 =
  "a3825703fd736cea3ca38a3294a7d0378c94316b828820ee138336ecc6777acb";
const dispositionConfirmationSha256 =
  "b967506e8cb67f1f9315d9b9ece9a5a8bd658e34bb5452c769e801c8f7703866";

const reviewedSources = Object.freeze([
  Object.freeze({ item: 1, award: "Beinecke Scholarship", page: "About", source_id: "c30778fe-43d7-57be-842a-e046d84baaee" }),
  Object.freeze({ item: 2, award: "Beinecke Scholarship", page: "Scholar FAQs", source_id: "2ea41875-5c88-5794-81b3-afa8ddaf31c1" }),
  Object.freeze({ item: 3, award: "Beinecke Scholarship", page: "Submission Materials", source_id: "af1367b5-0cb0-5b21-8e78-7dc195dd996f" }),
  Object.freeze({ item: 5, award: "Fulbright U.S. Student Program", page: "Competition & Selection", source_id: "b9407ce4-71f8-5c97-8f98-8466d640d4de" }),
  Object.freeze({ item: 6, award: "Hertz Fellowship", page: "Fellowship Overview", source_id: "5ec9a453-fd62-53e5-b885-726b21ce7247" }),
  Object.freeze({ item: 8, award: "NDSEG", page: "Homepage", source_id: "fa4088a7-706e-4ad3-ae12-3653751dd5e1" }),
  Object.freeze({ item: 9, award: "Samvid Scholars", page: "Homepage", source_id: "664d38ba-c717-5d51-b7ce-9e3a27f41fec" }),
  Object.freeze({ item: 10, award: "Schwarzman Scholars", page: "2026 Application Instructions", source_id: "719ffd9e-f97c-5c6d-8a5a-71b617cadf49" }),
  Object.freeze({ item: 11, award: "Yenching Academy", page: "Frequently Asked Questions", source_id: "c28878c0-6a8b-5fa8-b99b-ec826b86d8f2" }),
]);

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS = Object.freeze(
  reviewedSources.map((source) => source.source_id),
);

export function stage1EvidenceSchemaUpgradeExpectedManifest() {
  return structuredClone(exactManifest);
}

const reviewedSourcesById = new Map(
  reviewedSources.map((source) => [source.source_id, source]),
);
const deniedSourceIds = new Set([
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID,
]);

const exactManifest = Object.freeze({
  schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_MANIFEST_SCHEMA,
  created_at: "2026-08-14T19:30:00.000Z",
  purpose:
    "Zero-paid-call canonical evidence recapture for the nine previously approved baseline-only sources that remain eligible after keeping Churchill and Luce quarantined.",
  evidence_packet_sha256: evidencePacketSha256,
  applied_disposition_bundle_sha256: appliedDispositionBundleSha256,
  disposition_confirmation_sha256: dispositionConfirmationSha256,
  source_count: 9,
  source_ids: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS,
  sources: reviewedSources,
  excluded: Object.freeze([
    Object.freeze({
      item: 4,
      award: "Churchill Scholarship",
      source_id: STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID,
      reason: "User-directed quarantine pending Churchill-only evidence review.",
    }),
    Object.freeze({
      item: 7,
      award: "Luce Scholars Program",
      source_id: null,
      reason: "User-directed quarantine because the reviewed page lacks current funding evidence.",
    }),
  ]),
  safety: Object.freeze({
    paid_api_calls: 0,
    baseline_refresh: false,
    public_fact_writes: 0,
    first_observation_notifications: 0,
    source_discovery: false,
    changed_content_must_not_be_absorbed: true,
  }),
});

/**
 * Validates the immutable operator-reviewed nine-source manifest. This is a
 * pure value check: it performs no filesystem, database, browser, or R2 work.
 */
export function validateStage1EvidenceSchemaUpgradeManifest(value) {
  const manifest = parseJsonObject(value, "Stage 1 evidence-schema-upgrade manifest");
  const ids = Array.isArray(manifest.source_ids) ? manifest.source_ids : [];
  assertExactStage1EvidenceSchemaUpgradeSourceIds(ids, "manifest source_ids");

  const sourceRows = Array.isArray(manifest.sources) ? manifest.sources : [];
  assertExactStage1EvidenceSchemaUpgradeSourceIds(
    sourceRows.map((source) => source?.source_id),
    "manifest sources",
  );

  for (const source of sourceRows) {
    const id = cleanText(source?.source_id).toLowerCase();
    if (canonicalJson(source) !== canonicalJson(reviewedSourcesById.get(id))) {
      throw new Error(`Stage 1 reviewed source ${id || "unknown"} differs from its exact manifest binding.`);
    }
  }

  if (canonicalJson(manifest) !== canonicalJson(exactManifest)) {
    throw new Error("Stage 1 evidence-schema-upgrade requires the exact reviewed-nine manifest.");
  }
  return structuredClone(manifest);
}

export function assertExactStage1EvidenceSchemaUpgradeSourceIds(
  values,
  label = "source IDs",
) {
  if (!Array.isArray(values)) {
    throw new Error(`Stage 1 evidence-schema-upgrade ${label} must be an array.`);
  }
  const ids = values.map((value) => cleanText(value).toLowerCase());
  if (ids.some((id) => !uuidPattern.test(id))) {
    throw new Error(`Stage 1 evidence-schema-upgrade ${label} must contain only UUIDs.`);
  }
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    throw new Error(`Stage 1 evidence-schema-upgrade ${label} contains duplicate ${duplicate}.`);
  }
  const denied = ids.find((id) => deniedSourceIds.has(id));
  if (denied === STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID) {
    throw new Error("Churchill must remain quarantined and cannot enter Stage 1 evidence-schema upgrade.");
  }
  if (denied === STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID) {
    throw new Error("The deterministic Luce funding source identity is quarantined and cannot enter Stage 1 evidence-schema upgrade.");
  }
  const actual = [...ids].sort();
  const expected = [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    const missing = expected.filter((id) => !actual.includes(id));
    const unexpected = actual.filter((id) => !expected.includes(id));
    throw new Error(
      `Stage 1 evidence-schema-upgrade ${label} must equal the reviewed-nine set` +
      ` (missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}).`,
    );
  }
  return [...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS];
}

export function assertStage1EvidenceSchemaUpgradeCliContract({
  args = {},
  effectiveArgs = args,
  manifest,
  sourceIds = [],
} = {}) {
  validateStage1EvidenceSchemaUpgradeManifest(manifest);
  assertExactStage1EvidenceSchemaUpgradeSourceIds(sourceIds, "CLI selector source IDs");
  assertRawStage1EvidenceSchemaUpgradeCliContract(args);
  if (!cleanText(args["source-ids-file"])) {
    throw new Error("Stage 1 evidence-schema upgrade requires --source-ids-file with the exact reviewed-nine manifest.");
  }
  if (cleanText(args["source-id"])) {
    throw new Error("Stage 1 evidence-schema upgrade forbids --source-id; the exact reviewed-nine set is indivisible.");
  }
  if (args.limit !== undefined && Number(args.limit) !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length) {
    throw new Error("Stage 1 evidence-schema upgrade --limit, when supplied, must equal exactly 9.");
  }
  if (
    args["source-url"] !== undefined
    || args.award !== undefined
    || boolValue(effectiveArgs.continuous, false)
    || cleanText(effectiveArgs["run-trigger"]).toLowerCase() === "scheduled"
    || numberValue(effectiveArgs["shard-count"], 1) !== 1
    || numberValue(effectiveArgs["shard-index"], 0) !== 0
  ) {
    throw new Error("Stage 1 evidence-schema upgrade forbids additional filters, scheduling, continuous mode, and sharding.");
  }
  const forbiddenBooleanOptions = [
    "ai-review-evidence-capture",
    "backfill-baseline-info",
    "baseline-refresh",
    "complete-missing-baselines",
    "discover-html-subpages",
    "discover-pdf-subpages",
    "discovery-mode",
    "force-r2-snapshot-refresh",
    "initial-official-document-materialization",
    "localization-repair",
    "reset-previous-snapshot",
    "r2-backfill-baselines",
  ].filter((key) => boolValue(effectiveArgs[key], false));
  if (forbiddenBooleanOptions.length) {
    throw new Error(
      `Stage 1 evidence-schema upgrade cannot be combined with: ${forbiddenBooleanOptions.join(", ")}.`,
    );
  }
  if (
    numberValue(effectiveArgs["gemini-api-max-calls"], 0) !== 0
    || boolValue(effectiveArgs["extract-baseline-info"], false)
  ) {
    throw new Error("Stage 1 evidence-schema upgrade requires zero paid API calls and disables baseline fact extraction.");
  }
  if (
    !boolValue(effectiveArgs.all, false)
    || cleanText(effectiveArgs["visual-review-mode"]).toLowerCase() !== "none"
    || !boolValue(effectiveArgs["r2-snapshot-sync"], false)
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade requires all=true, visual-review-mode=none, and r2-snapshot-sync=true.",
    );
  }
  if (
    boolValue(effectiveArgs.promote, false)
    || boolValue(effectiveArgs["keep-unchanged"], false)
    || boolValue(effectiveArgs["keep-rejected"], false)
    || boolValue(effectiveArgs["keep-rejected-evidence"], false)
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade forbids normal promotion and keep/absorption paths.",
    );
  }
  if (
    cleanText(effectiveArgs["capture-profile"]).toLowerCase() !== "baseline-rich"
    || cleanText(effectiveArgs["section-extraction-profile"]).toLowerCase() !== "baseline-rich"
    || numberValue(effectiveArgs["max-expansion-state-screenshots"], -1) !== 24
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade requires baseline-rich capture/section profiles and exactly 24 expansion screenshots.",
    );
  }
  if (
    numberValue(effectiveArgs["web-concurrency"], -1) !== 1
    || cleanText(effectiveArgs["source-quality-mode"]).toLowerCase() !== "deterministic"
    || boolValue(effectiveArgs["pdf-only"], false)
    || boolValue(effectiveArgs["web-only"], false)
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade requires sequential mixed-source capture with deterministic source quality.",
    );
  }
  return Object.freeze({
    exact_source_count: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length,
    source_ids: Object.freeze([...STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS]),
    dry_run: boolValue(effectiveArgs["stage1-evidence-schema-upgrade-dry-run"], true),
  });
}

function assertRawStage1EvidenceSchemaUpgradeCliContract(rawArgs) {
  if (!isPlainObject(rawArgs)) {
    throw new TypeError("Stage 1 evidence-schema-upgrade raw CLI arguments must be an object.");
  }
  const maskedUnsafeBooleanOptions = [
    "ai-review-evidence-capture",
    "backfill-baseline-info",
    "baseline-refresh",
    "complete-missing-baselines",
    "discover-html-subpages",
    "discover-pdf-subpages",
    "discovery-mode",
    "extract-baseline-info",
    "force-r2-snapshot-refresh",
    "initial-official-document-materialization",
    "keep-rejected",
    "keep-rejected-evidence",
    "keep-unchanged",
    "localization-repair",
    "pdf-only",
    "promote",
    "reset-previous-snapshot",
    "r2-backfill-baselines",
    "web-only",
  ];
  const rawBooleanOptions = new Set([
    "all",
    "continuous",
    "include-not-due",
    "r2-snapshot-sync",
    "stage1-evidence-schema-upgrade",
    "stage1-evidence-schema-upgrade-dry-run",
    ...maskedUnsafeBooleanOptions,
  ]);
  for (const key of rawBooleanOptions) {
    if (Object.hasOwn(rawArgs, key) && !exactBooleanCliLiteral(rawArgs[key])) {
      throw new Error(
        `Stage 1 evidence-schema upgrade raw --${key} must be the literal true or false.`,
      );
    }
  }
  if (!exactTrueCliLiteral(rawArgs.all)) {
    throw new Error(
      "Stage 1 evidence-schema upgrade requires the literal operator selector --all=true.",
    );
  }
  for (const key of ["r2-snapshot-sync", "stage1-evidence-schema-upgrade"]) {
    if (Object.hasOwn(rawArgs, key) && !exactTrueCliLiteral(rawArgs[key])) {
      throw new Error(`Stage 1 evidence-schema upgrade raw --${key} must equal literal true.`);
    }
  }
  if (
    Object.hasOwn(rawArgs, "include-not-due")
    && exactTrueCliLiteral(rawArgs["include-not-due"])
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade forbids --include-not-due as a substitute for --all=true.",
    );
  }

  const enabledMaskedUnsafeBooleanOptions = maskedUnsafeBooleanOptions.filter((key) => (
    Object.hasOwn(rawArgs, key) && exactTrueCliLiteral(rawArgs[key])
  ));
  if (enabledMaskedUnsafeBooleanOptions.length) {
    throw new Error(
      "Stage 1 evidence-schema upgrade rejects unsafe raw CLI options before normalization: "
        + enabledMaskedUnsafeBooleanOptions.join(", "),
    );
  }

  if (
    Object.hasOwn(rawArgs, "run-trigger")
    && cleanText(rawArgs["run-trigger"]).toLowerCase() !== "manual"
  ) {
    throw new Error("Stage 1 evidence-schema upgrade raw --run-trigger must be manual.");
  }
  for (const [key, expected] of [
    ["shard-count", 1],
    ["shard-index", 0],
    ["gemini-api-max-calls", 0],
    ["max-expansion-state-screenshots", 24],
    ["web-concurrency", 1],
  ]) {
    if (
      Object.hasOwn(rawArgs, key)
      && numberValue(rawArgs[key], Number.NaN) !== expected
    ) {
      throw new Error(
        "Stage 1 evidence-schema upgrade raw --"
          + key
          + " must equal exactly "
          + expected
          + ".",
      );
    }
  }
  for (const [key, expected] of [
    ["visual-review-mode", "none"],
    ["capture-profile", "baseline-rich"],
    ["section-extraction-profile", "baseline-rich"],
    ["source-quality-mode", "deterministic"],
  ]) {
    if (
      Object.hasOwn(rawArgs, key)
      && cleanText(rawArgs[key]).toLowerCase() !== expected
    ) {
      throw new Error(
        "Stage 1 evidence-schema upgrade raw --"
          + key
          + " must equal exactly "
          + expected
          + ".",
      );
    }
  }
}

/**
 * Checks only immutable reviewed-source eligibility. Capture/baseline semantic
 * comparison and evidence completeness belong to the injected upgrade worker
 * and must not be inferred from this result.
 */
export function evaluateStage1EvidenceSchemaUpgradeEligibility({
  source,
  manifest,
} = {}) {
  validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const sourceId = cleanText(source?.id).toLowerCase();
  const reasons = [];
  const manifestSource = reviewedSourcesById.get(sourceId) || null;

  if (sourceId === STAGE1_EVIDENCE_SCHEMA_UPGRADE_CHURCHILL_SOURCE_ID) {
    reasons.push("churchill_quarantine_required");
  } else if (sourceId === STAGE1_EVIDENCE_SCHEMA_UPGRADE_LUCE_SOURCE_ID) {
    reasons.push("luce_funding_quarantine_required");
  } else if (!manifestSource) {
    reasons.push("source_not_in_reviewed_nine");
  }

  if (!uuidPattern.test(sourceId)) reasons.push("source_id_invalid");
  if (cleanText(source?.shared_awards?.status).toLowerCase() !== "active") {
    reasons.push("award_not_active");
  }
  if (
    manifestSource
    && cleanText(source?.shared_awards?.name) !== manifestSource.award
  ) {
    reasons.push("award_identity_mismatch");
  }
  if (!isExactPublicHttpsUrl(source?.url)) reasons.push("source_url_not_public_https");
  if (
    source?.admin_review_status !== "open"
    || source?.admin_review_note !== "exact_first_visual_baseline_verified"
    || source?.admin_reviewed_by !== "stage1-baseline-activation-receipt"
  ) {
    reasons.push("source_not_exact_finalized_stage1_activation");
  }

  const activation = evaluateStage1FirstVisualBaselineActivation({
    acquisition: source?.source_acquisition,
    capture: null,
    sourceId,
    bindingOnly: true,
  });
  if (!activation.applies) {
    reasons.push("stage1_baseline_only_acquisition_missing");
  } else if (!activation.allowed) {
    reasons.push(activation.reason || "stage1_activation_binding_invalid");
  }
  const finalization = validateFinalizedActivationMetadata({
    source,
    acquisition: source?.source_acquisition,
    activation,
  });
  if (!finalization.valid) reasons.push(...finalization.reason_codes);

  return Object.freeze({
    eligible: reasons.length === 0,
    source_id: sourceId || null,
    manifest_item: manifestSource?.item ?? null,
    award: manifestSource?.award ?? null,
    page: manifestSource?.page ?? null,
    reason_codes: Object.freeze([...new Set(reasons)]),
    activation_binding: Object.freeze({
      applies: activation.applies === true,
      allowed: activation.allowed === true,
      reason: cleanText(activation.reason) || null,
      guard_sha256: cleanText(activation.guard_sha256) || null,
    }),
    finalization_binding: finalization.binding,
    semantic_difference_checked: false,
    evidence_completeness_checked: false,
  });
}

/**
 * Orchestrates the isolated source operation through injectable interfaces.
 * Dry-run still calls the full capture-and-validation interface; it skips only
 * the mutation interfaces. That keeps dry-run representative without granting
 * database, R2, baseline, candidate, quarantine, or source-state authority.
 */
export async function runStage1EvidenceSchemaUpgradeSource({
  source,
  manifest,
  dryRun = true,
  enqueuePolicy,
  interfaces = {},
  now = new Date().toISOString(),
} = {}) {
  const eligibility = evaluateStage1EvidenceSchemaUpgradeEligibility({ source, manifest });
  const evaluatedAt = requiredTimestamp(now, "evaluation time");
  const manifestSha256 = sha256(canonicalJson(manifest));
  const base = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    evaluated_at: evaluatedAt,
    mode: dryRun ? "dry_run" : "apply",
    source_id: eligibility.source_id,
    manifest_sha256: manifestSha256,
    source_eligible: eligibility.eligible,
    eligibility,
    queue_policy: normalizeQueuePolicy(enqueuePolicy),
    capture_validation: { status: "not_evaluated", decision: null, evidence: null },
    pointer_journal: { status: "not_requested" },
    visual_review_candidate: { status: "not_requested" },
    quarantine: { status: "not_requested" },
    safety: executionSafety({ dryRun }),
    mutation_counts: dryRun ? zeroMutationCounts() : null,
  };

  const preflightActiveJournal = interfaces.preflightActiveJournal;
  if (typeof preflightActiveJournal === "function") {
    let preflightRaw;
    let preflight = null;
    try {
      preflightRaw = await preflightActiveJournal({
        source,
        manifest_source: reviewedSourcesById.get(eligibility.source_id),
        dry_run: dryRun,
      });
      if (preflightRaw !== null && preflightRaw !== undefined) {
        preflight = normalizeMutationResult(preflightRaw, {
          sourceId: eligibility.source_id,
          operation: "pointer_commit",
          allowedStatuses: [
            "dry_run_recovery_required",
            "upgraded",
            "abandoned_old_authority",
            "recovery_required",
          ],
        });
      }
    } catch (error) {
      if (dryRun) throw error;
      const quarantineEvidenceFailure = interfaces.quarantineEvidenceFailure;
      if (typeof quarantineEvidenceFailure !== "function") throw error;
      const recoveryFailure = stage1JournalRecoveryExceptionValidation({
        sourceId: eligibility.source_id,
        error,
      });
      return quarantineStage1MutationFailure({
        source,
        sourceId: eligibility.source_id,
        captureValidation: recoveryFailure.raw,
        inspectedBase: {
          ...base,
          capture_validation: recoveryFailure.capture_validation,
        },
        operation: "pointer_commit",
        error,
        unsafeResult: preflightRaw,
        quarantineEvidenceFailure,
      });
    }
    if (preflight) {
      const preflightBase = {
        ...base,
        pointer_journal: opaqueStatus(preflight, preflight.status),
        mutation_counts: preflight.mutation_counts,
        mutation_accounting: preflight.mutation_accounting,
        mutation_count_certainty: preflight.mutation_count_certainty,
      };
      if (dryRun) {
        if (
          preflight.status !== "dry_run_recovery_required"
          || canonicalJson(preflight.mutation_counts) !== canonicalJson(zeroMutationCounts())
        ) {
          throw new Error(
            "Stage 1 dry-run active-journal preflight must be read-only and report recovery required.",
          );
        }
        return Object.freeze({
          ...preflightBase,
          status: "dry_run_recovery_required",
          reason_code: "active_upgrade_journal_requires_apply_recovery",
          capture_validation: {
            status: "not_evaluated_active_journal",
            decision: null,
            evidence: null,
          },
          quarantine: hasOwnedStage1EvidenceSchemaUpgradeQuarantineHold(source)
            ? Object.freeze({ status: "existing_hold", receipt: null })
            : base.quarantine,
        });
      }
      if (preflight.status === "dry_run_recovery_required") {
        throw new Error(
          "Stage 1 apply active-journal preflight returned a dry-run-only status.",
        );
      }
      if (preflight.status === "recovery_required") {
        const recoveryValidation = stage1JournalRecoveryFailureValidation({
          sourceId: eligibility.source_id,
          pointerCommitReceipt: preflight.receipt,
        });
        const preflightAccounting = preflight.mutation_accounting
          || sealStage1EvidenceSchemaUpgradeMutationAccounting({
            operation: "pointer_commit",
            lowerBoundCounts: preflight.mutation_counts,
            unknownWriteCategories: [],
            evidence: {
              source: "normalized_active_journal_preflight_result",
              status: preflight.status,
              receipt_sha256: sha256(canonicalJson(preflight.receipt)),
            },
          });
        const recoveryError = Object.assign(
          new Error(
            "The active Stage 1 upgrade journal remains authority-ambiguous after recovery.",
          ),
          {
            code: "active_upgrade_journal_authority_ambiguous",
            stage1_mutation_accounting: preflightAccounting,
          },
        );
        {
          const quarantineEvidenceFailure = interfaces.quarantineEvidenceFailure;
          if (typeof quarantineEvidenceFailure !== "function") {
            return Object.freeze({
              ...preflightBase,
              status: "journal_recovery_required",
              reason_code: "missing_interfaces:quarantineEvidenceFailure",
              capture_validation: recoveryValidation.capture_validation,
            });
          }
          let quarantineRaw;
          let quarantine;
          try {
            quarantineRaw = await quarantineEvidenceFailure({
              source,
              context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
              capture_validation: recoveryValidation.raw,
              mutation_failure: Object.freeze({
                operation: "pointer_commit",
                error: recoveryError,
                mutation_accounting: preflightAccounting,
              }),
            });
            quarantine = normalizeMutationResult(quarantineRaw, {
              sourceId: eligibility.source_id,
              operation: "quarantine",
              allowedStatuses: ["quarantined"],
            });
          } catch (error) {
            return buildStage1QuarantineFailureResult({
              inspectedBase: {
                ...preflightBase,
                capture_validation: recoveryValidation.capture_validation,
              },
              triggerReasonCode: "active_upgrade_journal_authority_ambiguous",
              originalOperation: "pointer_commit",
              originalError: recoveryError,
              originalAccounting: preflightAccounting,
              preserveOriginalOperationStatus: true,
              quarantineError: error,
              quarantineRaw,
            });
          }
          return Object.freeze({
            ...preflightBase,
            status: "journal_recovery_required",
            reason_code:
              quarantine.reason_code || "pointer_commit_mutation_failed",
            quarantine_trigger_reason_code:
              "active_upgrade_journal_authority_ambiguous",
            capture_validation: recoveryValidation.capture_validation,
            quarantine: opaqueStatus(quarantine, "failed"),
            mutation_counts: addMutationCounts(
              preflight.mutation_counts,
              quarantine.mutation_counts,
            ),
            mutation_count_certainty: combineMutationCountCertainty([
              preflight,
              quarantine,
            ]),
          });
        }
      }
      if (!eligibility.eligible) {
        const held = hasOwnedStage1EvidenceSchemaUpgradeQuarantineHold(source);
        return Object.freeze({
          ...preflightBase,
          status: held
            ? "journal_recovered_quarantine_remaining"
            : "journal_recovered_source_ineligible",
          reason_code: held
            ? "active_upgrade_journal_recovered_existing_quarantine_preserved"
            : "active_upgrade_journal_recovered_source_ineligible",
          quarantine: held
            ? Object.freeze({ status: "existing_hold", receipt: null })
            : base.quarantine,
        });
      }
      if (preflight.status === "upgraded") {
        return Object.freeze({
          ...preflightBase,
          status: "upgraded",
          reason_code: "sealed_candidate_authority_recovered",
          capture_validation: {
            status: "recovered_without_capture",
            decision: "eligible_unchanged_upgrade",
            reason: "sealed_candidate_authority_recovered",
            evidence: { pointer_commit: preflight.receipt },
          },
        });
      }
      return Object.freeze({
        ...preflightBase,
        status: "journal_recovered_retry_required",
        reason_code: "old_authority_recovered_without_new_capture",
      });
    }
  }

  if (!eligibility.eligible) {
    return Object.freeze({
      ...base,
      status: "ineligible",
      mutation_counts: zeroMutationCounts(),
      quarantine: hasOwnedStage1EvidenceSchemaUpgradeQuarantineHold(source)
        ? Object.freeze({ status: "existing_hold", receipt: null })
        : base.quarantine,
    });
  }
  const captureAndValidate = interfaces.captureAndValidate;
  const upgradeEvidenceSchema = interfaces.upgradeEvidenceSchema;
  const enqueueVisualReviewCandidate = interfaces.enqueueVisualReviewCandidate;
  const quarantineEvidenceFailure = interfaces.quarantineEvidenceFailure;
  if (typeof captureAndValidate !== "function") {
    return Object.freeze({
      ...base,
      status: "implementation_blocked",
      reason_code: "missing_interfaces:captureAndValidate",
    });
  }

  const evidence = await captureAndValidate({
    source,
    manifest_source: reviewedSourcesById.get(eligibility.source_id),
    dry_run: dryRun,
  });
  assertZeroChargeResult(evidence, "capture validation");
  const inspected = normalizeCaptureValidation(evidence);
  const inspectedBase = {
    ...base,
    capture_validation: inspected.capture_validation,
  };
  if (dryRun) {
    return Object.freeze({
      ...inspectedBase,
      status: inspected.decision === "evidence_failure_quarantine"
        ? "dry_run_evidence_failure"
        : "dry_run_ready",
      reason_code: inspected.reason_code,
      pointer_journal: {
        status: inspected.outcome.would_commit ? "would_commit" : "not_planned",
      },
      visual_review_candidate: {
        status: inspected.outcome.would_queue_visual_candidate ? "would_queue" : "not_planned",
      },
      quarantine: {
        status: inspected.outcome.would_quarantine ? "would_quarantine" : "not_planned",
      },
      mutation_counts: zeroMutationCounts(),
    });
  }

  const requiredInterfaces = [];
  if (inspected.outcome.would_commit && typeof upgradeEvidenceSchema !== "function") {
    requiredInterfaces.push("upgradeEvidenceSchema");
  }
  if (
    inspected.outcome.would_queue_visual_candidate
    && typeof enqueueVisualReviewCandidate !== "function"
  ) {
    requiredInterfaces.push("enqueueVisualReviewCandidate");
  }
  if (
    (
      inspected.outcome.would_commit
      || inspected.outcome.would_queue_visual_candidate
      || inspected.outcome.would_quarantine
    )
    && typeof quarantineEvidenceFailure !== "function"
  ) {
    requiredInterfaces.push("quarantineEvidenceFailure");
  }
  if (requiredInterfaces.length) {
    return Object.freeze({
      ...inspectedBase,
      status: "implementation_blocked",
      reason_code: `missing_interfaces:${requiredInterfaces.join(",")}`,
    });
  }

  if (inspected.outcome.would_quarantine) {
    let quarantineRaw;
    let quarantine;
    try {
      quarantineRaw = await quarantineEvidenceFailure({
        source,
        context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
        capture_validation: evidence,
      });
      quarantine = normalizeMutationResult(quarantineRaw, {
        sourceId: eligibility.source_id,
        operation: "quarantine",
        allowedStatuses: ["quarantined"],
      });
    } catch (error) {
      return buildStage1QuarantineFailureResult({
        inspectedBase,
        triggerReasonCode: inspected.reason_code,
        quarantineError: error,
        quarantineRaw,
      });
    }
    return Object.freeze({
      ...inspectedBase,
      status: cleanText(quarantine?.status) === "quarantined"
        ? "evidence_failure_quarantined"
        : "quarantine_failed",
      reason_code: quarantine.reason_code || inspected.reason_code,
      quarantine: opaqueStatus(quarantine, "failed"),
      mutation_counts: quarantine.mutation_counts,
      mutation_count_certainty: quarantine.mutation_count_certainty,
    });
  }

  let upgrade = { status: "not_planned", receipt: null };
  let upgradeRaw = null;
  let mutationCounts = zeroMutationCounts();
  if (inspected.outcome.would_commit) {
    try {
      upgradeRaw = await upgradeEvidenceSchema({
        source,
        manifest_source: reviewedSourcesById.get(eligibility.source_id),
        capture_validation: evidence,
        enqueue_policy: base.queue_policy,
      });
      upgrade = normalizeMutationResult(upgradeRaw, {
        sourceId: eligibility.source_id,
        operation: "pointer_commit",
        allowedStatuses: ["upgraded", "abandoned_old_authority"],
      });
    } catch (error) {
      return quarantineStage1MutationFailure({
        source,
        sourceId: eligibility.source_id,
        captureValidation: evidence,
        inspectedBase,
        operation: "pointer_commit",
        error,
        unsafeResult: upgradeRaw,
        quarantineEvidenceFailure,
      });
    }
    mutationCounts = addMutationCounts(mutationCounts, upgrade.mutation_counts);
    if (upgrade.status === "abandoned_old_authority") {
      return Object.freeze({
        ...inspectedBase,
        status: "pointer_commit_retry_required",
        reason_code: "authoritative_snapshot_changed_retry_required",
        pointer_journal: opaqueStatus(upgrade, "abandoned_old_authority"),
        visual_review_candidate: { status: "not_planned" },
        mutation_counts: mutationCounts,
        mutation_count_certainty: combineMutationCountCertainty([upgrade]),
      });
    }
  }

  let candidate = { status: "not_planned", receipt: null };
  let candidateRaw = null;
  if (inspected.outcome.would_queue_visual_candidate) {
    try {
      candidateRaw = await enqueueVisualReviewCandidate({
        source,
        context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
        enqueue_policy: base.queue_policy,
        capture_validation: evidence,
        evidence_upgrade: upgrade,
      });
      candidate = normalizeMutationResult(candidateRaw, {
        sourceId: eligibility.source_id,
        operation: "candidate_enqueue",
        allowedStatuses: ["queued", "existing"],
      });
    } catch (error) {
      return quarantineStage1MutationFailure({
        source,
        sourceId: eligibility.source_id,
        captureValidation: evidence,
        inspectedBase,
        operation: "candidate_enqueue",
        error,
        unsafeResult: candidateRaw,
        quarantineEvidenceFailure,
      });
    }
    mutationCounts = addMutationCounts(mutationCounts, candidate.mutation_counts);
  }

  return Object.freeze({
    ...inspectedBase,
    status: inspected.outcome.would_commit
      ? inspected.outcome.would_queue_visual_candidate
        ? "upgraded_and_queued"
        : "upgraded"
      : "candidate_queued",
    pointer_journal: opaqueStatus(upgrade, "not_planned"),
    visual_review_candidate: opaqueStatus(candidate, cleanText(candidate.status)),
    mutation_counts: mutationCounts,
    mutation_count_certainty: combineMutationCountCertainty([upgrade, candidate]),
  });
}

export function createStage1EvidenceSchemaUpgradeReport({
  manifest,
  dryRun = true,
  results = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const checkedManifest = validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const rows = Array.isArray(results) ? results : [];
  const resultIds = rows.map((row) => row?.source_id);
  if (rows.length) {
    assertExactStage1EvidenceSchemaUpgradeSourceIds(resultIds, "result source IDs");
  }
  const eligible = rows.filter((row) => row?.source_eligible === true).length;
  const upgradedStatuses = new Set([
    "upgraded_and_queued",
    "upgraded",
  ]);
  const candidateStatuses = new Set([
    "upgraded_and_queued",
    "candidate_queued",
  ]);
  const quarantinedStatuses = new Set([
    "evidence_failure_quarantined",
    "journal_recovered_quarantine_remaining",
  ]);
  const durableQuarantineStates = new Set(["quarantined", "existing_hold"]);
  const successfulStatuses = new Set([
    ...upgradedStatuses,
    ...candidateStatuses,
  ]);
  const upgraded = rows.filter((row) => upgradedStatuses.has(row?.status)).length;
  const candidates = rows.filter((row) => candidateStatuses.has(row?.status)).length;
  const quarantined = rows.filter((row) => (
    quarantinedStatuses.has(row?.status)
    || durableQuarantineStates.has(row?.quarantine?.status)
  )).length;
  const completed = rows.filter((row) => successfulStatuses.has(row?.status)).length;
  const blocked = rows.filter((row) => !new Set([
    "dry_run_ready",
    ...successfulStatuses,
    ...quarantinedStatuses,
  ]).has(row?.status)).length;
  const exactCohortEvaluated =
    rows.length === STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length;
  const uncertainRows = rows.filter(
    (row) => (
      row?.mutation_count_certainty?.exact === false
      || (!dryRun && !hasValidMutationCounts(row?.mutation_counts))
    ),
  );
  const unknownWriteCategories = [...new Set(uncertainRows.flatMap(
    (row) => row?.mutation_count_certainty?.exact === false
      ? row.mutation_count_certainty.unknown_write_categories || []
      : Object.keys(zeroMutationCounts()),
  ))].sort();
  return Object.freeze({
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REPORT_SCHEMA,
    generated_at: requiredTimestamp(generatedAt, "report generation time"),
    mode: dryRun ? "dry_run" : "apply",
    manifest_sha256: sha256(canonicalJson(checkedManifest)),
    exact_source_count: STAGE1_EVIDENCE_SCHEMA_UPGRADE_SOURCE_IDS.length,
    evaluated_source_count: rows.length,
    eligible_source_count: eligible,
    upgraded_source_count: upgraded,
    candidate_source_count: candidates,
    quarantined_source_count: quarantined,
    completed_source_count: completed,
    blocked_source_count: blocked,
    terminal_failure_source_count: blocked,
    automated_work_clear: exactCohortEvaluated && blocked === 0 && quarantined === 0,
    quarantined_work_remaining: quarantined,
    status: !exactCohortEvaluated || blocked
      ? "blocked"
      : dryRun
        ? "dry_run_complete"
        : quarantined
          ? "quarantined_work_remaining"
          : "completed",
    results: rows,
    safety: executionSafety({ dryRun }),
    mutation_counts: dryRun ? zeroMutationCounts() : summarizeMutationCounts(rows),
    mutation_counts_are_exact: dryRun || uncertainRows.length === 0,
    mutation_count_semantics: dryRun || uncertainRows.length === 0
      ? "exact"
      : "confirmed_lower_bounds_with_unknown_writes",
    mutation_count_uncertain_source_count: dryRun ? 0 : uncertainRows.length,
    unknown_write_categories: dryRun ? Object.freeze([]) : Object.freeze(unknownWriteCategories),
  });
}

export function buildStage1EvidenceSchemaUpgradeFailureResult({
  sourceId,
  manifest,
  dryRun = true,
  enqueuePolicy,
  error,
  evaluatedAt = new Date().toISOString(),
} = {}) {
  const checkedManifest = validateStage1EvidenceSchemaUpgradeManifest(manifest);
  const canonicalSourceId = cleanText(sourceId).toLowerCase();
  if (!uuidPattern.test(canonicalSourceId)) {
    throw new Error("Stage 1 evidence-schema-upgrade failure source ID is invalid.");
  }
  return Object.freeze({
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_RESULT_SCHEMA,
    evaluated_at: requiredTimestamp(evaluatedAt, "failure evaluation time"),
    mode: dryRun ? "dry_run" : "apply",
    source_id: canonicalSourceId,
    manifest_sha256: sha256(canonicalJson(checkedManifest)),
    source_eligible: null,
    eligibility: null,
    queue_policy: normalizeQueuePolicy(enqueuePolicy),
    capture_validation: { status: "failed", decision: null, evidence: null },
    pointer_journal: { status: "not_requested" },
    visual_review_candidate: { status: "not_requested" },
    quarantine: { status: "not_requested" },
    safety: executionSafety({ dryRun }),
    mutation_counts: dryRun ? zeroMutationCounts() : null,
    status: "isolated_mode_failed",
    reason_code: cleanText(error?.code) || "stage1_evidence_schema_upgrade_failed",
    error: cleanText(error?.message || error) || "Unknown isolated-mode failure.",
  });
}

function normalizeQueuePolicy(value) {
  if (
    value?.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT
    || value?.bypassRejectionLedger !== true
    || value?.queueReconciliation !== false
  ) {
    throw new Error(
      "Stage 1 evidence-schema upgrade requires its exact visual-review enqueue policy.",
    );
  }
  return Object.freeze({
    context: value.context,
    bypassRejectionLedger: true,
    queueReconciliation: false,
  });
}

function validateFinalizedActivationMetadata({ source, acquisition, activation }) {
  const row = source?.source_activation_finalization;
  const receipt = row?.receipt;
  const disposition = acquisition?.review_seal?.human_source_disposition;
  const guard = disposition?.activation_guard;
  const reasons = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    reasons.push("stage1_activation_finalization_missing");
  } else {
    if (
      cleanText(row.shared_award_source_id) !== cleanText(source?.id)
      || cleanText(row.source_acquisition_id) !== cleanText(acquisition?.id)
      || cleanText(row.source_page_request_id)
        !== cleanText(acquisition?.origin_source_page_request_id)
    ) {
      reasons.push("stage1_activation_finalization_identity_mismatch");
    }
    if (
      cleanText(row.disposition_item_sha256) !== cleanText(guard?.decision_item_sha256)
      || cleanText(row.guard_sha256) !== cleanText(activation?.guard_sha256)
      || !shaPattern.test(cleanText(row.prepare_receipt_sha256))
      || !shaPattern.test(cleanText(row.observed_normalized_text_sha256))
      || !shaPattern.test(cleanText(row.finalization_receipt_sha256))
    ) {
      reasons.push("stage1_activation_finalization_hash_binding_invalid");
    }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      reasons.push("stage1_activation_finalization_receipt_missing");
    } else {
      const expectedReceiptKeys = [
        "creates_api_charge",
        "decision_item_sha256",
        "finalized_at",
        "guard_sha256",
        "observed_normalized_text_sha256",
        "persistence_evidence_sha256",
        "prepare_receipt_sha256",
        "public_fact_authority",
        "schema_version",
        "shared_award_source_id",
        "source_acquisition_id",
        "source_page_request_id",
        "status",
      ].sort();
      if (canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(expectedReceiptKeys)) {
        reasons.push("stage1_activation_finalization_receipt_keys_invalid");
      }
      if (
        receipt.schema_version
          !== "awardping.stage1.baseline-activation-finalization-receipt.v1"
        || receipt.status !== "finalized_open"
        || receipt.creates_api_charge !== false
        || receipt.public_fact_authority !== false
        || receipt.shared_award_source_id !== row.shared_award_source_id
        || receipt.source_acquisition_id !== row.source_acquisition_id
        || receipt.source_page_request_id !== row.source_page_request_id
        || receipt.decision_item_sha256 !== row.disposition_item_sha256
        || receipt.prepare_receipt_sha256 !== row.prepare_receipt_sha256
        || receipt.guard_sha256 !== row.guard_sha256
        || receipt.observed_normalized_text_sha256
          !== row.observed_normalized_text_sha256
        || receipt.persistence_evidence_sha256
          !== sha256(canonicalJson(row.persistence_evidence))
        || row.finalization_receipt_sha256 !== sha256(canonicalJson(receipt))
      ) {
        reasons.push("stage1_activation_finalization_receipt_binding_invalid");
      }
      const finalizedAt = canonicalTimestamp(row.finalized_at);
      if (
        !finalizedAt
        || canonicalTimestamp(receipt.finalized_at) !== finalizedAt
        || canonicalTimestamp(source?.admin_reviewed_at) !== finalizedAt
      ) {
        reasons.push("stage1_activation_finalization_timestamp_mismatch");
      }
    }
  }
  return Object.freeze({
    valid: reasons.length === 0,
    reason_codes: Object.freeze([...new Set(reasons)]),
    binding: Object.freeze({
      present: Boolean(row && typeof row === "object" && !Array.isArray(row)),
      source_acquisition_id: cleanText(row?.source_acquisition_id) || null,
      finalization_receipt_sha256: cleanText(row?.finalization_receipt_sha256) || null,
      finalized_at: canonicalTimestamp(row?.finalized_at),
    }),
  });
}

function normalizeCaptureValidation(value) {
  const decisions = new Set([
    "eligible_unchanged_upgrade",
    "material_difference_candidate",
    "evidence_failure_quarantine",
  ]);
  const decision = cleanText(value?.decision);
  if (!decisions.has(decision)) {
    throw new Error("Stage 1 capture validation returned an unsupported decision.");
  }
  const outcome = value?.outcome || {};
  const expectedOutcome = {
    would_commit: decision === "eligible_unchanged_upgrade",
    would_queue_visual_candidate: decision === "material_difference_candidate",
    would_quarantine: decision === "evidence_failure_quarantine",
  };
  if (
    outcome.would_commit !== expectedOutcome.would_commit
    || outcome.would_queue_visual_candidate !== expectedOutcome.would_queue_visual_candidate
    || outcome.would_quarantine !== expectedOutcome.would_quarantine
  ) {
    throw new Error("Stage 1 capture validation decision and planned outcome disagree.");
  }
  const reason = cleanText(value?.reason);
  const legacyReasonCode = cleanText(value?.reason_code);
  if (reason && legacyReasonCode && reason !== legacyReasonCode) {
    throw new Error("Stage 1 capture validation reason and reason_code disagree.");
  }
  const normalizedReason = reason || legacyReasonCode || null;
  return Object.freeze({
    decision,
    reason_code: normalizedReason,
    outcome: Object.freeze(expectedOutcome),
    capture_validation: Object.freeze({
      status: "evaluated",
      decision,
      reason: normalizedReason,
      evidence: value?.evidence ?? null,
    }),
  });
}

function stage1JournalRecoveryFailureValidation({ sourceId, pointerCommitReceipt }) {
  const reason = "active_upgrade_journal_authority_ambiguous";
  const evidence = Object.freeze({
    source_id: sourceId,
    pointer_commit_receipt: pointerCommitReceipt ?? null,
  });
  const raw = Object.freeze({
    schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
    decision: "evidence_failure_quarantine",
    creates_api_charge: false,
    reason,
    reasons: Object.freeze([Object.freeze({
      code: reason,
      detail:
        "The sealed Stage 1 upgrade journal could not be reconciled to old or candidate authority and requires durable operator quarantine.",
    })]),
    evidence,
    outcome: Object.freeze({
      would_commit: false,
      would_queue_visual_candidate: false,
      would_quarantine: true,
      creates_api_charge: false,
    }),
  });
  return Object.freeze({
    raw,
    capture_validation: Object.freeze({
      status: "evaluated",
      decision: raw.decision,
      reason,
      evidence,
    }),
  });
}

function stage1JournalRecoveryExceptionValidation({ sourceId, error }) {
  const reason = "active_upgrade_journal_recovery_failed";
  const evidence = Object.freeze({
    source_id: sourceId,
    error: Object.freeze({
      name: cleanText(error?.name) || "Error",
      code: cleanText(error?.code) || null,
      message: cleanText(error?.message || error) || "Unknown active-journal recovery failure.",
    }),
    mutation_accounting: (() => {
      try {
        return assertStage1EvidenceSchemaUpgradeMutationAccounting(
          error?.stage1_mutation_accounting,
          { operation: "pointer_commit" },
        );
      } catch {
        return null;
      }
    })(),
  });
  const raw = Object.freeze({
    schema_version: "awardping.stage1.evidence-schema-upgrade-validation.v1",
    decision: "evidence_failure_quarantine",
    creates_api_charge: false,
    reason,
    reasons: Object.freeze([Object.freeze({
      code: reason,
      detail:
        "The sealed Stage 1 active journal could not be recovered safely and requires durable operator quarantine.",
    })]),
    evidence,
    outcome: Object.freeze({
      would_commit: false,
      would_queue_visual_candidate: false,
      would_quarantine: true,
      creates_api_charge: false,
    }),
  });
  return Object.freeze({
    raw,
    capture_validation: Object.freeze({
      status: "evaluated",
      decision: raw.decision,
      reason,
      evidence,
    }),
  });
}

function assertZeroChargeResult(value, label) {
  if (value?.creates_api_charge !== false) {
    throw new Error(`Stage 1 ${label} must explicitly prove creates_api_charge=false.`);
  }
}

async function quarantineStage1MutationFailure({
  source,
  sourceId,
  captureValidation,
  inspectedBase,
  operation,
  error,
  unsafeResult = null,
  quarantineEvidenceFailure,
}) {
  const mutationAccounting = mutationFailureAccounting(
    error,
    operation,
    unsafeResult,
  );
  const mutationFailure = Object.freeze({
    operation,
    error,
    mutation_accounting: mutationAccounting,
  });
  let quarantineRaw;
  let quarantine;
  try {
    quarantineRaw = await quarantineEvidenceFailure({
      source,
      context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
      capture_validation: captureValidation,
      mutation_failure: mutationFailure,
    });
    quarantine = normalizeMutationResult(quarantineRaw, {
      sourceId,
      operation: "quarantine",
      allowedStatuses: ["quarantined"],
    });
  } catch (quarantineError) {
    return buildStage1QuarantineFailureResult({
      inspectedBase,
      triggerReasonCode: `${operation}_mutation_failed`,
      originalOperation: operation,
      originalError: error,
      originalAccounting: mutationAccounting,
      quarantineError,
      quarantineRaw,
    });
  }
  const mutationError = Object.freeze({
    operation,
    name: cleanText(error?.name) || "Error",
    code: cleanText(error?.code) || null,
    message: cleanText(error?.message || error) || "Unknown Stage 1 mutation failure.",
  });
  const quarantineAccounting = quarantine.mutation_accounting;
  const unknownWriteCategories = [...new Set([
    ...mutationAccounting.unknown_write_categories,
    ...(quarantine.mutation_count_certainty?.unknown_write_categories || []),
  ])].sort();
  const quarantineCountsExact = quarantine.mutation_count_certainty?.exact !== false;
  const countsExact = mutationAccounting.exact && quarantineCountsExact;
  return Object.freeze({
    ...inspectedBase,
    status: "evidence_failure_quarantined",
    reason_code: `${operation}_mutation_failed`,
    pointer_journal: operation === "pointer_commit"
      ? Object.freeze({ status: "mutation_failed", receipt: null })
      : inspectedBase.pointer_journal,
    visual_review_candidate: operation === "candidate_enqueue"
      ? Object.freeze({ status: "mutation_failed", receipt: null })
      : inspectedBase.visual_review_candidate,
    quarantine: opaqueStatus(quarantine, "failed"),
    mutation_failure: mutationError,
    mutation_accounting: mutationAccounting,
    quarantine_mutation_accounting: quarantineAccounting,
    mutation_count_certainty: Object.freeze({
      exact: countsExact,
      count_semantics: countsExact
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes",
      unknown_write_categories: Object.freeze(unknownWriteCategories),
      prior_operation_accounting_sha256: mutationAccounting.accounting_sha256,
      quarantine_accounting_sha256: quarantineAccounting?.accounting_sha256 || null,
      quarantine_counts_exact: quarantineCountsExact,
    }),
    mutation_counts: addMutationCounts(
      mutationAccounting.lower_bound_counts,
      quarantine.mutation_counts,
    ),
  });
}

function buildStage1QuarantineFailureResult({
  inspectedBase,
  triggerReasonCode,
  originalOperation = null,
  originalError = null,
  originalAccounting = null,
  preserveOriginalOperationStatus = false,
  quarantineError,
  quarantineRaw = null,
}) {
  const quarantineAccounting = mutationFailureAccounting(
    quarantineError,
    "quarantine",
    quarantineRaw,
  );
  const accountings = [originalAccounting, quarantineAccounting].filter(Boolean);
  const mutationCounts = accountings.reduce(
    (counts, accounting) => addMutationCounts(counts, accounting.lower_bound_counts),
    zeroMutationCounts(),
  );
  const unknownWriteCategories = [...new Set(accountings.flatMap(
    (accounting) => accounting.unknown_write_categories,
  ))].sort();
  const exact = unknownWriteCategories.length === 0;
  const quarantineFailure = mutationErrorSummary("quarantine", quarantineError);
  const primaryFailure = originalOperation
    ? mutationErrorSummary(originalOperation, originalError)
    : quarantineFailure;
  return Object.freeze({
    ...inspectedBase,
    status: "quarantine_failed",
    reason_code: "quarantine_mutation_failed",
    quarantine_trigger_reason_code: cleanText(triggerReasonCode) || null,
    pointer_journal: originalOperation === "pointer_commit"
      && !preserveOriginalOperationStatus
      ? Object.freeze({ status: "mutation_failed", receipt: null })
      : inspectedBase.pointer_journal,
    visual_review_candidate: originalOperation === "candidate_enqueue"
      && !preserveOriginalOperationStatus
      ? Object.freeze({ status: "mutation_failed", receipt: null })
      : inspectedBase.visual_review_candidate,
    quarantine: Object.freeze({ status: "failed", receipt: null }),
    mutation_failure: primaryFailure,
    quarantine_failure: quarantineFailure,
    mutation_accounting: originalAccounting || quarantineAccounting,
    quarantine_mutation_accounting: quarantineAccounting,
    mutation_count_certainty: Object.freeze({
      exact,
      count_semantics: exact
        ? "exact"
        : "confirmed_lower_bounds_with_unknown_writes",
      unknown_write_categories: Object.freeze(unknownWriteCategories),
      prior_operation_accounting_sha256: originalAccounting?.accounting_sha256 || null,
      quarantine_accounting_sha256: quarantineAccounting.accounting_sha256,
    }),
    mutation_counts: mutationCounts,
  });
}

function mutationErrorSummary(operation, error) {
  return Object.freeze({
    operation,
    name: cleanText(error?.name) || "Error",
    code: cleanText(error?.code) || null,
    message: cleanText(error?.message || error) || "Unknown Stage 1 mutation failure.",
  });
}

function mutationFailureAccounting(error, operation, unsafeResult = null) {
  try {
    return assertStage1EvidenceSchemaUpgradeMutationAccounting(
      error?.stage1_mutation_accounting,
      { operation },
    );
  } catch {
    try {
      const counts = normalizeMutationCounts(
        unsafeResult?.mutation_counts,
        `${operation} unsafe mutation`,
      );
      const receiptCounts = normalizeMutationCounts(
        unsafeResult?.receipt?.mutation_counts,
        `${operation} unsafe mutation receipt`,
      );
      if (canonicalJson(counts) !== canonicalJson(receiptCounts)) throw new Error();
      const accounting = normalizeResultMutationAccounting({
        value: unsafeResult,
        receipt: unsafeResult?.receipt,
        operation,
        counts,
      });
      if (accounting) return accounting;
    } catch {
      // An unsafe response may contribute only independently sealed, matching
      // accounting. Otherwise its possible writes remain explicitly unknown.
    }
    const possible = operation === "candidate_enqueue"
      ? ["candidate_writes", "database_writes"]
      : operation === "quarantine"
        ? ["database_writes", "quarantine_writes", "source_state_writes"]
        : [
            "database_writes",
            "local_baseline_writes",
            "r2_writes",
            "source_state_writes",
          ];
    return sealStage1EvidenceSchemaUpgradeMutationAccounting({
      operation,
      lowerBoundCounts: zeroMutationCounts(),
      unknownWriteCategories: possible,
      evidence: {
        source: "unsealed_mutation_exception",
        error_code: cleanText(error?.code) || null,
      },
    });
  }
}

function normalizeMutationResult(value, { sourceId, operation, allowedStatuses }) {
  assertZeroChargeResult(value, `${operation} mutation`);
  const status = cleanText(value?.status);
  if (!allowedStatuses.includes(status)) {
    throw new Error(`Stage 1 ${operation} returned unsupported status \"${status || "missing"}\".`);
  }
  if (
    cleanText(value?.source_id) !== sourceId
    || value?.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT
  ) {
    throw new Error(`Stage 1 ${operation} mutation identity does not match its source and context.`);
  }
  const counts = normalizeMutationCounts(value?.mutation_counts, `${operation} mutation`);
  const receipt = value?.receipt;
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || cleanText(receipt.source_id) !== sourceId
    || receipt.context !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT
    || receipt.operation !== operation
    || receipt.status !== status
    || receipt.creates_api_charge !== false
  ) {
    throw new Error(`Stage 1 ${operation} mutation receipt identity is invalid.`);
  }
  const receiptCounts = normalizeMutationCounts(
    receipt.mutation_counts,
    operation + " mutation receipt",
  );
  if (canonicalJson(receiptCounts) !== canonicalJson(counts)) {
    throw new Error(
      "Stage 1 " + operation + " outer and receipt mutation counts do not match exactly.",
    );
  }
  const reasonCode = cleanText(value?.reason_code) || null;
  const receiptReasonCode = cleanText(receipt?.reason_code) || null;
  if (reasonCode !== receiptReasonCode) {
    throw new Error(
      `Stage 1 ${operation} outer and receipt reason codes do not match exactly.`,
    );
  }
  const mutationAccounting = normalizeResultMutationAccounting({
    value,
    receipt,
    operation,
    counts,
  });
  assertOperationMutationProfile({ operation, status, counts });
  return Object.freeze({
    status,
    source_id: sourceId,
    context: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUEUE_CONTEXT,
    creates_api_charge: false,
    mutation_counts: counts,
    mutation_accounting: mutationAccounting,
    mutation_count_certainty: mutationAccounting
      ? Object.freeze({
          exact: mutationAccounting.exact,
          count_semantics: mutationAccounting.exact
            ? "exact"
            : "confirmed_lower_bounds_with_unknown_writes",
          unknown_write_categories: mutationAccounting.unknown_write_categories,
          accounting_sha256: mutationAccounting.accounting_sha256,
        })
      : exactMutationCountCertainty(),
    reason_code: reasonCode,
    receipt,
  });
}

function normalizeResultMutationAccounting({ value, receipt, operation, counts }) {
  const outer = value?.mutation_accounting ?? null;
  const inner = receipt?.mutation_accounting ?? null;
  if (outer === null && inner === null) return null;
  if (outer === null || inner === null) {
    throw new Error(
      `Stage 1 ${operation} outer and receipt mutation accounting must both be present.`,
    );
  }
  const checkedOuter = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    outer,
    { operation },
  );
  const checkedInner = assertStage1EvidenceSchemaUpgradeMutationAccounting(
    inner,
    { operation },
  );
  if (
    checkedOuter.accounting_sha256 !== checkedInner.accounting_sha256
    || canonicalJson(checkedOuter.lower_bound_counts) !== canonicalJson(counts)
  ) {
    throw new Error(
      `Stage 1 ${operation} mutation accounting does not match its receipt and counts.`,
    );
  }
  return checkedOuter;
}

function assertOperationMutationProfile({ operation, status, counts }) {
  const categorizedDatabaseWrites =
    counts.candidate_writes + counts.quarantine_writes + counts.source_state_writes;
  if (counts.database_writes < categorizedDatabaseWrites) {
    throw new Error(
      "Stage 1 " + operation + " mutation counts underreport categorized database writes.",
    );
  }
  if (
    operation === "pointer_commit"
    && (counts.candidate_writes !== 0 || counts.quarantine_writes !== 0)
  ) {
    throw new Error("Stage 1 pointer_commit contains out-of-scope queue or quarantine writes.");
  }
  if (
    operation === "candidate_enqueue"
    && (
      counts.r2_writes !== 0
      || counts.local_baseline_writes !== 0
      || counts.quarantine_writes !== 0
      || counts.source_state_writes !== 0
      || (status === "queued" && counts.candidate_writes < 1)
      || (status === "existing" && counts.candidate_writes !== 0)
    )
  ) {
    throw new Error("Stage 1 candidate_enqueue contains out-of-scope mutations.");
  }
  if (
    operation === "quarantine"
    && (
      counts.r2_writes !== 0
      || counts.local_baseline_writes !== 0
      || counts.candidate_writes !== 0
      || counts.quarantine_writes < 1
    )
  ) {
    throw new Error("Stage 1 quarantine contains out-of-scope mutations.");
  }
}

function normalizeMutationCounts(value, label) {
  const keys = Object.keys(zeroMutationCounts()).sort();
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys)
    || keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
  ) {
    throw new Error(`Stage 1 ${label} mutation counts are invalid.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function addMutationCounts(left, right) {
  return Object.freeze(Object.fromEntries(
    Object.keys(zeroMutationCounts()).map((key) => [key, left[key] + right[key]]),
  ));
}

function exactMutationCountCertainty() {
  return Object.freeze({
    exact: true,
    count_semantics: "exact",
    unknown_write_categories: Object.freeze([]),
    accounting_sha256: null,
  });
}

function hasOwnedStage1EvidenceSchemaUpgradeQuarantineHold(source) {
  return source?.admin_review_status === "review_later"
    && source?.admin_reviewed_by === "stage1-evidence-schema-upgrade-quarantine"
    && /^stage1_evidence_schema_upgrade_failed:[a-z0-9][a-z0-9_]{1,159}$/u.test(
      cleanText(source?.admin_review_note),
    );
}

function combineMutationCountCertainty(results) {
  const uncertain = results.filter(
    (result) => result?.mutation_count_certainty?.exact === false,
  );
  const unknown = [...new Set(uncertain.flatMap(
    (result) => result.mutation_count_certainty.unknown_write_categories || [],
  ))].sort();
  return Object.freeze({
    exact: uncertain.length === 0,
    count_semantics: uncertain.length === 0
      ? "exact"
      : "confirmed_lower_bounds_with_unknown_writes",
    unknown_write_categories: Object.freeze(unknown),
    accounting_sha256: uncertain.length === 1
      ? uncertain[0].mutation_count_certainty.accounting_sha256 || null
      : null,
  });
}

function opaqueStatus(value, fallback) {
  return Object.freeze({
    status: cleanText(value?.status) || fallback,
    receipt: value?.receipt ?? null,
  });
}

function executionSafety({ dryRun }) {
  const invariant = {
    creates_api_charge: false,
    live_capture_permitted: true,
    local_capture_artifacts_permitted: true,
    public_fact_writes: 0,
    reconciliation_requests: 0,
    public_events: 0,
    source_discovery: false,
    baseline_refreshes: 0,
  };
  return Object.freeze(dryRun
    ? {
        ...invariant,
        database_writes: 0,
        r2_writes: 0,
        local_baseline_writes: 0,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 0,
      }
    : invariant);
}

function zeroMutationCounts() {
  return Object.freeze({
    database_writes: 0,
    r2_writes: 0,
    local_baseline_writes: 0,
    candidate_writes: 0,
    quarantine_writes: 0,
    source_state_writes: 0,
  });
}

function summarizeMutationCounts(rows) {
  const totals = { ...zeroMutationCounts() };
  for (const row of rows) {
    const counts = row?.mutation_counts;
    if (!counts) return null;
    for (const key of Object.keys(totals)) {
      if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) return null;
      totals[key] += counts[key];
    }
  }
  return Object.freeze(totals);
}

function hasValidMutationCounts(value) {
  const keys = Object.keys(zeroMutationCounts());
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
    && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function isExactPublicHttpsUrl(value) {
  try {
    const parsed = new URL(cleanText(value));
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && !new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function parseJsonObject(value, label) {
  let parsed = value;
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new Error(`${label} is not valid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function requiredTimestamp(value, label) {
  const parsed = Date.parse(cleanText(value));
  if (!Number.isFinite(parsed)) throw new Error(`Stage 1 ${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function canonicalTimestamp(value) {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = cleanText(value).toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Stage 1 evidence-schema-upgrade boolean value \"${String(value)}\" is invalid.`);
}

function exactTrueCliLiteral(value) {
  return value === true || value === "true";
}

function exactBooleanCliLiteral(value) {
  return value === true || value === false || value === "true" || value === "false";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{64}$/;
