# Public date presentation

Date formatting and date meaning are separate checks. A well-formatted date
can still have a confusing label. Public pages, directory cards, metadata and
sharing images use one presentation helper so they cannot silently diverge.

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
