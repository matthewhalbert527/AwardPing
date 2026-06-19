import { Activity, ExternalLink, Sparkles } from "lucide-react";

export type ChangeTickerItem = {
  id: string;
  awardName: string;
  sourceTitle: string;
  sourceUrl: string;
  summary: string;
  detectedLabel: string;
  sample?: boolean;
};

export function ChangeTicker({ items }: { items: ChangeTickerItem[] }) {
  const tickerItems = items.length > 0 ? items : sampleTickerItems;
  const loopItems = [...tickerItems, ...tickerItems];

  return (
    <section className="mx-auto max-w-6xl px-5 pb-12">
      <div className="change-ticker-shell">
        <div className="change-ticker-copy">
          <h2 className="flex items-center gap-3 text-4xl font-black">
            <Sparkles className="change-ticker-sparkles" size={30} aria-hidden="true" />
            Update ticker
          </h2>
          <p className="mt-4 max-w-xl leading-7 text-[var(--muted)]">
            AwardPing turns source-page diffs into short, plain-English updates
            so students and advisors can see what updated without rereading every page.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <span className="change-ticker-pill">Deadline updates</span>
            <span className="change-ticker-pill">Eligibility edits</span>
            <span className="change-ticker-pill">PDF updates</span>
          </div>
        </div>

        <div className="change-ticker-window" aria-label="Recent award page updates">
          <div className="change-ticker-track">
            {loopItems.map((item, index) => (
              <article
                className="change-ticker-item"
                key={`${item.id}-${index}`}
                aria-hidden={index >= tickerItems.length}
              >
                <div className="change-ticker-item-heading">
                  <span className="change-ticker-status">
                    <Activity size={14} aria-hidden="true" />
                    {item.sample ? "Example" : item.detectedLabel}
                  </span>
                  <span className="change-ticker-award">{item.awardName}</span>
                </div>
                <p className="change-ticker-summary">{item.summary}</p>
                <a
                  className="change-ticker-source"
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>{item.sourceTitle}</span>
                </a>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const sampleTickerItems: ChangeTickerItem[] = [
  {
    id: "sample-deadline",
    awardName: "Goldwater Scholarship",
    sourceTitle: "Official deadline page",
    sourceUrl: "https://goldwaterscholarship.gov/",
    summary:
      "The posted deadline moved earlier and the application instructions now ask advisors to confirm institutional endorsement before submission.",
    detectedLabel: "Example",
    sample: true,
  },
  {
    id: "sample-eligibility",
    awardName: "Fulbright U.S. Student Program",
    sourceTitle: "Eligibility requirements",
    sourceUrl: "https://us.fulbrightonline.org/",
    summary:
      "The eligibility section added a new note about recent graduates and clarified which applicants should use the study/research application path.",
    detectedLabel: "Example",
    sample: true,
  },
  {
    id: "sample-pdf",
    awardName: "NSF Graduate Research Fellowship Program",
    sourceTitle: "Program solicitation PDF",
    sourceUrl: "https://www.nsfgrfp.org/",
    summary:
      "A revised PDF was detected with updated review criteria language and a refreshed application checklist for recommenders.",
    detectedLabel: "Example",
    sample: true,
  },
];
