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

type SnapshotObject = {
  key: string;
  url: string;
};

type SnapshotSide = {
  captured_at: string | null;
  focus_ratio?: number | null;
  kind?: "webpage" | "pdf" | string;
  objects: Record<string, SnapshotObject>;
};

type SourceSnapshotResponse = {
  source_url: string;
  source_title: string | null;
  source_page_type: string | null;
  expires_in_seconds: number;
  latest: SnapshotSide;
  previous: SnapshotSide;
};

type SnapshotVersion = "latest" | "previous";

export function SourceSnapshotViewerButton({
  changeDetectedAt,
  changeDetails,
  changeSummary,
  sourceId,
  sourceTitle,
  sourceUrl,
  sourcePageTypeLabel,
}: {
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
    if (!sourceId) return;

    setOpen(true);
    setLoading(true);
    setError(null);
    setActiveVersion("latest");

    try {
      const response = await fetch(snapshotRequestPath(sourceId, evidence), {
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

      setSnapshot(body as SourceSnapshotResponse);
    } catch {
      setSnapshot(null);
      setError("Snapshot unavailable.");
    } finally {
      setLoading(false);
    }
  }

  if (!sourceId) return null;

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
              onVersionChange={setActiveVersion}
              title={snapshot?.source_title || sourceTitle}
              version={activeVersion}
            />
          </section>
        </div>
      )}
    </>
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
    <aside className="source-snapshot-evidence" aria-label="Selected change evidence">
      <div className="source-snapshot-evidence-heading">
        <div>
          <p>Selected change</p>
          <h3>{evidence.changeTypeLabel || "Source update"}</h3>
        </div>
        <div className="source-snapshot-evidence-badges">
          {evidence.confidenceLabel && <span>{evidence.confidenceLabel}</span>}
          {detectedAt && <span>{formatSnapshotDate(detectedAt)}</span>}
        </div>
      </div>
      <p className="source-snapshot-evidence-summary">
        {evidence.summarySnippet || summary || "AwardPing detected a meaningful source-page change."}
      </p>
      {(evidence.previousSnippets.length > 0 || evidence.currentSnippets.length > 0) && (
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
  error,
  loading,
  onVersionChange,
  title,
  version,
}: {
  activeSnapshot: SnapshotSide | null;
  canShowPrevious: boolean;
  error: string | null;
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
          hasFocusTarget={focusRatio !== null}
          openLabel="Open PDF"
          openUrl={primaryObject.url}
          onVersionChange={onVersionChange}
        />
        <div className="source-snapshot-pdf">
          <FileText size={34} aria-hidden="true" />
          <div>
            <p className="source-snapshot-pdf-title">PDF snapshot</p>
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
        hasFocusTarget={focusRatio !== null}
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

function SnapshotFrameActions({
  activeVersion,
  canShowPrevious,
  hasFocusTarget,
  openLabel,
  openUrl,
  onVersionChange,
}: {
  activeVersion: SnapshotVersion;
  canShowPrevious: boolean;
  hasFocusTarget: boolean;
  openLabel: string;
  openUrl: string;
  onVersionChange: (version: SnapshotVersion) => void;
}) {
  return (
    <div className="source-snapshot-frame-actions">
      <div className="source-snapshot-version-control">
        <span>{hasFocusTarget ? "Changed section" : "Screenshot"}</span>
        <div className="source-snapshot-tabs" aria-label="Screenshot version">
          <SnapshotTab
            active={activeVersion === "latest"}
            label="Latest"
            onSelect={() => onVersionChange("latest")}
          />
          <SnapshotTab
            active={activeVersion === "previous"}
            disabled={!canShowPrevious}
            label="Previous"
            onSelect={() => onVersionChange("previous")}
          />
        </div>
      </div>
      <a href={openUrl} rel="noreferrer" target="_blank">
        <ExternalLink size={14} aria-hidden="true" />
        {openLabel}
      </a>
    </div>
  );
}

function snapshotRequestPath(sourceId: string, evidence: ReturnType<typeof buildChangeEvidence>) {
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
    ? [evidence.afterSnippet, ...evidence.currentSnippets, evidence.summarySnippet]
    : [evidence.beforeSnippet, ...evidence.previousSnippets, evidence.summarySnippet];
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
  if (!frame || !image || focusRatio === null || !Number.isFinite(focusRatio)) return;

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

function selectPrimarySnapshotObject(snapshot: SnapshotSide | null) {
  if (!snapshot) return null;
  if (snapshot.objects.page) return { kind: "image" as const, ...snapshot.objects.page };
  if (snapshot.objects.thumb) return { kind: "image" as const, ...snapshot.objects.thumb };
  if (snapshot.objects.pdf) return { kind: "pdf" as const, ...snapshot.objects.pdf };
  return null;
}

function hasSnapshotObjects(snapshot: SnapshotSide) {
  return Object.values(snapshot.objects || {}).some((value) => Boolean(value?.url));
}

function formatSnapshotDate(value: string) {
  return new Date(value).toLocaleString();
}
