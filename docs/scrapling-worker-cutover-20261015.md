# Scrapling worker cutover: October 15, 2026

## Current checkpoint — October 18

Production is partially switched: 14 verified HTML pages across nine awards, with the original daily schedule and downstream review lanes enabled. Only Gaither's complete finite HTML set is selected so far. Read `CURRENT_STATE.md` for exact deployed/installed identities and remaining source-level holds; development HEAD and the historical notes below are not deployment evidence.

The next isolated release adds an explicit ordinary-HTTPS source-only profile for NSF, exact artifact retention/review/publication/recovery, and honest summary-plus-source presentation without screenshot claims. It also retries unstable expanded-state screenshots using a fresh observation, without accepting mismatched geometry. These follow-up changes are locally tested but not yet installed or activated. The five new NSF URLs must pass normal intake/registration; do not reuse or bypass the historical Stage1 activation protocol. PDFs remain separate.

## Historical October 15 checkpoint

Status: local integration and staged runtime tested; **cutover incomplete and not activated**. The installed worker and its daily 18:00 America/Chicago schedule are unchanged. This document is not deployment evidence.

## Simple operating model

1. An exact reviewed award/source UUID and URL selects Scrapling; everything outside that manifest retains the existing collector. PDFs retain their separate existing path.
2. Scrapling obtains a settled main-document snapshot. Keep full HTML, source text/context, visible text, and a supplementary screenshot. Hidden HTML is retained evidence, not automatically current applicant guidance. No invented screenshot coordinates.
3. Compare complete same-source, same-profile snapshots. First observation or an explicit profile migration creates a baseline, not an award update. Link, structure, duplicate/order or incomplete changes remain reviewable; they must not disappear through the legacy sentence/noise filter.
4. Only bounded, complete changed blocks supported uniquely by sealed visible evidence and their ordered context may reach the existing AI-review gates. All full-source and visible prose edits must be accounted for; unchanged titles, structure and links are required. At most eight changed blocks are permitted because the existing publication normalizer retains eight. Other changes retain both captures for manual review. No comparison itself publishes or advances an unapproved baseline.

Local entry points: `scripts/lib/scrapling-worker.mjs`, `scripts/lib/scrapling-review-diff.mjs`, the explicit manifest branch in `scripts/capture-visual-snapshots.mjs`, and `installer/windows/Install-AwardPingScraplingRuntime.ps1`. No new crawler, discovery authority, adaptive selector substitution or anti-bot bypass is introduced.

## What is actually installed

