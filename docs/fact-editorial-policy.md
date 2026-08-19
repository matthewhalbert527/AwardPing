# AwardPing fact editorial policy (v1)

The contract for every published award fact. AI drafters and AI critics are
prompted with this document verbatim; human reviewers correct against it; every
human correction that reveals a missing rule gets added here with its example.

Seeded 2026-08-19 from the Rhodes review session (policy examples marked
`[rhodes-2026-08-19]` are real corrections made by the owner).

## Global rules

1. **Evidence first.** Every published value must be fully supported by its
   quoted evidence from a sealed capture. If the capture cannot support a
   field, the field stays unpublished. Never generalize beyond the quote.
2. **Neutral register.** Plain declaratives. No promotional or evaluative
   adjectives, no superlatives, no award-brochure voice.
   - Wrong: "A life-changing postgraduate opportunity…" `[rhodes-2026-08-19]`
   - Right: "A postgraduate scholarship for study at the University of Oxford."
3. **Right-field discipline.** A true statement in the wrong field is an
   error. Classify by the field contract below, not by where the source
   happened to mention it.
   - Wrong: "Basic tenure is two years" under `requirements`
     `[rhodes-2026-08-19]` — it describes the award, not who may apply.
   - Right: the same fact under `award_amounts` (funding duration).
4. **Applicant point of view.** Fields answer an applicant's practical
   questions: Can I apply? What do I get? What do I submit? When? How? Content
   that only makes sense to selection committees or administrators is either
   reframed for applicants or left out.
5. **Actionable where action is expected.** Fields whose job is routing
   (`how_to_apply`, `contacts`, `documents`) must contain the actionable
   artifact — a URL, an address, a named document — when the capture provides
   one. Prose that describes an action without enabling it fails.
   - Wrong: "visit the Office of the American Secretary website"
     `[rhodes-2026-08-19]`
   - Right: "Apply via https://www.rhodeshouse.ox.ac.uk/scholarships/applications/united-states-of-america"
6. **Cycle-explicit dates.** Dates carry their year and, where the source
   gives one, their timezone. A date must belong to the current published
   cycle; a prior-cycle date is a failure even when quoted accurately.
7. **Self-contained jargon.** Terms a college junior would not know are
   either explained by the value itself or omitted. Referencing a concept the
   reader cannot see (e.g., "the 1902 selection criteria" without stating
   them) fails. `[rhodes-2026-08-19]`
8. **Prefer omission over padding.** A short correct field beats a filled
   one. Empty is an acceptable state for any field except `overview`.

## Field contracts

| Field | Job (applicant question) | Format | Notes |
|---|---|---|---|
| `overview` | What is this award? | 1–2 plain sentences | What it is, what it funds, where. No mission language. |
| `deadline` | When must I submit? | One date + time + timezone | Current cycle only. |
| `opening_date` | When can I start? | One date | Current cycle only. |
| `award_amounts` | What do I get? | List items | Money, coverage, duration of funding, in-kind benefits (flights, insurance). Tenure/duration belongs HERE. |
| `eligibility` | Am I allowed to apply? | List of self-checkable gates | Citizenship, age, class year, enrollment, degree status. Objective gates only — no "strong candidates have…". |
| `requirements` | What must be true of my application? | List of self-checkable conditions | GPA thresholds, endorsement/nomination needs, authorship rules. Simple applicant-facing items ("US citizen, GPA, Junior" style), never selection philosophy. `[rhodes-2026-08-19]` |
| `application_materials` | What do I submit? | List of artifacts | Transcript, essays, letters — concrete deliverables. |
| `how_to_apply` | Where and how do I start? | Steps or a URL | Must carry the portal/form URL when captured. |
| `important_dates` | What is the timeline? | List of date: event pairs | Cycle-explicit. |
| `documents` | What official documents should I read? | List of named documents | Readable names, never bare URLs on the public page. |
| `contacts` | Who do I ask? | List of role: address pairs | Prefer the constituency-specific contact over generic addresses when both exist. |
| `academic_levels` | What stage of study? | List | e.g., Junior, Senior, Graduating senior, Graduate. |
| `disciplines` | What fields of study? | List | Only when the source states them; "all fields" needs a quote. |
| `citizenship` | What citizenship/residency? | List | Objective statuses only. |

## Critic lenses

Every draft fact sheet is judged by five independent critics, each applying
one lens against this document:

1. **evidence_support** — is each value fully supported by its quote, with no
   extrapolation? (The byte-exact substring check runs mechanically at import;
   this critic judges semantic support.)
2. **field_semantics** — is each fact in the field whose contract it
   satisfies? Would an applicant looking for it look here?
3. **style_register** — global rules 2, 7: neutral tone, self-contained
   language.
4. **actionability_completeness** — rules 4, 5, 8: does each routing field
   enable its action; is anything padded or, conversely, missing that the
   capture clearly supports?
5. **cycle_freshness** — rule 6: every date the current cycle, years present,
   nothing stale relative to the capture's own cycle statements.

A fact ships automatically only when all five critics pass it. Any objection
triggers one revision loop; unresolved objections escalate to human review.
Human corrections feed back into this file as new rules with examples.
