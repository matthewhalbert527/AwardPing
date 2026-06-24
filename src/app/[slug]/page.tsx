import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileText,
  ListChecks,
} from "lucide-react";
import { FreeChecker } from "@/components/free-checker";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import { getPublicAwardPageBySlug } from "@/lib/public-award-pages";
import { getSeoPage, seoPages } from "@/lib/seo-pages";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return seoPages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getSeoPage(slug);
  if (page) {
    return {
      title: page.title,
      description: page.description,
    };
  }

  if (!hasSupabaseAdminConfig()) return {};
  const awardPage = await getPublicAwardPageBySlug(slug).catch(() => null);
  if (!awardPage) return {};

  return {
    title: `${awardPage.award.name} | AwardPing`,
    description: awardPage.metaDescription,
    alternates: {
      canonical: `${appConfig.url}${awardPage.canonicalPath}`,
    },
  };
}

export default async function SlugPage({ params }: Props) {
  const { slug } = await params;
  const page = getSeoPage(slug);
  if (page) return <SeoLandingPageContent page={page} />;

  if (!hasSupabaseAdminConfig()) notFound();
  const awardPage = await getPublicAwardPageBySlug(slug).catch(() => null);
  if (!awardPage) notFound();
  if (awardPage.redirectPath) redirect(awardPage.redirectPath);

  return <PublicAwardPage data={awardPage} />;
}

async function SeoLandingPageContent({
  page,
}: {
  page: NonNullable<ReturnType<typeof getSeoPage>>;
}) {
  const user = await getCurrentUser();

  return (
    <div className="page-shell">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-[0.95fr_1.05fr]">
          <div>
            <span className="badge">AwardPing</span>
            <h1 className="mt-5 text-5xl font-black leading-tight">
              {page.h1}
            </h1>
            <p className="mt-5 text-lg leading-8 text-[var(--muted)]">
              {page.intro}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link className="button-primary" href={user ? "/dashboard" : "/signup"}>
                {user ? "Open dashboard" : "Sign up for free"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button-secondary" href="/award-directory">
                Find exact pages
              </Link>
            </div>
          </div>
          <FreeChecker />
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-20">
          <div className="grid gap-4 md:grid-cols-3">
            {page.bullets.map((bullet) => (
              <div className="card rounded-3xl p-6" key={bullet}>
                <CheckCircle2 className="text-[var(--brand)]" size={22} aria-hidden="true" />
                <p className="mt-4 font-bold leading-6">{bullet}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function PublicAwardPage({
  data,
}: {
  data: Awaited<ReturnType<typeof getPublicAwardPageBySlug>>;
}) {
  if (!data) notFound();
  const facts = data.facts;

  return (
    <div className="page-shell public-award-shell">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:py-14">
        <div className="public-award-layout">
          <aside className="public-award-rail">
            <p className="dashboard-label">AwardPing record</p>
            <nav aria-label={`${data.award.name} sections`} className="public-award-rail-nav">
              {[
                ["Overview", "#overview"],
                ["Facts", "#facts"],
                ["Source pages", "#sources"],
                ["Recent changes", "#changes"],
              ].map(([label, href]) => (
                <a href={href} key={href}>{label}</a>
              ))}
            </nav>
            <div className="public-award-rail-card">
              <span>Last checked</span>
              <strong>{data.lastCheckedAt ? formatDate(data.lastCheckedAt) : "Pending"}</strong>
            </div>
          </aside>

          <div className="public-award-main">
            <section className="public-award-hero" id="overview">
              <div className="award-detail-meta-line">
                <span>{data.sources.length} source pages</span>
                <span>{data.changes.length} recent updates</span>
                {facts.confidence && <span>{facts.confidence} confidence</span>}
              </div>
              <h1 className="public-award-title">{data.award.name}</h1>
              {facts.overview && <p className="public-award-summary">{facts.overview}</p>}
              <div className="mt-5 flex flex-wrap gap-3">
                <Link className="button-primary" href="/signup">
                  Add to watchlist
                  <ArrowRight size={17} aria-hidden="true" />
                </Link>
                {data.officialHomepage && (
                  <a className="button-secondary" href={data.officialHomepage} rel="noreferrer" target="_blank">
                    <ExternalLink size={16} aria-hidden="true" />
                    Official homepage
                  </a>
                )}
              </div>
            </section>

            <section className="public-award-section" id="facts">
              <div className="public-award-section-heading">
                <h2>Key details</h2>
                <p>Structured from AwardPing source-page snapshots and official links.</p>
              </div>
              <dl className="public-award-fact-grid">
                <PublicFact icon={<CalendarDays size={18} />} label="Deadline" value={facts.deadline} />
                <PublicFact label="Award amount" value={facts.awardAmount} />
                <PublicFact label="Academic level" value={facts.academicLevels.join(", ")} />
                <PublicFact label="Citizenship" value={facts.citizenship.join(", ")} />
                <PublicFact wide label="Eligibility" value={facts.eligibility.slice(0, 5).join("; ")} />
                <PublicFact wide icon={<ListChecks size={18} />} label="Application materials" value={facts.applicationMaterials.slice(0, 5).join("; ")} />
              </dl>
            </section>

            <section className="public-award-section" id="sources">
              <div className="public-award-section-heading">
                <h2>Official source pages</h2>
                <p>These are the pages AwardPing checks for this award.</p>
              </div>
              <div className="public-award-source-list">
                {data.sources.map((source) => (
                  <article className="public-award-source-row" key={source.id}>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="badge">{pageTypeLabel(source.pageType)}</span>
                        {source.lastCheckedAt && <span className="badge">{formatDate(source.lastCheckedAt)}</span>}
                      </div>
                      <h3>{source.title}</h3>
                      {source.description && <p>{source.description}</p>}
                    </div>
                    <a href={source.url} rel="noreferrer" target="_blank" aria-label={`Open ${source.title}`}>
                      <ExternalLink size={16} aria-hidden="true" />
                    </a>
                  </article>
                ))}
              </div>
            </section>

            <section className="public-award-section" id="changes">
              <div className="public-award-section-heading">
                <h2>Recent changes</h2>
                <p>Plain-English summaries of meaningful source-page changes.</p>
              </div>
              <div className="public-award-change-list">
                {data.changes.map((change) => (
                  <article className="public-award-change-row" key={change.id}>
                    <span className="badge">{formatDate(change.detectedAt)}</span>
                    <h3>{change.sourceTitle}</h3>
                    <p>{change.summary}</p>
                  </article>
                ))}
                {data.changes.length === 0 && (
                  <div className="public-award-empty">
                    <FileText size={20} aria-hidden="true" />
                    No meaningful updates have been recorded yet.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function PublicFact({
  icon,
  label,
  value,
  wide = false,
}: {
  icon?: ReactNode;
  label: string;
  value?: string | null;
  wide?: boolean;
}) {
  return (
    <div className={`public-award-fact ${wide ? "public-award-fact-wide" : ""}`}>
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{value || "Not listed yet"}</dd>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
