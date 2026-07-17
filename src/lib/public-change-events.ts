import "server-only";

import { dedupeChangeSummaries } from "@/lib/change-summary";
import type { Database } from "@/lib/database.types";
import {
  isPublicChangeEvent,
  type PublicChangeEventVisualEvidence,
} from "@/lib/public-change-event";
import { loadPublicEventVisualEvidence } from "@/lib/public-event-visual-evidence";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  Stage1PublicationEntry,
  Stage1PublicationIndex,
} from "@/lib/stage1-publication";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type PublicChangeEventRow = Pick<
  Database["public"]["Tables"]["shared_award_change_events"]["Row"],
  | "id"
  | "shared_award_id"
  | "shared_award_source_id"
  | "source_title"
  | "source_url"
  | "source_page_type"
  | "summary"
  | "change_details"
  | "suppressed_at"
  | "suppression_reason"
  | "suppression_source"
  | "visual_review_candidate_id"
  | "detected_at"
>;

export type PublicChangeEventSourceRow = Pick<
  Database["public"]["Tables"]["shared_award_sources"]["Row"],
  | "id"
  | "shared_award_id"
  | "url"
  | "admin_review_status"
  | "title"
  | "display_title"
  | "page_metadata"
  | "page_metadata_generated_at"
  | "page_metadata_model"
  | "page_type"
  | "source"
  | "reason"
  | "submitted_by_user_id"
>;

export type EligiblePublicChangeEvent = {
  event: PublicChangeEventRow;
  source: PublicChangeEventSourceRow;
  publication: Stage1PublicationEntry;
  /** Immutable event evidence that passed the complete public predicate. */
  evidence: PublicChangeEventVisualEvidence;
};

type Cursor = Pick<PublicChangeEventRow, "id" | "detected_at">;

type LoadEligiblePublicChangeEventsInput = {
  admin: AdminClient;
  publicationIndex: Stage1PublicationIndex;
  /** Null means that the caller needs the complete, proven result set. */
  limit: number | null;
  memberAwardIds?: string[];
  since?: string;
  pageSize?: number;
  maxScannedRows?: number;
};

const changeSelect = "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, suppressed_at, suppression_reason, suppression_source, visual_review_candidate_id, detected_at" as const;

const sourceSelect = "id, shared_award_id, url, admin_review_status, title, display_title, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id" as const;

/**
 * Loads public events in deterministic keyset pages and applies the complete
 * publication/evidence policy before deciding that enough rows were found.
 * Reaching the safety cap without proving the result is complete is an error,
 * so invalid recent rows can never silently starve older valid updates.
 */
