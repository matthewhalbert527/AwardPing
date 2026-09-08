/**
 * Display-only formatting for reviewed award date facts.
 *
 * Reviewed facts are stored exactly as a human approved them. This turns raw
 * machine timestamps, complete written dates and recurring rules with times,
 * calendar-date ranges, and clearly delimited timeline dates into the same
 * house style. A recurring rule never becomes an inferred calendar date. Standalone
 * 12-hour clocks in prose get the same typography without rewriting prose.
 *
 * Nothing here changes what a date means:
 *   * the components are read straight out of the text, never through `Date`,
 *     so the host time zone can never shift the day and JS can never roll an
 *     impossible date forward (2026-02-30 stays untouched, not "March 2");
 *   * a date with no time stays a date — no midnight is invented;
 *   * a numeric offset is rendered as the offset it is. `-05:00` is NOT proof
 *     of Central Time (it is also Peru, Colombia, and Central daylight time),
 *     so it renders as "(UTC-05:00)" rather than a named zone. Only the input's
 *     own designator is trusted, and only `Z` is named, as "(UTC)";
 *   * a timestamp with no designator gets no zone claim at all, and an offset
 *     that is out of range, or the "offset unknown" form "-00:00", leaves the
 *     whole value unchanged rather than stating a zone that is not known;
 *   * a fractional second is reproduced digit for digit, never parsed into a
 *     number, so recorded precision is neither rounded nor truncated;
 *   * the explicit "(applicant's time zone)" qualifier stays exactly that;
 *     it is not a geographic zone and is never converted into one;
 *   * recognized recurring rules keep their wording while the clock separator
 *     and stated zone use the calendar-date style. Qualifiers and compound
 *     clock prose retain their meaning. Unsupported dates and fractional
 *     minutes are never guessed at or partially salvaged.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * A complete ISO-8601 calendar date, optionally with a time of day and an
 * explicit zone designator. Deliberately strict: a partial value such as
 * "2026-03" or a stray suffix leaves the string unrecognised. A fractional
 * part is captured, and only where ISO puts it — on the seconds. A fractional
 * minute ("17:00.5") is a form this helper does not render, so it stays
 * unrecognised rather than silently losing the fraction.
 */
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?[ ]?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

