import { estimateGeminiCostUsd, estimateTextTokens } from "./gemini-batch-support.mjs";

export const GEMINI_PAID_LANES = Object.freeze({
  NEW_PAGE_REVIEW: "new_page_review",
  CHANGED_PAGE_REVIEW: "changed_page_review",
});

export class GeminiBudgetUnavailableError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "GeminiBudgetUnavailableError";
    this.code = "gemini_budget_unavailable";
    this.status = status;
  }
}

export function geminiActiveWorkReservation(value) {
  const status = objectValue(value instanceof GeminiBudgetUnavailableError ? value.status : value);
  if (cleanText(status.reason) !== "active_work_reservation_exists") return null;
  const reservationId = cleanText(status.active_reservation_id);
  const activeStatus = cleanText(status.active_status);
  if (!reservationId || !new Set(["reserved", "creating", "submitted"]).has(activeStatus)) return null;
  return {
    reservationId,
    status: activeStatus,
    manualRecoveryRequired: activeStatus === "creating",
    automaticProviderPoll: activeStatus === "submitted",
  };
}

export async function reserveGeminiSpend({
  supabase,
  laneKey,
  reservationKey,
  attemptToken,
  workFingerprint,
  estimatedCostUsd,
  workerSource,
  workerRunId = null,
  requestCount,
  model,
  metadata = {},
}) {
  assertLane(laneKey);
  const ownerAttemptToken = requiredUuid(attemptToken, "attemptToken");
  const billableWorkFingerprint = requiredText(workFingerprint, "workFingerprint");
  const estimatedMicroUsd = usdToMicroUsd(estimatedCostUsd, { minimum: 1 });
  const status = await rpcOne(supabase, "reserve_gemini_spend", {
    p_lane_key: laneKey,
    p_reservation_key: requiredText(reservationKey, "reservationKey"),
    p_attempt_token: ownerAttemptToken,
    p_work_fingerprint: billableWorkFingerprint,
    p_estimated_micro_usd: estimatedMicroUsd,
    p_worker_source: requiredText(workerSource, "workerSource"),
    p_worker_run_id: workerRunId || null,
    p_request_count: positiveInt(requestCount, "requestCount"),
    p_model: requiredText(model, "model"),
    p_metadata: objectValue(metadata),
  });
  const allowed = status?.granted === true && status?.can_submit === true;
  if (!allowed) {
    throw new GeminiBudgetUnavailableError(
      cleanText(status?.reason) || `${laneKey} has no unreserved Gemini budget remaining for this UTC day.`,
      normalizeBudgetStatus(status),
    );
  }
  const reservationId = cleanText(status?.reservation_id || status?.id);
  if (!reservationId) throw new Error("Gemini spend reservation succeeded without a reservation id.");
  return {
    ...normalizeBudgetStatus(status),
    allowed: true,
    reservation_id: reservationId,
    attempt_token: ownerAttemptToken,
    work_fingerprint: billableWorkFingerprint,
    estimated_micro_usd: estimatedMicroUsd,
    estimated_cost_usd: microUsdToUsd(estimatedMicroUsd),
  };
}

export async function submitGeminiSpendReservation({
  supabase,
  reservationId,
  attemptToken,
  providerBatchName,
}) {
  const expectedBatchName = requiredText(providerBatchName, "providerBatchName");
  const status = await rpcOne(supabase, "submit_gemini_spend_reservation", {
    p_reservation_id: requiredText(reservationId, "reservationId"),
    p_attempt_token: requiredUuid(attemptToken, "attemptToken"),
    p_provider_batch_name: expectedBatchName,
  });
  if (status?.submitted !== true || cleanText(status?.provider_batch_name) !== expectedBatchName) {
    throw new Error("Gemini spend reservation submission was not durably acknowledged.");
  }
  return status;
}

