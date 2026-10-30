-- Add only a physical access path for the unchanged historical capture-ref
-- containment predicate. All statuses/history remain indexed. No guard,
-- approval, role, grant, timeout, cache or source-state changes.
create index program_text_fact_reviews_capture_refs_gin
on public.program_text_fact_reviews
using gin ((validation #> '{review,capture_refs}'::text[]) pg_catalog.jsonb_path_ops);
-- Refresh planner statistics as in the measured rollback rehearsal.
analyze public.program_text_fact_reviews;
