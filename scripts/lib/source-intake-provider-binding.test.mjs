import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSourceIntakeProviderInputBinding,
  buildSourceIntakeProviderResultBinding,
  validateSourceIntakeProviderInputBinding,
  validateSourceIntakeProviderReplayBinding,
} from "./source-intake-provider-binding.mjs";
import {
  SourceIntakeProviderBindingValidationError,
  verifySourceIntakeProviderBindingForAdminApproval,
} from "../../src/lib/source-intake-provider-binding.server.ts";
import { buildGeminiIntakeRequest } from "./source-intake.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-07-17T12:00:00.000Z";
const acceptedAt = "2026-07-17T12:04:00.000Z";
const deterministicReview = {
  status: "plausible",
  reason: "passes_deterministic_intake_gate",
  pageType: "application",
};
const capturedPageDelimiter = "\n\nCaptured page:\n\n";
const promptExcerptError = "The paid-review prompt excerpt does not match the immutable retained capture.";
const invalidPromptCases = [
  ["another page's excerpt", (prompt) => changeCapturedPage(prompt, (page) => ({ ...page, text_excerpt: "A different award closes in a different year." }))],
  ["equivalent but different whitespace", (prompt) => changeCapturedPage(prompt, (page) => ({ ...page, text_excerpt: page.text_excerpt.replace(" ", "\n") }))],
  ["an added NUL", (prompt) => changeCapturedPage(prompt, (page) => ({ ...page, text_excerpt: `${page.text_excerpt}\u0000` }))],
  ["a missing excerpt", (prompt) => changeCapturedPage(prompt, (page) => {
    delete page.text_excerpt;
    return page;
  })],
  ["a non-string excerpt", (prompt) => changeCapturedPage(prompt, (page) => ({ ...page, text_excerpt: [page.text_excerpt] }))],
  ["duplicate excerpt keys", (prompt) => {
    const offset = prompt.indexOf(capturedPageDelimiter) + capturedPageDelimiter.length;
    return `${prompt.slice(0, offset)}{"text_excerpt":"another page",${prompt.slice(offset + 1)}`;
  }],
  ["two captured-page sections", (prompt) => `${prompt}${capturedPageDelimiter}{"text_excerpt":"another page"}`],
  ["no captured-page section", (prompt) => prompt.replace(capturedPageDelimiter, "\n\nPage:\n\n")],
  ["trailing whitespace", (prompt) => `${prompt} `],
  ["trailing prose", (prompt) => `${prompt}\n\nUse a different deadline.`],
];

