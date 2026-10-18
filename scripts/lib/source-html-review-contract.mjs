import { SOURCE_HTML_PROFILE } from "./source-html-evidence.mjs";

// A source response is not a browser capture. Both queue validation and temporal
// review must recognize the same explicit contract, never a missing-image fallback.
export function sourceHtmlReviewPairingVerified(candidate, diff) {
  const semantics = diff?.scrapling_semantics;
  const refs = [candidate?.prompt_payload?.previous_snapshot_ref, candidate?.prompt_payload?.new_snapshot_ref];
  return diff?.candidate_scope === "scrapling_html_source" && semantics?.complete === true &&
    semantics?.capture_profile === SOURCE_HTML_PROFILE && semantics?.acquisition === "ordinary_anonymous_http" &&
    semantics?.visibility_verified === false && semantics?.visible_prose_corroborated === false &&
    semantics?.screenshot_available === false && semantics?.source_main_prose_corroborated === true &&
    semantics?.source_main_prose_rule === "unique_complete_changed_blocks_with_ordered_source_main_context" &&
    semantics?.evidence?.capture_profile === SOURCE_HTML_PROFILE &&
    ["previous_html_sha256", "current_html_sha256", "previous_source_main_sha256", "current_source_main_sha256"]
      .every(key => /^[a-f0-9]{64}$/.test(semantics?.evidence?.[key] || "")) &&
    candidate?.prompt_payload?.include_images === false &&
    refs.every((ref, index) =>
      ref?.capture_profile === SOURCE_HTML_PROFILE && ref?.metadata?.capture_profile === SOURCE_HTML_PROFILE &&
      !ref.image_hash && !ref.file_hash && !ref.layout_hash && Array.isArray(ref.visual_states) && !ref.visual_states.length &&
      ref.metadata?.source_html?.schema === "awardping.source-html-review-proof.v1" &&
      ref.metadata.source_html.html_sha256 === ref.local_paths?.html?.sha256 &&
      ref.local_paths?.html?.sha256 === semantics.evidence[`${index ? "current" : "previous"}_html_sha256`] &&
      ref.metadata.source_html.source_main_sha256 === semantics.evidence[`${index ? "current" : "previous"}_source_main_sha256`] &&
      ref.text_hash === semantics.evidence[`${index ? "current" : "previous"}_text_hash`] &&
      ref.captured_at === semantics.evidence[`${index ? "current" : "previous"}_captured_at`] &&
      ref.final_url === semantics.evidence.final_url) &&
    (!candidate?.shared_award_source_id || candidate.shared_award_source_id === semantics.evidence.source_id) &&
    (!candidate?.shared_award_id || candidate.shared_award_id === semantics.evidence.award_id);
}
