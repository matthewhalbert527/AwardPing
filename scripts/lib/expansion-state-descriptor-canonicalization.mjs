export const MAX_EXPANSION_STATE_SCREENSHOTS = 24;
export const MAX_RAW_EXPANSION_STATE_DESCRIPTORS = 512;
export const expansionStateCaptureCoverageSchema =
  "awardping.expansion-state-capture-coverage.v1";

const expansionStateCaptureStatuses = new Set([
  "verified_complete",
  "incomplete_discovery",
  "incomplete_truncated",
  "incomplete_failures",
  "incomplete_state_count",
  "skipped_disabled",
  "skipped_profile",
  "skipped_relevance",
  "unavailable_error",
]);
export const MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS = 60_000;

function boundedCaptureLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(MAX_EXPANSION_STATE_SCREENSHOTS, parsed));
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boundedTimeoutMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS, resolved));
}

/**
 * Returns the expansion-only wall-clock budget after canonical discovery.
 * Zero logical states receive no extra time. The hard 24-state ceiling also
 * bounds this phase even if an untrusted caller supplies a larger count.
 */
export function expansionStateCaptureBudgetMs(attempted, {
  operationTimeoutMs = MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS,
  perStateTimeoutMs = MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS,
} = {}) {
  const parsedAttempted = Number.parseInt(String(attempted ?? ""), 10);
  const logicalStates = Number.isFinite(parsedAttempted)
    ? Math.max(0, Math.min(MAX_EXPANSION_STATE_SCREENSHOTS, parsedAttempted))
    : 0;
  if (logicalStates === 0) return 0;
  const overhead = boundedTimeoutMs(operationTimeoutMs, MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS);
  const perState = boundedTimeoutMs(perStateTimeoutMs, MAX_EXPANSION_STATE_TIMEOUT_PER_STATE_MS);
  return overhead + (logicalStates * perState);
}

function logicalPanelKey(descriptor) {
  const explicit = cleanString(descriptor?.logical_state_key);
  if (explicit) return explicit;
  const selectors = Array.isArray(descriptor?.panel_selectors)
    ? [...new Set(descriptor.panel_selectors.map(cleanString).filter(Boolean))].sort()
    : [];
  return selectors.length ? `logical-panels:${JSON.stringify(selectors)}` : "";
}

function descriptorPreference(descriptor) {
  let score = 0;
  if (cleanString(descriptor?.aria_controls)) score += 1_000;
  if (cleanString(descriptor?.data_target)) score += 800;
  if (descriptor?.state_kind === "details") score += 700;
  if (["button", "tab"].includes(cleanString(descriptor?.role).toLowerCase())) score += 500;
  if (descriptor?.tag === "BUTTON" || descriptor?.tag === "SUMMARY") score += 400;
  if (cleanString(descriptor?.id)) score += 100;
  if (descriptor?.state_kind === "adjacent-panel") score -= 100;
  return score;
}

/**
 * Converts raw actionable controls into one capture descriptor per bound
 * content panel. Browser discovery supplies the DOM-derived validity bit; this
 * pure step never guesses that a control or title is itself expandable content.
 */
