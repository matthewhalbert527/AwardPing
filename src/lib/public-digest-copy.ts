// Shared public wording; this module does not submit, confirm, or cancel email.
export const PUBLIC_DIGEST_LABEL = "Daily digest";
export const PUBLIC_DIGEST_DESCRIPTION =
  "Get a daily email when useful changes appear on official award pages. Quiet days stay quiet.";

export type PublicDigestStatusParams = { confirmed?: string; unsubscribed?: string };

// Preserve the redirect parameters and their existing precedence. Unknown
// values produce no notice, and invalid links never imply a successful action.
export function publicDigestStatusMessage(params: PublicDigestStatusParams) {
  if (params.confirmed === "1") return "Your AwardPing daily digest is confirmed.";
  if (params.confirmed === "invalid") return "That confirmation link is no longer valid.";
  if (params.unsubscribed === "1") return "You have been unsubscribed from the AwardPing daily digest.";
  if (params.unsubscribed === "retry") {
    return "A digest is already being sent. Please use the unsubscribe link again in a few minutes.";
  }
  if (params.unsubscribed === "invalid") return "That unsubscribe link is no longer valid.";
  return "";
}