export async function markGeminiSpendCreateStarted({
  supabase,
  reservationId,
  attemptToken,
  metadata = {},
}) {
  const status = await rpcOne(supabase, "mark_gemini_spend_create_started", {
    p_reservation_id: requiredText(reservationId, "reservationId"),
    p_attempt_token: requiredUuid(attemptToken, "attemptToken"),
    p_metadata: objectValue(metadata),
  });
  if (
    status?.create_allowed !== true
    || status?.create_started !== true
    || status?.already_started !== false
  ) {
    throw new Error("Gemini provider-create start was not durably acknowledged.");
  }
  return status;
}

export async function settleGeminiSpendReservation({
  supabase,
  reservationId,
  spentCostUsd,
  usage = {},
  spentSource = "terminal_provider_usage",
}) {
  if (!cleanText(reservationId)) return null;
  const status = await rpcOne(supabase, "settle_gemini_spend_reservation", {
    p_reservation_id: reservationId,
    p_spent_micro_usd: usdToMicroUsd(spentCostUsd),
    p_usage: objectValue(usage),
    p_spent_source: requiredText(spentSource, "spentSource"),
  });
  if (status?.settled !== true) {
    throw new Error("Gemini spend reservation settlement was not durably acknowledged.");
  }
  return status;
}

export async function releaseGeminiSpendReservation({
  supabase,
  reservationId,
  reason,
  expectedStatus = null,
  expectedAttemptToken = null,
}) {
  if (!cleanText(reservationId)) return null;
  const status = await rpcOne(supabase, "release_gemini_spend_reservation", {
    p_reservation_id: reservationId,
    p_reason: requiredText(reason, "reason"),
    p_expected_status: cleanText(expectedStatus) || null,
    p_expected_attempt_token: expectedAttemptToken
      ? requiredUuid(expectedAttemptToken, "expectedAttemptToken")
      : null,
  });
  if (status?.released !== true) {
    throw new Error("Gemini spend reservation release was not durably acknowledged.");
  }
  return status;
}

export async function releaseUnsubmittedGeminiSpendReservationByKey({
  supabase,
  reservationKey,
  reason,
}) {
  if (!supabase?.from) throw new Error("A Supabase service client is required for Gemini spend recovery.");
  const key = requiredText(reservationKey, "reservationKey");
  const { data, error } = await supabase
    .from("gemini_spend_reservations")
    .select("id,status,attempt_token")
    .eq("reservation_key", key)
    .maybeSingle();
  if (error) throw new Error(`Load Gemini spend reservation ${key} failed: ${error.message}`);
  if (!data) return { released: false, status: "missing", reservation_key: key };
  if (data.status === "released") {
    return { released: true, already_released: true, status: "released", reservation_id: data.id };
  }
  if (data.status !== "reserved") {
    throw new Error(
      `Gemini spend reservation ${key} is ${data.status}; it cannot be released as a pre-create reservation.`,
    );
  }
  return releaseGeminiSpendReservation({
    supabase,
    reservationId: data.id,
    reason,
    expectedStatus: "reserved",
    expectedAttemptToken: data.attempt_token,
  });
}

