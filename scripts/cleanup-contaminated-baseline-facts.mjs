#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const apply = boolArg(args.apply, false);
const supabase = createSupabaseClient();

const contaminatedSourcePatterns = [
  /NACADA/i,
  /academic advising/i,
  /advisor appreciation/i,
  /boater comment form/i,
  /change of major advising/i,
  /driving towards degree/i,
  /four forward/i,
  /hubertus w\.? v\.? willems/i,
  /munson institute/i,
  /mystic seaport/i,
  /positive outreach interventions/i,
  /typical advising session/i,
];

const sources = await loadAll(
  "shared_award_sources",
  "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model",
);
const contaminatedSources = sources.filter((source) => {
  const text = `${source.display_title || ""}\n${source.page_description || ""}\n${JSON.stringify(source.page_metadata || {})}`;
  return contaminatedSourcePatterns.some((pattern) => pattern.test(text));
});

if (apply) {
  for (const source of contaminatedSources) {
    const metadata = jsonObjectOrEmpty(source.page_metadata);
    const displayTitle = cleanPageTitle(metadata.page_title) || cleanText(source.title) || "Source page";
    const { error } = await supabase
      .from("shared_award_sources")
      .update({
        display_title: displayTitle,
        page_description: null,
        page_metadata: {
          version: 1,
          kind: "source_page_outline",
          final_url: metadata.final_url || source.url,
          page_title: metadata.page_title || source.title || null,
          baseline_facts_rejected: true,
          rejection_reason: "cleanup_contaminated_baseline_facts",
          cleaned_at: new Date().toISOString(),
        },
        page_metadata_generated_at: new Date().toISOString(),
        page_metadata_model: "cleanup-contaminated-baseline-facts",
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id);
    if (error) throw new Error(`source cleanup failed for ${source.id}: ${error.message}`);
  }

  const { error: clearSummaryError } = await supabase
    .from("shared_awards")
    .update({
      summary: null,
      public_facts: {},
      public_facts_generated_at: null,
      public_facts_model: null,
      structure_scan_error: "Generated baseline details were cleared after contamination was detected; queued for re-extraction.",
      updated_at: new Date().toISOString(),
    })
    .ilike("summary", "%Baseline detail confidence:%");
  if (clearSummaryError) throw new Error(`generated summary cleanup failed: ${clearSummaryError.message}`);

  const mitchellFacts = {
    overview:
      "The US-Ireland Alliance Scholarship Program, formerly known through the Mitchell Scholarship pages, is a national competitive scholarship for one academic year of postgraduate study in Ireland or Northern Ireland.",
    deadline: "Currently not open; the official site says selection of future classes was paused in March 2024.",
    opening_date: null,
    award_amounts: ["Tuition", "Accommodation", "Stipend for living expenses and travel"],
    eligibility: [
      "U.S. citizen",
      "Between 18 and 30 years old on October 1 in the application year",
      "Bachelor's degree from an accredited college or university before beginning study",
    ],
    requirements: [
      "Applicants are judged on scholarship, leadership, and sustained commitment to community and public service",
    ],
    application_materials: [
      "Online application",
      "Four letters of recommendation",
      "Institutional endorsement for undergraduate applicants",
    ],
    how_to_apply: ["Use the official online application system when the scholarship is open"],
    important_dates: ["Selection of future classes paused in March 2024"],
    documents: ["Official application preview PDF"],
    contacts: ["Trina Vargo, Founder & President, listed on the official US-Ireland Alliance site"],
    academic_levels: ["Graduate"],
    disciplines: ["Any discipline offered by institutions in Ireland and Northern Ireland"],
    citizenship: ["U.S. citizen"],
    sources_used: ["The US-Ireland Alliance Scholarship", "Am I Eligible?", "Application Process"],
    confidence: "high",
  };

  const { error: mitchellError } = await supabase
    .from("shared_awards")
    .update({
      name: "US-Ireland Alliance Scholarship (formerly Mitchell Scholarship)",
      summary:
        "The US-Ireland Alliance Scholarship Program is a national competitive scholarship for U.S. citizens ages 18 to 30 to pursue one academic year of postgraduate study in Ireland or Northern Ireland. The official site says selection of future classes was paused in March 2024 and the scholarship is currently not open.",
      public_facts: mitchellFacts,
      public_facts_generated_at: new Date().toISOString(),
      public_facts_model: "manual-mitchell-cleanup",
      structure_scan_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", "8156893a-22b7-4c83-8584-5fab9f174486");
  if (mitchellError) throw new Error(`Mitchell cleanup failed: ${mitchellError.message}`);
}

const generatedSummaryCount = await countGeneratedSummaries();
console.log(
  JSON.stringify(
    {
      apply,
      contaminatedSources: contaminatedSources.length,
      contaminatedAwardIds: [...new Set(contaminatedSources.map((source) => source.shared_award_id))].length,
      generatedSummariesWithBaselineMarker: generatedSummaryCount,
      examples: contaminatedSources.slice(0, 10).map((source) => ({
        id: source.id,
        awardId: source.shared_award_id,
        title: source.title,
        badDisplayTitle: source.display_title,
      })),
    },
    null,
    2,
  ),
);

async function countGeneratedSummaries() {
  const { count, error } = await supabase
    .from("shared_awards")
    .select("id", { count: "exact", head: true })
    .ilike("summary", "%Baseline detail confidence:%");
  if (error) throw new Error(`count generated summaries failed: ${error.message}`);
  return count || 0;
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanPageTitle(value) {
  return cleanText(value)
    .replace(/\s+[|-]\s+US-Ireland Alliance$/i, "")
    .replace(/\s+[|-]\s+AwardPing$/i, "")
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function createSupabaseClient() {
  const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const clean = arg.replace(/^--/, "");
    const [key, ...rest] = clean.split("=");
    parsed[key] = rest.length ? rest.join("=") : true;
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return /^(1|true|yes)$/i.test(String(value));
}
