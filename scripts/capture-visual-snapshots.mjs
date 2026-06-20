#!/usr/bin/env node
import crypto from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import { chromium } from "playwright-core";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";
const promptChars = 12_000;
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const archiveRoot = resolve(
  String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot),
);
const limit = positiveInt(args.limit, 25);
const includeNotDue = boolArg(args.all, false) || boolArg(args["include-not-due"], false);
const sourceIdFilter = cleanText(args["source-id"]);
const sourceUrlFilter = cleanText(args["source-url"]);
const awardFilter = cleanText(args.award);
const continuous = boolArg(args.continuous, false);
const intervalMinutes = positiveInt(args["interval-minutes"], 60);
const baselineRefresh = boolArg(args["baseline-refresh"], false);
const promote = boolArg(args.promote, true);
const pdfOnly = boolArg(args["pdf-only"], false);
const webOnly = boolArg(args["web-only"], false);
const keepUnchanged = boolArg(args["keep-unchanged"], false);
const keepRejected = boolArg(args["keep-rejected"], false);
const reviewOnAiFailure = boolArg(args["review-on-ai-failure"], true);
const requestedAiProvider = String(args["ai-provider"] || env.AI_PROVIDER || "auto").toLowerCase();
const viewportWidth = positiveInt(args["viewport-width"], 1365);
const viewportHeight = positiveInt(args["viewport-height"], 1600);
const jpegQuality = boundedInt(args["jpeg-quality"], 72, 30, 95);
const thumbWidth = positiveInt(args["thumb-width"], 900);
const timeoutMs = positiveInt(args["timeout-ms"], 60_000);
const delayMs = nonNegativeInt(args["delay-ms"], 0);
const domainDelayMs = Math.max(1_500, nonNegativeInt(args["domain-delay-ms"], 1_500));
const maxSourcesPerBrowser = positiveInt(args["max-sources-per-browser"], 250);
const maxPdfBytes = positiveInt(args["max-pdf-mb"], 50) * 1024 * 1024;
const aiProvider = selectAiProvider(requestedAiProvider, {
  gemini: env.GEMINI_API_KEY,
  openai: env.OPENAI_API_KEY,
});
const aiModel = modelForProvider(aiProvider);
let supabase = null;
const hostLastFetchAt = new Map();
const crawlerUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AwardPingVisualSnapshot/1.0 (+https://awardping.com/contact)";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!aiProvider) {
  console.error(missingAiMessage(requestedAiProvider));
  process.exit(1);
}

supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

async function runOnce() {
  ensureArchiveDirectories();

  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const reportPath = join(root, "reports", `visual-snapshot-run-${runStamp}.json`);
  const report = {
    archive_root: archiveRoot,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    ai_provider: aiProvider,
    ai_model: aiModel,
    env_path: envPath,
    options: {
      limit,
      include_not_due: includeNotDue,
      source_id: sourceIdFilter || null,
      source_url: sourceUrlFilter || null,
      award: awardFilter || null,
      baseline_refresh: baselineRefresh,
      promote,
      pdf_only: pdfOnly,
      web_only: webOnly,
      keep_unchanged: keepUnchanged,
      keep_rejected: keepRejected,
      review_on_ai_failure: reviewOnAiFailure,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      jpeg_quality: jpegQuality,
      thumb_width: thumbWidth,
      timeout_ms: timeoutMs,
      delay_ms: delayMs,
      domain_delay_ms: domainDelayMs,
      max_sources_per_browser: maxSourcesPerBrowser,
      max_pdf_bytes: maxPdfBytes,
    },
    checked: 0,
    baselined: 0,
    unchanged: 0,
    candidate_changes: 0,
    ai_true_changes: 0,
    ai_rejected: 0,
    text_only_ignored: 0,
    deterministic_noise: 0,
    visual_noise: 0,
    review: 0,
    skipped_pdf: 0,
    failed: 0,
    promoted: 0,
    pdf_checked: 0,
    pdf_unchanged: 0,
    pdf_changed: 0,
    gemini_usage: {
      calls: 0,
      prompt_tokens: 0,
      candidates_tokens: 0,
      total_tokens: 0,
      thoughts_tokens: 0,
      cached_content_tokens: 0,
      note: "Gemini API responses include token usage but not AI Studio dollar spend. Use Google AI Studio Spend for account spend/cap dollars.",
    },
    errors: [],
    saved_change_paths: [],
    review_paths: [],
    rejected_paths: [],
  };

  let browser = null;
  let context = null;
  let browserMeta = null;
  let sourcesSinceBrowserStart = 0;
  let workerRunId = null;

  async function restartBrowser(reason) {
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
    context = null;
    browser = null;

    const launched = await launchBrowser();
    browser = launched.browser;
    browserMeta = launched.browserMeta;
    context = await createBrowserContext(browser);
    sourcesSinceBrowserStart = 0;

    if (reason) {
      console.log(`BROWSER restarted ${reason}`);
    }
  }

  try {
    workerRunId = await startWorkerRun(report);
    const sources = await loadSources(limit);

    for (const source of sources) {
      const pdfSource = isPdfSource(source);
      if (pdfOnly && !pdfSource) {
        continue;
      }
      if (webOnly && pdfSource) {
        continue;
      }

      if (!pdfSource && !context) {
        await restartBrowser("initial");
      } else if (!pdfSource && sourcesSinceBrowserStart >= maxSourcesPerBrowser) {
        await restartBrowser(`after_${sourcesSinceBrowserStart}_sources`);
      }

      let retriedAfterBrowserRestart = false;
      while (true) {
        try {
          await waitForDomain(source.url);
          await processSource(source, context, browserMeta, report);
          sourcesSinceBrowserStart += 1;
          break;
        } catch (error) {
          if (!retriedAfterBrowserRestart && isBrowserClosedError(error)) {
            console.log(`BROWSER closed ${sourceLabel(source)} | ${errorMessage(error)}`);
            await restartBrowser("after_closed_context");
            retriedAfterBrowserRestart = true;
            continue;
          }

          report.failed += 1;
          const message = errorMessage(error);
          report.errors.push({
            source_id: source.id,
            source_url: source.url,
            message,
          });
          console.log(`FAILED ${message} ${sourceLabel(source)}`);

          if (isBrowserClosedError(error)) {
            await restartBrowser("after_failed_closed_context");
          }
          break;
        }
      }
    }

    report.status = "succeeded";
    await finishWorkerRun(workerRunId, "succeeded", null, report);
  } catch (error) {
    report.status = "failed";
    report.failed += 1;
    report.errors.push({
      source_id: null,
      source_url: null,
      message: errorMessage(error),
    });
    await finishWorkerRun(workerRunId, "failed", errorMessage(error), report);
    throw error;
  } finally {
    await context?.close().catch(() => null);
    await browser?.close().catch(() => null);
    report.finished_at = new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`REPORT ${reportPath}`);
  }
}

