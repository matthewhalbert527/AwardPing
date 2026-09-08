/**
 * Display-only formatting for reviewed award date facts.
 *
 * Reviewed facts are stored exactly as a human approved them, and most already
 * read well ("Last Friday in January, 5:00 p.m. Central Time"). A few carry a
 * raw machine timestamp instead, which is unreadable on a public card. This
 * turns ONLY that shape into the same house style and leaves every other
 * string byte-for-byte alone.
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
 *   * anything unrecognised — prose, recurring rules, "Rolling", "TBA",
 *     partial dates, a fractional minute — is returned unchanged rather than
 *     guessed at.
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

/**
 * One reviewed date fact, made readable. Returns the input unchanged whenever
 * it is not a machine timestamp this helper fully understands.
 */
export function formatAwardDateText(value: string) {
  const trimmed = value.trim();
  const formatted = formatIsoValue(trimmed);
  if (formatted) return formatted;

  // A reviewed item may label its date ("Interviews: 2026-03-27"). The label
  // is the reviewer's wording and is kept exactly; only the value is styled.
  const separator = trimmed.lastIndexOf(": ");
  if (separator > 0) {
    const tail = formatIsoValue(trimmed.slice(separator + 2).trim());
    if (tail) return `${trimmed.slice(0, separator)}: ${tail}`;
  }

  return value;
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
