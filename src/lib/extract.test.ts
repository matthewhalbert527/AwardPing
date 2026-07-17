import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const { undiciFetch } = vi.hoisted(() => ({ undiciFetch: vi.fn() }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: undiciFetch };
});

import { extractHtmlText, fetchExtractedContent, hashText, normalizeText } from "@/lib/extract";

afterEach(() => {
  vi.restoreAllMocks();
  undiciFetch.mockReset();
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
    undiciFetch.mockResolvedValue(
      new Response(`<html><body><main>${longText}</main></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const content = await fetchExtractedContent("https://example.edu/award");

    expect(content.sample).toBe(content.text);
    expect(content.sample.length).toBeGreaterThan(12_000);
  });

  it("cancels a chunked decoded body as soon as the 5 MB limit is exceeded", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    let cancelled = false;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (emitted >= 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    undiciFetch.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      }),
    );

    await expect(fetchExtractedContent("https://example.edu/oversized"))
      .rejects.toThrow(/too large/i);

    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(8);
  });

  it("rejects a public URL that redirects to a loopback address", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    undiciFetch.mockImplementation(
      async (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
        expect(String(input)).toBe("https://example.edu/award");
        expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        });
      },
    );

    await expect(
      fetchExtractedContent("https://example.edu/award"),
    ).rejects.toThrow(/private network/i);

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      dispatcher: expect.anything(),
    });
  });

  it("rejects a redirect whose hostname resolves to a link-local address", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(async (hostname) => {
      if (hostname === "example.edu") {
        return [{ address: "93.184.216.34", family: 4 }] as never;
      }
      if (hostname === "metadata.example.edu") {
        return [{ address: "169.254.169.254", family: 4 }] as never;
      }
      throw new Error(`Unexpected hostname: ${hostname}`);
    });
    undiciFetch.mockImplementation(
      async (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
        expect(String(input)).toBe("https://example.edu/award");
        expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
        return new Response(null, {
          status: 302,
          headers: { location: "http://metadata.example.edu/latest" },
        });
      },
    );

    await expect(
      fetchExtractedContent("https://example.edu/award"),
    ).rejects.toThrow(/private network/i);

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("metadata.example.edu", {
      all: true,
      verbatim: true,
    });
  });

  it("follows a legitimate public redirect through the protected fetch boundary", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(async (hostname) => {
      if (hostname === "example.edu") {
        return [{ address: "93.184.216.34", family: 4 }] as never;
      }
      if (hostname === "docs.example.edu") {
        return [{ address: "93.184.216.35", family: 4 }] as never;
      }
      throw new Error(`Unexpected hostname: ${hostname}`);
    });
    undiciFetch.mockImplementation(
      async (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
        expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
        if (String(input) === "https://example.edu/award") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://docs.example.edu/current-award" },
          });
        }
        return new Response(
          "<html><body><main>Applications close March 15.</main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    );

    const content = await fetchExtractedContent("https://example.edu/award");

    expect(content.text).toBe("Applications close March 15.");
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(undiciFetch.mock.calls.map((call) => call[1]?.redirect)).toEqual([
      "manual",
      "manual",
    ]);
    expect(undiciFetch.mock.calls.every((call) => Boolean(call[1]?.dispatcher))).toBe(true);
    expect(lookup).toHaveBeenCalledWith("example.edu", {
      all: true,
      verbatim: true,
    });
    expect(lookup).toHaveBeenCalledWith("docs.example.edu", {
      all: true,
      verbatim: true,
    });
  });
});