async function processSource(source, context, browserMeta, report) {
  const pdfSource = isPdfSource(source);
  const capture = pdfSource
    ? await capturePdfSource(source)
    : await captureSource(source, context, browserMeta);
  report.checked += 1;
  if (capture.kind === "pdf") {
    report.pdf_checked += 1;
  }

  const baselinePath = baselinePathForSource(source.id);
  const baseline = readJsonIfExists(baselinePath);

  if (!baseline || baselineRefresh) {
    writeBaseline(source, capture, {
      reason: baseline ? "baseline_refresh" : "initial_baseline",
      previous_baseline: baseline || null,
    });
    report.baselined += 1;
    console.log(`BASELINE ${capture.kind === "pdf" ? "PDF " : ""}${sourceLabel(source)}`);
    return;
  }

  const previous = readBaselineEvidence(baseline);
  if (!previous.ok) {
    throw new Error(
      `Baseline exists but evidence is missing (${previous.missing.join(", ")}). Rerun with --baseline-refresh=true after confirming the source.`,
    );
  }

  if (capture.kind === "pdf" || previous.kind === "pdf") {
    processPdfComparison(source, baseline, previous, capture, report);
    return;
  }

  const screenshotChanged = capture.image_hash !== baseline.image_hash;
  const textChanged = capture.text_hash !== baseline.text_hash;

  if (!screenshotChanged) {
    report.unchanged += 1;
    if (textChanged) {
      report.text_only_ignored += 1;
      console.log(`UNCHANGED screenshot_match_text_diff_ignored ${sourceLabel(source)}`);
    } else {
      console.log(`UNCHANGED ${sourceLabel(source)}`);
    }
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  const diff = buildDiffSummary(previous.text, capture.text, source);
  const deterministic = textChanged
    ? classifyDeterministicChange(diff, source)
    : {
        classification: "visual_candidate",
        reason: "screenshot_hash_changed_without_normalized_text_change",
        candidate_change: true,
      };

  report.candidate_changes += 1;
  const aiReview = await reviewCandidateWithAi({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
  }).catch((error) => ({
    ok: false,
    error: errorMessage(error),
    provider: aiProvider,
    model: aiModel,
    usage: error.aiUsage || null,
  }));

  if (aiReview.provider === "gemini" && aiReview.usage) {
    recordGeminiUsage(report, source, capture, aiReview);
  }

  if (!aiReview.ok) {
    if (reviewOnAiFailure) {
      const reviewPath = saveReviewRecord({
        source,
        baseline,
        previous,
        capture,
        diff,
        deterministic,
        reason: `ai_failure: ${aiReview.error}`,
        aiReview,
      });
      report.review += 1;
      report.review_paths.push(toArchiveRelative(reviewPath));
      console.log(`REVIEW ai_failure ${sourceLabel(source)}`);
    } else if (!keepUnchanged) {
      removeGeneratedCaptureDir(capture.dir);
    }
    return;
  }

  if (aiReview.result.confidence === "low") {
    const reviewPath = saveReviewRecord({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      reason: "low_confidence",
      aiReview,
    });
    report.review += 1;
    report.review_paths.push(toArchiveRelative(reviewPath));
    console.log(`REVIEW low_confidence ${sourceLabel(source)}`);
    return;
  }

  if (aiReview.result.is_true_change) {
    const changePath = saveTrueChange({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      aiReview,
    });
    report.ai_true_changes += 1;
    report.saved_change_paths.push(toArchiveRelative(changePath));

    if (promote) {
      writeBaseline(source, capture, {
        reason: "ai_approved_true_change",
        previous_baseline_capture: baseline.capture || null,
      });
      report.promoted += 1;
    }

    console.log(`AI TRUE ${aiReview.result.reader_summary || sourceLabel(source)}`);
    return;
  }

  report.ai_rejected += 1;
  if (keepRejected) {
    const rejectedPath = saveRejectedRecord({
      source,
      baseline,
      previous,
      capture,
      diff,
      deterministic,
      aiReview,
    });
    report.rejected_paths.push(toArchiveRelative(rejectedPath));
  } else if (!keepUnchanged) {
    removeGeneratedCaptureDir(capture.dir);
  }
  console.log(`AI REJECTED ${aiReview.result.noise_reason || "not award-relevant"} ${sourceLabel(source)}`);
}

function processPdfComparison(source, baseline, previous, capture, report) {
  const previousHash = baseline.file_hash || baseline.image_hash;
  const fileChanged = capture.file_hash !== previousHash;
  const textChanged = capture.text_hash !== baseline.text_hash;

  if (!fileChanged) {
    report.unchanged += 1;
    report.pdf_unchanged += 1;
    console.log(textChanged ? `UNCHANGED pdf_file_match_text_diff_ignored ${sourceLabel(source)}` : `UNCHANGED pdf_file_match ${sourceLabel(source)}`);
    if (!keepUnchanged) removeGeneratedCaptureDir(capture.dir);
    return;
  }

  const diff = buildDiffSummary(previous.text || "", capture.text || "", source);
  const deterministic = {
    classification: "candidate_change",
    reason: "pdf_file_hash_changed",
    candidate_change: true,
    previous_file_hash: previousHash || null,
    new_file_hash: capture.file_hash,
    previous_file_bytes: baseline.file_bytes || previous.meta?.file_bytes || null,
    new_file_bytes: capture.file_bytes,
  };
  const reviewPath = saveReviewRecord({
    source,
    baseline,
    previous,
    capture,
    diff,
    deterministic,
    reason: "pdf_file_hash_changed",
    aiReview: {
      provider: "none",
      model: null,
      result: null,
      error: null,
    },
  });

  report.candidate_changes += 1;
  report.review += 1;
  report.pdf_changed += 1;
  report.review_paths.push(toArchiveRelative(reviewPath));

  if (promote) {
    writeBaseline(source, capture, {
      reason: "pdf_file_hash_changed",
      previous_baseline_capture: baseline.capture || null,
    });
    report.promoted += 1;
  }

  console.log(`REVIEW pdf_changed ${sourceLabel(source)}`);
}

async function capturePdfSource(source) {
  const capturedAt = new Date().toISOString();
  const captureStamp = timestampForPath(capturedAt);
  const sourceDir = join(archiveRoot, "sources", source.id);
  const captureDir = join(sourceDir, "captures", captureStamp);
  mkdirSync(captureDir, { recursive: true });

  const pdfPath = join(captureDir, "document.pdf");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const download = await fetchPdfSource(source.url);
  const fileHash = hashBuffer(download.buffer);
  const extracted = await extractPdfText(download.buffer);
  const text = normalizeVisibleText(extracted.text || "");
  const textHash = hashText(text);

  writeFileSync(pdfPath, download.buffer);
  writeFileSync(textPath, `${text}\n`, "utf8");

  const meta = {
    version: 1,
    kind: "pdf",
    source: sourceMetadata(source),
    captured_at: capturedAt,
    final_url: download.finalUrl,
    status_code: download.status,
    status_text: download.statusText,
    content_type: download.contentType,
    file_hash: fileHash,
    image_hash: fileHash,
    text_hash: textHash,
    text_length: text.length,
    file_bytes: download.buffer.length,
    page_title: source.title || null,
    page_count: extracted.pageCount,
    pdf_text_error: extracted.error,
    files: {
      pdf: toArchiveRelative(pdfPath),
      text: toArchiveRelative(textPath),
      meta: toArchiveRelative(metaPath),
    },
  };

  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  return {
    ...meta,
    dir: captureDir,
    pdf_path: pdfPath,
    text_path: textPath,
    meta_path: metaPath,
    text,
  };
}

async function fetchPdfSource(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": crawlerUserAgent,
        Accept: "application/pdf,application/octet-stream,text/html;q=0.8,*/*;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`PDF download failed with HTTP ${response.status} ${response.statusText}`.trim());
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxPdfBytes) {
      throw new Error(`PDF is too large (${contentLength} bytes; limit ${maxPdfBytes} bytes)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxPdfBytes) {
      throw new Error(`PDF is too large (${buffer.length} bytes; limit ${maxPdfBytes} bytes)`);
    }

    return {
      buffer,
      finalUrl: response.url || url,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function extractPdfText(buffer) {
  let parser = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return {
      text: result.text || "",
      pageCount: result.total || null,
      error: null,
    };
  } catch (error) {
    return {
      text: "",
      pageCount: null,
      error: errorMessage(error),
    };
  } finally {
    await parser?.destroy().catch(() => null);
  }
}

async function captureSource(source, context, browserMeta) {
  const capturedAt = new Date().toISOString();
  const captureStamp = timestampForPath(capturedAt);
  const sourceDir = join(archiveRoot, "sources", source.id);
  const captureDir = join(sourceDir, "captures", captureStamp);
  mkdirSync(captureDir, { recursive: true });

  const pagePath = join(captureDir, "page.jpg");
  const thumbPath = join(captureDir, "thumb.jpg");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  const page = await context.newPage();

  let response = null;
  try {
    response = await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(15_000, timeoutMs) }).catch(() => null);
    await page.evaluate(() => document.fonts?.ready).catch(() => null);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
    await page.addStyleTag({ content: stableCaptureCss }).catch(() => null);
    const hiddenNoise = await hideNoiseElements(page);
    await page.evaluate(() => {
      for (const video of document.querySelectorAll("video")) {
        video.pause?.();
        video.removeAttribute("autoplay");
      }
    }).catch(() => null);
    await page.waitForTimeout(250).catch(() => null);

    const pageTitle = await page.title().catch(() => "");
    const finalUrl = page.url();
    const dimensions = await page.evaluate(() => ({
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      scroll_width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      scroll_height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      device_pixel_ratio: window.devicePixelRatio || 1,
    }));
    const rawText = await page.evaluate(() => document.body?.innerText || "");
    const text = normalizeVisibleText(rawText);
    const textHash = hashText(text);
    const pageBuffer = await page.screenshot({
      path: pagePath,
      fullPage: true,
      type: "jpeg",
      quality: jpegQuality,
      timeout: timeoutMs,
    });
    const imageHash = hashBuffer(pageBuffer);
    const thumbnail = await createThumbnail(context, pageBuffer);
    writeFileSync(thumbPath, thumbnail);
    writeFileSync(textPath, `${text}\n`, "utf8");

    const meta = {
      version: 1,
      source: sourceMetadata(source),
      captured_at: capturedAt,
      final_url: finalUrl,
      page_title: pageTitle,
      status_code: response?.status() || null,
      status_text: response?.statusText() || null,
      text_hash: textHash,
      image_hash: imageHash,
      text_length: text.length,
      page_bytes: pageBuffer.length,
      thumb_bytes: thumbnail.length,
      dimensions,
      browser: browserMeta,
      hidden_noise_counts: hiddenNoise,
      files: {
        page: toArchiveRelative(pagePath),
        thumb: toArchiveRelative(thumbPath),
        text: toArchiveRelative(textPath),
        meta: toArchiveRelative(metaPath),
      },
    };

    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

    return {
      ...meta,
      dir: captureDir,
      page_path: pagePath,
      thumb_path: thumbPath,
      text_path: textPath,
      meta_path: metaPath,
      text,
    };
  } finally {
    await page.close().catch(() => null);
  }
}

async function createThumbnail(context, pageBuffer) {
  const thumbPage = await context.newPage();
  try {
    await thumbPage.setViewportSize({ width: Math.min(thumbWidth, viewportWidth), height: 1200 });
    const dataUrl = `data:image/jpeg;base64,${pageBuffer.toString("base64")}`;
    await thumbPage.setContent(
      [
        "<!doctype html><html><head><meta charset=\"utf-8\">",
        "<style>html,body{margin:0;padding:0;background:white;overflow:hidden}</style>",
        "</head><body><img id=\"source\" alt=\"snapshot\" src=\"",
        dataUrl,
        "\"></body></html>",
      ].join(""),
      { waitUntil: "load" },
    );

    const data = await thumbPage.evaluate(
      async ({ width, quality }) => {
        const img = document.getElementById("source");
        await img.decode().catch(() => null);
        const maxHeight = 8000;
        const scale = Math.min(width / img.naturalWidth, maxHeight / img.naturalHeight, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context2d = canvas.getContext("2d");
        context2d.fillStyle = "#ffffff";
        context2d.fillRect(0, 0, canvas.width, canvas.height);
        context2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", quality);
      },
      { width: thumbWidth, quality: jpegQuality / 100 },
    );
    return Buffer.from(data.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  } finally {
    await thumbPage.close().catch(() => null);
  }
}

async function hideNoiseElements(page) {
  return page.evaluate((keywords) => {
    const counts = {};
    const protectedMainSelectors = "main, article, [role='main'], .content, #content";
    const awardTerms =
      /\b(deadline|due|application|apply|eligib|requirement|recommendation|transcript|essay|interview|funding|stipend|tuition|award amount|nomination|guideline|pdf)\b/i;

    function textOf(element) {
      return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    }

    function selectorSignals(element) {
      return [
        element.id,
        element.className,
        element.getAttribute("aria-label"),
        element.getAttribute("role"),
        element.getAttribute("data-testid"),
        element.getAttribute("data-test"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function isProtectedMainContent(element, signal) {
      if (element.matches(protectedMainSelectors)) return true;
      if (element.closest("main, article, [role='main']") && awardTerms.test(textOf(element))) {
        return !/(cookie|consent|gdpr|popup|modal|newsletter|subscribe|chat|intercom|drift|crisp|ad|ads|advertisement|sponsor|carousel|slider|swiper|slick|marquee)/i.test(signal);
      }
      return false;
    }

    function hide(element, reason) {
      if (!(element instanceof HTMLElement)) return;
      const signal = selectorSignals(element);
      if (isProtectedMainContent(element, signal)) return;
      counts[reason] = (counts[reason] || 0) + 1;
      element.setAttribute("data-awardping-hidden-noise", reason);
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("visibility", "hidden", "important");
    }

    const selectorRules = [
      ["cookie", "[id*='cookie' i], [class*='cookie' i], [aria-label*='cookie' i]"],
      ["consent", "[id*='consent' i], [class*='consent' i], [aria-label*='consent' i]"],
      ["gdpr", "[id*='gdpr' i], [class*='gdpr' i]"],
      ["privacy-banner", "[id*='privacy-banner' i], [class*='privacy-banner' i]"],
      ["popup", "[id*='popup' i], [class*='popup' i]"],
      ["modal", "[id*='modal' i], [class*='modal' i], [role='dialog'], [aria-modal='true']"],
      ["newsletter", "[id*='newsletter' i], [class*='newsletter' i], [aria-label*='newsletter' i]"],
      ["subscribe", "[id*='subscribe' i], [class*='subscribe' i], [aria-label*='subscribe' i]"],
      ["intercom", "[id*='intercom' i], [class*='intercom' i]"],
      ["drift", "[id*='drift' i], [class*='drift' i]"],
      ["crisp", "[id*='crisp' i], [class*='crisp' i]"],
      ["chat", "[id*='chat' i], [class*='chat' i], [aria-label*='chat' i]"],
      ["chatbot", "[id*='chatbot' i], [class*='chatbot' i]"],
      ["ad", "[id='ad'], [class='ad'], [id*='advertisement' i], [class*='advertisement' i], [id*='ad-banner' i], [class*='ad-banner' i]"],
      ["ads", "[id*='ads' i], [class*='ads' i], [id*='google_ads' i], [class*='google_ads' i]"],
      ["sponsor", "[id*='sponsor' i], [class*='sponsor' i]"],
      ["carousel", "[id*='carousel' i], [class*='carousel' i]"],
      ["slider", "[id*='slider' i], [class*='slider' i]"],
      ["swiper", "[id*='swiper' i], [class*='swiper' i]"],
      ["slick", "[id*='slick' i], [class*='slick' i]"],
      ["marquee", "marquee, [id*='marquee' i], [class*='marquee' i]"],
      ["dismissible-alert", "[class*='alert' i][class*='dismiss' i], [role='alert'][aria-live]"],
      ["sticky-social-share", "[id*='social-share' i], [class*='social-share' i], [id*='sharebar' i], [class*='sharebar' i]"],
    ];

    for (const [reason, selector] of selectorRules) {
      for (const element of document.querySelectorAll(selector)) {
        hide(element, reason);
      }
    }

    for (const element of document.querySelectorAll("body *")) {
      const signal = selectorSignals(element);
      if (!signal) continue;
      if (!keywords.some((keyword) => signal.includes(keyword))) continue;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const overlayLike =
        style.position === "fixed" ||
        style.position === "sticky" ||
        rect.width * rect.height < window.innerWidth * window.innerHeight * 0.35 ||
        /(cookie|consent|gdpr|popup|modal|newsletter|subscribe|intercom|drift|crisp|chatbot|chat|advertisement|ad-banner|carousel|slider|swiper|slick|marquee|social-share|sharebar)/i.test(signal);
      if (overlayLike) hide(element, "keyword-noise");
    }

    for (const element of document.querySelectorAll("iframe[src], aside")) {
      const signal = selectorSignals(element) + " " + (element.getAttribute("src") || "");
      if (/(youtube|vimeo|doubleclick|googlesyndication|advertisement|ads|chat|intercom|drift|crisp|social|share)/i.test(signal)) {
        hide(element, "embedded-widget");
      }
    }

    return counts;
  }, noiseKeywords);
}

async function reviewCandidateWithAi(input) {
  if (aiProvider === "gemini") return reviewWithGemini(input);
  if (aiProvider === "openai") return reviewWithOpenAI(input);
  throw new Error("No AI provider is available.");
}

async function reviewWithGemini(input) {
  const previousThumb = readFileSync(input.previous.thumbPath).toString("base64");
  const newThumb = readFileSync(input.capture.thumb_path).toString("base64");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      aiModel,
    )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: aiSystemPrompt }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: aiUserPrompt(input) },
              { inlineData: { mimeType: "image/jpeg", data: previousThumb } },
              { inlineData: { mimeType: "image/jpeg", data: newThumb } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
          responseSchema: aiResponseSchema,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json();
  const usage = normalizeGeminiUsage(data.usageMetadata);
  const rawText = extractGeminiText(data);
  let result = null;
  try {
    result = normalizeAiReview(rawText);
  } catch (error) {
    error.aiUsage = usage;
    throw error;
  }

  return {
    ok: true,
    provider: "gemini",
    model: aiModel,
    usage,
    raw_text: rawText,
    result,
  };
}

async function reviewWithOpenAI(input) {
  const previousThumb = readFileSync(input.previous.thumbPath).toString("base64");
  const newThumb = readFileSync(input.capture.thumb_path).toString("base64");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: aiModel,
      instructions: aiSystemPrompt,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: aiUserPrompt(input) },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${previousThumb}`,
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${newThumb}`,
            },
          ],
        },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: 900,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const data = await response.json();
  return {
    ok: true,
    provider: "openai",
    model: aiModel,
    raw_text: extractResponseText(data),
    result: normalizeAiReview(extractResponseText(data)),
  };
}

function aiUserPrompt({ source, baseline, previous, capture, diff, deterministic }) {
  return [
    `Award name: ${source.shared_awards?.name || "Unknown award"}`,
    `Source title: ${source.title || "Unknown source"}`,
    `Source URL: ${source.url}`,
    `Page type: ${source.page_type || "unknown"}`,
    "",
    "Previous baseline metadata:",
    JSON.stringify({
      captured_at: baseline.captured_at,
      final_url: baseline.final_url,
      page_title: baseline.page_title,
      text_hash: baseline.text_hash,
      image_hash: baseline.image_hash,
      capture: baseline.capture,
    }),
    "",
    "New capture metadata:",
    JSON.stringify({
      captured_at: capture.captured_at,
      final_url: capture.final_url,
      page_title: capture.page_title,
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      files: capture.files,
      hidden_noise_counts: capture.hidden_noise_counts,
    }),
    "",
    "Screenshot comparison is the primary signal. The two attached images are the previous thumbnail and the new thumbnail. Normalized text is secondary context and may be incomplete or noisy.",
    "",
    "Deterministic classification:",
    JSON.stringify(deterministic),
    "",
    "Deterministic diff summary:",
    JSON.stringify(diff),
    "",
    "Previous normalized text excerpt:",
    previous.text.slice(0, promptChars),
    "",
    "New normalized text excerpt:",
    capture.text.slice(0, promptChars),
    "",
    "Full screenshot paths for local human review:",
    JSON.stringify({
      previous_page: toArchiveRelative(previous.pagePath),
      new_page: toArchiveRelative(capture.page_path),
      previous_thumb: toArchiveRelative(previous.thumbPath),
      new_thumb: toArchiveRelative(capture.thumb_path),
    }),
    "",
    "Return one strict JSON object only.",
  ].join("\n");
}

function saveTrueChange({ source, baseline, previous, capture, diff, deterministic, aiReview }) {
  const changeDir = changeDirForCapture(capture, source.id);
  mkdirSync(changeDir, { recursive: true });
  const evidence = copyEvidenceFiles(changeDir, previous, capture);
  const changePath = join(changeDir, "change.json");
  const change = {
    version: 1,
    source_id: source.id,
    shared_award_id: source.shared_award_id,
    award_name: source.shared_awards?.name || null,
    source_title: source.title || null,
    source_url: source.url,
    page_type: source.page_type || null,
    detected_at: new Date().toISOString(),
    previous_baseline_capture_path: baseline.capture?.dir || null,
    new_capture_path: toArchiveRelative(capture.dir),
    previous_hashes: {
      text_hash: baseline.text_hash,
      image_hash: baseline.image_hash,
      file_hash: baseline.file_hash || null,
    },
    new_hashes: {
      text_hash: capture.text_hash,
      image_hash: capture.image_hash,
      file_hash: capture.file_hash || null,
    },
    deterministic_classification: deterministic,
    deterministic_diff: diff,
    ai_provider: aiReview.provider,
    ai_model: aiReview.model,
    ai_result: aiReview.result,
    reader_summary: aiReview.result.reader_summary,
    advisor_impact: aiReview.result.advisor_impact,
    changed_section: aiReview.result.changed_section,
    confidence: aiReview.result.confidence,
    promotion_status: promote ? "promoted" : "promotion_disabled",
    files: evidence,
  };
  writeFileSync(changePath, JSON.stringify(change, null, 2), "utf8");
  return changePath;
}

function saveReviewRecord({ source, baseline, previous, capture, diff, deterministic, reason, aiReview }) {
  const reviewDir = reviewDirForCapture(capture, source.id);
  mkdirSync(reviewDir, { recursive: true });
  const evidence = copyEvidenceFiles(reviewDir, previous, capture);
  const reviewPath = join(reviewDir, "review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify(
      {
        version: 1,
        reason,
        source: sourceMetadata(source),
        detected_at: new Date().toISOString(),
        previous_baseline_capture_path: baseline.capture?.dir || null,
        new_capture_path: toArchiveRelative(capture.dir),
        previous_hashes: {
          text_hash: baseline.text_hash,
          image_hash: baseline.image_hash,
          file_hash: baseline.file_hash || null,
        },
        new_hashes: {
          text_hash: capture.text_hash,
          image_hash: capture.image_hash,
          file_hash: capture.file_hash || null,
        },
        deterministic_classification: deterministic,
        deterministic_diff: diff,
        ai_provider: aiReview.provider || aiProvider,
        ai_model: aiReview.model || aiModel,
        ai_result: aiReview.result || null,
        ai_error: aiReview.error || null,
        files: evidence,
      },
      null,
      2,
    ),
    "utf8",
  );
  return reviewPath;
}

function saveRejectedRecord({ source, baseline, previous, capture, diff, deterministic, aiReview }) {
  const rejectedDir = rejectedDirForCapture(capture, source.id);
  mkdirSync(rejectedDir, { recursive: true });
  const rejectedPath = join(rejectedDir, "rejected.json");
  writeFileSync(
    rejectedPath,
    JSON.stringify(
      {
        version: 1,
        source: sourceMetadata(source),
        detected_at: new Date().toISOString(),
        noise_reason: aiReview.result.noise_reason || "AI rejected the candidate change.",
        previous_baseline_capture_path: baseline.capture?.dir || null,
        new_capture_path: toArchiveRelative(capture.dir),
        previous_hashes: {
          text_hash: baseline.text_hash,
          image_hash: baseline.image_hash,
          file_hash: baseline.file_hash || null,
        },
        new_hashes: {
          text_hash: capture.text_hash,
          image_hash: capture.image_hash,
          file_hash: capture.file_hash || null,
        },
        deterministic_classification: deterministic,
        deterministic_diff: diff,
        ai_provider: aiReview.provider,
        ai_model: aiReview.model,
        ai_result: aiReview.result,
        paths: {
          previous_text: toArchiveRelative(previous.textPath),
          previous_thumb: toArchiveRelative(previous.thumbPath),
          new_text: toArchiveRelative(capture.text_path),
          new_thumb: toArchiveRelative(capture.thumb_path),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return rejectedPath;
}

function copyEvidenceFiles(targetDir, previous, capture) {
  const files = {};
  const copyIfPresent = (key, sourcePath, targetName) => {
    if (!sourcePath || !existsSync(sourcePath)) return;
    files[key] = join(targetDir, targetName);
    copyFileSync(sourcePath, files[key]);
  };

  copyIfPresent("previous_page", previous.pagePath, "previous-page.jpg");
  copyIfPresent("new_page", capture.page_path, "new-page.jpg");
  copyIfPresent("previous_thumb", previous.thumbPath, "previous-thumb.jpg");
  copyIfPresent("new_thumb", capture.thumb_path, "new-thumb.jpg");
  copyIfPresent("previous_pdf", previous.pdfPath, "previous-document.pdf");
  copyIfPresent("new_pdf", capture.pdf_path, "new-document.pdf");
  copyIfPresent("previous_text", previous.textPath, "previous-text.txt");
  copyIfPresent("new_text", capture.text_path, "new-text.txt");
  copyIfPresent("previous_meta", previous.metaPath, "previous-meta.json");
  copyIfPresent("new_meta", capture.meta_path, "new-meta.json");

  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => [key, toArchiveRelative(value)]),
  );
}

function writeBaseline(source, capture, details) {
  const baselinePath = baselinePathForSource(source.id);
  mkdirSync(dirname(baselinePath), { recursive: true });
  const baseline = {
    version: 1,
    kind: capture.kind || "webpage",
    source: sourceMetadata(source),
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    page_title: capture.page_title,
    text_hash: capture.text_hash,
    image_hash: capture.image_hash,
    file_hash: capture.file_hash || null,
    file_bytes: capture.file_bytes || null,
    text_length: capture.text_length,
    dimensions: capture.dimensions,
    hidden_noise_counts: capture.hidden_noise_counts,
    capture: {
      dir: toArchiveRelative(capture.dir),
      page: capture.page_path ? toArchiveRelative(capture.page_path) : null,
      thumb: capture.thumb_path ? toArchiveRelative(capture.thumb_path) : null,
      pdf: capture.pdf_path ? toArchiveRelative(capture.pdf_path) : null,
      text: toArchiveRelative(capture.text_path),
      meta: toArchiveRelative(capture.meta_path),
    },
    summary_metadata: {
      reason: details.reason,
      updated_at: new Date().toISOString(),
      ai_provider: aiProvider,
      ai_model: aiModel,
      previous_baseline: details.previous_baseline
        ? {
            captured_at: details.previous_baseline.captured_at || null,
            text_hash: details.previous_baseline.text_hash || null,
            image_hash: details.previous_baseline.image_hash || null,
            file_hash: details.previous_baseline.file_hash || null,
            capture: details.previous_baseline.capture || null,
          }
        : null,
      previous_baseline_capture: details.previous_baseline_capture || null,
    },
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
}

function readBaselineEvidence(baseline) {
  const capture = baseline.capture || {};
  const kind = baseline.kind || (capture.pdf ? "pdf" : "webpage");
  const paths = {
    pagePath: capture.page ? fromArchiveRelative(capture.page) : null,
    thumbPath: capture.thumb ? fromArchiveRelative(capture.thumb) : null,
    pdfPath: capture.pdf ? fromArchiveRelative(capture.pdf) : null,
    textPath: fromArchiveRelative(capture.text),
    metaPath: fromArchiveRelative(capture.meta),
  };
  const requiredPaths =
    kind === "pdf" ? [paths.pdfPath, paths.textPath, paths.metaPath] : [paths.pagePath, paths.thumbPath, paths.textPath, paths.metaPath];
  const missing = requiredPaths.filter((value) => !value || !existsSync(value));
  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    kind,
    ...paths,
    text: readFileSync(paths.textPath, "utf8"),
    meta: readJsonIfExists(paths.metaPath),
  };
}

function buildDiffSummary(previousText, nextText, source) {
  const previousClean = normalizeVisibleText(previousText);
  const nextClean = normalizeVisibleText(nextText);
  const previousSentences = sentenceCandidates(previousClean);
  const nextSentences = sentenceCandidates(nextClean);
  const previousKeys = new Set(previousSentences.map(sentenceKey));
  const nextKeys = new Set(nextSentences.map(sentenceKey));
  const addedText = dedupeText(
    nextSentences.filter((sentence) => !previousKeys.has(sentenceKey(sentence))).filter(isUsefulChangedSentence),
  ).slice(0, 10);
  const removedText = dedupeText(
    previousSentences.filter((sentence) => !nextKeys.has(sentenceKey(sentence))).filter(isUsefulChangedSentence),
  ).slice(0, 10);
  const previousDates = new Set(contextualDatePhrases(previousClean));
  const nextDates = new Set(contextualDatePhrases(nextClean));
  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const nextAmounts = new Set(contextualMoneyPhrases(nextClean));
  const addedDates = [...nextDates].filter((value) => !previousDates.has(value));
  const removedDates = [...previousDates].filter((value) => !nextDates.has(value));
  const addedAmounts = [...nextAmounts].filter((value) => !previousAmounts.has(value));
  const removedAmounts = [...previousAmounts].filter((value) => !nextAmounts.has(value));
  const changedText = [...addedText, ...removedText, ...addedDates, ...removedDates, ...addedAmounts, ...removedAmounts].join(" ");

  return {
    source_context: {
      award_name: source.shared_awards?.name || null,
      source_title: source.title || null,
      source_url: source.url,
      page_type: source.page_type || null,
    },
    added_text: addedText,
    removed_text: removedText,
    date_changes: [
      ...addedDates.map((value) => `Added ${value}`),
      ...removedDates.map((value) => `Removed ${value}`),
    ],
    amount_changes: [
      ...addedAmounts.map((value) => `Added ${value}`),
      ...removedAmounts.map((value) => `Removed ${value}`),
    ],
    likely_section: inferSection(changedText || source.title || ""),
    changed_text_excerpt: truncate(changedText, 2400),
    previous_text_length: previousClean.length,
    new_text_length: nextClean.length,
    text_length_delta: nextClean.length - previousClean.length,
  };
}

function classifyDeterministicChange(diff, source) {
  const changedText = [
    ...diff.added_text,
    ...diff.removed_text,
    ...diff.date_changes,
    ...diff.amount_changes,
  ].join(" ");

  if (!changedText.trim()) {
    return {
      classification: "likely_noise",
      reason: "no_useful_changed_text",
      candidate_change: false,
    };
  }

  const fragments = [...diff.added_text, ...diff.removed_text];
  if (fragments.length && fragments.every(isVolatileOrBoilerplateFragment)) {
    return {
      classification: "likely_noise",
      reason: "volatile_or_boilerplate_only",
      candidate_change: false,
    };
  }

  if (looksLikeRecipientNewsOrPressText(changedText)) {
    return {
      classification: "likely_noise",
      reason: "recipient_news_or_press_churn",
      candidate_change: false,
    };
  }

  if (
    hasAwardRelevantTerms(changedText) ||
    diff.date_changes.length > 0 ||
    diff.amount_changes.length > 0 ||
    isProtectedAwardPageType(source.page_type)
  ) {
    return {
      classification: "candidate_change",
      reason: "award_relevant_terms_or_context",
      candidate_change: true,
    };
  }

  return {
    classification: "likely_noise",
    reason: "no_award_relevant_terms",
    candidate_change: false,
  };
}

async function loadSources(pageLimit) {
  const pageSize = Math.min(1_000, pageLimit);
  const sources = [];

  for (let from = 0; sources.length < pageLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, pageLimit - 1);
    const { data, error } = await buildSourcesQuery().range(from, to);

    if (error) throw new Error(describeSupabaseError(error, "load shared award sources"));

    const page = data || [];
    sources.push(...page);

    if (page.length < to - from + 1) {
      break;
    }
  }

  return sources.slice(0, pageLimit);
}

function buildSourcesQuery() {
  let query = supabase
    .from("shared_award_sources")
    .select(
      "id, shared_award_id, url, title, page_type, last_checked_at, next_check_at, shared_awards!inner(id, name, status)",
    )
    .eq("shared_awards.status", "active")
    .order("next_check_at", { ascending: true })
    .order("created_at", { ascending: true });

  if (!includeNotDue) {
    query = query.lte("next_check_at", new Date().toISOString());
  }
  if (sourceIdFilter) {
    query = query.eq("id", sourceIdFilter);
  }
  if (sourceUrlFilter) {
    query = query.eq("url", sourceUrlFilter);
  }
  if (awardFilter) {
    query = query.ilike("shared_awards.name", `%${escapeLike(awardFilter)}%`);
  }

  return query;
}

async function startWorkerRun(report) {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: baselineRefresh
        ? "local-visual-snapshot-worker-baseline-refresh"
        : "local-visual-snapshot-worker",
      status: "running",
      ai_provider: aiProvider,
      metadata: visualWorkerMetadata(report),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (isMissingMetadataColumnError(error)) {
      return startWorkerRunWithoutMetadata();
    }
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record visual worker run")}`);
    return null;
  }

  return data?.id || null;
}

