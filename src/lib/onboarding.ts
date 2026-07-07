import "server-only";

import { getUserProfile } from "@/lib/auth";
import type { OfficeContext } from "@/lib/offices";
import { getOfficeContext } from "@/lib/offices";
import { isPlaceholderOfficeName } from "@/lib/office-names";

type UserLike = {
  id: string;
  email?: string | null;
};

export type OnboardingStatus = {
  profile: Awaited<ReturnType<typeof getUserProfile>>;
  officeContext: OfficeContext | null;
  needsProfile: boolean;
  needsOffice: boolean;
  isComplete: boolean;
};

export async function getOnboardingStatus(user: UserLike): Promise<OnboardingStatus> {
  const [profile, officeContext] = await Promise.all([
    getUserProfile(user.id),
    getOfficeContext(user),
  ]);

  const needsProfile = !profile?.full_name?.trim() || !profile?.organization?.trim();
  const needsOffice = !officeContext || isPlaceholderOfficeName(officeContext.current.officeName);

  return {
    profile,
    officeContext,
    needsProfile,
    needsOffice,
    isComplete: !needsProfile && !needsOffice,
  };
}

export function onboardingRedirectPath(status: Pick<OnboardingStatus, "isComplete">) {
  return status.isComplete ? "/updates" : "/dashboard/onboarding";
}