export function canonicalizeExpansionStateDescriptors(rawDiscovery, {
  maxControls = 8,
} = {}) {
  const captureLimit = boundedCaptureLimit(maxControls);
  const rawDescriptors = Array.isArray(rawDiscovery?.descriptors)
    ? rawDiscovery.descriptors
    : [];
  const rawCandidates = Number.isSafeInteger(rawDiscovery?.raw_candidates)
    ? Math.max(0, rawDiscovery.raw_candidates)
    : rawDescriptors.length;
  const rawSetComplete = rawDiscovery?.raw_descriptor_set_complete === true;
  const groups = new Map();
  let invalidPanelControls = 0;
  let duplicateControls = 0;

  for (const [rawIndex, descriptor] of rawDescriptors.entries()) {
    if (!descriptor || descriptor.logical_panel_valid !== true) {
      invalidPanelControls += 1;
      continue;
    }
    const key = logicalPanelKey(descriptor);
    if (!key) {
      invalidPanelControls += 1;
      continue;
    }
    const existing = groups.get(key);
    const candidate = { descriptor, rawIndex, score: descriptorPreference(descriptor) };
    if (!existing) {
      groups.set(key, { ...candidate, logicalIndex: groups.size, key });
      continue;
    }
    duplicateControls += 1;
    if (candidate.score > existing.score) {
      groups.set(key, {
        ...candidate,
        logicalIndex: existing.logicalIndex,
        key,
      });
    }
  }

  const logicalDescriptors = [...groups.values()]
    .sort((left, right) => left.logicalIndex - right.logicalIndex)
    .map(({ descriptor, key }) => ({ ...descriptor, logical_state_key: key }));
  const isolationDescriptors = logicalDescriptors.map((descriptor, index) => ({
    ...descriptor,
    index,
  }));
  const knownOmitted = Math.max(0, logicalDescriptors.length - captureLimit);
  const descriptorSetComplete = rawSetComplete && knownOmitted === 0;

  return {
    candidates: logicalDescriptors.length,
    candidate_count_exact: rawSetComplete,
    raw_candidates: rawCandidates,
    raw_descriptor_set_complete: rawSetComplete,
    duplicate_controls_removed: duplicateControls,
    non_panel_controls_removed: invalidPanelControls,
    capture_limit: captureLimit,
    descriptor_set_complete: descriptorSetComplete,
    truncated: !descriptorSetComplete,
    truncated_count: knownOmitted,
    truncated_count_exact: rawSetComplete,
    isolation_descriptor_set_complete: rawSetComplete,
    isolation_descriptors: isolationDescriptors,
    descriptors: isolationDescriptors.slice(0, captureLimit),
    base_text: typeof rawDiscovery?.base_text === "string" ? rawDiscovery.base_text : "",
  };
}

export function summarizeExpansionStateCapture(setup, {
  states = [],
  failures = [],
  attempted = null,
} = {}) {
  const descriptors = Array.isArray(setup?.descriptors) ? setup.descriptors : [];
  const retainedStates = Array.isArray(states) ? states : [];
  const retainedFailures = Array.isArray(failures) ? failures : [];
  const candidates = Number.isSafeInteger(setup?.candidates) ? Math.max(0, setup.candidates) : 0;
  const attemptedCount = Number.isSafeInteger(attempted)
    ? Math.max(0, attempted)
    : descriptors.length;
  const complete = setup?.descriptor_set_complete === true &&
    setup?.candidate_count_exact === true &&
    attemptedCount === candidates &&
    retainedStates.length === attemptedCount &&
    retainedFailures.length === 0;
  const status = complete
    ? "verified_complete"
    : setup?.raw_descriptor_set_complete !== true || setup?.candidate_count_exact !== true
      ? "incomplete_discovery"
      : setup?.truncated === true
        ? "incomplete_truncated"
        : retainedFailures.length > 0
          ? "incomplete_failures"
          : "incomplete_state_count";
  return {
    candidates,
    raw_candidates: Number.isSafeInteger(setup?.raw_candidates)
      ? Math.max(0, setup.raw_candidates)
      : candidates,
    raw_candidate_count_exact: setup?.raw_descriptor_set_complete === true,
    candidate_count_exact: setup?.candidate_count_exact === true,
    duplicate_controls_removed: Number.isSafeInteger(setup?.duplicate_controls_removed)
      ? Math.max(0, setup.duplicate_controls_removed)
      : 0,
    non_panel_controls_removed: Number.isSafeInteger(setup?.non_panel_controls_removed)
      ? Math.max(0, setup.non_panel_controls_removed)
      : 0,
    attempted: attemptedCount,
    capture_limit: Number.isSafeInteger(setup?.capture_limit)
      ? Math.max(0, setup.capture_limit)
      : 0,
    capture_complete: complete,
    capture_status: status,
    truncated: setup?.truncated === true,
    truncated_count: Number.isSafeInteger(setup?.truncated_count)
      ? Math.max(0, setup.truncated_count)
      : 0,
    truncated_count_exact: setup?.truncated_count_exact === true,
  };
}

