import type { MetadataRoute } from "next";
import { seoPages } from "@/lib/seo-pages";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const staticRoutes = [
    "",
    "/login",
    "/signup",
    "/award-directory",
    "/updates",
    "/contact",
    "/security",
    "/privacy",
  ];

  return [
    ...staticRoutes.map((route) => ({
      url: `${baseUrl}${route}`,
      lastModified: new Date(),
    })),
    ...seoPages.map((page) => ({
      url: `${baseUrl}/${page.slug}`,
      lastModified: new Date(),
    })),
  ];
}
