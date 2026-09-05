# Evidence review request: Tillman Scholars Program (provisional candidate `tillman`)

Status: **inert human-review worksheet, awaiting human review.** Written
2026-09-05 from frozen parent `e19c5f5c70f088f27fbdcf88132f110e03a3acfb`.

This document is a worksheet. It is not an approval bundle, an attestation, an
evidence acceptance, a role binding, or a claim that the candidate is
candidate-, onboarding-, monitoring- or publication-eligible. It changes no
catalog row, seed, alias, source, config entry, or code, and it opens no fence:
Stage 1 remains exactly 25 awards under identity `stage1-national-25-v3`.

Every status below starts at `not_reviewed`, or at
`source_lead_observed_pending_human_review` where a supervisor-observed lead in
section 4 is available for a reviewer to examine. Nothing in this document is
"complete".

## 1. Scope

- Candidate id: `tillman`
- Provisional name: `Tillman Scholars Program`
- Provisional slug: `tillman-scholars-program`
- Status in config: `provisional`
- Declared official target (homepage-role source in the override packet):
  `https://pattillmanfoundation.org/apply-to-be-a-scholar/`. It is recorded as
  declared and is not replaced here; whether it is the canonical identity page
  is a review question (section 5, role 1).
- Out of scope: the Mitchell candidate (unchanged, plan hash
  `c64098d958e6ab8bdbda82764ab8c2890c76e343d328e5e0d4e0fac670c1f3b1`), every
  other catalog record, and the separate exact-25 architecture decision
  (section 6, stage 8).

Why this candidate: it is the smallest configured provisional evidence target,
with one declared official target and one precisely identified neighbouring
catalog record. Source count is not readiness; one declared source is one
declared source.

## 2. Frozen local facts (reproduced read-only from `e19c5f5` on 2026-09-05)

| Artifact | File | Version | Facts for `tillman` |
| --- | --- | --- | --- |
| Candidate config | `config/post-stage1-expansion-candidates.json` | `post-stage1-expansion-candidates-v1` | `candidateId` tillman, `awardName` Tillman Scholars Program, `slug` tillman-scholars-program, `status` provisional |
| Expansion planner | `scripts/lib/post-stage1-expansion-plan.mjs` | `post-stage1-expansion-plan-v2` | `planHash` `53d845215b34d21a90afaa0c0b92324e4edc8bb35d0cf62b5694055f8c58e44b`; joined seed index 166; `excludedDiscoveryUrls` = the seed 166 URL; `homepage` = the declared target, title "Tillman Scholars Program", confidence 0.92; `monitorableSources` 1; `lifecycle`: `currentCycleAuthority` unresolved, `humanSourceReview` unresolved, `remoteIdentityCollisionCheck` unresolved, `monitoringReadiness` false, `publicationEligibility` false |
| Seed catalog | `src/lib/award-seeds.ts` | catalog of 1157 seeds | seed 166 (literal name match): `Tillman Scholars Program`, `https://onsa.asu.edu/scholarship/tillman-scholars-program`; seed 819 (neighbouring, unresolved): `Pat Tillman Foundation - Tillman Military Scholarship for Military Service Members, Veterans, and Spouses`, `https://fellowship-finder.grad.illinois.edu/SearchResult/Fellowship/3939` |
| Source overrides | `src/lib/award-source-overrides.ts` | catalog of 31 packets | one packet `Tillman Scholars Program` (override index 28) with one source: the declared target, title "Tillman Scholars Program", pageType `homepage`, confidence 0.92, reason "Official organization source page." |
| Seed expansion inventory | `scripts/lib/award-seed-expansion-inventory.mjs` | `award-seed-expansion-inventory-v1` | seed 166 and seed 819 are both `directory_only` ("Starter link resolves to an institutional discovery directory host.") |
| Identity collision dossier | `scripts/lib/award-identity-collision-dossier.mjs` | `award-identity-collision-dossier-v1` | re-derived with probe `{ probeId: "tillman", lexicalTerms: ["tillman"] }`, not stored and no new dossier created: `records` 3, `exactNameLinks` 1, `urlLinks` 0, `lexicalNearbyOnly` 1; the records are override 28, seed 166 (exact-name link) and seed 819 (lexical-only); `relationship` unresolved_pending_human_review; all four eligibility flags false; re-derived `dossierHash` `57aabd13526540d1e2396ad3a6c01c16b496fea9622eb99e212e16a0f8f92d3e` |
| Override packet report | `scripts/lib/award-source-override-packet-report.mjs` | `award-source-override-packet-report-v1` | packet `packet-0029`: `sourceCount` 1, `hostnameCounts` {pattillmanfoundation.org: 1}, `pageTypeCounts` {homepage: 1}, `homepageCount` 1, `comparisonUrlKey` `pattillmanfoundation.org/apply-to-be-a-scholar`, https true, not a discovery URL, not policy-rejected, `literalSeedMatches` = seed 166 only, `warnings` none, `relationship` unresolved_pending_human_review, all eligibility flags false; the report's test-only material digest is `42e33e1ccdc615ed9306ecc48907e363dbc15f92d06eb5aa08e6e65efe4906b8` |
| Stage 1 identity | `src/lib/stage1-cohort-identity.ts` and `scripts/lib/post-stage1-expansion-plan.mjs` | `stage1-national-25-v3`; `stage1CohortIdentityHash` `71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9` (SHA-256 over the identity table payload); the planner's separate `stage1IdentityContentDigest` is `a6493d81606bd408d6291ef8dc193866168f155de10ee268ccca0efc6d387363` (SHA-256 over the six-field identity rows), a different byte domain and not interchangeable | 25 cohorts; `tillman` is not a Stage 1 cohort key, name, alias, slug, or homepage (the planner's overlap checks pass) |
| Stage 1 required roles | `scripts/lib/stage1-cohort-readiness.mjs` | `stage1-cohort-readiness-v2` | `REQUIRED_SOURCE_ROLES`: identity_home, eligibility, application_materials, dates_cycle, funding, faq, selection_interviews, current_documents |