/**
 * Produces the single persisted coverage verdict for an expansion-state
 * capture. The retained count is supplied after artifact projection so a
 * successfully opened state whose evidence was excluded cannot remain marked
 * complete merely because discovery and interaction succeeded.
 */
export function expansionStateCaptureCoverage(captureLike, {
  retainedStateCount = null,
} = {}) {
  const value = captureLike && typeof captureLike === "object" ? captureLike : {};
  const attemptedCount = nonNegativeInteger(value.attempted ?? value.attempted_count);
  const logicalCandidateCount = nonNegativeInteger(
    value.candidates ?? value.logical_candidate_count,
  );
  const rawCandidateCount = nonNegativeInteger(
    value.raw_candidates ?? value.raw_candidate_count,
  );
  const captureLimit = nonNegativeInteger(value.capture_limit);
  const failureCount = Array.isArray(value.failures)
    ? value.failures.length
    : nonNegativeInteger(value.failure_count);
  const retainedCount = retainedStateCount === null
    ? Array.isArray(value.states)
      ? value.states.length
      : nonNegativeInteger(value.retained_state_count)
    : nonNegativeInteger(retainedStateCount);
  const rawCandidateCountExact = value.raw_candidate_count_exact === true
    || value.raw_descriptor_set_complete === true;
  const logicalCandidateCountExact = value.candidate_count_exact === true
    || value.logical_candidate_count_exact === true;
  const truncated = value.truncated === true;
  const truncatedCount = nonNegativeInteger(value.truncated_count);
  const truncatedCountExact = value.truncated_count_exact === true;
  const complete = Boolean(
    (value.capture_complete === true || value.complete === true)
    && (value.capture_status || value.status) === "verified_complete"
    && rawCandidateCountExact
    && logicalCandidateCountExact
    && !truncated
    && truncatedCount === 0
    && truncatedCountExact
    && attemptedCount === logicalCandidateCount
    && retainedCount === attemptedCount
    && failureCount === 0,
  );
  const status = complete
    ? "verified_complete"
    : normalizedIncompleteCoverageStatus(value.capture_status || value.status, {
        rawCandidateCountExact,
        logicalCandidateCountExact,
        truncated,
        failureCount,
        attemptedCount,
        retainedCount,
      });

  return Object.freeze({
    schema: expansionStateCaptureCoverageSchema,
    complete,
    status,
    raw_candidate_count: rawCandidateCount,
    raw_candidate_count_exact: rawCandidateCountExact,
    logical_candidate_count: logicalCandidateCount,
    logical_candidate_count_exact: logicalCandidateCountExact,
    attempted_count: attemptedCount,
    retained_state_count: retainedCount,
    capture_limit: captureLimit,
    truncated,
    truncated_count: truncatedCount,
    truncated_count_exact: truncatedCountExact,
    failure_count: failureCount,
  });
}

/**
 * Strictly validates persisted coverage. This intentionally has no fallback
 * from expansion_state_count: retained artifacts prove what survived, not
 * whether discovery found and captured every logical panel.
 */
