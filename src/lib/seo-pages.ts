export type SeoPage = {
  slug: string;
  title: string;
  description: string;
  h1: string;
  intro: string;
  bullets: string[];
};

export const seoPages: SeoPage[] = [
  {
    slug: "national-award-deadline-monitor",
    title: "National Award Deadline Monitor",
    description:
      "Monitor nationally competitive award deadline pages for updates and receive email alerts when dates or requirements update.",
    h1: "National award deadline monitor",
    intro:
      "Track exact official deadline pages without checking them manually. AwardPing watches deadline, eligibility, and application text and emails you when something updates.",
    bullets: [
      "Track exact official deadline pages",
      "Watch eligibility and application updates",
      "Save update history for advisor follow-up",
    ],
  },
  {
    slug: "award-eligibility-change-monitor",
    title: "Award Eligibility Update Monitor",
    description:
      "Get notified when nationally competitive award eligibility or application pages update.",
    h1: "Award eligibility update monitor",
    intro:
      "AwardPing helps applicants and advisors keep track of official eligibility pages, campus nomination instructions, national deadlines, and updated application requirements.",
    bullets: [
      "Useful for eligibility and requirements pages",
      "No browser extension required",
      "Simple email alerts for updated content",
    ],
  },
  {
    slug: "award-page-change-checker",
    title: "Award Page Update Checker",
    description:
      "Paste an exact official award URL and check whether AwardPing can read the page.",
    h1: "Free award page update checker",
    intro:
      "Use the free checker to see if an exact official award deadline, application, eligibility, or PDF page can be monitored before saving it for recurring alerts.",
    bullets: [
      "Quick public URL validation",
      "Readable award text preview",
      "Save recurring checks when the page matters",
    ],
  },
  {
    slug: "award-pdf-update-monitor",
    title: "Award PDF Update Monitor",
    description:
      "Monitor nationally competitive award PDFs for text updates.",
    h1: "Award PDF update monitor",
    intro:
      "Many awards publish prospectuses, application guides, forms, and instructions as PDFs. AwardPing extracts PDF text and alerts you when a public document updates.",
    bullets: [
      "Track public PDF guides and forms",
      "Detect text-level document updates",
      "Keep one watchlist for pages and PDFs",
    ],
  },
  {
    slug: "award-office-deadline-tracker",
    title: "Award Office Deadline Tracker",
    description:
      "A simple update tracker for nationally competitive award offices, honors colleges, and advisors.",
    h1: "Deadline tracking for award offices",
    intro:
      "AwardPing is built for the practical office workflow: maintain a watchlist of public award pages, check them hourly, and keep a record of detected updates.",
    bullets: [
      "Built for advisor-managed watchlists",
      "Track campus and external award pages",
      "Keep a clean history of detected updates",
    ],
  },
];

export function getSeoPage(slug: string) {
  return seoPages.find((page) => page.slug === slug);
}
