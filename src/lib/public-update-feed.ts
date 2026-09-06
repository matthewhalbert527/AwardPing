import { hasSupabaseAdminConfig } from "@/lib/config";
import { getLiveUpdateItems, type LiveUpdateItem } from "@/lib/live-updates";

// The public feed is shown in one of three truthful states: updates loaded,
// none recorded yet, or unavailable (not configured, or the load failed).
// Unavailable never claims that nothing has changed, and a failed load never
// reaches the visitor as an error or takes a page down.
export type PublicUpdateFeed =
  | { status: "ready"; updates: LiveUpdateItem[] }
  | { status: "empty" }
  | { status: "unavailable" };

export const PUBLIC_UPDATE_FEED_EMPTY_NOTICE = "No award page changes have been recorded yet.";
export const PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE =
  "Live updates are unavailable right now. Please check back soon.";

// `limit` is the page's own size and `now` its single clock reading, so every
// label the loader produces agrees with the rest of that render.
export async function loadPublicUpdateFeed(limit: number, now: Date): Promise<PublicUpdateFeed> {
  if (!hasSupabaseAdminConfig()) return { status: "unavailable" };
  try {
    const updates = await getLiveUpdateItems(limit, now);
    return updates.length > 0 ? { status: "ready", updates } : { status: "empty" };
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Live updates could not be loaded.");
    return { status: "unavailable" };
  }
}

// The one notice for a feed that has nothing to list; null when it does.
export function publicUpdateFeedNotice(feed: PublicUpdateFeed) {
  if (feed.status === "ready") return null;
  return feed.status === "empty"
    ? PUBLIC_UPDATE_FEED_EMPTY_NOTICE
    : PUBLIC_UPDATE_FEED_UNAVAILABLE_NOTICE;
}
