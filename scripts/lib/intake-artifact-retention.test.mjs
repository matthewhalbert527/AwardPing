import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildInitialOfficialDocumentCandidate } from "./initial-official-document.mjs";
import {
  POST_RETENTION_CAPTURE_FAILURE_REASON,
  materializeFirstObservationCaptureFromAcquisition,
  persistPostRetentionCaptureFailure,
  restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition,
  retainFirstObservationIntakePdfArtifact,
  resumeFirstObservationIntakeArtifactRetention,
  serializableRetainedCaptureMetadata,
  validateRetainedIntakeArtifactManifest,
} from "./intake-artifact-retention.mjs";
import { buildVisualSnapshotRef } from "./visual-review-queue.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const acquisitionId = "33333333-3333-4333-8333-333333333333";
const awardId = "44444444-4444-4444-8444-444444444444";
const finalUrl = "https://example.edu/2027-guidance.pdf";
const capturedAt = "2026-07-16T18:00:00.000Z";
const exactText = "Applications are due March 15, 2027.";
const testStore = { storeId: "test-account.r2.local" };
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("immutable source-intake PDF retention", () => {
  it("retains and read-verifies exact request/hash-bound PDF, text, and metadata", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const pdfA = Buffer.from("%PDF-1.4 reviewed hash A");
    const manifest = await retain(root, r2, pdfA);

    expect(manifest.prefix).toBe(
      `source-intake-first-observation/v1/requests/${requestId}/sha256/${sha256(pdfA)}`,
    );
    expect(manifest.artifacts.pdf).toMatchObject({
      key: `${manifest.prefix}/document.pdf`,
      sha256: sha256(pdfA),
      byte_length: pdfA.length,
      content_type: "application/pdf",
    });
    expect(manifest.r2_verified_at).toMatch(/Z$/);
    expect([...r2.objects.keys()].sort()).toEqual([
      `${manifest.prefix}/capture.json`,
      `${manifest.prefix}/document.pdf`,
      `${manifest.prefix}/text.txt`,
    ]);
    expect(r2.puts).toBe(3);
    expect(r2.gets).toBe(3);

    // A retry receives 412 for every immutable object and succeeds only after
    // reading and verifying the already-stored bytes and provenance metadata.
    const retried = await retain(root, r2, pdfA);
    expect(retried.file_hash).toBe(manifest.file_hash);
    expect(r2.preconditions).toBe(3);
    expect(r2.gets).toBe(6);
  });

  it("stages hash A locally on R2 failure, then resumes A without recapturing URL hash B", async () => {
    const root = temporaryRoot();
    const pdfA = Buffer.from("%PDF-1.4 accepted review hash A");
    const pdfB = Buffer.from("%PDF-1.4 live URL now serves hash B");
    let staged;

    try {
      await retainFirstObservationIntakePdfArtifact({
        request: liveRequest(),
        capture: pdfCapture(pdfA),
        archiveRoot: root,
        bucket: "awardping-snapshots",
        config: {},
      });
    } catch (error) {
      staged = error.details?.staged_manifest;
      expect(error.code).toBe("intake_r2_configuration_missing");
    }
    expect(staged.file_hash).toBe(sha256(pdfA));
    expect(staged.r2_verified_at).toBeNull();
    expect(sha256(pdfB)).not.toBe(staged.file_hash);

    const r2 = memoryR2();
    const completed = await resumeFirstObservationIntakeArtifactRetention({
      stagedManifest: staged,
      archiveRoot: root,
      bucket: "awardping-snapshots",
      client: r2,
      config: testStore,
    });
    const acquisition = sealedAcquisition(completed);
    const capture = await materializeFirstObservationCaptureFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      bucket: "awardping-snapshots",
      client: r2,
      config: testStore,
    });

    expect(readFileSync(capture.pdf_path)).toEqual(pdfA);
    expect(capture.file_hash).toBe(sha256(pdfA));
    expect(capture.file_hash).not.toBe(sha256(pdfB));
    expect(buildInitialOfficialDocumentCandidate({
      acquisition,
      review: acquisition.review_seal,
      source: source(),
      capture,
    })).toMatchObject({
      eligible: true,
      reviewed_capture_file_sha256: sha256(pdfA),
      deterministic_diff: { reason: "new_official_document_first_observed" },
    });
  });

  it("rehydrates a missing local cache from exact R2 and refuses cross-request or tampered keys", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const pdfA = Buffer.from("%PDF-1.4 retained A");
    const manifest = await retain(root, r2, pdfA);
    const acquisition = sealedAcquisition(manifest);
    rmSync(join(root, "intake-artifacts"), { recursive: true, force: true });

    const capture = await materializeFirstObservationCaptureFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      bucket: "awardping-snapshots",
      client: r2,
      config: testStore,
    });
    expect(capture.intake_artifact_local_cache_rehydrated).toBe(true);
    expect(readFileSync(capture.pdf_path)).toEqual(pdfA);

    expect(() => validateRetainedIntakeArtifactManifest(manifest, {
      requestId: "55555555-5555-4555-8555-555555555555",
    })).toThrow(/another source-intake request/);
    const tampered = structuredClone(manifest);
    tampered.artifacts.pdf.key =
      `source-intake-first-observation/v1/requests/55555555-5555-4555-8555-555555555555/sha256/${manifest.file_hash}/document.pdf`;
    expect(() => validateRetainedIntakeArtifactManifest(tampered)).toThrow(/outside the immutable request namespace/);
  });

  it("reproduces candidate-local meta byte-for-byte from acquisition R2 after all local copies disappear", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const pdfA = Buffer.from("%PDF-1.4 candidate recovery A");
    const manifest = await retain(root, r2, pdfA);
    const acquisition = sealedAcquisition(manifest);
    const firstCapture = await materializeFirstObservationCaptureFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      bucket: "awardping-snapshots",
      client: r2,
      config: testStore,
    });
    const snapshotRef = buildVisualSnapshotRef(
      firstCapture,
      (path) => relative(root, path).replace(/\\/g, "/"),
    );
    const candidate = {
      id: "66666666-6666-4666-8666-666666666666",
      candidate_scope: "initial_official_document",
      source_acquisition_id: acquisition.id,
      new_file_hash: firstCapture.file_hash,
      new_text_hash: firstCapture.text_hash,
      new_snapshot_ref: snapshotRef,
      prompt_payload: {
        hashes: {
          new_file_hash: firstCapture.file_hash,
          new_text_hash: firstCapture.text_hash,
        },
      },
    };
    const originalMeta = readFileSync(firstCapture.meta_path);
    rmSync(join(root, "sources", sourceId), { recursive: true, force: true });
    rmSync(join(root, "intake-artifacts"), { recursive: true, force: true });

    const result = await restoreInitialOfficialDocumentCandidateArtifactsFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      candidate,
      bucket: "awardping-snapshots",
      client: r2,
      config: testStore,
    });

    expect(result).toMatchObject({
      restored: true,
      reason: "exact_acquisition_intake_artifact_restored",
    });
    expect(readFileSync(firstCapture.pdf_path)).toEqual(pdfA);
    expect(readFileSync(firstCapture.meta_path)).toEqual(originalMeta);
  });

  it("refuses a 412 collision when the existing R2 object is not the exact retained artifact", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const pdfA = Buffer.from("%PDF-1.4 collision A");
    const manifest = await retain(root, r2, pdfA);
    r2.objects.get(manifest.artifacts.pdf.key).body = Buffer.from("different bytes");

    await expect(retain(root, r2, pdfA)).rejects.toMatchObject({
      code: "intake_r2_verification_failed",
    });
  });

  it("refuses an exact-body collision with wrong content type or request provenance", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const pdfA = Buffer.from("%PDF-1.4 collision provenance A");
    const manifest = await retain(root, r2, pdfA);
    const stored = r2.objects.get(manifest.artifacts.pdf.key);
    stored.contentType = "application/octet-stream";
    await expect(retain(root, r2, pdfA)).rejects.toMatchObject({
      code: "intake_r2_verification_failed",
    });

    stored.contentType = "application/pdf";
    stored.metadata.request_id = "55555555-5555-4555-8555-555555555555";
    await expect(retain(root, r2, pdfA)).rejects.toMatchObject({
      code: "intake_r2_verification_failed",
    });
  });

  it("refuses bucket or account/store drift before reading retained bytes", async () => {
    const root = temporaryRoot();
    const r2 = memoryR2();
    const manifest = await retain(root, r2, Buffer.from("%PDF-1.4 store binding A"));
    const acquisition = sealedAcquisition(manifest);
    await expect(materializeFirstObservationCaptureFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      bucket: "different-bucket",
      client: r2,
      config: testStore,
    })).rejects.toMatchObject({ code: "intake_artifact_r2_target_mismatch" });
    await expect(materializeFirstObservationCaptureFromAcquisition({
      archiveRoot: root,
      source: source(),
      acquisition,
      bucket: "awardping-snapshots",
      client: r2,
      config: { storeId: "different-account.r2.local" },
    })).rejects.toMatchObject({ code: "intake_artifact_r2_target_mismatch" });
  });

  it("refuses a cache ancestor that redirects outside the archive root", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, "intake-artifacts"), { recursive: true });
    try {
      symlinkSync(outside, join(root, "intake-artifacts", "requests"), "junction");
    } catch (error) {
      if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) return;
      throw error;
    }
    await expect(retain(root, memoryR2(), Buffer.from("%PDF-1.4 symlink escape")))
      .rejects.toMatchObject({ code: "intake_local_unsafe_path" });
  });

  it("preserves completed artifact identity when the first metadata write fails immediately after retention", async () => {
    const root = temporaryRoot();
    const capture = {
      ...pdfCapture(Buffer.from("%PDF-1.4 post-retention persistence A")),
      links: ["https://example.edu"],
      pdf_links: [finalUrl],
    };
    const manifest = await retainFirstObservationIntakePdfArtifact({
      request: liveRequest(),
      capture,
      archiveRoot: root,
      bucket: "awardping-snapshots",
      client: memoryR2(),
      config: testStore,
    });
    const captureMetadata = serializableRetainedCaptureMetadata(capture, manifest);
    const writes = [];
    const persist = async (patch) => {
      writes.push(patch);
      if (writes.length === 1) throw new Error("injected first capture_metadata write failure");
      return { id: requestId, ...patch };
    };

    let recovery;
    try {
      await persist({ capture_metadata: captureMetadata });
    } catch (processingError) {
      recovery = await persistPostRetentionCaptureFailure({
        persist,
        captureMetadata,
        discoveredLinks: { links: capture.links, pdf_links: capture.pdf_links },
        processingError,
        now: "2026-07-16T18:05:00.000Z",
      });
    }

    expect(recovery).toMatchObject({ persisted: true });
    expect(recovery.patch).toMatchObject({
      status: "needs_manual_review",
      status_reason: POST_RETENTION_CAPTURE_FAILURE_REASON,
      capture_metadata: {
        capture_file_hash: manifest.file_hash,
        retained_artifact: {
          request_id: requestId,
          file_hash: manifest.file_hash,
          prefix: manifest.prefix,
        },
      },
    });
    expect(JSON.stringify(recovery.patch.capture_metadata)).not.toContain("artifact_bytes");
    expect(recovery.patch.discovered_links.pdf_links).toEqual([finalUrl]);
  });

  it("reports staged-manifest persistence as unproven so stale recovery can block URL refetch", async () => {
    const root = temporaryRoot();
    const capture = pdfCapture(Buffer.from("%PDF-1.4 staged persistence A"));
    let retentionError;
    try {
      await retainFirstObservationIntakePdfArtifact({
        request: liveRequest(),
        capture,
        archiveRoot: root,
        bucket: "awardping-snapshots",
        config: {},
      });
    } catch (error) {
      retentionError = error;
    }
    const staged = retentionError.details.staged_manifest;
    const captureMetadata = {
      ...serializableRetainedCaptureMetadata(capture, null),
      retained_artifact_staged: staged,
    };
    const recovery = await persistPostRetentionCaptureFailure({
      persist: async () => {
        throw new Error("injected staged-manifest quarantine persistence failure");
      },
      captureMetadata,
      processingError: retentionError,
      statusReason: retentionError.code,
      solution: retentionError.solution,
    });

    expect(recovery.persisted).toBe(false);
    expect(recovery.persistenceError.message).toContain("injected staged-manifest");
    expect(recovery.patch.capture_metadata.retained_artifact_staged).toMatchObject({
      request_id: requestId,
      file_hash: staged.file_hash,
      prefix: staged.prefix,
    });
  });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "awardping-intake-artifact-"));
  roots.push(root);
  return root;
}

