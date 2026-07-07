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
import { getPublicAwardPageBySlug } from "@/lib/public-award-pages";
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

export default async function SlugPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const page = getSeoPage(slug);
  if (page) return <SeoLandingPageContent page={page} />;

  if (!hasSupabaseAdminConfig()) notFound();
  const user = await getCurrentUser();
  const awardPage = await getPublicAwardPageBySlug(slug, { userId: user?.id }).catch(() => null);
  if (!awardPage) notFound();
  if (awardPage.redirectPath) redirect(awardPage.redirectPath);

  return <PublicAwardPage data={awardPage} initialChangeId={query.change} initialSourceId={query.source} />;
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
              <Link className="button-primary" href={user ? signedInLandingPath() : "/signup"}>
                {user ? signedInLandingLabel() : "Sign up for free"}
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
