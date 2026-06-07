import { describe, expect, it } from "vitest";
import {
  buildAwardSearchQueries,
  dedupeSearchCandidates,
  extractGeminiOutputText,
  extractOpenAIOutputText,
  sanitizeDiscoveryResult,
} from "@/lib/award-discovery";
import {
  contentTypeForPage,
  pageTypeLabel,
  type AwardDiscoveryResult,
} from "@/lib/award-discovery-types";

describe("award discovery helpers", () => {
  it("builds award-specific search queries", () => {
    expect(buildAwardSearchQueries(" Goldwater  Scholarship ")).toEqual([
      "Goldwater Scholarship official award homepage",
      "Goldwater Scholarship official deadline application eligibility",
      "Goldwater Scholarship application requirements applicant guide",
      "Goldwater Scholarship official PDF application guide deadline",
    ]);
  });

  it("dedupes candidates by normalized URL and drops unsafe URLs", () => {
    const candidates = dedupeSearchCandidates([
      {
        url: "https://example.org/app#section",
        title: " Application ",
        snippet: "First",
        sourceQuery: "one",
        score: 0.9,
      },
      {
        url: "https://example.org/app",
        title: "Duplicate",
        snippet: "Second",
        sourceQuery: "two",
        score: 0.8,
      },
      {
        url: "http://localhost/private",
        title: "Unsafe",
        snippet: "Ignore",
        sourceQuery: "three",
        score: 0.7,
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: "https://example.org/app",
      title: "Application",
    });
  });

  it("sanitizes classified discovery results", () => {
    const result: AwardDiscoveryResult = {
      awardName: "  Fulbright U.S. Student Program ",
      officialHomepage: "https://us.fulbrightonline.org/#top",
      summary: " Official pages for the award. ",
      confidence: 1.4,
      candidates: [
        {
          url: "https://us.fulbrightonline.org/applicants",
          title: " Applicants ",
          pageType: "application",
          confidence: -0.5,
          reason: " Application details ",
          recommendedToTrack: true,
        },
        {
          url: "ftp://example.org/file",
          title: "Bad",
          pageType: "other",
          confidence: 0.5,
          reason: "Bad protocol",
          recommendedToTrack: false,
        },
      ],
    };

    expect(sanitizeDiscoveryResult(result)).toMatchObject({
      awardName: "Fulbright U.S. Student Program",
      officialHomepage: "https://us.fulbrightonline.org/",
      summary: "Official pages for the award.",
      confidence: 1,
      candidates: [
        {
          url: "https://us.fulbrightonline.org/applicants",
          title: "Applicants",
          confidence: 0,
        },
      ],
    });
  });

  it("labels page types and detects PDF monitor content", () => {
    expect(pageTypeLabel("deadline")).toBe("Deadline");
    expect(contentTypeForPage("homepage", "https://example.org/guide.pdf")).toBe(
      "pdf",
    );
    expect(contentTypeForPage("application", "https://example.org/apply")).toBe(
      "auto",
    );
  });

  it("extracts Responses API output text", () => {
    expect(
      extractOpenAIOutputText({
        output: [
          {
            content: [{ type: "output_text", text: "{\"ok\":true}" }],
          },
        ],
      }),
    ).toBe("{\"ok\":true}");
  });

  it("extracts Gemini output text", () => {
    expect(
      extractGeminiOutputText({
        candidates: [
          {
            content: {
              parts: [{ text: "```json\n{\"ok\":true}\n```" }],
            },
          },
        ],
      }),
    ).toBe("{\"ok\":true}");
  });
});