Reading these facts together does not resolve anything. A literal name match,
a single declared source, and an absence of packet warnings are structural
observations; they are not identity, authority, or readiness.

## 3. Catalog identity question (human ruling required)

Question: do the records named `Tillman Scholars Program` (seed 166 and
override 28) and the record `Pat Tillman Foundation - Tillman Military
Scholarship for Military Service Members, Veterans, and Spouses` (seed 819)
name (a) the same award under different names, (b) distinct programs of one
foundation, or (c) something not yet determinable?

| Field | Value |
| --- | --- |
| decision | `unresolved` (allowed values: `same_award`, `distinct_programs`, `unresolved`) |
| canonical name | null |
| canonical homepage URL | null |
| evidence references | null |
| reviewer identity | null |
| reviewed at | null |
| notes | Both seeds point at institutional directory hosts, so neither seed URL is itself official evidence. The declared target is an application-path page on the foundation's host. |

Until a ruling is recorded here, no record above may be aliased, merged,
renamed, re-seeded, onboarded, or monitored.

Remote identity check: `not_performed`. No shared-award UUID is known or
asserted for this candidate, and absence from the live database is not
claimed. A future check must record its query, time, and result separately.

## 4. Supervisor-observed primary-source leads (observations, not accepted evidence)

The supervisor performed a read-only primary-source check on 2026-09-05 and
supplied the following. The author of this worksheet performed no network
access and holds no immutable full-page capture text, capture text object
key, layout, or offsets for any of these source leads; the three short
excerpts below are retained in this worksheet itself. These are discovery
leads for a reviewer to examine. They are not
accepted evidence, they bind no role, and they complete nothing.

Retrieval time recorded by the supervisor: `2026-09-05T21:20:07Z`.

Official URLs observed:

1. `https://pattillmanfoundation.org/apply/`
2. `https://pattillmanfoundation.org/news-media/2026-tillman-scholar-applications/` (published 2025-12-01)
3. `https://pattillmanfoundation.org/eligibility-and-compensation/`
4. `https://pattillmanfoundation.org/wp-content/uploads/2025/11/2026-PTF-Scholar-Application-One-Pager-1.pdf`

