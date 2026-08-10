export const CAPTURE_RESOURCE_LIMIT_CODE = "AWARDPING_CAPTURE_RESOURCE_LIMIT";

const RESOURCE_LIMIT_FAILURE_TYPE = "capture_resource_limit";

const LIMIT_CONFIGURATION = Object.freeze({
  dom_elements: "AWARDPING_MAX_CAPTURE_DOM_ELEMENTS",
  dom_text_nodes: "AWARDPING_MAX_CAPTURE_TEXT_NODES",
  dom_raw_text_characters: "AWARDPING_MAX_CAPTURE_TEXT_CHARS",
  visible_text_characters: "AWARDPING_MAX_CAPTURE_TEXT_CHARS",
  render_width_css_px: "AWARDPING_MAX_CAPTURE_WIDTH_CSS_PX",
  render_height_css_px: "AWARDPING_MAX_CAPTURE_HEIGHT_CSS_PX",
  render_pixels: "AWARDPING_MAX_CAPTURE_RENDER_PIXELS",
  screenshot_bytes: "AWARDPING_MAX_CAPTURE_SCREENSHOT_MB",
  browser_response_bytes: "AWARDPING_MAX_BROWSER_RESPONSE_MB",
  browser_network_policy: "the official source URL or source-page dependency",
  browser_context_shutdown: "the source-scoped browser context shutdown barrier",
  browser_proxy_shutdown: "the source-scoped browser proxy shutdown barrier",
  invalid_render_dimensions: "page markup",
});

export function captureResourceLimitError({
  stateId = "main",
  resource,
  observed,
  limit,
  unit = "count",
} = {}) {
  const safeStateId = cleanValue(stateId) || "main";
  const safeResource = cleanValue(resource) || "unknown_resource";
  const configuration = LIMIT_CONFIGURATION[safeResource] || "the matching capture limit";
  const error = new Error(
    `${RESOURCE_LIMIT_FAILURE_TYPE}: screenshot state=${JSON.stringify(safeStateId)} ` +
      `resource=${safeResource} observed=${formatObserved(observed)} limit=${formatObserved(limit)} unit=${unit}. ` +
      "Capture was rejected before evidence publication. Recommended safe action: verify the official page " +
      `for runaway, infinite, or unexpectedly duplicated content; change ${configuration} only after operator review.`,
  );
  error.code = CAPTURE_RESOURCE_LIMIT_CODE;
  error.failure_type = RESOURCE_LIMIT_FAILURE_TYPE;
  error.capture_resource_limit = true;
  error.capture_state_id = safeStateId;
  error.capture_resource = safeResource;
  error.observed = observed;
  error.limit = limit;
  error.configuration = configuration;
  return error;
}

export function isCaptureResourceLimitError(error) {
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (
      current.code === CAPTURE_RESOURCE_LIMIT_CODE ||
      current.capture_resource_limit === true ||
      String(current.message || "").toLowerCase().includes(RESOURCE_LIMIT_FAILURE_TYPE)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function errorChainHasCode(error, expectedCode) {
  const target = String(expectedCode || "").trim();
  if (!target) return false;
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.code === target) return true;
    current = current.cause;
  }
  return false;
}

export function assertCaptureNetworkWithinLimits(networkProxy, checkpoint, {
  stateId = "main",
  maxBytes,
} = {}) {
  if (!networkProxy || typeof networkProxy.policyViolationSince !== "function") {
    return null;
  }
  const violation = networkProxy.policyViolationSince(checkpoint);
  if (!violation) return null;
  const isByteLimit = violation.reason === "byte_limit";
  const configuredLimit = isByteLimit
    ? positiveInteger(violation.limit_bytes ?? maxBytes, "maxBytes")
    : "public HTTP(S) destinations only";
  throw captureResourceLimitError({
    stateId,
    resource: isByteLimit ? "browser_response_bytes" : "browser_network_policy",
    observed:
      `${violation.kind || "browser_response"} ${violation.target || "unknown_host"}` +
      `${violation.port ? `:${violation.port}` : ""} ` +
      (isByteLimit
        ? `${violation.observed_bytes ?? `more_than_${configuredLimit}`}`
        : `${violation.reason || "policy_refusal"}`),
    limit: configuredLimit,
    unit: isByteLimit ? "upstream_bytes" : "network_policy",
  });
}

