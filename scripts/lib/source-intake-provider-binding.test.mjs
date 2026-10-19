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
});

it("keeps the real v2 producer's pre-change prompt, envelope, input and result digests", () => {
    const { request, capture, rawResult } = fixture();
    const providerEnvelope = historical026Envelope();
    const inputBinding = buildSourceIntakeProviderInputBinding({
      request, capture, deterministicReview, providerEnvelope, model: "gemini-2.5-flash-lite",
    });
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
    expect(buildGeminiIntakeRequest(request, capture, deterministicReview, "ignored-current-model", inputBinding))
      .toEqual(providerEnvelope);
  });

// Literal 026 envelope. Preserve the four historical digest expectations.
function historical026Envelope() {
  const prompt = [
    "Review this pasted source URL for AwardPing intake.",
    "Strict output schema:",
    '{"status":"accepted|needs_review|rejected","detected_award_name":"string|null","detected_sponsor":"string|null","source_relevance":"primary|supporting|generic_listing|sibling_program|unrelated|unclear|access_error","cycle_relevance":"current_or_upcoming|evergreen|archived_or_past|not_program_page|unclear","page_type":"homepage|application|deadline|eligibility|requirements|faq|pdf|portal|listing|other","officialness":"official|likely_official|third_party|unclear","confidence":"high|medium|low","evidence_quotes":["short exact quote"],"facts":{"description":"string|null","deadline":"string|null","amount":"string|null","eligibility":[],"application_materials":[],"important_dates":[]},"suggested_sources":[{"url":"string","title":"string","page_type":"string","reason":"string","confidence":0}],"rejection_reason":"string|null","manual_review_reason":"string|null"}',
    "Submitted request:",
    '{"id":"11111111-1111-4111-8111-111111111111","requested_award_name":"Marshall Scholarship","notes":"Review the current official application page.","submitted_url":"https://example.org/apply","normalized_url":"https://example.org/apply","intake_type":"official_source"}',
    "Deterministic review:",
    '{"status":"plausible","reason":"passes_deterministic_intake_gate","pageType":"application"}',
    "Captured page:",
    '{"retained_capture_identity":{"request_id":"11111111-1111-4111-8111-111111111111","retained_capture_sha256":"abd0c9bec830561391f07515bc7040a1daabe127d921801f2f743a3061110f1f","normalized_text_sha256":"232628623594d96e23e0e9ba2850d86c61951bc4cdb135c2b7c2427b06fc2e03","canonical_url":"https://example.org/apply","response_final_url":"https://example.org/apply?cycle=2027","content_type":"text/html; charset=utf-8","retained_capture_byte_length":84,"normalized_text_length":58,"captured_at":"2026-07-17T12:00:00.000Z"},"prompt_policy":{"name":"awardping-source-intake-review","version":2,"system_instruction_version":1,"output_schema_version":1,"text_excerpt_offset":0,"text_excerpt_max_chars":16000},"final_url":"https://example.org/apply?cycle=2027","canonical_url":"https://example.org/apply","content_type":"text/html; charset=utf-8","text_excerpt":"Marshall Scholarship eligibility and application guidance.","pdf_links":[],"links":[]}',
  ].join("\n\n");
  return {
    request: {
      systemInstruction: { parts: [{ text: "You are AwardPing's strict source-intake reviewer. Return JSON only. Default to needs_review or rejected when uncertain. Do not invent deadlines, cycles, award names, or facts. Classify sibling programs, broad sponsor pages, search/listing pages, access errors, jobs/careers, profiles, recipients, news, and payment pages conservatively. Accepted facts must cite exact evidence quotes from the supplied page text." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1600, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
    },
    metadata: { key: "11111111-1111-4111-8111-111111111111", source_page_request_id: "11111111-1111-4111-8111-111111111111", model: "gemini-2.5-flash-lite" },
  };
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