async function finishWorkerRun(runId, status, errorMessageValue, report) {
  if (!runId) return;

  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.ai_true_changes,
      unchanged_count: report.unchanged,
      initial_count: report.baselined,
      discovered_count: 0,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: visualWorkerMetadata(report),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    if (isMissingMetadataColumnError(error)) {
      await finishWorkerRunWithoutMetadata(runId, status, errorMessageValue, report);
      return;
    }
    console.log(`WORKER RUN LOG FAILED | ${error.message}`);
  }
}

async function startWorkerRunWithoutMetadata() {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: baselineRefresh
        ? "local-visual-snapshot-worker-baseline-refresh"
        : "local-visual-snapshot-worker",
      status: "running",
      ai_provider: aiProvider,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record visual worker run")}`);
    return null;
  }

  return data?.id || null;
}

async function finishWorkerRunWithoutMetadata(runId, status, errorMessageValue, report) {
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.ai_true_changes,
      unchanged_count: report.unchanged,
      initial_count: report.baselined,
      discovered_count: 0,
      failed_count: report.failed,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    console.log(`WORKER RUN LOG FAILED | ${error.message}`);
  }
}

function visualWorkerMetadata(report) {
  return {
    kind: "visual_snapshot",
    archive_root: report.archive_root,
    ai_model: report.ai_model,
    options: report.options,
    counts: {
      candidate_changes: report.candidate_changes,
      ai_true_changes: report.ai_true_changes,
      ai_rejected: report.ai_rejected,
      text_only_ignored: report.text_only_ignored,
      deterministic_noise: report.deterministic_noise,
      visual_noise: report.visual_noise,
      review: report.review,
      skipped_pdf: report.skipped_pdf,
      pdf_checked: report.pdf_checked,
      pdf_unchanged: report.pdf_unchanged,
      pdf_changed: report.pdf_changed,
      promoted: report.promoted,
    },
    gemini_usage: report.gemini_usage,
    paths: {
      saved_changes: report.saved_change_paths.slice(0, 20),
      review: report.review_paths.slice(0, 20),
      rejected: report.rejected_paths.slice(0, 20),
    },
    errors: report.errors.slice(0, 20),
  };
}

