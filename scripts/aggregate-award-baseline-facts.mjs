#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const limit = limitArg(args.limit, "all");
const applyUpdates = boolArg(args.apply, true);
const force = boolArg(args.force, false);
const awardIdFilter = cleanText(args["award-id"]);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

async function runOnce() {
  mkdirSync(join(root, "reports"), { recursive: true });
  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const reportPath = join(root, "reports", `award-baseline-facts-aggregate-${runStamp}.json`);
  const report = {
    started_at: startedAt,
    finished_at: null,
    status: "running",
    ai_provider: "gemini-api-derived",
    ai_model: "source-page-baseline-facts",
    env_path: envPath,
    options: {
      limit,
      apply: applyUpdates,
      force,
      award_id: awardIdFilter || null,
    },
    loaded_awards: 0,
    source_fact_pages: 0,
    checked: 0,
    extracted: 0,
    applied: 0,
    skipped_existing: 0,
    no_baseline: 0,
    failed: 0,
    errors: [],
    saved_awards: [],
  };

  const runId = await startWorkerRun(report);
  try {
    const awards = await loadAwards();
    report.loaded_awards = awards.length;
    const sourcesByAward = await loadSourcesByAward();
    report.source_fact_pages = [...sourcesByAward.values()].reduce((sum, rows) => sum + rows.length, 0);
    await updateWorkerRun(runId, report);
    console.log(
      `AWARD_FACTS_AGGREGATE loaded_awards=${awards.length} source_fact_pages=${report.source_fact_pages} apply=${applyUpdates}`,
    );

    for (const award of awards) {
      report.checked += 1;
      try {
        const sources = sourcesByAward.get(award.id) || [];
        const usableSources = usableAwardSources(sources);
        if (!usableSources.length) {
          report.no_baseline += 1;
          continue;
        }

        const newestSourceGeneratedAt = newestGeneratedAt(usableSources);
        if (!force && award.last_structure_scan_at && newestSourceGeneratedAt) {
          const awardScanAt = new Date(award.last_structure_scan_at).getTime();
          const sourceScanAt = new Date(newestSourceGeneratedAt).getTime();
          if (Number.isFinite(awardScanAt) && Number.isFinite(sourceScanAt) && awardScanAt >= sourceScanAt) {
            report.skipped_existing += 1;
            continue;
          }
        }

        const details = aggregateAwardDetails(award, usableSources);
        const websiteSummary = buildWebsiteSummary(award, details);
        const publicFacts = buildPublicFacts(details);
        report.extracted += 1;
        report.saved_awards.push({
          award_id: award.id,
          award_name: award.name,
          source_count: usableSources.length,
          confidence: details.confidence,
        });

        if (applyUpdates) {
          await updateAwardSummary(award, details, websiteSummary, publicFacts);
          report.applied += 1;
        }

        console.log(`AWARD_FACTS aggregated confidence=${details.confidence} sources=${usableSources.length} ${award.name}`);
      } catch (error) {
        report.failed += 1;
        const message = errorMessage(error);
        report.errors.push({ award_id: award.id, award_name: award.name, message });
        console.log(`AWARD_FACTS failed ${award.name} | ${message}`);
      }

      await maybeUpdateWorkerRun(runId, report);
    }

    report.status = "succeeded";
    await finishWorkerRun(runId, "succeeded", null, report);
  } catch (error) {
    report.status = "failed";
    report.errors.push({ message: errorMessage(error) });
    await finishWorkerRun(runId, "failed", errorMessage(error), report);
    throw error;
  } finally {
    report.finished_at = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`AWARD_FACTS_REPORT ${reportPath}`);
  }
}

async function loadAwards() {
  const awards = await loadAllRows(
    "shared_awards",
    "id, name, slug, official_homepage, summary, public_facts, confidence, status, last_structure_scan_at, created_at",
    (query) => {
      query = query.eq("status", "active").order("created_at", { ascending: true });
      if (awardIdFilter) query = query.eq("id", awardIdFilter);
      return query;
    },
  );
  return limit === "all" ? awards : awards.slice(0, limit);
}

