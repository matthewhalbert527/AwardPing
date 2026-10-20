import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  retainFirstObservationIntakeArtifact,
  requiresFirstObservationArtifactRetention,
  serializableRetainedCaptureMetadata,
  validateRetainedIntakeArtifactManifest,
  verifySavedFirstObservationHtmlCapture,
  IntakeArtifactRetentionError,
} from "./lib/intake-artifact-retention.mjs";
import * as artifactContract from "./lib/intake-artifact-contract.mjs";
import {
  IntakeArtifactRetentionError as DirectVerificationError,
  verifySavedFirstObservationHtmlCapture as directVerifySavedHtml,
} from "./lib/intake-artifact-r2-verification.mjs";
import {
  captureIntakePage,
  deterministicSourceIntakeReview,
  sourceIntakeCaptureDisposition,
} from "./lib/source-intake.mjs";

const roots = [];

afterEach(() => {
  vi.restoreAllMocks();
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

describe("read-only saved first-observation HTML verification", () => {
  it("preserves all 61 original function/class bodies and nine constant values across the mechanical split", () => {
    const functions = {};
    const declarations = {};
    const constants = {};
    for (const path of ["./lib/intake-artifact-retention.mjs", "./lib/intake-artifact-contract.mjs", "./lib/intake-artifact-r2-verification.mjs"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const node of ast.statements) {
        if (node.name?.text) {
          expect(functions).not.toHaveProperty(node.name.text);
          functions[node.name.text] = sha256(node.body ? node.body.getText(ast) : node.getText(ast));
          declarations[node.name.text] = sha256(node.getText(ast).replace(/^export /, ""));
        }
        if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
          expect(constants).not.toHaveProperty(declaration.name.text);
          constants[declaration.name.text] = sha256(declaration.initializer.getText(ast));
        }
      }
    }
    const digest = (values) => sha256(JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]])));
    // Pinned from the exact pre-factor 18bad991... module, not a private saved capture.
    expect(Object.keys(functions)).toHaveLength(61);
    expect(digest(functions)).toBe("e3555e1e3e5687635c5d78723b9f27c383ff908778af9cf53daeba3b18004514");
    expect(digest(declarations)).toBe("8b50fe22c9d8afe932f32e5bafc9c61001f27405ae132fcbc1572b84dcc7dfdd");
    expect(Object.keys(constants)).toHaveLength(9);
    expect(digest(constants)).toBe("ece88e7869b446d6176b163e03617d9919fd38a951adfcea8d4a48f8094f2f2a");
  });

  it("keeps one error-class identity and the existing worker public API", async () => {
    expect(IntakeArtifactRetentionError).toBe(artifactContract.IntakeArtifactRetentionError);
    expect(DirectVerificationError).toBe(IntakeArtifactRetentionError);
    expect(validateRetainedIntakeArtifactManifest).toBe(artifactContract.validateRetainedIntakeArtifactManifest);
    expect(verifySavedFirstObservationHtmlCapture).toBe(directVerifySavedHtml);
    expect(new DirectVerificationError("fixture", "diagnostic")).toBeInstanceOf(IntakeArtifactRetentionError);
    const constants = JSON.stringify(artifactContract.artifactFiles);
    await directVerifySavedHtml(savedHtmlFixture().options);
    expect(JSON.stringify(artifactContract.artifactFiles)).toBe(constants);
  });

  it("has a filesystem-free application-owned direct-reader import graph, without worker write modules", () => {
    const visited = new Set();
    const pending = [new URL("./lib/intake-artifact-r2-verification.mjs", import.meta.url)];
    while (pending.length) {
      const url = pending.pop();
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      const source = readFileSync(url, "utf8");
      expect(source).not.toMatch(/node:(?:fs|path)|PutObjectCommand|intake-artifact-retention\.mjs/);
      const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const node of ast.statements) if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier?.text;
        if (!specifier) continue;
        if (specifier.startsWith(".")) pending.push(new URL(specifier, url));
        else expect(["node:crypto", "@aws-sdk/client-s3"]).toContain(specifier);
      }
    }
    expect([...visited].sort()).toEqual([
      "./lib/intake-artifact-r2-verification.mjs", "./lib/intake-artifact-contract.mjs", "./lib/source-intake-terminal-response.mjs",
    ].map((path) => new URL(path, import.meta.url).href).sort());
    // External SDK internals are not claimed to be an I/O sandbox by this local graph check.
  });

  it("verifies exactly three original objects and returns only their sealed core", async () => {
    const f = savedHtmlFixture();
    const before = JSON.stringify({ request: f.request, original: f.original });
    const snapshots = [...f.r2.objects].map(([key, value]) => [key, Buffer.from(value.body)]);
    const result = await verifySavedFirstObservationHtmlCapture(f.options);
    expect(result.capture).toEqual({
      ok: true, status_code: 200, title: "Scholarship language requirements", text: f.text,
      page_description: null, content_type: "text/html; charset=utf-8", byte_length: f.html.length,
      captured_at: f.original.captured_at, capture_file_hash: sha256(f.html),
      canonical_url: f.url, final_url: f.responseUrl, page_count: null, pdf_text_error: null,
      links: [], pdf_links: [], retained_artifact: f.original.retained_artifact,
      text_excerpt: f.text, text_length: f.text.length,
    });
    expect(result.capture.captured_at).not.toBe(f.request.capture_metadata.captured_at);
    expect(result.capture).not.toHaveProperty("facts");
    expect(result.capture).not.toHaveProperty("artifact_bytes");
    expect(result.evidence).toMatchObject({
      schema: "awardping.saved-first-observation-html-verification.v1", request_id: f.request.id,
      original_metadata_reproduced: false, projection: "sealed_core_only", creates_api_charge: false,
      refetches_page: false, mutates_storage: false, queues_review: false, source_approval: false, publishable: false,
    });
    expect(Object.keys(result.evidence.verified_artifacts)).toEqual(["pdf", "text", "capture_metadata"]);
    expect(f.r2.gets).toBe(3);
    expect(f.r2.puts).toBe(0);
    expect(JSON.stringify({ request: f.request, original: f.original })).toBe(before);
    for (const [key, body] of snapshots) expect(f.r2.objects.get(key).body).toEqual(body);
  });

  it("uses only exact manifest GET keys and one shared bounded-read signal", async () => {
    const f = savedHtmlFixture();
    const calls = [];
    await verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: async (command, options) => {
      calls.push({ command, options });
      return f.r2.send(command);
    } });
    expect(calls.map(({ command }) => command.constructor.name)).toEqual(Array(3).fill("GetObjectCommand"));
    expect(calls.map(({ command }) => command.input)).toEqual(Object.values(f.original.retained_artifact.artifacts)
      .map(({ key }) => ({ Bucket: "awardping-snapshots", Key: key })));
    expect(calls.every(({ command }) => Object.keys(command.input).join(",") === "Bucket,Key")).toBe(true);
    expect(calls.every(({ options }) => options.abortSignal === calls[0].options.abortSignal)).toBe(true);
    expect(calls[0].options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses the original producer's MIME canonicalization without changing the supplied original", async () => {
    const f = savedHtmlFixture();
    f.original.content_type = "text/html; charset=UTF-8";
    const before = JSON.stringify(f.original);
    const result = await verifySavedFirstObservationHtmlCapture(f.options);
    expect(result.capture.content_type).toBe("text/html; charset=utf-8");
    expect(f.original.content_type).toBe("text/html; charset=UTF-8");
    expect(JSON.stringify(f.original)).toBe(before);
    expect(result.capture.captured_at).toBe(f.original.captured_at);
    expect(f.r2.gets).toBe(3);
    expect(f.r2.puts).toBe(0);
  });

  it("treats only null, missing or plain empty manifest objects as absent claims", async () => {
    for (const value of [undefined, null, {}, Object.create(null)]) {
      const f = savedHtmlFixture();
      f.original.retained_artifact_staged = value;
      f.request.capture_metadata.retained_artifact_staged = value;
      f.request.capture_metadata.retained_artifact = value;
      const result = await verifySavedFirstObservationHtmlCapture(f.options);
      expect(result.capture.captured_at).toBe(f.original.captured_at);
      expect(f.r2.gets).toBe(3);
      expect(f.r2.puts).toBe(0);
    }
  });

  it("verifies the saved capture despite precisely bound terminal MAX_TOKENS markers, without changing that failed review", async () => {
    const f = savedHtmlFixture();
    f.request.capture_metadata.retained_artifact_staged = {};
    f.request.ai_review = savedHtmlTerminalFailure(f);
    const before = JSON.stringify(f.request.ai_review);
    const result = await verifySavedFirstObservationHtmlCapture(f.options);
    expect(result.capture.captured_at).toBe(f.original.captured_at);
    expect(result.evidence.queues_review).toBe(false);
    expect(result.evidence.creates_api_charge).toBe(false);
    expect(JSON.stringify(f.request.ai_review)).toBe(before);
    expect(f.r2.gets).toBe(3);
    expect(f.r2.puts).toBe(0);
  });

  it.each([
    ["different batch", (f) => { f.request.ai_review.possible_external_batch_name = "batches/other"; }],
    ["different attempt", (f) => { f.request.ai_review.gemini_spend_attempt_token = "22222222-2222-4222-8222-222222222222"; }],
    ["different input body", (f) => { f.request.ai_review.provider_input_binding.retained_capture_sha256 = "a".repeat(64); }],
    ["missing response", (f) => { delete f.request.ai_review.provider_response; }],
    ["conflicting finish", (f) => { f.request.ai_review.provider_response.candidates[0].finish_reason = "STOP"; }],
    ["blocked response", (f) => { f.request.ai_review.provider_response.promptFeedback = { blockReason: "SAFETY" }; }],
    ["failed closed", (f) => { f.request.ai_review.submission_claim_failed_closed_at = "2026-10-19T01:00:00.000Z"; }],
    ["worker still owns request", (f) => { f.request.worker_run_id = "worker"; }],
    ["top-level new submission claim", (f) => { f.request.submission_claim_token = "new"; }],
    ["publication claim", (f) => { f.request.ai_review.publication_claim_token = "new"; }],
  ])("keeps %s held even beside a MAX_TOKENS response", async (_name, mutate) => {
    const f = savedHtmlFixture();
    f.request.ai_review = savedHtmlTerminalFailure(f);
    mutate(f);
    const before = JSON.stringify(f.request.ai_review);
    await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({ code: "saved_capture_restore_request_not_idle" });
    expect(JSON.stringify(f.request.ai_review)).toBe(before);
    expect(f.r2.gets).toBe(0);
    expect(f.r2.puts).toBe(0);
  });

  it.each(["", "staged", [], 0, false, { schema_version: 1 }].map((value) => [value]))("does not treat malformed/nonempty staged %j as absent", async (value) => {
    for (const side of ["original", "current"]) {
      const f = savedHtmlFixture();
      (side === "original" ? f.original : f.request.capture_metadata).retained_artifact_staged = value;
      await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({ code: "saved_capture_restore_original_manifest_required" });
      expect(f.r2.gets).toBe(0);
      expect(f.r2.puts).toBe(0);
    }
  });

  it.each([
    ["wrong request", (f) => { f.request.id = "22222222-2222-4222-8222-222222222222"; }],
    ["different body", (f) => { f.request.capture_metadata.capture_file_hash = "a".repeat(64); }],
    ["different canonical URL", (f) => { f.request.capture_metadata.canonical_url += "/other"; }],
    ["different response URL", (f) => { f.request.capture_metadata.final_url += "/other"; }],
    ["missing original manifest", (f) => { delete f.original.retained_artifact; }],
    ["staged original", (f) => { f.original.retained_artifact_staged = f.original.retained_artifact; }],
    ["staged current", (f) => { f.request.capture_metadata.retained_artifact_staged = f.original.retained_artifact; }],
    ["already completed current", (f) => { f.request.capture_metadata.retained_artifact = f.original.retained_artifact; }],
    ["unverified manifest", (f) => { f.original.retained_artifact.r2_verified_at = null; }],
    ["different bucket", (f) => { f.options.bucket = "other-bucket"; }],
    ["different store", (f) => { f.options.config.storeId = "other.r2.local"; }],
    ["missing store", (f) => { f.options.config = {}; }],
    ["wrong artifact key", (f) => { f.original.retained_artifact.artifacts.text.key += "/other"; }],
    ["non HTML capture", (f) => { f.original.capture_method = "fetch_pdf_text"; }],
    ["non HTML current", (f) => { f.request.capture_metadata.capture_method = "fetch_pdf_text"; }],
    ["extra artifact", (f) => { f.original.retained_artifact.artifacts.extra = {}; }],
    ["HTML size bound", (f) => { f.original.retained_artifact.artifacts.pdf.byte_length = 20 * 1024 * 1024 + 1; f.original.retained_artifact.file_bytes = 20 * 1024 * 1024 + 1; }],
    ["text size bound", (f) => { f.original.retained_artifact.artifacts.text.byte_length = 2 * 1024 * 1024 + 1; }],
    ["metadata size bound", (f) => { f.original.retained_artifact.artifacts.capture_metadata.byte_length = 256 * 1024 + 1; }],
    ["non HTML manifest", (f) => { f.original.retained_artifact.document_content_type = "application/pdf"; f.original.retained_artifact.document_kind = "pdf"; f.original.retained_artifact.artifacts.pdf.content_type = "application/pdf"; }],
  ])("holds %s before reading storage", async (_name, mutate) => {
    const f = savedHtmlFixture();
    mutate(f);
    await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({
      name: "IntakeArtifactRetentionError", code: expect.stringMatching(/^saved_capture_restore_/),
    });
    expect(f.r2.gets).toBe(0);
    expect(f.r2.puts).toBe(0);
  });

  it.each([
    ["wrong status", (f) => { f.request.status = "added"; }],
    ["wrong held reason", (f) => { f.request.status_reason = "missing_evidence_quotes"; }],
    ["worker claim", (f) => { f.request.worker_run_id = "worker"; }],
    ["missing worker state", (f) => { delete f.request.worker_run_id; }],
    ["submission claim", (f) => { f.request.ai_review.submission_claim_token = "claim"; }],
    ["publication claim", (f) => { f.request.publication_claim_token = "claim"; }],
    ["creating batch", (f) => { f.request.ai_review.status = "creating"; }],
    ["submitted batch", (f) => { f.request.ai_review.gemini_batch_name = "batches/active"; }],
    ["ambiguous batch", (f) => { f.request.ai_review.possible_external_batch_name = "batches/unknown"; }],
    ["failed closed claim", (f) => { f.request.ai_review.submission_claim_failed_closed_at = "2026-10-19T00:00:00.000Z"; }],
    ["malformed AI state", (f) => { f.request.ai_review = []; }],
  ])("refuses %s without a read or mutation", async (_name, mutate) => {
    const f = savedHtmlFixture();
    mutate(f);
    await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({ code: "saved_capture_restore_request_not_idle" });
    expect(f.r2.gets).toBe(0);
    expect(f.r2.puts).toBe(0);
  });

  it.each([
    ["original timestamp", (f) => { f.original.captured_at = f.request.capture_metadata.captured_at; }],
    ["original text", (f) => { f.original.text += " altered"; }],
    ["original title", (f) => { f.original.title = "Different award"; }],
    ["original status", (f) => { f.original.status_code = 201; }],
    ["original type", (f) => { f.original.content_type = "text/html"; }],
    ["original length", (f) => { f.original.byte_length += 1; }],
    ["original excerpt", (f) => { f.original.text_excerpt += " altered"; }],
    ["original text length", (f) => { f.original.text_length += 1; }],
    ["original failed response", (f) => { f.original.ok = false; }],
    ["original PDF page count", (f) => { f.original.page_count = 2; }],
    ["original PDF error", (f) => { f.original.pdf_text_error = "unparsed"; }],
  ])("rejects mismatched %s against the sealed objects", async (_name, mutate) => {
    const f = savedHtmlFixture();
    mutate(f);
    await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({ code: "saved_capture_restore_original_core_mismatch" });
    expect(f.r2.gets).toBe(3);
    expect(f.r2.puts).toBe(0);
  });

  it.each(["pdf", "text", "capture_metadata"])("holds missing/corrupt %s without replacing it", async (role) => {
    for (const kind of ["missing", "corrupt", "provenance", "content-type", "length"]) {
      const f = savedHtmlFixture();
      const key = f.original.retained_artifact.artifacts[role].key;
      const object = f.r2.objects.get(key);
      if (kind === "missing") f.r2.objects.delete(key);
      if (kind === "corrupt") object.body[0] ^= 1;
      if (kind === "provenance") object.metadata.request_id = "22222222-2222-4222-8222-222222222222";
      if (kind === "content-type") object.contentType = "application/octet-stream";
      if (kind === "length") object.body = Buffer.concat([object.body, Buffer.from("x")]);
      const snapshot = [...f.r2.objects].map(([k, v]) => [k, Buffer.from(v.body)]);
      await expect(verifySavedFirstObservationHtmlCapture(f.options)).rejects.toMatchObject({ code: expect.stringMatching(/^saved_capture_restore_/)});
      expect(f.r2.puts).toBe(0);
      for (const [k, body] of snapshot) expect(f.r2.objects.get(k).body).toEqual(body);
    }
  });

  it("rejects a streamed body immediately on overflow and closes that stream", async () => {
    const f = savedHtmlFixture();
    const destroy = vi.fn();
    const next = vi.fn().mockResolvedValueOnce({ done: false, value: Buffer.alloc(f.html.length) })
      .mockResolvedValueOnce({ done: false, value: Buffer.from("x") });
    const response = await f.r2.send({ constructor: { name: "GetObjectCommand" }, input: { Key: f.original.retained_artifact.artifacts.pdf.key } });
    response.Body = { destroy, [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true }) }) };
    await expect(verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: async () => response }))
      .rejects.toMatchObject({ code: "saved_capture_restore_object_mismatch" });
    expect(next).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(f.r2.puts).toBe(0);
  });

  it("bounds a stalled stream with the same total deadline, without retry", async () => {
    const f = savedHtmlFixture();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const next = vi.fn(() => { entered(); return new Promise(() => {}); });
    const destroy = vi.fn();
    let sends = 0;
    const pending = verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: async () => {
      sends += 1;
      const object = f.r2.objects.get(f.original.retained_artifact.artifacts.pdf.key);
      return { ContentType: object.contentType, Metadata: object.metadata,
        Body: { destroy, [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true }) }) } };
    } });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "saved_capture_restore_read_failed" });
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(sends).toBe(1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not use an unbounded transform-only response body", async () => {
    const f = savedHtmlFixture();
    const transformToByteArray = vi.fn();
    await expect(verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: async () => ({ Body: { transformToByteArray } }) }))
      .rejects.toMatchObject({ code: "saved_capture_restore_read_failed" });
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("also bounds a stalled GET transport that ignores cancellation", async () => {
    const f = savedHtmlFixture();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let sends = 0;
    const pending = verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: () => {
      sends += 1; entered(); return new Promise(() => {});
    } });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "saved_capture_restore_read_failed" });
    expect(sends).toBe(1);
    expect(f.r2.puts).toBe(0);
  });

  it("does not expose echoed secrets, keys or underlying response details", async () => {
    const f = savedHtmlFixture();
    const secret = "API_SECRET_ECHO_DO_NOT_DISCLOSE";
    try {
      await verifySavedFirstObservationHtmlCapture({ ...f.options, sendCommand: async () => { throw new Error(secret); } });
      expect.fail("Expected a verification error");
    } catch (error) {
      expect(error).toMatchObject({ name: "IntakeArtifactRetentionError", code: "saved_capture_restore_read_failed" });
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(f.original.retained_artifact.prefix);
      expect(error).not.toHaveProperty("cause");
    }
  });
});

