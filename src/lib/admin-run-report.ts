import type { Database } from "@/lib/database.types";

export type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

export type RunReportItem = {
  key: string;
  label: string;
  value: number;
  detail: string;
  tone: "neutral" | "positive" | "attention";
};

export type RunReportDigest = {
  id: string;
  title: string;
  summary: string;
  status: "running" | "succeeded" | "failed";
  isRunning: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  items: RunReportItem[];
};

export type AdminRunReportFeed = {
  current: RunReportDigest | null;
  overnight: RunReportDigest | null;
  generatedAt: string;
};

type Totals = {
  pagesChecked: number;
  candidates: number;
  published: number;
  noiseRejected: number;
  sectionsRead: number;
  failedLoads: number;
  sourcesExcluded: number;
  batchReady: number;
  batchSubmitted: number;
  awardsQueued: number;
  awardsReconciled: number;
  factsAdded: number;
};

const currentRunMaxAgeMs = 48 * 60 * 60 * 1000;

export function buildAdminRunReportFeed(
  runs: WorkerRun[],
  now = new Date(),
): AdminRunReportFeed {
  const sorted = [...runs].sort(
    (left, right) => dateMs(right.started_at) - dateMs(left.started_at),
  );

  return {
    current: buildCurrentDigest(sorted, now),
    overnight: buildOvernightDigest(sorted),
    generatedAt: now.toISOString(),
  };
}

export function latestCompletedDailyRun(runs: WorkerRun[]) {
  return [...runs]
    .filter((run) => run.status !== "running" && isMaintenanceRun(run) && runProfile(run) === "daily")
    .sort((left, right) => dateMs(right.started_at) - dateMs(left.started_at))[0] || null;
}

function buildCurrentDigest(runs: WorkerRun[], now: Date): RunReportDigest | null {
  const active = runs.filter((run) => {
    if (run.status !== "running") return false;
    const ageMs = now.getTime() - dateMs(run.started_at);
    return ageMs >= 0 && ageMs <= currentRunMaxAgeMs;
  });
  if (!active.length) return null;

  const visualRuns = active.filter(isVisualRun);
  const coverageRuns = active.filter(isAiCoverageRun);
  const maintenanceRuns = active.filter(isMaintenanceRun);
  const baselineRuns = active.filter(isBaselineFactsRun);
  const totals = summarizeRuns(active);
  const hasDaily = visualRuns.length > 0 || maintenanceRuns.some((run) => runProfile(run) === "daily");
  const hasSetup = coverageRuns.length > 0 || maintenanceRuns.some((run) => runProfile(run) === "catchup");

  let title = "AwardPing is working";
  if (hasDaily && hasSetup) title = "Daily check and setup are running";
  else if (hasDaily) title = "Daily source check is running";
  else if (hasSetup) title = "Initial setup is running";
  else if (baselineRuns.length) title = "AI fact review is running";

  const summaryParts: string[] = [];
  if (visualRuns.length) {
    summaryParts.push(`${formatCount(totals.pagesChecked)} source ${plural(totals.pagesChecked, "page")} checked so far`);
    summaryParts.push(`${formatCount(totals.candidates)} change ${plural(totals.candidates, "candidate")} found`);
    summaryParts.push(`${formatCount(totals.published)} verified ${plural(totals.published, "update")} published`);
  }
  if (coverageRuns.length) {
    summaryParts.push(`${formatCount(totals.sourcesExcluded)} irrelevant or unclear sources excluded`);
    summaryParts.push(`${formatCount(totals.batchReady)} sources prepared for Batch review`);
  }
  if (!summaryParts.length) {
    summaryParts.push("The worker is active and preparing its first progress totals");
  }

  return {
    id: active.map((run) => run.id).sort().join(":"),
    title,
    summary: `${summaryParts.join("; ")}.`,
    status: "running",
    isRunning: true,
    startedAt: earliestDate(active.map((run) => run.started_at)),
    finishedAt: null,
    items: currentItems(totals, {
      hasVisual: visualRuns.length > 0,
      hasCoverage: coverageRuns.length > 0,
    }),
  };
}

