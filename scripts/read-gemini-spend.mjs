// Unified Gemini spend report: merges the three spend truths -
//   1) DB lane ledger (gemini_spend_events - the capped lanes)
//   2) file ledger (D:\AwardPingVisualSnapshots\usage\gemini-usage-<month>.jsonl -
//      capture/baseline/editorial calls)
//   3) prints a per-day, per-kind table plus month totals.
//
// Usage: node scripts/read-gemini-spend.mjs [--month=2026-08] [--env=.env.local]
// Read-only: one SELECT against the lane ledger, local file reads, no writes.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...rest] = a.slice(2).split("=");
    return [k, rest.join("=") || "true"];
  }),
);

const month = args.month || new Date().toISOString().slice(0, 7);

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(resolve(process.cwd(), args.env || ".env.local")), ...process.env };

const archiveRoot = env.AWARDPING_VISUAL_SNAPSHOT_DIR || "D:\\AwardPingVisualSnapshots";
const byDay = new Map();

function add(date, kind, usd) {
  if (!date || !date.startsWith(month)) return;
  const day = byDay.get(date) || new Map();
  day.set(kind, (day.get(kind) || 0) + usd);
  byDay.set(date, day);
}

// 1) file ledger
const jsonlPath = join(archiveRoot, "usage", `gemini-usage-${month}.jsonl`);
if (existsSync(jsonlPath)) {
  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      add(r.date, `file:${r.kind || "unknown"}`, r.estimated_cost_usd || 0);
    } catch { /* skip malformed line */ }
  }
}

// 2) DB lane ledger
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  const supabase = createSupabaseServiceClient(url, key);
  const { data, error } = await supabase
    .from("gemini_spend_events")
    .select("budget_date, lane_key, spent_delta_micro_usd")
    .gte("budget_date", `${month}-01`)
    .lte("budget_date", `${month}-31`);
  if (error) {
    console.error("lane ledger unavailable:", error.message);
  } else {
    for (const r of data || []) {
      add(r.budget_date, `lane:${r.lane_key}`, (r.spent_delta_micro_usd || 0) / 1e6);
    }
  }
} else {
  console.error("lane ledger skipped: missing Supabase env");
}

const days = [...byDay.keys()].sort();
const kindTotals = new Map();
let monthTotal = 0;
console.log(`Gemini spend - ${month}`);
for (const d of days) {
  const kinds = byDay.get(d);
  const dayTotal = [...kinds.values()].reduce((a, b) => a + b, 0);
  monthTotal += dayTotal;
  console.log(`\n${d}  $${dayTotal.toFixed(4)}`);
  for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    kindTotals.set(k, (kindTotals.get(k) || 0) + v);
    console.log(`   ${k.padEnd(40)} $${v.toFixed(4)}`);
  }
}
console.log(`\n=== ${month} by kind ===`);
for (const [k, v] of [...kindTotals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(40)} $${v.toFixed(4)}`);
}
console.log(`\nMONTH TOTAL: $${monthTotal.toFixed(2)}`);
console.log("(Google AI Studio's spend page remains billing ground truth.)");