function liveRequest() {
  return {
    id: requestId,
    acquisition_kind: "live_discovery",
    notification_mode: "first_capture_candidate",
    onboarding_batch_id: null,
  };
}

function pdfCapture(pdf) {
  const capture = {
    artifact_bytes: pdf,
    capture_file_hash: sha256(pdf),
    byte_length: pdf.length,
    captured_at: capturedAt,
    final_url: finalUrl,
    canonical_url: finalUrl,
    content_type: "application/pdf",
    status_code: 200,
    title: "2027 Application Guidance",
    page_count: 1,
    pdf_text_error: null,
    text: exactText,
  };
  return capture;
}

async function retain(root, r2, pdf) {
  return retainFirstObservationIntakePdfArtifact({
    request: liveRequest(),
    capture: pdfCapture(pdf),
    archiveRoot: root,
    bucket: "awardping-snapshots",
    client: r2,
    config: testStore,
  });
}

function source() {
  return {
    id: sourceId,
    shared_award_id: awardId,
    url: finalUrl,
    title: "2027 Application Guidance",
    page_type: "pdf",
  };
}

function sealedAcquisition(manifest) {
  const reviewSeal = {
    schema_version: 1,
    sealed: true,
    status: "accepted",
    award_relevance: "primary",
    source_relevance: "primary",
    cycle_relevance: "current_or_upcoming",
    officialness: "official",
    confidence: "high",
    page_type: "pdf",
    evidence_quotes: [exactText],
    exact_evidence_verified: true,
    capture_file_hash: manifest.file_hash,
    capture_final_url: finalUrl,
    capture_captured_at: capturedAt,
    retained_artifact: manifest,
  };
  return {
    id: acquisitionId,
    shared_award_source_id: sourceId,
    acquisition_kind: "live_discovery",
    notification_mode: "first_capture_candidate",
    origin_source_page_request_id: requestId,
    review_seal: reviewSeal,
    metadata: {
      retained_artifact: manifest,
      server_artifact_binding: {
        source_id: sourceId,
        acquisition_id: acquisitionId,
        request_id: requestId,
        file_hash: manifest.file_hash,
        final_url: finalUrl,
        artifact_prefix: manifest.prefix,
      },
    },
  };
}

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    puts: 0,
    gets: 0,
    preconditions: 0,
    async send(command) {
      const input = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        this.puts += 1;
        if (objects.has(input.Key)) {
          this.preconditions += 1;
          const error = new Error("Precondition failed");
          error.name = "PreconditionFailed";
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        objects.set(input.Key, {
          body: Buffer.from(input.Body),
          metadata: { ...input.Metadata },
          contentType: input.ContentType,
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        this.gets += 1;
        const stored = objects.get(input.Key);
        if (!stored) throw new Error("NoSuchKey");
        return {
          Body: Buffer.from(stored.body),
          ContentLength: stored.body.length,
          ContentType: stored.contentType,
          Metadata: { ...stored.metadata },
        };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
