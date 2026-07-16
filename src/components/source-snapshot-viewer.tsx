"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  ExternalLink,
  FileText,
  ImageIcon,
  LoaderCircle,
  X,
} from "lucide-react";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { formatCentralDateTime } from "@/lib/time-zone";

type SnapshotObject = {
  key: string;
  url: string;
  content_type?: string | null;
  width?: number | null;
  height?: number | null;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

type SnapshotSide = {
  captured_at: string | null;
  focus_ratio?: number | null;
  exact_overlap?: boolean;
  localization_status?: string | null;
  localization_reason?: string | null;
  kind?: "webpage" | "image" | "pdf" | string;
  objects: Record<string, SnapshotObject>;
};

type SourceSnapshotResponse = {
  change_event_id?: string | null;
  evidence_scope?: "change_event" | "source_current";
  evidence_status?: string | null;
  localization_direction?:
    | "added"
    | "removed"
    | "changed"
    | "mixed"
    | "previous"
    | "current"
    | "both"
    | "none";
  source_url: string;
  source_title: string | null;
  source_page_type: string | null;
  expires_in_seconds: number;
  latest: SnapshotSide;
  previous: SnapshotSide;
};

type SnapshotVersion = "latest" | "previous";

export function SourceSnapshotViewerButton({
  changeEventId,
  changeDetectedAt,
  changeDetails,
  changeSummary,
  sourceId,
  sourceTitle,
  sourceUrl,
  sourcePageTypeLabel,
}: {
  changeEventId?: string | null;
  sourceId: string | null | undefined;
  sourceTitle: string;
  sourceUrl: string;
  sourcePageTypeLabel?: string | null;
  changeSummary?: string | null;
  changeDetails?: unknown;
  changeDetectedAt?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SourceSnapshotResponse | null>(null);
  const [activeVersion, setActiveVersion] = useState<SnapshotVersion>("latest");

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const activeSnapshot = snapshot?.[activeVersion] || null;
  const canShowPrevious = Boolean(snapshot && hasSnapshotObjects(snapshot.previous));
  const evidence = useMemo(
    () =>
      buildChangeEvidence({
        sourceUrl,
        sourceTitle,
        summary: changeSummary,
        changeDetails,
      }),
    [changeDetails, changeSummary, sourceTitle, sourceUrl],
  );
  const hasEvidencePanel = Boolean(
    changeSummary ||
      changeDetectedAt ||
      evidence.currentSnippets.length ||
      evidence.previousSnippets.length ||
      evidence.confidenceLabel,
  );

  async function openViewer() {
    const requestPath = snapshotRequestPath(sourceId, evidence, changeEventId);
    if (!requestPath) return;

    setOpen(true);
    setLoading(true);
    setError(null);
    setActiveVersion("latest");

    try {
      const response = await fetch(requestPath, {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | SourceSnapshotResponse
        | null;

      if (!response.ok) {
        setSnapshot(null);
        setError(body && "error" in body && body.error ? body.error : "Snapshot unavailable.");
        return;
      }

      const loaded = body as SourceSnapshotResponse;
      setSnapshot(loaded);
      if (
        (snapshotInitialVersion(loaded.localization_direction) === "previous" ||
          !hasSnapshotObjects(loaded.latest)) &&
        hasSnapshotObjects(loaded.previous)
      ) {
        setActiveVersion("previous");
      }
    } catch {
      setSnapshot(null);
      setError("Snapshot unavailable.");
    } finally {
      setLoading(false);
    }
  }

  if (!sourceId && !changeEventId) return null;

  return (
    <>
      <button
        className="button-secondary source-snapshot-trigger px-3 py-2 text-sm"
        type="button"
        onClick={openViewer}
      >
        <ImageIcon size={14} aria-hidden="true" />
        Snapshot
      </button>

      {open && (
        <div
          className="source-snapshot-backdrop"
          role="presentation"
          onMouseDown={() => setOpen(false)}
        >
          <section
            aria-label={`${sourceTitle} snapshot`}
            aria-modal="true"
            className="source-snapshot-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="source-snapshot-header">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {sourcePageTypeLabel && <span className="badge">{sourcePageTypeLabel}</span>}
                  {activeSnapshot?.captured_at && (
                    <span className="source-snapshot-captured">
                      <Clock3 size={13} aria-hidden="true" />
                      {formatSnapshotDate(activeSnapshot.captured_at)}
                    </span>
                  )}
                </div>
                <h2 className="source-snapshot-title">{snapshot?.source_title || sourceTitle}</h2>
                <a
                  className="source-snapshot-source-link"
                  href={snapshot?.source_url || sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  {snapshot?.source_url || sourceUrl}
                </a>
              </div>

              <button
                aria-label="Close snapshot viewer"
                className="source-snapshot-close"
                type="button"
                onClick={() => setOpen(false)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {hasEvidencePanel && (
              <SnapshotEvidencePanel
                detectedAt={changeDetectedAt}
                evidence={evidence}
                summary={changeSummary}
              />
            )}

            <SnapshotBody
              activeSnapshot={activeSnapshot}
              error={error}
              loading={loading}
              canShowPrevious={canShowPrevious}
              firstObservation={evidence.isFirstObservation}
              onVersionChange={setActiveVersion}
              evidenceScope={snapshot?.evidence_scope || "source_current"}
              title={snapshot?.source_title || sourceTitle}
              version={activeVersion}
            />
          </section>
        </div>
      )}
    </>
  );
}

export function SourceSnapshotInlinePreview({
  changeEventId,
  changeDetails,
  changeSummary,
  sourceId,
  sourceTitle,
  sourceUrl,
}: {
  changeEventId?: string | null;
  sourceId: string | null | undefined;
  sourceTitle: string;
  sourceUrl: string;
  changeSummary?: string | null;
  changeDetails?: unknown;
}) {
  const [snapshotState, setSnapshotState] = useState<{
    requestPath: string;
    snapshot: SourceSnapshotResponse | null;
  } | null>(null);
  const evidence = useMemo(
    () =>
      buildChangeEvidence({
        sourceUrl,
        sourceTitle,
        summary: changeSummary,
        changeDetails,
      }),
    [changeDetails, changeSummary, sourceTitle, sourceUrl],
  );
  const requestPath = useMemo(
    () => snapshotRequestPath(sourceId, evidence, changeEventId),
    [changeEventId, evidence, sourceId],
  );
  const snapshot = snapshotState?.requestPath === requestPath
    ? snapshotState.snapshot
    : null;
  const requestFinished = snapshotState?.requestPath === requestPath;

  useEffect(() => {
    if (!requestPath) return;

    const controller = new AbortController();

    fetch(requestPath, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | SourceSnapshotResponse
          | { error?: string }
          | null;

        if (!response.ok || !isSourceSnapshotResponse(body)) {
          setSnapshotState({ requestPath, snapshot: null });
          return;
        }

        setSnapshotState({ requestPath, snapshot: body });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSnapshotState({ requestPath, snapshot: null });
        }
      });

    return () => controller.abort();
  }, [requestPath]);

  if ((!sourceId && !changeEventId) || !requestPath) return null;

  if (!requestFinished) {
    return (
      <div className="source-snapshot-inline source-snapshot-inline-state">
        <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
        Loading screenshot preview...
      </div>
    );
  }

  if (
    !snapshot ||
    (!hasSnapshotObjects(snapshot.latest) && !hasSnapshotObjects(snapshot.previous))
  ) {
    return (
      <div className="source-snapshot-inline source-snapshot-inline-state">
        <ImageIcon size={16} aria-hidden="true" />
        {changeEventId
          ? "Exact visual evidence is unavailable for this update."
          : "Screenshot preview not captured yet."}
      </div>
    );
  }

  return (
    <SnapshotInlineBody
      key={requestPath}
      firstObservation={evidence.isFirstObservation}
      snapshot={snapshot}
      title={snapshot.source_title || sourceTitle}
    />
  );
}

function SnapshotEvidencePanel({
  detectedAt,
  evidence,
  summary,
}: {
  detectedAt?: string | null;
  evidence: ReturnType<typeof buildChangeEvidence>;
  summary?: string | null;
}) {
  return (
    <aside
      className="source-snapshot-evidence"
      aria-label={
        evidence.isFirstObservation
          ? "Selected first-observation evidence"
          : "Selected change evidence"
      }
    >
      <div className="source-snapshot-evidence-heading">
        <div>
          <p>{evidence.isFirstObservation ? "Selected first observation" : "Selected change"}</p>
          <h3>{evidence.changeTypeLabel || "Source update"}</h3>
        </div>
        <div className="source-snapshot-evidence-badges">
          {evidence.confidenceLabel && <span>{evidence.confidenceLabel}</span>}
          {detectedAt && (
            <span>
              {evidence.isFirstObservation ? "Update recognized " : ""}
              {formatSnapshotDate(detectedAt)}
            </span>
          )}
        </div>
      </div>
      <p className="source-snapshot-evidence-summary">
        {evidence.summarySnippet ||
          summary ||
          (evidence.isFirstObservation
            ? "AwardPing first observed this official document."
            : "AwardPing detected a meaningful source-page change.")}
      </p>
      {evidence.isFirstObservation && evidence.currentSnippets.length > 0 ? (
        <div className="source-snapshot-evidence-grid">
          <div>
            <strong>Wording in the document</strong>
            <p>{evidence.currentSnippets[0] || evidence.afterSnippet}</p>
          </div>
        </div>
      ) : (evidence.previousSnippets.length > 0 || evidence.currentSnippets.length > 0) && (
        <div className="source-snapshot-evidence-grid">
          <div>
            <strong>Previous</strong>
            <p>{evidence.previousSnippets[0] || evidence.beforeSnippet || "No previous wording stored."}</p>
          </div>
          <div>
            <strong>Current</strong>
            <p>{evidence.currentSnippets[0] || evidence.afterSnippet || "No current wording stored."}</p>
          </div>
        </div>
      )}
      {evidence.isFirstObservation && (
        <p className="source-snapshot-evidence-summary">
          No prior version is asserted; this is AwardPing&apos;s first retained observation.
        </p>
      )}
    </aside>
  );
}

function SnapshotTab({
  active,
  disabled = false,
  label,
  onSelect,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onSelect: () => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }

  return (
    <button
      aria-selected={active}
      className="source-snapshot-tab"
      disabled={disabled}
      role="tab"
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {label}
    </button>
  );
}

function SnapshotBody({
  activeSnapshot,
  canShowPrevious,
  evidenceScope,
  error,
  firstObservation,
  loading,
  onVersionChange,
  title,
  version,
}: {
  activeSnapshot: SnapshotSide | null;
  canShowPrevious: boolean;
  evidenceScope: "change_event" | "source_current";
  error: string | null;
  firstObservation: boolean;
  loading: boolean;
  onVersionChange: (version: SnapshotVersion) => void;
  title: string;
  version: SnapshotVersion;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const primaryObject = useMemo(
    () => selectPrimarySnapshotObject(activeSnapshot),
    [activeSnapshot],
  );
  const focusRatio = typeof activeSnapshot?.focus_ratio === "number"
    ? activeSnapshot.focus_ratio
    : null;

  useEffect(() => {
    scrollToFocusRatio(frameRef.current, imageRef.current, focusRatio);
  }, [focusRatio, primaryObject?.url, version]);

  if (loading) {
    return (
      <div className="source-snapshot-state">
        <LoaderCircle className="animate-spin" size={22} aria-hidden="true" />
        Loading snapshot...
      </div>
    );
  }

  if (error) {
    return <div className="source-snapshot-state source-snapshot-state-error">{error}</div>;
  }

  if (!activeSnapshot || !primaryObject) {
    return (
      <div className="source-snapshot-state">
        {version === "previous"
          ? "There is no previous snapshot for this page yet."
          : "No visual snapshot is available yet."}
      </div>
    );
  }

  if (primaryObject.kind === "pdf") {
    return (
      <div className="source-snapshot-frame" ref={frameRef}>
        <SnapshotFrameActions
          activeVersion={version}
          canShowPrevious={canShowPrevious}
          currentLabel={
            firstObservation ? "First observed" : evidenceScope === "change_event" ? "Current" : "Latest"
          }
          firstObservation={firstObservation}
          localizationLabel={snapshotLocalizationLabel(activeSnapshot, focusRatio, evidenceScope)}
          openLabel="Open PDF"
          openUrl={primaryObject.url}
          onVersionChange={onVersionChange}
        />
        <div className="source-snapshot-pdf">
          <FileText size={34} aria-hidden="true" />
          <div>
            <p className="source-snapshot-pdf-title">
              {firstObservation ? "First-observed PDF" : "PDF snapshot"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="source-snapshot-frame" ref={frameRef}>
      <SnapshotFrameActions
        activeVersion={version}
        canShowPrevious={canShowPrevious}
        currentLabel={
          firstObservation ? "First observed" : evidenceScope === "change_event" ? "Current" : "Latest"
        }
        firstObservation={firstObservation}
        localizationLabel={snapshotLocalizationLabel(activeSnapshot, focusRatio, evidenceScope)}
        openLabel="Open image"
        openUrl={primaryObject.url}
        onVersionChange={onVersionChange}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={`${title} ${version} snapshot`}
        className="source-snapshot-image"
        ref={imageRef}
        src={primaryObject.url}
        onLoad={() => scrollToFocusRatio(frameRef.current, imageRef.current, focusRatio)}
      />
    </div>
  );
}

function SnapshotInlineBody({
  firstObservation,
  snapshot,
  title,
}: {
  firstObservation: boolean;
  snapshot: SourceSnapshotResponse;
  title: string;
}) {
  const [activeVersion, setActiveVersion] = useState<SnapshotVersion>(
    snapshotInitialVersion(snapshot.localization_direction),
  );
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const latestAvailable = hasSnapshotObjects(snapshot.latest);
  const previousAvailable = hasSnapshotObjects(snapshot.previous);
  const resolvedVersion =
    activeVersion === "previous" && previousAvailable
      ? "previous"
      : latestAvailable
        ? "latest"
        : "previous";
  const activeSnapshot = snapshot[resolvedVersion];
  const primaryObject = useMemo(
    () => selectPrimarySnapshotObject(activeSnapshot),
    [activeSnapshot],
  );
  const focusRatio = typeof activeSnapshot?.focus_ratio === "number"
    ? activeSnapshot.focus_ratio
    : null;

  useEffect(() => {
    scrollToFocusRatio(frameRef.current, imageRef.current, focusRatio);
  }, [focusRatio, primaryObject?.url, resolvedVersion]);

  if (!primaryObject) return null;

  const openLabel = primaryObject.kind === "pdf" ? "Open PDF" : "Open image";

  return (
    <div className="source-snapshot-inline">
      <div className="source-snapshot-inline-actions">
        <div className="source-snapshot-version-control">
          <span>
            {snapshotLocalizationLabel(
              activeSnapshot,
              focusRatio,
              snapshot.evidence_scope || "source_current",
            )}
          </span>
          <div className="source-snapshot-tabs source-snapshot-inline-tabs" aria-label="Evidence version">
            <SnapshotTab
              active={resolvedVersion === "latest"}
              disabled={!latestAvailable}
              label={
                firstObservation
                  ? "First observed"
                  : snapshot.evidence_scope === "change_event"
                    ? "Current"
                    : "Latest"
              }
              onSelect={() => setActiveVersion("latest")}
            />
            {!firstObservation && (
              <SnapshotTab
                active={resolvedVersion === "previous"}
                disabled={!previousAvailable}
                label="Previous"
                onSelect={() => setActiveVersion("previous")}
              />
            )}
          </div>
        </div>
        <a href={primaryObject.url} rel="noreferrer" target="_blank">
          <ExternalLink size={13} aria-hidden="true" />
          {openLabel}
        </a>
      </div>

      {primaryObject.kind === "pdf" ? (
        <div className="source-snapshot-inline-pdf">
          <FileText size={22} aria-hidden="true" />
          {firstObservation ? "First-observed PDF available" : "PDF snapshot available"}
        </div>
      ) : (
        <div className="source-snapshot-inline-frame" ref={frameRef}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`${title} ${resolvedVersion} snapshot`}
            className="source-snapshot-inline-image"
            ref={imageRef}
            src={primaryObject.url}
            onLoad={() => scrollToFocusRatio(frameRef.current, imageRef.current, focusRatio)}
          />
        </div>
      )}
    </div>
  );
}

function SnapshotFrameActions({
  activeVersion,
  canShowPrevious,
  currentLabel,
  firstObservation,
  localizationLabel,
  openLabel,
  openUrl,
  onVersionChange,
}: {
  activeVersion: SnapshotVersion;
  canShowPrevious: boolean;
  currentLabel: string;
  firstObservation: boolean;
  localizationLabel: string;
  openLabel: string;
  openUrl: string;
  onVersionChange: (version: SnapshotVersion) => void;
}) {
  return (
    <div className="source-snapshot-frame-actions">
      <div className="source-snapshot-version-control">
        <span>{localizationLabel}</span>
        <div className="source-snapshot-tabs" aria-label="Evidence version">
          <SnapshotTab
            active={activeVersion === "latest"}
            label={currentLabel}
            onSelect={() => onVersionChange("latest")}
          />
          {!firstObservation && (
            <SnapshotTab
              active={activeVersion === "previous"}
              disabled={!canShowPrevious}
              label="Previous"
              onSelect={() => onVersionChange("previous")}
            />
          )}
        </div>
      </div>
      <a href={openUrl} rel="noreferrer" target="_blank">
        <ExternalLink size={14} aria-hidden="true" />
        {openLabel}
      </a>
    </div>
  );
}

export function snapshotRequestPath(
  sourceId: string | null | undefined,
  evidence: ReturnType<typeof buildChangeEvidence>,
  changeEventId?: string | null,
) {
  if (changeEventId) {
    return `/api/change-events/${encodeURIComponent(changeEventId)}/visual-evidence`;
  }
  if (!sourceId) return null;
  const params = new URLSearchParams();
  for (const snippet of snapshotFocusSnippets("latest", evidence)) {
    params.append("latest", snippet);
  }
  for (const snippet of snapshotFocusSnippets("previous", evidence)) {
    params.append("previous", snippet);
  }
  const query = params.toString();
  return `/api/source-snapshots/${encodeURIComponent(sourceId)}${query ? `?${query}` : ""}`;
}

function snapshotFocusSnippets(version: SnapshotVersion, evidence: ReturnType<typeof buildChangeEvidence>) {
  const snippets = version === "latest"
    ? [evidence.afterSnippet, ...evidence.currentSnippets]
    : [evidence.beforeSnippet, ...evidence.previousSnippets];
  return uniqueStrings(
    snippets
      .filter((snippet): snippet is string => Boolean(snippet))
      .map((snippet) => snippet.replace(/\s+/g, " ").trim())
      .filter((snippet) => snippet.length >= 8)
      .map((snippet) => snippet.slice(0, 220)),
  ).slice(0, 4);
}

function scrollToFocusRatio(
  frame: HTMLDivElement | null,
  image: HTMLImageElement | null,
  focusRatio: number | null,
) {
  if (!frame || !image) return;

  if (focusRatio === null || !Number.isFinite(focusRatio)) {
    frame.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  window.requestAnimationFrame(() => {
    const imageTop = image.offsetTop;
    const imageHeight = image.clientHeight;
    if (!imageHeight) return;
    const targetTop = imageTop + imageHeight * Math.max(0, Math.min(1, focusRatio));
    frame.scrollTo({
      top: Math.max(0, targetTop - frame.clientHeight * 0.35),
      behavior: "auto",
    });
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

export function selectPrimarySnapshotObject(snapshot: SnapshotSide | null) {
  if (!snapshot) return null;
  if (snapshot.exact_overlap && snapshot.objects.crop) {
    return { kind: "image" as const, evidenceKind: "verified_crop" as const, ...snapshot.objects.crop };
  }
  if (snapshot.objects.full) {
    const kind = snapshot.kind === "pdf" || snapshot.objects.full.content_type?.includes("pdf")
      ? "pdf" as const
      : "image" as const;
    return { kind, evidenceKind: "event_full" as const, ...snapshot.objects.full };
  }
  if (snapshot.objects.page) return { kind: "image" as const, ...snapshot.objects.page };
  if (snapshot.objects.thumb) return { kind: "image" as const, ...snapshot.objects.thumb };
  if (snapshot.objects.pdf) return { kind: "pdf" as const, ...snapshot.objects.pdf };
  return null;
}

export function snapshotInitialVersion(
  direction: SourceSnapshotResponse["localization_direction"],
): SnapshotVersion {
  return direction === "removed" || direction === "previous" ? "previous" : "latest";
}

function hasSnapshotObjects(snapshot: SnapshotSide) {
  return Boolean(selectPrimarySnapshotObject(snapshot));
}

function isSourceSnapshotResponse(value: unknown): value is SourceSnapshotResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      "latest" in value &&
      "previous" in value &&
      "source_url" in value,
  );
}

function formatSnapshotDate(value: string) {
  return formatCentralDateTime(value);
}

export function snapshotLocalizationLabel(
  snapshot: SnapshotSide | null,
  focusRatio: number | null,
  evidenceScope: "change_event" | "source_current" = "source_current",
) {
  if (evidenceScope === "change_event") {
    if (snapshot?.kind === "pdf") {
      const reason = String(snapshot.localization_reason || "").trim();
      return reason ? `Immutable event PDF - ${reason}` : "Immutable event PDF";
    }
    if (snapshot?.exact_overlap && snapshot.objects.crop) return "Verified exact change area";
    const reason = String(snapshot?.localization_reason || "").trim();
    if (reason) return `Full event screenshot - ${reason}`;
    return "Full event screenshot - exact change location unavailable";
  }
  if (focusRatio !== null) return "Approximate text match in this retained source snapshot";
  switch (snapshot?.localization_status) {
    case "historical_layout_unavailable":
      return "Historical screenshot has no location data";
    case "capture_layout_unavailable":
      return "Screenshot has no usable page layout";
    case "evidence_not_found":
      return "Changed text not found in this screenshot";
    case "not_requested":
      return "No exact change text available";
    case "not_applicable":
      return "Screenshot location unavailable";
    default:
      return "Screenshot localization pending";
  }
}
