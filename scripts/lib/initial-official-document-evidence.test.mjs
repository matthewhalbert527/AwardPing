import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInitialOfficialDocumentCandidate } from "./initial-official-document.mjs";
import {
  PUBLISHED_VISUAL_EVIDENCE_PREFIX,
  preparePublishedInitialOfficialDocumentEvidence,
} from "./visual-event-evidence.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

const temporary = [];

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

describe("initial official document permanent evidence", () => {
  it("retains a first-observation attestation and the real current PDF without inventing a prior document", async () => {
    const fixture = createFixture();
    const store = memoryStore();

    const evidence = await preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: store,
      now: "2026-07-16T14:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      evidence_status: "not_applicable_new_document",
      source_acquisition_id: "acquisition-1",
      previous_capture: {
        full: null,
        crop: null,
        kind: "first_observation_attestation",
        state_id: "first-observation",
        metadata: {
          sha256: fixture.attestation.sha256,
          content_type: "application/json; charset=utf-8",
        },
        capture_hashes: {
          file_hash: fixture.attestation.sha256,
          attestation_hash: fixture.attestation.sha256,
          attestation_sha256: fixture.attestation.sha256,
        },
      },
      current_capture: {
        kind: "pdf",
        state_id: "document",
        full: { sha256: fixture.pdfHash, content_type: "application/pdf" },
      },
      localization: {
        direction: "added",
        sides: {
          previous: {
            status: "not_applicable_first_observation",
            required: false,
          },
          current: { status: "not_applicable_pdf", required: false },
        },
      },
      first_observation_binding: {
        candidate_id: "candidate-initial-1",
        candidate_signature: "candidate-signature-initial-1",
        source_acquisition_id: "acquisition-1",
        first_observation_attestation_sha256: fixture.attestation.sha256,
        current_file_sha256: fixture.pdfHash,
      },
    });
    expect(evidence.previous_capture.metadata.object_key).toContain(
      `${PUBLISHED_VISUAL_EVIDENCE_PREFIX}/candidate-initial-1/previous/first-observation-attestation/`,
    );
    expect(evidence.current_capture.full.object_key).toContain(
      `${PUBLISHED_VISUAL_EVIDENCE_PREFIX}/candidate-initial-1/current/document/`,
    );
    const attestationUpload = store.putCalls.find((item) =>
      item.key === evidence.previous_capture.metadata.object_key
    );
    expect(attestationUpload.body.toString("utf8")).toBe(fixture.attestation.canonical_json);
    expect(store.putCalls).toHaveLength(3);
    expect(store.headCalls).toEqual(store.putCalls.map((item) => item.key));
  });

  it("rejects tampered attestation bytes before any permanent upload", async () => {
    const fixture = createFixture();
    fixture.candidate.prompt_payload.first_observation_attestation.canonical_json =
      `${fixture.attestation.canonical_json} `;
    fixture.candidate.prompt_payload.first_observation_attestation.byte_length += 1;
    const store = memoryStore();

    await expect(preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: store,
    })).rejects.toMatchObject({ code: "first_observation_attestation_hash_mismatch" });
    expect(store.putCalls).toHaveLength(0);
  });

  it("fails closed when the immutable candidate prompt has no attestation", async () => {
    const fixture = createFixture();
    delete fixture.candidate.prompt_payload.first_observation_attestation;
    const store = memoryStore();

    await expect(preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: store,
    })).rejects.toMatchObject({ code: "first_observation_attestation_missing" });
    expect(store.putCalls).toHaveLength(0);
  });

  it("rejects a current PDF hash that disagrees with the candidate-bound capture", async () => {
    const fixture = createFixture();
    fixture.candidate.new_file_hash = "0".repeat(64);
    const store = memoryStore();

    await expect(preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: store,
    })).rejects.toMatchObject({ code: "initial_document_current_hash_mismatch" });
    expect(store.putCalls).toHaveLength(0);
  });

  it("rejects an attestation whose acquisition binding differs from the candidate", async () => {
    const fixture = createFixture();
    fixture.candidate.source_acquisition_id = "different-acquisition";
    const store = memoryStore();

    await expect(preparePublishedInitialOfficialDocumentEvidence({
      candidate: fixture.candidate,
      source: fixture.source,
      archiveRoot: fixture.archiveRoot,
      artifactStore: store,
    })).rejects.toMatchObject({ code: "first_observation_attestation_acquisition_mismatch" });
    expect(store.putCalls).toHaveLength(0);
  });
});

