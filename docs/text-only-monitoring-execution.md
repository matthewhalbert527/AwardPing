# Text-only AwardPing execution

Approved by the user on October23,2026. This supersedes the screenshot-dependent migration plan. Codex recurring follow-ups remain stopped.

## Product

- Current program details, concise genuine updates, official source links.
- Optional Exact wording for verified program-detail changes only.
- No screenshot capture, image AI, crops, visual evidence UI or signed asset endpoints.
- HTML/rendered HTML/native PDF/OCR text capture. OCR temporary images are extraction intermediates only.
- Fresh verified per-source baseline and epoch; initial coverage is not an update.
- Preserve old captures, reviews, sources and history privately. No automatic old paid retry or deletion.

## Implementation checklist

- [x] Remove all public/admin/watchlist visual evidence surfaces and retire two asset routes with410/no signing.
- [x] Implement neutral capture with exact raw source, complete text, source/owner/URL identity, blocks/page references, completeness and hashes.
- [x] Implement one bounded complete text comparison, field-specific review and exact quote validation.
- [x] Extend source state, publication transaction, public eligibility and digest authorization for the explicit text contract.
- [x] Integrate ordinary collection/review with existing spend limits, locks, idempotency and queues.
- [ ] Curate all25 required source sets, establish text baselines, and repeat captures.
- [ ] Stage and verify matching web/worker release, promote, install and verify ordinary monitoring.
- [ ] Confirm all25 complete sets and one normal daily run; report actual gaps.

## Verified before release

Final frozen release validation: production build/TypeScript passed; the complete dual-runner suite passed 9,395 Vitest tests and70 native Node compatibility tests (76 explicit environment-gated skips). Scoped lint and diff checks passed. Real runtime acquisition and native Windows installer/ACL fixtures were also exercised separately. Local homepage, updates and award-detail verification found no visual preview controls; both retired asset APIs returned410/no-store.

The database rehearsal used clearly synthetic facts inside an explicit rollback-only transaction. It passed silent first coverage, eight rejected invalid operations, UTF16 quotation binding, atomic publication, deferred triggers and idempotency. Independent readback confirmed no fixture source state, candidate, event or evidence remained. No paid model request was used for this rehearsal.

The read-only roster is 25 cohorts / 124 required source identities. Representative HTML and Marshall native-PDF acquisition passed. All four NSF legacy sources were independently checked against their exact official `nsf.gov` redirects; the configuration permits only those four final URLs.

Three required CLS paths return404: `/apply`, `/applicants/frequently-asked-questions`, `/applicants/selection`. Current official navigation points to `/applicants`, `/applicants/applicant-faq`, `/applicants/selection-process`. Their source/role corrections and current-fact review remain outstanding; do not mark CLS complete. OCR reading order remains explicitly unverified. A changed original PDF with unchanged native text is held rather than silently assumed to be metadata-only.

The correct CLS FAQ already exists as open source `6fbf523f-bc57-472b-8262-14600c1f4c46`, owned by CLS `ba1a3c76-4868-42b4-994b-6cbae72a7044`. Reuse it; do not overwrite the old FAQ `9592e589-2c8d-4f60-8aeb-3d4d97c1fae4` or transfer its selected facts. Applicant overview and selection-process need new source identities, preserving old apply `cb980b70-0938-4bbe-a32a-091ec44420d7` and selection `21511614-8d4c-4068-b81e-7f54ce33fa1b`. Correct collection roles are overview for dates/cycle, FAQ for FAQ/materials, and selection-process for selection/interviews. Funding needs its own source check, not a mechanical FAQ transfer. The existing legacy manifest setter still requires visual/fact authority, so use a separately reviewed collection-only correction rather than invented visual evidence, URL rewrites, deletion, or the held legacy intake queue.

Legacy image-retry and discovered-PDF submission endpoints are retired with no-store410 responses. Intake capture/AI retries are held before record access; private historical review records remain unchanged. Legacy visual worker queries exclude the new text scope even if manually invoked.

Collection completeness and current-fact acceptance are separate. Fresh text captures do not automatically replace previously reviewed public award facts or create initial-coverage alerts. Preserved visual review history is not retried by the new daily lanes.

## Contracts

Capture schema: `awardping.program-text-capture.v1`; profile `program-text-capture-v1`; acquisition `http_html|rendered_html|pdf_text|pdf_ocr`. Exact text block offsets are UTF16 with an exclusive end. Raw artifact hashes are SHA256 over the actual bytes. No image/layout artifact slots.

Event schema: `awardping.program-change.v1`; kind `program_details_changed`; summary and `program_changes`. Each change has an allowed program field, operation `add|remove|replace`, summary, and previous/current exact quote references (the absent side is null only for real additions/removals). Quote references contain block_id,start_utf16,end_utf16,text. Publication binds source/owner/URL, epoch, both immutable captures and the validated details.

Tracked fields cover dates/application status, eligibility/citizenship/academic level/discipline, funding/benefits/duration, application/nomination/material requirements, selection and applicant instructions/application destination/contact. No news/roster/layout/timestamp/file-only alerts.

## Publication permissions

The private evidence table retains its restriction on direct service-role inserts. Only `publish_program_text_event(uuid,jsonb,jsonb)` is SECURITY DEFINER, with an empty search path and EXECUTE restricted to service_role. Its fixed-table transaction validates source approval, candidate identity, epoch, immutable capture references and exact quotations before publishing and advancing the baseline. The source-state RPC and validation helpers remain SECURITY INVOKER. Historical visual publication guards and table-write permissions remain intact.

The rollback rehearsal exercises this exact service-role boundary, including rejected inputs, initial coverage, publication, idempotency and immediate execution of deferred constraints. Its synthetic rows are enclosed in a transaction ending in ROLLBACK; a separate read-only query verifies their absence afterward.

## Acceptance

- No image artifacts, visual endpoints or image/PDF provider attachments in new monitoring.
- Complete long-page/table/FAQ/PDF coverage; uncertain extraction or interpretation is held.
- Exact same-source/side/cycle quotes and strict source ownership checks.
- Silent initial baselines; legacy holds do not enter the new epoch.
- Consistent website/award facts/counts/read state/email; no duplicate notifications.
- Existing daily monitoring remains managed and enabled after installation; no second scheduler.
- All25 require complete reviewed source sets plus a repeat capture and normal scheduled operation.
