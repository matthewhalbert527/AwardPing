"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  ExternalLink,
  FileText,
  ImageIcon,
  LoaderCircle,
  X,
} from "lucide-react";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY } from "@/lib/change-details";
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

type SnapshotLoadOutcome =
  | { kind: "snapshot"; snapshot: SourceSnapshotResponse }
  | { kind: "unavailable" }
  | { kind: "failed" };

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function dialogFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.tabIndex >= 0,
  );
}

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
  const requestPath = snapshotRequestPath(sourceId, evidence, changeEventId);
  if (!requestPath) return null;

  // The selected-detail panel can reuse this button for another event/source.
  // A different request must start a fresh, closed modal session.
  return (
    <SnapshotViewerSession
      key={requestPath}
      changeDetectedAt={changeDetectedAt}
      changeSummary={changeSummary}
      evidence={evidence}
      requestPath={requestPath}
      sourcePageTypeLabel={sourcePageTypeLabel}
      sourceTitle={sourceTitle}
      sourceUrl={sourceUrl}
    />
  );
}

function SnapshotViewerSession({
  changeDetectedAt,
  changeSummary,
  evidence,
  requestPath,
  sourcePageTypeLabel,
  sourceTitle,
  sourceUrl,
}: {
  changeDetectedAt?: string | null;
  changeSummary?: string | null;
  evidence: ReturnType<typeof buildChangeEvidence>;
  requestPath: string;
  sourcePageTypeLabel?: string | null;
  sourceTitle: string;
  sourceUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SourceSnapshotResponse | null>(null);
  const [activeVersion, setActiveVersion] = useState<SnapshotVersion>("latest");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const closeViewer = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setOpen(false);
    setLoading(false);
  }, []);

  // Separate from focus cleanup: a rapid close/reopen may already own a new
  // request by the time the old focus effect is cleaned up.
  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;

    const focusReturnTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    closeButtonRef.current?.focus();

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeViewer();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialogFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (focusReturnTarget?.isConnected) focusReturnTarget.focus();
    };
  }, [closeViewer, open]);

  const activeSnapshot = snapshot?.[activeVersion] || null;
  const canShowPrevious = Boolean(snapshot && hasSnapshotObjects(snapshot.previous));
  const hasEvidencePanel = Boolean(
    changeSummary ||
      changeDetectedAt ||
      evidence.currentSnippets.length ||
      evidence.previousSnippets.length ||
      evidence.confidenceLabel,
  );

  async function openViewer() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setOpen(true);
    setLoading(true);
    setError(null);
    setActiveVersion("latest");
    setSnapshot(null);

    let settled: SnapshotLoadOutcome;
    try {
      const response = await fetch(requestPath, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        // These statuses can conceal access/identity failures, not absence.
        // Never show the routes' internal diagnostic messages.
        settled = [401, 403, 404].includes(response.status)
          ? { kind: "unavailable" }
          : { kind: "failed" };
      } else {
        const body: unknown = await response.json();
        settled = isSourceSnapshotResponse(body)
          ? { kind: "snapshot", snapshot: body }
          : { kind: "failed" };
      }
    } catch {
      settled = { kind: "failed" };
    }

    // Reopening the same URL still creates a new owner. Ignore late fetch/JSON
    // completions after close, unmount or supersession, even if abort is ignored.
    if (requestRef.current !== controller || controller.signal.aborted) return;

    if (settled.kind === "snapshot") {
      const loaded = settled.snapshot;
      setSnapshot(loaded);
      if (
        (snapshotInitialVersion(loaded.localization_direction) === "previous" ||
          !hasSnapshotObjects(loaded.latest)) &&
        hasSnapshotObjects(loaded.previous)
      ) {
        setActiveVersion("previous");
      }
    } else {
      setSnapshot(null);
      setError(settled.kind === "unavailable"
        ? "This screenshot evidence is not available."
        : "Screenshot evidence could not be loaded right now.");
    }
    setLoading(false);
  }

  return (
    <>
      <button
        className="button-secondary source-snapshot-trigger px-3 py-2 text-sm"
        ref={triggerRef}
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
          onMouseDown={(event) => {
            event.preventDefault();
            closeViewer();
          }}
        >
          <section
            aria-label={`${sourceTitle} snapshot`}
            aria-modal="true"
            className="source-snapshot-dialog"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
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
                ref={closeButtonRef}
                type="button"
                onClick={closeViewer}
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
              evidenceStatus={snapshot?.evidence_status || null}
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
    request: { path: string };
    outcome: SnapshotLoadOutcome;
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
  // Returning to the same URL starts a new request, not a reuse of an older
  // result. The identity changes only when the requested path changes.
  const request = useMemo(() => requestPath ? { path: requestPath } : null, [requestPath]);
  const outcome = snapshotState?.request === request
    ? snapshotState.outcome
    : null;
  const snapshot = outcome?.kind === "snapshot" ? outcome.snapshot : null;

  useEffect(() => {
    if (!request) return;
    const activeRequest = request;

    const controller = new AbortController();

    async function loadSnapshot() {
      let settled: SnapshotLoadOutcome;
      try {
        const response = await fetch(activeRequest.path, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          // Both endpoints also use 404 to conceal access/identity failures.
          // These statuses say nothing about whether an archive exists.
          settled = [401, 403, 404].includes(response.status)
            ? { kind: "unavailable" }
            : { kind: "failed" };
        } else {
          const body: unknown = await response.json();
          settled = isSourceSnapshotResponse(body)
            ? { kind: "snapshot", snapshot: body }
            : { kind: "failed" };
        }
      } catch {
        settled = { kind: "failed" };
      }

      // Fetch/JSON can settle after cleanup, including non-OK responses and
      // promises whose mocks or underlying transport do not honor abort.
      if (!controller.signal.aborted) {
        setSnapshotState({ request: activeRequest, outcome: settled });
      }
    }

    void loadSnapshot();

    return () => controller.abort();
  }, [request]);

  if ((!sourceId && !changeEventId) || !requestPath) return null;

  if (!outcome) {
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
        {outcome.kind === "failed"
          ? "Screenshot evidence could not be loaded right now."
          : outcome.kind === "unavailable"
          ? "This screenshot evidence is not available."
          : changeEventId
          ? snapshotUnavailableMessage(snapshot)
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
            ? FIRST_OBSERVED_OFFICIAL_DOCUMENT_SUMMARY
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
  evidenceStatus,
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
  evidenceStatus: string | null;
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
        {evidenceStatus === "historical_artifact_unrecoverable"
          ? snapshotUnavailableMessage({ evidence_status: evidenceStatus })
          : version === "previous"
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
  return isSnapshotRecord(value)
    && typeof value.source_url === "string"
    && isNullableSnapshotString(value.source_title)
    && isNullableSnapshotString(value.source_page_type)
    && typeof value.expires_in_seconds === "number"
    && Number.isFinite(value.expires_in_seconds)
    && (value.change_event_id === undefined || isNullableSnapshotString(value.change_event_id))
    && (value.evidence_scope === undefined || value.evidence_scope === "change_event" || value.evidence_scope === "source_current")
    && (value.evidence_status === undefined || isNullableSnapshotString(value.evidence_status))
    && (value.localization_direction === undefined || (typeof value.localization_direction === "string" && ["added", "removed", "changed", "mixed", "previous", "current", "both", "none"].includes(value.localization_direction)))
    && isSnapshotSide(value.latest)
    && isSnapshotSide(value.previous);
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableSnapshotString(value: unknown) {
  return value === null || typeof value === "string";
}

function isOptionalSnapshotNumber(value: unknown) {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isSnapshotSide(value: unknown): value is SnapshotSide {
  return isSnapshotRecord(value)
    && isNullableSnapshotString(value.captured_at)
    && (value.kind === undefined || typeof value.kind === "string")
    && (value.exact_overlap === undefined || typeof value.exact_overlap === "boolean")
    && isOptionalSnapshotNumber(value.focus_ratio)
    && (value.localization_status === undefined || isNullableSnapshotString(value.localization_status))
    && (value.localization_reason === undefined || isNullableSnapshotString(value.localization_reason))
    && isSnapshotRecord(value.objects)
    && Object.values(value.objects).every(isSnapshotObject);
}

function isSnapshotObject(value: unknown): value is SnapshotObject {
  return isSnapshotRecord(value)
    && typeof value.key === "string" && value.key.trim().length > 0
    && isSnapshotAssetUrl(value.url)
    && (value.content_type === undefined || isNullableSnapshotString(value.content_type))
    && isOptionalSnapshotNumber(value.width)
    && isOptionalSnapshotNumber(value.height)
    && (value.clip == null || (isSnapshotRecord(value.clip)
      && [value.clip.x, value.clip.y, value.clip.width, value.clip.height].every(
        (dimension) => typeof dimension === "number" && Number.isFinite(dimension),
      )));
}

function isSnapshotAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function formatSnapshotDate(value: string) {
  return formatCentralDateTime(value);
}

export function snapshotLocalizationLabel(
  snapshot: SnapshotSide | null,
  focusRatio: number | null,
  evidenceScope: "change_event" | "source_current" = "source_current",
) {
  const primaryObject = selectPrimarySnapshotObject(snapshot);
  if (!primaryObject) return "Screenshot unavailable";
  if (primaryObject.kind === "pdf") return "Saved PDF";
  if (evidenceScope === "change_event") {
    if (snapshot?.exact_overlap && snapshot.objects.crop) return "Highlighted change area";
    return "Screenshot; change location unavailable";
  }
  if (focusRatio !== null) return "Approximate text match";
  switch (snapshot?.localization_status) {
    case "historical_layout_unavailable":
      return "Older screenshot; highlight unavailable";
    case "capture_layout_unavailable":
      return "Screenshot highlight unavailable";
    case "evidence_not_found":
      return "Changed text not found in this screenshot";
    case "not_requested":
      return "No change text available to highlight";
    case "not_applicable":
      return "Screenshot without a highlighted passage";
    default:
      return "Highlight unavailable";
  }
}

export function snapshotUnavailableMessage(
  snapshot: Pick<SourceSnapshotResponse, "evidence_status"> | null,
) {
  return snapshot?.evidence_status === "historical_artifact_unrecoverable"
    ? "Historical visual evidence unavailable - retained artifacts could not be recovered for this update."
    : "Exact visual evidence is unavailable for this update.";
}
