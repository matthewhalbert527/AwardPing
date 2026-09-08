# Public date presentation

Date formatting and date meaning are separate checks. A well-formatted date
can still have a confusing label. Public pages, directory cards, metadata and
sharing images use one presentation helper so they cannot silently diverge.

## Clock style and directory alignment

Complete supported dates with times use **Month D, YYYY at h:mm a.m./p.m.
(stated zone)**. For example, the reviewed Gilman value
`October 1, 2026 at 11:59PM PT` becomes
`October 1, 2026 at 11:59 p.m. (PT)`, while the machine value
`2026-03-27T17:00:00-05:00` remains
`March 27, 2026 at 5:00 p.m. (UTC-05:00)`.

The original formatter covered machine timestamps but passed written clocks
through unchanged. The shared formatter now also recognizes complete written
month-first/day-first dates with valid 12-hour clocks. Named zones stay named;
numeric offsets stay numeric. No host locale, browser timezone or guessed
daylight-saving rule participates in display. No time is invented for date-only
values, and nonzero seconds/fractions remain intact.

Complete written dates without a clock use the same month-first calendar style:
`1 July 2026` becomes `July 1, 2026`. This reuses the timed-date calendar
validator, including leap-year checks. It does not infer a year, time, or zone.
Clear reviewed labels and date-first timeline descriptions retain their words;
an invalid, qualified, or ranged leading date cannot fall through to styling a
later valid date instead. Partial dates and recurring rules remain literal.

In recurring rules and longer descriptions, only complete valid 12-hour clock
tokens get typographic cleanup. The surrounding words, alternative dates,
applicant groups and conditions remain. Existing compound parentheses, such as
Goldwater's two-zone announcement time, are not nested or split. Invalid or
unsupported complete datetime statements remain untouched, and malformed clocks
cannot be partially salvaged into valid-looking times.

Directory cards reserve one consistent 18rem deadline column, independently of
the length of each date string. Scoped CSS prevents import-order conflicts;
the existing stacked layout remains at 640px and below. Values wrap instead
of clipping or shrinking their text.

Validated UTC tokens such as `(UTC-05:00)` stay together on a line in directory
deadlines and the award's date rows. The full date can still wrap. This is a
small DOM-only span: copied text, accessible text, metadata and sharing-image
strings keep their ordinary spaces and ASCII signs. Recognition reuses the
formatter's complete-date and reviewed-label boundaries; it never scans labels,
descriptions or unrelated facts for UTC-looking text. Unsupported values remain
literal, including uncertain offsets and unknown qualifiers. Existing semicolon
list splitting is unchanged; each displayed date item is considered separately.

## Program labels

The September 7, 2026 Boren correction exposed this distinction:

- The published award is **Boren Scholarships and Fellowships**, not one program.
- `January 27, 2027 (Boren Scholarships)` is shown as **Scholarships deadline**
  with **January 27, 2027** as its value.
- The timeline's `January 20, 2027 (Boren Fellowships)` becomes
  **Fellowships: January 20, 2027**. It stays in the timeline, not a newly inferred field.

The two programs have different deadlines, confirmed on the official
[Boren homepage](https://www.borenawards.org/). Removing both parenthetical
qualifiers would incorrectly imply the same deadline applies to both programs.

The helper recognizes only complete supported dates and exact award/program
identities. Program relationships are explicitly listed, not inferred by fuzzy
matching, singularization or deleting repeated words. Truly identical full-award
labels need not repeat the page/card title. Unknown shapes remain untouched.
No dates are hardcoded, and no stored or reviewed fact is rewritten.

## Checks required for future changes

- Check both the value and which applicants/program/cycle it describes.
- Preserve time zones, campus/national distinctions, course-dependent dates,
  event names, unknown values, invalid values and missing data.
- Never blanket-strip parentheses or scholarship names. For example,
  `(applicant's time zone)` and `(dependent on course)` carry essential meaning.
- Keep canonical fact identity separate from its display label, so a scoped
  deadline remains visible in both Overview and Dates & deadlines.
- Verify every consumer and input immutability, not just the date formatter.

The public audit covered all 25 published award pages and 87 date values on
September 8 at 03:10 UTC. Boren was the only redundant award-name suffix;
other parenthetical qualifiers and named timeline events were meaningful.