function savedHtmlFixture() {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const url = "https://example.edu/scholarship/language";
  const responseUrl = `${url}/`;
  const capturedAt = "2026-10-18T21:37:52.551Z";
  const html = Buffer.from("<main><h1>Scholarship language requirements</h1><p>Applicants must meet the language prerequisites.</p></main>");
  const text = "Scholarship language requirements\nApplicants must meet the language prerequisites.";
  const fileHash = sha256(html);
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  const metadata = { schema_version: 1, namespace: "source-intake-first-observation", request_id: requestId,
    captured_at: capturedAt, final_url: url, response_final_url: responseUrl, canonical_url: url,
    content_type: "text/html; charset=utf-8", document_kind: "html", status_code: 200,
    page_title: "Scholarship language requirements", page_count: null, pdf_text_error: null,
    file_hash: fileHash, file_bytes: html.length, text_hash: sha256(text), text_length: text.length,
    files: { pdf: "document.pdf", text: "text.txt", capture_metadata: "capture.json" } };
  const payloads = { pdf: html, text: Buffer.from(`${text}\n`), capture_metadata: Buffer.from(JSON.stringify(metadata)) };
  const types = { pdf: metadata.content_type, text: "text/plain; charset=utf-8", capture_metadata: "application/json" };
  const names = { pdf: "document.pdf", text: "text.txt", capture_metadata: "capture.json" };
  const artifacts = Object.fromEntries(Object.entries(payloads).map(([role, body]) => [role,
    { key: `${prefix}/${names[role]}`, sha256: sha256(body), byte_length: body.length, content_type: types[role] }]));
  const manifest = { schema_version: 1, namespace: "source-intake-first-observation", request_id: requestId,
    captured_at: capturedAt, final_url: url, response_final_url: responseUrl, canonical_url: url, prefix,
    file_hash: fileHash, file_bytes: html.length, document_kind: "html", document_content_type: metadata.content_type,
    text_hash: sha256(text), text_length: text.length, artifacts, r2_bucket: "awardping-snapshots",
    r2_store_id: "test-account.r2.local", r2_verified_at: "2026-10-18T21:37:53.000Z" };
  const original = { ok: true, status_code: 200, title: metadata.page_title, text, page_description: "UNSEALED DESCRIPTION",
    content_type: metadata.content_type, byte_length: html.length, captured_at: capturedAt, capture_file_hash: fileHash,
    canonical_url: url, final_url: responseUrl, page_count: null, pdf_text_error: null, capture_method: "fetch_html",
    text_excerpt: text, text_length: text.length, links: ["UNSEALED LINK"], facts: { invented: true }, retained_artifact: manifest };
  const request = { id: requestId, status: "needs_manual_review", status_reason: "intake_local_conflict", worker_run_id: null,
    ai_review: {}, capture_metadata: { ...original, captured_at: "2026-10-19T19:00:10.011Z", retained_artifact: null } };
  const r2 = memoryR2();
  for (const [role, body] of Object.entries(payloads)) r2.objects.set(artifacts[role].key, {
    body: Buffer.from(body), contentType: types[role], metadata: { sha256: sha256(body), request_id: requestId,
      file_sha256: fileHash, artifact_role: role, namespace: manifest.namespace },
  });
  const options = { request, captureMetadata: original, bucket: manifest.r2_bucket,
    config: { storeId: manifest.r2_store_id }, client: r2 };
  return { request, original, r2, options, html, text, url, responseUrl };
}

function savedHtmlTerminalFailure(f) {
  const claim = "33333333-3333-4333-8333-333333333333";
  return {
    submission_claim_token: claim, gemini_spend_attempt_token: claim,
    gemini_batch_name: "batches/known_one", possible_external_batch_name: "batches/known_one",
    gemini_batch_request_key: f.request.id, provider_batch_returned_at: "2026-10-19T01:00:00.000Z",
    completion_error: "source_intake_provider_incomplete_ai_response", model: "gemini-2.5-flash-lite",
    provider_input_binding: { schema_version: 2, namespace: "source-intake-provider-input-v2", request_id: f.request.id,
      retained_capture_sha256: f.request.capture_metadata.capture_file_hash, digest_sha256: "c".repeat(64), model: "gemini-2.5-flash-lite" },
    provider_response: { modelVersion: "gemini-2.5-flash-lite", candidates: [{ finishReason: "MAX_TOKENS",
      content: { parts: [{ text: '{"status":"accepted","facts":{' }] } }] },
  };
}

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