export function canonicalExpansionStateCaptureCoverage(value, {
  expectedRetainedStateCount = null,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = [
    "attempted_count",
    "capture_limit",
    "failure_count",
    "logical_candidate_count",
    "raw_candidate_count",
    "retained_state_count",
    "truncated_count",
  ];
  if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    return null;
  }
  for (const key of [
    "complete",
    "logical_candidate_count_exact",
    "raw_candidate_count_exact",
    "truncated",
    "truncated_count_exact",
  ]) {
    if (typeof value[key] !== "boolean") return null;
  }
  if (
    value.schema !== expansionStateCaptureCoverageSchema
    || !expansionStateCaptureStatuses.has(value.status)
    || value.raw_candidate_count < value.logical_candidate_count
    || value.attempted_count > value.logical_candidate_count
    || value.attempted_count > value.capture_limit
    || value.retained_state_count > value.attempted_count
    || value.failure_count > value.attempted_count
    || (
      expectedRetainedStateCount !== null
      && (
        !Number.isSafeInteger(expectedRetainedStateCount)
        || expectedRetainedStateCount < 0
        || value.retained_state_count !== expectedRetainedStateCount
      )
    )
  ) {
    return null;
  }

  if (
    value.logical_candidate_count_exact
    && value.truncated_count_exact
    && value.truncated_count !== Math.max(
      0,
      value.logical_candidate_count - value.attempted_count,
    )
  ) {
    return null;
  }
  if (
    value.logical_candidate_count_exact
    && value.logical_candidate_count > value.attempted_count
    && !value.truncated
  ) {
    return null;
  }
  if (value.complete !== (value.status === "verified_complete")) return null;
  if (
    value.complete
    && (
      !value.raw_candidate_count_exact
      || !value.logical_candidate_count_exact
      || value.truncated
      || value.truncated_count !== 0
      || !value.truncated_count_exact
      || value.attempted_count !== value.logical_candidate_count
      || value.retained_state_count !== value.attempted_count
      || value.failure_count !== 0
    )
  ) {
    return null;
  }

  return {
    schema: value.schema,
    complete: value.complete,
    status: value.status,
    raw_candidate_count: value.raw_candidate_count,
    raw_candidate_count_exact: value.raw_candidate_count_exact,
    logical_candidate_count: value.logical_candidate_count,
    logical_candidate_count_exact: value.logical_candidate_count_exact,
    attempted_count: value.attempted_count,
    retained_state_count: value.retained_state_count,
    capture_limit: value.capture_limit,
    truncated: value.truncated,
    truncated_count: value.truncated_count,
    truncated_count_exact: value.truncated_count_exact,
    failure_count: value.failure_count,
  };
}

export function sameExpansionStateCaptureCoverage(left, right, options = {}) {
  const canonicalLeft = canonicalExpansionStateCaptureCoverage(left, options);
  const canonicalRight = canonicalExpansionStateCaptureCoverage(right, options);
  return Boolean(
    canonicalLeft
    && canonicalRight
    && JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight),
  );
}

/**
 * Preserves a verified retained artifact set when historical discovery
 * completeness was never recorded. The retained count is an explicit lower
 * bound only: both candidate exactness flags remain false, so this verdict can
 * never be promoted as complete merely because N states survived.
 */
export function conservativeExpansionStateCaptureCoverage({
  retainedStateCount,
  captureLimit = retainedStateCount,
} = {}) {
  const retainedCount = nonNegativeInteger(retainedStateCount);
  const retainedLimit = Math.max(retainedCount, nonNegativeInteger(captureLimit));
  return expansionStateCaptureCoverage({
    raw_candidates: retainedCount,
    raw_candidate_count_exact: false,
    candidates: retainedCount,
    candidate_count_exact: false,
    attempted: retainedCount,
    capture_limit: retainedLimit,
    capture_complete: false,
    capture_status: "incomplete_discovery",
    truncated: false,
    truncated_count: 0,
    truncated_count_exact: false,
    failures: [],
  }, { retainedStateCount: retainedCount });
}

export function expansionStateCaptureCoverageLegacyMirrors(value) {
  const coverage = canonicalExpansionStateCaptureCoverage(value);
  if (!coverage) return null;
  return {
    expansion_state_candidates: coverage.logical_candidate_count,
    expansion_state_attempted: coverage.attempted_count,
    expansion_state_capture_limit: coverage.capture_limit,
    expansion_state_capture_complete: coverage.complete,
    expansion_state_capture_status: coverage.status,
    expansion_state_raw_candidates: coverage.raw_candidate_count,
    expansion_state_raw_candidate_count_exact: coverage.raw_candidate_count_exact,
    expansion_state_candidate_count_exact: coverage.logical_candidate_count_exact,
    expansion_state_truncated: coverage.truncated,
    expansion_state_truncated_count: coverage.truncated_count,
    expansion_state_truncated_count_exact: coverage.truncated_count_exact,
  };
}

