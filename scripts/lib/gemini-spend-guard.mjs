import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function geminiSpendGuardStatus({
  archiveRoot,
  dailyCostCapUsd,
  date = new Date().toISOString().slice(0, 10),
}) {
  const block = readGeminiBillingBlock(archiveRoot);
  const daily = summarizeGeminiUsageForDate(archiveRoot, date);
  const cap = nonNegativeNumber(dailyCostCapUsd, 0);
  const capReached = cap > 0 && daily.estimated_cost_usd >= cap;
  return {
    allowed: !block && !capReached,
    block,
    blocked: Boolean(block),
    cap,
    capReached,
    date,
    today: daily,
  };
}

export function markGeminiBillingBlocked({
  archiveRoot,
  kind,
  model,
  httpStatus,
  providerStatus,
  message,
}) {
  const blockedAt = new Date().toISOString();
  const path = geminiBillingBlockPath(archiveRoot);
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    provider: "gemini",
    blocked_at: blockedAt,
    date: blockedAt.slice(0, 10),
    kind: cleanText(kind),
    model: cleanText(model),
    http_status: Number(httpStatus) || null,
    provider_status: cleanText(providerStatus),
    message: cleanText(message),
    note: "AwardPing stops Gemini API workers when billing or prepayment credits are blocked. Remove this file after restoring billing if you want workers to resume.",
  };
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function readGeminiBillingBlock(archiveRoot) {
  const path = geminiBillingBlockPath(archiveRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? { ...parsed, path } : { path };
  } catch {
    return { path };
  }
}

export function summarizeGeminiUsageForDate(archiveRoot, date) {
  const total = {
    calls: 0,
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
    estimated_cost_usd: 0,
  };
  const month = String(date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const monthPath = join(archiveRoot, "usage", `gemini-usage-${month}.jsonl`);
  const summary = readFreshGeminiUsageSummary(archiveRoot, month, monthPath);
  const summaryDay = summary?.daily?.find((day) => day.date === date);
  if (summaryDay) {
    return {
      calls: nonNegativeInt(summaryDay.calls, 0),
      prompt_tokens: nonNegativeInt(summaryDay.prompt_tokens, 0),
      candidates_tokens: nonNegativeInt(summaryDay.candidates_tokens, 0),
      total_tokens: nonNegativeInt(summaryDay.total_tokens, 0),
      thoughts_tokens: nonNegativeInt(summaryDay.thoughts_tokens, 0),
      cached_content_tokens: nonNegativeInt(summaryDay.cached_content_tokens, 0),
      estimated_cost_usd: roundUsd(summaryDay.estimated_cost_usd),
    };
  }

  if (!existsSync(monthPath)) return total;

  for (const line of readFileSync(monthPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.provider !== "gemini") continue;
    const recordDate = record.date || String(record.used_at || "").slice(0, 10);
    if (recordDate !== date) continue;
    const usage = normalizeGeminiUsage(record.usage);
    total.calls += 1;
    total.prompt_tokens += usage.prompt_tokens;
    total.candidates_tokens += usage.candidates_tokens;
    total.total_tokens += usage.total_tokens;
    total.thoughts_tokens += usage.thoughts_tokens;
    total.cached_content_tokens += usage.cached_content_tokens;
    total.estimated_cost_usd = roundUsd(
      total.estimated_cost_usd + nonNegativeNumber(record.estimated_cost_usd, 0),
    );
  }
  return total;
}

function readFreshGeminiUsageSummary(archiveRoot, month, monthPath) {
  const summaryPath = join(archiveRoot, "usage", `gemini-usage-${month}-summary.json`);
  if (!existsSync(summaryPath)) return null;
  try {
    if (existsSync(monthPath) && statSync(summaryPath).mtimeMs < statSync(monthPath).mtimeMs) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(summaryPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function geminiBillingBlockPath(archiveRoot) {
  return join(archiveRoot, "usage", "gemini-billing-blocked.json");
}

function normalizeGeminiUsage(value) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    prompt_tokens: nonNegativeInt(object.prompt_tokens ?? object.promptTokenCount, 0),
    candidates_tokens: nonNegativeInt(object.candidates_tokens ?? object.candidatesTokenCount, 0),
    total_tokens: nonNegativeInt(object.total_tokens ?? object.totalTokenCount, 0),
    thoughts_tokens: nonNegativeInt(object.thoughts_tokens ?? object.thoughtsTokenCount, 0),
    cached_content_tokens: nonNegativeInt(
      object.cached_content_tokens ?? object.cachedContentTokenCount,
      0,
    ),
  };
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function roundUsd(value) {
  return Math.round(nonNegativeNumber(value, 0) * 1_000_000) / 1_000_000;
}
