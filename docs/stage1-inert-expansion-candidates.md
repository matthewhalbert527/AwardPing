# Decision memo: provably inert expansion candidates

Status: **adopted — option C implemented 2026-08-30** under the owner directive to complete all 25 cohorts ("continue until all 25 pages are complete and 100% ready", 2026-08-30). Guardrails implemented exactly as specified below; see migration 20260830223000 and the engine/validator changes in the same commit. Originally written 2026-08-22 from live evidence.
Blocks: the `truman` cohort, and any future award whose official page ships a
broken accordion.

## The situation

`https://www.truman.gov/apply/advice-guidance/frequently-asked-questions-applicants`
is Truman's official FAQ and carries the `faq` and `funding` role bindings from
the 2026-08-19 review. Its accordion is **broken on Truman's own site**.

Verified in a real browser on the live page:

- Clicking a question's button *does* flip `aria-expanded` from `false` to `true`.
- The bound drawer nevertheless keeps `aria-hidden="true"`, its classes never
  change, and its height stays `0` — permanently.
- This is not a capture artifact. The panel never opens for a human visitor
  either.

The capture engine therefore refuses all 23 candidates and records
`expansion_state_capture_coverage.status = "incomplete_failures"`
(`logical_candidate_count: 23`, `attempted_count: 23`, `failure_count: 23`,
`retained_state_count: 0`). Stage 1 requires `verified_complete` with zero
failures, so `truman` cannot chain.

**The engine is behaving correctly.** It cannot prove it captured content it was
never able to reveal, so it fails closed. Nothing in the current code is a bug.

## Why this is not simply "wait for Truman to fix it"

The FAQ answers are all present in the page's static text — the capture's
`text_length` is 8,491 and the answers are in it, because the drawers are in the
DOM and merely never revealed. So the *fact evidence* Stage 1 would publish is
already complete and quotable. What is missing is only the per-state screenshot
set proving that revealed content was captured.

Put differently: the fence is asking "did you open everything that opens?" and
on this page the honest answer is "nothing opens." Today we cannot express that.

## Options

**A. Wait for Truman to repair their site.** Zero code risk; blocks the release
indefinitely on a third party who has no reason to prioritize it, and gives us
no answer for the next award with the same defect.

**B. Rebind Truman's `faq` and `funding` roles to other official Truman pages.**
A review decision in your existing rebind pattern, no fence change. Cost: the
FAQ page is the best source for several of those facts, so some facts would get
weaker citations, and the FAQ page would drop out of monitoring for those roles.

**C. Introduce a "provably inert candidate" class.** A candidate is inert when,
across repeated attempts, the control responds (its own state flips) but the
bound content never becomes visible. Such candidates would be excluded from
`logical_candidate_count` with the proof recorded in the coverage metadata, so
coverage could reach `verified_complete` on the remaining (real) states.

## Recommendation: C, with the proof recorded, if you want Truman in the first 25

C is the only option that states the truth: this page has no expansion states.
It is also the only one that generalizes.

It is not a small change, and it touches a fence, which is why it is your call:

- `stage1ExpansionCaptureCoverageValid()` in
  `scripts/lib/expansion-state-descriptor-canonicalization.mjs` would need to
  accept a new `inert_count` and the accompanying proof block.
- The SQL fence in
  `supabase/migrations/20260814173236_require_stage1_expansion_capture_coverage.sql`
  enforces the same arithmetic independently (`failure_count = 0`,
  `attempted_count = logical_candidate_count`) and would need the matching
  change, applied to production.
- The capture engine would need to attempt each candidate more than once before
  declaring it inert, and record per-candidate evidence (attempts, the control
  state observed flipping, the drawer geometry staying at zero).

Guardrails I would insist on if you approve it:

1. Inert status is **earned per capture, never configured** — no allowlist of
   "sites we forgive", no per-source override.
2. The proof must be in the immutable metadata, so an auditor can re-derive the
   ruling from the sealed evidence alone.
3. A candidate whose control does *not* respond at all stays a **failure**, not
   an inert candidate. Inert means "demonstrably nothing to reveal", not
   "we could not drive it".
4. If any candidate on the page does open, the page is not inert and normal
   rules apply to all of them.

If you would rather not touch the fence at all before the first release, B is
the safe fallback and can be reversed later once C exists.

## What is already done

Nothing has been changed in the fence or the validator. This memo exists because
the alternative was to weaken an evidence rule without your review, and Truman is
the only cohort it currently blocks.

---

## Addendum 2026-09-01: mixed pages exist and need your ruling

Live evidence, first observed on the 2026-08-31 nightly sweep:

- `https://amafoundation.org/physicians-of-tomorrow`: 21 expansion candidates;
  **15 open and captured normally, 6 are provably dead** (each responded on
  both fresh-page attempts while its bound content never became visible -
  WordPress accordion buttons wired to nothing).
- `https://www.simonsfoundation.org/grant/simons-graduate-fellowships-in-ecology-and-evolution/?tab=faq`:
  same shape.

The capture engine was emitting mixed claims (retained > 0 plus an inert list
with proof), which guardrail 4 forbids and the validator + SQL fence correctly
reject - the mismatch surfaced as an opaque "coverage claim is invalid" crash.
The engine now conforms (commit on redesign/ui-overhaul): on a page where any
candidate opened, inert classifications are withdrawn post-run and recorded as
ordinary failures naming guardrail 4.

Consequence of the strict rule: a page with even one dead control among working
accordions can never reach `verified_complete`, so both sources above are held
`review_later` and their awards lose those sources from monitoring. Options:

**D. Keep guardrail 4 strict** (current state). Cost: mixed pages are
permanently unmonitorable; the dead-control pattern is common enough that this
list will grow.

**E. Extend inertness to per-candidate on mixed pages**, keeping every other
guardrail (earned per capture with two-attempt proof, never configured,
responded-but-hidden only). The claim's arithmetic already supports it
(attempted = retained + inert + failures); the validator's
`retained_state_count !== 0` rejection and the matching SQL-fence clause are
the only two changes. The original rationale for guardrail 4 was
distinguishing "the accordion system is broken" from "we failed to drive it" -
on a mixed page, 15 captured states prove the driver works, which arguably
makes per-candidate inertness *stronger* evidence there than on all-dead pages.

Recommendation: E, for the same reason C was right - it states the truth about
the page. Your call, as before; nothing changes until you rule.

**RULED 2026-09-01: option E adopted** (owner instruction in session, "ok do these").
Implemented on redesign/ui-overhaul: the per-candidate rule now holds in
`summarizeExpansionStateCapture`, `stage1ExpansionCaptureCoverageValid`, and the SQL
fence (migration `20260901160000_per_candidate_inert_expansion_states.sql`, applied to
production 2026-09-01); the engine's guardrail-4 withdrawal was reverted; contract tests
in `scripts/lib/per-candidate-inert-expansion.test.mjs`. Sequencing: the DB fence is
live now (a harmless superset), but the worker's own validator ships with the next
worker deploy - frozen until the release soak completes - so the two held sources
(AMA physicians-of-tomorrow, Simons ?tab=faq) stay `review_later` until that deploy,
then reopen.
