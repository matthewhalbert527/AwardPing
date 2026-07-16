export function normalizeGeminiPricingMode(value, { endpoint = "generateContent" } = {}) {
  const clean = cleanSlug(value);
  if (endpoint === "batchGenerateContent") return "batch";
  if (clean === "flex") return "flex";
  return "standard";
}

export function geminiPricePerMillion(model, pricingMode = "standard") {
  const name = String(model || "").toLowerCase();
  const mode = cleanSlug(pricingMode);
  const discounted = mode === "batch" || mode === "flex";

  if (name.includes("3.1-flash-lite")) return discounted ? { input: 0.125, output: 0.75 } : { input: 0.25, output: 1.5 };
  if (name.includes("3-flash") || name.includes("3.1-flash")) return discounted ? { input: 0.25, output: 1.5 } : { input: 0.5, output: 3 };
  if (name.includes("2.5-flash-lite")) return discounted ? { input: 0.05, output: 0.2 } : { input: 0.1, output: 0.4 };
  if (name.includes("2.5-flash")) return discounted ? { input: 0.15, output: 1.25 } : { input: 0.3, output: 2.5 };
  if (name.includes("flash-lite")) return discounted ? { input: 0.05, output: 0.2 } : { input: 0.1, output: 0.4 };
  return discounted ? { input: 0.5, output: 2.5 } : { input: 1, output: 5 };
}

export function estimateGeminiCostUsd(model, usage, pricingMode = "standard") {
  const rates = geminiPricePerMillion(model, pricingMode);
  const normalized = normalizeGeminiUsage(usage);
  const inputTokens = normalized.prompt_tokens || 0;
  const outputTokens = (normalized.candidates_tokens || 0) + (normalized.thoughts_tokens || 0);
  return roundUsd((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output);
}

export function estimateTextTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

export function shouldAttachBaselineFactsImage({ capture, promptText }) {
  const text = String(capture?.text || "");
  const title = String(capture?.page_title || "");
  if (!capture?.thumb_path) return false;
  if ((capture?.kind || "webpage") === "pdf") return false;
  if (text.trim().length < 1_200) return true;
  if (estimateTextTokens(promptText) > 8_000) return false;
  if (title && text && !text.toLowerCase().includes(title.toLowerCase().slice(0, 32))) return true;
  return false;
}

export function baselineFactsPromptCharLimit(capture, { includeImage = false } = {}) {
  const textLength = Number(capture?.text_length || String(capture?.text || "").length || 0);
  if (includeImage) return Math.min(8_000, Math.max(3_000, textLength));
  if (textLength > 24_000) return 10_000;
  return 12_000;
}

export function batchInputModeForRequests(requests, { inlineThreshold = 100, maxInlineBytes = 14 * 1024 * 1024 } = {}) {
  if (!Array.isArray(requests) || !requests.length) return "inline";
  if (requests.length > inlineThreshold) return "jsonl_file";
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ batch: { inputConfig: { requests: { requests } } } }), "utf8");
  return envelopeBytes <= maxInlineBytes ? "inline" : "jsonl_file";
}

export function extractGeminiBatchInlineResponses(data) {
  const response = objectValue(data?.response);
  const output = objectValue(response.output || response.dest);
  const direct = [
    response.inlinedResponses,
    response.inlined_responses,
    response.inlinedResponses?.inlinedResponses,
    response.inlined_responses?.inlined_responses,
    output.inlinedResponses,
    output.inlined_responses,
    output.inlinedResponses?.inlinedResponses,
    output.inlined_responses?.inlined_responses,
    data?.dest?.inlinedResponses,
    data?.dest?.inlined_responses,
    data?.dest?.inlinedResponses?.inlinedResponses,
    data?.dest?.inlined_responses?.inlined_responses,
  ].find(Array.isArray);
  return direct || [];
}