/**
 * Compatibility bridge for historical raw metadata. A canonical nested v1
 * verdict remains authoritative only when any scalar mirrors agree with it.
 * Scalar-only generations are validated, but always downgraded to conservative
 * incomplete discovery: the legacy producer never proved its raw discovery
 * set exact, even when its old capture_complete bit was true.
 */
export function legacyExpansionStateCaptureCoverageFromMetadata(metadata, {
  retainedStateCount,
} = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const expectedRetainedStateCount = Number.isSafeInteger(retainedStateCount)
    && retainedStateCount >= 0
    ? retainedStateCount
    : null;
  if (expectedRetainedStateCount === null) return null;
  const nested = canonicalExpansionStateCaptureCoverage(
    metadata.expansion_state_capture_coverage,
    { expectedRetainedStateCount },
  );

  const legacyV0IntegerFields = [
    "expansion_state_attempted",
    "expansion_state_candidates",
    "expansion_state_capture_limit",
    "expansion_state_truncated_count",
  ];
  const legacyV0BooleanFields = [
    "expansion_state_capture_complete",
    "expansion_state_truncated",
  ];
  const modernOnlyFields = [
    "expansion_state_capture_status",
    "expansion_state_raw_candidates",
    "expansion_state_raw_candidate_count_exact",
    "expansion_state_candidate_count_exact",
    "expansion_state_truncated_count_exact",
  ];
  const scalarClaimFields = [
    ...legacyV0IntegerFields,
    ...legacyV0BooleanFields,
    ...modernOnlyFields,
    "expansion_state_failures",
  ];
  const nestedClaimed = Object.hasOwn(
    metadata,
    "expansion_state_capture_coverage",
  );
  const scalarClaimed = scalarClaimFields.some((key) => Object.hasOwn(metadata, key));
  if (nestedClaimed && !nested) return null;
  if (nestedClaimed) {
    return expansionStateCaptureCoverageScalarClaimsMatch(
      metadata,
      nested,
      expectedRetainedStateCount,
    )
      ? nested
      : null;
  }
  if (!scalarClaimed) return null;
  if (
    legacyV0IntegerFields.some((key) => (
      !Object.hasOwn(metadata, key)
      || !Number.isSafeInteger(metadata[key])
      || metadata[key] < 0
    ))
    || legacyV0BooleanFields.some((key) => (
      !Object.hasOwn(metadata, key)
      || typeof metadata[key] !== "boolean"
    ))
    || !Object.hasOwn(metadata, "expansion_state_failures")
    || !Array.isArray(metadata.expansion_state_failures)
    || !Object.hasOwn(metadata, "expansion_state_count")
    || !Number.isSafeInteger(metadata.expansion_state_count)
    || metadata.expansion_state_count !== expectedRetainedStateCount
    || !Object.hasOwn(metadata, "expansion_state_screenshots")
    || !Array.isArray(metadata.expansion_state_screenshots)
    || metadata.expansion_state_screenshots.length !== expectedRetainedStateCount
    || metadata.expansion_state_attempted < expectedRetainedStateCount
    || metadata.expansion_state_attempted > metadata.expansion_state_candidates
    || metadata.expansion_state_attempted > metadata.expansion_state_capture_limit
    || metadata.expansion_state_failures.length > metadata.expansion_state_attempted
    || metadata.expansion_state_truncated_count > metadata.expansion_state_candidates
    || metadata.expansion_state_truncated
      !== (metadata.expansion_state_truncated_count > 0)
  ) {
    return null;
  }

  const modernFieldsClaimed = modernOnlyFields.some(
    (key) => Object.hasOwn(metadata, key),
  );
  if (!modernFieldsClaimed) {
    const conservativeV0 = conservativeLegacyExpansionStateCaptureCoverage({
      rawCandidateCount: metadata.expansion_state_candidates,
      logicalCandidateCount: metadata.expansion_state_candidates,
      attemptedCount: metadata.expansion_state_attempted,
      retainedStateCount: expectedRetainedStateCount,
      captureLimit: metadata.expansion_state_capture_limit,
      truncated: metadata.expansion_state_truncated,
      truncatedCount: metadata.expansion_state_truncated_count,
      failureCount: metadata.expansion_state_failures.length,
    });
    return conservativeV0;
  }

  if (
    !Object.hasOwn(metadata, "expansion_state_capture_status")
    || typeof metadata.expansion_state_capture_status !== "string"
    || !Object.hasOwn(metadata, "expansion_state_raw_candidates")
    || !Number.isSafeInteger(metadata.expansion_state_raw_candidates)
    || metadata.expansion_state_raw_candidates < 0
    || !Object.hasOwn(metadata, "expansion_state_candidate_count_exact")
    || typeof metadata.expansion_state_candidate_count_exact !== "boolean"
    || !Object.hasOwn(metadata, "expansion_state_truncated_count_exact")
    || typeof metadata.expansion_state_truncated_count_exact !== "boolean"
    || (
      Object.hasOwn(metadata, "expansion_state_raw_candidate_count_exact")
      && typeof metadata.expansion_state_raw_candidate_count_exact !== "boolean"
    )
  ) {
    return null;
  }

  const coverage = expansionStateCaptureCoverage({
    attempted: metadata.expansion_state_attempted,
    candidates: metadata.expansion_state_candidates,
    raw_candidates: metadata.expansion_state_raw_candidates,
    // The pre-nested canonicalizer used this exactness bit for both the raw
    // descriptor set and the logical count derived from it.
    raw_candidate_count_exact:
      metadata.expansion_state_raw_candidate_count_exact
      ?? metadata.expansion_state_candidate_count_exact,
    candidate_count_exact: metadata.expansion_state_candidate_count_exact,
    capture_limit: metadata.expansion_state_capture_limit,
    capture_complete: metadata.expansion_state_capture_complete,
    capture_status: metadata.expansion_state_capture_status,
    truncated: metadata.expansion_state_truncated,
    truncated_count: metadata.expansion_state_truncated_count,
    truncated_count_exact: metadata.expansion_state_truncated_count_exact,
    failures: metadata.expansion_state_failures,
  }, { retainedStateCount: expectedRetainedStateCount });
  const canonicalLegacy = canonicalExpansionStateCaptureCoverage(coverage, {
    expectedRetainedStateCount,
  });
  if (!canonicalLegacy) return null;
  return conservativeLegacyExpansionStateCaptureCoverage({
    rawCandidateCount: canonicalLegacy.raw_candidate_count,
    logicalCandidateCount: canonicalLegacy.logical_candidate_count,
    attemptedCount: canonicalLegacy.attempted_count,
    retainedStateCount: canonicalLegacy.retained_state_count,
    captureLimit: canonicalLegacy.capture_limit,
    truncated: canonicalLegacy.truncated,
    truncatedCount: canonicalLegacy.truncated_count,
    failureCount: canonicalLegacy.failure_count,
  });
}

