import "server-only";

import { appConfig } from "@/lib/config";

export const inviteOnlySignupHostedRequirement =
  "Hosted Supabase Auth must report disable_signup=true before release.";

export type InviteOnlySignupReadiness = {
  ready: boolean;
  status: "ready" | "unsafe" | "unknown";
  disableSignup: boolean | null;
  reason: string;
};

type CheckOptions = {
  supabaseUrl?: string;
  anonKey?: string;
  fetchImpl?: typeof fetch;
};

export async function checkInviteOnlySignupReleaseReadiness(
  options: CheckOptions = {},
): Promise<InviteOnlySignupReadiness> {
  const supabaseUrl = (options.supabaseUrl ?? appConfig.supabaseUrl).trim();
  const anonKey = (options.anonKey ?? appConfig.supabaseAnonKey).trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!supabaseUrl || !anonKey) {
    return unknown("Supabase URL or public anon key is unavailable.");
  }

  try {
    const response = await fetchImpl(
      `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/settings`,
      {
        method: "GET",
        headers: { apikey: anonKey },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      return unknown(`Supabase Auth settings returned HTTP ${response.status}.`);
    }

    const settings = (await response.json().catch(() => null)) as {
      disable_signup?: unknown;
    } | null;

    if (settings?.disable_signup === true) {
      return {
        ready: true,
        status: "ready",
        disableSignup: true,
        reason: inviteOnlySignupHostedRequirement,
      };
    }

    if (settings?.disable_signup === false) {
      return {
        ready: false,
        status: "unsafe",
        disableSignup: false,
        reason: "Hosted Supabase Auth still permits public signup.",
      };
    }

    return unknown("Supabase Auth settings did not include disable_signup.");
  } catch {
    return unknown("Supabase Auth settings could not be verified.");
  }
}

function unknown(reason: string): InviteOnlySignupReadiness {
  return {
    ready: false,
    status: "unknown",
    disableSignup: null,
    reason,
  };
}
