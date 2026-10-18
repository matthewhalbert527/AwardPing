# Scrapling follow-up — October 18, 2026

These changes repair review and capture gaps. They do not certify all25 awards or authorize a blanket baseline refresh.

- Retry stored completed changed-page reviews after normal polling/submission, even when no provider batch is active. Admit at most100 rows with a soft60-second deadline before claiming the next row; never cancel in-flight publication. Keep claim, source-order, evidence and current-policy checks; do not resubmit a completed answer to Gemini. Initial-document recovery is unchanged.
- Correct three SETOFtext column aliases in the existing database semantic-side helper. No evidence-rule, ownership or privilege change.
- Soros: if the first screenshot changes document dimensions, make one fresh capture with a viewport set to the full document height. Re-observe content; require exact before/image/after dimensions and full fit. Persistent resize, overflow, content changes and challenges stay held. No highlight coordinates are inferred.
- Permit a complete hash-verified screenshot with explicitly unavailable geometry to remain a full-image fallback. Require exact known sealed metadata projections; keep crops/layout/verified-at absent. Missing or contradictory evidence is still rejected.
- Keep24k as the lossless compaction threshold; permit a complete long-page review packet up to128k UTF-8 bytes. Full context and both original artifacts remain required; eight changed-block and8k changed-character limits remain. Oversized/ambiguous/hidden changes stay held. Existing full-request spend reservations, models and budgets are unchanged.

Local tests verify routing, reconstruction, byte bounds and prompt transport. They do not establish real-world AI summary accuracy. Source approvals, reviewed-page coverage, legacy review preservation and acquisition success are separate migration gates.
