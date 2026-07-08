import { ExternalLink } from "lucide-react";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { readableSourceTitle } from "@/lib/display-text";
import { formatCentralDateTime } from "@/lib/time-zone";
import { SourceSnapshotViewerButton } from "@/components/source-snapshot-viewer";

export function ChangeEvidencePanel({
  sourceId,
  sourceUrl,
  sourceTitle,
  sourcePageTypeLabel,
  summary,
  changeDetails,
  detectedAt,
  compact = false,
}: {
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
    <details className={compact ? "change-evidence change-evidence-compact" : "change-evidence"}>
      <summary>View change explanation</summary>
      <div className="change-evidence-body">
        {sourceId && sourceUrl ? (
          <div className="change-evidence-highlight-link">
            <SourceSnapshotViewerButton
              changeDetectedAt={detectedAt}
              changeDetails={changeDetails}
              changeSummary={summary}
              sourceId={sourceId}
              sourcePageTypeLabel={sourcePageTypeLabel}
              sourceTitle={snapshotTitle}
              sourceUrl={sourceUrl}
            />
          </div>
        ) : null}

        <section className="change-evidence-section">
          <h4>What changed</h4>
          {evidence.hasSummaryEvidence && (
            <div className="change-evidence-summary-only">
              {evidence.summaryLabel && (
                <span className="change-summary-label">{evidence.summaryLabel}</span>
              )}
              <p>{evidence.summarySnippet}</p>
            </div>
          )}

          {(evidence.descriptionSourceLabel ||
            evidence.changeTypeLabel ||
            evidence.sectionLabel ||
            evidence.confidenceLabel) && (
            <div className="change-evidence-meta">
              {evidence.descriptionSourceLabel && <span>{evidence.descriptionSourceLabel}</span>}
              {evidence.changeTypeLabel && <span>{evidence.changeTypeLabel}</span>}
              {evidence.sectionLabel && <span>{evidence.sectionLabel}</span>}
              {evidence.confidenceLabel && <span>{evidence.confidenceLabel}</span>}
            </div>
          )}

          {evidence.relationshipNote && (
            <p className="change-evidence-note">{evidence.relationshipNote}</p>
          )}

          {evidence.hasStructuredEvidence || evidence.hasSnapshotEvidence ? (
            <div className="change-evidence-grid">
              <section>
                <h5>Current wording</h5>
                {evidence.currentSnippets.length > 0 ? (
                  evidence.currentSnippets.map((snippet) => (
                    <mark className="change-evidence-added" key={snippet}>
                      {snippet}
                    </mark>
                  ))
                ) : (
                  <mark className="change-evidence-added">
                    {evidence.afterSnippet || "No new text was isolated in the stored excerpt."}
                  </mark>
                )}
              </section>
              <section>
                <h5>Previous wording</h5>
                {evidence.previousSnippets.length > 0 ? (
                  evidence.previousSnippets.map((snippet) => (
                    <mark className="change-evidence-removed" key={snippet}>
                      {snippet}
                    </mark>
                  ))
                ) : evidence.beforeSnippet ? (
                  <mark className="change-evidence-removed">{evidence.beforeSnippet}</mark>
                ) : (
                  <p>No reliable previous wording was isolated for this exact item.</p>
                )}
              </section>
            </div>
          ) : evidence.hasSummaryEvidence ? (
            <p className="change-evidence-note">
              AwardPing is showing the stored screenshot-based change summary for this update.
            </p>
          ) : (
            <p className="change-evidence-note">
              AwardPing does not have enough structured screenshot evidence to show before/after
              wording for this update.
            </p>
          )}
        </section>

        {evidence.advisorImpact && (
          <section className="change-evidence-section">
            <h4>Advisor impact</h4>
            <p className="change-evidence-note">{evidence.advisorImpact}</p>
          </section>
        )}

        {(sourceUrl || sourceTitle || sourcePageTypeLabel || detectedAt) && (
          <section className="change-evidence-section">
            <h4>Source</h4>
            <dl className="change-source-details">
              {sourceTitle && (
                <div>
                  <dt>Page</dt>
                  <dd>{snapshotTitle}</dd>
                </div>
              )}
              {sourceUrl && (
                <div>
                  <dt>URL</dt>
                  <dd>
                    <a href={sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={13} aria-hidden="true" />
                      <span>{sourceUrl}</span>
                    </a>
                  </dd>
                </div>
              )}
              {sourcePageTypeLabel && (
                <div>
                  <dt>Type</dt>
                  <dd>{sourcePageTypeLabel}</dd>
                </div>
              )}
              {detectedAt && (
                <div>
                  <dt>Detected</dt>
                  <dd>{formatDate(detectedAt)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}
      </div>
    </details>
  );
}

function formatDate(value: string) {
  return formatCentralDateTime(value);
}