function buildOvernightDigest(runs: WorkerRun[]): RunReportDigest | null {
  const parent = latestCompletedDailyRun(runs);
  if (parent) {
    const start = dateMs(parent.started_at);
    const end = dateMs(parent.finished_at) || start;
    const related = runs.filter((run) => {
      const started = dateMs(run.started_at);
      return run.id !== parent.id && started >= start && started <= end;
    });
    return completedDigest(parent, related);
  }

  const completedVisuals = runs.filter((run) => run.status !== "running" && isDailyVisualRun(run));
  if (!completedVisuals.length) return null;
  const latestKey = monitoringWindowKey(completedVisuals[0].started_at);
  const group = completedVisuals.filter((run) => monitoringWindowKey(run.started_at) === latestKey);
  const representative = group[0];
  return completedDigest(representative, group);
}

function completedDigest(parent: WorkerRun, related: WorkerRun[]): RunReportDigest {
  const rows = related.length ? related : [parent];
  const totals = summarizeRuns(rows);
  const meaningful = totals.pagesChecked + totals.published + totals.sourcesExcluded +
    totals.batchSubmitted + totals.awardsReconciled + totals.factsAdded;
  const failed = parent.status === "failed" || rows.some((run) => run.status === "failed");
  let summary: string;

  if (!meaningful) {
    summary = failed
      ? "The last overnight run stopped without recording completed source-page work or public updates."
      : "The last overnight run completed, but it recorded no source-page checks, new AI interpretations, or public updates.";
  } else {
    const parts: string[] = [];
    if (totals.pagesChecked) {
      parts.push(`checked ${formatCount(totals.pagesChecked)} source ${plural(totals.pagesChecked, "page")}`);
    }
    if (totals.candidates) {
      parts.push(`found ${formatCount(totals.candidates)} change ${plural(totals.candidates, "candidate")}`);
    }
    if (totals.published) {
      parts.push(`published ${formatCount(totals.published)} verified ${plural(totals.published, "update")}`);
    }
    if (totals.sourcesExcluded) {
      parts.push(`excluded ${formatCount(totals.sourcesExcluded)} unsuitable sources`);
    }
    if (totals.factsAdded) {
      parts.push(`added ${formatCount(totals.factsAdded)} source ${plural(totals.factsAdded, "interpretation")}`);
    }
    if (totals.awardsReconciled) {
      parts.push(`rebuilt ${formatCount(totals.awardsReconciled)} award ${plural(totals.awardsReconciled, "page")}`);
    }
    summary = `The last overnight run ${joinSummaryParts(parts)}.`;
  }

  return {
    id: `overnight:${parent.id}`,
    title: "Last overnight run",
    summary,
    status: failed ? "failed" : "succeeded",
    isRunning: false,
    startedAt: parent.started_at,
    finishedAt: parent.finished_at,
    items: completedItems(totals),
  };
}

function summarizeRuns(runs: WorkerRun[]): Totals {
  const visualRuns = runs.filter(isVisualRun);
  const coverageRuns = runs.filter(isAiCoverageRun);
  const totals: Totals = {
    pagesChecked: sum(visualRuns.map((run) => run.checked_count)),
    candidates: sum(visualRuns.map((run) => metric(run, ["candidate_changes"]))),
    published: sum(visualRuns.map((run) => Math.max(
      metric(run, ["published_updates"]),
      metric(run, ["ai_true_changes"]),
    ))),
    noiseRejected: sum(visualRuns.map((run) =>
      metric(run, ["deterministic_source_rejected"]) +
      metric(run, ["deterministic_noise_rejected"]),
    )),
    sectionsRead: sum(visualRuns.map((run) => metric(run, ["expandable_sections_extracted"]))),
    failedLoads: sum(visualRuns.map((run) => run.failed_count)),
    sourcesExcluded: max(coverageRuns.map((run) => metric(run, ["moved_to_review_later"]))),
    batchReady: max(coverageRuns.map((run) => metric(run, ["queued_for_ai_review"]))),
    batchSubmitted: max(coverageRuns.map((run) => metric(run, ["submitted_to_gemini_batch"]))),
    awardsQueued: max(runs.map((run) => metric(run, ["awards_queued_for_reconciliation"]))),
    awardsReconciled: max(runs.map((run) => metric(run, ["awards_reconciled"]))),
    factsAdded: sum(runs.filter(isBaselineFactsRun).map((run) => Math.max(
      metric(run, ["applied"]),
      metric(run, ["extracted"]),
    ))),
  };
  return totals;
}

