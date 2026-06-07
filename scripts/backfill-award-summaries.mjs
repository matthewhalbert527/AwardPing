#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as cheerio from "cheerio";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, args.env) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = args.apply === true || args.apply === "true";
const force = args.force === true || args.force === "true";
const limit = positiveInt(args.limit, 0);
const concurrency = positiveInt(args.concurrency, 3);
const timeoutMs = positiveInt(args["timeout-ms"], 20_000);
const delayMs = nonNegativeInt(args["delay-ms"], 200);
const minExistingSummaryChars = positiveInt(args["min-existing-summary-chars"], 80);
const minSourceTextChars = positiveInt(args["min-source-text-chars"], 450);
const sourceTextChars = positiveInt(args["source-text-chars"], 9_000);
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "gemini").toLowerCase();
const aiProvider =
  requestedAiProvider === "auto"
    ? env.GEMINI_API_KEY
      ? "gemini"
      : env.OPENAI_API_KEY
        ? "openai"
        : "false"
    : requestedAiProvider;
const aiSummaries =
  args.ai !== "false" &&
  env.LOCAL_WORKER_AI_SUMMARIES !== "false" &&
  ((aiProvider === "gemini" && Boolean(env.GEMINI_API_KEY)) ||
    (aiProvider === "openai" && Boolean(env.OPENAI_API_KEY)));
