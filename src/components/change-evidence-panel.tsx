import { ExternalLink } from "lucide-react";
import { programChangePresentation } from "@/lib/program-change-presentation";

export function ChangeEvidencePanel({
  sourceUrl,
  changeDetails,
  compact = false,
  hideSourceLink = false,
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
  hideSourceLink?: boolean;
}) {
  const presentation = programChangePresentation(changeDetails);
  const hasSourceLink = Boolean(sourceUrl && !hideSourceLink && officialSourceUrl(sourceUrl));
  const quotes = presentation?.quotes ?? [];
  if (!hasSourceLink && quotes.length === 0) return null;

  return (
    <div className={compact ? "change-evidence change-evidence-compact" : "change-evidence"}>
      {hasSourceLink && (
        <div className="change-evidence-actions">
          <a className="change-evidence-source-link" href={sourceUrl!} rel="noreferrer" target="_blank">
            <ExternalLink size={14} aria-hidden="true" />
            Official source
          </a>
        </div>
      )}
      {quotes.length > 0 && (
        <details className="program-change-wording">
          <summary>Exact wording</summary>
          <div className="program-change-quotes">
            {quotes.map((quote, index) => (
              <section key={index} aria-label={quote.label}>
                <h4>{quote.label}</h4>
                {quote.previous !== null && (
                  <div><span>Previously</span><blockquote>{quote.previous}</blockquote></div>
                )}
                {quote.current !== null && (
                  <div><span>Now</span><blockquote>{quote.current}</blockquote></div>
                )}
              </section>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function officialSourceUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
