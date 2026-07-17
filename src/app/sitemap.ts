import type { MetadataRoute } from "next";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getPublicAwardSitemapRows } from "@/lib/public-award-pages";
import { seoPages } from "@/lib/seo-pages";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const staticRoutes = [
    "",
    "/login",
    "/award-directory",
    "/updates",
    "/updates/subscribe",
    "/advisor-hub",
    "/contact",
    "/security",
    "/privacy",
  ];
  const awardRows = hasSupabaseAdminConfig()
    ? await getPublicAwardSitemapRows().catch(() => [])
    : [];

  return [
    ...staticRoutes.map((route) => ({
      url: `${baseUrl}${route}`,
      lastModified: new Date(),
    })),
    ...seoPages.map((page) => ({
      url: `${baseUrl}/${page.slug}`,
      lastModified: new Date(),
    })),
    ...awardRows.map((award) => ({
      url: `${baseUrl}${award.urlPath}`,
      lastModified: award.updatedAt ? new Date(award.updatedAt) : new Date(),
    })),
  ];
}