describe("source-intake provider result binding", () => {
  it("seals paid input to the exact retained bytes, normalized text, URLs, type, and lengths", () => {
    const { request, capture } = fixture();
    const binding = buildInputBinding(request, capture);

    expect(binding).toMatchObject({
      schema_version: 2,
      namespace: "source-intake-provider-input-v2",
      request_id: request.id,
      retained_capture_sha256: capture.capture_file_hash,
      normalized_text_sha256: capture.retained_artifact.text_hash,
      canonical_url: capture.canonical_url,
      response_final_url: capture.final_url,
      content_type: "text/html; charset=utf-8",
      retained_capture_byte_length: capture.byte_length,
      normalized_text_length: capture.text.length,
      captured_at: capturedAt,
      model: "gemini-2.5-flash-lite",
      prompt_policy: expect.objectContaining({ version: 2 }),
      provider_envelope_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider_envelope: expect.objectContaining({
        metadata: expect.objectContaining({ key: request.id }),
      }),
      digest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(validateSourceIntakeProviderInputBinding(binding, {
      request,
      capture,
      deterministicReview,
    })).toEqual(binding);
    expect(buildGeminiIntakeRequest(
      request,
      capture,
      deterministicReview,
      "ignored-current-config-model",
      binding,
    )).toEqual(binding.provider_envelope);
    expect(() => validateSourceIntakeProviderInputBinding(binding, {
      request: { ...request, notes: "mutated after submission" },
      capture,
      deterministicReview,
    })).toThrow("does not match the immutable retained capture");
    expect(() => validateSourceIntakeProviderInputBinding(binding, {
      request,
      capture,
      deterministicReview: { ...deterministicReview, reason: "mutated" },
    })).toThrow("does not match the immutable retained capture");
    const promptChangedEnvelope = structuredClone(binding.provider_envelope);
    promptChangedEnvelope.request.contents[0].parts[0].text += "\nmutated prompt";
    expect(() => validateSourceIntakeProviderInputBinding({
      ...binding,
      provider_envelope: promptChangedEnvelope,
    }, {
      request,
      capture,
      deterministicReview,
    })).toThrow();
    expect(() => validateSourceIntakeProviderInputBinding({
      ...binding,
      schema_version: 1,
      namespace: "source-intake-provider-input",
    }, { request, capture, deterministicReview })).toThrow(
      "Historical unbound results cannot be replayed",
    );
  });

  it("seals the prompt excerpt range and also rejects changes beyond the 16k provider excerpt", () => {
    const { request, capture } = fixture();
    const longText = `${"A".repeat(16_000)}tail-one`;
    const longCapture = captureWithText(capture, longText);
    const binding = buildInputBinding(request, longCapture);
    expect(binding.text_excerpt_offset).toBe(0);
    expect(binding.text_excerpt_length).toBe(16_000);
    expect(binding.text_excerpt_sha256).toBe(sha256("A".repeat(16_000)));

    const changedBeyondExcerpt = captureWithText(
      longCapture,
      `${"A".repeat(16_000)}tail-two`,
    );
    expect(() => validateSourceIntakeProviderInputBinding(binding, {
      request,
      capture: changedBeyondExcerpt,
      deterministicReview,
    })).toThrow();
  });

  it("fails closed when any captured evidence is changed after paid submission", () => {
    const { request, capture } = fixture();
    const binding = buildInputBinding(request, capture);
    for (const changedCapture of [
      { ...capture, text: `${capture.text} changed` },
      { ...capture, final_url: "https://example.org/redirected" },
      { ...capture, canonical_url: "https://example.org/another-award" },
      { ...capture, content_type: "text/plain" },
      { ...capture, byte_length: capture.byte_length + 1 },
      { ...capture, capture_file_hash: "f".repeat(64) },
    ]) {
      expect(() => validateSourceIntakeProviderInputBinding(binding, {
        request,
        capture: changedCapture,
        deterministicReview,
      })).toThrow();
    }
  });

  it("binds the accepted provider JSON and Batch identity and verifies a $0 replay", () => {
    const { request, capture, rawResult } = fixture();
    const inputBinding = buildInputBinding(request, capture);
    const providerResultBinding = buildSourceIntakeProviderResultBinding({
      request,
      capture,
      deterministicReview,
      inputBinding,
      rawResult,
      batchName: "batches/source-intake-1",
      batchRequestKey: request.id,
      model: "gemini-2.5-flash-lite",
      acceptedAt,
    });
    const storedReview = {
      status: "accepted",
      raw: rawResult,
      completed_at: acceptedAt,
      gemini_batch_name: "batches/source-intake-1",
      gemini_batch_request_key: request.id,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: inputBinding,
      provider_result_binding: providerResultBinding,
    };

    expect(validateSourceIntakeProviderReplayBinding({
      request,
      capture,
      deterministicReview,
      storedReview,
    })).toMatchObject({
      inputBinding,
      resultBinding: providerResultBinding,
      capture: { retained_artifact: expect.objectContaining({ request_id: request.id }) },
    });

    expect(() => buildSourceIntakeProviderResultBinding({
      request,
      capture,
      deterministicReview,
      inputBinding: { ...inputBinding, digest_sha256: "0".repeat(64) },
      rawResult,
      batchName: "batches/source-intake-1",
      batchRequestKey: request.id,
      model: "gemini-2.5-flash-lite",
      acceptedAt,
    })).toThrow("does not match the immutable retained capture");
  });

  it("rejects legacy unbound rows and any substituted stored result", () => {
    const { request, capture, rawResult } = fixture();
    const inputBinding = buildInputBinding(request, capture);
    const providerResultBinding = buildSourceIntakeProviderResultBinding({
      request,
      capture,
      deterministicReview,
      inputBinding,
      rawResult,
      batchName: "batches/source-intake-1",
      batchRequestKey: request.id,
      model: "gemini-2.5-flash-lite",
      acceptedAt,
    });
    const baseReview = {
      status: "accepted",
      raw: rawResult,
      completed_at: acceptedAt,
      gemini_batch_name: "batches/source-intake-1",
      gemini_batch_request_key: request.id,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: inputBinding,
      provider_result_binding: providerResultBinding,
    };

    expect(() => validateSourceIntakeProviderReplayBinding({
      request,
      capture,
      deterministicReview,
      storedReview: { ...baseReview, provider_input_binding: undefined },
    })).toThrow("Historical unbound results cannot be replayed");

    expect(() => validateSourceIntakeProviderReplayBinding({
      request,
      capture,
      deterministicReview,
      storedReview: {
        ...baseReview,
        raw: { ...rawResult, detected_award_name: "Substituted Award" },
      },
    })).toThrow("not sealed to the exact retained capture");

    expect(() => validateSourceIntakeProviderReplayBinding({
      request,
      capture,
      deterministicReview,
      storedReview: {
        ...baseReview,
        gemini_batch_request_key: "22222222-2222-4222-8222-222222222222",
      },
    })).toThrow();
  });

  it("recomputes the exact capture and stored result at the admin approval boundary", () => {
    const { request, capture, rawResult } = fixture();
    const providerInputBinding = buildInputBinding(request, capture);
    const providerResultBinding = buildSourceIntakeProviderResultBinding({
      request,
      capture,
      deterministicReview,
      inputBinding: providerInputBinding,
      rawResult,
      batchName: "batches/source-intake-approval",
      batchRequestKey: request.id,
      model: "gemini-2.5-flash-lite",
      acceptedAt,
    });
    const aiReview = {
      status: "accepted",
      raw: rawResult,
      completed_at: acceptedAt,
      gemini_batch_name: "batches/source-intake-approval",
      gemini_batch_request_key: request.id,
      model: "gemini-2.5-flash-lite",
      provider_input_binding: providerInputBinding,
      provider_result_binding: providerResultBinding,
    };

    expect(verifySourceIntakeProviderBindingForAdminApproval({
      request,
      deterministicReview,
      captureMetadata: capture,
      aiReview,
    })).toMatchObject({ inputBinding: providerInputBinding, resultBinding: providerResultBinding });

    try {
      verifySourceIntakeProviderBindingForAdminApproval({
        request,
        deterministicReview,
        captureMetadata: capture,
        aiReview: {
          ...aiReview,
          provider_input_binding: {
            ...providerInputBinding,
            digest_sha256: "0".repeat(64),
          },
        },
      });
      throw new Error("Expected the tampered provider binding to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceIntakeProviderBindingValidationError);
      expect(error).toMatchObject({
        status: 409,
        message: expect.stringContaining("does not match the immutable retained capture"),
      });
    }
  });

  it("keeps the real v2 producer's pre-change prompt, envelope, input and result digests", () => {
    const { request, capture, rawResult } = fixture();
    const inputBinding = buildInputBinding(request, capture);
    const storedReview = reviewForBinding(request, capture, rawResult, inputBinding);
    expect({
      prompt: inputBinding.user_prompt_sha256,
      envelope: inputBinding.provider_envelope_sha256,
      input: inputBinding.digest_sha256,
      result: storedReview.provider_result_binding.digest_sha256,
    }).toEqual({
      prompt: "87c4df5dfad76bca4f43dbc640e66f244c681cf50b0d74bc935be44d4384bb41",
      envelope: "dd7cce4553134fa421147d3b8b614afbf982747cd8da11e9658991b4532d03a2",
      input: "b2264bb752dbf15518bbabd4fdaca87e5a489a4a0ab19837f58dd538b5dea6e7",
      result: "cd1f81660aa761eddf3efc0ab4918b22c5dc1c91e7bb0b18d8543d910372d3c9",
    });
    expect(validateSourceIntakeProviderReplayBinding({ request, capture, deterministicReview, storedReview }))
      .toMatchObject({ inputBinding, resultBinding: storedReview.provider_result_binding });
    expect(verifySourceIntakeProviderBindingForAdminApproval({ request, captureMetadata: capture, deterministicReview, aiReview: storedReview }))
      .toMatchObject({ inputBinding, resultBinding: storedReview.provider_result_binding });
  });

  it.each([
    ["description", { description: { text: "Example award" } }],
    ["deadline", { deadline: ["March 1", "March 15"] }],
    ["amount", { amount: 5000 }],
    ["amount", { amount: false, award_amount: "$5,000" }],
    ["amount", { amount: 0, award_amount: "$5,000" }],
    ["amount", { amount: [], award_amount: "$5,000" }],
    ["award_amount", { amount: null, award_amount: { amount: 5000 } }],
    ["facts", []],
    ["facts", "March 1"],
  ])("refuses admin approval of a correctly sealed wrong-type %s", (field, facts) => {
    const { request, capture, rawResult } = fixture();
    const inputBinding = buildInputBinding(request, capture);
    const invalidRaw = { ...rawResult, facts, raw: { ...rawResult, facts: {} } };
    const storedReview = reviewForBinding(request, capture, invalidRaw, inputBinding);
    // Raw-result seals remain valid and retained; semantic/type validity is a
    // separate prerequisite for approval, not a reason to rewrite the evidence.
    expect(validateSourceIntakeProviderReplayBinding({ request, capture, deterministicReview, storedReview }))
      .toMatchObject({ inputBinding });
    expect(() => verifySourceIntakeProviderBindingForAdminApproval({ request, captureMetadata: capture, deterministicReview, aiReview: storedReview }))
      .toThrow(`Invalid scalar facts require manual review before source approval (${field}).`);
    expect(storedReview.raw).toEqual(invalidRaw);
  });

  it.each([
    undefined, null, {},
    { description: null, deadline: "", amount: null, award_amount: "$5,000" },
    { deadline: "March 1; March 15", amount: "$5,000", award_amount: { unused: true } },
    { amount: "   ", award_amount: { unused: true } },
  ])("keeps valid optional scalar shapes approvable", (facts) => {
    const { request, capture, rawResult } = fixture();
    const inputBinding = buildInputBinding(request, capture);
    const storedReview = reviewForBinding(request, capture, { ...rawResult, facts }, inputBinding);
    expect(verifySourceIntakeProviderBindingForAdminApproval({ request, captureMetadata: capture, deterministicReview, aiReview: storedReview }))
      .toMatchObject({ inputBinding });
  });

  it.each(invalidPromptCases)("refuses to seal %s as the retained capture", (_label, changePrompt) => {
    const { request, capture } = fixture();
    const providerEnvelope = buildGeminiIntakeRequest(request, capture, deterministicReview, "gemini-2.5-flash-lite");
    providerEnvelope.request.contents[0].parts[0].text = changePrompt(providerEnvelope.request.contents[0].parts[0].text);
    expect(() => buildSourceIntakeProviderInputBinding({
      request, capture, deterministicReview, providerEnvelope, model: "gemini-2.5-flash-lite",
    })).toThrow(promptExcerptError);
  });

  it.each(invalidPromptCases)("refuses self-consistently sealed %s on replay and approval", (_label, changePrompt) => {
    const { request, capture, rawResult } = fixture();
    const original = buildInputBinding(request, capture);
    const storedReview = reviewForBinding(request, capture, rawResult, original);
    // Recompute every affected digest: this reproduces an internally consistent
    // old v2 seal, not an ordinary hash-tampering failure. These are test-only
    // synthetic records, never production evidence or a historical-row repair.
    const envelope = structuredClone(original.provider_envelope);
    envelope.request.contents[0].parts[0].text = changePrompt(envelope.request.contents[0].parts[0].text);
    const changedInput = reseal({
      ...original,
      provider_envelope: envelope,
      user_prompt_sha256: sha256(envelope.request.contents[0].parts[0].text),
      provider_envelope_sha256: sha256(canonicalJson(envelope)),
    });
    storedReview.provider_input_binding = changedInput;
    storedReview.provider_result_binding = reseal({
      ...storedReview.provider_result_binding,
      input_digest_sha256: changedInput.digest_sha256,
    });
    expect.soft(() => validateSourceIntakeProviderInputBinding(changedInput, { request, capture, deterministicReview }))
      .toThrow(promptExcerptError);
    expect.soft(() => validateSourceIntakeProviderReplayBinding({ request, capture, deterministicReview, storedReview }))
      .toThrow(promptExcerptError);
    expect.soft(() => verifySourceIntakeProviderBindingForAdminApproval({ request, captureMetadata: capture, deterministicReview, aiReview: storedReview }))
      .toThrow(promptExcerptError);
  });

  it.each([
    "Marshall Scholarship\neligibility\tand application guidance.",
    'Marshall “Scholarship” — “Apply” at https://example.org/中文?name="test".',
    "Marshall Scholarship\n\nCaptured page:\n\ntext within the source is JSON-escaped.",
    `${"A".repeat(15_999)}🎓application guidance`,
  ])("accepts actual producer normalization and JSON escaping: %.50s", (text) => {
    const { request, capture, rawResult } = fixture();
    const changedCapture = captureWithText(capture, text);
    const inputBinding = buildInputBinding(request, changedCapture);
    const storedReview = reviewForBinding(request, changedCapture, rawResult, inputBinding);
    expect(validateSourceIntakeProviderReplayBinding({ request, capture: changedCapture, deterministicReview, storedReview }))
      .toMatchObject({ inputBinding });
    expect(verifySourceIntakeProviderBindingForAdminApproval({ request, captureMetadata: changedCapture, deterministicReview, aiReview: storedReview }))
      .toMatchObject({ inputBinding });
  });
});

function changeCapturedPage(prompt, changePage) {
  const offset = prompt.indexOf(capturedPageDelimiter) + capturedPageDelimiter.length;
  return prompt.slice(0, offset) + JSON.stringify(changePage(JSON.parse(prompt.slice(offset))));
}

function reviewForBinding(request, capture, rawResult, inputBinding) {
  const resultBinding = buildSourceIntakeProviderResultBinding({
    request, capture, deterministicReview, inputBinding, rawResult,
    batchName: "batches/source-intake-compatibility", batchRequestKey: request.id,
    model: "gemini-2.5-flash-lite", acceptedAt,
  });
  return {
    status: "accepted", raw: rawResult, completed_at: acceptedAt,
    gemini_batch_name: resultBinding.provider_batch_name,
    gemini_batch_request_key: request.id, model: "gemini-2.5-flash-lite",
    provider_input_binding: inputBinding, provider_result_binding: resultBinding,
  };
}

function reseal(binding) {
  const basis = { ...binding };
  delete basis.digest_sha256;
  return { ...basis, digest_sha256: sha256(canonicalJson(basis)) };
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function fixture() {
  const text = "Marshall Scholarship eligibility and application guidance.";
  const fileBytes = Buffer.from("<html><body>Marshall Scholarship eligibility and application guidance.</body></html>");
  const fileHash = sha256(fileBytes);
  const canonicalUrl = "https://example.org/apply";
  const responseUrl = "https://example.org/apply?cycle=2027";
  const prefix = `source-intake-first-observation/v1/requests/${requestId}/sha256/${fileHash}`;
  const textBytes = Buffer.from(`${text}\n`, "utf8");
  const request = {
    id: requestId,
    award_name: "Marshall Scholarship",
    notes: "Review the current official application page.",
    submitted_url: canonicalUrl,
    homepage_url: canonicalUrl,
    normalized_url: canonicalUrl,
    intake_type: "official_source",
  };
  const capture = {
    capture_file_hash: fileHash,
    byte_length: fileBytes.length,
    captured_at: capturedAt,
    canonical_url: canonicalUrl,
    final_url: responseUrl,
    content_type: "text/html; charset=utf-8",
    text,
    retained_artifact: {
      schema_version: 1,
      namespace: "source-intake-first-observation",
      request_id: requestId,
      captured_at: capturedAt,
      final_url: canonicalUrl,
      response_final_url: responseUrl,
      canonical_url: canonicalUrl,
      prefix,
      file_hash: fileHash,
      file_bytes: fileBytes.length,
      document_kind: "html",
      document_content_type: "text/html; charset=utf-8",
      text_hash: sha256(text),
      text_length: text.length,
      r2_bucket: "awardping-artifacts",
      r2_store_id: "account.r2.cloudflarestorage.com",
      r2_verified_at: "2026-07-17T12:01:00.000Z",
      artifacts: {
        pdf: {
          key: `${prefix}/document.pdf`,
          sha256: fileHash,
          byte_length: fileBytes.length,
          content_type: "text/html; charset=utf-8",
        },
        text: {
          key: `${prefix}/text.txt`,
          sha256: sha256(textBytes),
          byte_length: textBytes.length,
          content_type: "text/plain; charset=utf-8",
        },
        capture_metadata: {
          key: `${prefix}/capture.json`,
          sha256: "d".repeat(64),
          byte_length: 456,
          content_type: "application/json",
        },
      },
    },
  };
  return {
    request,
    capture,
    rawResult: {
      status: "accepted",
      detected_award_name: "Marshall Scholarship",
      source_relevance: "primary",
    },
  };
}

function buildInputBinding(request, capture) {
  const model = "gemini-2.5-flash-lite";
  const providerEnvelope = buildGeminiIntakeRequest(
    request,
    capture,
    deterministicReview,
    model,
  );
  return buildSourceIntakeProviderInputBinding({
    request,
    capture,
    deterministicReview,
    providerEnvelope,
    model,
  });
}

function captureWithText(capture, text) {
  const textBytes = Buffer.from(`${text}\n`, "utf8");
  return {
    ...capture,
    text,
    retained_artifact: {
      ...capture.retained_artifact,
      text_hash: sha256(text),
      text_length: text.length,
      artifacts: {
        ...capture.retained_artifact.artifacts,
        text: {
          ...capture.retained_artifact.artifacts.text,
          sha256: sha256(textBytes),
          byte_length: textBytes.length,
        },
      },
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
