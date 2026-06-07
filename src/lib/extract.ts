import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { assertPublicHttpUrl } from "@/lib/url-safety";
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
  const safeUrl = await assertPublicHttpUrl(rawUrl);
  const response = await fetchCrawlerResponse(safeUrl);

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error("This award source is too large for the v1 tracking limit.");
  }

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error("This award source is too large for the v1 tracking limit.");
  }

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
}

async function fetchCrawlerResponse(url: URL) {
  const attempts = [
    crawlerHeaders(userAgent),
    crawlerHeaders(fallbackUserAgent),
  ];
  let latestResponse: Response | null = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: attempts[index],
      signal: AbortSignal.timeout(18_000),
    });

    if (response.ok) return response;
    latestResponse = response;

    if (index === attempts.length - 1 || !shouldRetryWithAlternateHeaders(response.status)) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs(response));
  }

  return latestResponse as Response;
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

function retryDelayMs(response: Response) {
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
