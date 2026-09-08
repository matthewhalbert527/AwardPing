/**
 * Display-only scope projection for reviewed award dates.
 *
 * One published award record can cover two application tracks. Boren is the
 * live example: the page is "Boren Scholarships and Fellowships", and the
 * reviewed date facts name the track each date belongs to, so a visitor can
 * tell which one they are reading. Rendered literally that becomes
 * "January 27, 2027 (Boren Scholarships)" underneath a "Deadline" label — the
 * brand is said twice while the part that carries the meaning, the track,
 * hides inside a parenthetical.
 *
 * This lifts the track into the label ("Scholarships deadline"), or in front
 * of a timeline date ("Fellowships: January 20, 2027"), and drops a
 * parenthetical that only repeats the award's own name. It is a projection of
 * text a reviewer approved, never a rewrite of it: the stored fact is
 * untouched, and every value this file does not positively recognize is handed
 * to `formatAwardDateText` whole.
 *
 * The rules it will not bend:
 *   * recognition needs BOTH an exact terminal `(program identity)` and, in
 *     front of it, one complete calendar date — with nothing else in between;
 *   * a program identity is matched by exact string equality, against the
 *     award's own name or against a small hand-written registry. No substring,
 *     prefix, conjunction-splitting or singularization guessing, so an award
 *     nobody registered can never have words deleted by accident;
 *   * date validity and house style are decided by `formatAwardDateText`,
 *     never re-implemented here and never through `Date`. Leap years, month
 *     lengths, zone designators and the rendered wording stay defined in
 *     exactly one place, and no date is written down in this file;
 *   * every other qualifier a reviewer wrote is meaning, not noise.
 *     "(applicant's time zone)", "(endorsing institution time zone)",
 *     "(dependent on course)" and a "(UTC-05:00)" this file never produced all
 *     fail recognition and survive intact through the fallback;
 *   * a nested parenthetical, a non-terminal one, a range, a labelled item, a
 *     partial or impossible date, and any appended prose all fall back with
 *     the WHOLE original suffix preserved;
 *   * a timeline entry stays a timeline entry. Nothing here infers that a date
 *     is a deadline, an opening, or any other category.
 */

import { formatAwardDateText } from "@/lib/award-date-display";

/**
 * The scopes a combined award may present, keyed by the exact award name and
 * then by the exact program identity a reviewer wrote in the fact.
 *
 * Hand-written on purpose. Every entry is a decision that the official
 * homepage shows these as two tracks of one program, so the shared brand can
 * be dropped and the track kept. Adding an award means adding it here; there
 * is deliberately no rule that could infer one.
 */
const PRESENTATION_SCOPES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "Boren Scholarships and Fellowships",
    new Map([
      ["Boren Scholarships", "Scholarships"],
      ["Boren Fellowships", "Fellowships"],
    ]),
  ],
]);

/** The field labels a caller may pass, and how each reads after a scope. */
const SCOPED_FIELD_LABEL = {
  Deadline: "deadline",
  "Opening date": "opening date",
} as const;

export type AwardDateFieldLabel = keyof typeof SCOPED_FIELD_LABEL;

export type AwardDateFieldPresentation = {
  label: string;
  value: string | null;
};

/**
 * A program identity in its own parentheses at the very end of the value, with
 * exactly one complete date in front of it.
 *
 * `[^()]` keeps the identity flat, so a nested parenthetical never matches as
 * one: "January 27, 2027 (Boren Scholarships (US))" backtracks to a head of
 * "January 27, 2027 (Boren Scholarships", which is not a date, and the value
 * falls back untouched.
 */
const TERMINAL_PROGRAM_IDENTITY_PATTERN = /^(.+) \(([^()]+)\)$/;

/** "January 27, 2027". Shape only — the month, day and year are checked below. */
const MONTH_NAME_DATE_SHAPE_PATTERN = /^[A-Za-z]+ (\d{1,2}), (\d{4})$/;

/**
 * A machine date, and nothing else. The only whitespace this admits is the one
 * ISO separator between date and time, which is what keeps a multi-date or
 * labelled value out: every such form `formatAwardDateText` understands — the
 * "A to B" range, the "(applicant's time zone)" suffix, a "label: value" item
 * — needs whitespace this shape does not allow.
 */
