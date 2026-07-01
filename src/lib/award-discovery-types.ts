import { z } from "zod";

export const awardPageTypes = [
  "homepage",
  "deadline",
  "application",
  "eligibility",
  "requirements",
  "pdf",
  "faq",
  "other",
] as const;

export type AwardPageType = (typeof awardPageTypes)[number];

export const discoveryCandidateSchema = z.object({
  url: z.string().url(),
  title: z.string().trim().min(1).max(220),
  pageType: z.enum(awardPageTypes),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(360),
  recommendedToTrack: z.boolean(),
});

export const awardDiscoveryResultSchema = z.object({
  awardName: z.string().trim().min(1).max(140),
  officialHomepage: z.string().url().nullable(),
  summary: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  candidates: z.array(discoveryCandidateSchema).max(12),
});

export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;
export type AwardDiscoveryResult = z.infer<typeof awardDiscoveryResultSchema>;

export function pageTypeLabel(pageType: AwardPageType) {
  const labels: Record<AwardPageType, string> = {
    homepage: "Homepage",
    deadline: "Deadline",
    application: "Application",
    eligibility: "Eligibility",
    requirements: "Award conditions",
    pdf: "PDF guide",
    faq: "FAQ",
    other: "Other source",
  };

  return labels[pageType];
}

export function contentTypeForPage(pageType: AwardPageType, url: string) {
  if (pageType === "pdf" || new URL(url).pathname.toLowerCase().endsWith(".pdf")) {
    return "pdf" as const;
  }

  return "auto" as const;
}