export async function finalizeCaptureNetworkBoundary({
  page,
  context,
  networkProxy,
  checkpoint,
  stateId = "main",
  maxBytes,
  shutdownTimeoutMs = 5_000,
} = {}) {
  const shutdownTimeout = positiveInteger(shutdownTimeoutMs, "shutdownTimeoutMs");
  // Page shutdown is best effort because the required context shutdown below
  // is the authoritative source boundary.
  await boundedBoundaryOperation(
    page?.close?.(),
    shutdownTimeout,
    "Browser page shutdown timed out.",
  ).catch(() => null);

  let contextFailure = null;
  try {
    await boundedBoundaryOperation(
      context?.close?.(),
      shutdownTimeout,
      "Browser context shutdown timed out.",
    );
  } catch (error) {
    contextFailure = error;
  }

  let settleFailure = null;
  try {
    await networkProxy?.settlePolicyEvaluations?.({ timeoutMs: shutdownTimeout });
  } catch (error) {
    settleFailure = error;
  }

  let proxyCloseFailure = null;
  try {
    await boundedBoundaryOperation(
      networkProxy?.close?.(),
      shutdownTimeout + 1_000,
      "Browser proxy shutdown timed out.",
    );
  } catch (error) {
    proxyCloseFailure = error;
  }

  // Proxy close destroys every response/tunnel stream. Snapshot violations
  // only after that required barrier so late bytes cannot appear post-publish.
  assertCaptureNetworkWithinLimits(networkProxy, checkpoint, { stateId, maxBytes });
  if (settleFailure) throw settleFailure;
  if (contextFailure) {
    const failure = captureResourceLimitError({
      stateId,
      resource: "browser_context_shutdown",
      observed: cleanValue(contextFailure?.message || contextFailure || "shutdown_failed"),
      limit: shutdownTimeout,
      unit: "milliseconds",
    });
    failure.code = "AWARDPING_CAPTURE_CONTEXT_SHUTDOWN";
    failure.cause = contextFailure;
    throw failure;
  }
  if (proxyCloseFailure) {
    const failure = captureResourceLimitError({
      stateId,
      resource: "browser_proxy_shutdown",
      observed: cleanValue(proxyCloseFailure?.message || proxyCloseFailure || "shutdown_failed"),
      limit: shutdownTimeout + 1_000,
      unit: "milliseconds",
    });
    failure.code = "AWARDPING_CAPTURE_PROXY_SHUTDOWN";
    failure.cause = proxyCloseFailure;
    throw failure;
  }
  return { closed: true };
}

export async function captureBoundedBodyInnerText(page, {
  stateId = "main",
  maxChars,
  maxTextNodes,
  maxElements,
} = {}) {
  const limits = {
    maxChars: positiveInteger(maxChars, "maxChars"),
    maxTextNodes: positiveInteger(maxTextNodes, "maxTextNodes"),
    maxElements: positiveInteger(maxElements, "maxElements"),
  };
  const snapshot = await page.evaluate(({ maxCharsValue, maxTextNodesValue, maxElementsValue }) => {
    const body = document.body;
    if (!body) {
      return {
        text: "",
        visible_text_characters: 0,
        raw_text_characters: 0,
        text_nodes: 0,
        elements: 0,
      };
    }

    const elementCount = body.getElementsByTagName("*").length + 1;
    if (elementCount > maxElementsValue) {
      return {
        limit_resource: "dom_elements",
        observed: elementCount,
        limit: maxElementsValue,
        unit: "elements",
      };
    }

    const excludedParentTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const maxRawCharsValue = maxCharsValue * 2;
    let rawTextCharacters = 0;
    let textNodes = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (excludedParentTags.has(node.parentElement?.tagName || "")) continue;
      textNodes += 1;
      if (textNodes > maxTextNodesValue) {
        return {
          limit_resource: "dom_text_nodes",
          observed: textNodes,
          limit: maxTextNodesValue,
          unit: "text_nodes",
        };
      }
      rawTextCharacters += node.data?.length || 0;
      if (rawTextCharacters > maxRawCharsValue) {
        return {
          limit_resource: "dom_raw_text_characters",
          observed: rawTextCharacters,
          limit: maxRawCharsValue,
          unit: "characters",
        };
      }
    }

    const text = body.innerText || "";
    if (text.length > maxCharsValue) {
      return {
        limit_resource: "visible_text_characters",
        observed: text.length,
        limit: maxCharsValue,
        unit: "characters",
      };
    }
    return {
      text,
      visible_text_characters: text.length,
      raw_text_characters: rawTextCharacters,
      text_nodes: textNodes,
      elements: elementCount,
    };
  }, {
    maxCharsValue: limits.maxChars,
    maxTextNodesValue: limits.maxTextNodes,
    maxElementsValue: limits.maxElements,
  });

  if (snapshot?.limit_resource) {
    throw captureResourceLimitError({
      stateId,
      resource: snapshot.limit_resource,
      observed: snapshot.observed,
      limit: snapshot.limit,
      unit: snapshot.unit,
    });
  }
  if (!snapshot || typeof snapshot.text !== "string") {
    throw captureResourceLimitError({
      stateId,
      resource: "visible_text_characters",
      observed: "unavailable",
      limit: limits.maxChars,
      unit: "characters",
    });
  }
  return snapshot;
}

export async function assertCaptureRenderWithinLimits(page, {
  stateId = "main",
  maxWidthCssPx,
  maxHeightCssPx,
  maxRenderPixels,
} = {}) {
  const dimensions = await page.evaluate(() => ({
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    scroll_width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    scroll_height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    device_pixel_ratio: window.devicePixelRatio || 1,
  }));
  return validateCaptureRenderDimensions(dimensions, {
    stateId,
    maxWidthCssPx,
    maxHeightCssPx,
    maxRenderPixels,
  });
}

