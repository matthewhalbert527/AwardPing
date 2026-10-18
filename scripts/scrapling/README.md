# AwardPing's small Scrapling collector

## October 18 status and source-only HTML

The live worker currently selects 14 HTML pages across nine awards. This is a partial rollout, not all 25 awards. Check `CURRENT_STATE.md` and the installed manifest for the latest verified scope; the dated pilot notes below describe earlier work.

The follow-up implementation adds an explicit per-source `scrapling-source-html-v1` profile for official pages available through ordinary anonymous HTTPS. It uses Scrapling's normal fetcher with bounded, public-only access. It is not an automatic fallback from a challenged browser, does not solve challenges, and does not use cookies, login, impersonation or redirects.

Source-only captures retain three bound files: raw HTML as inert text, complete parsed review text/context, and metadata. They have no screenshot or visibility claim. Changes must match the same profile, retain complete before/after context and pass the existing AI review and publication gates. The website shows the verified summary and official source link; it does not offer a nonexistent screenshot or serve raw HTML. Structural, ambiguous, incomplete and unsupported changes remain held for review.

Five current NSF pages and their repeat captures passed local acquisition checks, including all 48 FAQ answers. That is not source approval, a paid-model accuracy result or live activation. Normal source intake and atomic registration are still required before selecting their returned UUIDs. Intake's bounded source-relevance review is not full-document factual certification. First baselines do not create award updates. Image-only PDFs remain a separate, explicitly limited document path.

Deploy the matching worker, publication/recovery schema and website support before selecting this new profile. Preserve queued reviews and older evidence during any profile migration.

## Earlier pilot notes

This is an isolated **replacement candidate for page acquisition**, not a new production worker. The website, production schedule, baselines, review queue and publication rules are unchanged. The existing HTML and screenshot work is preserved.

The October 15 daily-worker adapter is also local and default-off. It selects only exact reviewed source IDs/URLs and retains the existing PDF path. See [the cutover status](../../docs/scrapling-worker-cutover-20261015.md) for source review, remaining coverage gaps, runtime staging and activation prerequisites; successful pilot captures do not mean the daily worker has switched.

## One path, three responsibilities

1. Fetch once: `collector.py` uses Scrapling to load one official page and retain its HTML plus a browser-visible diagnostic view. `../lib/scrapling-capture.mjs` validates that record and reuses AwardPing's existing bounded, public-only network proxy.
2. Read the full HTML: `html_document.py` uses Scrapling to extract source text, headings/list/table context and raw links, including closed accordions and scroll-hidden sections. It runs offline on the retained HTML, without clicking or fetching again. Full source text is the primary change-review input; visible-only comparison is a diagnostic, not complete award coverage.
3. Compare and report: `../capture-scrapling-pilot.mjs` saves two rounds over the independently identified 25-award roster. `../analyze-scrapling-html.mjs` produces a separate, immutable HTML-source comparison from those verified captures. Neither imports or starts the production worker.

Rendering is used consistently in this first version because CSS visibility was the previous pilot's primary problem. No HTTP-to-browser switching, adaptive similarity, AI extraction, CAPTCHA solving, cookie login or automatic accordion clicking. Those are not necessary to establish an accurate baseline.

## Install and run

Use an isolated Python 3.10+ environment, not the application's Node dependencies or a shared Python installation:

```powershell
python -m venv tmp/scrapling-runtime
./tmp/scrapling-runtime/Scripts/python.exe -m pip install -r scripts/scrapling/requirements.txt
node scripts/capture-scrapling-pilot.mjs --roster=tmp/scrapling-pilot-20261015/roster.json
# Use the actual new run directory printed by the capture command:
node scripts/analyze-scrapling-html.mjs tmp/scrapling-pilot-20261015/runs/run-<timestamp>
```

