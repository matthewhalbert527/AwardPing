import "server-only";

import { z } from "zod";
import type { Database, Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  stage1CohortIdentityHash,
  stage1CohortIdentityMismatch,
  stage1CohortIdentityVersion,
} from "@/lib/stage1-cohort-identity";

export const stage1PublicationPolicyVersion = "stage1-publication-v1";
export const stage1AwardCount = 25;
export const stage1EvidenceFreshnessMs = 24 * 60 * 60 * 1000;

export type Stage1PublicationState =
  Database["public"]["Tables"]["stage1_award_registry"]["Row"]["publication_state"];
export type Stage1RegistryRow =
  Database["public"]["Tables"]["stage1_award_registry"]["Row"];
export type Stage1MemberRow =
  Database["public"]["Tables"]["stage1_award_members"]["Row"];
export type Stage1SourceIdentityRule =
  Database["public"]["Tables"]["stage1_award_source_identity_rules"]["Row"];
export type Stage1EffectivePublicationRow =
  Database["public"]["Functions"]["list_stage1_effective_publication"]["Returns"][number];

export type Stage1PublicationRelease = {
  releaseKey: "stage1-national-25";
  releaseState: Stage1PublicationState;
  releaseEpoch: string | null;
  policyVersion: string;
  cohortIdentityVersion: string;
  cohortIdentityHash: string;
  activatedAt: string | null;
  effectivelyReleased: boolean;
  effectiveReason: string;
};

export type Stage1ReviewedHomepage = {
  sourceId: string;
  url: string;
};

export type Stage1PublicationEntry = {
  registry: Stage1RegistryRow;
  canonicalAwardId: string;
  memberAwardIds: string[];
  allowedSourceIds: string[];
  allowedSourceIdSet: Set<string>;
  publishedFacts: Json;
  officialHomepageSourceId: string | null;
  officialHomepageUrl: string | null;
  sourceIdentityRules: Stage1SourceIdentityRule[];
  effectiveReason: string;
  evaluatedAt: string;
  effectivelyVerified: boolean;
};

export type Stage1PublicationIndex = {
  available: boolean;
  unavailableReason: string | null;
  release: Stage1PublicationRelease | null;
  entries: Stage1PublicationEntry[];
  entryByCohortKey: Map<string, Stage1PublicationEntry>;
  entryByMemberAwardId: Map<string, Stage1PublicationEntry>;
  verifiedEntries: Stage1PublicationEntry[];
  verifiedCanonicalAwardIds: string[];
  verifiedMemberAwardIds: string[];
};

type Stage1PublicationInput = {
  registryRows: Stage1RegistryRow[];
  memberRows: Stage1MemberRow[];
  identityRules: Stage1SourceIdentityRule[];
  effectiveRows: Stage1EffectivePublicationRow[];
  release: Stage1PublicationRelease;
  allowedSourceIdsByCohortKey?: Map<string, string[]>;
  publishedFactsByCohortKey?: Map<string, Json>;
  reviewedHomepageByCohortKey?: Map<string, Stage1ReviewedHomepage>;
  now?: Date;
};

