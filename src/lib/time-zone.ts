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
