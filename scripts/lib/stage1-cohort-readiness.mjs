import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

export const STAGE1_READINESS_SCHEMA_VERSION = "stage1-cohort-readiness-v1";
export const STAGE1_POLICY_VERSION = "stage1-publication-v1";
export const STAGE1_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export const REQUIRED_SOURCE_ROLES = Object.freeze([
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
]);

export const PUBLISHED_FACT_FIELDS = Object.freeze([
  "overview",
  "deadline",
  "opening_date",
  "award_amounts",
  "eligibility",
  "requirements",
  "application_materials",
  "how_to_apply",
  "important_dates",
  "documents",
  "contacts",
  "academic_levels",
  "disciplines",
  "citizenship",
  "confidence",
]);

// This is deliberately explicit. A fuzzy search must never substitute another
// program for one of the 25 launch awards.
export const STAGE1_COHORT_DEFINITION = Object.freeze([
  cohort(1, "rhodes_us", "Rhodes Scholarship (United States)", "rhodes scholarship", "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/", [
    "rhodes scholarships",
  ]),
  cohort(2, "marshall", "Marshall Scholarship", "marshall scholarship", "https://www.marshallscholarship.org/", [], {
    identityRules: [{
      rule_key: "exclude_marshall_sherfield",
      url_pattern: "(?:^|/)marshall-sherfield(?:/|$)|/media/[0-9]+/msf_",
      title_pattern: "sherfield|postdoctoral|\\bmsf\\b",
      reason: "Marshall Sherfield is a separate postdoctoral fellowship and must never supply Marshall Scholarship facts or updates.",
    }],
    preferredPaths: {
      identity_home: ["/"],
      application_materials: ["/apply/"],
      eligibility: ["/apply/eligibility/"],
      faq: ["/apply/faqs/"],
      selection_interviews: ["/apply/interviews/"],
    },
  }),
  cohort(3, "fulbright_us_student", "Fulbright U.S. Student Program", "fulbright u.s. student program", "https://us.fulbrightonline.org/", [
    "u.s. department of state - fulbright u.s. student program - english teaching assistantships (eta)",
    "u.s. department of state - fulbright u.s. student program - grants for research, study, & arts",
  ]),
  cohort(4, "gates_cambridge", "Gates Cambridge Scholarship", "gates cambridge scholarship", "https://www.gatescambridge.org/", []),
  cohort(5, "churchill", "Churchill Scholarship", "churchill scholarship", "https://www.churchillscholarship.org/", []),
  cohort(6, "schwarzman", "Schwarzman Scholars", "schwarzman scholars", "https://www.schwarzmanscholars.org/", [
    "schwarzman scholarship",
  ]),
  cohort(7, "knight_hennessy", "Knight-Hennessy Scholars", "knight-hennessy scholars", "https://knight-hennessy.stanford.edu/", [
    "knight-hennessy scholars program",
  ]),
  cohort(8, "yenching", "Yenching Academy", "yenching academy scholars", "https://yenchingacademy.pku.edu.cn/", []),
  cohort(9, "luce", "Luce Scholars Program", "luce scholars program", "https://lucescholars.org/", [
    "henry luce foundation - scholars program for professional development in asia",
  ]),
  cohort(10, "truman", "Harry S. Truman Scholarship", "truman scholarship", "https://www.truman.gov/", []),
  cohort(11, "goldwater", "Barry Goldwater Scholarship", "goldwater scholarship", "https://goldwaterscholarship.gov/", []),
  cohort(12, "udall_undergraduate", "Udall Undergraduate Scholarship", "udall scholarship", "https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx", [
    "morris k. udall and stewart l. udall scholarship",
  ]),
  cohort(13, "beinecke", "Beinecke Scholarship", "beinecke scholarship", "https://beineckescholarship.org/", []),
  cohort(14, "gilman", "Benjamin A. Gilman International Scholarship", "gilman international scholarship", "https://www.gilmanscholarship.org/", [
    "gilman scholarship",
  ]),
  cohort(15, "boren", "Boren Scholarships and Fellowships", "boren awards", "https://www.borenawards.org/", [
    "boren awards for international study",
    "boren scholarship/fellowship urgd/grad",
    "us national security education program (nsep) - boren fellowships",
  ]),
  cohort(16, "cls", "Critical Language Scholarship Program", "critical language scholarship", "https://clscholarship.org/", [
    "critical language scholarships program",
    "critical languages scholarship",
    "u.s. department of state - critical language scholarship (cls) program",
  ]),
  cohort(17, "nsf_grfp", "NSF Graduate Research Fellowship Program", "nsf graduate research fellowship program", "https://www.nsfgrfp.org/", [
    "national science foundation graduate research fellowship",
  ]),
  cohort(18, "hertz", "Hertz Fellowship", "hertz foundation graduate fellowship", "https://www.hertzfoundation.org/the-fellowship/", []),
  cohort(19, "ndseg", "National Defense Science and Engineering Graduate Fellowship", "national defense science and engineering graduate fellowship", "https://ndseg.org/", [
    "department of war national defense science and engineering grad fellowships",
  ]),
  cohort(20, "smart", "SMART Scholarship-for-Service Program", "smart scholarship for service program", "https://www.smartscholarship.org/smart", [
    "smart scholarship program",
    "u.s. department of defense (dod) - science, mathematics & research for transformation (smart) - scholarship for service program",
  ]),
  cohort(21, "gem", "GEM Fellowship", "gem national consortium", "https://www.gemfellowship.org/", [
    "national gem consortium - master's engineering and science fellowship",
    "national gem consortium - ph.d. engineering and science fellowship",
  ]),
  cohort(22, "noaa_hollings", "NOAA Ernest F. Hollings Undergraduate Scholarship", "noaa hollings scholarship", "https://www.noaa.gov/office-education/hollings-scholarship", [
    "ernest f. hollings undergraduate scholarship (noaa)",
    "hollings scholarship",
  ]),
  cohort(23, "soros", "Paul & Daisy Soros Fellowships for New Americans", "paul & daisy soros fellowships for new americans", "https://www.pdsoros.org/", [
    "soros fellowship for new americans",
    "soros fellowships for new americans",
  ]),
  cohort(24, "samvid", "Samvid Scholars", "samvid scholars program", "https://samvidscholars.org/", []),
  cohort(25, "gaither", "James C. Gaither Junior Fellows Program", "james c. gaither junior fellows program", "https://carnegieendowment.org/james-c-gaither-junior-fellows-program", [
    "carnegie junior fellowship",
  ]),
]);

