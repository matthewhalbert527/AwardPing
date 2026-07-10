import { appConfig } from "@/lib/config";
import { normalizeHttpUrl } from "@/lib/url-safety";
import {
  awardDiscoveryResultSchema,
  awardPageTypes,
  type AwardDiscoveryResult,
  type DiscoveryCandidate,
} from "@/lib/award-discovery-types";

export type SearchCandidate = {
  url: string;
  title: string;
  snippet: string;
  sourceQuery: string;
  score: number | null;
};

export type AwardAiProvider = "gemini" | "openai";

const discoveryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["awardName", "officialHomepage", "summary", "confidence", "candidates"],
  properties: {
    awardName: { type: "string", minLength: 1, maxLength: 140 },
    officialHomepage: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    candidates: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "url",
          "title",
          "pageType",
          "confidence",
          "reason",
          "recommendedToTrack",
        ],
        properties: {
          url: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 220 },
          pageType: { type: "string", enum: awardPageTypes },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 360 },
          recommendedToTrack: { type: "boolean" },
        },
      },
    },
  },
} as const;

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
};

export function buildAwardSearchQueries(query: string) {
  const award = query.trim().replace(/\s+/g, " ");
  return [
    `${award} official award homepage`,
    `${award} official deadline application eligibility`,
    `${award} application requirements applicant guide`,
    `${award} official PDF application guide deadline`,
  ];
}

export function dedupeSearchCandidates(candidates: SearchCandidate[]) {
  const seen = new Set<string>();
  const deduped: SearchCandidate[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate.url);
    if (!normalized.ok) continue;

    normalized.url.hash = "";
    const key = normalized.url.toString();
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push({
      ...candidate,
      url: key,
      title: candidate.title.trim() || normalized.url.hostname,
      snippet: candidate.snippet.trim(),
    });
  }

  return deduped;
}

export function sanitizeDiscoveryResult(result: AwardDiscoveryResult) {
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];

  for (const candidate of result.candidates) {
    const normalized = normalizeHttpUrl(candidate.url);
    if (!normalized.ok) continue;

    normalized.url.hash = "";
    const url = normalized.url.toString();
    if (seen.has(url)) continue;

    seen.add(url);
    candidates.push({
      ...candidate,
      url,
      title: candidate.title.trim(),
      reason: candidate.reason.trim(),
      confidence: clampConfidence(candidate.confidence),
    });
  }

  const officialHomepage = result.officialHomepage
    ? normalizeHttpUrl(result.officialHomepage)
    : null;
  if (officialHomepage?.ok === true) {
    officialHomepage.url.hash = "";
  }

  return {
    ...result,
    awardName: result.awardName.trim(),
    summary: result.summary.trim(),
    confidence: clampConfidence(result.confidence),
    officialHomepage:
      officialHomepage?.ok === true ? officialHomepage.url.toString() : null,
    candidates,
  };
}

export async function searchAwardCandidates(
  query: string,
  options: {
    apiKey?: string;
    fetcher?: typeof fetch;
    maxResultsPerQuery?: number;
  } = {},
) {
  const apiKey = options.apiKey ?? appConfig.tavilyApiKey;
  if (!apiKey) {
    throw new Error("Tavily is not configured.");
  }

  const fetcher = options.fetcher ?? fetch;
  const maxResultsPerQuery = options.maxResultsPerQuery ?? 5;
  const queries = buildAwardSearchQueries(query);

  const responses = await Promise.all(
    queries.map(async (sourceQuery) => {
      const response = await fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: sourceQuery,
          topic: "general",
          search_depth: "basic",
          max_results: maxResultsPerQuery,
          include_answer: false,
          include_images: false,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Tavily search failed with ${response.status}.`);
      }

      const json = (await response.json()) as TavilySearchResponse;
      return (json.results || []).map((result): SearchCandidate | null => {
        if (!result.url) return null;

        return {
          url: result.url,
          title: result.title || result.url,
          snippet: result.content || "",
          sourceQuery,
          score: typeof result.score === "number" ? result.score : null,
        };
      });
    }),
  );

  return dedupeSearchCandidates(responses.flat().filter(Boolean) as SearchCandidate[]);
}

export async function classifyAwardCandidates(
  query: string,
  candidates: SearchCandidate[],
  options: {
    apiKey?: string;
    model?: string;
    fetcher?: typeof fetch;
  } = {},
) {
  const apiKey = options.apiKey ?? appConfig.openaiApiKey;
  if (!apiKey) {
    throw new Error("OpenAI is not configured.");
  }

  const fetcher = options.fetcher ?? fetch;
  const model = options.model ?? appConfig.openaiDiscoveryModel;
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You classify search results for nationally competitive scholarships, fellowships, and awards. Prefer official national sponsor pages. Choose exact pages that update: deadline, application, eligibility, requirements, PDF guides, and FAQs. Do not invent URLs.",
        },
        {
          role: "user",
          content: JSON.stringify({
            searchedAward: query,
            candidates: candidates.slice(0, 20),
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "award_discovery_result",
          strict: true,
          schema: discoveryJsonSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI classification failed with ${response.status}.`);
  }

  const json = await response.json();
  const outputText = extractOpenAIOutputText(json);
  const parsed = awardDiscoveryResultSchema.parse(JSON.parse(outputText));
  return sanitizeDiscoveryResult(parsed);
}

export function hasAwardClassifierConfig() {
  return Boolean(selectAwardAiProvider());
}

export function selectAwardAiProvider(): AwardAiProvider | null {
  const requested = appConfig.aiProvider.toLowerCase();
  if (requested === "gemini") return null;
  if (requested === "openai") return appConfig.openaiApiKey ? "openai" : null;
  if (appConfig.openaiApiKey) return "openai";
  return null;
}

export function extractOpenAIOutputText(response: unknown) {
  if (
    typeof response === "object" &&
    response &&
    "output_text" in response &&
    typeof response.output_text === "string"
  ) {
    return response.output_text;
  }

  if (
    typeof response === "object" &&
    response &&
    "output" in response &&
    Array.isArray(response.output)
  ) {
    for (const item of response.output) {
      if (
        typeof item === "object" &&
        item &&
        "content" in item &&
        Array.isArray(item.content)
      ) {
        for (const content of item.content) {
          if (
            typeof content === "object" &&
            content &&
            "text" in content &&
            typeof content.text === "string"
          ) {
            return content.text;
          }
        }
      }
    }
  }

  throw new Error("OpenAI response did not include structured output text.");
}

export function extractGeminiOutputText(response: unknown) {
  const parts: string[] = [];

  if (
    typeof response === "object" &&
    response &&
    "candidates" in response &&
    Array.isArray(response.candidates)
  ) {
    for (const candidate of response.candidates) {
      if (
        typeof candidate !== "object" ||
        !candidate ||
        !("content" in candidate) ||
        typeof candidate.content !== "object" ||
        !candidate.content ||
        !("parts" in candidate.content) ||
        !Array.isArray(candidate.content.parts)
      ) {
        continue;
      }

      for (const part of candidate.content.parts) {
        if (
          typeof part === "object" &&
          part &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          parts.push(part.text);
        }
      }
    }
  }

  const text = parts.join("").trim();
  if (text) return stripJsonFence(text);
  throw new Error("Gemini response did not include output text.");
}

function clampConfidence(value: number) {
  return Math.min(1, Math.max(0, value));
}

function stripJsonFence(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