function createFixture() {
  const archiveRoot = mkdtempSync(join(tmpdir(), "awardping-initial-document-evidence-"));
  temporary.push(archiveRoot);
  const captureDirectory = join(archiveRoot, "current");
  mkdirSync(captureDirectory, { recursive: true });
  const pdfPath = join(captureDirectory, "document.pdf");
  const pdf = Buffer.from(
    "%PDF-1.4\nApplicants must submit two letters of recommendation.\n%%EOF\n",
  );
  writeFileSync(pdfPath, pdf);
  const pdfHash = sha(pdf);
  const metaPath = join(captureDirectory, "meta.json");
  writeFileSync(metaPath, JSON.stringify({
    kind: "pdf",
    captured_at: "2026-07-16T12:00:00.000Z",
  }));
  const currentRef = {
    kind: "pdf",
    captured_at: "2026-07-16T12:00:00.000Z",
    file_hash: pdfHash,
    local_paths: {
      pdf: artifactPathRef(pdfPath),
      meta: artifactPathRef(metaPath),
    },
  };
  const manifest = visualSnapshotArtifactManifest(currentRef);
  currentRef.artifact_manifest = manifest;
  currentRef.artifact_manifest_digest = manifest.digest;
  const source = {
    id: "source-1",
    shared_award_id: "award-1",
    url: "https://example.edu/2027-rules.pdf",
  };
  const decision = buildInitialOfficialDocumentCandidate({
    acquisition: {
      id: "acquisition-1",
      notification_mode: "first_capture_candidate",
      review_seal: { capture_file_hash: pdfHash },
    },
    review: {
      id: "review-1",
      sealed: true,
      status: "accepted",
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      confidence: "high",
      evidence_quotes: ["Applicants must submit two letters of recommendation."],
      capture_file_hash: pdfHash,
      capture_final_url: source.url,
    },
    source,
    capture: {
      kind: "pdf",
      captured_at: currentRef.captured_at,
      final_url: source.url,
      file_hash: pdfHash,
      text: "Applicants must submit two letters of recommendation.",
    },
  });
  if (!decision.eligible) throw new Error(`Fixture decision failed: ${decision.reason}`);
  const attestation = decision.first_observation_attestation;
  const candidate = {
    id: "candidate-initial-1",
    candidate_scope: "initial_official_document",
    candidate_signature: "candidate-signature-initial-1",
    shared_award_id: source.shared_award_id,
    shared_award_source_id: source.id,
    source_acquisition_id: "acquisition-1",
    previous_file_hash: attestation.sha256,
    new_file_hash: pdfHash,
    previous_snapshot_ref: {
      kind: "first_observation_attestation",
      attestation_sha256: attestation.sha256,
    },
    new_snapshot_ref: currentRef,
    prompt_payload: {
      first_observation_attestation: structuredClone(attestation),
      hashes: {
        first_observation_attestation_sha256: attestation.sha256,
        previous_file_hash: attestation.sha256,
        new_file_hash: pdfHash,
        new_artifact_manifest_digest: currentRef.artifact_manifest_digest,
      },
    },
  };
  return { archiveRoot, source, candidate, attestation, pdfHash };
}

function memoryStore() {
  const objects = new Map();
  return {
    bucket: "test-bucket",
    putCalls: [],
    headCalls: [],
    async put(value) {
      this.putCalls.push(value);
      objects.set(value.key, value);
    },
    async head({ key }) {
      this.headCalls.push(key);
      const value = objects.get(key);
      return {
        byte_length: value.body.length,
        content_type: value.contentType,
        sha256: value.sha256,
      };
    },
  };
}

function artifactPathRef(path) {
  const body = readFileSync(path);
  return {
    path,
    sha256: sha(body),
    byte_length: body.length,
    bytes: body.length,
  };
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