const ISO_DATE_RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/;
// This is reviewed wording observed on the Truman deadline, not a license to
// interpret arbitrary parenthetical prose or to override a stated UTC offset.
const APPLICANT_LOCAL_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) (\(applicant's time zone\))$/;

const CLOCK_12_SOURCE = String.raw`(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?[ \t]*([ap])\.?m\.?`;
const CLOCK_12_PATTERN = new RegExp(`^${CLOCK_12_SOURCE}$`, "i");
// Whole clock-shaped tokens only: never salvage 05pm from 17:05pm, 5pm from
// 5:00.5pm, or an AM/PM fragment embedded in an identifier or slash expression.
const CLOCK_IN_TEXT_PATTERN = new RegExp(
  String.raw`(?<![\w.:/+\-])${CLOCK_12_SOURCE}(?![\w.:/+-])`, "gi",
);
const WRITTEN_DATE_TIME_PATTERN =
  /^([A-Za-z]+ \d{1,2}, \d{4}|\d{1,2} [A-Za-z]+ \d{4})(?: at |, )(\d[^\n]*?[ap]\.?m\.?)(?: (.+))?$/i;
// Recognize the rule, not its next occurrence: there is deliberately no year
// calculation, weekday arithmetic, or arbitrary prose/date-prefix inference.
const RECURRING_RULE_SOURCE = String.raw`(?:First|Second|Third|Fourth|Fifth|Last) (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) in (?:${MONTH_NAMES.join("|")})(?: \d{4})?`;
const RECURRING_DATE_TIME_PATTERN = new RegExp(
  String.raw`^(${RECURRING_RULE_SOURCE})(?: at |, )(\d[^\n]*?[ap]\.?m\.?)(?: (.+))?$`, "i",
);
const RECURRING_DATE_START_PATTERN = new RegExp(String.raw`^${RECURRING_RULE_SOURCE}\b`, "i");
// SMART states its rule after the clock. Only this complete relation can be
// reordered; an explicitly stated year and zone remain exactly that, not an
// inferred occurrence or a regional conversion of a numeric offset.
const CLOCK_FIRST_RECURRING_SOURCE = String.raw`(\d[^\n]*?[ap]\.?m\.?)(?: (.+?))? on the (${RECURRING_RULE_SOURCE})`;
const CLOCK_FIRST_RECURRING_PATTERN = new RegExp(String.raw`^${CLOCK_FIRST_RECURRING_SOURCE}$`, "i");
const CLOCK_FIRST_RECURRING_START_PATTERN = new RegExp(String.raw`^${CLOCK_FIRST_RECURRING_SOURCE}\b`, "i");
const NAMED_ZONE_PATTERN = /^(?:UTC|GMT|PT|PST|PDT|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|HST|AKST|AKDT|BST|CET|CEST|IST|JST|AEST|AEDT|NZST|NZDT|(?:Eastern|Central|Pacific|Mountain)(?: (?:Standard |Daylight )?Time)?)$/i;
const LOCAL_ZONE_QUALIFIERS = new Set([
  "(applicant's time zone)",
  "(endorsing institution time zone)",
  "in the time zone of the endorsing institution",
]);

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function formatTimeOfDay(hour: number, minute: number, second: number, fraction: string | undefined) {
  const meridiem = hour < 12 ? "a.m." : "p.m.";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  // Fractional digits are reproduced exactly as written — never parsed into a
  // number, so arbitrary precision is neither rounded nor truncated. A nonzero
  // fraction carries information, so it also forces its own whole second to
  // show (":00.250"); an all-zero fraction says nothing and is dropped.
  const hasFraction = fraction !== undefined && /[1-9]/.test(fraction);
  const seconds = second > 0 || hasFraction
    ? `:${String(second).padStart(2, "0")}${hasFraction ? `.${fraction}` : ""}`
    : "";
  return `${hour12}:${String(minute).padStart(2, "0")}${seconds} ${meridiem}`;
}

/** The readable form of a present designator, or null when it is unsupported. */
function formatZoneDesignator(designator: string) {
  if (designator === "Z" || designator === "z") return "UTC";
  const sign = designator[0];
  const digits = designator.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2));
  if (hours > 23 || minutes > 59) return null;
  // RFC 3339 gives "-00:00" the specific meaning "offset unknown". It is not
  // UTC, and nothing here may imply that it is.
  if (sign === "-" && hours === 0 && minutes === 0) return null;
  return `UTC${sign}${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function formatTwelveHourClock(value: string) {
  const match = CLOCK_12_PATTERN.exec(value);
  if (!match) return null;
  const [, rawHour, rawMinute, rawSecond, fraction, meridiem] = match;
  const hour = Number(rawHour);
  const minute = Number(rawMinute ?? 0);
  const second = Number(rawSecond ?? 0);
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) return null;
  return formatTimeOfDay(hour % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0), minute, second, fraction);
}

/** Preserve zone identity; parentheses are presentation, never conversion. */
function formatWrittenZone(value: string) {
  if (LOCAL_ZONE_QUALIFIERS.has(value)) return value;
  const zone = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
  if (NAMED_ZONE_PATTERN.test(zone)) return `(${zone})`;
  const offset = /^(?:UTC)?([+-]\d{2}:?\d{2})$/.exec(zone);
  if (offset) {
    const formatted = formatZoneDesignator(offset[1]);
    return formatted ? `(${formatted})` : null;
  }
  return null;
}

/** One complete written calendar date, with no inferred time or year. */
function formatWrittenCalendarDate(value: string) {
  const monthFirst = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const rawDay = monthFirst?.[2] ?? dayFirst?.[1];
  const year = monthFirst?.[3] ?? dayFirst?.[3];
  if (!monthName || !rawDay || !year) return null;
  const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === monthName.toLowerCase());
  if (month < 0) return null;
  // Reuse the strict calendar validator; neither Date nor a host locale is used.
  return formatIsoValue(`${year}-${String(month + 1).padStart(2, "0")}-${rawDay.padStart(2, "0")}`);
}

function formatWrittenDateTime(value: string) {
  const match = WRITTEN_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;
  const [, date, clock, qualifier] = match;
  const calendarDate = formatWrittenCalendarDate(date);
  const time = formatTwelveHourClock(clock);
  if (!calendarDate || !time) return null;
  const zone = qualifier === undefined ? "" : formatWrittenZone(qualifier);
  if (zone === null) return null;
  return `${calendarDate} at ${time}${zone ? ` ${zone}` : ""}`;
}

/** Style one complete recurring rule without resolving it into a dated event. */
function formatRecurringDateTime(value: string) {
  const ruleFirst = RECURRING_DATE_TIME_PATTERN.exec(value);
  const clockFirst = ruleFirst ? null : CLOCK_FIRST_RECURRING_PATTERN.exec(value);
  if (!ruleFirst && !clockFirst) return null;
  const rule = ruleFirst ? ruleFirst[1] : clockFirst![3];
  const clock = ruleFirst ? ruleFirst[2] : clockFirst![1];
  const qualifier = ruleFirst ? ruleFirst[3] : clockFirst![2];
  const time = formatTwelveHourClock(clock);
  if (!time) return null;
  const zone = qualifier === undefined ? "" : formatWrittenZone(qualifier);
  if (zone === null) return null;
  // The moved rule now starts the sentence. No other wording/case is changed.
  const displayedRule = clockFirst ? rule[0].toUpperCase() + rule.slice(1) : rule;
  return `${displayedRule} at ${time}${zone ? ` ${zone}` : ""}`;
}

/** The readable form of one complete ISO value, or null when it is not one. */
function formatIsoValue(value: string) {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, fraction, designator] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  const calendarDate = `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
  if (rawHour === undefined) return calendarDate;

  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = rawSecond === undefined ? 0 : Number(rawSecond);
  // 24:00 and leap seconds are legal ISO but not renderable as a wall time.
  if (hour > 23 || minute > 59 || second > 59) return null;

  let zone: string | null = null;
  if (designator !== undefined) {
    zone = formatZoneDesignator(designator);
    // An offset this helper cannot state honestly leaves the value untouched.
    if (zone === null) return null;
  }

  const timeOfDay = formatTimeOfDay(hour, minute, second, fraction);
  return `${calendarDate} at ${timeOfDay}${zone ? ` (${zone})` : ""}`;
}