const MACHINE_DATE_SHAPE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ][^\s()]+)?$/;

/**
 * The house-style rendering of one complete month-name date, or null.
 *
 * Validity is not computed here. Each of the twelve months is offered to
 * `formatAwardDateText` as an ISO date, and the text is accepted only when one
 * of them renders back byte for byte. That single comparison proves the month
 * is spelled the way this codebase spells it, the day exists in that month of
 * that year, and the value is already in house style — using the calendar
 * rules that live in the formatter rather than a second copy of them.
 */
function recognizeMonthNameDate(text: string) {
  const match = MONTH_NAME_DATE_SHAPE_PATTERN.exec(text);
  if (!match) return null;

  const [, day, year] = match;
  const isoDay = day.padStart(2, "0");
  for (let month = 1; month <= 12; month += 1) {
    const isoCandidate = `${year}-${String(month).padStart(2, "0")}-${isoDay}`;
    if (formatAwardDateText(isoCandidate) === text) return text;
  }
  return null;
}

/** The readable form of one complete single calendar date, or null. */
function recognizeCompleteCalendarDate(text: string) {
  const monthName = recognizeMonthNameDate(text);
  if (monthName) return monthName;

  if (!MACHINE_DATE_SHAPE_PATTERN.test(text)) return null;
  // Under the shape above the formatter has exactly one branch it can take, so
  // a changed result means it recognized a single complete date; an unchanged
  // one means it refused the value, and so does this.
  const formatted = formatAwardDateText(text);
  return formatted === text ? null : formatted;
}

type ScopedDate =
  /** The identity is the award's own name: redundant, so it can go. */
  | { kind: "redundant"; date: string }
  /** The identity names one track of a registered combined award. */
  | { kind: "scoped"; date: string; scope: string };

/**
 * The date and its scope, or null when this value is not one this file may
 * touch. Null is the normal answer, and it always means "render the original".
 */
function recognizeScopedDate(value: string, awardName: string | undefined): ScopedDate | null {
  // No award to compare against is missing context, not a licence to guess.
  if (!awardName) return null;

  const match = TERMINAL_PROGRAM_IDENTITY_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, head, identity] = match;
  const date = recognizeCompleteCalendarDate(head);
  if (!date) return null;

  if (identity === awardName) return { kind: "redundant", date };

  const scope = PRESENTATION_SCOPES.get(awardName)?.get(identity);
  if (scope === undefined) return null;
  return { kind: "scoped", date, scope };
}

/**
 * One reviewed date field, ready to render: the label to show and the value to
 * show under it.
 *
 * A recognized track moves into the label ("Scholarships deadline") and the
 * value becomes the date alone. A parenthetical that only repeats the award's
 * own name is dropped and the caller's field label is kept. Everything else —
 * including every value with a qualifier that carries meaning — comes back
 * under the caller's label, formatted exactly as `formatAwardDateText` would
 * have formatted it on its own.
 */
export function presentAwardDateField(
  value: string | null | undefined,
  awardName: string | undefined,
  fieldLabel: AwardDateFieldLabel = "Deadline",
): AwardDateFieldPresentation {
  // A missing value stays missing, so a caller's own "Not listed" still works.
  if (value === null || value === undefined) return { label: fieldLabel, value: null };

  const scoped = recognizeScopedDate(value, awardName);
  if (!scoped) return { label: fieldLabel, value: formatAwardDateText(value) };
  if (scoped.kind === "redundant") return { label: fieldLabel, value: scoped.date };
  return { label: `${scoped.scope} ${SCOPED_FIELD_LABEL[fieldLabel]}`, value: scoped.date };
}

/**
 * One reviewed timeline date, ready to render.
 *
 * A recognized track is stated in front of the date ("Fellowships: January 20,
 * 2027"); a parenthetical that only repeats the award's own name is dropped.
 * The entry is never given a category it did not have — no "deadline" or
 * "opening" is invented for it — and anything unrecognized is returned exactly
 * as `formatAwardDateText` returns it.
 */
export function presentAwardTimelineDate(value: string, awardName?: string): string {
  const scoped = recognizeScopedDate(value, awardName);
  if (!scoped) return formatAwardDateText(value);
  if (scoped.kind === "redundant") return scoped.date;
  return `${scoped.scope}: ${scoped.date}`;
}
