import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { SetupNotice } from "@/components/setup-notice";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { pageTypeLabel, type AwardPageType } from "@/lib/award-discovery-types";
import { requireUser } from "@/lib/auth";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { displayChangeSummary } from "@/lib/change-summary";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { cleanDisplayText, readableSourceTitle } from "@/lib/display-text";
import { insertionIndexForAddedText } from "@/lib/highlight-insertion";
import { requireOfficeContext } from "@/lib/offices";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ kind: string; id: string }>;
};

type HighlightChange = {
  kind: "shared" | "office";
  title: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails: Json;
  detectedAt: string;
  previousTextSample: string | null;
  newTextSample: string | null;
  backHref: string;
};

export default async function HighlightPage({ params }: Props) {
  if (!hasSupabaseConfig()) {
    return (
      <div className="page-shell">
        <SiteHeader />
        <main className="mx-auto max-w-5xl px-5 py-14">
          <SetupNotice />
        </main>
        <SiteFooter />
      </div>
    );
  }

  const { kind, id } = await params;
  if (kind !== "shared" && kind !== "office") notFound();

  let change: HighlightChange | null;
  try {
    change = await loadChange(kind, id);
  } catch (error) {
    logHighlightLoadIssue("highlight page load failed", error);
    return <HighlightLoadIssue backHref={kind === "office" ? "/dashboard" : "/award-directory"} />;
  }
  if (!change) notFound();

  const evidence = buildChangeEvidence({
    sourceUrl: change.sourceUrl,
    sourceTitle: change.sourceTitle,
    summary: change.summary,
    changeDetails: change.changeDetails,
    previousTextSample: change.previousTextSample,
    newTextSample: change.newTextSample,
  });
  const afterCandidates = evidence.hasStructuredEvidence && evidence.currentSnippets.length > 0
    ? uniqueCandidates(evidence.currentSnippets)
    : uniqueCandidates([evidence.afterSnippet, ...evidence.addedSnippets]);
  const beforeCandidates = evidence.hasStructuredEvidence && evidence.previousSnippets.length > 0
    ? uniqueCandidates(evidence.previousSnippets)
    : uniqueCandidates([evidence.beforeSnippet, ...evidence.removedSnippets]);
  const showAfterSnapshot = evidence.hasSnapshotEvidence && Boolean(normalizeSnapshotText(change.newTextSample || ""));
  const showBeforeSnapshot =
    evidence.hasSnapshotEvidence && Boolean(normalizeSnapshotText(change.previousTextSample || ""));
  const beforeInsertionMarker =
    showBeforeSnapshot && beforeCandidates.length === 0
      ? findInsertionMarker(
          change.previousTextSample,
          change.newTextSample,
          afterCandidates,
          "New text inserted here",
        )
      : null;
  const suppressContextOnlyBeforeSnapshot =
    showBeforeSnapshot &&
    beforeCandidates.length === 0 &&
    !beforeInsertionMarker &&
    afterCandidates.length > 0;
  const showBeforePanel = showBeforeSnapshot && !suppressContextOnlyBeforeSnapshot;
  const snapshotPanelCount = [showAfterSnapshot, showBeforePanel].filter(Boolean).length;
  const hasSupportingExcerpts =
    evidence.currentSnippets.length > 0 || evidence.previousSnippets.length > 0;

  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="highlight-page mx-auto max-w-6xl px-5 py-12">
        <div className="highlight-page-header">
          <Link className="button-secondary highlight-back-link" href={change.backHref}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </Link>
          <div>
            <span className="badge">Change explanation</span>
            <h1>{change.title}</h1>
            <p>
              AwardPing summarizes the stored before and after evidence so broad page edits are
              easier to understand. Supporting excerpts show the text behind the description.
            </p>
          </div>
        </div>

        <section className="highlight-source-bar">
          <div className="highlight-source-main">
            <h2>Source</h2>
            <p>{readableSourceTitle(change.sourceTitle || "Official source page", change.sourceUrl)}</p>
            <div className="highlight-source-meta">
              {change.sourcePageType && <span>{pageTypeLabel(change.sourcePageType)}</span>}
              <span>Detected {formatDate(change.detectedAt)}</span>
            </div>
          </div>
          {change.sourceUrl && (
            <a className="highlight-source-action" href={change.sourceUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} aria-hidden="true" />
              Open current official page
            </a>
          )}
        </section>

        <section className="highlight-summary-panel highlight-description-panel">
          <div className="highlight-description-kicker">
            <Sparkles size={16} aria-hidden="true" />
            <span>{evidence.descriptionSourceLabel || "Change description"}</span>
          </div>
          <h2>What changed</h2>
          <p className="highlight-description-copy">
            {evidence.summarySnippet ||
              displayChangeSummary(change.summary, change.sourceUrl, change.changeDetails)}
          </p>
          {(evidence.changeTypeLabel || evidence.sectionLabel || evidence.confidenceLabel) && (
            <div className="highlight-description-meta">
              {evidence.changeTypeLabel && (
                <span>
                  <strong>Type</strong>
                  {evidence.changeTypeLabel}
                </span>
              )}
              {evidence.sectionLabel && (
                <span>
                  <strong>Section</strong>
                  {evidence.sectionLabel}
                </span>
              )}
              {evidence.confidenceLabel && (
                <span>
                  <strong>Confidence</strong>
                  {evidence.confidenceLabel}
                </span>
              )}
            </div>
          )}
          {evidence.relationshipNote && (
            <p className="highlight-note highlight-caution-note">{evidence.relationshipNote}</p>
          )}
          {evidence.advisorImpact && (
            <p className="highlight-note highlight-advisor-note">{evidence.advisorImpact}</p>
          )}
        </section>

        {hasSupportingExcerpts && (
          <section className="highlight-summary-panel highlight-excerpts-panel">
            <div className="highlight-section-intro">
              <h2>Supporting excerpts</h2>
              <p>
                These are the stored snippets AwardPing used to produce the description. They are
                evidence excerpts, not a promise that every changed word is marked.
              </p>
            </div>
            <div className="highlight-excerpt-grid">
              <SupportingExcerptList
                title="Current wording"
                snippets={evidence.currentSnippets}
                variant="added"
                emptyText="No current wording was isolated in the stored excerpt."
              />
              <SupportingExcerptList
                title="Previous wording"
                snippets={evidence.previousSnippets}
                variant="removed"
                emptyText="No reliable previous wording was isolated for this item."
              />
            </div>
          </section>
        )}

        {evidence.hasSnapshotEvidence && snapshotPanelCount > 0 ? (
          <>
            <div className="highlight-section-intro highlight-snapshot-intro">
              <h2>Stored snapshot context</h2>
              <p>
                Exact marks appear only when a stored snippet can be placed in the snapshot text.
                The description above is the primary explanation.
              </p>
            </div>
            <div
              className={`highlight-snapshot-grid${
                snapshotPanelCount === 1 ? " highlight-snapshot-grid-single" : ""
              }`}
            >
              {showAfterSnapshot && (
                <HighlightedSnapshot
                  title={showBeforePanel ? "Current stored snapshot" : "Stored snapshot text"}
                  text={change.newTextSample}
                  candidates={afterCandidates}
                  variant="added"
                />
              )}
              {showBeforePanel && (
                <HighlightedSnapshot
                  title="Previous stored snapshot"
                  text={change.previousTextSample}
                  candidates={beforeCandidates}
                  variant="removed"
                  marker={beforeInsertionMarker}
                />
              )}
            </div>
          </>
        ) : (
          <section className="highlight-summary-panel highlight-status-panel">
            <h2>Evidence status</h2>
            <p>
              No reliable before/after snippet was isolated for this update. The stored comparison
              was likely affected by an older shortened sample, so this page avoids highlighting
              unrelated text.
            </p>
          </section>
        )}

        {suppressContextOnlyBeforeSnapshot && (
          <section className="highlight-summary-panel highlight-status-panel">
            <h2>Evidence status</h2>
            <p>
              A previous snapshot exists, but AwardPing did not isolate reliable previous wording
              for this exact item. The text shown above is wording present in the later stored
              snapshot, not proof of a direct replacement.
            </p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function SupportingExcerptList({
  title,
  snippets,
  variant,
  emptyText,
}: {
  title: string;
  snippets: string[];
  variant: "added" | "removed";
  emptyText: string;
}) {
  return (
    <section className={`highlight-excerpt-list highlight-excerpt-list-${variant}`}>
      <h3>{title}</h3>
      {snippets.length > 0 ? (
        <ul>
          {snippets.map((snippet) => (
            <li key={snippet}>{snippet}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyText}</p>
      )}
    </section>
  );
}

function HighlightLoadIssue({ backHref }: { backHref: string }) {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="highlight-page mx-auto max-w-4xl px-5 py-12">
        <Link className="button-secondary highlight-back-link" href={backHref}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </Link>
        <section className="highlight-summary-panel highlight-status-panel">
          <h1 className="text-3xl font-black text-[var(--brand-dark)]">Highlight unavailable</h1>
          <p>
            AwardPing could not load the stored evidence for this update right now. The source page
            may still be available from the award record, and this view can be retried later.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

async function loadChange(kind: string, id: string) {
  if (kind === "shared") return loadSharedChange(id);
  if (kind === "office") return loadOfficeChange(id);
  notFound();
}

async function loadSharedChange(id: string): Promise<HighlightChange | null> {
  if (!hasSupabaseAdminConfig()) return null;

  const admin = createSupabaseAdminClient();
  const { data: change, error } = await withRetry("load shared highlight change", () =>
    admin
      .from("shared_award_change_events")
      .select(
        "id, shared_award_id, source_title, source_url, source_page_type, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at",
      )
      .eq("id", id)
      .maybeSingle(),
  );

  if (error) throw new Error(error.message);
  if (!change) return null;
  if (!isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type })) return null;

  const [{ data: award }, snapshotById] = await Promise.all([
    withRetry("load shared highlight award", () =>
      admin.from("shared_awards").select("id, name").eq("id", change.shared_award_id).maybeSingle(),
    ),
    fetchSharedSnapshotSamples(admin, [change.previous_snapshot_id, change.new_snapshot_id]),
  ]);

  return {
    kind: "shared",
    title: award?.name || change.source_title || "Shared award update",
    sourceTitle: change.source_title,
    sourceUrl: change.source_url,
    sourcePageType: change.source_page_type,
    summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
    changeDetails: change.change_details,
    detectedAt: change.detected_at,
    previousTextSample: change.previous_snapshot_id
      ? snapshotById.get(change.previous_snapshot_id) || null
      : null,
    newTextSample: change.new_snapshot_id ? snapshotById.get(change.new_snapshot_id) || null : null,
    backHref: "/award-directory",
  };
}

async function loadOfficeChange(id: string): Promise<HighlightChange | null> {
  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const supabase = await createSupabaseServerClient();
  const { data: change, error } = await withRetry("load office highlight change", () =>
    supabase
      .from("change_events")
      .select(
        "id, office_id, monitor_id, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at",
      )
      .eq("id", id)
      .eq("office_id", officeContext.current.officeId)
      .maybeSingle(),
  );

  if (error) throw new Error(error.message);
  if (!change) return null;

  const [{ data: monitor }, snapshotById] = await Promise.all([
    withRetry("load office highlight monitor", () =>
      supabase
        .from("monitors")
        .select("id, label, url, page_type")
        .eq("id", change.monitor_id)
        .eq("office_id", officeContext.current.officeId)
        .maybeSingle(),
    ),
    fetchOfficeSnapshotSamples(supabase, [change.previous_snapshot_id, change.new_snapshot_id]),
  ]);

  return {
    kind: "office",
    title: monitor?.label || "Office watchlist update",
    sourceTitle: monitor?.label || "Office watchlist page",
    sourceUrl: monitor?.url || null,
    sourcePageType: monitor?.page_type || null,
    summary: displayChangeSummary(change.summary, monitor?.url || null, change.change_details),
    changeDetails: change.change_details,
    detectedAt: change.detected_at,
    previousTextSample: change.previous_snapshot_id
      ? snapshotById.get(change.previous_snapshot_id) || null
      : null,
    newTextSample: change.new_snapshot_id ? snapshotById.get(change.new_snapshot_id) || null : null,
    backHref: "/dashboard",
  };
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

async function fetchSharedSnapshotSamples(
  admin: SupabaseAdminClient,
  ids: Array<string | null>,
) {
  const snapshotIds = ids.filter((snapshotId): snapshotId is string => Boolean(snapshotId));
  if (!snapshotIds.length) return new Map<string, string>();

  const { data, error } = await withRetry("load shared highlight snapshots", () =>
    admin
      .from("shared_award_source_snapshots")
      .select("id, text_sample")
      .in("id", snapshotIds),
  );

  if (error) throw new Error(error.message);
  return new Map((data || []).map((snapshot) => [snapshot.id, snapshot.text_sample]));
}

async function fetchOfficeSnapshotSamples(
  supabase: SupabaseServerClient,
  ids: Array<string | null>,
) {
  const snapshotIds = ids.filter((snapshotId): snapshotId is string => Boolean(snapshotId));
  if (!snapshotIds.length) return new Map<string, string>();

  const { data, error } = await withRetry("load office highlight snapshots", () =>
    supabase
      .from("monitor_snapshots")
      .select("id, text_sample")
      .in("id", snapshotIds),
  );

  if (error) throw new Error(error.message);
  return new Map((data || []).map((snapshot) => [snapshot.id, snapshot.text_sample]));
}


async function withRetry<Result>(label: string, fn: () => PromiseLike<Result>) {
  let lastError: unknown;
  const attempts = 2;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await withQueryTimeout(label, fn());
      const queryError = resultError(result);
      if (queryError) throw queryError;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 350));
    }
  }

  logHighlightLoadIssue(`${label} failed`, lastError);
  throw lastError;
}

function withQueryTimeout<Result>(label: string, query: PromiseLike<Result>) {
  return Promise.race([
    query,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 5000);
    }),
  ]);
}