export async function loadGeminiSpendReservation({ supabase, reservationId }) {
  if (!supabase?.from) throw new Error("A Supabase service client is required for Gemini spend accounting.");
  const id = requiredText(reservationId, "reservationId");
  const { data, error } = await supabase
    .from("gemini_spend_reservations")
    .select("id,reservation_key,status,attempt_token,work_fingerprint,request_count,reserved_micro_usd,spent_micro_usd,provider_batch_name,create_started_at,submitted_at,model")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load Gemini spend reservation ${id} failed: ${error.message}`);
  if (!data) throw new Error(`Gemini spend reservation ${id} was not found.`);
  return data;
}

export function terminalGeminiSettlement({
  model,
  usage,
  reservation,
  responseCount,
  usageResponseCount,
  mappingComplete = false,
  pricingMode = "batch",
}) {
  const expected = positiveInt(reservation?.request_count, "reservation.request_count");
  const responses = nonNegativeInt(responseCount);
  const responsesWithUsage = nonNegativeInt(usageResponseCount);
  const coverageComplete = mappingComplete === true
    && responses === expected
    && responsesWithUsage === expected;
  const providerCostUsd = estimateGeminiCostUsd(model, usage, pricingMode);
  const useProviderUsage = coverageComplete && providerCostUsd > 0;
  return {
    spentCostUsd: useProviderUsage
      ? providerCostUsd
      : microUsdToUsd(nonNegativeInt(reservation?.reserved_micro_usd)),
    spentSource: useProviderUsage
      ? "terminal_provider_usage"
      : "terminal_batch_conservative_reserved_maximum",
    coverage: {
      expected_responses: expected,
      observed_responses: responses,
      responses_with_usage: responsesWithUsage,
      mapping_complete: mappingComplete === true,
      complete: coverageComplete,
    },
  };
}

export function geminiUsageHasEvidence(usage = {}) {
  const value = objectValue(usage);
  return [
    "total_tokens",
    "prompt_tokens",
    "candidates_tokens",
    "thoughts_tokens",
    "cached_content_tokens",
  ].some((key) => Number.isFinite(Number(value[key])) && Number(value[key]) > 0);
}

export async function listGeminiBudgetStatus(supabase) {
  const { data, error } = await supabase.rpc("list_gemini_budget_status");
  if (error) throw new Error(`list_gemini_budget_status failed: ${error.message}`);
  return (Array.isArray(data) ? data : data ? [data] : []).map(normalizeBudgetStatus);
}

export function estimateGeminiBatchRequestsCostUsd(model, requests, { outputTokensPerRequest = 1_200 } = {}) {
  const items = Array.isArray(requests) ? requests : [];
  const promptTokens = items.reduce(
    (sum, request) => sum + estimateTextTokens(JSON.stringify(request || {})),
    0,
  );
  return estimateGeminiCostUsd(
    model,
    {
      prompt_tokens: promptTokens,
      candidates_tokens: Math.max(0, Math.ceil(Number(outputTokensPerRequest) || 0)) * items.length,
    },
    "batch",
  );
}

export function estimateGeminiMaximumBatchRequestsCostUsd(
  model,
  requests,
  {
    maxOutputTokensPerRequest,
    inputOverheadTokensPerRequest = 1_024,
    imageTokenSafetyMultiplier = 2,
  } = {},
) {
  const items = Array.isArray(requests) ? requests : [];
  const maximumOutputTokens = positiveInt(maxOutputTokensPerRequest, "maxOutputTokensPerRequest");
  const overhead = Math.max(0, Math.ceil(Number(inputOverheadTokensPerRequest) || 0));
  const imageMultiplier = Math.max(1, Number(imageTokenSafetyMultiplier) || 1);
  // Text uses UTF-8 bytes as a conservative token upper bound. Inline images
  // are billed as image tiles rather than base64 text, so count their decoded
  // dimensions with Google's published 258-token/768px tile rule. Unknown or
  // malformed image data falls back to its encoded byte length. Standard
  // (non-Batch) rates add 2x price headroom over the Batch endpoint.
  const maximumInputTokens = items.reduce(
    (sum, request) => {
      const analyzed = analyzeGeminiRequestInput(request);
      return sum + analyzed.textBytes + Math.ceil(analyzed.imageTokens * imageMultiplier) + overhead;
    },
    0,
  );
  return estimateGeminiCostUsd(
    model,
    {
      prompt_tokens: maximumInputTokens,
      candidates_tokens: maximumOutputTokens * items.length,
    },
    "standard",
  );
}

export function analyzeGeminiRequestInput(request) {
  let imageTokens = 0;
  const scrubbed = scrubInlineImageData(request, (inlineData) => {
    const encoded = typeof inlineData?.data === "string" ? inlineData.data : "";
    if (!encoded) return;
    const buffer = Buffer.from(encoded, "base64");
    const dimensions = imageDimensions(buffer, inlineData?.mimeType || inlineData?.mime_type);
    imageTokens += dimensions
      ? geminiImageTokens(dimensions.width, dimensions.height)
      : Buffer.byteLength(encoded, "utf8");
  });
  return {
    textBytes: Buffer.byteLength(JSON.stringify(scrubbed ?? {}), "utf8"),
    imageTokens,
  };
}

function scrubInlineImageData(value, observeImage) {
  if (Array.isArray(value)) return value.map((item) => scrubInlineImageData(item, observeImage));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === "inlineData" || key === "inline_data") && child && typeof child === "object") {
      observeImage(child);
      next[key] = { ...child, data: "" };
    } else {
      next[key] = scrubInlineImageData(child, observeImage);
    }
  }
  return next;
}

function geminiImageTokens(width, height) {
  const safeWidth = Math.max(1, Math.ceil(Number(width) || 0));
  const safeHeight = Math.max(1, Math.ceil(Number(height) || 0));
  if (safeWidth <= 384 && safeHeight <= 384) return 258;
  return Math.ceil(safeWidth / 768) * Math.ceil(safeHeight / 768) * 258;
}

function imageDimensions(buffer, mimeType = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  const mime = cleanText(mimeType).toLowerCase();
  if (mime.includes("png") || buffer.subarray(1, 4).toString("ascii") === "PNG") {
    if (buffer.length < 24) return null;
    return validDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (mime.includes("webp") || buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return webpDimensions(buffer);
  }
  if (mime.includes("jpeg") || mime.includes("jpg") || (buffer[0] === 0xff && buffer[1] === 0xd8)) {
    return jpegDimensions(buffer);
  }
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) {
      return validDimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const kind = buffer.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    return validDimensions(readUInt24LE(buffer, 24) + 1, readUInt24LE(buffer, 27) + 1);
  }
  if (kind === "VP8 " && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return validDimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return validDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function validDimensions(width, height) {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
}

export function usdToMicroUsd(value, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid USD amount: ${value}`);
  return Math.max(minimum, Math.round(number * 1_000_000));
}