function isMissingMetadataColumnError(error) {
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    (message.includes("metadata") && (message.includes("column") || message.includes("schema cache")))
  );
}

async function launchBrowser() {
  const executablePath = findInstalledBrowserExecutable();
  const launchOptions = {
    headless: true,
    timeout: timeoutMs,
    args: [
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,AutofillServerCommunication,MediaRouter",
      "--mute-audio",
    ],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  try {
    const browser = await chromium.launch(launchOptions);
    const version = browser.version();
    return {
      browser,
      browserMeta: {
        automation: "playwright-core",
        executable_path: executablePath || "playwright-default",
        browser_version: version,
        user_agent: crawlerUserAgent,
        viewport_width: viewportWidth,
        viewport_height: viewportHeight,
      },
    };
  } catch (error) {
    throw new Error(
      `Could not launch Chrome or Edge for visual snapshots. Install Chrome/Edge or set BROWSER_EXECUTABLE_PATH/CHROME_PATH/EDGE_PATH. ${errorMessage(error)}`,
    );
  }
}

async function createBrowserContext(browser) {
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    userAgent: crawlerUserAgent,
    locale: "en-US",
    colorScheme: "light",
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 1,
  });

  await context.addInitScript({
    content: `
      (() => {
        const style = document.createElement("style");
        style.setAttribute("data-awardping-stable-capture", "true");
        style.textContent = ${JSON.stringify(stableCaptureCss)};
        const attach = () => (document.head || document.documentElement).appendChild(style.cloneNode(true));
        if (document.documentElement) attach();
        else document.addEventListener("DOMContentLoaded", attach, { once: true });
      })();
    `,
  });

  await context.route("**/*", async (route) => {
    const url = route.request().url().toLowerCase();
    if (/(doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|adsystem|facebook\.net|hotjar|intercom|drift|crisp|optimizely|segment\.io)/i.test(url)) {
      await route.abort().catch(() => null);
      return;
    }
    await route.continue().catch(() => null);
  });

  return context;
}

