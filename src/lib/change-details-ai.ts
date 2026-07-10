import "server-only";

import { buildChangePromptContext } from "@/lib/diff";
import { appConfig } from "@/lib/config";
import { monitoringPolicyPromptLinesForScope } from "@/lib/award-monitoring-policy";
import {
  buildHeuristicChangeDetails,
  normalizeAiChangeDetails,
  type ChangeDetailSource,
  type ChangeDetails,
} from "@/lib/change-details";

const promptChars = 12_000;

export async function generateChangeDetailsForSource(input: {
  previousSample?: string | null;
  nextText: string;
  source?: ChangeDetailSource;
}): Promise<ChangeDetails> {
  const fallback = buildHeuristicChangeDetails({
    previousSample: input.previousSample || null,
    nextText: input.nextText,
    source: input.source,
  });
  const provider = selectAiProvider();

  if (!provider || !input.previousSample || !fallback.is_alert_worthy) {
    return fallback;
  }

  return generateWithOpenAI(input, fallback);
}

function selectAiProvider() {
  const requested = appConfig.aiProvider.toLowerCase();
  if ((requested === "openai" || requested === "auto") && appConfig.openaiApiKey) {
    return "openai" as const;
  }
  return null;
}

async function generateWithOpenAI(
  input: {
    previousSample?: string | null;
    nextText: string;
    source?: ChangeDetailSource;
  },
  fallback: ChangeDetails,
) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${appConfig.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: appConfig.openaiDiscoveryModel || "gpt-4.1-mini",
        instructions: systemPrompt,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: userPrompt(input, fallback),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_object",
          },
        },
        max_output_tokens: 700,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return withGenerationFallback(
        fallback,
        "openai",
        appConfig.openaiDiscoveryModel || "gpt-4.1-mini",
      );
    }
    const data = await response.json();
    return normalizeAiChangeDetails({
      value: jsonValueFromText(extractResponseText(data)),
      fallback,
      source: input.source,
      provider: "openai",
      model: appConfig.openaiDiscoveryModel || "gpt-4.1-mini",
    });
  } catch {
    return withGenerationFallback(fallback, "openai", appConfig.openaiDiscoveryModel || "gpt-4.1-mini");
  }
}

function withGenerationFallback(
  fallback: ChangeDetails,
  provider: "gemini" | "openai",
  model: string,
): ChangeDetails {
  return {
    ...fallback,
    generation_provider: provider,
    generation_status: "fallback",
    generation_model: model,
  };
}

const systemPrompt = [
  "You summarize official award webpage changes for scholarship advisors.",
  "Return valid JSON only. Do not include markdown.",
  "Use only facts visible in the provided previous excerpt, new excerpt, and structured diff.",
  "Default to rejection when uncertain.",
  "Ignore navigation, footers, social links, CTAs, testimonials, unrelated programs, and raw scrape artifacts.",
  "If either excerpt is an error, access denied, forbidden, not found, or other source access page, set is_alert_worthy=false.",
  ...monitoringPolicyPromptLinesForScope("change_details_ai"),
  "Do not treat page redesign, image changes, popups, navigation, staff/profile/fellow/news rotations, or file metadata as applicant-facing changes.",
  "Never use facts from sibling awards or broad search/listing pages.",
  "Reject vague page-update language and raw scrape signals such as LEARN MORE.",
  "source_relevance must be primary or supporting to approve. Use unrelated or unclear when the page is a sibling award, broad listing/search page, stale archive, or not clearly about this exact award.",
  "changed_facts must list only concrete applicant-facing facts involving deadlines, opening dates, amounts, eligibility, award conditions, application materials, application instructions, documents, contact, or official cycle status.",
  "exact_before and exact_after must be exact strings from the structured diff evidence, or null only when the change is one-sided and the other side is genuinely absent.",
  "Required top-level keys: reader_summary, before, after, exact_before, exact_after, section, change_type, advisor_impact, is_alert_worthy, source_relevance, source_relevance_reason, changed_facts, evidence_location, confidence, noise_flags, rejection_reason.",
  "Use null for unknown before/after/section/advisor_impact.",
  "Set is_alert_worthy=false when no concrete award-relevant fact changed.",
  "Make reader_summary a clear one- or two-sentence explanation for a scholarship advisor.",
  "For broad content rotations, set is_alert_worthy=false unless exact applicant-facing deadline, eligibility, funding, material, contact, cycle, or application wording changed.",
  "For concrete award changes, state the practical before/after meaning instead of dumping raw scraped text.",
  "Confidence must be low, medium, or high.",
].join(" ");

function userPrompt(
  input: {
    previousSample?: string | null;
    nextText: string;
    source?: ChangeDetailSource;
  },
  fallback: ChangeDetails,
) {
  const source = input.source || {};

  return [
    `Award: ${source.award_name || "Unknown award"}`,
    `Source title: ${source.source_title || "Unknown source"}`,
    `Source URL: ${source.source_url || "Unknown URL"}`,
    `Page type: ${source.page_type || "unknown"}`,
    "",
    "Structured diff candidates:",
    JSON.stringify(fallback.structured_diff),
    "",
    "Fallback JSON to improve if possible:",
    JSON.stringify({
      reader_summary: fallback.reader_summary,
      before: fallback.before,
      after: fallback.after,
      exact_before: fallback.before,
      exact_after: fallback.after,
      section: fallback.section,
      change_type: fallback.change_type,
      advisor_impact: fallback.advisor_impact,
      is_alert_worthy: fallback.is_alert_worthy,
      source_relevance: "primary",
      source_relevance_reason: "Assume relevant only if the source context and evidence match the named award.",
      changed_facts: [
        {
          fact: fallback.change_type,
          before: fallback.before,
          after: fallback.after,
          added_text: fallback.structured_diff.added_text[0] || null,
          removed_text: fallback.structured_diff.removed_text[0] || null,
        },
      ].filter((fact) => fact.before || fact.after || fact.added_text || fact.removed_text),
      evidence_location: fallback.section,
      confidence: fallback.confidence,
    }),
    "",
    `Diff context:\n${buildChangePromptContext(input.previousSample || null, input.nextText)}`,
    "",
    `Previous excerpt:\n${(input.previousSample || "").slice(0, promptChars)}`,
    "",
    `New excerpt:\n${input.nextText.slice(0, promptChars)}`,
    "",
    "Return one JSON object. The reader_summary must be a direct explanation of the changed fact, not a scrape fragment or a word-level diff.",
  ].join("\n");
}

function jsonValueFromText(text: string) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;

  try {
    return JSON.parse(clean) as unknown;
  } catch {
    const objectMatch = clean.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      return JSON.parse(objectMatch[0]) as unknown;
    } catch {
      return null;
    }
  }
}

function extractResponseText(data: unknown) {
  const root = objectValue(data);
  if (!root) return "";
  if (typeof root.output_text === "string") return root.output_text.trim();

  const parts: string[] = [];
  for (const item of arrayValue(root.output)) {
    const itemObject = objectValue(item);
    if (!itemObject) continue;
    for (const content of arrayValue(itemObject.content)) {
      const contentObject = objectValue(content);
      if (!contentObject) continue;
      if (
        (contentObject.type === "output_text" || contentObject.type === "text") &&
        typeof contentObject.text === "string"
      ) {
        parts.push(contentObject.text);
      }
    }
  }

  return parts.join(" ").trim();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