function currentItems(
  totals: Totals,
  options: { hasVisual: boolean; hasCoverage: boolean },
) {
  const items: RunReportItem[] = [];
  if (options.hasVisual) {
    items.push(item("checked", "Pages checked", totals.pagesChecked, "across the daily source scan", "positive"));
    items.push(item("candidates", "Change candidates", totals.candidates, "before verification", "neutral"));
    items.push(item("published", "Verified updates", totals.published, "safe to show publicly", "positive"));
  }
  if (totals.noiseRejected) {
    items.push(item("noise", "Noise dismissed", totals.noiseRejected, "stopped before AI review", "positive"));
  }
  if (totals.sectionsRead) {
    items.push(item("sections", "Sections read", totals.sectionsRead, "expandable panels extracted", "neutral"));
  }
  if (totals.failedLoads) {
    items.push(item("failures", "Load failures", totals.failedLoads, "pages to retry", "attention"));
  }
  if (options.hasCoverage) {
    items.push(item("excluded", "Sources excluded", totals.sourcesExcluded, "removed from daily monitoring", "positive"));
    items.push(item("batch-ready", "Batch review ready", totals.batchReady, "sources awaiting AI decisions", "neutral"));
  }
  return items.slice(0, 8);
}

function completedItems(totals: Totals) {
  const items: RunReportItem[] = [];
  if (totals.pagesChecked) items.push(item("checked", "Pages checked", totals.pagesChecked, "official source pages", "positive"));
  if (totals.candidates) items.push(item("candidates", "Candidates found", totals.candidates, "before verification", "neutral"));
  if (totals.published) items.push(item("published", "Updates published", totals.published, "verified applicant-facing changes", "positive"));
  if (totals.sourcesExcluded) items.push(item("excluded", "Sources excluded", totals.sourcesExcluded, "kept out of monitoring", "positive"));
  if (totals.factsAdded) items.push(item("facts", "AI facts added", totals.factsAdded, "evidence-backed interpretations", "positive"));
  if (totals.awardsReconciled) items.push(item("reconciled", "Awards rebuilt", totals.awardsReconciled, "reconciled public pages", "positive"));
  if (totals.failedLoads) items.push(item("failures", "Load failures", totals.failedLoads, "pages needing a retry", "attention"));
  return items;
}

function item(
  key: string,
  label: string,
  value: number,
  detail: string,
  tone: RunReportItem["tone"],
): RunReportItem {
  return { key, label, value, detail, tone };
}

function isVisualRun(run: WorkerRun) {
  return runKind(run) === "visual_snapshot" || /visual-snapshot-worker/i.test(run.worker_name);
}

function isDailyVisualRun(run: WorkerRun) {
  return isVisualRun(run) && /visual-snapshot-worker-shard-\d+-of-\d+$/i.test(run.worker_name);
}

function isAiCoverageRun(run: WorkerRun) {
  return runKind(run) === "open_source_ai_review_coverage_backfill" ||
    /open-source-ai-coverage-backfill/i.test(run.worker_name);
}

function isMaintenanceRun(run: WorkerRun) {
  return runKind(run) === "maintenance" || run.worker_name === "local-maintenance-runner";
}

function isBaselineFactsRun(run: WorkerRun) {
  return runKind(run) === "baseline_facts" || /baseline-facts-worker/i.test(run.worker_name);
}

function runKind(run: WorkerRun) {
  return cleanText(record(run.metadata).kind);
}

function runProfile(run: WorkerRun) {
  return cleanText(record(run.metadata).profile);
}

function metric(run: WorkerRun, keys: string[]) {
  const metadata = record(run.metadata);
  const containers = [
    metadata,
    record(metadata.counts),
    record(metadata.counters),
    record(metadata.final_summary),
  ];
  for (const key of keys) {
    for (const container of containers) {
      if (Object.prototype.hasOwnProperty.call(container, key)) {
        return numberValue(container[key]);
      }
    }
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + numberValue(value), 0);
}

function max(values: number[]) {
  return values.reduce((highest, value) => Math.max(highest, numberValue(value)), 0);
}

function earliestDate(values: string[]) {
  return [...values].sort((left, right) => dateMs(left) - dateMs(right))[0] || null;
}

function dateMs(value: string | null | undefined) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function monitoringWindowKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const local = new Date(Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
  ));
  if (Number(byType.get("hour")) < 18) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}

function joinSummaryParts(parts: string[]) {
  if (!parts.length) return "completed without recording measurable changes";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}
