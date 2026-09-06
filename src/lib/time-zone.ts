export const AWARDPING_TIME_ZONE = "America/Chicago";
export const AWARDPING_TIME_ZONE_LABEL = "Central Time";

type DateValue = Date | number | string | null | undefined;

const defaultDateOptions: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

const defaultDateTimeOptions: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

export function formatCentralDate(
  value: DateValue,
  options: Intl.DateTimeFormatOptions = defaultDateOptions,
) {
  return formatCentral(value, options);
}

export function formatCentralDateTime(
  value: DateValue,
  options: Intl.DateTimeFormatOptions = defaultDateTimeOptions,
) {
  return formatCentral(value, options);
}

export function centralDateKey(value: DateValue) {
  const date = toValidDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AWARDPING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

export const DATE_UNAVAILABLE_LABEL = "Date unavailable";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Relative labels run through this many whole days; then a date takes over. */
const RELATIVE_DAY_LIMIT = 14;

export type TimestampDescription = {
  /** Canonical millisecond ISO form for a `dateTime` attribute; null when not a date. */
  dateTime: string | null;
  /** Full Central date and time with zone, for titles and assistive text. */
  full: string;
  /** Central calendar day key, or "" when the value is not a date. */
  dateKey: string;
};

export type DetectedAtDescription = TimestampDescription & {
  /** Compact label for dense rows: relative through 14 days, then a date. */
  compact: string;
};

export function describeTimestamp(value: DateValue): TimestampDescription {
  const date = toValidDate(value);
  if (!date) return { dateTime: null, full: DATE_UNAVAILABLE_LABEL, dateKey: "" };
  return {
    // Every valid input, including database timestamps with microseconds,
    // is emitted in the standard millisecond ISO form HTML accepts.
    dateTime: date.toISOString(),
    full: formatCentralDateTime(date),
    dateKey: centralDateKey(date),
  };
}

// One explicit `now` per render keeps every label on a page consistent and
// keeps rendering pure. Thresholds are floored: minutes below an hour, hours
// below a day, whole days through the limit, then a Central date that omits
// the year only inside the current Central year. A timestamp ahead of `now`
// (clock skew) reads as "Just now".
export function describeDetectedAt(value: DateValue, now: DateValue): DetectedAtDescription {
  const description = describeTimestamp(value);
  const date = toValidDate(value);
  if (!date) return { ...description, compact: DATE_UNAVAILABLE_LABEL };
  return { ...description, compact: compactDetectedLabel(date, toValidDate(now)) };
}

// The Central calendar day before a `YYYY-MM-DD` key, computed on the calendar
// rather than by subtracting 24 hours, so DST transitions never skip or
// repeat a day.
export function previousCentralDateKey(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return "";
  const previous = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1));
  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, "0"),
    String(previous.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function compactDetectedLabel(date: Date, now: Date | null) {
  if (!now) return absoluteCompactLabel(date, null);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return "Just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days <= RELATIVE_DAY_LIMIT) return `${days}d ago`;
  return absoluteCompactLabel(date, now);
}

function absoluteCompactLabel(date: Date, now: Date | null) {
  const sameCentralYear =
    now !== null && centralDateKey(date).slice(0, 4) === centralDateKey(now).slice(0, 4);
  return formatCentralDate(
    date,
    sameCentralYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

function formatCentral(value: DateValue, options: Intl.DateTimeFormatOptions) {
  const date = toValidDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone: AWARDPING_TIME_ZONE,
  }).format(date);
}

function toValidDate(value: DateValue) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