export async function loadEligiblePublicChangeEvents({
  admin,
  publicationIndex,
  limit,
  memberAwardIds = publicationIndex.verifiedMemberAwardIds,
  since,
  pageSize = 200,
  maxScannedRows = limit === null ? 50_000 : Math.max(5_000, limit * 500),
}: LoadEligiblePublicChangeEventsInput): Promise<EligiblePublicChangeEvent[]> {
  if (
    !publicationIndex.available ||
    publicationIndex.verifiedEntries.length === 0 ||
    !publicationIndex.release?.effectivelyReleased ||
    !publicationIndex.release.releaseEpoch
  ) {
    return [];
  }
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error("Public change-event limit must be a non-negative integer or null.");
  }
  if (limit === 0) return [];
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("Public change-event page size must be between 1 and 1000.");
  }
  if (!Number.isSafeInteger(maxScannedRows) || maxScannedRows < 1) {
    throw new Error("Public change-event scan cap must be a positive integer.");
  }
  const sinceValue = since ? normalizedTimestamp(since, "since") : null;
  const verifiedMemberIds = new Set(publicationIndex.verifiedMemberAwardIds);
  const selectedMemberIds = [
    ...new Set(memberAwardIds.filter((id) => verifiedMemberIds.has(id))),
  ];
  if (!selectedMemberIds.length) return [];
  const selectedPublications = [
    ...new Set(
      selectedMemberIds
        .map((id) => publicationIndex.entryByMemberAwardId.get(id))
        .filter((entry): entry is Stage1PublicationEntry => Boolean(entry)),
    ),
  ];
  const selectedAllowedSourceIds = [
    ...new Set(selectedPublications.flatMap((entry) => entry.allowedSourceIds)),
  ];
  if (!selectedAllowedSourceIds.length) return [];

  const eligible: EligiblePublicChangeEvent[] = [];
  const sourceById = new Map<string, PublicChangeEventSourceRow>();
  let cursor: Cursor | null = null;
  let scannedRows = 0;

  while (true) {
    const remainingBeforeCap = maxScannedRows - scannedRows;
    // One additional row proves that the configured cap would be exceeded.
    const requestedPageSize = Math.min(pageSize, remainingBeforeCap + 1);
    let query = admin
      .from("shared_award_change_events")
      .select(changeSelect)
      .in("shared_award_id", selectedMemberIds)
      .in("shared_award_source_id", selectedAllowedSourceIds)
      .is("suppressed_at", null)
      .order("detected_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(requestedPageSize);
    if (sinceValue) query = query.gte("detected_at", sinceValue);
    if (cursor) query = query.or(publicChangeEventCursorFilter(cursor));

    const { data, error } = await query;
    if (error) {
      throw new Error(`Public change-event page query failed: ${error.message}`);
    }
    const page = (data || []) as PublicChangeEventRow[];
    assertStrictlyDescendingPage(page, cursor);
    if (scannedRows + page.length > maxScannedRows) {
      throw new Error(
        `Public change-event scan exceeded ${maxScannedRows} rows before the result was proven complete.`,
      );
    }
    scannedRows += page.length;

    if (page.length) {
      const allowedCandidates = page.filter((event) => {
        const publication = publicationIndex.entryByMemberAwardId.get(
          event.shared_award_id,
        );
        return Boolean(
          publication?.effectivelyVerified &&
          event.shared_award_source_id &&
          publication.allowedSourceIdSet.has(event.shared_award_source_id),
        );
      });
      const missingSourceIds = [
        ...new Set(
          allowedCandidates
            .map((event) => event.shared_award_source_id)
            .filter((sourceId): sourceId is string => sourceId !== null)
            .filter((sourceId) => !sourceById.has(sourceId)),
        ),
      ];
      await loadSourceRows(admin, missingSourceIds, sourceById);
      const evidenceCandidates = allowedCandidates.filter((event) =>
        Boolean(
          event.shared_award_source_id &&
          sourceById.has(event.shared_award_source_id),
        ),
      );
      const evidenceByEventId = await loadPublicEventVisualEvidence(
        admin,
        evidenceCandidates.map((event) => event.id),
      );

      for (const event of evidenceCandidates) {
        const publication = publicationIndex.entryByMemberAwardId.get(
          event.shared_award_id,
        );
        const source = event.shared_award_source_id
          ? sourceById.get(event.shared_award_source_id) || null
          : null;
        const evidence = evidenceByEventId.get(event.id) || null;
        if (
          !publication ||
          !source ||
          !evidence ||
          !isPublicChangeEvent({
            event,
            award: {
              id: publication.canonicalAwardId,
              name: publication.registry.canonical_name,
              status: "active",
            },
            source,
            publication,
            evidence,
          })
        ) {
          continue;
        }
        eligible.push({ event, source, publication, evidence });
      }
    }

    const deduped = dedupeEligiblePublicChangeEvents(eligible);
    if (limit !== null && deduped.length >= limit) {
      await assertStage1PublicationReleaseCurrent(admin, publicationIndex);
      return deduped.slice(0, limit);
    }
    if (page.length < requestedPageSize || !page.length) {
      await assertStage1PublicationReleaseCurrent(admin, publicationIndex);
      return deduped;
    }
    cursor = page.at(-1) || null;
  }
}

/**
 * Establishes the release epoch used as the publication decision. Call this
 * immediately before irreversible downstream delivery as well as after scans.
 */