export function microUsdToUsd(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) / 1_000_000 : 0;
}

function normalizeBudgetStatus(value) {
  const object = objectValue(value);
  const capMicro = numericField(object, "cap_micro_usd", "effective_cap_micro_usd");
  const reservedMicro = numericField(object, "reserved_micro_usd");
  const spentMicro = numericField(object, "spent_micro_usd");
  const remainingMicro = numericField(
    object,
    "remaining_micro_usd",
    null,
    Math.max(0, capMicro - reservedMicro - spentMicro),
  );
  return {
    ...object,
    lane_key: cleanText(object.lane_key),
    cap_micro_usd: capMicro,
    reserved_micro_usd: reservedMicro,
    spent_micro_usd: spentMicro,
    remaining_micro_usd: remainingMicro,
    cap_usd: microUsdToUsd(capMicro),
    reserved_usd: microUsdToUsd(reservedMicro),
    spent_usd: microUsdToUsd(spentMicro),
    remaining_usd: microUsdToUsd(remainingMicro),
    reset_at: cleanText(object.reset_at) || null,
    configuration_source: cleanText(object.configuration_source || object.source) || "database_policy",
  };
}

async function rpcOne(supabase, name, params) {
  if (!supabase?.rpc) throw new Error("A Supabase service client is required for Gemini spend accounting.");
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return Array.isArray(data) ? data[0] || null : data;
}

function assertLane(value) {
  if (!Object.values(GEMINI_PAID_LANES).includes(value)) {
    throw new Error(`Unsupported Gemini paid lane: ${value || "(missing)"}`);
  }
}

function numericField(object, key, alternate = null, fallback = 0) {
  const number = Number(object[key] ?? (alternate ? object[alternate] : undefined));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredText(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return text.toLowerCase();
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return Math.floor(number);
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}
