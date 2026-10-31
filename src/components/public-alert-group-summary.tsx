import type { PublicAlertGroupMember } from "@/lib/public-alert-groups";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { describeTimestamp } from "@/lib/time-zone";

/** One update, with each official page and its exact comparison kept distinct. */
export function PublicAlertGroupSummary({ members, showEvidence = false, showSourceLinks = true }: {
  members: PublicAlertGroupMember[]; showEvidence?: boolean; showSourceLinks?: boolean;
}) {
  return <div className="space-y-4" aria-label="Related changes">
    {members.map(member => {
      const detected = describeTimestamp(member.detectedAt);
      return <section key={member.id} className="space-y-2">
      {showSourceLinks ? <a className="text-sm font-semibold underline" href={member.sourceUrl} rel="noreferrer" target="_blank">{member.sourceTitle}</a>
        : <p className="text-sm font-semibold">{member.sourceTitle}</p>}
      {showEvidence && detected.dateTime && <time className="text-xs text-[var(--muted)]" dateTime={detected.dateTime}>Recorded {detected.full}</time>}
      <ChangeSummaryDisplay compact summary={member.summary} changeDetails={member.changeDetails}
        sourceTitle={member.sourceTitle} sourceUrl={member.sourceUrl} />
      {showEvidence && <ChangeEvidencePanel compact hideSourceLink changeEventId={member.id} changeDetails={member.changeDetails}
        sourceId={member.sourceId} sourceTitle={member.sourceTitle} sourceUrl={member.sourceUrl} detectedAt={member.detectedAt} />}
    </section>; })}
  </div>;
}
