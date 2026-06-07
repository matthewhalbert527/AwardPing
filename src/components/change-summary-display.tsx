import { changeSummaryDisplayParts } from "@/lib/change-summary";

export function ChangeSummaryDisplay({
  summary,
  sourceUrl,
  sourceTitle,
  changeDetails,
  compact = false,
}: {
  summary: string | null | undefined;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  changeDetails?: unknown;
  compact?: boolean;
}) {
  const parts = changeSummaryDisplayParts(summary, sourceUrl, sourceTitle, changeDetails);

  return (
    <div className={compact ? "change-summary change-summary-compact" : "change-summary"}>
      <span className="change-summary-label">{parts.label}</span>
      {parts.paragraphs.length > 0 ? (
        parts.paragraphs.map((paragraph, index) => <p key={`${parts.label}-${index}`}>{paragraph}</p>)
      ) : (
        <p>{parts.text}</p>
      )}
    </div>
  );
}