function logHighlightLoadIssue(message: string, error: unknown) {
  if (process.env.NODE_ENV === "production") {
    console.error(message, error);
  }
}


function resultError(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error) return null;
  if (error instanceof Error) return error;
  if (typeof error === "object" && error && "message" in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(String(error));
}

function HighlightedSnapshot({
  title,
  text,
  candidates,
  variant,
  marker,
}: {
  title: string;
  text: string | null;
  candidates: string[];
  variant: "added" | "removed";
  marker?: SnapshotMarker | null;
}) {
  const clean = normalizeSnapshotText(text || "");
  const match = findHighlightMatch(clean, candidates);
  const markerExcerpt = marker ? snapshotMarkerExcerpt(clean, marker.index) : null;

  return (
    <section className="highlight-snapshot">
      <h2>{title}</h2>
      {!clean ? (
        <p className="highlight-note">No stored snapshot text is available for this side.</p>
      ) : match ? (
        <FormattedSnapshotText
          text={`${match.prefix}${match.before}${match.match}${match.after}${match.suffix}`}
          highlightStart={match.prefix.length + match.before.length}
          highlightEnd={match.prefix.length + match.before.length + match.match.length}
          variant={variant}
        />
      ) : marker && markerExcerpt ? (
        <FormattedSnapshotText
          text={markerExcerpt.text}
          insertionIndex={markerExcerpt.index}
          insertionLabel={marker.label}
          variant={variant}
        />
      ) : candidates.length === 0 ? (
        <FormattedSnapshotText text={truncateSnapshot(clean, 4200)} variant={variant} />
      ) : (
        <>
          <p className="highlight-note">
            AwardPing could not place the isolated snippet inside this stored excerpt. The stored
            snapshot is shown for context only.
          </p>
          <FormattedSnapshotText text={truncateSnapshot(clean, 4200)} variant={variant} />
        </>
      )}
    </section>
  );
}