export function geminiBatchOutputFileNames(data) {
  const names = [];
  for (const value of [
    data?.metadata?.output,
    data?.metadata?.dest,
    data?.response,
    data?.response?.output,
    data?.response?.dest,
    data?.response?.outputConfig,
    data?.response?.output_config,
    data?.output,
    data?.dest,
  ]) {
    collectFileNames(value, names, new Set());
  }
  return unique(names).filter((name) => /^files\//.test(name));
}

export function geminiBatchJsonlRequest(entry) {
  const key = geminiBatchInlineResponseKey(entry);
  const request = objectValue(entry?.request);
  if (!key || !Object.keys(request).length) return entry;
  return { key, request };
}

export function geminiBatchInlineResponseMap(responses) {
  const mapped = new Map();
  const duplicateKeys = [];
  let missingKeys = 0;

  for (const response of responses || []) {
    const key = geminiBatchInlineResponseKey(response);
    if (!key) {
      missingKeys += 1;
      continue;
    }
    if (mapped.has(key)) duplicateKeys.push(key);
    mapped.set(key, response);
  }

  return { responses: mapped, missingKeys, duplicateKeys: new Set(duplicateKeys) };
}

export function geminiBatchInlineResponseKey(response) {
  return cleanText(
    response?.metadata?.key ||
      response?.metadata?.request_key ||
      response?.metadata?.source_id ||
      response?.requestMetadata?.key ||
      response?.request_metadata?.key ||
      response?.key,
  );
}

export function geminiInlineResponsePayload(response) {
  return response?.response || response?.generateContentResponse || response?.generate_content_response || response;
}

export function geminiInlineError(response) {
  const payload = geminiInlineResponsePayload(response);
  const promptFeedback = payload?.promptFeedback || payload?.prompt_feedback;
  const blockReason = cleanText(promptFeedback?.blockReason || promptFeedback?.block_reason);
  if (blockReason) {
    return {
      message: `Gemini prompt blocked: ${blockReason}`,
      status: "PROMPT_BLOCKED",
      prompt_feedback: promptFeedback,
    };
  }
  return response?.error || response?.response?.error || response?.status?.error || null;
}

export function parseGeminiModelJsonObject(text) {
  const clean = String(text || "").trim().replace(/^\uFEFF/, "");
  if (!clean) return null;

  const candidates = [clean];
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isJsonObject(parsed)) return parsed;
      if (Array.isArray(parsed) && parsed.length === 1 && isJsonObject(parsed[0])) {
        return parsed[0];
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function extractGeminiUsageMetadata(responseItem) {
  const payload = geminiInlineResponsePayload(responseItem);
  return (
    responseItem?.response?.usageMetadata ||
    responseItem?.response?.usage_metadata ||
    payload?.usageMetadata ||
    payload?.usage_metadata ||
    {}
  );
}

export function normalizeGeminiUsage(metadata) {
  const promptTokens = nonNegativeInt(metadata?.promptTokenCount ?? metadata?.prompt_tokens, 0);
  const candidatesTokens = nonNegativeInt(metadata?.candidatesTokenCount ?? metadata?.candidates_tokens, 0);
  const thoughtsTokens = nonNegativeInt(metadata?.thoughtsTokenCount ?? metadata?.thoughts_tokens, 0);
  const cachedContentTokens = nonNegativeInt(metadata?.cachedContentTokenCount ?? metadata?.cached_content_tokens, 0);
  const fallbackTotal = promptTokens + candidatesTokens + thoughtsTokens;
  return {
    prompt_tokens: promptTokens,
    candidates_tokens: candidatesTokens,
    total_tokens: nonNegativeInt(metadata?.totalTokenCount ?? metadata?.total_tokens, fallbackTotal),
    thoughts_tokens: thoughtsTokens,
    cached_content_tokens: cachedContentTokens,
  };
}

export function geminiBatchUsageAccounting(responses, { mappingComplete = false } = {}) {
  const items = Array.isArray(responses) ? responses : [...(responses || [])];
  const usage = normalizeGeminiUsage({});
  let usageResponseCount = 0;
  for (const response of items) {
    const itemUsage = normalizeGeminiUsage(extractGeminiUsageMetadata(response));
    if ([
      itemUsage.total_tokens,
      itemUsage.prompt_tokens,
      itemUsage.candidates_tokens,
      itemUsage.thoughts_tokens,
      itemUsage.cached_content_tokens,
    ].some((value) => value > 0)) {
      usageResponseCount += 1;
    }
    usage.prompt_tokens += itemUsage.prompt_tokens;
    usage.candidates_tokens += itemUsage.candidates_tokens;
    usage.total_tokens += itemUsage.total_tokens;
    usage.thoughts_tokens += itemUsage.thoughts_tokens;
    usage.cached_content_tokens += itemUsage.cached_content_tokens;
  }
  return {
    usage,
    responseCount: items.length,
    usageResponseCount,
    mappingComplete: mappingComplete === true,
  };
}

export function geminiBatchExactMappingComplete(responses, mapped, expectedKeys) {
  const items = Array.isArray(responses) ? responses : [...(responses || [])];
  const expected = [...new Set((expectedKeys || []).map(cleanText).filter(Boolean))];
  const responseMap = mapped?.responses instanceof Map ? mapped.responses : new Map();
  const duplicateKeys = mapped?.duplicateKeys instanceof Set ? mapped.duplicateKeys : new Set();
  return expected.length > 0
    && items.length === expected.length
    && Number(mapped?.missingKeys || 0) === 0
    && duplicateKeys.size === 0
    && responseMap.size === expected.length
    && expected.every((key) => responseMap.has(key));
}

export function mergeBatchJobRecord(state, record) {
  const next = {
    version: 1,
    jobs: Array.isArray(state?.jobs) ? [...state.jobs] : [],
  };
  const batchName = cleanText(record?.batch_name);
  const displayName = cleanText(record?.display_name);
  const spendReservationId = cleanText(record?.spend_reservation_id);
  const spendReservationKey = cleanText(record?.spend_reservation_key);
  let index = next.jobs.findIndex((job) =>
    (batchName && cleanText(job?.batch_name) === batchName) ||
    (displayName && cleanText(job?.display_name) === displayName)
  );
  if (index === -1) {
    index = next.jobs.findIndex((job) =>
    (spendReservationId && cleanText(job?.spend_reservation_id) === spendReservationId) ||
    (spendReservationKey && cleanText(job?.spend_reservation_key) === spendReservationKey)
    );
  }
  const merged = index === -1 ? record : { ...next.jobs[index], ...record };
  const mergedBatchName = cleanText(merged?.batch_name);
  const mergedReservationId = cleanText(merged?.spend_reservation_id);
  const mergedReservationKey = cleanText(merged?.spend_reservation_key);
  next.jobs = next.jobs.filter((job, jobIndex) => {
    if (jobIndex === index) return false;
    return !(
      (mergedBatchName && cleanText(job?.batch_name) === mergedBatchName) ||
      (mergedReservationId && cleanText(job?.spend_reservation_id) === mergedReservationId) ||
      (mergedReservationKey && cleanText(job?.spend_reservation_key) === mergedReservationKey)
    );
  });
  next.jobs.push(merged);
  return next;
}

export function unfinishedBatchJobs(state) {
  return (Array.isArray(state?.jobs) ? state.jobs : []).filter((job) =>
    ["submitted", "processing"].includes(cleanSlug(job?.status)),
  );
}

export function batchJobsAwaitingReconciliation(state) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  return jobs.filter((job) => {
    const status = cleanSlug(job?.status);
    if (["submitted", "processing"].includes(status)) return true;
    return (
      status === "succeeded" &&
      cleanSlug(job?.input_mode) === "jsonl_file" &&
      !job?.reconciled_at &&
      Array.isArray(job?.request_keys) &&
      job.request_keys.length > 0
    );
  });
}

export function latestRequestKeysByBatchJob(jobs) {
  const claimed = new Set();
  const keysByJob = new Map();
  const ordered = [...(Array.isArray(jobs) ? jobs : [])].sort((left, right) =>
    String(right?.submitted_at || "").localeCompare(String(left?.submitted_at || "")),
  );
  for (const job of ordered) {
    const keys = [];
    for (const key of Array.isArray(job?.request_keys) ? job.request_keys : []) {
      const clean = cleanText(key);
      if (!clean || claimed.has(clean)) continue;
      claimed.add(clean);
      keys.push(clean);
    }
    keysByJob.set(job?.batch_name || job?.display_name, keys);
  }
  return keysByJob;
}

export function activeBatchRequestKeys(state) {
  return new Set(
    batchJobsAwaitingReconciliation(state).flatMap((job) =>
      Array.isArray(job.request_keys) ? job.request_keys : []
    ),
  );
}

export function submittedRequestCapReached({ submitted = 0, pending = 0, cap = 0 } = {}) {
  const max = nonNegativeInt(cap, 0);
  if (!max) return false;
  return nonNegativeInt(submitted, 0) + nonNegativeInt(pending, 0) >= max;
}

function collectFileNames(value, names, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      /(?:fileName|file_name|responsesFile|responses_file|output|dest)/i.test(key) &&
      /^files\//.test(child)
    ) {
      names.push(child);
    } else if (child && typeof child === "object") {
      collectFileNames(child, names, seen);
    }
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function roundUsd(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 1_000_000) / 1_000_000;
}