An installed Chrome or Edge is used without attaching to the user's browser profile. `--python=<path>` and `--browser=<path>` can specify runtimes; `--concurrency=1` reduces load. Default concurrency is two. Each capture has a 90-second process-tree deadline and 60 MiB aggregate proxied-network limit. Browser routing allows only GET/HEAD, with strict TLS, public-address validation, standard ports, no service workers or WebSockets and no retained user sessions. Raw HTML is capped at 5 MiB and rendered text at 250,000 characters.

The roster contains reviewed source identities, not crawler-discovered URLs. Registry-homepage fallbacks are explicitly labelled and do not establish active monitoring or published-award status. PDF entries are inventoried, not silently parsed as HTML.

## Results and accuracy

Each new run is under `tmp/scrapling-pilot-20261015/runs/run-<timestamp>/`. Existing runs are never overwritten. `progress.jsonl` survives interrupted runs. Capture `report.json`, `summary.md` and `implementation.json` report acquisition and visible-only diagnostics. The primary HTML-source report and derived documents are in a new `html-analysis-<timestamp>/` child. Records bind each extracted document to the exact capture file and HTML hashes. A nonzero completion status means coverage gaps remain; it does not erase successful evidence.

- `unchanged`: the selected view's content, context and links match. The HTML report includes closed source sections; the visible-only capture report does not. Neither certifies coverage of an entire interactive website.
- `changed_needs_review`: a verified observed difference, not yet a meaningful award update. Navigation, countdowns or consent text may still produce candidates.
- `unavailable`: failed, incomplete, invalid, incompatible or missing evidence. Never treated as unchanged or as a deletion.

The raw HTML and rendered projection are different evidence layers. Chromium's native layout snapshot supplies rendered text (including CSS capitalization and non-selectable text), filtered by computed visibility. Scrapling parses that inert projection without executing retained HTML. Native browser URL resolution preserves query-string and other link semantics. List qualifications, heading paths, table-row/cell context, duplicate text and link destinations remain available for comparison. Full observed text is also compared so unstructured prose outside semantic elements cannot be silently ignored. The projection is retained for exact offline re-parsing. Raw HTML is an adjacent ancillary observation, not the authority for visibility or screenshot alignment.

The HTML-source parser intentionally includes hidden or possibly stale body content, while excluding scripts, styles, comments, templates and `noscript` text. This catches closed-section changes but does not choose which conflicting statement is current. It preserves raw link/base attributes without guessing URL resolution. HTML snapshots are genuine retained DOM observations; the browser readiness check establishes visible-content stability, not hidden-content stability. Source differences still require context/relevance review before any summary or publication.

Limitations are explicit: no expansion/scroll activation; iframe/shadow contents, form values, image text, generated CSS text, clipping/occlusion and image-only link labels are not fully verified. The native snapshot has DOM preflight and a 20 MiB post-read check, not a streaming browser-memory allocation limit. No screenshot location is claimed. No adaptive selector is allowed to silently substitute a similar deadline. Two same-day captures measure repeatability; manually labelled changes and controlled fixtures are required to assess accuracy.

WebSockets are intercepted without connecting to their servers or returning messages. Where a page attempts one, the record discloses that live-connection content was not observed; the client sees a mocked connection. The handler is nonblocking to avoid a Playwright synchronous-close deadlock, covered by an intercepted browser regression test.

Semantic blocks and heading paths are navigation aids, not independently verified award facts. Text in ordinary `div` elements may appear only in the full text/projection, and a footer can follow an unrelated article heading. A qualification in a preceding paragraph may apply to a later list. Downstream interpretation must use the complete retained context, not a standalone block or heading label.

October 17 context correction: HTML-source blocks and links inside `<details>` now retain an optional `details_path`, containing the first direct-child summary of each ancestor details container, outermost first. This ties an FAQ answer or application link to its actual question without inventing an HTML heading level. Missing/empty summaries contribute an empty string (an unlabeled container), not a guessed browser label; siblings outside the container have no field. Opening/closing the same details element does not change this source context or establish visibility. The additive field preserves reading of older captures, but parser introductions require a baseline-only refresh before ordinary comparison; newly retained context is not an award update. This is source-structure evidence, not proof of the question's factual applicability. Ordinary unstructured text still has the limitations above.