function FormattedSnapshotText({
  text,
  highlightStart,
  highlightEnd,
  insertionIndex,
  insertionLabel,
  variant,
}: {
  text: string;
  highlightStart?: number;
  highlightEnd?: number;
  insertionIndex?: number;
  insertionLabel?: string;
  variant: "added" | "removed";
}) {
  const clean = text.trim();
  const ranges = snapshotParagraphRanges(clean, highlightStart, highlightEnd);
  const insertionRangeIndex =
    insertionIndex === undefined
      ? -1
      : ranges.findIndex((range) => insertionIndex >= range.start && insertionIndex <= range.end);

  return (
    <div className="highlight-snapshot-text">
      {ranges.map((range, index) => {
        const rangeInsertionIndex = index === insertionRangeIndex ? insertionIndex : undefined;
        return (
          <p key={`${range.start}-${range.end}-${index}`}>
            {renderSnapshotRange({
              text: clean,
              start: range.start,
              end: range.end,
              highlightStart,
              highlightEnd,
              insertionIndex: rangeInsertionIndex,
              insertionLabel,
              variant,
            })}
          </p>
        );
      })}
    </div>
  );
}

function renderSnapshotRange({
  text,
  start,
  end,
  highlightStart,
  highlightEnd,
  insertionIndex,
  insertionLabel,
  variant,
}: {
  text: string;
  start: number;
  end: number;
  highlightStart?: number;
  highlightEnd?: number;
  insertionIndex?: number;
  insertionLabel?: string;
  variant: "added" | "removed";
}) {
  const decorations: Array<
    | { type: "highlight"; start: number; end: number }
    | { type: "insertion"; start: number; end: number }
  > = [];

  if (
    highlightStart !== undefined &&
    highlightEnd !== undefined &&
    highlightEnd > start &&
    highlightStart < end
  ) {
    decorations.push({
      type: "highlight",
      start: Math.max(start, highlightStart),
      end: Math.min(end, highlightEnd),
    });
  }

  if (insertionIndex !== undefined && insertionIndex >= start && insertionIndex <= end) {
    decorations.push({ type: "insertion", start: insertionIndex, end: insertionIndex });
  }

  if (decorations.length === 0) return text.slice(start, end);

  decorations.sort((left, right) => left.start - right.start || left.end - right.end);
  const nodes: ReactNode[] = [];
  let cursor = start;

  for (const decoration of decorations) {
    if (decoration.start > cursor) {
      nodes.push(text.slice(cursor, decoration.start));
    }

    if (decoration.type === "insertion") {
      nodes.push(
        <span className="highlight-insertion-marker" key={`marker-${decoration.start}`}>
          {insertionLabel || "Inserted here"}
        </span>,
      );
      continue;
    }

    nodes.push(
      <mark
        className={`highlight-match highlight-match-${variant}`}
        key={`mark-${decoration.start}-${decoration.end}`}
      >
        {text.slice(decoration.start, decoration.end)}
      </mark>,
    );
    cursor = Math.max(cursor, decoration.end);
  }

  if (cursor < end) nodes.push(text.slice(cursor, end));
  return <>{nodes}</>;
}