const allowHeuristicApply = args["allow-heuristic-apply"] === "true";
const outputPath =
  args.output ||
  join(root, "reports", `summary-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const placeholderSummaryPatterns = [
  /^official pages? for\b/i,
  /^default nationally competitive award\b/i,
  /^no official source pages?\b/i,
  /^source pages? for\b/i,
  /^award pages?\b/i,
  /^scholarship$/i,
  /^fellowship$/i,
  /^award$/i,
];

const trailingFragmentPattern =
  /\b(a|an|and|as|by|for|from|in|of|on|or|the|to|with)$/i;

const nonAwardDescriptionPatterns = [
  /^the\s+.+?\s+page\s+(added|removed|changed|provides|offers|contains|includes|lists)\b/i,
  /\b(application status has changed|added the following wording|removed the following wording|changed wording from)\b/i,
  /\b(provides?|offers?|contains?|features?|lists?|includes?)\s+(information|details|resources|guidance|source pages?|official pages?)\b/i,
  /\b(official|source)\s+pages?\b/i,
  /\b(skip to main|toggle menu|privacy policy|cookie policy|search for:|read more|learn more|click here)\b/i,
  /https?:\/\//i,
];

const supabase = createSupabaseClient();
const [awards, sources, snapshots] = await Promise.all([
  loadAll("shared_awards", "id,name,official_homepage,summary,status,updated_at"),
  loadAll(
    "shared_award_sources",
    "id,shared_award_id,url,title,page_type,confidence,last_error,updated_at",
  ),
  loadAll(
    "shared_award_source_snapshots",
    "id,shared_award_id,shared_award_source_id,source_url,source_title,source_page_type,text_sample,created_at",
  ),
]);

const activeAwards = awards.filter((award) => award.status === "active");
const activeAwardIds = new Set(activeAwards.map((award) => award.id));
const activeSources = sources.filter((source) => activeAwardIds.has(source.shared_award_id));
const sourcesByAwardId = groupBy(activeSources, (source) => source.shared_award_id);
const snapshotsBySourceId = newestSnapshotsByKey(
  snapshots.filter((snapshot) => activeAwardIds.has(snapshot.shared_award_id)),
  (snapshot) => snapshot.shared_award_source_id,
);
const snapshotsByAwardUrl = newestSnapshotsByKey(
  snapshots.filter((snapshot) => activeAwardIds.has(snapshot.shared_award_id)),
  (snapshot) => `${snapshot.shared_award_id}\n${canonicalUrlKey(snapshot.source_url)}`,
);

const targets = activeAwards
  .filter((award) =>
    force || summaryNeedsBackfill(award.summary, { minLength: minExistingSummaryChars }),
  )
  .sort((left, right) => left.name.localeCompare(right.name));
const limitedTargets = limit > 0 ? targets.slice(0, limit) : targets;

console.log(
  `Backfilling ${limitedTargets.length}/${targets.length} award summaries; apply=${apply}; force=${force}; ai=${aiSummaries ? aiProvider : "false"}; env=${envPath}.`,
);

if (apply && !aiSummaries && !allowHeuristicApply) {
  throw new Error(
    "Refusing to apply heuristic-only summaries. Add GEMINI_API_KEY or OPENAI_API_KEY, or pass --allow-heuristic-apply=true after reviewing a dry-run report.",
  );
}

const stats = {
  awardsTargeted: limitedTargets.length,
  accepted: 0,
  applied: 0,
  skippedNoSourceText: 0,
  skippedWeakSummary: 0,
  failed: 0,
};
const results = [];
const updates = [];

await mapWithConcurrency(limitedTargets, concurrency, async (award) => {
  try {
    const source = await selectSourceText(award);
    if (!source) {
      stats.skippedNoSourceText += 1;
      results.push(resultRow(award, "no_source_text", null, null, "No source text was available."));
      console.log(`MISS   ${award.name} | no source text`);
      return;
    }

    const generated = await generateAwardSummary(award, source);
    const summary = cleanGeneratedSummary(generated);
    if (!isUsefulBackfilledSummary(summary)) {
      stats.skippedWeakSummary += 1;
      results.push(resultRow(award, "weak_summary", source, summary, "Generated summary did not pass quality checks."));
      console.log(`REVIEW ${award.name} | weak summary`);
      return;
    }

    stats.accepted += 1;
    updates.push({
      id: award.id,
      name: award.name,
      previousSummary: award.summary,
      summary,
      sourceUrl: source.url,
      sourceTitle: source.title,
      sourceKind: source.kind,
    });
    results.push(resultRow(award, "accepted", source, summary, null));
    console.log(`READY  ${award.name}`);

    if (delayMs > 0) await sleep(delayMs);
  } catch (error) {
    stats.failed += 1;
    results.push(
      resultRow(
        award,
        "failed",
        null,
        null,
        error instanceof Error ? error.message : String(error),
      ),
    );
    console.log(`FAILED ${award.name} | ${error instanceof Error ? error.message : String(error)}`);
  }
});

if (apply && updates.length) {
  for (const batch of chunk(updates, 50)) {
    await Promise.all(
      batch.map(async (row) => {
        const { error } = await supabase
          .from("shared_awards")
          .update({ summary: row.summary, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw new Error(`shared_awards summary update failed for ${row.name}: ${error.message}`);
      }),
    );
    stats.applied += batch.length;
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  apply,
  ai: aiSummaries ? aiProvider : "false",
  options: {
    limit,
    concurrency,
    timeoutMs,
    minExistingSummaryChars,
    minSourceTextChars,
    sourceTextChars,
    allowHeuristicApply,
  },
  stats: {
    ...stats,
    activeAwards: activeAwards.length,
    targetsTotal: targets.length,
    rowsReady: updates.length,
  },
  updates,
  results,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ outputPath, ...report.stats }, null, 2));

async function selectSourceText(award) {
  const sortedSources = [...(sourcesByAwardId.get(award.id) || [])].sort(compareSources);
  for (const source of sortedSources) {
    const snapshot =
      snapshotsBySourceId.get(source.id) ||
      snapshotsByAwardUrl.get(`${award.id}\n${canonicalUrlKey(source.url)}`);
    const snapshotText = normalizeText(snapshot?.text_sample || "");
    if (snapshotText.length >= minSourceTextChars) {
      return {
        kind: "snapshot",
        title: source.title || snapshot?.source_title || "Source page",
        url: source.url,
        pageType: source.page_type,
        text: snapshotText.slice(0, sourceTextChars),
      };
    }
  }

  for (const source of sortedSources.slice(0, 6)) {
    try {
      const fetched = await fetchSourceText(source.url, source.page_type);
      if (fetched.text.length >= minSourceTextChars) {
        return {
          kind: "fetch",
          title: source.title || "Source page",
          url: source.url,
          pageType: source.page_type,
          text: fetched.text.slice(0, sourceTextChars),
        };
      }
    } catch {
      // Stale or blocked source URLs are common in the imported database; try the next source.
    }
  }

  if (award.official_homepage) {
    try {
      const fetched = await fetchSourceText(award.official_homepage, "homepage");
      if (fetched.text.length >= minSourceTextChars) {
        return {
          kind: "homepage_fetch",
          title: "Official homepage",
          url: award.official_homepage,
          pageType: "homepage",
          text: fetched.text.slice(0, sourceTextChars),
        };
      }
    } catch {
      // Leave as no source text; the report keeps this row available for manual source repair.
    }
  }

  const existingSummary = normalizeText(award.summary || "");
  if (canRewriteExistingSummary(existingSummary)) {
    return {
      kind: "existing_summary",
      title: "Existing award summary",
      url: award.official_homepage || sortedSources[0]?.url || "",
      pageType: "other",
      text: existingSummary.slice(0, sourceTextChars),
    };
  }

  return null;
}

async function fetchSourceText(url, pageType) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "AwardPingSummaryBackfill/1.0 (+https://awardping.com)",
      accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8,*/*;q=0.5",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

  const maxBytes = 5 * 1024 * 1024;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error(`${url} exceeded the ${maxBytes} byte limit`);

  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`${url} exceeded the ${maxBytes} byte limit`);

  const isPdf =
    pageType === "pdf" ||
    contentType.includes("application/pdf") ||
    /\.pdf($|\?)/i.test(url);
  const rawText = isPdf ? await extractPdfText(buffer) : extractHtmlText(buffer.toString("utf8"));
  return { text: normalizeText(rawText), contentType };
}

async function extractPdfText(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ first: 15 });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function extractHtmlText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, nav, footer").remove();
  return $("body").text() || $.root().text();
}

async function generateAwardSummary(award, source) {
  const fallback = heuristicAwardSummary(award, source.text);
  if (!aiSummaries) return fallback;
  if (aiProvider === "openai") return generateWithOpenAI(award, source, fallback);
  return generateWithGemini(award, source, fallback);
}

async function generateWithGemini(award, source, fallback) {
  try {
    const model = args.model || env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: [
                  "You write concise award descriptions for a scholarship advising database.",
                  "Describe the award, fellowship, grant, internship, or program itself, not the web page.",
                  "Use only the supplied source text and fallback summary.",
                  "Do not invent dates, award amounts, eligibility rules, or deadlines.",
                  "Do not mention websites, pages, updates, source text, navigation, forms, or application instructions unless they define the award.",
                ].join(" "),
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    `Award: ${award.name}`,
                    `Source title: ${source.title}`,
                    `Source URL: ${source.url}`,
                    `Fallback summary: ${fallback}`,
                    "",
                    `Source excerpt:\n${source.text}`,
                    "",
                    [
                      "Return exactly one complete sentence of 16-32 words, maximum 220 characters.",
                      "The sentence must say what the award funds, supports, recognizes, or provides and who it is for.",
                      "Do not start with 'This page', 'The page', 'The website', or a source-page title.",
                      "No bullets. No quotation marks.",
                    ].join(" "),
                  ].join("\n"),
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.05, maxOutputTokens: 90 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return fallback;
    const data = await response.json();
    return extractGeminiText(data) || fallback;
  } catch {
    return fallback;
  }
}

async function generateWithOpenAI(award, source, fallback) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model || env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini",
        instructions: [
          "Write one concise award description for a scholarship advising database.",
          "Describe the award itself, not the web page.",
          "Use only the source text and fallback summary.",
          "Do not mention websites, pages, updates, source text, navigation, forms, or application instructions unless they define the award.",
        ].join(" "),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  `Award: ${award.name}`,
                  `Source title: ${source.title}`,
                  `Source URL: ${source.url}`,
                  `Fallback summary: ${fallback}`,
                  "",
                  `Source excerpt:\n${source.text}`,
                  "",
                  "Return exactly one complete sentence of 16-32 words, maximum 220 characters, describing what the award funds or supports and who it is for.",
                ].join("\n"),
              },
            ],
          },
        ],
        max_output_tokens: 120,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    return extractOpenAIText(data) || fallback;
  } catch {
    return fallback;
  }
}

function heuristicAwardSummary(award, text) {
  const clean = normalizeText(text);
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 60 && sentence.length <= 340);
  const tokens = significantTokens(award.name);
  const scored = sentences
    .map((sentence) => ({
      sentence,
      score:
        countTokenHits(tokens, sentence.toLowerCase()) +
        (/\b(fellowship|scholarship|award|grant|funds?|supports?|provides?|eligible|applicants?)\b/i.test(
          sentence,
        )
          ? 3
          : 0) -
        (/\b(cookie|privacy|subscribe|navigation|menu|footer)\b/i.test(sentence) ? 4 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.sentence.length - right.sentence.length);
  const best = scored.find((item) => item.score > 0)?.sentence || sentences[0] || award.name;
  return truncateAtWord(best, 280);
}

function cleanGeneratedSummary(value) {
  const clean = normalizeText(value)
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/^summary:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  const firstLine = clean.split(/\n/)[0]?.trim() || "";
  const summary = truncateAtWord(firstLine, 280).replace(/\s+([,.])/g, "$1");
  if (!summary || /[.!?]$/.test(summary)) return summary;
  return `${summary}.`;
}

function isUsefulBackfilledSummary(summary) {
  const clean = normalizeSummaryBackfillText(summary);
  const normalized = clean.toLowerCase();
  const words = clean.split(/\s+/).filter(Boolean);
  return (
    clean.length >= 70 &&
    clean.length <= 280 &&
    words.length >= 12 &&
    words.length <= 42 &&
    sentenceCount(clean) <= 2 &&
    !placeholderSummaryPatterns.some((pattern) => pattern.test(clean)) &&
    !trailingFragmentPattern.test(clean) &&
    !nonAwardDescriptionPatterns.some((pattern) => pattern.test(clean)) &&
    !normalized.includes("official pages for") &&
    !normalized.includes("this page") &&
    !normalized.includes("the website") &&
    !normalized.includes("source page") &&
    !normalized.includes("click here") &&
    !normalized.includes("learn more")
  );
}

function canRewriteExistingSummary(summary) {
  const normalized = summary.toLowerCase();
  return (
    summary.length >= 100 &&
    summary.length <= 2_000 &&
    !placeholderSummaryPatterns.some((pattern) => pattern.test(summary)) &&
    !nonAwardDescriptionPatterns.some((pattern) => pattern.test(summary)) &&
    !normalized.includes("official pages for") &&
    !normalized.includes("source page") &&
    !normalized.includes("this page") &&
    !normalized.includes("the website")
  );
}

function summaryNeedsBackfill(summary, options = {}) {
  const minLength = options.minLength ?? 80;
  const clean = normalizeSummaryBackfillText(summary);
  if (!clean) return true;
  if (clean.length < minLength) return true;
  if (clean.length > 340) return true;
  if (placeholderSummaryPatterns.some((pattern) => pattern.test(clean))) return true;
  if (trailingFragmentPattern.test(clean)) return true;
  if (nonAwardDescriptionPatterns.some((pattern) => pattern.test(clean))) return true;
  if (sentenceCount(clean) > 2 && clean.length > 220) return true;
  return false;
}

function normalizeSummaryBackfillText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function sentenceCount(value) {
  const protectedValue = value.replace(
    /\b(U\.S|U\.K|Ph\.D|M\.D|D\.C|D\.Phil|Ed\.D|J\.D|B\.A|M\.A|M\.S|B\.S|Dr|Mr|Ms|Mrs)\./g,
    (match) => match.replace(/\./g, ""),
  );
  const matches = protectedValue.match(/[.!?](?=\s|$)/g);
  return matches?.length || 0;
}

function compareSources(left, right) {
  const typeDelta = pageTypeRank(left.page_type) - pageTypeRank(right.page_type);
  if (typeDelta !== 0) return typeDelta;
  const errorDelta = Number(Boolean(left.last_error)) - Number(Boolean(right.last_error));
  if (errorDelta !== 0) return errorDelta;
  return Number(right.confidence || 0) - Number(left.confidence || 0);
}

function pageTypeRank(pageType) {
  const ranks = {
    homepage: 0,
    application: 1,
    eligibility: 2,
    requirements: 3,
    deadline: 4,
    faq: 5,
    pdf: 6,
    other: 7,
  };
  return ranks[pageType] ?? 9;
}

function resultRow(award, status, source, summary, error) {
  return {
    awardId: award.id,
    awardName: award.name,
    status,
    previousSummary: award.summary || null,
    summary,
    source: source
      ? {
          url: source.url,
          title: source.title,
          pageType: source.pageType,
          kind: source.kind,
        }
      : null,
    error,
  };
}

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ")
      .trim() || ""
  );
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return (
    data?.output
      ?.flatMap((item) => item.content || [])
      ?.map((part) => part.text || "")
      ?.join(" ")
      ?.trim() || ""
  );
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseQueryWithRetry(
      () => supabase.from(table).select(select).range(from, from + 999),
      `${table}:${from}-${from + 999}`,
    );
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function supabaseQueryWithRetry(makeQuery, label) {
  const attempts = 4;
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await makeQuery();
      lastResult = result;
      if (!result.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }

    if (attempt === attempts || !isTransientSupabaseError(lastError)) break;
    const backoffMs = 500 * attempt;
    console.warn(
      `Retrying Supabase read ${label} after transient error (${attempt}/${attempts}): ${errorMessage(
        lastError,
      )}`,
    );
    await sleep(backoffMs);
  }

  return (
    lastResult || {
      data: null,
      error: {
        message: errorMessage(lastError),
      },
    }
  );
}

function isTransientSupabaseError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
}

function errorMessage(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error.message === "string") return error.message;
  if (typeof error.details === "string") return error.details;
  return String(error);
}

function createSupabaseClient() {
  if (
    env.NEXT_PUBLIC_SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    !env.NEXT_PUBLIC_SUPABASE_URL.includes("127.0.0.1")
  ) {
    return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const projectRef = readLinkedProjectRef();
  if (!projectRef) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or link Supabase.");
  }

  const keys = JSON.parse(
    execFileSync("npx", ["supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], {
      encoding: "utf8",
      cwd: root,
    }),
  );
  const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
  if (!serviceRoleKey) throw new Error(`Could not read service_role key for ${projectRef}.`);
  return createSupabaseServiceClient(`https://${projectRef}.supabase.co`, serviceRoleKey);
}