The report's `legacy_parser_agreement` runs the earlier raw-HTML parser against the **same** retained capture. It is a focused visibility diagnostic, not a fresh run of the production worker or a directly comparable historical accuracy score.

## Verification

```powershell
./tmp/scrapling-runtime/Scripts/python.exe -m unittest discover -s scripts/scrapling -p "test_*.py"
node node_modules/vitest/vitest.mjs run scripts/lib/scrapling-capture.test.mjs scripts/scrapling-pilot.test.mjs scripts/analyze-scrapling-html.test.mjs --maxWorkers=1
node node_modules/vitest/vitest.mjs run scripts/scrapling-parser-review.test.mjs --maxWorkers=1
```

The parser-to-review integration suite executes the real Python HTML parser and JS validators/formatter/review gate against controlled HTML. Its visible-text and screenshot-pairing assertions are explicitly synthetic: it verifies the language boundary and safe routing, not a real browser observation or AI accuracy. It uses the existing local `tmp/scrapling-runtime/Scripts/python.exe`; set `AWARDPING_SCRAPLING_TEST_PYTHON` to an explicit existing interpreter for another environment. A missing default runtime visibly skips the group; an explicitly selected missing/broken runtime fails. Each parser call has a 15-second deadline and no provider/credential/worker loading.

Collector tests intercept all browser requests with local fixtures; they do not fetch award sites. Controlled requirements/deadline/link changes are separate from genuine live observations. Production adoption requires source-coverage review, retained-evidence compatibility and a reviewed release; this pilot cannot activate itself.

October 17 closed-accordion correction: Chromium can leave old child-layout records after an opened `<details>` element closes. The native projection now checks bounded main-document `::details-content` computed-style observations, bound to snapshot order/count/attributes and included in the existing observation fingerprint. Hidden details content is excluded from the visible projection while the first direct summary keeps its own visibility rules; explicitly visible CSS overrides and open content are preserved. Full source HTML and its closed answers/links remain retained. Ambiguous bindings fail rather than guess. These adjacent reads are bracketed, not an atomic DOM/CSS transaction or complete pixel-visibility proof. Regressions use local/intercepted pages and preserve all screenshot mismatch/review guards.

October 17 NSF diagnostic: an exact final main-frame HTTP202 response carrying `x-amzn-waf-action: challenge` now fails with `upstream_challenge_response` after the ordinary response type/URL checks. This records a clear unavailable reason, not a CAPTCHA diagnosis, accepted applicant page or access workaround. No retries, authentication, challenge-solving, raw header retention or new source substitution is added. Ordinary low-text failures and response-change protections remain. Four bounded exact-source NSF attempts established this response before the label change; the earlier hub failure was not retried. All five NSF roles remain unavailable.

## Optional worker evidence profile

`scrapling-evidence-v1` keeps the accepted atomic HTML/visible-text observation as primary evidence, then captures a supplementary screenshot. It records whether page semantics match on both sides of the screenshot. If they do not, the exact mismatch hashes and a warning are retained: the image is not silently discarded, nor claimed aligned. Navigation, unreadable content, network-boundary failures and other acquisition failures still fail closed. The original pilot profile is unchanged.

The worker adapter retains this evidence in the existing archive format, without inventing element geometry. Its separate comparison branch avoids legacy sentence-noise baseline advancement. Only bounded, complete changed blocks with unique visible corroboration, unchanged structure/context, and compatible screenshot evidence may reach existing review gates. Hidden, duplicated, unsupported, structural, oversized or screenshot-mismatched changes retain both captures for manual review. This is conservative eligibility for review, not proven factual accuracy or complete automatic coverage. PDF discovery remains passive main-document observation, not exhaustive website discovery.