/** Recognize only a complete value; never replace ISO-looking substrings. */
function formatCompleteDateValue(value: string) {
  const formatted = formatIsoValue(value);
  if (formatted) return formatted;

  const written = formatWrittenDateTime(value);
  if (written) return written;

  const recurring = formatRecurringDateTime(value);
  if (recurring) return recurring;

  const writtenDate = formatWrittenCalendarDate(value);
  if (writtenDate) return writtenDate;

  const range = ISO_DATE_RANGE_PATTERN.exec(value);
  if (range) {
    const start = formatIsoValue(range[1]);
    const end = formatIsoValue(range[2]);
    // Both ends must be real dates in chronological order. Fixed-width ISO
    // calendar dates compare directly, without host-zone or Date conversion.
    if (!start || !end || range[1] > range[2]) return null;
    return `${start} to ${end}`;
  }

  const localTime = APPLICANT_LOCAL_TIME_PATTERN.exec(value);
  if (localTime) {
    const timestamp = formatIsoValue(localTime[1]);
    if (timestamp) return `${timestamp} ${localTime[2]}`;
  }

  return null;
}

/** The same recognition boundaries serve string formatting and DOM wrapping. */
function reviewedDateParts(value: string) {
  const trimmed = value.trim();
  const formatted = formatCompleteDateValue(trimmed);
  if (formatted) return { prefix: "", date: formatted, suffix: "" };

  // Date-first timeline entries have a clear boundary before the reviewer's
  // description. Preserve every word after it, including any embedded dates.
  // A leading date-shaped head must validate whole, including dates without
  // clocks. Never salvage a valid tail from an invalid, qualified, or ranged
  // head (for example "31 June 2026: 1 July 2026").
  if (/^\d{4}-/.test(trimmed) || /^(?:[A-Za-z]+ \d{1,2}, \d{4}|\d{1,2} [A-Za-z]+ \d{4})/.test(trimmed) || RECURRING_DATE_START_PATTERN.test(trimmed) || CLOCK_FIRST_RECURRING_START_PATTERN.test(trimmed)) {
    const separator = trimmed.indexOf(": ");
    if (separator > 0 && trimmed.slice(separator + 2).trim()) {
      const head = formatCompleteDateValue(trimmed.slice(0, separator));
      if (head) return { prefix: "", date: head, suffix: trimmed.slice(separator) };
    }
    return null;
  }

  // A reviewed item may label its date ("Interviews: 2026-03-27"). The label
  // is the reviewer's wording and is kept exactly; only the value is styled.
  const separator = trimmed.lastIndexOf(": ");
  if (separator > 0) {
    const label = trimmed.slice(0, separator);
    // A prior machine-date fragment may belong to an invalid range or a more
    // complex statement. Do not partially rewrite only its final valid date.
    if (/\d{4}-\d{2}/.test(label)) return null;
    const tail = formatCompleteDateValue(trimmed.slice(separator + 2).trim());
    if (tail) return { prefix: `${label}: `, date: tail, suffix: "" };
  }

  return null;
}

