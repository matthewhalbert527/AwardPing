import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { changeSummaryPresentation } from "@/lib/change-summary";
import { programChangePresentation } from "@/lib/program-change-presentation";
import type { LiveUpdateItem } from "@/lib/live-updates";
import { liveUpdateAwardHref } from "@/lib/public-award-links";
import { PublicAlertGroupSummary } from "@/components/public-alert-group-summary";
import styles from "./public-update-card.module.css";

/** One reader-facing update presentation shared by home and the full feed. */
export function PublicUpdateCard({ update }: { update: LiveUpdateItem }) {
  const awardHref = liveUpdateAwardHref({ ...update, sourceId: update.group ? null : update.sourceId });
  const presentation = programChangePresentation(update.changeDetails) ??
    changeSummaryPresentation(update.summary, update.sourceUrl, update.sourceTitle, update.changeDetails);
  const normalizedTitle = normalizedSentence(presentation.title);
  // Keep the existing compact metadata slot, not another category badge or
  // a second copy of a complete summary. Generic fallbacks add no information.
  const showTitle = presentation.title !== "Official page update" &&
    !presentation.paragraphs.some((paragraph) => normalizedSentence(paragraph) === normalizedTitle);
  return (
    <article className="public-live-update-row">
      <div className={styles.card}>
        <header className={styles.header}>
          <h3 className="public-live-update-title-row">
            <Link href={awardHref} prefetch={false}>{update.awardName}</Link>
          </h3>
          <div className="public-live-update-time">
            <span>
              {update.detectedDateTime ? (
                <time dateTime={update.detectedDateTime} title={update.detectedTitle}>
                  {update.detectedLabel}
                  <span className="sr-only"> ({update.detectedTitle})</span>
                </time>
              ) : (
                update.detectedLabel
              )}
            </span>
            {update.group ? <strong>Related award changes</strong> : showTitle && <strong>{presentation.title}</strong>}
          </div>
        </header>
        <div className={styles.panel}>
          {!update.group && update.sourceTitle && (
            <p className="public-live-update-source">{update.sourceTitle}</p>
          )}
          {update.group ? <PublicAlertGroupSummary members={update.group.members} /> : <ChangeSummaryDisplay
            compact
            summary={update.summary}
            sourceUrl={update.sourceUrl}
            sourceTitle={update.sourceTitle}
            changeDetails={update.changeDetails}
          />}
          <div className="public-live-update-actions">
            <Link
              className="public-live-update-detail-link"
              href={awardHref}
              prefetch={false}
              aria-label={`View update for ${update.awardName}`}
            >
              View update
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            {!update.group && <a
              className="public-live-update-source-link"
              href={update.sourceUrl}
              rel="noreferrer"
              target="_blank"
              aria-label={`Official source: ${update.sourceTitle}`}
            >
              Official source
              <ExternalLink size={15} aria-hidden="true" />
            </a>}
          </div>
        </div>
      </div>
    </article>
  );
}

function normalizedSentence(value: string) {
  return value.trim().toLowerCase().replace(/[.!?]+$/, "");
}
