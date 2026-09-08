# Directory card glance row

Every browse card uses the same three fields, in order: **Level**, **Citizenship**, **Updates**. The deadline stays in its existing separate position. Navigation instructions and source-loading details are not eligibility facts and do not belong in this row.

`awardCardGlance` is a display-only projection. Filters and the full award page continue to use the original reviewed values. It considers every academic-level and citizenship entry; never restore the former `slice(0, 2)` / `slice(0, 1)` truncation.

- Familiar wording is shortened only by exact whole-value aliases. Do not remove conditional, regional, year, course, or program-stage restrictions with fuzzy matching.
- Deduplicate exact normalized aliases only. Related categories are not necessarily duplicates.
- A complete field longer than 80 characters becomes **See full criteria**. The original text remains in the title detail, and the existing whole-card link opens the full award page. No fragment is presented as the entire eligibility rule.
- Missing eligibility is **Not listed**, not unrestricted. An unknown or invalid update count is **Not available**, not zero.
- Updates count recorded events, not a freshness window. Zero is **None recorded**; positive counts are **N recorded**. Do not infer counts from source counts, unloaded event arrays, or `recentlyUpdated`.

The row is a semantic description list with locally scoped CSS. It uses columns when the card has room and aligned label/value rows in narrow containers. Values wrap without clipping; it adds no nested controls to the card link.

Regression coverage includes Goldwater's three U.S. status categories, SMART's four levels and five countries, DACA, regional national-status restrictions, scoped graduate programs, complex conditional citizenship rules, unavailable counts, and unchanged source data/filter behavior.
