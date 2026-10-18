import { formatAwardDateText } from "@/lib/award-date-display";
import { presentAwardDateField, presentAwardTimelineDate } from "@/lib/award-date-presentation";
import { parseChangeDetails } from "@/lib/change-details";
import type { PublicAwardFacts } from "@/lib/public-award-facts";

export type AwardDeadlinePresentation = {
  label: string;
  entries: Array<{ label: string; value: string; status: "past" | "listed" }>;
  notice: string | null;
};

/** Display projection only. No inferred next cycle, dates or applicant groups. */
export function presentAwardDeadlines(
  facts: { deadline?: string | null; importantDates?: string[] },
  awardName?: string,
  now?: Date,
): AwardDeadlinePresentation {
  const direct = presentAwardDateField(facts.deadline, awardName);
  const candidates = direct.value ? [{ label: direct.label, value: direct.value }] : [];
  for (const value of facts.importantDates || []) {
    const item = applicationDeadlineItem(value, awardName);
    if (item) candidates.push(item);
  }
  const seen = new Set<string>();
  const entries = candidates.filter((item) => {
    // Only exact displayed values with equivalent generic labels collapse.
    // Distinct rounds, qualifiers and program scopes never get merged.
    const label = /^(?:Application )?Deadline$/i.test(item.label) ? "deadline" : item.label;
    const key = `${label}\n${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((entry) => ({ ...entry, status: definitelyPast(entry.value, now) ? "past" as const : "listed" as const }));
  const allPast = entries.length > 0 && entries.every((entry) => entry.status === "past");
  return {
    label: entries.length > 1 ? "Application deadlines" : entries[0]?.label || "Application deadline",
    entries,
    notice: allPast
      ? `The listed ${entries.length === 1 ? "deadline has" : "deadlines have"} passed. A later deadline is not confirmed here.`
      : entries.length === 0 ? "No application deadline is recorded here. Check the official award site." : null,
  };
}

function applicationDeadlineItem(value: string, awardName?: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  // Gates' reviewed timeline puts the event kind AFTER the date and audience.
  // Remove only that exact category suffix, never the date's scope or conditions.
  const suffix = /^(.*):\s*(Application deadline)\.?$/i.exec(clean);
  if (suffix) return { label: "Application deadline", value: presentAwardTimelineDate(suffix[1], awardName) };
  const prefix = /^((?:Applications? (?:deadline|due|close)|Deadline for applications?|Application submission deadline)(?:\s+[^:]*)?):\s*(.+)$/i.exec(clean);
  if (prefix) return { label: prefix[1], value: presentAwardTimelineDate(prefix[2], awardName) };
  // Other wording is retained whole only if it explicitly calls itself an
  // application deadline. Interviews, outcomes and document dates stay secondary.
  if (/\bapplication deadline\b/i.test(clean)) {
    return { label: "Application deadline", value: presentAwardTimelineDate(clean, awardName) };
  }
  return null;
}

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const calendarToken = new RegExp(`\\b(?:(${months.join("|")}) (\\d{1,2}), (\\d{4})|(\\d{1,2}) (${months.join("|")}) (\\d{4})|(\\d{4})-(\\d{2})-(\\d{2}))\\b`, "gi");

function definitelyPast(value: string, now?: Date) {
  if (!now || !Number.isFinite(now.getTime())) return false;
  // A conditional or recurring rule is not proof that the award is closed.
  if (/\b(?:every|annual|annually|recurring|rolling|varies|tba|tbd|unconfirmed|tentative|usually|typically|later|extended|extensions?|provisional)\b/i.test(value)) return false;
  const matches = [...value.matchAll(calendarToken)];
  if (!matches.length) return false;
  // One recognized date must not hide a second partial/unsupported date.
  const remaining = value.replace(calendarToken, "");
  if (new RegExp(`\\b(?:${months.join("|")})\\b`, "i").test(remaining)) return false;
  return matches.every((match) => {
    const month = match[1] || match[5];
    const year = match[3] || match[6] || match[7];
    const day = match[2] || match[4] || match[9];
    const monthNumber = month ? months.findIndex((name) => name.toLowerCase() === month.toLowerCase()) + 1 : Number(match[8]);
    const iso = `${year}-${String(monthNumber).padStart(2, "0")}-${day.padStart(2, "0")}`;
    // Reuse the house formatter's calendar validation; impossible dates cannot
    // roll forward through JavaScript's Date normalization.
    if (formatAwardDateText(iso) === iso) return false;
    // End of that calendar day in UTC-12: conservative across all time zones.
    // We intentionally don't claim the precise cutoff or "applications closed".
    const latestEnd = Date.parse(`${iso}T00:00:00Z`) + 36 * 60 * 60 * 1000;
    return now.getTime() > latestEnd;
  });
}

export type AwardFactCurrentnessNotice = {
  kind: "possible_conflict";
  title: string;
  message: string;
  changeId: string;
  detectedAt: string;
  fields: string[];
};

/**
 * An advisory comparison of displayed facts with already-public retained
 * before/after evidence. Never rewrites facts, approves evidence or promises
 * that a null result means current. It deliberately catches only exact old
 * wording or explicit changed date windows, not broad AI semantic guesses.
 */
export function awardFactCurrentness(input: {
  facts: PublicAwardFacts;
  changes: Array<{ id: string; detectedAt: string; changeDetails?: unknown }>;
  factsReviewedAt?: string | null;
}): AwardFactCurrentnessNotice | null {
  const fields = Object.entries(input.facts).flatMap(([key, value]) =>
    typeof value === "string" ? [{ key, value: normalize(value) }]
      : Array.isArray(value) ? value.map((item) => ({ key, value: normalize(item) })) : [],
  ).filter((field) => field.key !== "confidence");
  for (const change of input.changes) {
    const details = parseChangeDetails(change.changeDetails);
    if (!details || details.event_kind === "new_official_document" || !details.is_alert_worthy) continue;
    const before = [details.exact_before, details.before, ...details.structured_diff.removed_text].filter((value): value is string => Boolean(value));
    const after = [details.exact_after, details.after, ...details.structured_diff.added_text].filter((value): value is string => Boolean(value));
    if (!before.length || !after.length) continue;
    const oldText = normalize(before.join(" "));
    const newText = normalize(after.join(" "));
    if (oldText === newText) continue;
    const candidates = before.flatMap((value) => [
      ...(normalize(value).split(" ").length >= 6 ? [normalize(value)] : []),
      ...explicitDateWindows(value).map(normalize),
    ]).filter((value) => value && !newText.includes(value));
    const affected = fields.filter((field) =>
      candidates.some((candidate) => field.value.includes(candidate)) ||
      (field.value.split(" ").length >= 6 && oldText.includes(field.value) && !newText.includes(field.value)),
    );
    if (!affected.length) continue;
    return {
      kind: "possible_conflict",
      title: "Some details may be out of date",
      message: "A recorded update changes wording still present in these details. Review the update and official source before applying.",
      changeId: change.id,
      detectedAt: change.detectedAt,
      fields: [...new Set(affected.map((field) => field.key))],
    };
  }
  return null;
}

function explicitDateWindows(value: string) {
  const pattern = new RegExp(`\\b(?:${months.join("|")}) \\d{4} (?:and|to|through|–|-) (?:${months.join("|")}) \\d{4}\\b`, "gi");
  return [...value.replace(/\s+/g, " ").matchAll(pattern)].map((match) => match[0]);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
}