export function validateCaptureRenderDimensions(dimensions, {
  stateId = "main",
  maxWidthCssPx,
  maxHeightCssPx,
  maxRenderPixels,
} = {}) {
  const widthLimit = positiveInteger(maxWidthCssPx, "maxWidthCssPx");
  const heightLimit = positiveInteger(maxHeightCssPx, "maxHeightCssPx");
  const pixelLimit = positiveInteger(maxRenderPixels, "maxRenderPixels");
  const viewportWidth = finitePositiveNumber(dimensions?.viewport_width);
  const viewportHeight = finitePositiveNumber(dimensions?.viewport_height);
  const scrollWidth = finitePositiveNumber(dimensions?.scroll_width);
  const scrollHeight = finitePositiveNumber(dimensions?.scroll_height);
  const devicePixelRatio = finitePositiveNumber(dimensions?.device_pixel_ratio);
  if (!viewportWidth || !viewportHeight || !scrollWidth || !scrollHeight || !devicePixelRatio) {
    throw captureResourceLimitError({
      stateId,
      resource: "invalid_render_dimensions",
      observed: JSON.stringify(dimensions ?? null),
      limit: "finite positive dimensions",
      unit: "dimensions",
    });
  }

  const cssWidth = Math.max(viewportWidth, scrollWidth);
  const cssHeight = Math.max(viewportHeight, scrollHeight);
  if (cssWidth > widthLimit) {
    throw captureResourceLimitError({
      stateId,
      resource: "render_width_css_px",
      observed: cssWidth,
      limit: widthLimit,
      unit: "css_px",
    });
  }
  if (cssHeight > heightLimit) {
    throw captureResourceLimitError({
      stateId,
      resource: "render_height_css_px",
      observed: cssHeight,
      limit: heightLimit,
      unit: "css_px",
    });
  }

  const pixelWidth = Math.ceil(cssWidth * devicePixelRatio);
  const pixelHeight = Math.ceil(cssHeight * devicePixelRatio);
  const renderPixels = pixelWidth * pixelHeight;
  if (!Number.isSafeInteger(renderPixels) || renderPixels > pixelLimit) {
    throw captureResourceLimitError({
      stateId,
      resource: "render_pixels",
      observed: Number.isSafeInteger(renderPixels) ? renderPixels : "unsafe_integer",
      limit: pixelLimit,
      unit: "pixels",
    });
  }

  return {
    dimensions: {
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      scroll_width: scrollWidth,
      scroll_height: scrollHeight,
      device_pixel_ratio: devicePixelRatio,
    },
    css_width: cssWidth,
    css_height: cssHeight,
    pixel_width: pixelWidth,
    pixel_height: pixelHeight,
    render_pixels: renderPixels,
  };
}

export function assertCaptureScreenshotBytes(buffer, {
  stateId = "main",
  maxBytes,
} = {}) {
  const byteLimit = positiveInteger(maxBytes, "maxBytes");
  const byteLength = Number(buffer?.byteLength ?? buffer?.length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > byteLimit) {
    throw captureResourceLimitError({
      stateId,
      resource: "screenshot_bytes",
      observed: Number.isSafeInteger(byteLength) ? byteLength : "unavailable",
      limit: byteLimit,
      unit: "bytes",
    });
  }
  return byteLength;
}

export function assertCaptureScreenshotDimensions(screenshot, {
  stateId = "main",
  maxWidthCssPx,
  maxHeightCssPx,
  maxRenderPixels,
} = {}) {
  const devicePixelRatio = finitePositiveNumber(screenshot?.expected_device_pixel_ratio);
  const pixelWidth = finitePositiveNumber(screenshot?.pixel_width);
  const pixelHeight = finitePositiveNumber(screenshot?.pixel_height);
  if (!devicePixelRatio || !pixelWidth || !pixelHeight) {
    throw captureResourceLimitError({
      stateId,
      resource: "invalid_render_dimensions",
      observed: JSON.stringify(screenshot ?? null),
      limit: "finite positive screenshot dimensions",
      unit: "dimensions",
    });
  }
  return validateCaptureRenderDimensions({
    viewport_width: pixelWidth / devicePixelRatio,
    viewport_height: pixelHeight / devicePixelRatio,
    scroll_width: pixelWidth / devicePixelRatio,
    scroll_height: pixelHeight / devicePixelRatio,
    device_pixel_ratio: devicePixelRatio,
  }, {
    stateId,
    maxWidthCssPx,
    maxHeightCssPx,
    maxRenderPixels,
  });
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function finitePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function boundedBoundaryOperation(value, timeoutMs, message) {
  if (!value || typeof value.then !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish(reject, new Error(message));
    }, timeoutMs);
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => {
        if (timedOut) return;
        finish(reject, error);
      },
    );
  });
}

function cleanValue(value) {
  return String(value || "").trim().slice(0, 160);
}

function formatObserved(value) {
  return String(value ?? "unknown").replace(/\s+/g, " ").slice(0, 500);
}