export function buildStage1PublicationIndex({
  registryRows,
  memberRows,
  identityRules,
  effectiveRows,
  release,
  allowedSourceIdsByCohortKey = new Map(),
  publishedFactsByCohortKey = new Map(),
  reviewedHomepageByCohortKey = new Map(),
  now = new Date(),
}: Stage1PublicationInput): Stage1PublicationIndex {
  const unavailable = (reason: string): Stage1PublicationIndex => ({
    available: false,
    unavailableReason: reason,
    release: null,
    entries: [],
    entryByCohortKey: new Map(),
    entryByMemberAwardId: new Map(),
    verifiedEntries: [],
    verifiedCanonicalAwardIds: [],
    verifiedMemberAwardIds: [],
  });

  if (registryRows.length !== stage1AwardCount) {
    return unavailable(
      `Stage 1 registry must contain exactly ${stage1AwardCount} awards; found ${registryRows.length}.`,
    );
  }

  if (
    release.releaseKey !== "stage1-national-25" ||
    release.policyVersion !== stage1PublicationPolicyVersion ||
    release.cohortIdentityVersion !== stage1CohortIdentityVersion ||
    release.cohortIdentityHash !== stage1CohortIdentityHash
  ) {
    return unavailable("Stage 1 cohort release identity does not match the reviewed national 25 contract.");
  }

  const identityMismatch = stage1CohortIdentityMismatch(registryRows);
  if (identityMismatch) {
    return unavailable(identityMismatch);
  }

  const registryByCohortKey = new Map(
    registryRows.map((registry) => [registry.cohort_key, registry]),
  );
  if (registryByCohortKey.size !== stage1AwardCount) {
    return unavailable("Stage 1 registry contains duplicate cohort keys.");
  }

  const effectiveByCohortKey = new Map(
    effectiveRows.map((row) => [row.cohort_key, row]),
  );
  if (
    effectiveRows.length !== stage1AwardCount ||
    effectiveByCohortKey.size !== stage1AwardCount
  ) {
    return unavailable("Stage 1 effective-publication result is incomplete.");
  }

  const effectiveCount = effectiveRows.filter((row) => row.effectively_verified).length;
  if (effectiveCount !== 0 && effectiveCount !== stage1AwardCount) {
    return unavailable(
      `Stage 1 effective-publication result is partial (${effectiveCount}/${stage1AwardCount}).`,
    );
  }

  const releaseActive = release.releaseState === "verified_beta";
  if (releaseActive) {
    if (
      !release.effectivelyReleased ||
      release.effectiveReason !== "verified" ||
      effectiveCount !== stage1AwardCount ||
      !isUuid(release.releaseEpoch) ||
      !isTimestamp(release.activatedAt)
    ) {
      return unavailable("Stage 1 verified release is missing one authoritative 25-award epoch.");
    }
    if (
      registryRows.some((registry) => registry.release_epoch !== release.releaseEpoch) ||
      effectiveRows.some((row) =>
        row.release_epoch !== release.releaseEpoch ||
        row.release_state !== "verified_beta" ||
        row.release_policy_version !== stage1PublicationPolicyVersion ||
        row.release_identity_version !== stage1CohortIdentityVersion ||
        row.release_identity_hash !== stage1CohortIdentityHash ||
        !row.cohort_ready ||
        row.cohort_readiness_reason !== "verified" ||
        row.effective_reason !== "verified"
      )
    ) {
      return unavailable("Stage 1 release contains a partial or mixed publication epoch.");
    }
  } else if (
    release.effectivelyReleased ||
    release.releaseEpoch !== null ||
    release.activatedAt !== null ||
    effectiveCount !== 0 ||
    registryRows.some((registry) => registry.release_epoch !== null) ||
    effectiveRows.some((row) => row.release_epoch !== null)
  ) {
    return unavailable("Stage 1 closed release contains stale or mixed publication epochs.");
  }

  const rulesByCohortKey = new Map<string, Stage1SourceIdentityRule[]>();
  for (const rule of identityRules) {
    if (!registryByCohortKey.has(rule.cohort_key)) {
      return unavailable(
        `Stage 1 source identity rule references unknown cohort ${rule.cohort_key}.`,
      );
    }
    const cohortRules = rulesByCohortKey.get(rule.cohort_key) || [];
    cohortRules.push(rule);
    rulesByCohortKey.set(rule.cohort_key, cohortRules);
  }

  const membersByCohortKey = new Map<string, Stage1MemberRow[]>();
  for (const member of memberRows) {
    if (!registryByCohortKey.has(member.cohort_key)) {
      return unavailable(`Stage 1 member references unknown cohort ${member.cohort_key}.`);
    }
    const cohortMembers = membersByCohortKey.get(member.cohort_key) || [];
    cohortMembers.push(member);
    membersByCohortKey.set(member.cohort_key, cohortMembers);
  }

  const entries: Stage1PublicationEntry[] = [];
  const entryByCohortKey = new Map<string, Stage1PublicationEntry>();
  const entryByMemberAwardId = new Map<string, Stage1PublicationEntry>();

  for (const registry of [...registryRows].sort(
    (left, right) => left.launch_rank - right.launch_rank,
  )) {
    const members = membersByCohortKey.get(registry.cohort_key) || [];
    const canonicalMembers = members.filter(
      (member) => member.member_kind === "canonical",
    );
    if (
      canonicalMembers.length !== 1 ||
      canonicalMembers[0].shared_award_id !== registry.canonical_shared_award_id
    ) {
      return unavailable(
        `Stage 1 cohort ${registry.cohort_key} does not have one matching canonical member.`,
      );
    }

    const memberAwardIds = [...new Set(members.map((member) => member.shared_award_id))];
    const effective = effectiveByCohortKey.get(registry.cohort_key);
    if (!effective) {
      return unavailable(
        `Stage 1 cohort ${registry.cohort_key} has no effective-publication result.`,
      );
    }
    const allowedSourceIds = [
      ...new Set(allowedSourceIdsByCohortKey.get(registry.cohort_key) || []),
    ];
    const publishedFacts =
      publishedFactsByCohortKey.get(registry.cohort_key) || {};
    const reviewedHomepage = reviewedHomepageByCohortKey.get(registry.cohort_key) || null;
    if (
      releaseActive &&
      (!reviewedHomepage ||
        reviewedHomepage.url !== registry.official_homepage ||
        !allowedSourceIds.includes(reviewedHomepage.sourceId))
    ) {
      return unavailable(
        `Stage 1 cohort ${registry.cohort_key} has no exact reviewed official-homepage source.`,
      );
    }
    const effectivePrerequisitesPresent = releaseActive &&
      allowedSourceIds.length > 0 &&
      hasPublishedOverview(publishedFacts) &&
      Boolean(reviewedHomepage);
    const entry: Stage1PublicationEntry = {
      registry,
      canonicalAwardId: registry.canonical_shared_award_id,
      memberAwardIds,
      allowedSourceIds,
      allowedSourceIdSet: new Set(allowedSourceIds),
      publishedFacts,
      officialHomepageSourceId: reviewedHomepage?.sourceId || null,
      officialHomepageUrl: reviewedHomepage?.url || null,
      sourceIdentityRules: rulesByCohortKey.get(registry.cohort_key) || [],
      effectiveReason: effective.effective_reason,
      evaluatedAt: effective.evaluated_at,
      effectivelyVerified:
        releaseActive &&
        effectivePrerequisitesPresent &&
        effective.effectively_verified &&
        effective.effective_reason === "verified" &&
        isEffectivelyVerifiedRegistryRow(registry, now),
    };
    entries.push(entry);
    entryByCohortKey.set(registry.cohort_key, entry);

    for (const memberAwardId of memberAwardIds) {
      if (entryByMemberAwardId.has(memberAwardId)) {
        return unavailable(
          `Stage 1 award ${memberAwardId} belongs to more than one cohort.`,
        );
      }
      entryByMemberAwardId.set(memberAwardId, entry);
    }
  }

  const verifiedEntries = entries.filter((entry) => entry.effectivelyVerified);
  if (releaseActive && verifiedEntries.length !== stage1AwardCount) {
    return unavailable(
      `Stage 1 release epoch did not verify all ${stage1AwardCount} awards.`,
    );
  }
  return {
    available: true,
    unavailableReason: null,
    release,
    entries,
    entryByCohortKey,
    entryByMemberAwardId,
    verifiedEntries,
    verifiedCanonicalAwardIds: verifiedEntries.map((entry) => entry.canonicalAwardId),
    verifiedMemberAwardIds: verifiedEntries.flatMap((entry) => entry.memberAwardIds),
  };
}