export async function assertStage1PublicationReleaseCurrent(
  admin: AdminClient,
  publicationIndex: Stage1PublicationIndex,
) {
  const expected = publicationIndex.release;
  if (
    !publicationIndex.available ||
    !expected?.effectivelyReleased ||
    !expected.releaseEpoch
  ) {
    throw new Error("Stage 1 public release is not active.");
  }
  const { data, error } = await admin
    .from("stage1_publication_release_state")
    .select("release_key, release_state, release_epoch, policy_version, cohort_identity_version, cohort_identity_hash")
    .eq("release_key", expected.releaseKey)
    .maybeSingle();
  if (error || !data) {
    throw new Error("Stage 1 public release could not be revalidated.");
  }
  if (
    data.release_state !== "verified_beta" ||
    data.release_epoch !== expected.releaseEpoch ||
    data.policy_version !== expected.policyVersion ||
    data.cohort_identity_version !== expected.cohortIdentityVersion ||
    data.cohort_identity_hash !== expected.cohortIdentityHash
  ) {
    throw new Error("Stage 1 public release changed while updates were loading.");
  }
  return expected.releaseEpoch;
}

export function dedupeEligiblePublicChangeEvents(
  events: EligiblePublicChangeEvent[],
) {
  const rowsByCanonicalAward = new Map<string, PublicChangeEventRow[]>();
  for (const entry of events) {
    const canonicalAwardId = entry.publication.canonicalAwardId;
    rowsByCanonicalAward.set(canonicalAwardId, [
      ...(rowsByCanonicalAward.get(canonicalAwardId) || []),
      {
        ...entry.event,
        // Aliases belong to one public award and must deduplicate together.
        shared_award_id: canonicalAwardId,
      },
    ]);
  }
  const retainedIds = new Set(
    [...rowsByCanonicalAward.values()]
      .flatMap((rows) => dedupeChangeSummaries(rows))
      .map((row) => row.id),
  );
  // Preserve the keyset query's global newest-first order.
  return events.filter((entry) => retainedIds.has(entry.event.id));
}

export function publicChangeEventCursorFilter(cursor: Cursor) {
  const detectedAt = validatedCursorTimestamp(cursor.detected_at, "cursor");
  if (!isUuid(cursor.id)) {
    throw new Error("Public change-event cursor contains an invalid event id.");
  }
  return [
    `detected_at.lt.${detectedAt}`,
    `and(detected_at.eq.${detectedAt},id.lt.${cursor.id})`,
  ].join(",");
}

function assertStrictlyDescendingPage(
  page: PublicChangeEventRow[],
  previousCursor: Cursor | null,
) {
  let previous = previousCursor;
  for (const row of page) {
    validatedCursorTimestamp(row.detected_at, "row");
    if (!isUuid(row.id)) {
      throw new Error("Public change-event query returned an invalid event id.");
    }
    if (previous && compareCursor(row, previous) >= 0) {
      throw new Error("Public change-event keyset page was not strictly descending.");
    }
    previous = row;
  }
}

function compareCursor(left: Cursor, right: Cursor) {
  const leftMicros = timestampMicros(left.detected_at);
  const rightMicros = timestampMicros(right.detected_at);
  if (leftMicros !== rightMicros) return leftMicros < rightMicros ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function loadSourceRows(
  admin: AdminClient,
  sourceIds: string[],
  target: Map<string, PublicChangeEventSourceRow>,
) {
  for (let index = 0; index < sourceIds.length; index += 200) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select(sourceSelect)
      .in("id", sourceIds.slice(index, index + 200));
    if (error) {
      throw new Error(`Public change-event source query failed: ${error.message}`);
    }
    for (const source of (data || []) as PublicChangeEventSourceRow[]) {
      target.set(source.id, source);
    }
  }
}

function normalizedTimestamp(value: string, label: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Public change-event ${label} timestamp is invalid.`);
  }
  return new Date(milliseconds).toISOString();
}

function validatedCursorTimestamp(value: string, label: string) {
  timestampMicros(value, label);
  return value;
}

function timestampMicros(value: string, label = "cursor") {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Public change-event ${label} timestamp is invalid.`);
  }
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const zoneOffsetMinutes = zone === "Z"
    ? 0
    : (zone.startsWith("-") ? -1 : 1) *
      (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return BigInt(utcMillis - zoneOffsetMinutes * 60_000) * BigInt(1_000) +
    BigInt(fraction.padEnd(6, "0"));
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