Page contents observed by the supervisor on URL 1, paraphrased here and not
retained as text: a program description that can serve as an identity/home
lead, funding and benefit information, an on-page FAQ section or summary,
and a selection summary that mentions finalist interviews. URL 4 was also
supplied as a funding lead. These observations only route leads to roles in
section 5; they are not excerpts, not accepted evidence, and this worksheet
retains no verbatim text from the observed leads beyond the three excerpts
below.

Retained excerpts: this worksheet adds exactly these three verbatim excerpts
and no other verbatim text from the four observed leads. Each
`excerptSha256` is over the UTF-8 bytes of the excerpt text alone, with no
surrounding quotation marks and no trailing newline; all three were
recomputed locally on 2026-09-05 and matched. An excerpt hash is not the
`captureTextSha256` that the Stage 1 workflow requires over the complete
immutable capture text, and it must never be entered in that field.

| # | Source | Excerpt | excerptSha256 |
| --- | --- | --- | --- |
| E1 | Apply page (URL 1) | Applications for the 2026 Class of Tillman Scholars are now closed. | `08734e6c204cf9166271fe45aacce1bf7f0fd22c388baf9c34863e05405e31c3` |
| E2 | Apply page (URL 1) | Applications open December 1 each year for the upcoming academic year. | `c3e5cb1e9882d15737d8a5f51ba214b0e10efe7e416f0bbaef7b25eb6934699e` |
| E3 | Official 2026 press release (URL 2) | Applications to become a 2026 Tillman Scholar will close on February 1, 2026. | `ce1cfc94e5bd9070a18b7e493009ab624042754957368a1c36312b6f6630533f` |

What these leads establish: that a 2026 class and application cycle existed
and is now closed, and that the apply page carries a general annual statement
that applications open December 1.

What these leads do not establish: a 2027 cycle, any future deadline, a current
open status, the canonical catalog identity of the award, remote uniqueness in
the live database, or eligibility of this candidate for AwardPing onboarding.
No excerpt here is bound to a role until a reviewer accepts it in section 5
with a retained immutable text reference, a `captureTextSha256` over the
complete capture text, and exact offsets.

## 5. Eight-role worksheet

Rules: no role is complete; no pageType, source count, or URL slug binds a
role; a lead listed against a role is something to examine, not a binding; one
page may support several roles only after review; unknown fields stay `null`
or `not_reviewed`; offsets and retained-text references are never invented.

| # | Role (`REQUIRED_SOURCE_ROLES`) | Current status | Leads to examine | Open questions |
| --- | --- | --- | --- | --- |
| 1 | identity_home | `source_lead_observed_pending_human_review` | URL 1 (program description observed); separately, the declared target `https://pattillmanfoundation.org/apply-to-be-a-scholar/` (declared, not observed by the supervisor, not replaced) | Which page is the canonical identity page: URL 1, the declared application-path target, or another foundation page? Depends on the section 3 ruling. |
| 2 | eligibility (applicant eligibility) | `source_lead_observed_pending_human_review` | URL 3 | Which cycle do the eligibility terms apply to? |
| 3 | application_materials | `source_lead_observed_pending_human_review` | URL 1, URL 4 | Are the materials current for a cycle that is not yet open? |
| 4 | dates_cycle | `source_lead_observed_pending_human_review` | URL 1 (E1, E2), URL 2 (E3) | E1 and E3 name the 2026 class, which is closed; E2 is a general annual statement. No 2027 date exists in the retained text. |
| 5 | funding | `source_lead_observed_pending_human_review` | URL 1 (funding and benefit information observed), URL 4 | No funding excerpt is retained; a capture and human review are required before any value is recorded. |
| 6 | faq | `source_lead_observed_pending_human_review` | URL 1 (an on-page FAQ section or summary observed) | No FAQ excerpt is retained; whether that section satisfies the role is for review. |
| 7 | selection_interviews | `source_lead_observed_pending_human_review` | URL 1 (a selection summary mentioning finalist interviews observed) | No excerpt is retained; the selection process and any interview stage are unverified until captured and reviewed. |
| 8 | current_documents | `source_lead_observed_pending_human_review` | URL 4 | The document is titled for the 2026 cycle in its URL; currency for any later cycle is unknown. |

