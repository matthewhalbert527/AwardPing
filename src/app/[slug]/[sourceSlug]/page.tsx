import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { getPublicAwardPageBySlug } from "@/lib/public-award-pages";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string; sourceSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!hasSupabaseAdminConfig()) return {};

  const data = await getPublicAwardPageBySlug(slug).catch(() => null);
  if (!data) return {};

  return {
    title: `${data.award.name} | AwardPing`,
    description: data.metaDescription,
    alternates: {
      canonical: `${appConfig.url}${data.canonicalPath}`,
    },
    robots: {
      index: false,
      follow: true,
    },
  };
}

export default async function PublicAwardSourcePage({ params }: Props) {
  const { slug } = await params;
  if (!hasSupabaseAdminConfig()) notFound();

  const data = await getPublicAwardPageBySlug(slug).catch(() => null);
  if (!data) notFound();
  redirect(data.redirectPath || data.canonicalPath);
}
