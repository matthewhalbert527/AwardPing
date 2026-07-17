import { Resend } from "resend";
import { displayChangeSummary } from "@/lib/change-summary";
import { appConfig } from "@/lib/config";
import type { PublicDigestChange } from "@/lib/public-updates-core";
import { formatCentralDate } from "@/lib/time-zone";

let resend: Resend | null = null;

export type ChangeAlertEmail = {
  to: string;
  label: string;
  url: string;
  summary: string;
  changeDetails?: unknown;
};

export type OfficeInviteEmail = {
  to: string;
  officeName: string;
  inviteUrl: string;
};

export type DigestChange = {
  label: string;
  url: string;
  summary: string;
  changeDetails?: unknown;
  detectedAt: string;
};

export type DailyDigestEmail = {
  to: string;
  officeName: string;
  changes: DigestChange[];
};

export type PublicUpdateConfirmationEmail = {
  to: string;
  confirmUrl: string;
};

export type PublicDailyDigestRenderInput = {
  changes: PublicDigestChange[];
  unsubscribeUrl: string;
};

export type RenderedPublicDailyDigestEmail = {
  from: string;
  subject: string;
  html: string;
  text: string;
};

export type FrozenPublicDailyDigestEmail = RenderedPublicDailyDigestEmail & {
  to: string;
  idempotencyKey: string;
};

export class PublicDigestDeliveryError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PublicDigestDeliveryError";
  }
}

export type ContactFormEmail = {
  to: string;
  name: string;
  email: string;
  message: string;
};

export async function sendChangeAlertEmail(input: ChangeAlertEmail) {
  const summary = displayChangeSummary(input.summary, input.url, input.changeDetails);

  if (!appConfig.resendApiKey) {
    logSkippedEmail("alert", {
      to: input.to,
      label: input.label,
      url: input.url,
    });
    return { skipped: true };
  }

  resend ??= new Resend(appConfig.resendApiKey);

  return resend.emails.send({
    from: appConfig.alertFromEmail,
    to: input.to,
    subject: `${input.label} updated`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">AwardPing found an award page update</h1>
        <p><strong>${escapeHtml(input.label)}</strong> updated.</p>
        <p>${escapeHtml(summary)}</p>
        <p><a href="${escapeHtml(input.url)}">Open tracked award page</a></p>
      </div>
    `,
    text: `AwardPing found an award page update\n\n${input.label} updated.\n${summary}\n${input.url}`,
  });
}

export async function sendOfficeInviteEmail(input: OfficeInviteEmail) {
  if (!appConfig.resendApiKey) {
    logSkippedEmail("office invite", {
      to: input.to,
      officeName: input.officeName,
      inviteUrl: "[redacted]",
    });
    return { skipped: true };
  }

  resend ??= new Resend(appConfig.resendApiKey);

  return resend.emails.send({
    from: appConfig.alertFromEmail,
    to: input.to,
    subject: `Join ${input.officeName} on AwardPing`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">You were invited to an AwardPing office</h1>
        <p>${escapeHtml(input.officeName)} invited you to share its award page watchlist.</p>
        <p><a href="${escapeHtml(input.inviteUrl)}">Accept invitation</a></p>
      </div>
    `,
    text: `You were invited to join ${input.officeName} on AwardPing.\n\n${input.inviteUrl}`,
  });
}

export async function sendDailyDigestEmail(input: DailyDigestEmail) {
  if (!appConfig.resendApiKey) {
    logSkippedEmail("daily digest", {
      to: input.to,
      officeName: input.officeName,
      changes: input.changes.length,
    });
    return { skipped: true };
  }

  resend ??= new Resend(appConfig.resendApiKey);
  const changes = input.changes.map((change) => ({
    ...change,
    summary: displayChangeSummary(change.summary, change.url, change.changeDetails),
  }));

  const listHtml = changes
    .map(
      (change) => `
        <li style="margin-bottom: 16px;">
          <strong>${escapeHtml(change.label)}</strong><br />
          ${escapeHtml(change.summary)}<br />
          <a href="${escapeHtml(change.url)}">Open tracked page</a>
        </li>
      `,
    )
    .join("");

  const listText = changes
    .map(
      (change) =>
        `${change.label}\n${change.summary}\n${change.url}\nDetected: ${change.detectedAt}`,
    )
    .join("\n\n");

  return resend.emails.send({
    from: appConfig.alertFromEmail,
    to: input.to,
    subject: `${input.officeName} AwardPing daily digest`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">AwardPing daily digest</h1>
        <p>${escapeHtml(input.officeName)} had ${input.changes.length} tracked update${
          input.changes.length === 1 ? "" : "s"
        }.</p>
        <ul>${listHtml}</ul>
      </div>
    `,
    text: `AwardPing daily digest for ${input.officeName}\n\n${listText}`,
  });
}

export async function sendPublicUpdateConfirmationEmail(input: PublicUpdateConfirmationEmail) {
  if (!appConfig.resendApiKey) {
    logSkippedEmail("public update confirmation", {
      to: input.to,
      confirmUrl: "[redacted]",
    });
    return { skipped: true };
  }

  resend ??= new Resend(appConfig.resendApiKey);

  return resend.emails.send({
    from: appConfig.alertFromEmail,
    to: input.to,
    subject: "Confirm your AwardPing daily updates",
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">Confirm your daily AwardPing updates</h1>
        <p>Use the link below to receive daily emails when AwardPing detects useful public award-page updates.</p>
        <p><a href="${escapeHtml(input.confirmUrl)}">Confirm daily updates</a></p>
        <p style="color: #626b7c; font-size: 13px;">If you did not request this, you can ignore this email.</p>
      </div>
    `,
    text: `Confirm your daily AwardPing updates\n\n${input.confirmUrl}\n\nIf you did not request this, you can ignore this email.`,
  });
}