const ROLE_SIGNALS = Object.freeze({
  identity_home: {
    pageTypes: ["homepage"],
    patterns: [/\boverview\b/i, /\bhome(?:page)?\b/i, /\babout\b/i],
  },
  eligibility: {
    pageTypes: ["eligibility"],
    patterns: [/eligib/i, /who can apply/i, /qualification/i],
  },
  application_materials: {
    pageTypes: ["application", "requirements"],
    patterns: [/\bapply\b/i, /application/i, /material/i, /requirement/i, /how to apply/i],
  },
  dates_cycle: {
    pageTypes: ["deadline"],
    patterns: [/deadline/i, /important date/i, /timeline/i, /calendar/i, /\bcycle\b/i],
  },
  funding: {
    pageTypes: [],
    patterns: [/funding/i, /benefit/i, /stipend/i, /award amount/i, /financial/i, /tuition/i],
  },
  faq: {
    pageTypes: ["faq"],
    patterns: [/\bfaqs?\b/i, /frequently asked/i],
  },
  selection_interviews: {
    pageTypes: [],
    patterns: [/interview/i, /selection/i, /review process/i, /finalist/i],
  },
  current_documents: {
    pageTypes: ["pdf"],
    patterns: [/\.pdf(?:$|[?#])/i, /rules/i, /guide/i, /handbook/i, /instruction/i, /document/i, /statement/i],
  },
});

export function validateExactStage1Definition(definition = STAGE1_COHORT_DEFINITION) {
  const errors = [];
  const cohortKeys = new Set();
  const canonicalKeys = new Set();
  const allSearchKeys = new Set();
  const ranks = new Set();
  let aliasCount = 0;

  if (definition.length !== 25) errors.push(`expected_25_cohorts_found_${definition.length}`);
  for (const entry of definition) {
    if (cohortKeys.has(entry.cohortKey)) errors.push(`duplicate_cohort_key:${entry.cohortKey}`);
    if (canonicalKeys.has(entry.canonicalSearchKey)) errors.push(`duplicate_canonical_search_key:${entry.canonicalSearchKey}`);
    if (ranks.has(entry.launchRank)) errors.push(`duplicate_launch_rank:${entry.launchRank}`);
    cohortKeys.add(entry.cohortKey);
    canonicalKeys.add(entry.canonicalSearchKey);
    ranks.add(entry.launchRank);

    for (const searchKey of [entry.canonicalSearchKey, ...entry.aliasSearchKeys]) {
      if (allSearchKeys.has(searchKey)) errors.push(`duplicate_search_key:${searchKey}`);
      allSearchKeys.add(searchKey);
    }
    aliasCount += entry.aliasSearchKeys.length;
  }
  if (aliasCount !== 25) errors.push(`expected_25_aliases_found_${aliasCount}`);
  if (ranks.size !== 25 || Math.min(...ranks) !== 1 || Math.max(...ranks) !== 25) {
    errors.push("launch_ranks_must_be_1_through_25");
  }

  return {
    ok: errors.length === 0,
    errors,
    cohort_count: definition.length,
    alias_count: aliasCount,
    unique_search_key_count: allSearchKeys.size,
  };
}

export function allStage1SearchKeys(definition = STAGE1_COHORT_DEFINITION) {
  return definition.flatMap((entry) => [entry.canonicalSearchKey, ...entry.aliasSearchKeys]);
}

export function sourceIdentityDisposition(source, rules = []) {
  const text = [source?.title, source?.display_title, source?.page_description]
    .filter(Boolean)
    .join(" ");
  const invalidRules = [];

  for (const rule of rules) {
    const urlRegex = compilePostgresPattern(rule.url_pattern, invalidRules, rule.rule_key);
    const titleRegex = compilePostgresPattern(rule.title_pattern, invalidRules, rule.rule_key);
    if ((urlRegex && urlRegex.test(String(source?.url || ""))) || (titleRegex && titleRegex.test(text))) {
      return { excluded: true, rule_key: rule.rule_key, reason: rule.reason, invalid_rules: invalidRules };
    }
  }

  return { excluded: false, rule_key: null, reason: null, invalid_rules: invalidRules };
}

export function rankOfficialSourceCandidates({
  cohort: definition,
  role,
  sources,
  visualSnapshots = new Map(),
  now = new Date(),
  identityRules = definition.identityRules,
}) {
  const signal = ROLE_SIGNALS[role];
  if (!signal) throw new Error(`Unknown Stage 1 source role: ${role}`);
  const preferredPaths = definition.preferredPaths?.[role] || [];

  return sources
    .map((source) => {
      const disposition = sourceIdentityDisposition(source, identityRules);
      if (disposition.excluded || !isOfficialProgramUrl(source.url, definition.officialHomepage)) return null;
      const snapshot = visualSnapshots instanceof Map
        ? visualSnapshots.get(source.id)
        : visualSnapshots?.[source.id];
      const searchable = [
        source.url,
        source.title,
        source.display_title,
        source.page_description,
        source.reason,
      ].filter(Boolean).join(" ");
      const pathname = normalizedPathname(source.url);
      let score = 100;
      const reasons = ["official_program_domain"];

      if (sameNormalizedUrl(source.url, definition.officialHomepage)) {
        score += role === "identity_home" ? 180 : 25;
        reasons.push("exact_official_homepage");
      }
      if (preferredPaths.some((path) => normalizedPath(path) === pathname)) {
        score += 240;
        reasons.push("program_specific_preferred_path");
      }
      if (signal.pageTypes.includes(String(source.page_type || "").toLowerCase())) {
        score += 80;
        reasons.push("matching_page_type");
      }
      const matches = signal.patterns.filter((pattern) => pattern.test(searchable)).length;
      if (matches) {
        score += Math.min(120, matches * 35);
        reasons.push(`role_text_signals:${matches}`);
      }
      if (source.admin_review_status === "open") {
        score += 35;
        reasons.push("source_open");
      } else {
        score -= 90;
        reasons.push("source_review_later");
      }
      if (source.last_error) {
        score -= 80;
        reasons.push("source_has_error");
      } else {
        score += 15;
      }
      if (isFresh(source.last_checked_at, now)) {
        score += 30;
        reasons.push("fresh_source_check");
      }
      if (snapshotPointerAvailable(snapshot)) {
        score += 20;
        reasons.push("immutable_visual_pointer_present");
      }
      score += Math.round(Number(source.confidence || 0) * 10);

      return {
        source_id: source.id,
        shared_award_id: source.shared_award_id,
        url: source.url,
        title: source.display_title || source.title || null,
        page_type: source.page_type || null,
        admin_review_status: source.admin_review_status || null,
        last_checked_at: source.last_checked_at || null,
        last_error: source.last_error || null,
        score,
        reasons,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score
      || timestamp(right.last_checked_at) - timestamp(left.last_checked_at)
      || left.url.localeCompare(right.url))
    .slice(0, 5);
}

export function inspectLocalVisualEvidence({ archiveRoot, source, snapshot }) {
  const baselinePath = resolve(archiveRoot, "sources", source.id, "baseline.json");
  const result = {
    baseline_path: baselinePath,
    baseline_exists: false,
    baseline_readable: false,
    source_identity_matches: false,
    capture_timestamp_matches: false,
    snapshot_hashes_match: false,
    compared_hash_fields: [],
    mismatched_hash_fields: [],
    artifact_paths_safe: false,
    artifact_count: 0,
    missing_artifacts: [],
    exact_available: false,
  };
  if (!existsSync(baselinePath)) return result;
  result.baseline_exists = true;

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    result.baseline_readable = true;
  } catch {
    return result;
  }

  result.source_identity_matches = baseline?.source?.id === source.id
    && baseline?.source?.shared_award_id === source.shared_award_id;
  result.capture_timestamp_matches = sameInstant(baseline?.captured_at, snapshot?.latest_captured_at);

  const snapshotHashes = objectValue(snapshot?.latest_hashes);
  const hashFields = Object.entries(snapshotHashes)
    .filter(([, value]) => typeof value === "string" && value.length > 0);
  result.compared_hash_fields = hashFields.map(([field]) => field);
  result.mismatched_hash_fields = hashFields
    .filter(([field, value]) => baseline?.[field] !== value)
    .map(([field]) => field);
  result.snapshot_hashes_match = hashFields.length > 0 && result.mismatched_hash_fields.length === 0;

  const capture = objectValue(baseline?.capture);
  const artifactEntries = Object.entries(capture)
    .filter(([role, value]) => role !== "dir" && typeof value === "string" && value.trim());
  result.artifact_count = artifactEntries.length;
  result.artifact_paths_safe = artifactEntries.length > 0;
  for (const [role, relativePath] of artifactEntries) {
    const artifactPath = resolve(archiveRoot, relativePath);
    if (!pathInside(artifactPath, archiveRoot)) {
      result.artifact_paths_safe = false;
      result.missing_artifacts.push({ role, reason: "path_outside_archive" });
      continue;
    }
    if (!existsSync(artifactPath)) result.missing_artifacts.push({ role, reason: "file_missing" });
  }

  result.exact_available = Boolean(
    snapshot
    && result.baseline_readable
    && result.source_identity_matches
    && result.capture_timestamp_matches
    && result.snapshot_hashes_match
    && result.artifact_paths_safe
    && result.missing_artifacts.length === 0,
  );
  return result;
}

export function buildStage1ReadinessReport({
  generatedAt = new Date().toISOString(),
  registryMode,
  publicationSnapshot = null,
  publicationSnapshotError = null,
  awards = [],
  sources = [],
  visualSnapshots = [],
  factCandidates = [],
  reconciliations = [],
  pageAudits = [],
  quarantines = [],
  manifests = [],
  factLedger = [],
  archiveRoot,
  queryInventory = {},
}) {
  const now = new Date(generatedAt);
  const definitionValidation = validateExactStage1Definition();
  if (!definitionValidation.ok) {
    throw new Error(`Invalid built-in Stage 1 definition: ${definitionValidation.errors.join(", ")}`);
  }

  const awardById = new Map(awards.map((award) => [award.id, award]));
  const awardsBySearchKey = groupBy(awards, (award) => award.search_key);
  const sourcesByAward = groupBy(sources, (source) => source.shared_award_id);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const snapshotsBySource = new Map(visualSnapshots.map((snapshot) => [snapshot.shared_award_source_id, snapshot]));
  const candidatesByAward = groupBy(factCandidates, (candidate) => candidate.shared_award_id);
  const candidateById = new Map(factCandidates.map((candidate) => [candidate.id, candidate]));
  const reconciliationByAward = groupBy(reconciliations, (row) => row.shared_award_id);
  const auditsByAward = groupBy(pageAudits, (row) => row.shared_award_id);
  const manifestByCohortRole = new Map(manifests.map((row) => [`${row.cohort_key}:${row.source_role}`, row]));
  const remoteCohorts = publicationSnapshot?.cohorts || [];
  const remoteByKey = new Map(remoteCohorts.map((row) => [row?.registry?.cohort_key, row]));
  const ledgerByCohort = groupBy(factLedger, (row) => row.cohort_key);

  const globalBlockers = [];
  if (registryMode !== "remote_service_snapshot") {
    globalBlockers.push(blocker(
      "stage1_registry_not_available_remotely",
      "critical",
      "The service-only Stage 1 publication snapshot is not available; the exact built-in definition was used and publication must remain blocked.",
      { rpc_error: publicationSnapshotError || null },
    ));
  }
  const remoteValidation = validateRemoteSnapshot(publicationSnapshot);
  if (registryMode === "remote_service_snapshot" && !remoteValidation.ok) {
    globalBlockers.push(blocker(
      "remote_stage1_snapshot_invalid",
      "critical",
      "The remote Stage 1 snapshot is not exactly the intended 25-award cohort.",
      { errors: remoteValidation.errors },
    ));
  }

  const cohortReports = STAGE1_COHORT_DEFINITION.map((definition) => {
    const remote = remoteByKey.get(definition.cohortKey) || null;
    const canonicalMatches = awardsBySearchKey.get(definition.canonicalSearchKey) || [];
    const canonical = canonicalMatches.length === 1 ? canonicalMatches[0] : null;
    const expectedMemberKeys = [definition.canonicalSearchKey, ...definition.aliasSearchKeys];
    const resolvedExpectedMembers = expectedMemberKeys.flatMap((searchKey) => awardsBySearchKey.get(searchKey) || []);
    const remoteMemberIds = new Set((remote?.members || []).map((member) => member.shared_award_id));
    const memberRows = registryMode === "remote_service_snapshot"
      ? [...remoteMemberIds].map((id) => awardById.get(id)).filter(Boolean)
      : resolvedExpectedMembers;
    const memberIds = new Set(memberRows.map((award) => award.id));
    const expectedMemberIds = new Set(resolvedExpectedMembers.map((award) => award.id));
    const cohortSources = memberRows.flatMap((award) => sourcesByAward.get(award.id) || []);
    const cohortCandidates = memberRows.flatMap((award) => candidatesByAward.get(award.id) || []);
    const selectedCandidates = cohortCandidates.filter((candidate) => candidate.candidate_status === "selected");
    const identityRules = (remote?.identity_rules?.length ? remote.identity_rules : definition.identityRules) || [];
    const invalidRuleKeys = new Set();
    const sourceReports = cohortSources.map((source) => {
      const identity = sourceIdentityDisposition(source, identityRules);
      for (const key of identity.invalid_rules) invalidRuleKeys.add(key);
      const snapshot = snapshotsBySource.get(source.id) || null;
      const local = inspectLocalVisualEvidence({ archiveRoot, source, snapshot });
      const r2 = inspectR2Pointer(snapshot);
      return {
        id: source.id,
        shared_award_id: source.shared_award_id,
        member_search_key: awardById.get(source.shared_award_id)?.search_key || null,
        url: source.url,
        title: source.title || null,
        display_title: source.display_title || null,
        page_type: source.page_type || null,
        confidence: source.confidence == null ? null : Number(source.confidence),
        admin_review_status: source.admin_review_status || null,
        last_checked_at: source.last_checked_at || null,
        source_check_age_hours: ageHours(source.last_checked_at, now),
        fresh_within_24h: isFresh(source.last_checked_at, now),
        consecutive_failures: source.consecutive_failures || 0,
        last_error: source.last_error || null,
        identity_exclusion: identity,
        official_program_domain: isOfficialProgramUrl(source.url, definition.officialHomepage),
        visual_evidence: {
          latest_captured_at: snapshot?.latest_captured_at || null,
          fresh_within_24h: isFresh(snapshot?.latest_captured_at, now),
          r2,
          local,
        },
      };
    });
    const sourceReportById = new Map(sourceReports.map((source) => [source.id, source]));
    const excludedSources = sourceReports.filter((source) => source.identity_exclusion.excluded);
    const blockers = [];

    if (canonicalMatches.length !== 1) {
      blockers.push(blocker(
        canonicalMatches.length === 0 ? "canonical_award_missing" : "canonical_search_key_not_unique",
        "critical",
        `Canonical search key must resolve to exactly one award; found ${canonicalMatches.length}.`,
        { search_key: definition.canonicalSearchKey },
      ));
    }
    const remoteRegistry = remote?.registry || null;
    const identity = canonicalIdentityReport(definition, canonical, remoteRegistry);
    for (const drift of identity.blocking_drift) blockers.push(drift);

    const missingExpectedSearchKeys = expectedMemberKeys.filter((key) => (awardsBySearchKey.get(key) || []).length !== 1);
    const remoteMissingMemberIds = [...expectedMemberIds].filter((id) => !remoteMemberIds.has(id));
    const remoteUnexpectedMemberIds = [...remoteMemberIds].filter((id) => !expectedMemberIds.has(id));
    if (missingExpectedSearchKeys.length) {
      blockers.push(blocker(
        "retained_member_missing_or_ambiguous",
        "critical",
        "One or more exact retained canonical/alias search keys are missing or ambiguous; no substitution is allowed.",
        { search_keys: missingExpectedSearchKeys },
      ));
    }
    if (registryMode === "remote_service_snapshot" && (remoteMissingMemberIds.length || remoteUnexpectedMemberIds.length)) {
      blockers.push(blocker(
        "remote_member_set_drift",
        "critical",
        "Remote Stage 1 members differ from the exact canonical-plus-retained-alias definition.",
        { missing_member_ids: remoteMissingMemberIds, unexpected_member_ids: remoteUnexpectedMemberIds },
      ));
    }
    if (invalidRuleKeys.size) {
      blockers.push(blocker(
        "identity_rule_invalid",
        "critical",
        "A source identity exclusion rule could not be compiled safely.",
        { rule_keys: [...invalidRuleKeys] },
      ));
    }

    const sourceRoles = REQUIRED_SOURCE_ROLES.map((role) => {
      const manifest = manifestByCohortRole.get(`${definition.cohortKey}:${role}`) || null;
      const ranked = rankOfficialSourceCandidates({
        cohort: definition,
        role,
        sources: cohortSources,
        visualSnapshots: snapshotsBySource,
        now,
        identityRules,
      });
      const binding = inspectManifestBinding({
        manifest,
        role,
        now,
        sourceReportById,
        candidateById,
        memberIds,
      });
      if (!binding.valid) {
        blockers.push(blocker(
          "source_role_not_verified",
          "critical",
          `Required source role ${role} does not have fresh, exact, immutable evidence.`,
          { role, reasons: binding.reasons, best_candidate_url: ranked[0]?.url || null },
        ));
      }
      if (ranked.length === 0) {
        blockers.push(blocker(
          "official_source_candidate_missing",
          "high",
          `No retained official-domain source is a candidate for ${role}.`,
          { role },
        ));
      }
      return {
        source_role: role,
        manifest: manifest ? sanitizeManifest(manifest) : null,
        manifest_binding: binding,
        best_official_candidate_url: ranked[0]?.url || null,
        official_candidate_urls: ranked,
      };
    });

    const latestReconciliation = canonical
      ? latestBy(reconciliationByAward.get(canonical.id) || [], "created_at")
      : null;
    const latestAudit = canonical ? latestBy(auditsByAward.get(canonical.id) || [], "created_at") : null;
    const publicFacts = nonEmptyPublishedFacts(canonical?.public_facts);
    const reconciliationReport = inspectReconciliation({
      reconciliation: latestReconciliation,
      now,
      memberIds,
      sourceById,
      candidateById,
    });
    if (!reconciliationReport.fresh_success) {
      blockers.push(blocker(
        "canonical_reconciliation_not_fresh_success",
        "critical",
        "The latest canonical reconciliation is absent, failed, incomplete, or older than 24 hours.",
        { status: latestReconciliation?.status || null, completed_at: latestReconciliation?.completed_at || null },
      ));
    }
    if (!reconciliationReport.exact_identity_arrays) {
      blockers.push(blocker(
        "reconciliation_identity_bindings_invalid",
        "critical",
        "The latest reconciliation does not carry valid source/candidate arrays bound to this cohort.",
        reconciliationReport.bindings,
      ));
    }

    const auditReport = inspectPageAudit({ audit: latestAudit, publicFacts, now });
    if (!auditReport.fresh_pass) {
      blockers.push(blocker(
        "canonical_page_audit_not_fresh_pass",
        "critical",
        "The latest canonical page audit is absent, not passed, or older than 24 hours.",
        { status: latestAudit?.audit_status || null, created_at: latestAudit?.created_at || null },
      ));
    }
    if (!auditReport.public_snapshot_exact) {
      blockers.push(blocker(
        "page_audit_public_snapshot_mismatch",
        "critical",
        "The latest page-audit snapshot does not exactly match every non-empty public fact.",
        { mismatched_fields: auditReport.mismatched_fields },
      ));
    }

    const unresolvedAudits = memberRows
      .flatMap((award) => auditsByAward.get(award.id) || [])
      .filter((audit) => !audit.resolved_at && (audit.audit_status === "failed" || audit.audit_status === "needs_review" || audit.severity === "critical"));
    if (unresolvedAudits.length) {
      blockers.push(blocker(
        "unresolved_failed_or_critical_audit",
        "critical",
        `${unresolvedAudits.length} unresolved failed, needs-review, or critical audit(s) remain across retained members.`,
        { audit_ids: unresolvedAudits.map((audit) => audit.id) },
      ));
    }

    const cohortQuarantines = quarantines.filter((row) =>
      memberIds.has(row.shared_award_id)
      || (row.shared_award_source_id && sourceReportById.has(row.shared_award_source_id)));
    const quarantineReport = summarizeQuarantine(cohortQuarantines, memberIds);
    if (quarantineReport.actionable_open_exact > 0) {
      blockers.push(blocker(
        "actionable_quarantine_open",
        "critical",
        `${quarantineReport.actionable_open_exact} actionable quarantine case(s) remain open.`,
        { reason_totals: quarantineReport.by_reason },
      ));
    }

    if (Object.keys(publicFacts).length === 0 || isEmptyJson(publicFacts.overview)) {
      blockers.push(blocker(
        "public_facts_or_overview_missing",
        "critical",
        "Canonical public facts require at least one non-empty field and a non-empty overview.",
      ));
    }
    const factBindings = inspectPublicFactBindings({
      publicFacts,
      selectedCandidates,
      reconciliation: latestReconciliation,
      audit: latestAudit,
      manifests: sourceRoles.map((role) => role.manifest).filter(Boolean),
    });
    if (!factBindings.all_fields_exact) {
      blockers.push(blocker(
        "public_fact_candidate_bindings_incomplete",
        "critical",
        "Not every public fact is exactly bound to a selected candidate, source, reconciliation, audit snapshot, and manifest.",
        { unbound_fields: factBindings.unbound_fields },
      ));
    }

    const ledgerReport = inspectFactLedger({
      registry: remoteRegistry,
      rows: ledgerByCohort.get(definition.cohortKey) || [],
      publicFacts,
      latestReconciliation,
      latestAudit,
    });
    if (remoteRegistry?.publication_state === "verified_beta" && !ledgerReport.exact) {
      blockers.push(blocker(
        "published_fact_ledger_invalid",
        "critical",
        "The verified publication state is not backed by an exact current fact-ledger batch.",
        { reasons: ledgerReport.reasons },
      ));
    }

    if (registryMode === "remote_service_snapshot" && remote?.effectively_verified !== true) {
      blockers.push(blocker(
        "remote_effective_publication_gate_closed",
        "critical",
        "The authoritative remote publication decision is closed.",
        { effective_reason: remote?.effective_reason || "cohort_missing_from_snapshot" },
      ));
    }

    const uniqueBlockers = dedupeBlockers(blockers);
    const selectedCandidateReports = selectedCandidates
      .sort((left, right) => left.field_name.localeCompare(right.field_name) || timestamp(right.extracted_at) - timestamp(left.extracted_at))
      .map((candidate) => ({
        id: candidate.id,
        field_name: candidate.field_name,
        shared_award_id: candidate.shared_award_id,
        member_search_key: awardById.get(candidate.shared_award_id)?.search_key || null,
        shared_award_source_id: candidate.shared_award_source_id || null,
        source_url: sourceById.get(candidate.shared_award_source_id)?.url || candidate.source_url || null,
        source_role: candidate.source_role || null,
        normalized_value: candidate.normalized_value,
        evidence_quote: candidate.evidence_quote || null,
        evidence_location: candidate.evidence_location || null,
        extracted_at: candidate.extracted_at || null,
        confidence: candidate.confidence || null,
        exact_current_public_value_match: deepEqual(publicFacts[candidate.field_name], candidate.normalized_value),
      }));

    const cohortReport = {
      launch_rank: definition.launchRank,
      cohort_key: definition.cohortKey,
      canonical_name: definition.canonicalName,
      publication: remote ? {
        state: remoteRegistry?.publication_state || null,
        state_reason: remoteRegistry?.state_reason || null,
        effectively_verified: remote.effectively_verified === true,
        effective_reason: remote.effective_reason || null,
        evaluated_at: remote.evaluated_at || publicationSnapshot?.evaluated_at || null,
        policy_version: remoteRegistry?.policy_version || null,
      } : {
        state: "unknown_registry_not_remote",
        state_reason: "The exact built-in cohort definition was used; publication remains fail-closed.",
        effectively_verified: false,
        effective_reason: "stage1_registry_not_available_remotely",
        evaluated_at: generatedAt,
        policy_version: STAGE1_POLICY_VERSION,
      },
      canonical_identity: identity,
      retained_members: {
        expected_search_keys: expectedMemberKeys,
        resolved: memberRows.map((award) => ({
          id: award.id,
          search_key: award.search_key,
          name: award.name,
          slug: award.slug || null,
          status: award.status,
          kind: award.search_key === definition.canonicalSearchKey ? "canonical" : "alias",
        })),
        missing_or_ambiguous_search_keys: missingExpectedSearchKeys,
        remote_missing_member_ids: remoteMissingMemberIds,
        remote_unexpected_member_ids: remoteUnexpectedMemberIds,
      },
      source_roles: sourceRoles,
      excluded_or_sibling_sources: excludedSources,
      sources: sourceReports,
      selected_fact_candidates: selectedCandidateReports,
      canonical_reconciliation: reconciliationReport,
      canonical_page_audit: auditReport,
      unresolved_failed_or_critical_audits: unresolvedAudits.map(sanitizeAudit),
      public_fact_bindings: factBindings,
      fact_publication_ledger: ledgerReport,
      quarantine: quarantineReport,
      blockers: uniqueBlockers,
      ready_for_verified_beta_promotion: uniqueBlockers.length === 0 && remote?.effectively_verified === true,
    };
    cohortReport.next_actions = nextActionsForCohort(cohortReport);
    return cohortReport;
  });

  const allBlockers = [...globalBlockers, ...cohortReports.flatMap((cohort) => cohort.blockers)];
  const actions = [
    ...globalBlockers.map((entry) => nextActionForBlocker(null, entry, null)),
    ...cohortReports.flatMap((cohort) => cohort.next_actions),
  ].filter(Boolean);

  return {
    schema_version: STAGE1_READINESS_SCHEMA_VERSION,
    generated_at: generatedAt,
    read_only_attestation: {
      remote_mutations: 0,
      paid_api_calls: 0,
      captures: 0,
      r2_object_requests: 0,
      r2_availability_basis: "immutable_database_object_pointers_only; no paid/object HEAD probes",
      local_availability_basis: "baseline identity, timestamp, hash metadata, safe paths, and file existence",
    },
    registry: {
      mode: registryMode,
      publication_snapshot_schema_version: publicationSnapshot?.schema_version || null,
      publication_snapshot_evaluated_at: publicationSnapshot?.evaluated_at || null,
      publication_snapshot_error: publicationSnapshotError || null,
      exact_definition: definitionValidation,
      remote_snapshot_validation: remoteValidation,
    },
    required_source_roles: REQUIRED_SOURCE_ROLES,
    published_fact_fields: PUBLISHED_FACT_FIELDS,
    query_inventory: queryInventory,
    summary: {
      exact_cohort_count: cohortReports.length,
      ready_for_verified_beta_count: cohortReports.filter((cohort) => cohort.ready_for_verified_beta_promotion).length,
      blocked_count: cohortReports.filter((cohort) => !cohort.ready_for_verified_beta_promotion).length,
      total_blockers: allBlockers.length,
      blockers_by_code: countBy(allBlockers, (entry) => entry.code),
      total_sources: cohortReports.reduce((sum, cohort) => sum + cohort.sources.length, 0),
      excluded_or_sibling_sources: cohortReports.reduce((sum, cohort) => sum + cohort.excluded_or_sibling_sources.length, 0),
      selected_fact_candidates: cohortReports.reduce((sum, cohort) => sum + cohort.selected_fact_candidates.length, 0),
      actionable_quarantine_open: cohortReports.reduce((sum, cohort) => sum + cohort.quarantine.actionable_open_exact, 0),
    },
    global_blockers: globalBlockers,
    cohorts: cohortReports,
    safe_next_action_plan: {
      schema_version: "stage1-safe-next-actions-v1",
      generated_at: generatedAt,
      ordering: "priority_then_launch_rank_then_action_id",
      action_count: actions.length,
      creates_api_charge_totals: countBy(actions, (action) => action.creates_api_charge),
      actions: actions.sort((left, right) =>
        left.priority - right.priority
        || (left.launch_rank || 0) - (right.launch_rank || 0)
        || left.action_id.localeCompare(right.action_id)),
    },
  };
}

function cohort(launchRank, cohortKey, canonicalName, canonicalSearchKey, officialHomepage, aliasSearchKeys, options = {}) {
  return Object.freeze({
    launchRank,
    cohortKey,
    canonicalName,
    canonicalSearchKey,
    officialHomepage,
    aliasSearchKeys: Object.freeze(aliasSearchKeys),
    identityRules: Object.freeze(options.identityRules || []),
    preferredPaths: Object.freeze(options.preferredPaths || {}),
  });
}

function compilePostgresPattern(value, invalidRules, ruleKey) {
  if (!value) return null;
  try {
    return new RegExp(String(value).replaceAll("\\m", "\\b").replaceAll("\\M", "\\b"), "i");
  } catch {
    invalidRules.push(ruleKey || "unnamed_rule");
    return null;
  }
}

function isOfficialProgramUrl(candidate, officialHomepage) {
  try {
    const candidateHost = stripWww(new URL(candidate).hostname);
    const officialHost = stripWww(new URL(officialHomepage).hostname);
    return candidateHost === officialHost
      || candidateHost.endsWith(`.${officialHost}`)
      || officialHost.endsWith(`.${candidateHost}`);
  } catch {
    return false;
  }
}

function canonicalIdentityReport(definition, actual, remoteRegistry) {
  const blockingDrift = [];
  const expectedSlug = remoteRegistry?.canonical_slug || null;
  const idMatches = actual && (!remoteRegistry || remoteRegistry.canonical_shared_award_id === actual.id);
  const nameMatches = actual?.name === definition.canonicalName;
  const slugMatches = actual && expectedSlug ? actual.slug === expectedSlug : null;
  const homepageExact = actual?.official_homepage === definition.officialHomepage;
  const homepageNormalized = actual
    ? sameNormalizedUrl(actual.official_homepage, definition.officialHomepage)
    : false;
  const active = actual?.status === "active";

  if (actual && !idMatches) blockingDrift.push(blocker("canonical_id_drift", "critical", "Registry canonical ID does not match the exact canonical search-key record."));
  if (actual && !nameMatches) blockingDrift.push(blocker("canonical_name_drift", "critical", "Canonical display name differs from the Stage 1 reviewed name.", { expected: definition.canonicalName, actual: actual.name }));
  if (actual && expectedSlug && !slugMatches) blockingDrift.push(blocker("canonical_slug_drift", "critical", "Canonical slug differs from the service-only Stage 1 registry.", { expected: expectedSlug, actual: actual.slug }));
  if (actual && !homepageExact) blockingDrift.push(blocker("canonical_homepage_drift", "critical", "Canonical official homepage differs from the exact reviewed Stage 1 homepage.", { expected: definition.officialHomepage, actual: actual.official_homepage, normalized_match: homepageNormalized }));
  if (actual && !active) blockingDrift.push(blocker("canonical_award_inactive", "critical", "Canonical award is not active.", { status: actual.status }));

  return {
    expected: {
      search_key: definition.canonicalSearchKey,
      name: definition.canonicalName,
      shared_award_id: remoteRegistry?.canonical_shared_award_id || null,
      slug: expectedSlug,
      official_homepage: definition.officialHomepage,
    },
    actual: actual ? {
      id: actual.id,
      search_key: actual.search_key,
      name: actual.name,
      slug: actual.slug || null,
      official_homepage: actual.official_homepage || null,
      status: actual.status,
      public_facts_generated_at: actual.public_facts_generated_at || null,
    } : null,
    comparisons: {
      registry_id_matches_search_key_record: idMatches,
      exact_name_matches: nameMatches,
      slug_matches_registry: slugMatches,
      slug_status: expectedSlug ? "compared_to_remote_registry" : "unknown_until_remote_registry_exists",
      homepage_exact_matches: homepageExact,
      homepage_normalized_matches: homepageNormalized,
      active,
    },
    blocking_drift: blockingDrift,
  };
}

function inspectR2Pointer(snapshot) {
  const objectKeys = objectValue(snapshot?.latest_object_keys);
  const hashes = objectValue(snapshot?.latest_hashes);
  const keyValues = Object.values(objectKeys).filter((value) => typeof value === "string" && value.trim());
  const hashValues = Object.values(hashes).filter((value) => typeof value === "string" && value.trim());
  const pointerAvailable = Boolean(snapshot?.latest_captured_at && keyValues.length && hashValues.length);
  return {
    availability: pointerAvailable ? "immutable_pointer_present_unprobed" : "missing",
    evidence_level: "database_pointer_only_no_r2_object_request",
    bucket_present: Boolean(snapshot?.bucket),
    object_key_count: keyValues.length,
    hash_count: hashValues.length,
    object_keys: objectKeys,
    hashes,
    pointer_available: pointerAvailable,
  };
}

function inspectManifestBinding({ manifest, role, now, sourceReportById, candidateById, memberIds }) {
  const reasons = [];
  if (!manifest) return { valid: false, reasons: ["manifest_missing"] };
  if (manifest.source_role !== role) reasons.push("manifest_role_mismatch");
  if (!["present", "combined", "not_published"].includes(manifest.manifest_status)) reasons.push("manifest_status_missing");
  if (!isFresh(manifest.checked_at, now)) reasons.push("manifest_check_not_fresh");
  if (manifest.policy_version !== STAGE1_POLICY_VERSION) reasons.push("policy_version_mismatch");
  const evidence = objectValue(manifest.evidence);
  if (evidence.official !== true && evidence.official !== "true") reasons.push("official_attestation_missing");
  if (!isFresh(evidence.r2_verified_at, now)) reasons.push("r2_verification_not_fresh");
  if (!isFresh(evidence.local_verified_at, now)) reasons.push("local_verification_not_fresh");
  if (evidence.policy_version !== manifest.policy_version) reasons.push("evidence_policy_mismatch");
  if (!String(evidence.supporting_text || "").trim()) reasons.push("supporting_text_missing");

  const sourceIds = Array.isArray(manifest.source_ids) ? manifest.source_ids : [];
  if (sourceIds.length === 0) reasons.push("source_ids_missing");
  for (const sourceId of sourceIds) {
    const source = sourceReportById.get(sourceId);
    const binding = objectValue(objectValue(evidence.source_bindings)[sourceId]);
    if (!source) {
      reasons.push(`source_not_in_cohort:${sourceId}`);
      continue;
    }
    if (!memberIds.has(source.shared_award_id)) reasons.push(`source_member_mismatch:${sourceId}`);
    if (source.admin_review_status !== "open") reasons.push(`source_not_open:${sourceId}`);
    if (!source.fresh_within_24h) reasons.push(`source_check_stale:${sourceId}`);
    if (source.last_error) reasons.push(`source_error:${sourceId}`);
    if (source.identity_exclusion.excluded) reasons.push(`source_identity_excluded:${sourceId}`);
    if (!source.visual_evidence.fresh_within_24h) reasons.push(`snapshot_stale:${sourceId}`);
    if (!source.visual_evidence.r2.pointer_available) reasons.push(`r2_pointer_missing:${sourceId}`);
    if (!source.visual_evidence.local.exact_available) reasons.push(`local_exact_evidence_missing:${sourceId}`);
    if (binding.source_url !== source.url) reasons.push(`source_url_binding_mismatch:${sourceId}`);
    if (!deepEqual(binding.object_keys, source.visual_evidence.r2.object_keys)) reasons.push(`object_key_binding_mismatch:${sourceId}`);
    if (!deepEqual(binding.hashes, source.visual_evidence.r2.hashes)) reasons.push(`hash_binding_mismatch:${sourceId}`);
    if (!deepEqual(binding.r2_hashes, source.visual_evidence.r2.hashes)) reasons.push(`r2_hash_binding_mismatch:${sourceId}`);
    if (!deepEqual(binding.local_hashes, source.visual_evidence.r2.hashes)) reasons.push(`local_hash_binding_mismatch:${sourceId}`);
    if (!sameInstant(binding.captured_at, source.visual_evidence.latest_captured_at)) reasons.push(`capture_timestamp_binding_mismatch:${sourceId}`);
  }

  const candidateIds = Array.isArray(evidence.fact_candidate_ids) ? evidence.fact_candidate_ids : [];
  if (["present", "combined"].includes(manifest.manifest_status) && candidateIds.length === 0) {
    reasons.push("fact_candidate_ids_missing");
  }
  for (const candidateId of candidateIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate || candidate.candidate_status !== "selected") reasons.push(`candidate_not_selected:${candidateId}`);
    else if (!sourceIds.includes(candidate.shared_award_source_id)) reasons.push(`candidate_source_not_bound:${candidateId}`);
  }

  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checked_at: manifest.checked_at || null,
    source_ids: sourceIds,
    fact_candidate_ids: candidateIds,
    r2_verified_at: evidence.r2_verified_at || null,
    local_verified_at: evidence.local_verified_at || null,
  };
}

function inspectReconciliation({ reconciliation, now, memberIds, sourceById, candidateById }) {
  const sourceIds = Array.isArray(reconciliation?.source_ids) ? reconciliation.source_ids : null;
  const candidateIds = Array.isArray(reconciliation?.candidate_ids) ? reconciliation.candidate_ids : null;
  const unknownSourceIds = (sourceIds || []).filter((id) => !memberIds.has(sourceById.get(id)?.shared_award_id));
  const unknownCandidateIds = (candidateIds || []).filter((id) => !memberIds.has(candidateById.get(id)?.shared_award_id));
  const candidateSourceMismatches = (candidateIds || []).filter((id) => {
    const candidate = candidateById.get(id);
    return candidate?.shared_award_source_id && !(sourceIds || []).includes(candidate.shared_award_source_id);
  });
  const freshSuccess = Boolean(
    reconciliation?.status === "succeeded"
    && isFresh(reconciliation.completed_at, now),
  );
  const exactArrays = Boolean(
    sourceIds
    && candidateIds
    && unknownSourceIds.length === 0
    && unknownCandidateIds.length === 0
    && candidateSourceMismatches.length === 0,
  );
  return {
    latest: reconciliation ? sanitizeReconciliation(reconciliation) : null,
    fresh_success: freshSuccess,
    age_hours: ageHours(reconciliation?.completed_at, now),
    exact_identity_arrays: exactArrays,
    bindings: {
      source_ids_present: Boolean(sourceIds),
      candidate_ids_present: Boolean(candidateIds),
      source_id_count: sourceIds?.length || 0,
      candidate_id_count: candidateIds?.length || 0,
      unknown_source_ids: unknownSourceIds,
      unknown_candidate_ids: unknownCandidateIds,
      candidate_source_mismatches: candidateSourceMismatches,
    },
  };
}

function inspectPageAudit({ audit, publicFacts, now }) {
  const snapshot = objectValue(audit?.public_page_snapshot);
  const mismatchedFields = Object.entries(publicFacts)
    .filter(([field, value]) => !deepEqual(snapshot[field], value))
    .map(([field]) => field);
  return {
    latest: audit ? sanitizeAudit(audit) : null,
    fresh_pass: Boolean(audit?.audit_status === "passed" && isFresh(audit.created_at, now)),
    age_hours: ageHours(audit?.created_at, now),
    public_snapshot_exact: Object.keys(publicFacts).length > 0 && mismatchedFields.length === 0,
    compared_fields: Object.keys(publicFacts),
    mismatched_fields: mismatchedFields,
  };
}

function inspectPublicFactBindings({ publicFacts, selectedCandidates, reconciliation, audit, manifests }) {
  const reconciliationSources = new Set(Array.isArray(reconciliation?.source_ids) ? reconciliation.source_ids : []);
  const reconciliationCandidates = new Set(Array.isArray(reconciliation?.candidate_ids) ? reconciliation.candidate_ids : []);
  const auditSnapshot = objectValue(audit?.public_page_snapshot);
  const manifestBindings = manifests.map((manifest) => ({
    sourceIds: new Set(Array.isArray(manifest.source_ids) ? manifest.source_ids : []),
    candidateIds: new Set(Array.isArray(manifest?.evidence?.fact_candidate_ids) ? manifest.evidence.fact_candidate_ids : []),
  }));
  const fields = Object.entries(publicFacts).map(([fieldName, publicValue]) => {
    const matchingCandidates = selectedCandidates.filter((candidate) =>
      candidate.field_name === fieldName
      && deepEqual(candidate.normalized_value, publicValue)
      && candidate.shared_award_source_id
      && reconciliationCandidates.has(candidate.id)
      && reconciliationSources.has(candidate.shared_award_source_id)
      && deepEqual(auditSnapshot[fieldName], publicValue)
      && manifestBindings.some((binding) =>
        binding.candidateIds.has(candidate.id)
        && binding.sourceIds.has(candidate.shared_award_source_id)));
    return {
      field_name: fieldName,
      public_value: publicValue,
      exact_bound: matchingCandidates.length > 0,
      matching_candidate_ids: matchingCandidates.map((candidate) => candidate.id),
      matching_source_ids: [...new Set(matchingCandidates.map((candidate) => candidate.shared_award_source_id))],
    };
  });
  return {
    public_fact_count: fields.length,
    exact_bound_count: fields.filter((field) => field.exact_bound).length,
    all_fields_exact: fields.length > 0 && fields.every((field) => field.exact_bound),
    unbound_fields: fields.filter((field) => !field.exact_bound).map((field) => field.field_name),
    fields,
  };
}

function inspectFactLedger({ registry, rows, publicFacts, latestReconciliation, latestAudit }) {
  const batchId = registry?.fact_ledger_batch_id || null;
  const batchRows = batchId ? rows.filter((row) => row.verification_batch_id === batchId) : [];
  const reasons = [];
  if (!batchId) reasons.push("registry_fact_ledger_batch_missing");
  const byField = new Map(batchRows.map((row) => [row.field_name, row]));
  for (const [field, value] of Object.entries(publicFacts)) {
    const row = byField.get(field);
    if (!row) reasons.push(`ledger_field_missing:${field}`);
    else {
      if (!deepEqual(row.public_value, value)) reasons.push(`ledger_public_value_mismatch:${field}`);
      if (!deepEqual(row.normalized_value, value)) reasons.push(`ledger_normalized_value_mismatch:${field}`);
      if (row.reconciliation_id !== latestReconciliation?.id) reasons.push(`ledger_reconciliation_mismatch:${field}`);
      if (row.page_audit_id !== latestAudit?.id) reasons.push(`ledger_audit_mismatch:${field}`);
    }
  }
  if (batchRows.length !== Object.keys(publicFacts).length) reasons.push("ledger_field_count_mismatch");
  return {
    verification_batch_id: batchId,
    exact: Boolean(batchId && Object.keys(publicFacts).length > 0 && reasons.length === 0),
    expected_field_count: Object.keys(publicFacts).length,
    ledger_field_count: batchRows.length,
    reasons: [...new Set(reasons)],
    fields: batchRows.map((row) => ({
      field_name: row.field_name,
      candidate_id: row.candidate_id,
      source_id: row.source_id,
      source_url: row.source_url,
      source_role: row.source_role,
      source_captured_at: row.source_captured_at,
      reconciliation_id: row.reconciliation_id,
      page_audit_id: row.page_audit_id,
      cycle: row.cycle,
      policy_version: row.policy_version,
      verified_at: row.verified_at,
    })),
  };
}

function summarizeQuarantine(rows, memberIds) {
  const deduped = [...new Map(rows.map((row) => [row.id, row])).values()];
  const open = deduped.filter((row) => row.status === "quarantined" || row.status === "in_review");
  const actionableOpen = open.filter((row) => row.classification === "actionable_quarantine" && row.requires_action);
  return {
    total_exact: deduped.length,
    open_exact: open.length,
    actionable_open_exact: actionableOpen.length,
    historical_limitation_open_exact: open.filter((row) => row.classification === "historical_limitation").length,
    terminal_failures_requiring_action_exact: actionableOpen.reduce((sum, row) => sum + Number(row.terminal_failure_count || 0), 0),
    source_only_matches_exact: deduped.filter((row) => !memberIds.has(row.shared_award_id) && row.shared_award_source_id).length,
    by_reason: countBy(open, (row) => row.reason_code || "unknown"),
    by_category: countBy(open, (row) => row.category || "unknown"),
    cases: open.map((row) => ({
      id: row.id,
      classification: row.classification,
      category: row.category,
      status: row.status,
      severity: row.severity,
      public_impact: row.public_impact,
      owner: row.owner,
      retry_mode: row.retry_mode,
      retry_charge: row.retry_charge,
      reason_code: row.reason_code,
      reason: row.reason,
      recommended_action: row.recommended_action,
      shared_award_id: row.shared_award_id,
      shared_award_source_id: row.shared_award_source_id,
      evidence_record_count: row.evidence_record_count,
      first_observed_at: row.first_observed_at,
      last_observed_at: row.last_observed_at,
    })),
  };
}

export const STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION = 3;

export function validateRemoteSnapshot(snapshot) {
  if (!snapshot) return { ok: false, errors: ["snapshot_missing"] };
  const errors = [];
  if (snapshot.schema_version !== STAGE1_PUBLICATION_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`unexpected_schema_version:${snapshot.schema_version}`);
  }
  const rows = Array.isArray(snapshot.cohorts) ? snapshot.cohorts : [];
  if (rows.length !== 25) errors.push(`expected_25_cohorts_found_${rows.length}`);
  const actualKeys = rows.map((row) => row?.registry?.cohort_key).filter(Boolean);
  const expectedKeys = STAGE1_COHORT_DEFINITION.map((entry) => entry.cohortKey);
  if (!deepEqual([...actualKeys].sort(), [...expectedKeys].sort())) errors.push("cohort_key_set_mismatch");
  const canonicalCount = rows.reduce((sum, row) => sum + (row.members || []).filter((member) => member.member_kind === "canonical").length, 0);
  const aliasCount = rows.reduce((sum, row) => sum + (row.members || []).filter((member) => member.member_kind === "alias").length, 0);
  if (canonicalCount !== 25) errors.push(`expected_25_canonical_members_found_${canonicalCount}`);
  if (aliasCount !== 25) errors.push(`expected_25_alias_members_found_${aliasCount}`);
  return { ok: errors.length === 0, errors, cohort_count: rows.length, canonical_member_count: canonicalCount, alias_member_count: aliasCount };
}

function nextActionsForCohort(cohortReport) {
  return cohortReport.blockers
    .map((entry) => nextActionForBlocker(cohortReport, entry, cohortReport.source_roles))
    .filter(Boolean);
}

export function nextActionForBlocker(cohort, entry, sourceRoles) {
  const key = cohort?.cohort_key || "global";
  const base = {
    action_id: `${key}:${entry.code}`,
    cohort_key: cohort?.cohort_key || null,
    launch_rank: cohort?.launch_rank || null,
    blocker_code: entry.code,
    evidence: entry.evidence || {},
    safe_to_run_automatically: false,
    automated_retry: "none",
    creates_api_charge: "no",
    mutates_remote_state: false,
    recommended_command: null,
  };
  if (entry.code === "stage1_registry_not_available_remotely" || entry.code === "remote_stage1_snapshot_invalid") {
    return { ...base, priority: 1, action_type: "validate_and_deploy_registry", summary: "Validate the reviewed Stage 1 migration, then deploy it through the normal migration workflow; do not promote any award.", mutates_remote_state: true };
  }
  if (entry.code === "source_role_not_verified" || entry.code === "official_source_candidate_missing") {
    const role = entry.evidence?.role;
    const candidates = sourceRoles?.find((row) => row.source_role === role)?.official_candidate_urls || [];
    return {
      ...base,
      action_id: `${key}:${entry.code}:${role || "unknown"}`,
      priority: 3,
      action_type: "review_source_role",
      summary: candidates.length
        ? `Review the ranked official candidate for ${role}, capture fresh immutable evidence, and bind it only after hashes match.`
        : `Locate and manually verify an official program-domain source for ${role}; source intake may then enter the new-page review pipeline.`,
      creates_api_charge: candidates.length ? "no" : "conditional",
      mutates_remote_state: true,
      evidence: { ...base.evidence, ranked_candidates: candidates },
    };
  }
  if (/reconciliation/.test(entry.code)) {
    return { ...base, priority: 4, action_type: "repair_then_reconcile", summary: "Repair source/candidate bindings, then run the zero-charge reconciliation lane with explicit source_ids and candidate_ids.", creates_api_charge: "no", mutates_remote_state: true };
  }
  if (/page_audit|audit/.test(entry.code)) {
    return { ...base, priority: 5, action_type: "review_audit_failure", summary: "Inspect the findings, repair the cited fact or evidence bindings, then rerun the deterministic zero-charge page-audit lane. Any genuinely changed page is reviewed separately in the changed-page lane.", creates_api_charge: "no", mutates_remote_state: true };
  }
  if (
    /^(?:canonical_(?:award_missing|search_key_not_unique|id_drift|name_drift|slug_drift|homepage_drift|award_inactive)|retained_member_missing_or_ambiguous|remote_member_set_drift|identity_rule_invalid)$/.test(
      entry.code,
    )
  ) {
    return { ...base, priority: 2, action_type: "repair_exact_identity", summary: "Resolve the exact canonical/alias identity mismatch by search key; do not use fuzzy substitutions.", mutates_remote_state: true };
  }
  if (/public_fact|ledger/.test(entry.code)) {
    return { ...base, priority: 6, action_type: "repair_fact_evidence", summary: "Bind every non-empty public fact to an exact selected candidate, source snapshot, reconciliation, audit snapshot, and policy version before promotion. This binding step is zero-charge.", creates_api_charge: "no", mutates_remote_state: true };
  }
  if (entry.code === "actionable_quarantine_open") {
    return { ...base, priority: 7, action_type: "resolve_quarantine", summary: "Work the durable quarantine cases by reason and owner; resolve only after evidence proves the underlying failure is gone.", mutates_remote_state: true };
  }
  if (entry.code === "remote_effective_publication_gate_closed") {
    return { ...base, priority: 9, action_type: "hold_publication", summary: "Keep the award unpublished until all earlier evidence actions pass and the authoritative RPC returns verified.", mutates_remote_state: false };
  }
  return { ...base, priority: 8, action_type: "manual_review", summary: entry.message };
}

function sanitizeManifest(row) {
  const evidence = objectValue(row.evidence);
  return {
    cohort_key: row.cohort_key,
    source_role: row.source_role,
    manifest_status: row.manifest_status,
    source_ids: row.source_ids,
    checked_at: row.checked_at,
    policy_version: row.policy_version,
    evidence: {
      official: evidence.official ?? null,
      source_url: evidence.source_url || null,
      supporting_text: truncateText(evidence.supporting_text, 1_000),
      captured_at: evidence.captured_at || null,
      r2_verified_at: evidence.r2_verified_at || null,
      local_verified_at: evidence.local_verified_at || null,
      cycle: evidence.cycle || null,
      reconciliation_status: evidence.reconciliation_status || null,
      policy_version: evidence.policy_version || null,
      fact_candidate_ids: Array.isArray(evidence.fact_candidate_ids) ? evidence.fact_candidate_ids : [],
      source_bindings: compactSourceBindings(evidence.source_bindings),
      omitted_evidence_keys: Object.keys(evidence).filter((key) => ![
        "official",
        "source_url",
        "supporting_text",
        "captured_at",
        "r2_verified_at",
        "local_verified_at",
        "cycle",
        "reconciliation_status",
        "policy_version",
        "fact_candidate_ids",
        "source_bindings",
      ].includes(key)),
    },
  };
}

function sanitizeReconciliation(row) {
  return {
    id: row.id,
    reason: row.reason,
    status: row.status,
    source_ids: row.source_ids,
    candidate_ids: row.candidate_ids,
    priority: row.priority,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: truncateText(row.error, 1_000),
    metadata_summary: compactJsonSummary(row.metadata),
  };
}

function sanitizeAudit(row) {
  const findings = arrayValue(row.findings);
  const suggestedFixes = arrayValue(row.suggested_fixes);
  const fieldConflicts = arrayValue(row.field_conflicts);
  const sourceRejections = arrayValue(row.source_rejections);
  const publicSnapshot = objectValue(row.public_page_snapshot);
  return {
    id: row.id,
    shared_award_id: row.shared_award_id,
    audit_kind: row.audit_kind,
    audit_status: row.audit_status,
    severity: row.severity,
    failure_report: {
      finding_count: findings.length,
      findings: compactIssueItems(findings),
      suggested_fix_count: suggestedFixes.length,
      suggested_fixes: compactIssueItems(suggestedFixes),
      field_conflict_count: fieldConflicts.length,
      field_conflicts: compactIssueItems(fieldConflicts),
      source_rejection_count: sourceRejections.length,
      source_rejections: compactIssueItems(sourceRejections),
    },
    selected_fact_summary: compactJsonSummary(row.selected_fact_summary),
    public_page_snapshot_binding: {
      field_names: Object.keys(publicSnapshot).sort(),
      sha256: jsonSha256(publicSnapshot),
      byte_length: Buffer.byteLength(stableStringify(publicSnapshot), "utf8"),
    },
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  };
}

function compactSourceBindings(value) {
  return Object.fromEntries(Object.entries(objectValue(value)).map(([sourceId, raw]) => {
    const binding = objectValue(raw);
    return [sourceId, {
      source_url: binding.source_url || null,
      captured_at: binding.captured_at || null,
      object_keys: objectValue(binding.object_keys),
      hashes: objectValue(binding.hashes),
      r2_hashes: objectValue(binding.r2_hashes),
      local_hashes: objectValue(binding.local_hashes),
    }];
  }));
}

function compactIssueItems(value, limit = 20) {
  const items = arrayValue(value);
  return items.slice(0, limit).map((item) => {
    if (typeof item === "string") return truncateText(item, 600);
    if (!item || typeof item !== "object") return item;
    const preferredKeys = [
      "code",
      "type",
      "field",
      "field_name",
      "severity",
      "reason",
      "message",
      "description",
      "suggestion",
      "suggested_fix",
      "source_id",
      "source_url",
    ];
    const compact = {};
    for (const key of preferredKeys) {
      if (!(key in item)) continue;
      compact[key] = typeof item[key] === "string" ? truncateText(item[key], 600) : item[key];
    }
    if (Object.keys(compact).length) return compact;
    return { summary: truncateText(stableStringify(item), 800) };
  });
}

function compactJsonSummary(value) {
  if (value == null) return { type: "null", sha256: jsonSha256(null), byte_length: 4 };
  const canonical = stableStringify(value);
  if (Array.isArray(value)) {
    return {
      type: "array",
      item_count: value.length,
      sha256: jsonSha256(value),
      byte_length: Buffer.byteLength(canonical, "utf8"),
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).sort(),
      sha256: jsonSha256(value),
      byte_length: Buffer.byteLength(canonical, "utf8"),
    };
  }
  return {
    type: typeof value,
    value: truncateText(value, 600),
    sha256: jsonSha256(value),
    byte_length: Buffer.byteLength(canonical, "utf8"),
  };
}