- Worker revision observed: `33c78b955637913b68324da3285e82101174d91a`, under `C:/Users/matth/AppData/Local/AwardPingWorker/app`.
- Three capture shards run daily at 18:00 Chicago. Eight downstream lanes repeat every 15 minutes. The October 14 report loaded 2,069 sources, captured 2,053 and recorded 16 failures; report health was degraded despite successful task exit codes.
- The exact 25 awards have 946 source records, of which 232 are open and pass the existing monitoring-quality gate. Do not replace this real inventory with the public API's incomplete pilot roster or its synthetic fallback IDs.
- New-page and changed-page Gemini batch creation returned HTTP 400 `FAILED_PRECONDITION`. Latest 16:45/16:47 logs report `retry_backoff` with `next_retry_at=none`; exit 0 means skipped, not successful review or an empty queue. A read-only metadata check returned 200 and batch support for both configured models. This rules out a missing model, not an account/billing prerequisite; no successful generation or batch submission was established.
- A separate read-only [batch-list request](https://ai.google.dev/api/batch-api#method:-batches.list) returned 200 and twenty historical successful operations dated September 27–28, with further pages unrequested. This confirms readable historical provider state, not current submission health or a proven account/billing diagnosis. Receipt: `tmp/scrapling-cutover-20261015/review-provider-batch-status.json`. No paid generation, submission, retry reset or provider settings change was requested.

### Evening billing investigation

The signed-in Google UI matched the installed AwardPing key suffix to project `gen-lang-client-0413862374` (`API Key for test`), which is also used by ForgeRoom XR. Its billing account is closed. The user's other billing account shows $59.79 of eligible Gemini developer credits; the separate $1,000 GenAI App Builder promotion is explicitly not applicable to the Gemini API. No full API key was displayed or copied.

After explicit user approval, moving that existing project to the credit-bearing account failed with Google's billing-enabled project quota error. With separate explicit approval, a support request for one additional slot was submitted. Google confirmed `Your email has been sent`, normally about two business days for a response. Proof: `tmp/scrapling-cutover-20261015/billing-quota-request-submitted.png`. No purchase, automatic top-up, successful billing move or provider recovery occurred. The requested production cutover remains blocked; don't interpret readable model/batch metadata or backoff-skipped jobs as recovery.

## Reviewed source plan

Both source audits compare official pages with all 232 currently open records. They propose 114 pages/documents: 106 HTML and 8 PDFs. Exact URLs, authority links, fetch evidence, live UUID matches, moved routes, wrong-award and recipient-only classifications are retained in:

- `tmp/scrapling-cutover-20261015/source-review-01-13.json` and `.md`
- `tmp/scrapling-cutover-20261015/source-review-14-25.json` and `.md`
- `tmp/scrapling-cutover-20261015/live-source-inventory.json`
- `tmp/scrapling-cutover-20261015/monitoring-inventory.json`

| Award | Recommended HTML / PDF | Scope and important distinction |
| --- | --- | --- |
| Rhodes (US) | 2 / 3 | US application, candidate rules, FAQ; tenure and endorsement documents are separate roles |
| Marshall | 3 / 1 | Apply, eligibility, FAQ, current candidate rules |
| Fulbright US Student | 8 / 0 | Eligibility, benefits, timeline and academic/arts/ETA routes; not every country-specific award |
| Gates Cambridge | 4 / 0 | Timeline, eligibility, application, FAQ; US and other applicant deadlines differ |
| Churchill | 1 / 0 | Combined scholarship page; do not import Kanders rules |
| Schwarzman | 3 / 0 | Admissions, instructions, FAQ; distinguish application route/cycle and stale PDFs |
| Knight-Hennessy | 6 / 1 | Eligibility, deadlines, applications, FAQ, funding and form guidance; graduate-department deadlines remain separate |
| Yenching | 2 / 0 | Official Peking University admissions and FAQ; applicant routes differ |
| Luce | 2 / 0 | Selection rules plus overview; stale open banner must not override a passed date |
| Truman | 4 / 1 | Eligibility, bulletin, dates, FAQ; HTML/PDF rule disagreement requires review |
| Goldwater | 6 / 0 | Student overview, nomination, FAQ, fields, questions and essay |
| Udall | 5 / 2 | Undergraduate program/application/dates/categories, FAQ, current eligibility and sample application; multi-program PDF needs scoped interpretation |
| Beinecke | 4 / 0 | Program/deadlines, eligibility, submission, advisor FAQ; nomination and aid deadlines differ |
| Gilman | 6 / 0 | General award, dates, eligibility, application, essays, FAQ; Gilman-McCain is not interchangeable |
| Boren | 10 / 0 | Separate scholarship/fellowship instructions and FAQs, eligibility, budgets, essays and selection |
| CLS | 5 / 0 | Correct selection-process and applicant-faq routes replace obsolete paths |
| NSF GRFP | 5 / 0 | Current NSF hub, eligibility, how-to-apply, applicant FAQ and NSF 26-526; collection remains blocked |
| Hertz | 4 / 0 | Fellowship, eligibility, application and FAQ |
| NDSEG | 5 / 0 | Current officially delegated contractor application/eligibility/review/FAQ pages; award identity remains NDSEG |
| SMART | 5 / 0 | Program, eligibility, application and FAQ knowledge articles; retain raw route identity |
| GEM | 3 / 0 | Foundation, fellowship program and application process |
| NOAA Hollings | 4 / 0 | Program and prospective-applicant guidance/FAQ; current-scholar paperwork is not applicant eligibility |
| Soros | 4 / 0 | Program, eligibility, application and benefits |
| Samvid | 2 / 0 | Current official site and how-to-apply; no invented closing date |
| Gaither | 3 / 0 | Program, important dates and FAQ; nomination packet not verified publicly |

This is a research proposal, not a human approval attestation or a record of applied database changes. Unreviewed extras are preserved. New/non-open sources still need the normal source-intake process and baseline-only activation. Do not overwrite historical source identities merely because a URL redirects.

A fresh evening read-only activation proposal selected74 exact already-approved HTML records across24 awards, with no NSF source selected. Two live approval-input reads were identical; manifest and runtime selection validation passed. All158 other open records remain preserved. Forty recommendations are excluded:8 PDFs,11 non-open rows,15 new URLs and6 redirect aliases. Exact manifest, nonempty source-ID list, report and receipt: `tmp/scrapling-cutover-20261015/activation-plan-2026-10-15T23-47-33-430Z/`. Manifest SHA256: `7c1f29ce1436a1fe6dc9d31240f370a0ab6eec3b997b794974ad7d263034cf45`. This neither applies source changes nor proves full25-award coverage.

## Validation evidence

First immutable reviewed-source run:
`tmp/scrapling-cutover-20261015/reviewed-run-2026-10-15T21-31-52-324Z-f9a41d2f/report.json`

- 106 HTML attempts, 92 successful captures across 23 awards, 14 recorded failures.
- Five NSF pages: insufficient readable text. Correct official URLs do not imply the collector can read them.
- Nine other failures: full source semantics changed during the supplementary screenshot (Fulbright 1, SMART 5, NOAA FAQ 1, Soros 2).
- Eight PDFs were inventoried, not counted as HTML captures.
- Corrected CLS pages 5/5 and NDSEG contractor pages 5/5 succeeded.
- All capture inputs/code hashes stayed fixed. The finite process finished and was drained. Failures are not rewritten by subsequent tests.

A separate bounded SMART diagnostic preserved equal visible semantics but detected changed full-HTML text; the first difference was countdown seconds. It does not prove every text difference was a countdown. The acquisition fix retains the accepted atomic HTML snapshot and reports supplementary-image mismatches honestly. Targeted recapture results must be recorded separately.

Final targeted follow-up: `tmp/scrapling-cutover-20261015/targeted-run-2026-10-15T22-06-24-520Z-54019418/report.json`.

- One SMART homepage canary succeeded before the remaining eight were allowed to run. All nine then captured successfully; no NSF or original-success retries were made.
- Seven supplementary images were explicitly unmatched: SMART's five had full-HTML text differences; Fulbright and NOAA FAQ had visible text/block/link differences. Soros's two were semantically bracketed. None claim verified screenshot geometry.
- All nine capture/result hashes validated and all 14 frozen input/code hashes were unchanged. Report SHA-256: `1c9a6cf6e71f0bc5f8898752a23fbbb62663a5c273d32e878d8e38a7decb6ca0`.
- Across the first run and targeted follow-up, 101 of 106 selected HTML sources were acquired across 24 awards. This is combined evidence from separate runs, not a full final-version rerun, paired-change accuracy benchmark, or successful all-25 production deployment. NSF's five unresolved failures and both earlier reports remain intact.
- The finite capture session ended and its collector processes were confirmed absent.

NSF research (`tmp/scrapling-cutover-20261015/nsf-alternatives.md`) found accessible official RSS with only partial information and official PDF candidates whose contents were unverified. Neither substitutes for complete current rules. Do not use archived cycles, third-party copies or access-control bypasses to claim coverage.

The eight selected PDFs were subsequently downloaded and separately audited read-only: all eight were genuine, parseable PDFs; 57 pages were extracted with two tools and 22 sampled pages visually checked. Seven had meaningful native body text. The Knight-Hennessy sample's body is image-only, and Marshall's final route diagram is image-based. The audit distinguishes current link context from misleading/stale metadata and multi-program scope. No OCR, full visual review or successful production-PDF-pipeline run is claimed. Exact source URLs, hashes and caveats: `tmp/scrapling-cutover-20261015/pdf-review/pdf-review.{md,json}`.

Automatic-review coverage is deliberately not claimed: existing 8,000-character prose and 24,000-byte complete-diff bounds still hold many large sources. Tests using fictional edits to retained Samvid pages demonstrate eligible date/funding substitutions, not genuine website changes or a recall benchmark. The public evidence renderer does not yet disclose supplementary-image mismatch details, so such changes must remain on manual hold rather than entering automatic publication with a potentially different screenshot.

## Runtime and activation conditions

### Narrow release boundary

The installed worker's `33c78b955637913b68324da3285e82101174d91a` is the release base, not development HEAD or the website release. Read-only dependency review identified19 production files for the local replacement: the capture worker; four existing retention/review helpers (`r2-capture-artifact-bindings`, `r2-baseline-rehydration`, `visual-baseline-promotion`, `visual-review-queue`); seven new helpers (`rendered-html-capture`, `rendered-html-comparison`, `structured-html-content`, `scrapling-capture`, `scrapling-worker`, `scrapling-review-diff`, `scrapling-runtime-binding`); four collector files (`collector.py`, `html_document.py`, `visible-document.js`, `requirements.txt`); and the three Windows installer/integration scripts. Tests/docs accompany a reviewed release but pilot/replay/analyzer CLIs are not runtime dependencies.

No Node dependency upgrade is required. Keep unrelated newer source-intake, reconciliation, event-suppression, provider-binding, website and downstream-wrapper changes out of a narrow worker release. The current full main installer also contains older447-line lock/provenance/copy/uninstall hardening beyond the Scrapling patch; either review that explicitly or port only the Scrapling integration onto the installed base. No release was constructed or committed during this assessment. Run the exact resulting release's tests: current-development tests for a newer downstream wrapper are not evidence for an isolated release retaining the old wrapper.

The new local main-installer opt-in stages an exact hash-bound manifest and pinned runtime before suspending tasks. Worker startup also verifies the manifest, requirements, receipt and runtime bytes synchronously; partial configuration fails closed, while both unset retains the legacy path. These protections do not migrate baselines, establish provider health or claim ongoing integrity after startup. See `scrapling-runtime-installer.md` for the opt-in parameters and limitations.

The first long-path staging install passed package/version checks but failed the actual native fetcher import on Windows. Its nine attempted recaptures all failed before fetching; these are runtime failures, not webpage failures. Preserve `tmp/scrapling-cutover-20261015/targeted-run-2026-10-15T21-51-32-657Z-9477faff` and the failed runtime. The installer now performs a bounded, no-request import of Scrapling's actual fetcher/native dependencies on both install and reuse.

A new short-root staged install at `C:/Users/matth/AppData/Local/AwardPingScraplingStage20261015` passed package and native-import checks, the finite live follow-up, and exact receipt reuse verification afterward. Requirement SHA: `fa16916c5b0580387498f00cd628f5d1313dafd9b2a37bf5ccec36a714ae09b3`. Receipt SHA: `eb685312c8951711dd091ac16ae0ada0b348611cdc7d066db50396bdc93e768d`. This is a test runtime, not the installed worker. See `scrapling-runtime-installer.md` for base-Python and supply-chain limitations.

Final focused verification:716 JavaScript tests in21 files plus55 Python parser/intercepted-browser tests passed. Strict changed-helper/test lint, worker error-only lint, syntax and diff checks passed. Independent review verified capture identity, mismatch retention, cold-cache evidence and no baseline advancement on holds; it found and fixed the screenshot-publication issue described above. This is not a whole-repository or production end-to-end pass. All finite test/install/capture sessions ended.

Evening integration verification:961 JavaScript tests passed in21 explicitly selected HTML/Scrapling/pilot/replay/retention/queue files, plus55 Python tests using the validated short runtime. This selection differs from the earlier716-test set. Main-installer9 and runtime-helper12 focused tests also passed, including default-off, complete candidate-file validation and legacy rollback. Strict changed-test/helper lint, worker error-only lint, syntax and diff checks passed. The broader existing `worker-installer-update-safety.test.mjs` suite did not produce a result after more than7 minutes and was stopped; it is INCOMPLETE, not green. Its verified test process/children and all other bounded test sessions ended. No exact isolated release or production run has been verified.

Before activation:

1. Resolve the remaining source/document access and extraction gaps; verify exact live source UUID/URL/award mappings and normal approval states. Record unsupported coverage honestly.
2. Verify complete paired semantic comparisons and review holds on the final profile, plus a working review-service submission/approval path. A successful capture is not an accuracy/recall benchmark.
3. Build an isolated, clean, reviewed worker release containing only intended changes and required dependencies; do not install this dirty shared checkout wholesale. Main-installer integration and startup runtime/manifest verification are now implemented locally; verify them again on the exact isolated release, including legacy rollback.
4. Install the pinned runtime in a durable worker-owned location, retain the receipt and stage a validated exact-source manifest. `AWARDPING_SCRAPLING_MANIFEST` and `AWARDPING_SCRAPLING_PYTHON` are currently unset in production. Unsupported legacy fact/localization/HTML-discovery maintenance must remain disabled for Scrapling sources.
5. Perform a bounded baseline-only profile migration with immutable evidence and verified required R2 persistence. Never compare legacy extraction with Scrapling as if an award changed.
6. Activate only after verified rollback and a full healthy run. Keep the existing worker, source histories, baselines and runtime receipts. Rollback also requires explicit profile-compatible baselines, not silently comparing two extraction formats.

No production database/source status, worker configuration, scheduler, baseline, archive, website or publication change was made by this local implementation. A default-off branch and green unit tests are not a completed cutover.

## October 17 offline accuracy corrections

Three narrow corrections were implemented while billing recovery remains separate:

- Complete, explicitly labeled decreasing countdown-only blocks receive a manual hold, not a published update or an automatically advanced baseline. Mixed deadline/funding/audience/cycle changes are not filtered out by this rule.
- HTML-source blocks and links retain their actual `<details>` question ancestry in optional `details_path` fields. Moving an answer/link outside its question is now a structural change rather than an identical document. All three JS evidence validators preserve and bound this field; visible-review routing also requires the question context to match. Empty/ambiguous/unmatched questions remain held. Older evidence stays readable but must not be silently upgraded: use the documented baseline-only refresh when introducing the richer parser. This does not reconstruct missing relationships for old captures or unstructured prose-only nodes.
- The collector binds observed document addresses to the actual final main-frame HTTP response. A path/query rewrite without a matching response is unavailable, not an inferred redirect or replacement source. Genuine redirects retain original source identity and final response status/type; fragment-only changes are permitted. Legitimate client-side routing can consequently remain unsupported. No automatic alternate-source selection is added.

The new `scripts/scrapling-parser-review.test.mjs` exercises real Python extraction through JS validation, serialization and review routing with controlled HTML. Visibility/screenshot receipts in that integration group are synthetic, not browser evidence or verified award facts. Separate collector tests use local intercepted/loopback-only responses, never official award sites.

The root's selected ten-suite regression run passed 508 JavaScript tests, including all 13 parser-to-review integration checks. The separate Python parser and collector suites passed 33 and 38 tests respectively; all fixture processes ended. Recommended Node/ESM lint passed nine touched JS/test files with zero errors/warnings. The updated offline benchmark matched 29 controlled expectations and 14 retained cases; the retained set still has zero independently verified substantive award changes, so real-change recall and AI summary accuracy remain unmeasured. These results do not establish full-source coverage, an exact isolated-release pass, or production readiness. The historical 101/106 HTML acquisition result, NSF gaps and PDF limitations are unchanged; no live collection or activation occurred in this batch.

## October 17 remaining-gap work (local, not activated)

The complete 25-award source audit is recorded in `tmp/scrapling-coverage-audit-20261017/matrix.md` and `.json`. It checks all canonical identities and pins ten historical report/inventory inputs. The selected 106 HTML identities divide into 74 open, 15 held and 17 local proposals; the eight PDFs divide into five open, one held and two proposals. These are October 15 status snapshots, not fresh approval. The historical 101 successful HTML acquisitions and five NSF failures remain separate from factual completeness, current health and automatic-review eligibility.

One new bounded NSF-hub diagnostic (`tmp/nsf-diagnostic-20261017/report.json`) received HTTP 202 with no title or visible text and 2,010 HTML bytes. It remained unavailable. This demonstrates an empty upstream response for that attempt, not a proven parser omission or confirmed CAPTCHA cause. The other four exact-source failures were not retried. Official web-reader access is not equivalent to this collector's acquisition; partial RSS or old-cycle documents do not establish a replacement for current full rules. No threshold reduction or access-control bypass.

### PDF text gaps must not disappear as noise

The existing PDF comparison incorrectly treated different file bytes with identical native text as noise and could advance the baseline. An image/diagram edit can produce precisely that result. It now retains both originals and saves a manual review hold, before interpretation-disabled/noise/AI paths, without baseline rotation or cleanup. Identical PDF bytes still mean the file itself has not changed.

`scripts/lib/pdf-text-coverage.mjs` adds small native-text diagnostics from the existing `pdf-parse` per-page output: ordered complete page list, exact file hash, per-page non-whitespace character counts, and sparse-page warnings below 80 characters. This threshold is a conservative warning, not an OCR detector or proof of completeness; genuine blank pages can be held too. Invalid/missing metadata and sparse pages on either side also hold changed PDFs. Legacy records are not silently upgraded: a reviewed baseline-only refresh or manual review is needed, not a fabricated coverage record. Dense text never claims images, diagrams, multi-column order or all facts were read.

The new metadata stays in the existing hash-bound `meta.json` and review-copy paths. Initial-document sealed-review/recovery and explicitly requested baseline-refresh workflows remain separate existing paths; this change guards ongoing changed-file comparison, not every historical publication path. No PDF file format or source identity is rewritten.

All eight retained PDFs (57 pages) were reparsed offline with the actual worker `pdf-parse` 2.4.5 package. The new diagnostic flags exactly 21 sparse pages in two documents: 20 Knight-Hennessy sample pages and Marshall's final diagram page. Original file hashes remained unchanged. The visual PDF skill check confirmed that the sparse text omitted visible body/diagram content; no OCR or new fact publication was performed. Receipt: `tmp/scrapling-pdf-gap-20261017/report.json`. Other documents passing the density check are not certified semantically complete.

The local release now also depends on `scripts/lib/pdf-text-coverage.mjs` (one addition to the earlier 19-file release boundary). Candidate installer closure checks include it while legacy rollback validation does not require it. No install, schedule/config change, source approval or deployment occurred.

### Closed accordions and supplementary screenshots

The seven retained mismatches were investigated without rewriting captures. All five SMART records differ only by a hidden countdown ticking two seconds in full source prose; replacing that exact timer reproduces each recorded post-screenshot prose hash. Fulbright and NOAA have visible text/block/link differences with unchanged HTML-source semantics; their retained post-observation hashes alone cannot prove the exact cause. All seven current-context sizes exceed the 24,000-byte review packet bound even before previous values are added, so fixing screenshot pairing alone would not make them automatically reviewable.

A local browser fixture reproduced a concrete visibility bug: after an opened `<details>` element closes, Chromium can retain stale child-layout records. The collector now excludes content hidden by the actual `::details-content` style while preserving the first summary and genuinely visible CSS overrides. Main-document style records are bounded and matched by count/order/attributes to snapshot details; mismatches fail, and the style observations join the existing stability fingerprint. Full HTML answers and links are not removed. This is adjacent bracketed evidence, not an atomic DOM/CSS transaction or screenshot geometry.

The regression failed before the fix and passed afterward. All47 collector tests passed, including open/nested details, visible CSS overrides, hidden pseudo-elements, malformed bindings and capture-level full-HTML/screenshot preservation. Those are local/intercepted fixtures, not proof that a live NOAA/Fulbright mismatch was resolved. A new collector should still use a reviewed baseline-only refresh rather than infer an award change from changed extraction behavior.

After independent review and release of collector ownership, one bounded current-code NOAA FAQ capture succeeded: exact source `e5acfcc4-3469-4fc8-99f1-ee14e8dbbda1`, HTTP200, 4,890 visible versus 30,706 HTML-source characters, with screenshot semantics bracketed and no mismatches. Receipt: `tmp/noaa-diagnostic-20261017/run-2026-10-17T20-31-53-482Z-7f59006e/report.json` (SHA256 `679c7af454c30cd6a45f7a278e4806667b1b9d8e8ae0820a959a2ab26d7874fb`). Code/runtime/source hashes remained unchanged; one attempt, no retry. This is fresh acquisition/pairing evidence, not proof of the exact historical mismatch cause, all25 health, closed-answer visibility, source approval or automatic-review eligibility. The old captures and historical audit remain unchanged; full-context review limits still apply.

Final root verification for this remaining-gap batch passed512/512JavaScript tests across14selected suites, including PDF hold paths, retention, network-boundary assertions, installer closure and real parser integration. Strict lint passed six touched root files; worker/helper syntax and diff checks passed. Together with the47collector tests and eight-document PDF replay, this supports the local changes—not an installed-worker, AI accuracy or production cutover claim. No billing, provider, DB, approval, baseline, schedule, installation or deployment action occurred.

## October 17 follow-up: NSF access, scanned PDFs and oversized context

Four remaining exact NSF sources were each requested once with the unchanged ordinary collector. All returned HTTP202 plus `x-amzn-waf-action: challenge`, empty visible content and a2,010-byte challenge DOM. This directly identifies an upstream Challenge interstitial, not applicant content or a proven CAPTCHA. The previous hub result was preserved without a new request or retroactive header inference. Receipt: `tmp/nsf-gap-20261017/run-2026-10-17T22-42-31-855Z/report.json`, SHA256 `85e393a0e1f8eeff735622869b1f51174e223172c4b5f2d7f7bb79660b3b0890`. No cookies, credential headers or request IDs were logged. All five NSF coverage gaps remain; this is independent of Google billing.

The subsequent local collector patch reports `upstream_challenge_response` for only that exact main-response status/header pair. It does not retry, bypass access controls, weaken text requirements or select an alternate page. Existing final-response identity guards remain. The regression failed before the fix; all53collector tests passed afterward using intercepted/loopback fixtures. New collectorSHA256 `73feef72a7689e49e3a3c96ee007615f0264b679aad608f38caf081ad216d609`. Real NSF diagnostic receipts remain pinned to the earlier code, not this new label.

An explicit offline/manual [PDF OCR evidence tool](pdf-ocr-evidence.md) now renders selected retained pages and uses the installed Windows OCR engine. All21flagged pages produced hash-bound supplemental text and word rectangles with unchanged originals. Visual samples show material watermark errors and lost diagram relationships; no OCR confidence/completeness or fact approval is claimed. OCR remains separate from native PDF metadata, worker imports, installer closure and every existing hold. This is a review aid, not an automatic scanned-PDF solution or a new production dependency.

[Lossless v4 review context tables](scrapling-accuracy.md) remove repeated strings and paths after v3 does not fit, with exact current/previous reconstruction checks and all existing gates/size limits intact. Full prose and changed blocks remain uncut. Retained SMART context shrinks substantially, but historical screenshot/countdown holds remain. Fulbright and NOAA still exceed the unchanged24k limit. Prompt handling explains the representation; no Gemini accuracy result or actual queue submission is established.

These are local candidate improvements and diagnostic receipts. No source approval, baseline migration, installed-worker/scheduler configuration, DB, publication, site, provider or billing action occurred. The isolated-release and cutover requirements above remain outstanding.

Final follow-up verification:381/381JavaScript tests across nine selected suites passed, including real Windows blank-image OCR, mocked orchestration, PDF holds, long-page reconstruction, queue serialization, real Python parser integration and accuracy fixtures;53/53collector tests passed separately. Strict recommended lint passed seven touched JS/test files; four previously recorded queue-module escape warnings remain errors outside the new code. Syntax/diff checks passed. Independent added-change reviews found no remaining blocker; none of these checks validates actual Gemini output or a production release.