async function loadSourcesByAward() {
  const rows = await loadAllRows(
    "shared_award_sources",
    "id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type",
    (query) =>
      query
        .eq("admin_review_status", "open")
        .not("page_metadata_generated_at", "is", null)
        .order("page_metadata_generated_at", { ascending: false }),
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!row.shared_award_id) continue;
    const facts = baselineFacts(row);
    if (!Object.keys(facts).length) continue;
    const current = grouped.get(row.shared_award_id) || [];
    current.push(row);
    grouped.set(row.shared_award_id, current);
  }
  return grouped;
}

async function loadAllRows(table, columns, buildQuery) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    query = buildQuery ? buildQuery(query) : query;
    const { data, error } = await query;
    if (error) throw new Error(describeSupabaseError(error, `load ${table}`));
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function aggregateAwardDetails(award, sources) {
  const details = {
    summary: bestAwardDescription(award, sources),
    deadline: null,
    opening_date: null,
    award_amounts: [],
    eligibility: [],
    requirements: [],
    application_materials: [],
    how_to_apply: [],
    important_dates: [],
    documents: [],
    contacts: [],
    notes: [],
    sources_used: [],
    confidence: "low",
  };

  const confidenceScores = [];
  for (const source of sources) {
    const facts = baselineFacts(source);
    const relevance = cleanSlug(facts.award_relevance);
    const sourceWeight = relevance === "primary" ? 0 : relevance === "supporting" ? 1 : 2;
    assignFirst(details, "deadline", cleanNullable(facts.deadline), sourceWeight);
    assignFirst(details, "opening_date", cleanNullable(facts.opening_date), sourceWeight);
    addValues(details.award_amounts, facts.award_amounts, sourceWeight);
    addValues(details.eligibility, facts.eligibility, sourceWeight);
    addValues(details.requirements, facts.requirements, sourceWeight);
    addValues(details.application_materials, facts.application_materials, sourceWeight);
    addValues(details.how_to_apply, facts.how_to_apply, sourceWeight);
    addValues(details.important_dates, facts.important_dates, sourceWeight);
    addValues(details.documents, facts.documents, sourceWeight);
    addValues(details.contacts, facts.contacts, sourceWeight);
    addValues(details.notes, facts.notes, sourceWeight);
    addValues(details.sources_used, [source.display_title || source.title || source.url], sourceWeight);
    confidenceScores.push(confidenceScoreLabel(cleanSlug(facts.confidence)));
  }

  details.award_amounts = rankedValues(details.award_amounts, 8);
  details.eligibility = rankedValues(details.eligibility, 12);
  details.requirements = rankedValues(details.requirements, 12);
  details.application_materials = rankedValues(details.application_materials, 10);
  details.how_to_apply = rankedValues(details.how_to_apply, 8);
  details.important_dates = normalizeImportantDateItems(rankedValues(details.important_dates, 10), {
    deadline: details.deadline,
    openingDate: details.opening_date,
  });
  details.documents = rankedValues(details.documents, 8);
  details.contacts = rankedValues(details.contacts, 6);
  details.notes = rankedValues(details.notes, 6);
  details.sources_used = rankedValues(details.sources_used, 8);
  details.confidence = aggregateConfidence(confidenceScores, details);
  return details;
}

function usableAwardSources(sources) {
  return sources.filter((source) => {
    const facts = baselineFacts(source);
    const relevance = cleanSlug(facts.award_relevance);
    if (relevance === "unrelated") return false;
    return Boolean(
      cleanNullable(facts.deadline) ||
        cleanNullable(facts.opening_date) ||
        arrayHasValues(facts.award_amounts) ||
        arrayHasValues(facts.eligibility) ||
        arrayHasValues(facts.requirements) ||
        arrayHasValues(facts.application_materials) ||
        arrayHasValues(facts.how_to_apply) ||
        arrayHasValues(facts.important_dates) ||
        arrayHasValues(facts.documents) ||
        arrayHasValues(facts.contacts) ||
        cleanNullable(facts.page_description),
    );
  });
}

function arrayHasValues(value) {
  return Array.isArray(value) && value.some((item) => cleanText(arrayItemText(item)));
}

function assignFirst(details, key, value, weight) {
  if (!value) return;
  if (!details[`_${key}_weight`] || weight < details[`_${key}_weight`]) {
    details[key] = value;
    details[`_${key}_weight`] = weight;
  }
}

