import crypto from "node:crypto";

export const VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION = 1;

const quotePairs = [
  [/[\u2018\u2019\u201a\u201b\u2032]/gu, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/gu, '"'],
];

export function normalizeVisualExactText(value) {
  let normalized = String(value || "").normalize("NFKC");
  for (const [pattern, replacement] of quotePairs) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[\u00a0\u2007\u202f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function visualExactTokens(value) {
  const normalized = normalizeVisualExactText(value);
  if (!normalized) return [];
  return [...normalized.matchAll(
    /[\p{L}\p{N}]+(?:[.,:/-](?=[\p{L}\p{N}])[\p{L}\p{N}]+)*|[^\s]/gu,
  )].map((match) => match[0]);
}

export function directionalVisualLocalizationPhrases({
  side,
  changeDetails = null,
  deterministicDiff = null,
  exactText = null,
} = {}) {
  const normalizedSide = side === "previous" ? "previous" : "current";
  const details = objectValue(changeDetails);
  const structured = objectValue(details.structured_diff);
  const deterministic = objectValue(deterministicDiff);
  const facts = Array.isArray(details.changed_facts) ? details.changed_facts : [];
  const values = [];
  const add = (value, source) => {
    for (const item of arrayValue(value)) {
      const normalized = normalizeVisualExactText(item);
      if (!normalized) continue;
      values.push({ text: String(item), normalized, source });
    }
  };

  add(exactText, "explicit_exact_text");
  if (normalizedSide === "previous") {
    add(details.exact_before, "change_details.exact_before");
    add(details.before, "change_details.before");
    for (const fact of facts) add(objectValue(fact).removed_text, "changed_facts.removed_text");
    add(structured.removed_text, "change_details.structured_diff.removed_text");
    add(deterministic.removed_text, "deterministic_diff.removed_text");
    add(deterministic.exact_before_text, "deterministic_diff.exact_before_text");
  } else {
    add(details.exact_after, "change_details.exact_after");
    add(details.after, "change_details.after");
    for (const fact of facts) add(objectValue(fact).added_text, "changed_facts.added_text");
    add(structured.added_text, "change_details.structured_diff.added_text");
    add(deterministic.added_text, "deterministic_diff.added_text");
    add(deterministic.exact_after_text, "deterministic_diff.exact_after_text");
  }

  const seen = new Set();
  return values
    .map((value, priority) => ({
      ...value,
      priority,
      source_rank: localizationPhraseSourceRank(value.source),
      tokens: visualExactTokens(value.normalized),
    }))
    .filter((value) => {
      if (!value.tokens.length || seen.has(value.normalized)) return false;
      seen.add(value.normalized);
      return true;
    });
}

export function bindVisualTextGeometry(geometry, {
  capturedAt = null,
  imageHash,
  imageRef = null,
  screenshot = null,
} = {}) {
  const source = objectValue(geometry);
  const documentSize = sizeValue(source.document);
  const viewport = sizeValue(source.viewport);
  const devicePixelRatio = positiveNumber(source.device_pixel_ratio) || 1;
  const screenshotValue = objectValue(screenshot);
  const cssWidth = positiveNumber(screenshotValue.css_width) || documentSize.width;
  const cssHeight = positiveNumber(screenshotValue.css_height) || documentSize.height;
  const pixelWidth = positiveNumber(screenshotValue.pixel_width) || Math.round(cssWidth * devicePixelRatio);
  const pixelHeight = positiveNumber(screenshotValue.pixel_height) || Math.round(cssHeight * devicePixelRatio);
  const nodes = normalizeGeometryNodes(source.nodes);
  const bound = {
    version: VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION,
    state_id: cleanNullable(source.state_id),
    coordinate_space: "document-css-pixels",
    captured_at: cleanNullable(capturedAt || source.captured_at),
    document: documentSize,
    viewport,
    device_pixel_ratio: devicePixelRatio,
    node_count: nodes.length,
    run_count: nodes.reduce((count, node) => count + node.runs.length, 0),
    nodes,
    screenshot: {
      image_hash: cleanNullable(imageHash),
      image_ref: imageRef || null,
      css_width: cssWidth,
      css_height: cssHeight,
      pixel_width: pixelWidth,
      pixel_height: pixelHeight,
    },
  };
  return {
    ...bound,
    geometry_hash: visualTextGeometryHash(bound),
  };
}

export function verifyVisualTextGeometryBinding(geometry, imageHash = null) {
  const value = objectValue(geometry);
  const geometryHash = cleanText(value.geometry_hash);
  const boundImageHash = cleanText(objectValue(value.screenshot).image_hash);
  if (!geometryHash) return { valid: false, reason: "geometry_hash_missing" };
  if (!boundImageHash) return { valid: false, reason: "bound_image_hash_missing" };
  if (imageHash && cleanText(imageHash) !== boundImageHash) {
    return { valid: false, reason: "bound_image_hash_mismatch" };
  }
  const expected = visualTextGeometryHash(withoutGeometryHash(value));
  if (geometryHash !== expected) return { valid: false, reason: "geometry_hash_mismatch" };
  return { valid: true, reason: "geometry_and_image_bound" };
}

export function findExactTextNodeMatch({ geometry, exactText } = {}) {
  const phrases = arrayValue(exactText)
    .map((candidate, index) => {
      const value = objectValue(candidate);
      const text = Object.keys(value).length ? value.text || value.normalized : candidate;
      return {
        text: String(text || ""),
        normalized: normalizeVisualExactText(text),
        tokens: visualExactTokens(text),
        priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : index,
        source: cleanText(value.source) || "explicit_exact_text",
        source_rank: Number.isFinite(Number(value.source_rank))
          ? Number(value.source_rank)
          : localizationPhraseSourceRank(cleanText(value.source) || "explicit_exact_text"),
      };
    })
    .filter((phrase) => phrase.tokens.length);
  if (!phrases.length) {
    return { status: "unavailable_exact_text", reason: "No exact wording was supplied." };
  }

  const indexed = indexedGeometryTokens(geometry);
  if (!indexed.length) {
    return { status: "unavailable_geometry", reason: "The screenshot has no searchable text-node geometry." };
  }

  const uniqueCandidates = [];
  let ambiguous = false;
  for (const phrase of phrases) {
    const matches = exactSequenceMatches(indexed, phrase.tokens);
    if (matches.length === 1) {
      uniqueCandidates.push({ phrase, match: matches[0] });
    } else if (matches.length > 1) {
      ambiguous = true;
    }
  }

  if (uniqueCandidates.length) {
    uniqueCandidates.sort((left, right) =>
      left.phrase.source_rank - right.phrase.source_rank ||
      right.phrase.tokens.length - left.phrase.tokens.length ||
      left.phrase.priority - right.phrase.priority,
    );
    const selected = uniqueCandidates[0];
    return {
      status: "matched",
      reason: "Normalized exact wording matched one text-node sequence.",
      exact_text: selected.phrase.normalized,
      phrase_source: selected.phrase.source,
      matched_rects: selected.match.rects,
      matched_node_orders: selected.match.nodeOrders,
      token_start: selected.match.start,
      token_end: selected.match.end,
    };
  }

  if (ambiguous) {
    return {
      status: "unavailable_ambiguous_exact_match",
      reason: "The exact wording appears in more than one location in this screenshot.",
    };
  }
  return {
    status: "unavailable_exact_text_not_found",
    reason: "The normalized exact wording was not found in this screenshot's text-node geometry.",
  };
}

function localizationPhraseSourceRank(source) {
  const value = cleanText(source);
  if (value === "explicit_exact_text" || /^change_details\.exact_(before|after)$/.test(value)) return 0;
  if (/^(changed_facts|change_details\.structured_diff)\./.test(value)) return 1;
  if (/^deterministic_diff\.(removed_text|added_text)$/.test(value)) return 2;
  if (/^change_details\.(before|after)$/.test(value)) return 3;
  if (/^deterministic_diff\.exact_(before|after)_text$/.test(value)) return 9;
  return 5;
}

export function planVerifiedCrop({
  matchedRects,
  geometry,
  padding = 48,
  minWidth = 360,
  minHeight = 180,
} = {}) {
  const rects = arrayValue(matchedRects).map(rectValue).filter(Boolean);
  if (!rects.length) {
    return { status: "unavailable_match_rectangles", reason: "The exact match has no usable rectangles." };
  }
  const geometryValue = objectValue(geometry);
  const documentSize = sizeValue(geometryValue.document);
  const screenshot = objectValue(geometryValue.screenshot);
  const cssWidth = positiveNumber(screenshot.css_width) || documentSize.width;
  const cssHeight = positiveNumber(screenshot.css_height) || documentSize.height;
  if (!cssWidth || !cssHeight) {
    return { status: "unavailable_image_dimensions", reason: "Screenshot dimensions are missing." };
  }

  const bounds = unionRects(rects);
  if (!bounds) {
    return { status: "unavailable_match_rectangles", reason: "The exact match rectangles are invalid." };
  }
  const safePadding = nonNegativeNumber(padding);
  const desired = {
    left: Math.max(0, bounds.x - safePadding),
    top: Math.max(0, bounds.y - safePadding),
    right: Math.min(cssWidth, bounds.right + safePadding),
    bottom: Math.min(cssHeight, bounds.bottom + safePadding),
  };
  const cropRect = expandBoundsToMinimum(desired, {
    width: Math.min(cssWidth, positiveNumber(minWidth) || 1),
    height: Math.min(cssHeight, positiveNumber(minHeight) || 1),
    maxWidth: cssWidth,
    maxHeight: cssHeight,
  });
  const exactOverlap = rects.every((rect) => rectOverlapsClip(rect, cropRect));
  if (!exactOverlap) {
    return {
      status: "unavailable_crop_overlap_failed",
      reason: "The proposed crop does not overlap every exact-wording rectangle.",
      crop_rect: cropRect,
      exact_overlap: false,
    };
  }

  const pixelWidth = positiveNumber(screenshot.pixel_width) || cssWidth;
  const pixelHeight = positiveNumber(screenshot.pixel_height) || cssHeight;
  const scaleX = pixelWidth / cssWidth;
  const scaleY = pixelHeight / cssHeight;
  const pixelLeft = Math.max(0, Math.floor(cropRect.x * scaleX));
  const pixelTop = Math.max(0, Math.floor(cropRect.y * scaleY));
  const pixelRight = Math.min(pixelWidth, Math.ceil(cropRect.right * scaleX));
  const pixelBottom = Math.min(pixelHeight, Math.ceil(cropRect.bottom * scaleY));

  return {
    status: "verified",
    reason: "The crop contains every exact-wording rectangle.",
    crop_rect: cropRect,
    crop_rect_pixels: {
      x: pixelLeft,
      y: pixelTop,
      width: Math.max(1, pixelRight - pixelLeft),
      height: Math.max(1, pixelBottom - pixelTop),
      right: pixelRight,
      bottom: pixelBottom,
    },
    exact_overlap: true,
  };
}

export function localizeVisualEventSide({
  side,
  exactText = null,
  states = [],
  padding = 48,
  changeDetails = null,
  deterministicDiff = null,
} = {}) {
  const normalizedSide = side === "previous" ? "previous" : "current";
  const phrases = directionalVisualLocalizationPhrases({
    side: normalizedSide,
    exactText,
    changeDetails,
    deterministicDiff,
  });
  if (!phrases.length) {
    const opposite = directionalVisualLocalizationPhrases({
      side: normalizedSide === "previous" ? "current" : "previous",
      changeDetails,
      deterministicDiff,
    });
    return localizationResult({
      side: normalizedSide,
      status: opposite.length
        ? normalizedSide === "previous"
          ? "unavailable_not_required_for_added_wording"
          : "unavailable_not_required_for_removed_wording"
        : "unavailable_exact_text",
      reason: opposite.length
        ? `No ${normalizedSide} wording is required for this one-sided change.`
        : "No exact wording was supplied for this side.",
    });
  }

  const artifacts = arrayValue(states).map(normalizeState).filter(Boolean);
  if (!artifacts.length) {
    return localizationResult({
      side: normalizedSide,
      status: "unavailable_image_state",
      reason: "No screenshot state with structured geometry is available.",
    });
  }

  const mainStates = artifacts.filter((state) => state.kind === "main");
  const expansionStates = artifacts.filter((state) => state.kind !== "main");
  const mainResult = localizeAcrossStateGroup(mainStates, phrases, padding);
  if (mainResult?.status === "verified") return localizationResult({ side: normalizedSide, ...mainResult });
  if (mainResult?.status === "unavailable_ambiguous_exact_match") {
    return localizationResult({ side: normalizedSide, ...mainResult });
  }

  const expansionResults = expansionStates
    .map((state) => localizeInState(state, phrases, padding))
    .filter(Boolean);
  const verifiedExpansion = expansionResults.filter((result) => result.status === "verified");
  if (verifiedExpansion.length === 1) {
    return localizationResult({ side: normalizedSide, ...verifiedExpansion[0] });
  }
  if (
    verifiedExpansion.length > 1 ||
    expansionResults.some((result) => result.status === "unavailable_ambiguous_exact_match")
  ) {
    return localizationResult({
      side: normalizedSide,
      status: "unavailable_ambiguous_exact_match",
      reason: "The exact wording maps to more than one retained screenshot state.",
    });
  }

  const bindingFailure = [...(mainResult ? [mainResult] : []), ...expansionResults]
    .find((result) => result.status === "unavailable_geometry_binding");
  return localizationResult({
    side: normalizedSide,
    status: bindingFailure ? bindingFailure.status : "unavailable_exact_text_not_found",
    reason: bindingFailure?.reason || "The exact wording was not found in any retained screenshot state.",
  });
}

export function rectOverlapsClip(rect, clip) {
  const left = rectValue(rect);
  const right = rectValue(clip);
  if (!left || !right) return false;
  return Math.min(left.right, right.right) > Math.max(left.x, right.x) &&
    Math.min(left.bottom, right.bottom) > Math.max(left.y, right.y);
}

function localizeAcrossStateGroup(states, phrases, padding) {
  if (!states.length) return null;
  const results = states.map((state) => localizeInState(state, phrases, padding));
  const verified = results.filter((result) => result.status === "verified");
  if (verified.length === 1) return verified[0];
  if (verified.length > 1 || results.some((result) => result.status === "unavailable_ambiguous_exact_match")) {
    return {
      status: "unavailable_ambiguous_exact_match",
      reason: "The exact wording maps to more than one main screenshot location.",
    };
  }
  return results.find((result) => result.status === "unavailable_geometry_binding") || results[0] || null;
}

function localizeInState(state, phrases, padding) {
  const binding = verifyVisualTextGeometryBinding(state.geometry, state.image_hash);
  if (!binding.valid) {
    return {
      status: "unavailable_geometry_binding",
      reason: `Screenshot geometry is not bound to this image: ${binding.reason}.`,
      state_id: state.state_id,
    };
  }
  const match = findExactTextNodeMatch({
    geometry: state.geometry,
    exactText: phrases,
  });
  if (match.status !== "matched") {
    return { ...match, state_id: state.state_id };
  }
  const crop = planVerifiedCrop({
    matchedRects: match.matched_rects,
    geometry: state.geometry,
    padding,
  });
  if (crop.status !== "verified") {
    return { ...crop, state_id: state.state_id, exact_text: match.exact_text };
  }
  return {
    status: "verified",
    reason: "Normalized exact wording and crop overlap were verified.",
    state_id: state.state_id,
    state_kind: state.kind,
    state_label: state.label,
    image_path: state.image_path,
    image_ref: state.image_ref,
    image_hash: state.image_hash,
    geometry_hash: state.geometry.geometry_hash,
    exact_text: match.exact_text,
    phrase_source: match.phrase_source,
    matched_rects: match.matched_rects,
    matched_node_orders: match.matched_node_orders,
    crop_rect: crop.crop_rect,
    crop_rect_pixels: crop.crop_rect_pixels,
    exact_overlap: true,
  };
}

function localizationResult(value) {
  return {
    status: value.status,
    side: value.side,
    state_id: value.state_id || null,
    exact_text: value.exact_text || null,
    matched_rects: value.matched_rects || [],
    crop_rect: value.crop_rect || null,
    crop_rect_pixels: value.crop_rect_pixels || null,
    exact_overlap: value.exact_overlap === true,
    reason: value.reason,
    algorithm_version: VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION,
    ...value,
  };
}

function normalizeState(value, index) {
  const state = objectValue(value);
  const geometry = objectValue(state.geometry || state.text_geometry || state.layout);
  if (!Object.keys(geometry).length) return null;
  return {
    state_id: cleanText(state.state_id || state.id) || `state-${index + 1}`,
    kind: cleanText(state.kind) === "main" || state.main === true ? "main" : "expansion_state",
    label: cleanNullable(state.label),
    image_path: cleanNullable(state.image_path || state.path),
    image_ref: state.image_ref || state.ref || null,
    image_hash: cleanText(state.image_hash || objectValue(geometry.screenshot).image_hash),
    geometry,
  };
}

function indexedGeometryTokens(geometry) {
  const nodes = Array.isArray(objectValue(geometry).nodes) ? geometry.nodes : [];
  const indexed = [];
  for (const node of [...nodes].sort((left, right) => Number(left?.order || 0) - Number(right?.order || 0))) {
    const runs = Array.isArray(node?.runs) ? node.runs : [];
    for (const run of [...runs].sort((left, right) => Number(left?.start || 0) - Number(right?.start || 0))) {
      const runTokens = visualExactTokens(run?.text);
      const rects = arrayValue(run?.rects).map(rectValue).filter(Boolean);
      if (!runTokens.length || !rects.length) continue;
      for (const token of runTokens) {
        indexed.push({
          token,
          rects,
          nodeOrder: Number(node?.order || 0),
        });
      }
    }
  }
  return indexed;
}

function exactSequenceMatches(indexed, expectedTokens) {
  const matches = [];
  for (let start = 0; start <= indexed.length - expectedTokens.length; start += 1) {
    let matchesAll = true;
    for (let offset = 0; offset < expectedTokens.length; offset += 1) {
      if (indexed[start + offset].token !== expectedTokens[offset]) {
        matchesAll = false;
        break;
      }
    }
    if (!matchesAll) continue;
    const selected = indexed.slice(start, start + expectedTokens.length);
    matches.push({
      start,
      end: start + expectedTokens.length,
      rects: uniqueRects(selected.flatMap((token) => token.rects)),
      nodeOrders: [...new Set(selected.map((token) => token.nodeOrder))],
    });
  }
  return matches;
}

function normalizeGeometryNodes(value) {
  return arrayValue(value).map((node, index) => {
    const item = objectValue(node);
    return {
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      path: cleanNullable(item.path),
      text: String(item.text || ""),
      separator_before: item.separator_before === "" ? "" : " ",
      rects: arrayValue(item.rects).map(rectValue).filter(Boolean),
      runs: arrayValue(item.runs).map((run) => {
        const value = objectValue(run);
        return {
          start: nonNegativeNumber(value.start),
          end: nonNegativeNumber(value.end),
          text: String(value.text || ""),
          rects: arrayValue(value.rects).map(rectValue).filter(Boolean),
        };
      }).filter((run) => run.text && run.rects.length),
    };
  }).filter((node) => node.runs.length);
}

function visualTextGeometryHash(value) {
  return crypto.createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function withoutGeometryHash(value) {
  const rest = { ...objectValue(value) };
  delete rest.geometry_hash;
  return rest;
}

function stableJsonStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function unionRects(rects) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom };
}

function expandBoundsToMinimum(bounds, { width, height, maxWidth, maxHeight }) {
  const initialWidth = Math.max(1, bounds.right - bounds.left);
  const initialHeight = Math.max(1, bounds.bottom - bounds.top);
  const targetWidth = Math.min(maxWidth, Math.max(initialWidth, width));
  const targetHeight = Math.min(maxHeight, Math.max(initialHeight, height));
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const x = Math.max(0, Math.min(maxWidth - targetWidth, centerX - targetWidth / 2));
  const y = Math.max(0, Math.min(maxHeight - targetHeight, centerY - targetHeight / 2));
  return {
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    width: roundCoordinate(targetWidth),
    height: roundCoordinate(targetHeight),
    right: roundCoordinate(x + targetWidth),
    bottom: roundCoordinate(y + targetHeight),
  };
}

function uniqueRects(values) {
  const seen = new Set();
  const rects = [];
  for (const value of values) {
    const rect = rectValue(value);
    if (!rect) continue;
    const key = [rect.x, rect.y, rect.width, rect.height].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    rects.push(rect);
  }
  return rects;
}

function rectValue(value) {
  const rect = objectValue(value);
  const x = finiteNumber(rect.x ?? rect.left);
  const y = finiteNumber(rect.y ?? rect.top);
  const right = finiteNumber(rect.right);
  const bottom = finiteNumber(rect.bottom);
  const width = positiveNumber(rect.width) || positiveNumber(right !== null && x !== null ? right - x : null);
  const height = positiveNumber(rect.height) || positiveNumber(bottom !== null && y !== null ? bottom - y : null);
  if (x === null || y === null || !width || !height) return null;
  return {
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    width: roundCoordinate(width),
    height: roundCoordinate(height),
    right: roundCoordinate(x + width),
    bottom: roundCoordinate(y + height),
  };
}

function sizeValue(value) {
  const size = objectValue(value);
  return {
    width: positiveNumber(size.width) || 0,
    height: positiveNumber(size.height) || 0,
  };
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : 0;
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 100) / 100;
}
