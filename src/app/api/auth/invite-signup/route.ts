import { NextResponse } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

const genericError = "We could not create an account with that invitation.";

const signupSchema = z
  .object({
    inviteToken: z
      .string()
      .trim()
      .min(8)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    password: z.string().min(12).max(128),
  })
  .strict();

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type Reservation = {
  invite_id: string;
  office_id: string;
  normalized_email: string;
  reservation_id: string;
};

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return errorResponse(400);
  }

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (!isSameOriginMutationRequest(request)) {
    return errorResponse(403);
  }
  if (!parsed.success) {
    return errorResponse(400);
  }

  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    reportFailure("configuration", new Error("Supabase signup configuration is incomplete."));
    return errorResponse(503);
  }

  const admin = createSupabaseAdminClient();
  let reservation: Reservation | null = null;
  let createdUserId: string | null = null;
  let completionSucceeded = false;
  let completionAttempted = false;
  let completionAmbiguous = false;

  try {
    const reserveResult = await admin.rpc("reserve_office_invite_signup", {
      p_invite_secret: parsed.data.inviteToken,
    });

    if (reserveResult.error || !reserveResult.data?.[0]) {
      reportFailure("reservation", reserveResult.error);
      return errorResponse(400);
    }

    reservation = reserveResult.data[0];
    const creation = await createOrReconcileInvitedUser(
      admin,
      reservation,
      parsed.data.password,
    );
    if (creation.status !== "created") {
      return errorResponse(503);
    }

    const reconciledUserId = creation.userId;
    createdUserId = reconciledUserId;
    completionAttempted = true;
    const completion = await completeInviteSignup(
      admin,
      reservation,
      reconciledUserId,
    );

    if (completion === "ambiguous") {
      completionAmbiguous = true;
      return errorResponse(503);
    }
    if (completion === "failed") {
      await compensateCreatedUser(admin, reservation, reconciledUserId);
      return errorResponse(400);
    }

    completionSucceeded = true;
    let signedIn = false;
    try {
      const supabase = await createSupabaseServerClient();
      const signIn = await supabase.auth.signInWithPassword({
        email: reservation.normalized_email,
        password: parsed.data.password,
      });
      signedIn = !signIn.error && Boolean(signIn.data.session);
      if (!signedIn) {
        reportFailure("automatic-sign-in", signIn.error);
      }
    } catch (error) {
      reportFailure("automatic-sign-in", error);
    }

    return NextResponse.json(
      { ok: true, signedIn },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    reportFailure("unexpected", error);
    if (
      createdUserId &&
      reservation &&
      !completionSucceeded &&
      !completionAttempted &&
      !completionAmbiguous
    ) {
      await compensateCreatedUser(admin, reservation, createdUserId);
    }
    return errorResponse(400);
  }
}

async function createOrReconcileInvitedUser(
  admin: AdminClient,
  reservation: Reservation,
  password: string,
): Promise<
  | { status: "created"; userId: string }
  | { status: "ambiguous" }
> {
  try {
    const createResult = await admin.auth.admin.createUser({
      email: reservation.normalized_email,
      password,
      email_confirm: true,
      user_metadata: {
        awardping_invite_id: reservation.invite_id,
        awardping_invite_reservation_id: reservation.reservation_id,
      },
    });
    if (createResult.data.user?.id) {
      if (createResult.error) reportFailure("auth-user-create", createResult.error);
      return { status: "created", userId: createResult.data.user.id };
    }
    reportFailure("auth-user-create", createResult.error);
  } catch (error) {
    reportFailure("auth-user-create", error);
  }

  try {
    const reconciliation = await admin.rpc(
      "reconcile_office_invite_signup_auth_user",
      {
        p_invite_id: reservation.invite_id,
        p_normalized_email: reservation.normalized_email,
        p_reservation_id: reservation.reservation_id,
      },
    );
    if (reconciliation.error) {
      reportFailure("auth-user-reconciliation", reconciliation.error);
      return { status: "ambiguous" };
    }
    const userId = reconciliation.data?.[0]?.user_id;
    return userId
      ? { status: "created", userId }
      : { status: "ambiguous" };
  } catch (error) {
    reportFailure("auth-user-reconciliation", error);
    return { status: "ambiguous" };
  }
}

async function completeInviteSignup(
  admin: AdminClient,
  reservation: Reservation,
  userId: string,
): Promise<"completed" | "failed" | "ambiguous"> {
  const args = {
    p_invite_id: reservation.invite_id,
    p_normalized_email: reservation.normalized_email,
    p_reservation_id: reservation.reservation_id,
    p_user_id: userId,
  };

  let firstAttempt;
  try {
    firstAttempt = await admin.rpc("complete_office_invite_signup", args);
  } catch (error) {
    reportFailure("completion", error);
    firstAttempt = { data: null, error };
  }
  if (!firstAttempt.error) {
    return firstAttempt.data?.[0] ? "completed" : "failed";
  }

  reportFailure("completion", firstAttempt.error);
  let retry;
  try {
    retry = await admin.rpc("complete_office_invite_signup", args);
  } catch (error) {
    reportFailure("completion-reconciliation", error);
    return "ambiguous";
  }
  if (!retry.error) {
    return retry.data?.[0] ? "completed" : "failed";
  }

  reportFailure("completion-reconciliation", retry.error);
  return "ambiguous";
}

async function compensateCreatedUser(
  admin: AdminClient,
  reservation: Reservation,
  userId: string,
) {
  try {
    const deletion = await admin.auth.admin.deleteUser(userId);
    if (deletion.error) {
      reportFailure("auth-user-compensation", deletion.error);
      return false;
    }
  } catch (error) {
    reportFailure("auth-user-compensation", error);
    return false;
  }

  await releaseReservation(admin, reservation);
  return true;
}

async function releaseReservation(admin: AdminClient, reservation: Reservation) {
  try {
    const release = await admin.rpc("release_office_invite_signup_reservation", {
      p_invite_id: reservation.invite_id,
      p_reservation_id: reservation.reservation_id,
    });
    if (release.error) {
      reportFailure("reservation-release", release.error);
      return false;
    }
    return release.data === true;
  } catch (error) {
    reportFailure("reservation-release", error);
    return false;
  }
}

function errorResponse(status: number) {
  return NextResponse.json(
    { ok: false, error: genericError },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function reportFailure(stage: string, error: unknown) {
  const detail =
    error && typeof error === "object"
      ? {
          code: "code" in error ? String(error.code) : undefined,
          message: "message" in error ? String(error.message) : undefined,
        }
      : undefined;
  console.error(`[invite-signup] ${stage} failed`, detail);
}
