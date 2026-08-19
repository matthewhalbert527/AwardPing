// Award fact pipeline: draft -> byte-verify -> critic panel -> revise -> re-verify -> re-panel.
//
// Usage:
//   node scripts/run-award-fact-pipeline.mjs --manifest=<pipeline-manifest.json>
//     --outdir=<dir> [--model=gemini-3.7-flash] [--env=.env.local] [--only=<cohort_key>]
//
// Manifest shape: { <cohort_key>: { name, cycle, sources: { <source_id>:
//   { title, url, text_path, usable } }, usable, total } }
//
// Quotes are verified byte-exact against local capture text after every model
// call; a fact whose quote cannot be recovered verbatim is dropped and logged.
// Facts never ship from this script - it emits drafts, verdicts, and an
// exception queue for human review.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...rest] = a.slice(2).split("=");
    return [k, rest.join("=") || "true"];
  }),
);

const root = process.cwd();
const model = args.model || "gemini-3.7-flash";
const outdir = resolve(root, args.outdir || "reports/stage1-review-session-2026-08-18/facts");
mkdirSync(outdir, { recursive: true });

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(resolve(root, args.env || ".env.local")), ...process.env };
const apiKey = env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY missing");

const policy = readFileSync(resolve(root, "docs/fact-editorial-policy.md"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, args.manifest), "utf8"));

const FIELDS = ["overview", "deadline", "opening_date", "award_amounts", "eligibility",
  "requirements", "application_materials", "how_to_apply", "important_dates",
  "documents", "contacts", "academic_levels", "disciplines", "citizenship"];

const factSchema = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: FIELDS },
          value: { type: "string" },
          quote: { type: "string" },
          source_id: { type: "string" },
        },
        required: ["field", "value", "quote", "source_id"],
      },
    },
  },
  required: ["facts"],
};

const verdictSchema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          verdict: { type: "string", enum: ["pass", "fail"] },
          reason: { type: "string" },
          suggested_fix: { type: "string" },
        },
        required: ["field", "verdict", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

const usageTotal = { in: 0, out: 0, calls: 0 };

async function gemini(prompt, schema, temperature = 0.1) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema },
        }),
      },
    );
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, attempt * 4000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const usage = body?.usageMetadata || {};
    usageTotal.in += usage.promptTokenCount || 0;
    usageTotal.out += usage.candidatesTokenCount || 0;
    usageTotal.calls += 1;
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    return JSON.parse(text);
  }
  throw new Error("Gemini retries exhausted");
}