function addValues(target, value, weight) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of values) {
    const clean = cleanText(stripUrls(arrayItemText(item))).replace(/[.;:\s]+$/g, "");
    if (!clean || clean.length < 3) continue;
    target.push({ value: clean, weight });
  }
}

function rankedValues(values, limit) {
  const seen = new Set();
  return values
    .sort((left, right) => left.weight - right.weight || left.value.length - right.value.length)
    .map((entry) => entry.value)
    .filter((value) => {
      const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function normalizeImportantDateItems(values, context = {}) {
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const item = contextualImportantDate(value, context);
    if (!item) continue;
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(truncate(item, 180));
  }
  return normalized.slice(0, 10);
}

function contextualImportantDate(value, context) {
  const clean = cleanText(value).replace(/^important dates?:\s*/i, "");
  if (!clean || !hasDateSignal(clean)) return null;
  if (!isBareDateValue(clean)) return clean;
  if (sameDateText(clean, context.deadline)) return `Application deadline: ${clean}`;
  if (sameDateText(clean, context.openingDate)) return `Applications open: ${clean}`;
  return null;
}

function sameDateText(value, reference) {
  const left = normalizeDateText(value);
  const right = normalizeDateText(reference || "");
  return Boolean(left && right && (left === right || right.includes(left) || left.includes(right)));
}

function normalizeDateText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b(?:deadline|due|opens?|opening|applications?|application|date|by|on|at)\b/g, " ")
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasDateSignal(value) {
  return (
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(value) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(value) ||
    /\b(?:spring|summer|fall|autumn|winter)\s+\d{4}\b/i.test(value)
  );
}

function isBareDateValue(value) {
  const stripped = cleanText(value)
    .toLowerCase()
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, " ")
    .replace(/\b(?:spring|summer|fall|autumn|winter|early|mid|late|end|beginning|start|through|to|and|or|of|the|by|on|at)\b/g, " ")
    .replace(/\b\d{1,4}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/[,\-–—/().:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length === 0;
}

function bestAwardDescription(award, sources) {
  const preferred = sources
    .map((source) => {
      const facts = baselineFacts(source);
      const relevance = cleanSlug(facts.award_relevance);
      const category = cleanSlug(facts.page_category);
      const description = cleanNullable(facts.page_description) || cleanNullable(source.page_description);
      const sourceSignal = `${source.url || ""} ${source.display_title || ""} ${source.title || ""}`.toLowerCase();
      return {
        description,
        score: awardDescriptionScore({ relevance, category, pageType: source.page_type, sourceSignal }),
      };
    })
    .filter((entry) => entry.description && !looksGenericDescription(entry.description))
    .sort((left, right) => left.score - right.score || left.description.length - right.description.length)[0];

  return (
    preferred?.description ||
    `${award.name} has baseline details extracted from current AwardPing source snapshots.`
  );
}

function awardDescriptionScore({ relevance, category, pageType, sourceSignal }) {
  let score = relevance === "primary" ? 0 : relevance === "supporting" ? 4 : 8;
  if (!/(overview|award|fellowship|scholarship|application|solicitation)/.test(category)) score += 2;

  const type = cleanSlug(pageType);
  if (type === "homepage") score -= 4;
  if (type === "application") score -= 2;
  if (/\b(?:solicitation|program-solicitation|funding\/opportunities)\b/.test(sourceSignal)) score -= 2;

  if (/\b(?:updates?|news|webinar|virtual office hours|office hours|event|history|faq)\b/.test(sourceSignal)) score += 8;
  if (/\/updates(?:\/|$)/.test(sourceSignal)) score += 8;
  return score;
}

function looksGenericDescription(value) {
  return /\b(privacy policy|cookie policy|logo|brand|newsletter|donation|annual report|financial statement)\b/i.test(value);
}

function buildWebsiteSummary(award, details) {
  const parts = [];
  parts.push(ensureSentencePunctuation(stripUrls(details.summary)));
  addFact(parts, "Deadline", details.deadline);
  addFact(parts, "Opening date", details.opening_date);
  addFact(parts, "Award amount", details.award_amounts);
  addFact(parts, "Eligibility", details.eligibility);
  addFact(parts, "Requirements", details.requirements);
  addFact(parts, "Application materials", details.application_materials);
  addFact(parts, "How to apply", details.how_to_apply);
  addFact(parts, "Important dates", details.important_dates);
  addFact(parts, "Documents", details.documents);
  addFact(parts, "Contacts", details.contacts);
  addFact(parts, "Notes", details.notes);
  parts.push(`Baseline detail confidence: ${details.confidence}.`);
  return truncate(parts.filter(Boolean).join(" "), 2_800);
}

function addFact(parts, label, value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const cleanValues = values
    .map((item) => cleanText(stripUrls(item)).replace(/[.;:\s]+$/g, ""))
    .filter(Boolean);
  if (!cleanValues.length) return;
  parts.push(`${label}: ${ensureSentencePunctuation(truncate(cleanValues.join("; "), 500))}`);
}

function buildPublicFacts(details) {
  const text = [
    ...details.eligibility,
    ...details.requirements,
    ...details.application_materials,
    ...details.documents,
  ].join(" ");

  return {
    overview: details.summary || null,
    deadline: details.deadline,
    opening_date: details.opening_date,
    award_amounts: details.award_amounts,
    eligibility: details.eligibility,
    requirements: details.requirements,
    application_materials: details.application_materials,
    how_to_apply: details.how_to_apply,
    important_dates: details.important_dates,
    documents: details.documents,
    contacts: details.contacts,
    academic_levels: inferAcademicLevels(text),
    disciplines: inferDisciplines(text),
    citizenship: inferCitizenship(text),
    sources_used: details.sources_used,
    confidence: details.confidence,
  };
}

async function updateAwardSummary(award, details, websiteSummary, publicFacts) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("shared_awards")
    .update({
      summary: websiteSummary,
      public_facts: publicFacts,
      public_facts_generated_at: now,
      public_facts_model: "source-page-baseline-facts",
      confidence: confidenceScore(details.confidence),
      last_structure_scan_at: now,
      structure_scan_error: null,
      updated_at: now,
    })
    .eq("id", award.id);
  if (error) throw new Error(describeSupabaseError(error, "update award fact summary"));
}

function inferAcademicLevels(value) {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/\bundergraduate transcripts?\b/g, "")
    .replace(/\bbachelor'?s? transcripts?\b/g, "");
  const levels = [];
  if (/\b(first-year|freshman|sophomore|junior|senior|undergraduate|bachelor)/.test(clean)) levels.push("Undergraduate");
  if (/\bgraduate|master|doctoral|phd|ph\.d|postdoctoral|postdoc/.test(clean)) levels.push("Graduate");
  if (/\bpostdoctoral|postdoc/.test(clean)) levels.push("Postdoctoral");
  return levels;
}

function inferDisciplines(value) {
  const clean = String(value || "").toLowerCase();
  const disciplines = [];
  if (/\b(ecology|evolution|biology|life sciences?)\b/.test(clean)) disciplines.push("Life sciences");
  if (/\b(stem|science|engineering|mathematics|technology|computer|biology|chemistry|physics)\b/.test(clean)) disciplines.push("STEM");
  if (/\bpublic service|policy|government|international affairs|foreign service|leadership\b/.test(clean)) disciplines.push("Public service");
  if (/\bhumanities|arts|literature|history|language|social science\b/.test(clean)) disciplines.push("Humanities / social sciences");
  if (/\bhealth|medicine|medical|nursing|clinical\b/.test(clean)) disciplines.push("Health");
  return disciplines;
}

function inferCitizenship(value) {
  const clean = String(value || "").toLowerCase();
  const citizenship = [];
  if (/\bu\.?s\.?\s+(citizen|national)|united states citizen/.test(clean)) citizenship.push("U.S. citizens");
  if (/\bpermanent resident|green card/.test(clean)) citizenship.push("Permanent residents");
  if (/\binternational students?|non-u\.?s\.?|foreign nationals?/.test(clean)) citizenship.push("International applicants");
  return citizenship;
}

async function startWorkerRun(report) {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-award-baseline-detail-worker",
      status: "running",
      ai_provider: report.ai_provider,
      metadata: workerMetadata(report),
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record award facts aggregate run")}`);
    return null;
  }
  return data?.id || null;
}

