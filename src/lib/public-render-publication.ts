import "server-only";
import { cache } from "react";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";

/** Share public authority reads only within one React server render. React
 * discards this memo for the next request. Never use a persistent cache, user
 * data, or this render reader for actions, delivery or publication decisions. */
export const loadPublicRenderPublicationIndex = cache(loadStage1PublicationIndex);
