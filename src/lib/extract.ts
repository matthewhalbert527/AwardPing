import crypto from "node:crypto";
import * as cheerio from "cheerio";
import {
  fetchPublicHttpResponse,
  normalizeHttpUrl,
  type PublicHttpResponse,
} from "@/lib/url-safety";
import type { MonitorContentType } from "@/lib/plans";

export type ExtractedContent = {
  url: string;
  hash: string;
  text: string;
  sample: string;
  byteLength: number;
  statusCode: number;
  contentType: string;
};

const maxBytes = 5 * 1024 * 1024;
const userAgent =
  "Mozilla/5.0 (compatible; AwardPingBot/1.0; +https://awardping.com/contact; public award page monitor)";
const fallbackUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AwardPingBot/1.0 Chrome/124.0 Safari/537.36 (+https://awardping.com/contact)";

export async function fetchExtractedContent(
  rawUrl: string,
  preferredType: MonitorContentType = "auto",
): Promise<ExtractedContent> {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized.ok) {
    throw new Error(normalized.reason);
  }
  const safeUrl = normalized.url;
  const fetched = await fetchCrawlerResponse(safeUrl);
  const response = fetched.response;

  try {
    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      throw new Error("This award source is too large for the v1 tracking limit.");
    }

    const contentType = response.headers.get("content-type") || "";
    const arrayBuffer = await readResponseBodyBounded(response, maxBytes);

    const isPdf =
      preferredType === "pdf" ||
      (preferredType === "auto" &&
        (contentType.includes("application/pdf") ||
          safeUrl.pathname.toLowerCase().endsWith(".pdf")));

    const text = isPdf
      ? await extractPdfText(arrayBuffer)
      : extractHtmlText(Buffer.from(arrayBuffer).toString("utf8"));

    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      throw new Error("No readable text was found on this URL.");
    }

    return {
      url: safeUrl.toString(),
      hash: hashText(normalizedText),
      text: normalizedText,
      sample: normalizedText,
      byteLength: arrayBuffer.byteLength,
      statusCode: response.status,
      contentType,
    };
  } finally {
    await releaseCrawlerResponse(fetched);
  }
}

async function readResponseBodyBounded(
  response: PublicHttpResponse["response"],
  byteLimit: number,
) {
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteLength += value.byteLength;
      if (byteLength > byteLimit) {
        await reader.cancel("AwardPing response byte limit exceeded").catch(() => undefined);
        throw new Error("This award source is too large for the v1 tracking limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function fetchCrawlerResponse(url: URL): Promise<PublicHttpResponse> {
  const attempts = [
    crawlerHeaders(userAgent),
    crawlerHeaders(fallbackUserAgent),
  ];
  let latestResponse: PublicHttpResponse | null = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const fetched = await fetchPublicHttpResponse(url, {
      headers: attempts[index],
      signal: AbortSignal.timeout(18_000),
    });
    const response = fetched.response;

    if (response.ok) return fetched;
    latestResponse = fetched;

    if (index === attempts.length - 1 || !shouldRetryWithAlternateHeaders(response.status)) {
      return fetched;
    }

    await releaseCrawlerResponse(fetched);
    await sleep(retryDelayMs(response));
  }

  if (!latestResponse) {
    throw new Error("Crawler fetch did not produce a response.");
  }
  return latestResponse;
}

async function releaseCrawlerResponse(fetched: PublicHttpResponse) {
  await fetched.response.body?.cancel().catch(() => undefined);
  await fetched.close();
}

function crawlerHeaders(nextUserAgent: string) {
  return {
    "user-agent": nextUserAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.7,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: "https://awardping.com/",
  };
}

function shouldRetryWithAlternateHeaders(status: number) {
  return status === 403 || status === 405 || status === 429 || status >= 500;
}

function retryDelayMs(response: PublicHttpResponse["response"]) {
  if (response.status !== 429) return 750;
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return 2_000;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1_000), 5_000);

  const retryAt = new Date(retryAfter).getTime();
  if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 1_000), 5_000);

  return 2_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractHtmlText(html: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe").remove();
  $("br").replaceWith("\n");
  $("p, div, section, article, header, footer, main, aside, nav, li, h1, h2, h3, h4, h5, h6, td, th")
    .prepend("\n")
    .append("\n");
  return $("body").text() || $.root().text();
}

export async function extractPdfText(arrayBuffer: ArrayBuffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const result = await parser.getText({ first: 20 });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

export function normalizeText(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

export function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