export function hasExpansionStateCaptureCoverageClaim(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return [
    "expansion_state_capture_coverage",
    "expansion_state_attempted",
    "expansion_state_candidates",
    "expansion_state_capture_limit",
    "expansion_state_capture_complete",
    "expansion_state_capture_status",
    "expansion_state_failures",
    "expansion_state_raw_candidates",
    "expansion_state_raw_candidate_count_exact",
    "expansion_state_candidate_count_exact",
    "expansion_state_truncated",
    "expansion_state_truncated_count",
    "expansion_state_truncated_count_exact",
  ].some((key) => Object.hasOwn(metadata, key));
}

function normalizedIncompleteCoverageStatus(statusValue, state) {
  const status = cleanString(statusValue);
  if (status.startsWith("skipped_") && expansionStateCaptureStatuses.has(status)) {
    return status;
  }
  if (status === "unavailable_error") return status;
  if (!state.rawCandidateCountExact || !state.logicalCandidateCountExact) {
    return "incomplete_discovery";
  }
  if (state.truncated) return "incomplete_truncated";
  if (state.failureCount > 0) return "incomplete_failures";
  if (state.retainedCount !== state.attemptedCount) return "incomplete_state_count";
  return expansionStateCaptureStatuses.has(status) && status !== "verified_complete"
    ? status
    : "incomplete_state_count";
}