export function isEffectivelyVerifiedRegistryRow(
  registry: Stage1RegistryRow,
  now = new Date(),
) {
  if (
    registry.publication_state !== "verified_beta" ||
    registry.policy_version !== stage1PublicationPolicyVersion
  ) {
    return false;
  }

  return [registry.evidence_checked_at, registry.last_verified_at].every(
    (value) => isFreshTimestamp(value, now),
  );
}

const publicationStateSchema = z.enum([
  "pending",
  "verified_beta",
  "revalidation_pending",
  "suspended",
]);
const memberKindSchema = z.enum(["canonical", "alias"]);
const stage1RegistrySnapshotSchema = z.object({
  cohort_key: z.string().min(1),
  launch_rank: z.number().int().min(1).max(stage1AwardCount),
  canonical_name: z.string().min(1),
  canonical_shared_award_id: z.string().uuid(),
  canonical_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  official_homepage: z.string().url().startsWith("https://"),
  publication_state: publicationStateSchema,
  state_reason: z.string().min(1),
  policy_version: z.string().min(1),
  fact_ledger_batch_id: z.string().uuid().nullable(),
  release_epoch: z.string().uuid().nullable(),
  evidence_checked_at: z.string().nullable(),
  last_verified_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();
const stage1MemberSnapshotSchema = z.object({
  shared_award_id: z.string().uuid(),
  cohort_key: z.string().min(1),
  member_kind: memberKindSchema,
  reason: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();
const stage1IdentityRuleSnapshotSchema = z.object({
  id: z.number().int().nonnegative(),
  cohort_key: z.string().min(1),
  rule_key: z.string().min(1),
  url_pattern: z.string().nullable(),
  title_pattern: z.string().nullable(),
  reason: z.string().min(1),
  policy_version: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();
const stage1SnapshotSchema = z.object({
  schema_version: z.literal(3),
  cohort_identity_version: z.literal(stage1CohortIdentityVersion),
  cohort_identity_hash: z.literal(stage1CohortIdentityHash),
  evaluated_at: z.string(),
  release: z.object({
    release_key: z.literal("stage1-national-25"),
    release_state: publicationStateSchema,
    release_epoch: z.string().uuid().nullable(),
    policy_version: z.string().min(1),
    cohort_identity_version: z.string().min(1),
    cohort_identity_hash: z.string().regex(/^[0-9a-f]{64}$/),
    activated_at: z.string().nullable(),
    effectively_released: z.boolean(),
    effective_reason: z.string().min(1),
    ready_cohort_count: z.number().int().min(0).max(stage1AwardCount),
  }).strict(),
  cohorts: z.array(z.object({
    registry: stage1RegistrySnapshotSchema,
    effectively_verified: z.boolean(),
    effective_reason: z.string().min(1),
    cohort_ready: z.boolean(),
    cohort_readiness_reason: z.string().min(1),
    evaluated_at: z.string(),
    members: z.array(stage1MemberSnapshotSchema),
    identity_rules: z.array(stage1IdentityRuleSnapshotSchema),
    allowed_source_ids: z.array(z.string().uuid()),
    reviewed_homepage: z.object({
      source_id: z.string().uuid(),
      url: z.string().url().startsWith("https://"),
    }).strict().nullable(),
    published_facts: z.record(z.string(), z.unknown()),
  }).strict()),
}).strict();

export async function loadStage1PublicationIndex(): Promise<Stage1PublicationIndex> {
  const admin = createSupabaseAdminClient();
  const snapshotResult = await admin.rpc("get_stage1_publication_snapshot");
  if (snapshotResult.error) {
    return buildUnavailableIndex(
      snapshotResult.error.message || "Stage 1 publication registry is unavailable.",
    );
  }

  const parsed = stage1SnapshotSchema.safeParse(snapshotResult.data);
  if (!parsed.success) {
    return buildUnavailableIndex(
      `Stage 1 publication snapshot failed validation: ${parsed.error.issues[0]?.message || "unknown schema error"}`,
    );
  }

  const snapshot = parsed.data;
  const evaluatedAt = new Date(snapshot.evaluated_at);
  if (!Number.isFinite(evaluatedAt.getTime())) {
    return buildUnavailableIndex("Stage 1 publication snapshot has an invalid evaluation time.");
  }
  if (snapshot.cohorts.some((cohort) => cohort.evaluated_at !== snapshot.evaluated_at)) {
    return buildUnavailableIndex("Stage 1 publication snapshot mixed evaluation times.");
  }

  const allowedSourceIdsByCohortKey = new Map(
    snapshot.cohorts.map((cohort) => [
      cohort.registry.cohort_key,
      cohort.allowed_source_ids,
    ]),
  );
  const publishedFactsByCohortKey = new Map(
    snapshot.cohorts.map((cohort) => [
      cohort.registry.cohort_key,
      cohort.published_facts as Json,
    ]),
  );
  const reviewedHomepageByCohortKey = new Map(
    snapshot.cohorts.flatMap((cohort) => cohort.reviewed_homepage
      ? [[cohort.registry.cohort_key, {
          sourceId: cohort.reviewed_homepage.source_id,
          url: cohort.reviewed_homepage.url,
        }] as const]
      : []),
  );
  const release: Stage1PublicationRelease = {
    releaseKey: snapshot.release.release_key,
    releaseState: snapshot.release.release_state,
    releaseEpoch: snapshot.release.release_epoch,
    policyVersion: snapshot.release.policy_version,
    cohortIdentityVersion: snapshot.release.cohort_identity_version,
    cohortIdentityHash: snapshot.release.cohort_identity_hash,
    activatedAt: snapshot.release.activated_at,
    effectivelyReleased: snapshot.release.effectively_released,
    effectiveReason: snapshot.release.effective_reason,
  };

  return buildStage1PublicationIndex({
    registryRows: snapshot.cohorts.map((cohort) => cohort.registry as Stage1RegistryRow),
    memberRows: snapshot.cohorts.flatMap((cohort) => cohort.members as Stage1MemberRow[]),
    identityRules: snapshot.cohorts.flatMap(
      (cohort) => cohort.identity_rules as Stage1SourceIdentityRule[],
    ),
    effectiveRows: snapshot.cohorts.map((cohort) => ({
      cohort_key: cohort.registry.cohort_key,
      effectively_verified: cohort.effectively_verified,
      effective_reason: cohort.effective_reason,
      evaluated_at: cohort.evaluated_at,
      cohort_ready: cohort.cohort_ready,
      cohort_readiness_reason: cohort.cohort_readiness_reason,
      release_epoch: snapshot.release.release_epoch,
      release_state: snapshot.release.release_state,
      release_policy_version: snapshot.release.policy_version,
      release_identity_version: snapshot.release.cohort_identity_version,
      release_identity_hash: snapshot.release.cohort_identity_hash,
    })),
    release,
    allowedSourceIdsByCohortKey,
    publishedFactsByCohortKey,
    reviewedHomepageByCohortKey,
    now: evaluatedAt,
  });
}

export async function getStage1PublicationEntryForAward(
  sharedAwardId: string,
): Promise<Stage1PublicationEntry | null> {
  const index = await loadStage1PublicationIndex();
  return index.entryByMemberAwardId.get(sharedAwardId) || null;
}

export function isStage1SourceIdentityExcluded(
  publication: Stage1PublicationEntry,
  source: { url?: string | null; title?: string | null; display_title?: string | null },
) {
  const title = [source.title, source.display_title].filter(Boolean).join(" ");
  return publication.sourceIdentityRules.some((rule) =>
    matchesIdentityPattern(source.url || "", rule.url_pattern) ||
    matchesIdentityPattern(title, rule.title_pattern),
  );
}

function isFreshTimestamp(value: string | null, now: Date) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  return age >= 0 && age <= stage1EvidenceFreshnessMs;
}

function buildUnavailableIndex(reason: string): Stage1PublicationIndex {
  return {
    available: false,
    unavailableReason: reason,
    release: null,
    entries: [],
    entryByCohortKey: new Map(),
    entryByMemberAwardId: new Map(),
    verifiedEntries: [],
    verifiedCanonicalAwardIds: [],
    verifiedMemberAwardIds: [],
  };
}

function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function isTimestamp(value: string | null): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function hasPublishedOverview(value: Json) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const overview = value.overview;
  return typeof overview === "string" && overview.trim().length > 0;
}

function matchesIdentityPattern(value: string, pattern: string | null) {
  if (!pattern || !value) return false;
  try {
    const javascriptPattern = pattern
      .replaceAll("\\m", "\\b")
      .replaceAll("\\M", "\\b");
    return new RegExp(javascriptPattern, "i").test(value);
  } catch {
    // A malformed service-only rule fails closed for its cohort source.
    return true;
  }
}