let lastWorkerUpdateAt = 0;
let lastWorkerUpdateChecked = 0;

async function maybeUpdateWorkerRun(runId, report) {
  if (!runId) return;
  const now = Date.now();
  if (report.checked - lastWorkerUpdateChecked < 25 && now - lastWorkerUpdateAt < 60_000) return;
  lastWorkerUpdateChecked = report.checked;
  lastWorkerUpdateAt = now;
  await updateWorkerRun(runId, report);
}

async function updateWorkerRun(runId, report) {
  if (!runId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed,
      metadata: workerMetadata(report),
    })
    .eq("id", runId);
  if (error) console.log(`WORKER RUN UPDATE FAILED | ${describeSupabaseError(error, "update award facts aggregate run")}`);
}

async function finishWorkerRun(runId, status, errorMessageValue, report) {
  if (!runId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: workerMetadata(report),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) console.log(`WORKER RUN FINISH FAILED | ${describeSupabaseError(error, "finish award facts aggregate run")}`);
}

function workerMetadata(report) {
  return {
    kind: "award_baseline_details_from_source_facts",
    ai_model: report.ai_model,
    options: report.options,
    counts: {
      loaded_awards: report.loaded_awards,
      source_fact_pages: report.source_fact_pages,
      checked: report.checked,
      extracted: report.extracted,
      applied: report.applied,
      skipped_existing: report.skipped_existing,
      no_baseline: report.no_baseline,
      failed: report.failed,
    },
    detail_pipeline: {
      extraction: {
        extracted: report.extracted,
        no_baseline: report.no_baseline,
        skipped_existing: report.skipped_existing,
        failed: report.failed,
      },
      publishing: {
        applied: report.applied,
      },
    },
    saved_awards: report.saved_awards.slice(-20),
    errors: report.errors.slice(-20),
  };
}

