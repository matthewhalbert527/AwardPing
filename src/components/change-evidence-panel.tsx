import { ExternalLink } from "lucide-react";
import { buildChangeEvidence } from "@/lib/change-evidence";
import { readableSourceTitle } from "@/lib/display-text";

export function ChangeEvidencePanel({
  changeId,
  changeKind,
  sourceUrl,
  sourceTitle,
  sourcePageTypeLabel,
  summary,
  changeDetails,
  detectedAt,
  previousTextSample,
  newTextSample,
  compact = false,
}: {
  changeId?: string | null;
  changeKind?: "shared" | "office" | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourcePageTypeLabel?: string | null;
  summary?: string | null;
  changeDetails?: unknown;
  detectedAt?: string | null;
  previousTextSample?: string | null;
  newTextSample?: string | null;
  compact?: boolean;
}) {
  const evidence = buildChangeEvidence({
    sourceUrl,
    sourceTitle,
    summary,
    changeDetails,
    previousTextSample,
    newTextSample,
  });
  const storedHighlightUrl =
    changeId && changeKind
      ? `/highlight/${changeKind}/${encodeURIComponent(changeId)}`
      : null;

  return (
    <details className={compact ? "change-evidence change-evidence-compact" : "change-evidence"}>
      <summary>View change explanation</summary>
      <div className="change-evidence-body">
        {storedHighlightUrl ? (
          <a
            className="change-evidence-highlight-link"
            href={storedHighlightUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open full change explanation
          </a>
        ) : evidence.highlightedUrl ? (
          <a
            className="change-evidence-highlight-link"
            href={evidence.highlightedUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open matched official-page text
          </a>
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
              Snapshot text is not available for this update, so AwardPing is showing the stored
              change summary.
            </p>
          ) : (
            <p className="change-evidence-note">
              AwardPing does not have enough stored snapshot text to show before/after evidence for
              this update.
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
                  <dd>{readableSourceTitle(sourceTitle, sourceUrl)}</dd>
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

        {storedHighlightUrl ? (
          <p className="change-evidence-note">
            Full explanations use AwardPing&apos;s stored snapshot text, so they still work when the
            official page has changed again.
          </p>
        ) : evidence.highlightedUrl ? (
          <p className="change-evidence-note">
            Matched official-page links depend on the current site still containing the changed text
            and may not work on PDFs or heavily scripted pages.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