function jsonSha256(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function truncateText(value, maxLength) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function nonEmptyPublishedFacts(value) {
  const facts = objectValue(value);
  return Object.fromEntries(PUBLISHED_FACT_FIELDS
    .filter((field) => !isEmptyJson(facts[field]))
    .map((field) => [field, facts[field]]));
}

function isEmptyJson(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function blocker(code, severity, message, evidence = {}) {
  return { code, severity, message, evidence };
}

function dedupeBlockers(entries) {
  const byIdentity = new Map();
  for (const entry of entries) {
    const key = `${entry.code}:${stableStringify(entry.evidence)}`;
    if (!byIdentity.has(key)) byIdentity.set(key, entry);
  }
  return [...byIdentity.values()];
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = String(keyFor(value));
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function latestBy(rows, field) {
  return [...rows].sort((left, right) => timestamp(right[field]) - timestamp(left[field]) || String(right.id).localeCompare(String(left.id)))[0] || null;
}

function isFresh(value, now) {
  const time = timestamp(value);
  return time > 0 && time <= now.getTime() + 5 * 60 * 1_000 && time >= now.getTime() - STAGE1_FRESHNESS_MS;
}

function ageHours(value, now) {
  const time = timestamp(value);
  if (!time) return null;
  return Math.round(((now.getTime() - time) / (60 * 60 * 1_000)) * 100) / 100;
}

function timestamp(value) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameInstant(left, right) {
  const leftTime = timestamp(left);
  const rightTime = timestamp(right);
  return leftTime > 0 && leftTime === rightTime;
}

function snapshotPointerAvailable(snapshot) {
  return Boolean(
    snapshot?.latest_captured_at
    && Object.keys(objectValue(snapshot.latest_object_keys)).length
    && Object.values(objectValue(snapshot.latest_hashes)).some(Boolean),
  );
}

function sameNormalizedUrl(left, right) {
  try {
    const normalize = (value) => {
      const url = new URL(value);
      url.hash = "";
      url.search = "";
      url.hostname = stripWww(url.hostname);
      url.pathname = normalizedPath(url.pathname);
      return url.toString().replace(/\/$/, "");
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function normalizedPathname(value) {
  try {
    return normalizedPath(new URL(value).pathname);
  } catch {
    return "";
  }
}

function normalizedPath(value) {
  const path = String(value || "/").replace(/\/+/g, "/");
  return path === "/" ? "/" : `${path.replace(/^\/?/, "/").replace(/\/$/, "")}/`;
}

function stripWww(value) {
  return String(value || "").toLowerCase().replace(/^www\./, "");
}

function pathInside(candidate, parent) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}