function conservativeLegacyExpansionStateCaptureCoverage({
  rawCandidateCount,
  logicalCandidateCount,
  attemptedCount,
  retainedStateCount,
  captureLimit,
  truncated,
  truncatedCount,
  failureCount,
}) {
  const coverage = expansionStateCaptureCoverage({
    raw_candidates: rawCandidateCount,
    raw_candidate_count_exact: false,
    candidates: logicalCandidateCount,
    candidate_count_exact: false,
    attempted: attemptedCount,
    capture_limit: captureLimit,
    capture_complete: false,
    capture_status: "incomplete_discovery",
    truncated,
    truncated_count: truncatedCount,
    truncated_count_exact: false,
    failure_count: failureCount,
  }, { retainedStateCount });
  return canonicalExpansionStateCaptureCoverage(coverage, {
    expectedRetainedStateCount: retainedStateCount,
  });
}

function expansionStateCaptureCoverageScalarClaimsMatch(
  metadata,
  nested,
  expectedRetainedStateCount,
) {
  const scalarMappings = [
    ["expansion_state_attempted", "attempted_count", "integer"],
    ["expansion_state_candidates", "logical_candidate_count", "integer"],
    ["expansion_state_capture_limit", "capture_limit", "integer"],
    ["expansion_state_capture_complete", "complete", "boolean"],
    ["expansion_state_capture_status", "status", "string"],
    ["expansion_state_raw_candidates", "raw_candidate_count", "integer"],
    [
      "expansion_state_raw_candidate_count_exact",
      "raw_candidate_count_exact",
      "boolean",
    ],
    [
      "expansion_state_candidate_count_exact",
      "logical_candidate_count_exact",
      "boolean",
    ],
    ["expansion_state_truncated", "truncated", "boolean"],
    ["expansion_state_truncated_count", "truncated_count", "integer"],
    [
      "expansion_state_truncated_count_exact",
      "truncated_count_exact",
      "boolean",
    ],
  ];
  for (const [legacyField, canonicalField, kind] of scalarMappings) {
    if (!Object.hasOwn(metadata, legacyField)) continue;
    const value = metadata[legacyField];
    if (
      (kind === "integer" && (!Number.isSafeInteger(value) || value < 0))
      || (kind === "boolean" && typeof value !== "boolean")
      || (kind === "string" && typeof value !== "string")
      || value !== nested[canonicalField]
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(metadata, "expansion_state_failures")
    && (
      !Array.isArray(metadata.expansion_state_failures)
      || metadata.expansion_state_failures.length !== nested.failure_count
    )
  ) {
    return false;
  }
  if (
    Object.hasOwn(metadata, "expansion_state_count")
    && metadata.expansion_state_count !== expectedRetainedStateCount
  ) {
    return false;
  }
  if (
    Object.hasOwn(metadata, "expansion_state_screenshots")
    && (
      !Array.isArray(metadata.expansion_state_screenshots)
      || metadata.expansion_state_screenshots.length !== expectedRetainedStateCount
    )
  ) {
    return false;
  }
  return true;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
