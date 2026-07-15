import crypto from "node:crypto";

export const captureProfileNames = [
  "stable-daily",
  "baseline-rich",
  "localization-repair",
  "discovery",
];

export const sectionExtractionProfileNames = [
  "stable-daily",
  "baseline-rich",
  "evidence",
];

const awardContentPageTypes = new Set([
  "application",
  "deadline",
  "deadlines",
  "eligibility",
  "faq",
  "requirements",
  "requirement",
  "materials",
  "pdf",
]);

const accordionPageTypes = new Set([
  "application",
  "eligibility",
  "faq",
  "requirements",
  "requirement",
]);

export function defaultCaptureProfile({
  localizationRepair = false,
  discoveryMode = false,
  completeMissingBaselines = false,
  baselineRefresh = false,
  r2BackfillBaselines = false,
} = {}) {
  if (localizationRepair) return "localization-repair";
  if (discoveryMode) return "discovery";
  if (completeMissingBaselines || baselineRefresh || r2BackfillBaselines) return "baseline-rich";
  return "stable-daily";
}

export function normalizeCaptureProfile(value, fallback = "stable-daily") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (captureProfileNames.includes(normalized)) return normalized;
  return captureProfileNames.includes(fallback) ? fallback : "stable-daily";
}

export function defaultSectionExtractionProfile({
  completeMissingBaselines = false,
  baselineRefresh = false,
  r2BackfillBaselines = false,
} = {}) {
  if (completeMissingBaselines || baselineRefresh || r2BackfillBaselines) return "baseline-rich";
  return "stable-daily";
}

export function normalizeSectionExtractionProfile(value, fallback = "stable-daily") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (sectionExtractionProfileNames.includes(normalized)) return normalized;
  return sectionExtractionProfileNames.includes(fallback) ? fallback : "stable-daily";
}

export function sectionExtractionProfileSettings(profile, overrides = {}) {
  const normalized = normalizeSectionExtractionProfile(profile);
  const settings = {
    profile: normalized,
    maxControls: normalized === "stable-daily" ? 80 : 160,
    naturalClicksOnly: normalized === "stable-daily",
    allowForceOpenFallback: normalized !== "stable-daily",
    includeInBaselineFacts: normalized === "baseline-rich",
    captureEvidence: normalized === "evidence",
  };

  return {
    ...settings,
    ...Object.fromEntries(
      Object.entries(overrides).filter((entry) => entry[1] !== undefined && entry[1] !== null),
    ),
  };
}

export function captureProfileSettings(profile, overrides = {}) {
  const normalized = normalizeCaptureProfile(profile);
  // Localization repair must reproduce the ordinary monitoring capture pixel-for-pixel.
  // The repair worker keeps its own profile name for audit metadata, but broad expansion
  // or scroll behavior would make its image hash differ from the stable-daily baseline
  // and prevent the metadata-only repair from ever being applied safely.
  const stableRender = ["stable-daily", "localization-repair"].includes(normalized);
  const settings = {
    profile: normalized,
    includeExpansionTextInPrimary: normalized === "baseline-rich",
    useMainContentHashForComparison: stableRender,
    allowExpansionScreenshots: !stableRender,
    allowBroadExpansion: !stableRender,
    allowScrollActivation: !stableRender,
    defaultMaxExpansionStateScreenshots: stableRender ? 0 : normalized === "discovery" ? 3 : 8,
  };

  return {
    ...settings,
    ...Object.fromEntries(
      Object.entries(overrides).filter((entry) => entry[1] !== undefined && entry[1] !== null),
    ),
  };
}

export function shouldUseScrollActivationForSource(source, profile, requested = true) {
  if (!requested) return false;
  const settings = captureProfileSettings(profile);
  if (settings.allowScrollActivation) return true;
  return awardContentPageTypes.has(cleanKey(source?.page_type));
}

export function shouldUseExpansionForSource(source, profile) {
  const settings = captureProfileSettings(profile);
  if (["stable-daily", "localization-repair"].includes(settings.profile)) return false;
  if (settings.allowBroadExpansion) return true;
  return accordionPageTypes.has(cleanKey(source?.page_type));
}

export function expansionRelevanceModeForSource(source, profile) {
  return shouldUseExpansionForSource(source, profile) ? "award-content" : "none";
}

export function buildStableTextBlocks({
  rawText = "",
  mainText = "",
  chromeText = "",
  expansionStates = [],
  profile = "stable-daily",
} = {}) {
  const settings = captureProfileSettings(profile);
  const bodyText = normalizeVisibleText(rawText);
  const mainContentText = normalizeVisibleText(mainText || rawText);
  const navHeaderFooterText = normalizeVisibleText(chromeText);
  const expansionText = normalizeVisibleText(
    (expansionStates || [])
      .map((state) => {
        const text = normalizeVisibleText(state?.text || "");
        if (!text) return "";
        return `Expansion state: ${state?.label || "Section"}\n${text}`;
      })
      .filter(Boolean)
      .join("\n\n"),
  );
  const primaryText = normalizeVisibleText(
    settings.includeExpansionTextInPrimary && expansionText
      ? `${bodyText}\n\n${expansionText}`
      : bodyText,
  );

  return {
    primary_text: primaryText,
    body_text: bodyText,
    main_content_text: mainContentText,
    nav_header_footer_text: navHeaderFooterText,
    expansion_text: expansionText,
    text_hash: hashText(primaryText),
    body_text_hash: hashText(bodyText),
    main_content_hash: hashText(mainContentText),
    nav_header_footer_hash: hashText(navHeaderFooterText),
    expansion_hash: hashText(expansionText),
    expansion_text_length: expansionText.length,
  };
}

export function compareStableCaptureHashes(baseline = {}, capture = {}, { profile = "stable-daily" } = {}) {
  const settings = captureProfileSettings(profile);
  const screenshotChanged = Boolean(
    capture?.image_hash && baseline?.image_hash && capture.image_hash !== baseline.image_hash,
  );
  const bodyTextHashChanged = Boolean(
    capture?.body_text_hash && baseline?.body_text_hash && capture.body_text_hash !== baseline.body_text_hash,
  );
  const mainContentHashChanged = Boolean(
    capture?.main_content_hash &&
      baseline?.main_content_hash &&
      capture.main_content_hash !== baseline.main_content_hash,
  );
  const chromeHashChanged = Boolean(
    capture?.nav_header_footer_hash &&
      baseline?.nav_header_footer_hash &&
      capture.nav_header_footer_hash !== baseline.nav_header_footer_hash,
  );

  if (settings.useMainContentHashForComparison && capture?.main_content_hash && baseline?.main_content_hash) {
    return {
      screenshotChanged,
      textChanged: mainContentHashChanged,
      mainContentHashChanged,
      bodyTextHashChanged,
      chromeHashChanged,
      chromeOnlyHashChanged: screenshotChanged && !mainContentHashChanged,
      comparisonHash: "main_content_hash",
    };
  }

  const textChanged = Boolean(capture?.text_hash && baseline?.text_hash && capture.text_hash !== baseline.text_hash);
  return {
    screenshotChanged,
    textChanged,
    mainContentHashChanged,
    bodyTextHashChanged,
    chromeHashChanged,
    chromeOnlyHashChanged: screenshotChanged && !textChanged && chromeHashChanged,
    comparisonHash: "text_hash",
  };
}

export function normalizeVisibleText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "")
    .replace(/^_+|_+$/g, "");
}

function hashText(text) {
  return crypto.createHash("sha256").update(normalizeVisibleText(text), "utf8").digest("hex");
}