function findInstalledBrowserExecutable() {
  const candidates = [
    args["browser-executable"],
    env.BROWSER_EXECUTABLE_PATH,
    env.CHROME_PATH,
    env.EDGE_PATH,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
    env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    env.PROGRAMFILES ? join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : null,
    env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe") : null,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function waitForDomain(value) {
  let hostname = "unknown";
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return;
  }

  const previous = hostLastFetchAt.get(hostname) || 0;
  const elapsed = Date.now() - previous;
  if (elapsed < domainDelayMs) {
    await sleep(domainDelayMs - elapsed);
  }
  hostLastFetchAt.set(hostname, Date.now());
}

function ensureArchiveDirectories() {
  for (const dir of [
    archiveRoot,
    join(archiveRoot, "sources"),
    join(archiveRoot, "changes"),
    join(archiveRoot, "review"),
    join(archiveRoot, "rejected"),
    join(archiveRoot, "usage"),
    join(root, "reports"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function recordGeminiUsage(report, source, capture, aiReview) {
  const usage = aiReview.usage || normalizeGeminiUsage(null);
  report.gemini_usage.calls += 1;
  report.gemini_usage.prompt_tokens += usage.prompt_tokens;
  report.gemini_usage.candidates_tokens += usage.candidates_tokens;
  report.gemini_usage.total_tokens += usage.total_tokens;
  report.gemini_usage.thoughts_tokens += usage.thoughts_tokens;
  report.gemini_usage.cached_content_tokens += usage.cached_content_tokens;

  const usedAt = new Date().toISOString();
  const record = {
    used_at: usedAt,
    date: usedAt.slice(0, 10),
    month: usedAt.slice(0, 7),
    provider: "gemini",
    model: aiReview.model,
    source_id: source.id,
    award_name: source.shared_awards?.name || null,
    source_title: source.title || null,
    source_url: source.url,
    capture_path: toArchiveRelative(capture.dir),
    usage,
  };
  const summary = appendGeminiUsageRecord(record);
  const today = summary.daily.find((day) => day.date === record.date);
  console.log(
    [
      "GEMINI_USAGE",
      `call_tokens=${usage.total_tokens}`,
      `today_tokens=${today?.total_tokens || 0}`,
      `month_tokens=${summary.month_total.total_tokens}`,
      "account_spend_source=google_ai_studio_spend",
    ].join(" "),
  );
}

function appendGeminiUsageRecord(record) {
  const usageDir = join(archiveRoot, "usage");
  mkdirSync(usageDir, { recursive: true });
  const monthPath = join(usageDir, `gemini-usage-${record.month}.jsonl`);
  appendFileSync(monthPath, `${JSON.stringify(record)}\n`, "utf8");

  const summary = summarizeGeminiUsageMonth(monthPath, record.month);
  const summaryPath = join(usageDir, `gemini-usage-${record.month}-summary.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(usageDir, "gemini-usage-current.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

function summarizeGeminiUsageMonth(monthPath, month) {
  const daily = new Map();
  const monthTotal = emptyGeminiUsageTotal();

  if (existsSync(monthPath)) {
    for (const line of readFileSync(monthPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.provider !== "gemini" || record.month !== month) continue;
      const usage = normalizeGeminiUsage(record.usage);
      const date = record.date || String(record.used_at || "").slice(0, 10) || "unknown";
      if (!daily.has(date)) daily.set(date, emptyGeminiUsageTotal());
      addGeminiUsage(daily.get(date), usage);
      addGeminiUsage(monthTotal, usage);
    }
  }

  const dailyRows = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date, ...total }));

  return {
    provider: "gemini",
    month,
    updated_at: new Date().toISOString(),
    account_spend_source: "Google AI Studio Spend page",
    note: "This file tracks AwardPing Gemini API calls and tokens. Exact dollar spend/cap usage is shown in Google AI Studio and may lag by up to 24 hours.",
    month_total: monthTotal,
    daily: dailyRows,
    raw_records_path: toArchiveRelative(monthPath),
  };
}

function emptyGeminiUsageTotal() {
  return {
    calls: 0,
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
  };
}

function addGeminiUsage(total, usage) {
  total.calls += 1;
  total.prompt_tokens += usage.prompt_tokens;
  total.candidates_tokens += usage.candidates_tokens;
  total.total_tokens += usage.total_tokens;
  total.thoughts_tokens += usage.thoughts_tokens;
  total.cached_content_tokens += usage.cached_content_tokens;
}

function baselinePathForSource(sourceId) {
  return join(archiveRoot, "sources", sourceId, "baseline.json");
}

function changeDirForCapture(capture, sourceId) {
  return join(archiveRoot, "changes", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function reviewDirForCapture(capture, sourceId) {
  return join(archiveRoot, "review", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function rejectedDirForCapture(capture, sourceId) {
  return join(archiveRoot, "rejected", `${timestampForPath(capture.captured_at)}-${sourceId}`);
}

function removeGeneratedCaptureDir(dir) {
  const resolvedDir = resolve(dir);
  if (!isPathInside(resolvedDir, archiveRoot)) {
    throw new Error(`Refusing to remove capture outside archive root: ${resolvedDir}`);
  }
  rmSync(resolvedDir, { recursive: true, force: true });
}

function isPathInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sourceMetadata(source) {
  return {
    id: source.id,
    shared_award_id: source.shared_award_id,
    award_name: source.shared_awards?.name || null,
    title: source.title || null,
    url: source.url,
    page_type: source.page_type || null,
    last_checked_at: source.last_checked_at || null,
    next_check_at: source.next_check_at || null,
  };
}

function sourceLabel(source) {
  return `${source.shared_awards?.name || source.title || source.id} | ${source.title || source.page_type || "source"} | ${source.url}`;
}

function isPdfSource(source) {
  if (String(source.page_type || "").toLowerCase() === "pdf") return true;
  try {
    return new URL(source.url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function toArchiveRelative(filePath) {
  return relative(archiveRoot, resolve(filePath)).replace(/\\/g, "/");
}

function fromArchiveRelative(value) {
  if (!value) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  return join(archiveRoot, value);
}

function normalizeVisibleText(value) {
  const lines = String(value || "")
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isVolatileLine(line));

  const result = [];
  const seenRecent = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seenRecent.has(key) && !hasAwardRelevantTerms(line)) continue;
    result.push(line);
    seenRecent.add(key);
    if (seenRecent.size > 200) {
      const first = seenRecent.values().next().value;
      seenRecent.delete(first);
    }
  }

  return result.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function isVolatileLine(line) {
  const clean = normalizeText(line);
  const lower = clean.toLowerCase();
  if (!clean) return true;
  if (hasAwardRelevantTerms(clean)) return false;
  if (/^(last updated|updated|modified|retrieved|accessed|current as of|as of)\s*:?\s*[\w,/: -]+$/i.test(clean)) return true;
  if (/^(today|yesterday|current date|local time)\s*:?\s*[\w,/: -]+$/i.test(clean)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i.test(clean)) return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?$/i.test(clean)) return true;
  if (/^\d+\s+(shares?|views?|likes?|comments?)$/i.test(clean)) return true;
  if (/^(slide|page)\s+\d+\s+(of|\/)\s+\d+$/i.test(clean)) return true;
  if (/\b(cookie|cookies|consent|gdpr|privacy preferences|accept all|reject all|manage preferences)\b/i.test(clean)) return true;
  if (/\b(facebook|instagram|linkedin|twitter|x\.com|youtube|share this|follow us|subscribe to our newsletter)\b/i.test(clean)) return true;
  if (/\b(skip to|toggle menu|open menu|close menu|search this site|breadcrumb|copyright|all rights reserved)\b/i.test(clean)) return true;
  if (lower.length <= 2) return true;
  return false;
}

function isVolatileOrBoilerplateFragment(value) {
  const clean = normalizeText(value);
  if (!clean) return true;
  if (hasAwardRelevantTerms(clean)) return false;
  return (
    isVolatileLine(clean) ||
    /\b(menu|navigation|footer|header|breadcrumb|subscribe|newsletter|social|share|cookie|privacy|advertisement|sponsor|carousel|slide|read more|learn more)\b/i.test(
      clean,
    ) ||
    looksLikeRecipientNewsOrPressText(clean)
  );
}

function hasAwardRelevantTerms(value) {
  return /\b(deadline|due date|applications?\s+(?:open|close|due)|opens?|closes?|apply|application|eligible|eligibility|requirements?|recommendations?|nomination|nominations?|transcripts?|essays?|interviews?|funding|stipend|tuition|award amount|amount awarded|guidelines?|instructions?|materials?|selection|submit|submission|citizenship|gpa|pdf|document|portal)\b/i.test(
    String(value || ""),
  );
}

function isProtectedAwardPageType(value) {
  return new Set(["homepage", "deadline", "application", "eligibility", "requirements", "faq"]).has(
    String(value || "").toLowerCase(),
  );
}

function sentenceCandidates(text) {
  return splitChangeSentences(normalizeText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 620);
}

function splitChangeSentences(text) {
  return protectSentenceAbbreviations(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map(restoreSentenceAbbreviations);
}

function protectSentenceAbbreviations(value) {
  return String(value || "")
    .replace(/\bM\.\s*D\./g, `M${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bPh\.\s*D\./gi, `Ph${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*S\./g, `U${sentenceDotPlaceholder}S${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*K\./g, `U${sentenceDotPlaceholder}K${sentenceDotPlaceholder}`)
    .replace(/\bi\.\s*e\./gi, `i${sentenceDotPlaceholder}e${sentenceDotPlaceholder}`)
    .replace(/\be\.\s*g\./gi, `e${sentenceDotPlaceholder}g${sentenceDotPlaceholder}`);
}

function restoreSentenceAbbreviations(value) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
}

function sentenceKey(sentence) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isUsefulChangedSentence(sentence) {
  const clean = normalizeText(sentence);
  if (isVolatileOrBoilerplateFragment(clean)) return false;
  if (looksLikeSourceAccessError(clean)) return true;
  return clean.length >= 20;
}

function contextualDatePhrases(text) {
  return unique(sentenceCandidates(text).filter(isAwardDateContext).flatMap(datePhrases));
}

function datePhrases(text) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => normalizeText(match[0])));
}

function isAwardDateContext(sentence) {
  const lower = String(sentence || "").toLowerCase();
  if (looksLikeRecipientNewsOrPressText(lower)) return false;
  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|acceptance|nomination|submit|submission)\b/.test(
    lower,
  );
}

function contextualMoneyPhrases(text) {
  return unique(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => normalizeText(match[0])),
  );
}

