import "server-only";
import { createHash } from "node:crypto";
import { appConfig } from "@/lib/config";
import type { Database, Json } from "@/lib/database.types";
import { SAVED_FIRST_OBSERVATION_RESTORED_REASON } from "@/lib/source-intake-operator-actions";
import {
  IntakeArtifactRetentionError,
  verifySavedFirstObservationHtmlCapture,
} from "../../scripts/lib/intake-artifact-r2-verification.mjs";

type RequestRow = Database["public"]["Tables"]["source_page_requests"]["Row"];
type RequestPatch = Database["public"]["Tables"]["source_page_requests"]["Update"];

export class SavedCaptureRestoreError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) {
    super(message);
    this.name = "SavedCaptureRestoreError";
  }
}

// No database, URL capture, provider call or storage write. The caller must
// commit this narrow patch with the observed row's status/time/idle CAS.
export async function savedCaptureRestorePatch({
  current, savedCaptureMetadata, expectedUpdatedAt, actorEmail, now,
}: {
  current: RequestRow;
  savedCaptureMetadata: Record<string, unknown>;
  expectedUpdatedAt: string;
  actorEmail: string;
  now: string;
}): Promise<RequestPatch> {
  if (!expectedUpdatedAt || expectedUpdatedAt !== current.updated_at || current.worker_run_id !== null) {
    throw new SavedCaptureRestoreError("This request changed or is being processed. Refresh before restoring it.");
  }
  const actor = actorEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(actor) || !Number.isFinite(Date.parse(now))) {
    throw new SavedCaptureRestoreError("The administrator or recovery timestamp could not be verified.");
  }
  const originalInput = JSON.stringify(savedCaptureMetadata);
  const before = JSON.stringify(current);
  if (Buffer.byteLength(originalInput, "utf8") > 128 * 1024 || Buffer.byteLength(before, "utf8") > 2 * 1024 * 1024) {
    throw new SavedCaptureRestoreError("The saved capture or audit record is too large for this recovery.", 400);
  }
  let verified;
  try {
    verified = await verifySavedFirstObservationHtmlCapture({
      request: current,
      captureMetadata: savedCaptureMetadata,
      bucket: appConfig.r2Bucket,
      config: {
        bucket: appConfig.r2Bucket,
        endpoint: appConfig.r2Endpoint || `https://${appConfig.r2AccountId}.r2.cloudflarestorage.com`,
        accessKeyId: appConfig.r2AccessKeyId,
        secretAccessKey: appConfig.r2SecretAccessKey,
      },
    });
  } catch (error) {
    if (error instanceof IntakeArtifactRetentionError) {
      // Do not disclose object keys, account/store identities or supplied data.
      throw new SavedCaptureRestoreError("The original saved capture could not be verified. Nothing was changed.");
    }
    throw error;
  }
  if (!verified) {
    throw new SavedCaptureRestoreError("The original saved capture could not be verified. Nothing was changed.");
  }
  if (JSON.stringify(current) !== before || JSON.stringify(savedCaptureMetadata) !== originalInput) {
    throw new SavedCaptureRestoreError("The recovery inputs changed during verification. Nothing was changed.");
  }
  const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const audit = {
    schema: "awardping.saved-first-observation-restore.v1",
    restored_at: now,
    restored_by: actor,
    previous_request: current,
    previous_request_sha256: digest(current),
    supplied_original_capture_metadata: savedCaptureMetadata,
    supplied_original_capture_metadata_sha256: digest(savedCaptureMetadata),
    digest_encoding: "canonical-json-recursive-sorted-object-keys-v1",
    evidence: verified.evidence,
    projection: "sealed_core_only_not_full_original_metadata",
    creates_api_charge: false,
    queues_review: false,
    approves_source: false,
    publishes_update: false,
  };
  const captureMetadata = { ...verified.capture, saved_first_observation_restore: audit };
  if (Buffer.byteLength(JSON.stringify(captureMetadata), "utf8") > 3 * 1024 * 1024) {
    throw new SavedCaptureRestoreError("The complete recovery audit cannot be retained safely. Nothing was changed.", 400);
  }
  return {
    status: "needs_manual_review",
    status_reason: SAVED_FIRST_OBSERVATION_RESTORED_REASON,
    updated_at: now,
    capture_metadata: JSON.parse(JSON.stringify(captureMetadata)) as Json,
    // captureFromRow reads this column ahead of capture.links. The old failed
    // links remain in previous_request, but must not become new AI input.
    discovered_links: { links: [], pdf_links: [] },
  };
}

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sort(item)])) : entry;
  return JSON.stringify(sort(value));
}
