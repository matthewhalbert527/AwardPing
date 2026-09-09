import { ExternalLink } from "lucide-react";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { readableSourceTitle } from "@/lib/display-text";
import { SourceSnapshotViewerButton } from "@/components/source-snapshot-viewer";

export function ChangeEvidencePanel({
  changeEventId,
  sourceId,
  sourceUrl,
  sourceTitle,
  sourcePageTypeLabel,
  summary,
  changeDetails,
  detectedAt,
  compact = false,
}: {
  changeEventId?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourcePageTypeLabel?: string | null;
  summary?: string | null;
  changeDetails?: unknown;
  detectedAt?: string | null;
  compact?: boolean;
}) {
  const evidence = buildChangeEvidence({
    sourceUrl,
    sourceTitle,
    summary,
    changeDetails,
  });
  const snapshotTitle = readableSourceTitle(sourceTitle, sourceUrl);

  return (
    <div className={compact ? "change-evidence change-evidence-compact" : "change-evidence"}>
      <div className="change-evidence-actions">
        {(changeEventId || sourceId) && sourceUrl ? (
          <SourceSnapshotViewerButton
            changeEventId={changeEventId}
            changeDetectedAt={detectedAt}
            changeDetails={changeDetails}
            changeSummary={summary}
            sourceId={sourceId}
            sourcePageTypeLabel={sourcePageTypeLabel}
            sourceTitle={snapshotTitle}
            sourceUrl={sourceUrl}
          />
        ) : null}
        {sourceUrl && (
          <a className="change-evidence-source-link" href={sourceUrl} rel="noreferrer" target="_blank">
            <ExternalLink size={14} aria-hidden="true" />
            Open source
          </a>
        )}
      </div>
      {evidence.relationshipNote && <p className="change-evidence-note">{evidence.relationshipNote}</p>}
      {evidence.isFirstObservation && (
        <p className="change-evidence-note">
          First retained observation; publication date not established.
        </p>
      )}
    </div>
  );
}
