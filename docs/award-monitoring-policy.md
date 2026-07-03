# Award Monitoring Policy

AwardPing's global monitoring policy lives in:

`config/award-monitoring-policy.json`

Use this file as the first stop for stipulations that decide what should become a public update, what should be filtered as noise, and what source-quality cleanup should treat as low-value or bad source shape.

## How It Is Used

- App-side change classification and public rendering use `src/lib/award-monitoring-policy.ts`.
- Node runners use `scripts/lib/award-monitoring-policy.mjs`.
- Visual snapshot AI prompts include policy prompt lines by scope.
- The overnight source-quality pass records the active policy version in each report.

## Adding A Stipulation

1. Add a named entry to `policy_flags` or `source_quality_stipulations`.
2. Give update filters a stable `id`, for example `relative_age_timestamp_churn`.
3. Set `alert_blocking: true` when the flag should prevent public updates.
4. Set `persistent: true` when stored change details with that flag should keep being filtered later.
5. Add `prompt_scopes` and `prompt` when AI review should receive the stipulation.
6. Wire deterministic helper logic only when text or metadata can reject it without AI.
7. Add or update tests in `src/lib/award-monitoring-policy.test.ts` and the relevant classifier test.

## Current Example

`relative_age_timestamp_churn` covers news/listing recency labels such as `8 days ago` becoming `9 days ago`. That is not an applicant-facing award change and should not produce an update for any award.
