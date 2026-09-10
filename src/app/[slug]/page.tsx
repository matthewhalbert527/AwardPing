import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FreeChecker } from "@/components/free-checker";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import {
  getPublicAwardPageResolutionBySlug,
  type PublicAwardPageData,
} from "@/lib/public-award-pages";
import { publicAwardHref, publicAwardQueryId } from "@/lib/public-award-links";
import { getSeoPage, seoPages } from "@/lib/seo-pages";

export const dynamic = "force-dynamic";

const AWARD_UNAVAILABLE_METADATA: Metadata = {
  title: "Award details unavailable",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ slug: string }>;
  // A repeated key arrives as an array; publicAwardQueryId keeps only a
  // single well-formed id.
  searchParams?: Promise<{ source?: string | string[]; change?: string | string[] }>;
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

  if (!hasSupabaseAdminConfig()) return AWARD_UNAVAILABLE_METADATA;
  const resolution = await getPublicAwardPageResolutionBySlug(slug).catch(
    () => ({ kind: "unavailable" as const }),
  );
  if (resolution.kind === "unavailable") return AWARD_UNAVAILABLE_METADATA;
  if (resolution.kind === "under_verification") {
    return {
      title: "Award under verification",
      description: "This award record is being reverified before publication.",
      robots: { index: false, follow: false },
    };
  }
  if (resolution.kind !== "published") return {};
  const awardPage = resolution.data;

  return {
    title: awardPage.award.name,
    description: awardPage.metaDescription,
    alternates: {
      canonical: `${appConfig.url}${awardPage.canonicalPath}`,
    },
  };
}

export default async function SlugPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const context = {
    sourceId: publicAwardQueryId(query.source),
    changeId: publicAwardQueryId(query.change),
  };
  const page = getSeoPage(slug);
  if (page) return <SeoLandingPageContent page={page} />;

  const retryHref = publicAwardHref(`/${slug}`, context);
  if (!hasSupabaseAdminConfig()) return <AwardUnavailable retryHref={retryHref} />;
  // The validated change id rides along so an update older than the recent
  // list is still loaded (through the public gates) and can be selected.
  const initialResolution = await getPublicAwardPageResolutionBySlug(slug, {
    changeId: context.changeId,
  }).catch(() => ({ kind: "unavailable" as const }));
  if (initialResolution.kind === "unavailable") {
    return <AwardUnavailable retryHref={retryHref} />;
  }
  if (initialResolution.kind === "under_verification") {
    return <AwardUnderVerification />;
  }
  if (initialResolution.kind !== "published") notFound();

  const user = await getCurrentUser();
  const resolution = user
    ? await getPublicAwardPageResolutionBySlug(slug, { userId: user.id, changeId: context.changeId }).catch(
        () => ({ kind: "unavailable" as const }),
      )
    : initialResolution;
  // A second load must pass the same current gates; never fall back to the
  // earlier public data if availability or verification changed meanwhile.
  if (resolution.kind === "unavailable") return <AwardUnavailable retryHref={retryHref} />;
  if (resolution.kind === "under_verification") return <AwardUnderVerification />;
  if (resolution.kind !== "published") notFound();
  const awardPage = resolution.data;
  // An alias slug keeps its update context through the canonical redirect.
  if (awardPage.redirectPath) redirect(publicAwardHref(awardPage.redirectPath, context));

  return (
    <PublicAwardPage
      data={awardPage}
      initialChangeId={context.changeId}
      initialSourceId={context.sourceId}
    />
  );
}

function AwardUnavailable({ retryHref }: { retryHref: string }) {
  return (
    <div className="page-shell">
      {/* Metadata and page data load independently. Keep this unavailable
          response non-indexable even if the metadata lookup succeeded. */}
      <meta name="robots" content="noindex, nofollow" />
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <section aria-labelledby="award-unavailable-heading">
          <header className="public-page-heading">
            <h1 id="award-unavailable-heading">Award details unavailable</h1>
            <p role="status">
              Award details are unavailable right now. Please try again.
            </p>
          </header>
          <div className="public-page-actions">
            {/* A full navigation retries the server load, rather than reusing
                this failed page from the client router cache. */}
            <a className="button-primary" href={retryHref}>Try again</a>
            <Link className="button-secondary" href="/award-directory" prefetch={false}>
              Browse awards
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function AwardUnderVerification() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <section>
          <header className="public-page-heading">
            <h1>Under verification</h1>
            <p>
              AwardPing is checking this award&apos;s official pages, current cycle,
              evidence, and monitoring health. Application facts stay hidden until
              every release check passes.
            </p>
          </header>
          <div className="public-page-actions">
            <Link className="button-primary" href="/award-directory" prefetch={false}>
              View verified awards
            </Link>
            <Link className="button-secondary" href="/">
              Return home
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function SeoLandingPageContent({
  page,
}: {
  page: NonNullable<ReturnType<typeof getSeoPage>>;
}) {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="public-page-main public-page-main-narrow">
        <header className="public-page-heading">
          <h1>{page.h1}</h1>
          <p>{page.intro}</p>
          <div className="public-page-actions">
            <Link className="button-primary" href="/updates">
              View updates
            </Link>
            <Link className="button-secondary" href="/award-directory" prefetch={false}>
              Browse awards
            </Link>
          </div>
        </header>
        {page.slug === "award-page-change-checker" ? <FreeChecker /> : null}
      </main>
      <SiteFooter />
    </div>
  );
}

function PublicAwardPage({
  data,
  initialChangeId,
  initialSourceId,
}: {
  data: PublicAwardPageData;
  initialChangeId?: string;
  initialSourceId?: string;
}) {
  if (!data) notFound();

  return (
    <div className="page-shell public-award-shell">
      <SiteHeader />
      <main className="public-award-console-wrap">
        <PublicAwardWorkspace
          data={data}
          initialChangeId={initialChangeId}
          initialSourceId={initialSourceId}
        />
      </main>
      <SiteFooter />
    </div>
  );
}