function baselineFacts(source) {
  const metadata = jsonObjectOrEmpty(source.page_metadata);
  if (metadata.baseline_facts_rejected || metadata.baselineFactsRejected) return {};
  if (metadata.kind && !metadata.baseline_facts && !metadata.baselineFacts) return {};
  return jsonObjectOrEmpty(metadata.baseline_facts || metadata.baselineFacts || source.page_metadata);
}

function newestGeneratedAt(sources) {
  return sources
    .map((source) => source.page_metadata_generated_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function aggregateConfidence(scores, details) {
  const maxScore = Math.max(0, ...scores);
  const hasUsefulFacts = Boolean(
    details.deadline ||
      details.award_amounts.length ||
      details.eligibility.length ||
      details.requirements.length ||
      details.application_materials.length,
  );
  if (maxScore >= 3 && hasUsefulFacts) return "high";
  if (maxScore >= 2 || hasUsefulFacts) return "medium";
  return "low";
}

function confidenceScoreLabel(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function confidenceScore(value) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  return 0.5;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function limitArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (String(value).toLowerCase() === "all") return "all";
  return positiveInt(value, fallback === "all" ? 100 : fallback);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim().slice(0, 2_000);
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function arrayItemText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const direct = value.text || value.value || value.summary || value.description || value.title || value.name;
  if (direct) return direct;
  const date = value.date || value.deadline || value.opening_date || value.label;
  const note = value.note || value.detail || value.details || value.event;
  if (date && note) return `${date}: ${note}`;
  if (date) return date;
  if (note) return note;
  return Object.entries(value)
    .filter((entry) => ["string", "number", "boolean"].includes(typeof entry[1]))
    .map(([key, item]) => `${key}: ${item}`)
    .join("; ");
}

function stripUrls(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureSentencePunctuation(value) {
  const clean = cleanText(value);
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function truncate(value, maxLength) {
  const clean = String(value || "");
  if (clean.length <= maxLength) return clean;
  const target = Math.max(1, maxLength - 3);
  const boundary = clean.lastIndexOf(" ", target);
  const clipped = clean.slice(0, boundary > target * 0.65 ? boundary : target).replace(/[.,;:\s]+$/g, "");
  return `${clipped}...`;
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timestampForPath(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function describeSupabaseError(error, fallback) {
  if (!error) return fallback;
  return error.message || error.details || error.hint || fallback;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

await runOnce().catch((error) => {
  console.error(`AWARD_FACTS_FATAL ${errorMessage(error)}`);
  process.exit(1);
});