/** Unsupported reviewed wording always keeps the original string. */
function formatReviewedDateValue(value: string) {
  const parts = reviewedDateParts(value);
  return parts ? `${parts.prefix}${parts.date}${parts.suffix}` : value;
}

/**
 * Hold only the stated UTC token of an already-formatted date together.
 * Recognition uses the complete-date validator, not a substring search or
 * public formatter round-trip (unrecognized prose also round-trips there).
 * Labels and descriptions are never searched, and every input byte is kept.
 */
export function awardDateZoneSlices(value: string) {
  const parts = reviewedDateParts(value);
  if (!parts || `${parts.prefix}${parts.date}${parts.suffix}` !== value) return null;
  const zone = /\(UTC(?:[+-]\d{2}:\d{2})?\)$/.exec(parts.date);
  if (!zone) return null;
  return {
    prefix: parts.prefix + parts.date.slice(0, zone.index),
    zone: zone[0],
    suffix: parts.suffix,
  };
}

/** One deterministic house style for both machine and reviewed prose clocks. */
export function formatAwardDateText(value: string) {
  const formatted = formatReviewedDateValue(value);
  // Unsupported machine statements keep the previous all-or-nothing guard.
  if (formatted === value && /\b\d{4}-\d{2}/.test(value)) return value;
  // A whole written or recurring datetime with an invalid date/clock or an unrecognized
  // suffix is not a license to salvage just the clock from that statement.
  // A reviewer's label must not bypass that same all-or-nothing boundary.
  if (formatted === value) {
    const separator = value.lastIndexOf(": ");
    const candidates = [value.trim(), ...(separator > 0 ? [value.slice(separator + 2).trim()] : [])];
    if (candidates.some((candidate) =>
      (WRITTEN_DATE_TIME_PATTERN.test(candidate) && formatWrittenDateTime(candidate) === null)
      || (RECURRING_DATE_TIME_PATTERN.test(candidate) && formatRecurringDateTime(candidate) === null)
      || (CLOCK_FIRST_RECURRING_START_PATTERN.test(candidate) && formatRecurringDateTime(candidate) === null)
    )) return value;
  }
  return formatted.replace(CLOCK_IN_TEXT_PATTERN, (clock) => formatTwelveHourClock(clock) ?? clock);
}

/**
 * The same formatting across the shapes a public fact panel holds: one value,
 * a list of values, or nothing at all. Missing values stay missing, so a
 * caller's own "Not listed" fallback keeps working.
 */
export function formatAwardDateFact(value: string): string;
export function formatAwardDateFact(value: string[]): string[];
export function formatAwardDateFact(value: null | undefined): null;
export function formatAwardDateFact(
  value: string | string[] | null | undefined,
): string | string[] | null;
export function formatAwardDateFact(
  value: string | string[] | null | undefined,
): string | string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(formatAwardDateText);
  return formatAwardDateText(value);
}
