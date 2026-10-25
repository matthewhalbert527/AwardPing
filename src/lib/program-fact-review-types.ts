import type { Json } from "@/lib/database.types";

export type ProgramFactFieldView = {
  field: string;
  status: "verified" | "not_published" | "unresolved";
  note: string;
  items: { value: string; track: string | null }[];
};
export type ProgramFactBatchItem = {
  cohort_key: string;
  award_id: string;
  name: string;
  slug: string;
  sources: { id: string; url: string; title: string | null; ready: boolean | null; state: string }[];
  review: null | {
    id: string; content_hash: string; status: "draft" | "approved"; reviewed_at: string | null;
    current: boolean; cycle: string; blockers: string[]; fields: ProgramFactFieldView[];
  };
};
export type ProgramFactPublication = {
  schema: "awardping.program-fact-publication.v1";
  revision: string;
  active: boolean;
  cohorts: { cohort_key: string; review_id: string; award_id: string; epoch: string; reviewed_at: string;
    current: boolean; public_facts: Json; source_ids: string[] }[];
};