type SnapshotParagraphRange = {
  start: number;
  end: number;
};

type SnapshotMarker = {
  index: number;
  label: string;
};

function snapshotParagraphRanges(
  text: string,
  highlightStart: number | undefined,
  highlightEnd: number | undefined,
): SnapshotParagraphRange[] {
  if (!text) return [];
  const breaks = new Set([0, text.length]);
  const protectedRange =
    highlightStart !== undefined && highlightEnd !== undefined
      ? { start: highlightStart, end: highlightEnd }
      : null;

  for (const index of structuralSnapshotBreaks(text)) {
    if (index > 0 && index < text.length && !insideRange(index, protectedRange)) {
      breaks.add(index);
    }
  }

  for (const index of sentenceSnapshotBreaks(text, breaks, protectedRange)) {
    if (index > 0 && index < text.length && !insideRange(index, protectedRange)) {
      breaks.add(index);
    }
  }

  const sortedBreaks = [...breaks].sort((left, right) => left - right);
  return sortedBreaks
    .slice(0, -1)
    .map((start, index) => trimRange(text, start, sortedBreaks[index + 1]))
    .filter((range) => range.end > range.start);
}

function structuralSnapshotBreaks(text: string) {
  const breaks: number[] = [];
  const contentStart = snapshotContentStartIndex(text);
  const headingPattern =
    /\s+(How to Apply|Applying for [A-Z][^.]{0,120}|Before you Apply|Before Applying|Rules and Guidance|How to submit an application|Your Completed Application|Completing Your Application|Submitting Your Application|Application Overview|Application Requirements|Selection Criteria|Eligibility Requirements|Eligibility|Deadlines?|Timeline|Recommendation Guidance|Information for Recommenders|Institutional Advisors|Transcripts?|Essays?|Interviews?|Course Search|Frequently Asked Questions|FAQs?|Award Amount|Funding|Program Overview|Contact Information|Additional Information)\b/g;
  for (const match of text.matchAll(headingPattern)) {
    if (match.index !== undefined && match.index + 1 >= contentStart) {
      breaks.push(match.index + 1);
    }
  }

  const navigationBoundary = /\b(Open Search|Read updates from the Commission Open Search)\s+/g;
  for (const match of text.matchAll(navigationBoundary)) {
    if (match.index !== undefined) breaks.push(match.index + match[0].length);
  }

  return breaks;
}

