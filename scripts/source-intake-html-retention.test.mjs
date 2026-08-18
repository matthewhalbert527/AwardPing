import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  retainFirstObservationIntakeArtifact,
  requiresFirstObservationArtifactRetention,
  serializableRetainedCaptureMetadata,
  validateRetainedIntakeArtifactManifest,
} from "./lib/intake-artifact-retention.mjs";
import {
  captureIntakePage,
  deterministicSourceIntakeReview,
  sourceIntakeCaptureDisposition,
} from "./lib/source-intake.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("low-coverage HTML source intake retention", () => {
  it("captures exact HTML bytes, verifies them in R2, and reaches ai_review_pending", async () => {
    const request = {
      id: "11111111-1111-4111-8111-111111111111",
      award_name: "Marshall Scholarship",
      acquisition_kind: "admin_intake",
      notification_mode: "manual_review",
      onboarding_batch_id: "low-coverage-source-backfill-v1",
    };
    const url = "https://example.edu/marshall/apply/eligibility";
    const canonicalUrl = "https://example.edu/marshall/apply";
    const html = Buffer.from([
      "<!doctype html>",
      `<html><head><title>Marshall Scholarship Eligibility</title><link rel="canonical" href="${canonicalUrl}"></head>`,
      "<body><main><h1>Marshall Scholarship Eligibility</h1>",
      "<p>This nationally competitive scholarship accepts applications from eligible students.</p>",
      "<p>Review the application deadline and apply through the official program.</p>",
      "</main></body></html>",
    ].join(""), "utf8");
    const capture = await captureIntakePage(url, {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response(html, {
        status: 200,
        headers: { "content-type": 'text/html; charset="utf-8"' },
      }),
    });

    expect(capture.capture_method).toBe("fetch_html");
    expect(capture.artifact_bytes).toEqual(html);
    expect(capture.byte_length).toBe(html.length);
    expect(capture.capture_file_hash).toBe(sha256(html));
    expect(Object.keys(capture)).not.toContain("artifact_bytes");
    expect(JSON.stringify(capture)).not.toContain("artifact_bytes");

    await expect(retainFirstObservationIntakeArtifact({
      request,
      capture: { ...capture },
      archiveRoot: temporaryRoot(),
      bucket: "awardping-snapshots",
      client: memoryR2(),
      config: { storeId: "test-account.r2.local" },
    })).rejects.toMatchObject({ code: "intake_artifact_bytes_unavailable" });

    const deterministicReview = deterministicSourceIntakeReview({
      url: capture.canonical_url || capture.final_url,
      title: capture.title,
      text: capture.text,
      requestedAwardName: request.award_name,
      contentType: capture.content_type,
    });
    expect(deterministicReview.status).toBe("plausible");
    expect(requiresFirstObservationArtifactRetention(request, capture)).toBe(true);

    const root = temporaryRoot();
    const r2 = memoryR2();
    const retainedArtifact = await retainFirstObservationIntakeArtifact({
      request,
      capture,
      archiveRoot: root,
      bucket: "awardping-snapshots",
      client: r2,
      config: { storeId: "test-account.r2.local" },
    });
    const captureMetadata = serializableRetainedCaptureMetadata(capture, retainedArtifact);
    const disposition = sourceIntakeCaptureDisposition(deterministicReview, "batch");

    expect(disposition).toEqual({
      status: "ai_review_pending",
      status_reason: "ready_for_gemini_batch_review",
    });
    expect(captureMetadata).toMatchObject({
      capture_file_hash: sha256(html),
      byte_length: html.length,
      retained_artifact: {
        request_id: request.id,
        file_hash: sha256(html),
        response_final_url: url,
        canonical_url: canonicalUrl,
        document_kind: "html",
        document_content_type: 'text/html; charset="utf-8"',
        r2_verified_at: expect.stringMatching(/Z$/),
      },
    });
    expect(JSON.stringify(captureMetadata)).not.toContain("artifact_bytes");
    expect(validateRetainedIntakeArtifactManifest(retainedArtifact, {
      requestId: request.id,
      fileHash: capture.capture_file_hash,
      finalUrl: capture.canonical_url || capture.final_url,
      requireR2Verified: true,
    })).toMatchObject({
      document_kind: "html",
      document_content_type: 'text/html; charset="utf-8"',
      response_final_url: url,
      canonical_url: canonicalUrl,
    });
    expect(r2.objects.get(retainedArtifact.artifacts.pdf.key)).toMatchObject({
      body: html,
      contentType: 'text/html; charset="utf-8"',
    });
    expect(r2.puts).toBe(3);
    expect(r2.gets).toBe(3);
  });

  it("wires verified retention into the worker before the AI-pending transition", () => {
    const worker = readFileSync(
      new URL("./process-source-intake-requests.mjs", import.meta.url),
      "utf8",
    );
    const stage = worker.slice(
      worker.indexOf("async function processCaptureStage"),
      worker.indexOf("async function submitPendingAiRequests"),
    );
    const retention = stage.indexOf("await retainFirstObservationIntakeArtifact({");
    const disposition = stage.indexOf("sourceIntakeCaptureDisposition(deterministicReview, geminiApiMode)");
    const transition = stage.indexOf("status: captureDisposition.status", disposition);

    expect(retention).toBeGreaterThan(-1);
    expect(disposition).toBeGreaterThan(retention);
    expect(transition).toBeGreaterThan(disposition);
  });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "awardping-html-intake-"));
  roots.push(root);
  return root;
}

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    puts: 0,
    gets: 0,
    async send(command) {
      const input = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        this.puts += 1;
        if (objects.has(input.Key)) {
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
