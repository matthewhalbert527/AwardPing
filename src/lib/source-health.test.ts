import { describe, expect, it } from "vitest";
import { classifySourceHealth, summarizeSourceHealth } from "@/lib/source-health";

describe("source health display", () => {
  it("turns crawler errors into user-facing source states", () => {
    expect(classifySourceHealth({ lastError: "Fetch failed with HTTP 403." }).label).toBe(
      "Blocked by site",
    );
    expect(classifySourceHealth({ lastError: "Fetch failed with HTTP 404." }).label).toBe(
      "Missing page",
    );
    expect(classifySourceHealth({ lastError: "getaddrinfo ENOTFOUND example.edu" }).label).toBe(
      "Domain failed",
    );
    expect(classifySourceHealth({ lastError: "fetch failed: certificate has expired (CERT_HAS_EXPIRED)" }).label).toBe(
      "Certificate issue",
    );
    expect(classifySourceHealth({ lastError: "fetch failed" }).label).toBe(
      "Crawler fetch failed",
    );
    expect(classifySourceHealth({ lastError: "No readable text was found on this URL." }).label).toBe(
      "No readable text",
    );
  });

  it("summarizes checked, pending, and review states", () => {
    const summary = summarizeSourceHealth([
      { lastCheckedAt: "2026-05-26T00:00:00.000Z" },
      { lastError: "Fetch failed with HTTP 404." },
      {},
    ]);

    expect(summary.total).toBe(3);
    expect(summary.checked).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.review).toBe(1);
    expect(summary.missing).toBe(1);
  });
});