function snapshotContentStartIndex(text: string) {
  const navigationBoundary = /\b(Open Search|Read updates from the Commission Open Search)\s+/g;
  let index = 0;
  for (const match of text.matchAll(navigationBoundary)) {
    if (match.index !== undefined) index = match.index + match[0].length;
  }
  return index;
}

function sentenceSnapshotBreaks(
  text: string,
  existingBreaks: Set<number>,
  protectedRange: SnapshotParagraphRange | null,
) {
  const breaks: number[] = [];
  const sortedBreaks = [...existingBreaks].sort((left, right) => left - right);
  let paragraphStart = 0;
  const sentenceBoundary = /[.!?]\s+(?=[A-Z0-9"“])/g;

  for (const match of text.matchAll(sentenceBoundary)) {
    if (match.index === undefined) continue;
    const breakIndex = match.index + match[0].length;
    const nextStructuralBreak = sortedBreaks.find((index) => index > paragraphStart);
    const maxEnd = nextStructuralBreak || text.length;

    if (breakIndex >= maxEnd) {
      paragraphStart = maxEnd;
      continue;
    }

    if (breakIndex - paragraphStart >= 460 && !insideRange(breakIndex, protectedRange)) {
      breaks.push(breakIndex);
      paragraphStart = breakIndex;
    }
  }

  return breaks;
}

function insideRange(index: number, range: SnapshotParagraphRange | null) {
  return Boolean(range && index > range.start && index < range.end);
}

function trimRange(text: string, start: number, end: number) {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/.test(text[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1])) nextEnd -= 1;
  return { start: nextStart, end: nextEnd };
}

function findHighlightMatch(text: string, candidates: string[]) {
  for (const candidate of candidates) {
    const cleanCandidate = cleanHighlightCandidate(candidate);
    if (cleanCandidate.length < 8) continue;

    const searches = uniqueCandidates([
      cleanCandidate,
      cleanCandidate.slice(0, 220),
      cleanCandidate.slice(0, 140),
      cleanCandidate.slice(0, 90),
    ]).filter((value) => value.length >= 8);

    for (const search of searches) {
      const index = text.toLowerCase().indexOf(search.toLowerCase());
      if (index !== -1) return snapshotExcerpt(text, index, search.length);
    }
  }

  return null;
}

function snapshotExcerpt(text: string, index: number, length: number) {
  const radius = 1200;
  const highlight = expandHighlightToWordBoundaries(text, index, index + length);
  const start = Math.max(0, highlight.start - radius);
  const end = Math.min(text.length, highlight.end + radius);

  return {
    prefix: start > 0 ? "... " : "",
    before: text.slice(start, highlight.start),
    match: text.slice(highlight.start, highlight.end),
    after: text.slice(highlight.end, end),
    suffix: end < text.length ? " ..." : "",
  };
}

function expandHighlightToWordBoundaries(text: string, start: number, end: number) {
  let expandedStart = Math.max(0, Math.min(start, text.length));
  let expandedEnd = Math.max(expandedStart, Math.min(end, text.length));

  while (
    expandedStart > 0 &&
    isWordCharacter(text[expandedStart - 1]) &&
    isWordCharacter(text[expandedStart])
  ) {
    expandedStart -= 1;
  }

  while (
    expandedEnd < text.length &&
    isWordCharacter(text[expandedEnd - 1]) &&
    isWordCharacter(text[expandedEnd])
  ) {
    expandedEnd += 1;
  }

  return { start: expandedStart, end: expandedEnd };
}

function isWordCharacter(value: string | undefined) {
  return Boolean(value && /[A-Za-z0-9]/.test(value));
}

function findInsertionMarker(
  previousText: string | null,
  nextText: string | null,
  addedCandidates: string[],
  label: string,
): SnapshotMarker | null {
  const previousClean = normalizeSnapshotText(previousText || "");
  const nextClean = normalizeSnapshotText(nextText || "");
  if (!previousClean || !nextClean || addedCandidates.length === 0) return null;

  const addedMatch = findCandidateIndex(nextClean, addedCandidates);
  if (!addedMatch) return null;

  const index = insertionIndexForAddedText(
    previousClean,
    nextClean,
    addedMatch.index,
    addedMatch.length,
  );
  return index === null ? null : { index, label };
}

function findCandidateIndex(text: string, candidates: string[]) {
  for (const candidate of candidates) {
    const cleanCandidate = cleanHighlightCandidate(candidate);
    if (cleanCandidate.length < 8) continue;

    const searches = uniqueCandidates([
      cleanCandidate,
      cleanCandidate.slice(0, 220),
      cleanCandidate.slice(0, 140),
      cleanCandidate.slice(0, 90),
    ]).filter((value) => value.length >= 8);

    for (const search of searches) {
      const index = indexOfInsensitive(text, search);
      if (index !== -1) return { index, length: search.length };
    }
  }

  return null;
}

function indexOfInsensitive(text: string, search: string) {
  return text.toLowerCase().indexOf(search.toLowerCase());
}

function snapshotMarkerExcerpt(text: string, index: number) {
  const radius = 1200;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";

  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    index: prefix.length + index - start,
  };
}

function uniqueCandidates(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => normalizeSnapshotText(value || "")).filter(Boolean))];
}

function cleanHighlightCandidate(value: string) {
  return normalizeSnapshotText(value)
    .replace(/^['"“”]+|['"“”]+$/g, "")
    .replace(/\.\.\.$/, "")
    .trim();
}

function normalizeSnapshotText(value: string) {
  return cleanDisplayText(value).replace(/\s+/g, " ").trim();
}

function truncateSnapshot(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()} ...`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
