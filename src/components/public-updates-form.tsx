"use client";

import { useReducer, useRef } from "react";
import Link from "next/link";
import { Loader2, Mail } from "lucide-react";

export const PUBLIC_UPDATES_SUBSCRIBE_ENDPOINT = "/api/public-updates/subscribe";
const PUBLIC_UPDATES_RETRY_MESSAGE = "Daily updates could not be requested. Try again later.";

export type PublicUpdatesSubmission = {
  email: string;
  privacyConsent: boolean;
  website: string;
};

export type PublicUpdatesOutcome = {
  type: "success" | "error";
  message: string;
};

export type PublicUpdatesFormState = PublicUpdatesSubmission & {
  status: "idle" | "pending" | "success" | "error";
  message: string;
};

export type PublicUpdatesFormAction =
  | { type: "email"; value: string }
  | { type: "privacyConsent"; value: boolean }
  | { type: "website"; value: string }
  | { type: "submit" }
  | { type: "settle"; outcome: PublicUpdatesOutcome };

export const initialPublicUpdatesFormState: PublicUpdatesFormState = {
  email: "",
  privacyConsent: false,
  website: "",
  status: "idle",
  message: "",
};

// The form's lifecycle is one pure transition so it can be proven without a
// browser: one request per submission, a success clears what the visitor
// typed, and any failure keeps it for another try.
export function publicUpdatesFormReducer(
  state: PublicUpdatesFormState,
  action: PublicUpdatesFormAction,
): PublicUpdatesFormState {
  switch (action.type) {
    case "email":
      return { ...state, email: action.value };
    case "privacyConsent":
      return { ...state, privacyConsent: action.value };
    case "website":
      return { ...state, website: action.value };
    case "submit":
      if (state.status === "pending") return state;
      return { ...state, status: "pending", message: "" };
    case "settle":
      if (state.status !== "pending") return state;
      if (action.outcome.type === "success") {
        return {
          ...state,
          email: "",
          privacyConsent: false,
          status: "success",
          message: action.outcome.message,
        };
      }
      return { ...state, status: "error", message: action.outcome.message };
  }
}

// One POST with the unchanged payload. The server answers every well-formed
// address the same way, so its message is shown as is; a failed transport or
// an unreadable reply becomes one generic retry message.
export async function requestPublicUpdates(
  { email, privacyConsent, website }: PublicUpdatesSubmission,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicUpdatesOutcome> {
  try {
    const response = await fetchImpl(PUBLIC_UPDATES_SUBSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, privacyConsent, website }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      return {
        type: "error",
        message: data.error || "Daily updates could not be requested.",
      };
    }
    return {
      type: "success",
      message: data.message || "Check your email to confirm daily updates.",
    };
  } catch {
    return { type: "error", message: PUBLIC_UPDATES_RETRY_MESSAGE };
  }
}

export type PublicUpdatesSubmitEvent = { preventDefault: () => void };

// The exact logic the form binds to onSubmit. The in-flight latch is
// synchronous: two submit events in one tick both see the same rendered
// state, so the ref, not that state, decides whether a request starts. It
// is released once the request settles, whatever the outcome.
export function createPublicUpdatesSubmitHandler({
  inFlight,
  submission,
  dispatch,
  request = requestPublicUpdates,
}: {
  inFlight: { current: boolean };
  submission: PublicUpdatesSubmission;
  dispatch: (action: PublicUpdatesFormAction) => void;
  request?: (submission: PublicUpdatesSubmission) => Promise<PublicUpdatesOutcome>;
}) {
  return async function submit(event: PublicUpdatesSubmitEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      dispatch({ type: "submit" });
      const outcome = await request(submission).catch(
        (): PublicUpdatesOutcome => ({ type: "error", message: PUBLIC_UPDATES_RETRY_MESSAGE }),
      );
      dispatch({ type: "settle", outcome });
    } finally {
      inFlight.current = false;
    }
  };
}

export function PublicUpdatesForm() {
  const [form, dispatch] = useReducer(publicUpdatesFormReducer, initialPublicUpdatesFormState);
  const inFlight = useRef(false);
  const pending = form.status === "pending";
  // Bound at event time, so the latch ref is only touched outside render.
  function submit(event: PublicUpdatesSubmitEvent) {
    return createPublicUpdatesSubmitHandler({ inFlight, submission: form, dispatch })(event);
  }

  return (
    <form className="card rounded-3xl p-5 sm:p-6" onSubmit={submit} aria-busy={pending}>
      <div>
        <label className="text-sm font-bold" htmlFor="public-updates-email">
          Email address
        </label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <input
            id="public-updates-email"
            className="input"
            type="email"
            placeholder="advisor@example.edu"
            value={form.email}
            onChange={(event) => dispatch({ type: "email", value: event.target.value })}
            required
          />
          <button className="button-primary sm:w-44" type="submit" disabled={pending}>
            {pending ? (
              <Loader2 className="animate-spin" size={17} aria-hidden="true" />
            ) : (
              <Mail size={17} aria-hidden="true" />
            )}
            {pending ? "Subscribing…" : "Subscribe"}
          </button>
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm font-semibold leading-6 text-[var(--muted)]">
        <input
          className="mt-1 accent-[var(--brand)]"
          type="checkbox"
          checked={form.privacyConsent}
          onChange={(event) => dispatch({ type: "privacyConsent", value: event.target.checked })}
          required
        />
        <span>
          I agree to receive AwardPing public update emails and understand my
          data is handled under the{" "}
          <Link className="font-bold text-[var(--brand)] underline" href="/privacy">
            privacy policy
          </Link>
          .
        </span>
      </label>

      <div className="hidden" aria-hidden="true">
        <label htmlFor="public-updates-website">Website</label>
        <input
          id="public-updates-website"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={(event) => dispatch({ type: "website", value: event.target.value })}
        />
      </div>

      {/* Always in the DOM, so a result is announced in place without moving
          focus; it takes no space while it is empty. */}
      <p role="status" aria-live="polite" aria-atomic="true" className={statusClassName(form)}>
        {form.message}
      </p>
    </form>
  );
}

function statusClassName(form: PublicUpdatesFormState) {
  return [
    form.message ? "mt-4" : "",
    "text-sm font-semibold",
    form.status === "error" ? "text-[var(--foreground)]" : "text-[var(--brand-dark)]",
  ]
    .filter(Boolean)
    .join(" ");
}