function readLinkedProjectRef() {
  try {
    return readFileSync(resolve(root, "supabase/.temp/project-ref"), "utf8").trim();
  } catch {
    return "";
  }
}

function newestSnapshotsByKey(rows, getKey) {
  const sorted = [...rows].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
  );
  const grouped = new Map();
  for (const row of sorted) {
    const key = getKey(row);
    if (!key || grouped.has(key)) continue;
    grouped.set(key, row);
  }
  return grouped;
}

function groupBy(rows, getKey) {
  const grouped = new Map();
  for (const row of rows) {
    const key = getKey(row);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return grouped;
}

function canonicalUrlKey(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\.aspx$/i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();
    return `${hostname}${pathname || "/"}`;
  } catch {
    return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function significantTokens(value) {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "award",
    "awards",
    "for",
    "from",
    "in",
    "of",
    "program",
    "scholarship",
    "scholarships",
    "the",
    "to",
    "with",
  ]);
  return [
    ...new Set(
      String(value || "")
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.filter((token) => token.length >= 4 && !stopwords.has(token)) || [],
    ),
  ];
}

function countTokenHits(tokens, text) {
  let hits = 0;
  for (const token of tokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(value, maxLength) {
  const clean = normalizeText(value);
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > 80 ? boundary : maxLength).trim()}...`;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(values, workerCount, callback) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      await callback(current);
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const raw = value.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      parsed[key] = rest.join("=");
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      index += 1;
    } else {
      parsed[raw] = true;
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  try {
    const envFile = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      envFile[key] = value;
    }
    return envFile;
  } catch {
    return {};
  }
}
