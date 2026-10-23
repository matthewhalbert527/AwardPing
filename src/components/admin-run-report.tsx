import type { AdminRunReportFeed } from "@/lib/admin-run-report";

type Props = { compact?: boolean; initialFeed?: AdminRunReportFeed };

/** Legacy image-run reports are not evidence of the new text epoch's coverage. */
export function AdminRunReport({ compact = false }: Props) {
  return (
    <section className={compact ? "card operator-scan-report" : "card admin-section-card admin-run-report"} aria-labelledby="text-monitoring-report-title">
      <h2 id="text-monitoring-report-title">Text monitoring coverage</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        New text-monitoring coverage is not yet reported in this dashboard. Historical image scans do not establish readiness for the new system.
      </p>
      <p className="mt-2 text-sm">
        On the installed AwardPing PC, open <code>6-SHOW-VISUAL-SNAPSHOT-STATUS.bat</code> to read the text coverage report. The filename is retained for compatibility; it does not run image capture.
      </p>
      <p className="mt-2 text-sm text-[var(--muted)]">First coverage is not a program update. No completion count is inferred here.</p>
    </section>
  );
}
