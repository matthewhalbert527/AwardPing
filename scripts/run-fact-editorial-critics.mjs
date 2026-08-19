// Fact editorial critic panel: judges a draft award fact sheet against
// docs/fact-editorial-policy.md with five independent Gemini critics.
//
// Usage:
//   node scripts/run-fact-editorial-critics.mjs --draft=<draft.json> [--model=gemini-3.7-flash]
//     [--env=.env.local] [--output=<verdicts.json>]
//
// Draft JSON shape: { award: string, facts: [{ field, value, quote, source_title }] }
//
// Safety: read-only against the filesystem; makes exactly five Gemini
// generateContent calls (one per critic lens) per invocation. No database or
// R2 access. Intended for operator runs and the editorial regression suite;
// production-scale runs should prefer the batch API per worker policy.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...rest] = a.slice(2).split("=");
    return [k, rest.join("=") || "true"];
  }),
);

const root = process.cwd();
const envPath = resolve(root, args.env || ".env.local");
const draftPath = resolve(root, args.draft || "");
const model = args.model || "gemini-3.7-flash";
const outputPath = resolve(
  root,
  args.output || draftPath.replace(/\.json$/, "") + `.verdicts.${model}.json`,
);

if (!args.draft || !existsSync(draftPath)) {
  console.error("Usage: node scripts/run-fact-editorial-critics.mjs --draft=<draft.json>");
  process.exit(2);
}

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(envPath), ...process.env };
const apiKey = env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`GEMINI_API_KEY not found in ${envPath} or process env.`);
  process.exit(2);
}

const policy = readFileSync(resolve(root, "docs/fact-editorial-policy.md"), "utf8");
const draft = JSON.parse(readFileSync(draftPath, "utf8"));

const LENSES = [
  ["evidence_support", "Judge ONLY semantic evidence support: is each value fully supported by its quote with no extrapolation beyond what the quote states?"],
  ["field_semantics", "Judge ONLY field placement: does each fact satisfy the contract of the field it is filed under? A true fact in the wrong field fails."],
  ["style_register", "Judge ONLY register and self-containedness (global rules 2 and 7): neutral tone, no promotional or evaluative language, no references a reader cannot resolve."],
  ["actionability_completeness", "Judge ONLY actionability and completeness (global rules 4, 5, 8): routing fields must carry their actionable artifact; flag padding, and flag clearly-supported facts that are missing."],
  ["cycle_freshness", "Judge ONLY dates and cycle (global rule 6): years present, current cycle, timezone where the source gives one."],
];

const responseSchema = {
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
    missing_facts: { type: "array", items: { type: "string" } },
  },
  required: ["verdicts"],
};

async function critic(lens, instruction) {
  const prompt = [
    "You are one critic on an editorial panel for published scholarship facts.",
    `Your lens: ${lens}. ${instruction}`,
    "Apply the editorial policy below strictly. Judge every fact in the draft;",
    "emit one verdict per fact (use the fact's `field` value verbatim).",
    "Only report failures your lens is responsible for; pass everything else.",
    "",
    "=== EDITORIAL POLICY ===",
    policy,
    "",
    "=== DRAFT FACT SHEET (JSON) ===",
    JSON.stringify(draft, null, 1),
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`${lens}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const usage = body?.usageMetadata || {};
  return { lens, ...JSON.parse(text), usage: { in: usage.promptTokenCount, out: usage.candidatesTokenCount } };
}

const results = [];
for (const [lens, instruction] of LENSES) {
  process.stderr.write(`critic: ${lens}...\n`);
  results.push(await critic(lens, instruction));
}

const failures = [];
for (const r of results) {
  for (const v of r.verdicts || []) {
    if (v.verdict === "fail") failures.push({ lens: r.lens, ...v });
  }
  for (const miss of r.missing_facts || []) {
    failures.push({ lens: r.lens, field: "(missing)", verdict: "fail", reason: miss });
  }
}

const tokens = results.reduce(
  (acc, r) => ({ in: acc.in + (r.usage.in || 0), out: acc.out + (r.usage.out || 0) }),
  { in: 0, out: 0 },
);

writeFileSync(outputPath, JSON.stringify({ model, draft: draftPath, results, failures }, null, 1));
console.log(`model=${model} tokens_in=${tokens.in} tokens_out=${tokens.out}`);
console.log(`failures=${failures.length} -> ${outputPath}`);
for (const f of failures) {
  console.log(`  [${f.lens}] ${f.field}: ${f.reason}${f.suggested_fix ? ` | fix: ${f.suggested_fix}` : ""}`);
}
