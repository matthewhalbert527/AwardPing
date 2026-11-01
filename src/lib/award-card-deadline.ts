import { formatAwardDateText } from "@/lib/award-date-display";
import type { AwardDeadlinePresentation } from "@/lib/award-page-presentation";

export type AwardCardDeadline = {
  label: string;
  date: string;
  time: string | null;
  closedCycle: boolean;
};

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const recurringDate = new RegExp(`^(?:First|Second|Third|Fourth|Fifth|Last) (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) in (?:${months.join("|")})(?: \\d{4})?$`, "i");
const namedZone = /^(?:UTC|GMT|PT|PST|PDT|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|HST|AKST|AKDT|BST|CET|CEST|IST|JST|AEST|AEDT|NZST|NZDT|(?:Eastern|Central|Pacific|Mountain)(?: (?:Standard |Daylight )?Time)?)$/i;
const localZones = new Set(["applicant's time zone", "endorsing institution time zone"]);
const localZonePhrases = new Set([
  ", your time zone",
  " in the endorsing institution's time zone",
  " in the endorsing institution’s time zone",
]);
const genericLabel = /^(?:Application )?Deadlines?$/i;

function simpleScopePrefix(value: string) {
  // The entry is already an application deadline. Lift a single exact scope,
  // never a conditional clause, another event category, or part of a date range.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &/'’().,\-—–]*$/u.test(value)) return false;
  if (/\b(?:if|unless|dependent|depending|tentative|unconfirmed|usually|typically|may|might|except|and|or|subject to|interviews?|outcomes?|results?|notifications?|opening|opens?)\b/i.test(value)) return false;
  if (new RegExp(`\\b(?:${months.join("|")})\\b|\\d{4}-\\d{2}`, "i").test(value)) return false;
  return (value.match(/\b\d{4}\b/g) ?? []).length <= 1;
}

/** Shorten only redundant category words, retaining the exact reviewed scope. */
function displayLabel(label: string) {
  if (/^(?:\d{4} )?(?:(?:National|Institutional|Campus|Internal) )?nomination deadline$/i.test(label)) {
    return label.slice(0, -" deadline".length);
  }
  const application = /^(Application) deadline(?: (?:—|–|--) (.+))?$/i.exec(label);
  if (!application) return label;
  const scope = application[2];
  if (!scope) return application[1];
  // Conditional/compound labels keep their full wording and punctuation.
  if (/[():;\r\n—–]|--|\b(?:if|unless|dependent|depending|tentative|unconfirmed|usually|typically|may|might|except|and|or|subject to)\b/i.test(scope)) return label;
  const season = /^((?:Spring|Summer|Fall|Autumn|Winter) \d{4}) cycle$/i.exec(scope);
  return `${application[1]} · ${season?.[1] ?? scope}`;
}

/** Reuse the house formatter's calendar rules; never resolve a recurring rule. */
function completeDate(value: string) {
  if (recurringDate.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatAwardDateText(value) !== value;
  const monthFirst = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const day = monthFirst?.[2] ?? dayFirst?.[1];
  const year = monthFirst?.[3] ?? dayFirst?.[3];
  if (!monthName || !day || !year) return false;
  const month = months.findIndex((name) => name.toLowerCase() === monthName.toLowerCase()) + 1;
  if (!month) return false;
  const iso = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return formatAwardDateText(iso) === formatAwardDateText(value);
}

function explicitTime(value: string) {
  // Presented clocks only: leave malformed/compound clocks and extra prose whole.
  const match = /^(?:[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)? [ap]\.m\.(.*)$/i.exec(value);
  if (!match) return false;
  if (!match[1]) return true;
  if (localZonePhrases.has(match[1].toLowerCase())) return true;
  const qualifier = /^ ?\(([^()]+)\)$|^ ([^()]+)$/.exec(match[1]);
  if (!qualifier) return false;
  const zone = qualifier[1] ?? qualifier[2];
  if (namedZone.test(zone) || localZones.has(zone)) return true;
  const offset = /^(?:UTC)?([+-])(\d{2}):(\d{2})$/.exec(zone);
  return Boolean(offset && Number(offset[2]) <= 23 && Number(offset[3]) <= 59 && !(offset[1] === "-" && offset[2] === "00" && offset[3] === "00"));
}

/**
 * Split already-presented card copy into visual lines, without changing facts.
 * Only one complete date/recurring rule plus a terminal explicit clock can split.
 * Unknown, conditional, ranged or multiply qualified wording stays together.
 * A past date is not evidence that its application cycle is closed.
 */
export function presentAwardCardDeadline(
  entry: AwardDeadlinePresentation["entries"][number],
): AwardCardDeadline {
  const original: AwardCardDeadline = { label: displayLabel(entry.label), date: entry.value, time: null, closedCycle: false };
  if (/[\r\n]/.test(entry.value)) return original;
  const closed = /^(.+?) (?:--|—) closed cycle$/i.exec(entry.value);
  const closedCycle = Boolean(closed && !/\bclosed cycle\b/i.test(closed[1]));
  const value = closedCycle ? closed![1] : entry.value;
  const fallback = { ...original, date: value, closedCycle };
  const prefix = /^([^:]+): (.+)$/.exec(value);
  const scope = prefix && simpleScopePrefix(prefix[1]) ? prefix[1] : null;
  // Retain every cycle/track already in the entry label. Conflicting scopes
  // cannot be replaced by a more convenient generic card label.
  if (scope && !genericLabel.test(entry.label) && entry.label !== scope) return fallback;
  const dateValue = scope ? prefix![2] : value;
  const timed = /^(.+) at (.+)$/.exec(dateValue);
  if (timed && completeDate(timed[1]) && explicitTime(timed[2])) {
    return { label: displayLabel(scope ?? entry.label), date: timed[1], time: timed[2], closedCycle };
  }
  if (completeDate(dateValue)) return { label: displayLabel(scope ?? entry.label), date: dateValue, time: null, closedCycle };
  return fallback;
}
