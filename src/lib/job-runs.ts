import "server-only";

import type { JobRunName, JobRunStatus, Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type FinishJobRunInput = {
  status: Exclude<JobRunStatus, "running">;
  processedCount: number;
  error?: string | null;
  metadata?: Json;
};

export async function startJobRun(jobName: JobRunName, metadata: Json = {}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("job_runs")
    .insert({
      job_name: jobName,
      status: "running",
      metadata,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw error || new Error("Job run could not be created.");
  }

  return data.id;
}

export async function finishJobRun(runId: string, input: FinishJobRunInput) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("job_runs")
    .update({
      status: input.status,
      finished_at: new Date().toISOString(),
      processed_count: input.processedCount,
      error: input.error || null,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
    .eq("id", runId);

  if (error) {
    throw error;
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown job failure.";
}