export function renderPublicDailyDigestEmail(
  input: PublicDailyDigestRenderInput,
): RenderedPublicDailyDigestEmail {
  const listHtml = input.changes
    .map(
      (change) => `
        <li style="margin-bottom: 18px;">
          <strong>${escapeHtml(change.awardName)}</strong><br />
          <span>${escapeHtml(change.sourceTitle)}</span><br />
          ${escapeHtml(change.summary)}<br />
          <a href="${escapeHtml(change.sourceUrl)}">Open source page</a>
        </li>
      `,
    )
    .join("");

  const listText = input.changes
    .map(
      (change) =>
        `${change.awardName}\n${change.sourceTitle}\n${change.summary}\n${change.sourceUrl}\nDetected: ${formatDigestDate(change.detectedAt)}`,
    )
    .join("\n\n");

  return {
    from: appConfig.alertFromEmail,
    subject: `AwardPing daily updates: ${input.changes.length} award page update${
      input.changes.length === 1 ? "" : "s"
    }`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">AwardPing daily updates</h1>
        <p>AwardPing found ${input.changes.length} useful public award-page update${
          input.changes.length === 1 ? "" : "s"
        }.</p>
        <ul>${listHtml}</ul>
        <p style="color: #626b7c; font-size: 13px;">
          <a href="${escapeHtml(input.unsubscribeUrl)}">Unsubscribe</a> from public daily updates.
        </p>
      </div>
      `,
    text: `AwardPing daily updates\n\n${listText}\n\nUnsubscribe: ${input.unsubscribeUrl}`,
  };
}

export async function sendFrozenPublicDailyDigestEmail(
  input: FrozenPublicDailyDigestEmail,
) {
  if (!appConfig.resendApiKey) {
    logSkippedEmail("public daily digest", { to: input.to });
    throw new PublicDigestDeliveryError(
      "Public daily digest delivery is unavailable because RESEND_API_KEY is not configured.",
      false,
      false,
    );
  }

  resend ??= new Resend(appConfig.resendApiKey);
  let result: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    result = await resend.emails.send(
      {
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  } catch (error) {
    throw new PublicDigestDeliveryError(
      `Public daily digest provider outcome is unknown: ${errorMessage(error)}`,
      true,
      true,
    );
  }

  if (result.error) {
    throw new PublicDigestDeliveryError(
      `Public daily digest provider rejected the request: ${result.error.message}`,
      false,
      true,
    );
  }
  if (!result.data?.id) {
    throw new PublicDigestDeliveryError(
      "Public daily digest provider did not confirm a delivery request ID.",
      true,
      true,
    );
  }

  return { providerMessageId: result.data.id };
}

export async function sendContactFormEmail(input: ContactFormEmail) {
  if (!appConfig.resendApiKey) {
    logSkippedEmail("contact form", {
      to: input.to,
      from: input.email,
    });
    return { skipped: true };
  }

  resend ??= new Resend(appConfig.resendApiKey);

  return resend.emails.send({
    from: appConfig.alertFromEmail,
    to: input.to,
    replyTo: input.email,
    subject: `AwardPing contact form: ${input.name}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #17211b; line-height: 1.55;">
        <h1 style="font-size: 22px;">AwardPing contact form</h1>
        <p><strong>Name:</strong> ${escapeHtml(input.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(input.email)}</p>
        <p><strong>Message:</strong></p>
        <p>${escapeHtml(input.message).replaceAll("\n", "<br />")}</p>
      </div>
    `,
    text: `AwardPing contact form\n\nName: ${input.name}\nEmail: ${input.email}\n\n${input.message}`,
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function logSkippedEmail(kind: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") {
    console.log(`RESEND_API_KEY missing; skipped ${kind} email`);
    return;
  }

  console.log(`RESEND_API_KEY missing; skipped ${kind} email`, details);
}

function formatDigestDate(value: string) {
  return formatCentralDate(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown provider error.");
}
