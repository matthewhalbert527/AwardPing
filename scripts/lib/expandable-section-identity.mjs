const genericSectionLabelPattern = /^section\s+\d+$/i;

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
}

function normalizedEvidenceText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeExpandableSectionLabel(value) {
  return normalizedEvidenceText(value);
}

export function stableExpandableSectionKey(section, index = 0) {
  const label = cleanText(section?.label);
  const normalizedLabel = normalizeExpandableSectionLabel(label);
  if (normalizedLabel && !genericSectionLabelPattern.test(label)) {
    return `label-${slug(normalizedLabel)}`;
  }

  return `section-${Math.max(0, Number(index) || 0) + 1}`;
}

export function canonicalizeExpandableSections(sections = []) {
  const seen = new Map();
  return (Array.isArray(sections) ? sections : []).map((section, index) => {
    const baseKey = stableExpandableSectionKey(section, index);
    const occurrence = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, occurrence);
    const sectionKey = occurrence > 1 ? `${baseKey}-${occurrence}` : baseKey;
    const previousKey = cleanText(section?.section_key);

    return {
      ...section,
      section_key: sectionKey,
      legacy_section_key:
        previousKey && previousKey !== sectionKey
          ? previousKey
          : cleanText(section?.legacy_section_key) || null,
    };
  });
}

export function pageTextContainsSectionLabel(pageText, label) {
  const normalizedPage = normalizedEvidenceText(pageText);
  const normalizedLabel = normalizeExpandableSectionLabel(label);
  return Boolean(normalizedPage && normalizedLabel && normalizedPage.includes(normalizedLabel));
}

function meaningfulBodyExcerpt(value) {
  const normalized = normalizedEvidenceText(value);
  if (normalized.length < 48) return "";
  return normalized.slice(0, Math.min(180, normalized.length));
}

export function sectionPresenceEvidence({
  changeKind,
  section,
  previousPageText,
  currentPageText,
  previousMainContentHash,
  currentMainContentHash,
  extractionEnabled = true,
  extractionError = null,
}) {
  const label = cleanText(section?.label);
  const bodyExcerpt = meaningfulBodyExcerpt(section?.text);
  const normalizedPreviousPage = normalizedEvidenceText(previousPageText);
  const normalizedCurrentPage = normalizedEvidenceText(currentPageText);
  const previousLabelPresent = pageTextContainsSectionLabel(previousPageText, label);
  const currentLabelPresent = pageTextContainsSectionLabel(currentPageText, label);
  const previousBodyPresent = Boolean(bodyExcerpt && normalizedPreviousPage.includes(bodyExcerpt));
  const currentBodyPresent = Boolean(bodyExcerpt && normalizedCurrentPage.includes(bodyExcerpt));
  const mainContentHashChanged = Boolean(
    previousMainContentHash &&
      currentMainContentHash &&
      previousMainContentHash !== currentMainContentHash,
  );
  const extractionComplete = Boolean(extractionEnabled && !extractionError);

  let confirmed = false;
  let reason = "unsupported_change_kind";
  if (changeKind === "removed") {
    confirmed = Boolean(
      extractionComplete &&
        previousLabelPresent &&
        !currentLabelPresent &&
        !currentBodyPresent &&
        mainContentHashChanged,
    );
    reason = confirmed
      ? "section_absent_from_current_page_text"
      : currentLabelPresent || currentBodyPresent
        ? "section_still_present_in_current_page_text"
        : !mainContentHashChanged
          ? "main_content_did_not_change"
          : !previousLabelPresent
            ? "previous_page_does_not_confirm_section_label"
            : !extractionComplete
              ? "section_extraction_incomplete"
              : "section_removal_not_confirmed";
  } else if (changeKind === "added") {
    confirmed = Boolean(
      extractionComplete &&
        currentLabelPresent &&
        !previousLabelPresent &&
        mainContentHashChanged,
    );
    reason = confirmed
      ? "section_label_added_to_current_page_text"
      : previousLabelPresent || previousBodyPresent
        ? "section_already_present_in_previous_page_text"
        : !mainContentHashChanged
          ? "main_content_did_not_change"
          : !currentLabelPresent
            ? "current_page_does_not_confirm_section_label"
            : !extractionComplete
              ? "section_extraction_incomplete"
              : "section_addition_not_confirmed";
  }

  return {
    change_kind: changeKind,
    confirmed,
    reason,
    label,
    previous_label_present: previousLabelPresent,
    current_label_present: currentLabelPresent,
    previous_body_present: previousBodyPresent,
    current_body_present: currentBodyPresent,
    main_content_hash_changed: mainContentHashChanged,
    extraction_complete: extractionComplete,
  };
}
