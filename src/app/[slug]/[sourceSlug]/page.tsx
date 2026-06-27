import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PublicAwardWorkspace } from "@/components/public-award-workspace";
import { SiteFooter } from "@/components/site-footer";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { getPublicAwardSourcePageBySlugs } from "@/lib/public-award-pages";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; sourceSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, sourceSlug } = await params;
  if (!hasSupabaseAdminConfig()) return {};

  const data = await getPublicAwardSourcePageBySlugs(slug, sourceSlug).catch(() => null);
  if (!data) return {};

  const description =
    data.source.description ||
    `${data.source.title} details, official link, and recent updates for ${data.award.name}.`;

  return {
    title: `${data.source.title} | ${data.award.name} | AwardPing`,
    description: truncate(description, 155),
    alternates: {
      canonical: `${appConfig.url}${data.source.publicPath}`,
    },
  };
}

export default async function PublicAwardSourcePage({ params }: Props) {
  const { slug, sourceSlug } = await params;
  if (!hasSupabaseAdminConfig()) notFound();

  const data = await getPublicAwardSourcePageBySlugs(slug, sourceSlug).catch(() => null);
  if (!data) notFound();
  if (data.redirectPath) redirect(data.redirectPath);

  return (
    <div className="page-shell public-award-shell">
      <main className="public-award-console-wrap">
        <PublicAwardWorkspace data={data} initialSourceId={data.source.id} />
      </main>
      <SiteFooter />
    </div>
  );
}

function truncate(value: string, length: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1).replace(/\s+\S*$/, "")}...`;
}
