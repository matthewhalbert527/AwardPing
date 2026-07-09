import { describe, expect, it } from "vitest";
import {
  dedupeIntakeSubmissions,
  deterministicSourceIntakeReview,
  normalizeSourceIntakeUrl,
  parseBulkSourceIntakeText,
} from "@/lib/source-intake";

describe("source intake helpers", () => {
  it("normalizes public urls and removes tracking", () => {
    expect(normalizeSourceIntakeUrl("example.edu/path/?utm_source=x&b=2&a=1#section")).toBe(
      "https://example.edu/path?a=1&b=2",
    );
  });

  it("rejects unsafe or local urls", () => {
    expect(() => normalizeSourceIntakeUrl("file:///tmp/source.html")).toThrow(/http and https/i);
    expect(() => normalizeSourceIntakeUrl("http://localhost:3000/source")).toThrow(/internal/i);
  });

  it("parses bulk pasted urls with per-line award names", () => {
    const rows = parseBulkSourceIntakeText(
      "https://one.edu/award | One Award | primary page\nhttps://two.edu/faq",
      { awardName: "Default Award", notes: "shared", intakeType: "official_source" },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ awardName: "One Award", notes: "primary page" });
    expect(rows[1]).toMatchObject({ awardName: "Default Award", notes: "shared" });
  });

  it("deduplicates by normalized url and award name", () => {
    const rows = dedupeIntakeSubmissions([
      { url: "https://example.edu/award?utm_source=x", awardName: "Award" },
      { url: "https://example.edu/award", awardName: "Award" },
      { url: "https://example.edu/award", awardName: "Other Award" },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("passes plausible award pages and rejects obvious bad pages", () => {
    const good = deterministicSourceIntakeReview({
      url: "https://example.edu/fellowship/apply",
      title: "Example Fellowship",
      text: "The Example Fellowship application deadline is March 1. Eligibility and stipend details are listed here.",
    });
    expect(good.status).toBe("plausible");
    expect(good.allowed).toBe(true);

    const bad = deterministicSourceIntakeReview({
      url: "https://example.edu/careers/jobs/123",
      title: "Job profile",
      text: "Apply for this job.",
    });
    expect(bad.status).toBe("rejected");
    expect(bad.qualityFlags).toContain("blocked-url-shape");
  });

  it("routes generic listings to manual review instead of accepting them", () => {
    const review = deterministicSourceIntakeReview({
      url: "https://example.edu/scholarship-search?q=engineering",
      title: "Scholarship search",
      text: "Search awards and scholarships.",
    });
    expect(review.status).toBe("needs_manual_review");
    expect(review.qualityFlags).toContain("generic-listing");
  });
});