Prospective review-item record. Copy one block per item under review; a block
is a pending review item, never an already accepted item, until a reviewer
sets `decision` with a real immutable capture behind it. The two hash
domains are distinct and must never be conflated: `captureTextSha256` is the
SHA-256 over the complete immutable retained capture text that the Stage 1
workflow requires, and `excerptSha256` is only a worksheet lead-integrity
hash over the exact excerpt bytes. E1 to E3 may populate only `sourceUrl`,
`retrievedAt`, `exactExcerpt` and `excerptSha256` in a pending review item;
they cannot populate `captureTextSha256`, `retainedTextReference` or
`excerptOffsets`, and they do not establish acceptance.

```text
sourceUrl:               null
retrievedAt:             null
retainedTextReference:   null   (immutable capture text object key; null until a real immutable capture exists)
captureTextSha256:       null   (SHA-256 of the complete immutable retained capture text; required before acceptance)
exactExcerpt:            null
excerptOffsets:          null   (start-end within the retained capture text; null until a real immutable capture exists; never estimated)
excerptSha256:           null   (optional worksheet lead-integrity hash of the exact excerpt bytes; never a substitute for captureTextSha256)
applicableCycle:         null
claimedRole:             null   (one of the eight roles)
reviewerIdentity:        null
reviewedAt:              null
decision:                not_reviewed   (not_reviewed | accepted | rejected | needs_more_evidence)
unresolvedConflicts:     null
```

## 6. Remaining stages and gates (all open; none opened by this document)

1. Catalog identity: the section 3 ruling, with canonical name and homepage
   evidence recorded.
2. Current-cycle authority: `currentCycleAuthority` is `unresolved`. The
   leads show a closed 2026 cycle and an annual opening statement only; a
   current cycle must be evidenced by a retained capture and human review.
3. Lifecycle evidence: eight roles with immutable retained captures, exact
   quotes and offsets, applicable cycle, and reviewer attestation, per
   `docs/stage1-reviewed-source-and-candidate-workflow.md`.
4. Candidate eligibility: `candidateEligible` stays false in every artifact;
   this document does not change it.
5. Onboarding: `onboardingEligible` stays false; requires a canonical shared
   award identity, reviewed source requests, and the intake path. Not started.
6. Monitoring: `monitoringEligible` stays false; requires the capture fleet
   and quality gates. Not started.
7. Publication: `publicationEligible` stays false; the Stage 1 publication
   fences are unchanged.
8. Exact-25 architecture decision: how any award beyond the national 25 would
   be published is a separate owner decision. This document does not address
   it, does not open any fence, and does not increase the current count of 25.

Relationship for every record named here: `unresolved_pending_human_review`.
Eligibility for every record named here: `candidateEligible` false,
`onboardingEligible` false, `monitoringEligible` false,
`publicationEligible` false.

## 7. Read-only re-derivation of section 2

From the repository root at `e19c5f5`, without network access: import
`awardSeeds` and `awardSourceOverrides` from `src/lib`, build the planner with
`config/post-stage1-expansion-candidates.json` and the Stage 1 identity rows
(cohort definition plus canonical slugs), build the dossier with the probe in
section 2, build the packet report with the two catalogs, and build the seed
inventory with the seeds and the Stage 1 cohort definition. The values in
section 2 are what those builders return today; the three excerpt hashes are
`sha256(utf8(excerpt))`.

## 8. Provenance

- Local facts: reproduced from frozen parent `e19c5f5` on 2026-09-05.
- Primary-source leads and excerpts: supplied by the supervisor from a
  read-only check at `2026-09-05T21:20:07Z`; hashes verified locally.
- Author network access: none. Live database, worker, and cloud state: not
  consulted; anything remote is unknown by construction.
