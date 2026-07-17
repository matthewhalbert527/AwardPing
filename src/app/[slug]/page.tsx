import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { FreeChecker } from "@/components/free-checker";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getCurrentUser } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { signedInLandingLabel, signedInLandingPath } from "@/lib/navigation";
import {
  getPublicAwardPageBySlug,
  getPublicAwardPageResolutionBySlug,
} from "@/lib/public-award-pages";
import { getSeoPage, seoPages } from "@/lib/seo-pages";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ source?: string; change?: string }>;
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
  const resolution = await getPublicAwardPageResolutionBySlug(slug).catch(
    () => ({ kind: "missing" as const }),
  );
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
  const page = getSeoPage(slug);
  if (page) return <SeoLandingPageContent page={page} />;

  if (!hasSupabaseAdminConfig()) notFound();
  const initialResolution = await getPublicAwardPageResolutionBySlug(slug).catch(
    () => ({ kind: "missing" as const }),
  );
  if (initialResolution.kind === "under_verification") {
    return <AwardUnderVerification />;
  }
  if (initialResolution.kind !== "published") notFound();

  const user = await getCurrentUser();
  const awardPage = user
    ? await getPublicAwardPageBySlug(slug, { userId: user.id }).catch(() => null)
    : initialResolution.data;
  if (!awardPage) notFound();
  if (awardPage.redirectPath) redirect(awardPage.redirectPath);

  return <PublicAwardPage data={awardPage} initialChangeId={query.change} initialSourceId={query.source} />;
}

function AwardUnderVerification() {
  return (
    <div className="page-shell">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-20">
        <section className="card rounded-3xl p-8 md:p-10">
          <span className="badge">Protected beta record</span>
          <h1 className="mt-5 text-4xl font-black">Under verification</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg md:leading-8">
            AwardPing is checking this award&apos;s official pages, current cycle,
            evidence, and monitoring health. Application facts stay hidden until
            every release check passes.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
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
              <Link className="button-primary" href={user ? signedInLandingPath() : "/contact"}>
                {user ? signedInLandingLabel() : "Request beta access"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link className="button-secondary" href="/award-directory" prefetch={false}>
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
  initialChangeId,
  initialSourceId,
}: {
  data: Awaited<ReturnType<typeof getPublicAwardPageBySlug>>;
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