function contextAroundMatch(text, index) {
  return normalizeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value) {
  const lower = value.toLowerCase();
  if (/\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(lower)) {
    return false;
  }
  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(
    lower,
  );
}

function inferSection(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(deadline|timeline|dates?)\b/.test(lower)) return "Dates and deadlines";
  if (/\b(eligible|eligibility|requirements?)\b/.test(lower)) return "Eligibility";
  if (/\b(apply|application|submit|submission)\b/.test(lower)) return "Application";
  if (/\b(recommendation|transcript|essay|materials?)\b/.test(lower)) return "Materials";
  if (/\b(funding|stipend|tuition|amount)\b/.test(lower)) return "Funding";
  if (/\b(pdf|document|guideline|instruction)\b/.test(lower)) return "Documents";
  return null;
}

function looksLikeRecipientNewsOrPressText(value) {
  return /\b(latest news|press release|news|blog|story|stories|recipient profile|past recipients?|received the .* award|receives the .* award|was awarded|has been awarded|photo by|getty images|staff|job posting|event calendar|upcoming events)\b/i.test(
    String(value || ""),
  );
}

function looksLikeSourceAccessError(value) {
  const clean = normalizeText(String(value || ""));
  return /\b(error\s*(?:401|403|404|410|429|50[0-4])|access denied|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(
    clean,
  );
}

function normalizeAiReview(text) {
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error("AI returned invalid JSON.");
  const confidence = String(parsed.confidence || "").toLowerCase();
  if (!["low", "medium", "high"].includes(confidence)) {
    throw new Error("AI JSON is missing confidence.");
  }

  if (typeof parsed.is_true_change !== "boolean") {
    throw new Error("AI JSON is missing is_true_change.");
  }

  if (
    parsed.is_true_change &&
    (!cleanNullable(parsed.reader_summary) || !cleanNullable(parsed.advisor_impact))
  ) {
    throw new Error("AI approved a true change without reader_summary or advisor_impact.");
  }

  return {
    is_true_change: parsed.is_true_change,
    noise_reason: cleanNullable(parsed.noise_reason),
    reader_summary: cleanNullable(parsed.reader_summary),
    advisor_impact: cleanNullable(parsed.advisor_impact),
    changed_section: cleanNullable(parsed.changed_section),
    confidence,
  };
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join(" ")
    .trim();
}

function normalizeGeminiUsage(metadata) {
  const promptTokens = nonNegativeInt(metadata?.promptTokenCount ?? metadata?.prompt_tokens, 0);
  const candidatesTokens = nonNegativeInt(
    metadata?.candidatesTokenCount ?? metadata?.candidates_tokens,
    0,
  );
  const thoughtsTokens = nonNegativeInt(metadata?.thoughtsTokenCount ?? metadata?.thoughts_tokens, 0);
  const cachedContentTokens = nonNegativeInt(
    metadata?.cachedContentTokenCount ?? metadata?.cached_content_tokens,
    0,
  );
  const fallbackTotal = promptTokens + candidatesTokens + thoughtsTokens;
  return {
    prompt_tokens: promptTokens,
    candidates_tokens: candidatesTokens,
    total_tokens: nonNegativeInt(metadata?.totalTokenCount ?? metadata?.total_tokens, fallbackTotal),
    thoughts_tokens: thoughtsTokens,
    cached_content_tokens: cachedContentTokens,
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return (data?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || "")
    .join(" ")
    .trim();
}

function selectAiProvider(requestedProvider, keys) {
  const requested = String(requestedProvider || "auto").toLowerCase();
  if (requested === "gemini") return keys.gemini ? "gemini" : null;
  if (requested === "openai") return keys.openai ? "openai" : null;
  if (requested !== "auto") return null;
  if (keys.gemini) return "gemini";
  if (keys.openai) return "openai";
  return null;
}

function missingAiMessage(requestedProvider) {
  if (requestedProvider === "gemini") {
    return "GEMINI_API_KEY is required when --ai-provider=gemini. AI review is mandatory; refusing to run.";
  }
  if (requestedProvider === "openai") {
    return "OPENAI_API_KEY is required when --ai-provider=openai. AI review is mandatory; refusing to run.";
  }
  return "GEMINI_API_KEY or OPENAI_API_KEY is required for visual snapshot AI review. AI review is mandatory; refusing to run.";
}

function modelForProvider(provider) {
  if (provider === "gemini") return env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (provider === "openai") return env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini";
  return null;
}

function describeSupabaseError(error, action) {
  const message = error?.message || String(error);
  const details = error?.details ? ` ${error.details}` : "";
  const hint = error?.hint ? ` ${error.hint}` : "";
  const code = error?.code ? ` (${error.code})` : "";
  const fullText = `${message}${details}${hint}`.toLowerCase();

  if (fullText.includes("invalid api key")) {
    return "Invalid Supabase service_role key. Re-run the Windows installer and paste the Supabase project service_role key for the AwardPing Supabase project.";
  }
  if (
    fullText.includes("fetch failed") ||
    fullText.includes("failed to fetch") ||
    fullText.includes("econnrefused") ||
    fullText.includes("enotfound")
  ) {
    return `Could not reach Supabase while trying to ${action}. Check NEXT_PUBLIC_SUPABASE_URL in the worker env file. Current URL: ${supabaseUrl}.`;
  }
  if (
    fullText.includes("does not exist") ||
    fullText.includes("could not find the table") ||
    fullText.includes("schema cache") ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205"
  ) {
    return `${message}${code}. The Supabase schema is missing the shared-award/local-worker tables. Apply the AwardPing Supabase migrations.`;
  }

  return `${message}${details}${hint}${code} while trying to ${action}.`;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function timestampForPath(value = new Date().toISOString()) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanText(value) {
  return normalizeText(value).slice(0, 2000);
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function truncate(value, maxLength) {
  const clean = normalizeText(value);
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()}...`;
}

function dedupeText(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = normalizeText(value);
    if (!clean) continue;
    const key = sentenceKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[rawKey] = values[index + 1];
      index += 1;
    } else {
      parsed[rawKey] = "true";
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = positiveInt(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function isBrowserClosedError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser context was closed") ||
    message.includes("browser has been closed") ||
    message.includes("context has been closed") ||
    message.includes("target closed")
  );
}

const noiseKeywords = [
  "cookie",
  "consent",
  "gdpr",
  "privacy-banner",
  "popup",
  "modal",
  "newsletter",
  "subscribe",
  "intercom",
  "drift",
  "crisp",
  "chatbot",
  "chat",
  "advertisement",
  "ad-banner",
  "sponsor",
  "carousel",
  "slider",
  "swiper",
  "slick",
  "marquee",
  "social-share",
  "sharebar",
];

const stableCaptureCss = `
*,
*::before,
*::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
}
video,
audio,
canvas[data-live],
[aria-live="polite"],
[aria-live="assertive"] {
  animation: none !important;
}
[data-awardping-hidden-noise] {
  display: none !important;
  visibility: hidden !important;
}
`;

const aiSystemPrompt = [
  "You are judging official award webpage screenshot changes for scholarship advisors.",
  "Return valid strict JSON only. Do not include markdown.",
  "Compare the two attached screenshot thumbnails first. Use normalized text only as secondary context because it can be incomplete or noisy.",
  "Mark is_true_change=true only when a visible screenshot change shows that a concrete award-relevant fact changed.",
  "True changes include deadline changes, application opening or closing changes, eligibility changes, requirement changes, nomination or recommendation changes, document/PDF/guideline changes, funding/stipend/tuition/award amount changes, or application instruction changes.",
  "Reject cookie banners, carousels, ads, newsletter popups, current-date or last-updated-only changes, font/reflow/lazy-image changes, nav/footer/sidebar changes, social/share widgets, event/news/listing churn, recipient-news churn, staff/job content, unrelated research/news pages, and unrelated page widgets unless award requirements changed.",
  "Do not infer relevance just because words like award, fellowship, grant, application, or deadline appear in unrelated content.",
  "reader_summary should be one or two sentences, plain English, advisor-facing.",
  "advisor_impact should say what an advising office might need to check or update.",
  "If confidence is low, set is_true_change=false unless the changed award fact is explicit.",
  "Required keys: is_true_change, noise_reason, reader_summary, advisor_impact, changed_section, confidence.",
  "Use null for unavailable noise_reason, reader_summary, advisor_impact, or changed_section.",
  "confidence must be low, medium, or high.",
].join(" ");

const aiResponseSchema = {
  type: "object",
  properties: {
    is_true_change: { type: "boolean" },
    noise_reason: { type: "string", nullable: true },
    reader_summary: { type: "string", nullable: true },
    advisor_impact: { type: "string", nullable: true },
    changed_section: { type: "string", nullable: true },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "is_true_change",
    "noise_reason",
    "reader_summary",
    "advisor_impact",
    "changed_section",
    "confidence",
  ],
};

if (continuous) {
  while (true) {
    await runOnce().catch((error) => {
      console.error(errorMessage(error));
    });
    console.log(`Sleeping ${intervalMinutes} minutes before the next visual snapshot run.`);
    await sleep(intervalMinutes * 60 * 1000);
  }
} else {
  try {
    await runOnce();
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
