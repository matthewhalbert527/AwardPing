import type { MetadataRoute } from "next";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getPublicAwardSitemapRows, getPublicAwardSourceSitemapRows } from "@/lib/public-award-pages";
import { seoPages } from "@/lib/seo-pages";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const staticRoutes = [
    "",
    "/login",
    "/signup",
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
  const awardSourceRows = hasSupabaseAdminConfig()
    ? await getPublicAwardSourceSitemapRows().catch(() => [])
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
    ...awardSourceRows.map((source) => ({
      url: `${baseUrl}${source.urlPath}`,
      lastModified: source.updatedAt ? new Date(source.updatedAt) : new Date(),
    })),
  ];
}
