export const UPDATE_WINDOW_OPTIONS = [
  { value: "all", label: "All", days: null },
  { value: "day", label: "Last day", days: 1 },
  { value: "week", label: "Last week", days: 7 },
  { value: "month", label: "Last month", days: 30 },
  { value: "3months", label: "Last 3 months", days: 90 },
  { value: "6months", label: "Last 6 months", days: 180 },
  { value: "year", label: "Last year", days: 365 },
] as const;

type AwardUpdateInput = {
  changeCount: number | null;
  latestUpdateAt?: string | null;
};

/** Rolling elapsed-time windows, evaluated at the visitor's filter selection. */
export function awardMatchesUpdateWindow(award: AwardUpdateInput, window: string, nowMs: number) {
  if (window === "all") return true;
  const days = UPDATE_WINDOW_OPTIONS.find((option) => option.value === window)?.days;
  const count = award.changeCount;
  if (!days || !Number.isFinite(nowMs) || count === null || !Number.isInteger(count) || count <= 0) {
    return false;
  }

  // Like the card's Last update date, require a real, explicitly zoned
  // instant. Never substitute a source check or first information capture.
  const value = award.latestUpdateAt;
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value);
  if (!match || /-00:?00$/.test(value)) return false;
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= nowMs - days * 86_400_000 && timestamp <= nowMs;
}
