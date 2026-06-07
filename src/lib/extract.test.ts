import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractHtmlText, fetchExtractedContent, hashText, normalizeText } from "@/lib/extract";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("content extraction helpers", () => {
  it("extracts readable body text without scripts", () => {
    const text = extractHtmlText(`
      <html>
        <body>
          <h1>Deadline updated</h1>
          <script>ignore()</script>
        </body>
      </html>
    `);

    expect(normalizeText(text)).toBe("Deadline updated");
  });

  it("keeps block element boundaries when extracting text", () => {
    const text = extractHtmlText(`
      <html>
        <body>
          <article>Article<span>2 Min Read</span><h1>NASA Glenn Earns R&D 100 Award</h1></article>
          <p>The exhibits focus on decision-making processes.</p><p>Palo Alto, CA</p>
        </body>
      </html>
    `);

    const clean = normalizeText(text);
    expect(clean).toContain("NASA Glenn Earns R&D 100 Award");
    expect(clean).toContain("processes. Palo Alto, CA");
    expect(clean).not.toContain("ReadNASA");
  });

  it("creates stable hashes from normalized text", () => {
    expect(hashText(normalizeText("Hello   world"))).toBe(
      hashText(normalizeText("Hello world")),
    );
  });

  it("keeps the full normalized snapshot text instead of truncating samples", async () => {
    const longText = `Deadline updated. ${"Eligibility requirements remain unchanged. ".repeat(500)}`;
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<html><body><main>${longText}</main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const content = await fetchExtractedContent("https://example.edu/award");

    expect(content.sample).toBe(content.text);
    expect(content.sample.length).toBeGreaterThan(12_000);
  });
});