function verifyQuotes(facts, texts) {
  const verified = [];
  const dropped = [];
  for (const f of facts) {
    const t = texts[f.source_id];
    if (!t) { dropped.push({ ...f, why: "unknown source" }); continue; }
    let q = f.quote;
    if (!t.includes(q)) {
      const parts = q.trim().split(/\s+/).map((p) =>
        p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['\u2019\u0092]/g, "['\u2019\u0092]"));
      const m = new RegExp(parts.join("\\s+")).exec(t);
      if (m) q = m[0];
      else { dropped.push({ ...f, why: "quote not in capture" }); continue; }
    }
    const start = t.indexOf(q);
    verified.push({ ...f, quote: q, start, end: start + q.length });
  }
  return { verified, dropped };
}

const LENSES = [
  ["evidence_support", "Judge ONLY semantic evidence support: is each value fully supported by its quote with no extrapolation?"],
  ["field_semantics", "Judge ONLY field placement per the field contracts. A true fact in the wrong field fails."],
  ["style_register", "Judge ONLY register and self-containedness (global rules 2 and 7)."],
  ["actionability_completeness", "Judge ONLY actionability and padding/omission (global rules 4, 5, 8)."],
  ["cycle_freshness", "Judge ONLY dates and cycle (global rule 6)."],
];

async function panel(award, facts) {
  const failures = [];
  for (const [lens, instruction] of LENSES) {
    const out = await gemini([
      "You are one critic on an editorial panel for published scholarship facts.",
      `Lens: ${lens}. ${instruction}`,
      "Judge every fact; emit one verdict per fact using its `field` verbatim.",
      "Only fail facts for problems within your lens.",
      "=== EDITORIAL POLICY ===", policy,
      `=== AWARD: ${award} - DRAFT FACTS (JSON) ===`, JSON.stringify(facts, null, 1),
    ].join("\n"), verdictSchema);
    for (const v of out.verdicts || []) {
      if (v.verdict === "fail") failures.push({ lens, ...v });
    }
  }
  return failures;
}

function excerpt(text, max = 42000) {
  return text.length <= max ? text : text.slice(0, max) + "\n[...capture truncated for drafting...]";
}

const only = args.only;
const summary = [];
for (const [key, award] of Object.entries(manifest)) {
  if (only && key !== only) continue;
  const texts = {};
  const sourceBlocks = [];
  for (const [sid, s] of Object.entries(award.sources)) {
    if (!s.usable) continue;
    const t = readFileSync(s.text_path, "utf8");
    texts[sid] = t;
    sourceBlocks.push(`--- SOURCE ${sid}\ntitle: ${s.title}\nurl: ${s.url}\n${excerpt(t)}`);
  }
  if (!sourceBlocks.length) {
    summary.push({ award: key, status: "skipped_no_usable_captures" });
    console.log(`${key}: SKIP (no usable captures)`);
    continue;
  }

  console.log(`${key}: drafting from ${sourceBlocks.length} captures...`);
  try {
    const draft = await gemini([
      "Extract publishable facts for this award from the captured official pages below.",
      "Follow the editorial policy exactly: neutral register, right-field discipline,",
      "actionable routing fields, cycle-explicit dates, applicant point of view.",
      "Every fact needs `quote`: a VERBATIM substring copied character-for-character from",
      "one source below (including its line breaks and odd characters), and `source_id`",
      "naming that source. Never paraphrase inside `quote`. Prefer omission over padding;",
      "emit list-like fields as multiple facts with the same `field`.",
      `Award: ${award.name} (cycle ${award.cycle})`,
      "=== EDITORIAL POLICY ===", policy,
      "=== CAPTURED SOURCES ===", ...sourceBlocks,
    ].join("\n"), factSchema, 0.2);

    let { verified, dropped } = verifyQuotes(draft.facts || [], texts);
    let failures = await panel(award.name, verified);
    let final = verified;
    let round2 = null;

    if (failures.length) {
      const revised = await gemini([
        "Revise this draft fact sheet to resolve the panel failures below.",
        "Keep every passing fact unchanged. For each failure: fix the value, move the",
        "fact to the correct field, or delete it. Quotes must remain VERBATIM substrings",
        "of the original captures - reuse existing quotes or select new verbatim ones.",
        "=== EDITORIAL POLICY ===", policy,
        `=== AWARD: ${award.name} - CURRENT FACTS ===`, JSON.stringify(verified, null, 1),
        "=== PANEL FAILURES ===", JSON.stringify(failures, null, 1),
        "=== CAPTURED SOURCES ===", ...sourceBlocks,
      ].join("\n"), factSchema, 0.2);
      const v2 = verifyQuotes(revised.facts || [], texts);
      dropped = dropped.concat(v2.dropped);
      round2 = await panel(award.name, v2.verified);
      final = v2.verified;
      failures = round2;
    }

    writeFileSync(join(outdir, `${key}.json`), JSON.stringify({
      award: award.name, cycle: award.cycle, status: "ok",
      facts: final, dropped_quotes: dropped, exceptions: failures,
    }, null, 1));
    summary.push({ award: key, status: "ok", facts: final.length, dropped: dropped.length, exceptions: failures.length });
    console.log(`${key}: ${final.length} facts, ${dropped.length} dropped quotes, ${failures.length} exceptions`);
  } catch (err) {
    summary.push({ award: key, status: "error", error: String(err).slice(0, 200) });
    console.log(`${key}: ERROR ${String(err).slice(0, 160)}`);
  }
}


function appendUsageLedger(kind, model, usage, estCostUsd) {
  try {
    const archiveRoot = env.AWARDPING_VISUAL_SNAPSHOT_DIR || "D:\AwardPingVisualSnapshots";
    const dir = resolve(archiveRoot, "usage");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const record = {
      used_at: now, date: now.slice(0, 10), month: now.slice(0, 7),
      provider: "gemini", kind, model, api_mode: "standard",
      usage: { prompt_tokens: usage.in, candidates_tokens: usage.out },
      estimated_cost_usd: estCostUsd,
    };
    appendFileSync(resolve(dir, `gemini-usage-${record.month}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error("usage ledger append failed:", String(err).slice(0, 120));
  }
}

const cost = (usageTotal.in * 0.75 + usageTotal.out * 3.75) / 1e6;
appendUsageLedger("editorial_pipeline", model, usageTotal, cost);
writeFileSync(join(outdir, "_summary.json"), JSON.stringify({ model, usage: usageTotal, est_cost_usd: cost, summary }, null, 1));
console.log(`PIPELINE_DONE calls=${usageTotal.calls} tokens_in=${usageTotal.in} tokens_out=${usageTotal.out} est_cost=$${cost.toFixed(3)}`);
