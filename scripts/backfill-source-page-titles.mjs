#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, args.env) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = args.apply === true || args.apply === "true";
const limit = positiveInt(args.limit, 0);
const awardLike = String(args["award-like"] || "").trim().toLowerCase();
const urlLike = String(args["url-like"] || "").trim().toLowerCase();
const sourceId = String(args["source-id"] || "").trim();
const model = args.model || env.GEMINI_TITLE_MODEL || env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
if (!env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is required to generate source page titles.");
}

const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log(
  `Backfilling source page titles; apply=${apply}; limit=${limit || "all"}; model=${model}; awardLike=${awardLike || "any"}; urlLike=${urlLike || "any"}; sourceId=${sourceId || "any"}.`,
);

const sources = await loadSources();
const duplicateTitleKeys = duplicateTitleKeysByAward(sources);
const candidates = sources.filter((source) => shouldImproveSourceTitle(source, duplicateTitleKeys));
const limited = limit > 0 ? candidates.slice(0, limit) : candidates;
const snapshots = await loadLatestSnapshots(limited.map((source) => source.id));
let updated = 0;
let skipped = 0;

for (const source of limited) {
  const snapshot = snapshots.get(source.id);
  const text = snapshot?.text_sample || "";
  if (!text || text.length < 120) {
    skipped += 1;
    console.log(`SKIP ${source.shared_awards?.name || source.title} | no useful snapshot text | ${source.url}`);
    continue;
  }

  const nextTitle = await generateTitle(source, text);
  if (!nextTitle || normalizeTitleKey(nextTitle) === normalizeTitleKey(source.title)) {
    skipped += 1;
    console.log(`KEEP ${source.shared_awards?.name || source.title} | ${source.title} | ${source.url}`);
    continue;
  }

  console.log(`${apply ? "UPDATE" : "DRY"} ${source.shared_awards?.name || "Award"} | ${source.title} -> ${nextTitle} | ${source.url}`);
  if (apply) {
    const { error } = await supabase
      .from("shared_award_sources")
      .update({ title: nextTitle, updated_at: new Date().toISOString() })
      .eq("id", source.id);
    if (error) throw error;
    updated += 1;
  }
}

console.log(JSON.stringify({ scanned: sources.length, targeted: limited.length, updated, skipped }, null, 2));

async function loadSources() {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select("id, shared_award_id, url, title, page_type, updated_at, shared_awards!inner(id, name, status)")
      .eq("shared_awards.status", "active")
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows.filter((source) => {
    if (sourceId && source.id !== sourceId) return false;
    if (awardLike && !String(source.shared_awards?.name || "").toLowerCase().includes(awardLike)) return false;
    if (urlLike && !String(source.url || "").toLowerCase().includes(urlLike)) return false;
    return true;
  });
}

async function loadLatestSnapshots(sourceIds) {
  const snapshots = new Map();
  const chunkSize = 300;

  for (let index = 0; index < sourceIds.length; index += chunkSize) {
    const ids = sourceIds.slice(index, index + chunkSize);
    const { data, error } = await supabase
      .from("shared_award_source_snapshots")
      .select("shared_award_source_id, text_sample, created_at")
      .in("shared_award_source_id", ids)
      .order("created_at", { ascending: false });
    if (error) throw error;

    for (const row of data || []) {
      if (row.shared_award_source_id && !snapshots.has(row.shared_award_source_id)) {
        snapshots.set(row.shared_award_source_id, row);
      }
    }
  }

  return snapshots;
}

async function generateTitle(source, text) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: [
                "Create a concise title for one source page in an award-source outline UI.",
                "Return JSON only: {\"title\":\"...\"}.",
                "Use 2-7 words, Title Case, and make it specific to this exact page.",
                "Do not use generic labels like Apply, Learn More, Here, Guidelines, Application, or Source Page.",
                "Do not simply rewrite the URL. Infer the page's role from the page text.",
                "Prefer labels such as Application Instructions, Eligibility Requirements, Selection Criteria, Recommendation Guidance, FAQ, Deadline Calendar, Program Overview, Registration Form, or a specific document/topic title.",
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
                  `Award: ${source.shared_awards?.name || "Unknown award"}`,
                  `Stored title: ${source.title || ""}`,
                  `Page type: ${source.page_type || "unknown"}`,
                  `URL: ${source.url}`,
                  "",
                  "Page text excerpt:",
                  text.slice(0, 5000),
                ].join("\n"),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.05,
          maxOutputTokens: 80,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      }),
      signal: AbortSignal.timeout(18_000),
    },
  );

  if (!response.ok) return null;
  const data = await response.json();
  return cleanGeneratedSourceTitle(extractGeminiText(data));
}

function cleanGeneratedSourceTitle(text) {
  const parsed = parseJsonObjectFromText(text);
  const clean = normalizeText(String(parsed?.title || text || ""))
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!clean || isGenericTitle(clean) || looksLikeUrlTitle(clean)) return null;
  if (clean.split(/\s+/).length > 9) return null;
  return clean
    .split(/\s+/)
    .map((word) =>
      /^(FAQ|PDF|NSF|GRFP|USA|US|UK|PHD|NASA|R&D|AAAS)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function shouldImproveSourceTitle(source, duplicateTitleKeys) {
  const clean = normalizeText(source.title || "");
  if (!clean || isGenericTitle(clean) || looksLikeUrlTitle(clean)) return true;
  if (duplicateTitleKeys.has(`${source.shared_award_id}:${normalizeTitleKey(clean)}`) && clean.split(/\s+/).length <= 3) {
    return true;
  }
  return false;
}

function duplicateTitleKeysByAward(sources) {
  const counts = new Map();
  for (const source of sources) {
    const key = `${source.shared_award_id}:${normalizeTitleKey(source.title)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function isGenericTitle(value) {
  return /^(apply|applications?|learn more|read more|view more|more information|details?|click here|here|tips here\.?|guidelines?|forms?|download|source page|homepage|other source)$/i.test(
    normalizeText(value),
  );
}

function looksLikeUrlTitle(value) {
  const clean = normalizeText(value);
  return /^https?:\/\//i.test(clean) || /^\/[^/]+(?:\/[^/]+)*\/?$/i.test(clean) || /^[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/i.test(clean);
}

function normalizeTitleKey(value) {
  return normalizeText(String(value || "")).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

function parseJsonObjectFromText(text) {
  try {
    return JSON.parse(String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    return null;
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    const trimmed = String(value || "");
    if (!trimmed.startsWith("--")) continue;
    const [key, rawValue] = trimmed.slice(2).split("=");
    parsed[key] = rawValue === undefined ? true : rawValue;
  }
  return parsed;
}

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}
