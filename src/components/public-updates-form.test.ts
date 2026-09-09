import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// A static render cannot type or submit. The component's reducer state is
// preset for one render, and the handler the form binds to onSubmit is
// invoked directly with a recording dispatch that applies the same reducer.
const preset = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useReducer = ((reducer: unknown, initial: unknown) =>
    (actual.useReducer as unknown as (reducer: unknown, initial: unknown) => unknown)(
      reducer,
      preset.state ?? initial,
    )) as typeof actual.useReducer;
  return { ...actual, useReducer };
});

import {
  PUBLIC_UPDATES_SUBSCRIBE_ENDPOINT,
  PublicUpdatesForm,
  createPublicUpdatesSubmitHandler,
  initialPublicUpdatesFormState,
  publicUpdatesFormReducer,
  requestPublicUpdates,
  type PublicUpdatesFormAction,
  type PublicUpdatesFormState,
  type PublicUpdatesSubmission,
} from "@/components/public-updates-form";

const RETRY_MESSAGE = "Daily updates could not be requested. Try again later.";

const typed: PublicUpdatesFormState = {
  ...initialPublicUpdatesFormState,
  email: "advisor@example.edu",
  privacyConsent: true,
};

function render(state?: Partial<PublicUpdatesFormState>) {
  preset.state = state ? { ...initialPublicUpdatesFormState, ...state } : null;
  try {
    return renderToStaticMarkup(createElement(PublicUpdatesForm));
  } finally {
    preset.state = null;
  }
}

const STATUS_REGION_OPEN = '<p role="status" aria-live="polite" aria-atomic="true"';

function statusRegion(html: string) {
  const matches = [
    ...html.matchAll(/<p role="status" aria-live="polite" aria-atomic="true" class="([^"]*)">([^<]*)<\/p>/g),
  ];
  expect(matches).toHaveLength(1);
  return { className: matches[0][1], text: matches[0][2] };
}

function submitButton(html: string) {
  const match = html.match(/<button class="button-primary sm:w-44" type="submit"( disabled="")?>([\s\S]*?)<\/button>/);
  if (!match) throw new Error("submit button missing");
  return { disabled: match[1] === ' disabled=""', inner: match[2] };
}

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(respond: () => Promise<unknown>) {
  const calls: FetchCall[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// Each request stays open until the test settles it, oldest first.
function deferredFetch() {
  const calls: FetchCall[] = [];
  const waiting: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise<unknown>((resolve, reject) => waiting.push({ resolve, reject }));
  }) as unknown as typeof fetch;
  function next() {
    const entry = waiting.shift();
    if (!entry) throw new Error("no request is waiting");
    return entry;
  }
  return {
    impl,
    calls,
    resolveNext: (response: Response) => next().resolve(response),
    rejectNext: (error: unknown) => next().reject(error),
  };
}

function jsonResponse(ok: boolean, payload: unknown) {
  return { ok, json: async () => payload } as unknown as Response;
}

function fakeEvent() {
  const event = {
    prevented: 0,
    preventDefault: () => {
      event.prevented += 1;
    },
  };
  return event;
}

// The handler exactly as the component binds it: one shared in-flight ref, the
// current form as the submission, and a dispatch that applies the reducer.
function bindHandler(
  fetchImpl: typeof fetch,
  options: { request?: (submission: PublicUpdatesSubmission) => Promise<never> } = {},
) {
  const inFlight = { current: false };
  let state = typed;
  const dispatched: PublicUpdatesFormAction[] = [];
  const dispatch = (action: PublicUpdatesFormAction) => {
    dispatched.push(action);
    state = publicUpdatesFormReducer(state, action);
  };
  const bind = () =>
    createPublicUpdatesSubmitHandler({
      inFlight,
      submission: state,
      dispatch,
      request: options.request ?? ((submission) => requestPublicUpdates(submission, fetchImpl)),
    });
  // dispatchAction stands in for a visitor's own onChange while the handler
  // runs, so a mid-flight edit goes through the very same reducer.
  return { inFlight, dispatched, bind, dispatchAction: dispatch, submit: bind(), state: () => state };
}

const EMAIL_INPUT_OPEN = '<input id="public-updates-email" class="input" type="email" placeholder="advisor@example.edu" required=""';

// Attribute-order-independent readings of the two visitor-editable controls.
function emailInput(html: string) {
  const markup = html.match(/<input id="public-updates-email"[^>]*\/>/)?.[0];
  if (!markup) throw new Error("email input missing");
  return { markup, disabled: markup.includes(' disabled=""'), value: markup.match(/value="([^"]*)"/)?.[1] ?? "" };
}

function consentInput(html: string) {
  const markup = html.match(/<input class="mt-1 accent-\[var\(--brand\)\]"[^>]*\/>/)?.[0];
  if (!markup) throw new Error("consent checkbox missing");
  return { markup, disabled: markup.includes(' disabled=""'), checked: markup.includes(' checked=""') };
}

function honeypotInput(html: string) {
  const markup = html.match(/<input id="public-updates-website"[^>]*\/>/)?.[0];
  if (!markup) throw new Error("honeypot input missing");
  return { markup, disabled: markup.includes(' disabled=""'), value: markup.match(/value="([^"]*)"/)?.[1] ?? "" };
}

afterEach(() => {
  preset.state = null;
});

describe("PublicUpdatesForm markup", () => {
  it("renders the idle form with an empty, always-present status region", () => {
    const html = render();

    expect(html.startsWith('<form class="card rounded-3xl p-5 sm:p-6" aria-busy="false">')).toBe(true);
    const button = submitButton(html);
    expect(button.disabled).toBe(false);
    expect(button.inner).toContain("lucide-mail");
    expect(button.inner.endsWith("Subscribe")).toBe(true);
    expect(html).not.toContain("Subscribing");
    const region = statusRegion(html);
    expect(region.text).toBe("");
    expect(region.className).toBe("text-sm font-semibold text-[var(--brand-dark)]");
    // Required fields, the privacy link and the anti-bot field are unchanged.
    expect(html).toContain(`${EMAIL_INPUT_OPEN} value=""/>`);
    expect(html).toContain('<input class="mt-1 accent-[var(--brand)]" type="checkbox" required=""/>');
    expect(html).toContain('<a class="font-bold text-[var(--brand)] underline" href="/privacy">privacy policy</a>');
    expect(html).toContain(
      '<div class="hidden" aria-hidden="true"><label for="public-updates-website">Website</label><input id="public-updates-website" tabindex="-1" autoComplete="off" value=""/></div>',
    );
    expect(html).not.toContain("autofocus");
  });

  it("shows the pending state: disabled button, visible label, busy form, values kept", () => {
    const html = render({ ...typed, status: "pending" });

    expect(html.startsWith('<form class="card rounded-3xl p-5 sm:p-6" aria-busy="true">')).toBe(true);
    const button = submitButton(html);
    expect(button.disabled).toBe(true);
    expect(button.inner).toContain("animate-spin");
    expect(button.inner.endsWith("Subscribing…")).toBe(true);
    expect(statusRegion(html).text).toBe("");
    // Both editable fields are locked for the request's lifetime, and what the
    // visitor can see is exactly what was submitted.
    expect(emailInput(html)).toMatchObject({ disabled: true, value: "advisor@example.edu" });
    expect(consentInput(html)).toMatchObject({ disabled: true, checked: true });
    // The privacy policy link is never disabled, so the terms stay readable.
    expect(html).toContain('<a class="font-bold text-[var(--brand)] underline" href="/privacy">privacy policy</a>');
  });

  it("announces success in the same region beside cleared inputs", () => {
    const html = render({ status: "success", message: "Check your email to confirm daily updates." });

    expect(html).toContain('aria-busy="false"');
    expect(submitButton(html).disabled).toBe(false);
    const region = statusRegion(html);
    expect(region.text).toBe("Check your email to confirm daily updates.");
    expect(region.className).toBe("mt-4 text-sm font-semibold text-[var(--brand-dark)]");
    expect(html).toContain(`${EMAIL_INPUT_OPEN} value=""/>`);
    expect(html).not.toContain('checked=""');
  });

  it("announces a failure in the same region and keeps what was typed", () => {
    const html = render({ ...typed, status: "error", message: RETRY_MESSAGE });

    const region = statusRegion(html);
    expect(region.text).toBe(RETRY_MESSAGE);
    expect(region.className).toBe("mt-4 text-sm font-semibold text-[var(--foreground)]");
    expect(submitButton(html).disabled).toBe(false);
    expect(html).toContain(`${EMAIL_INPUT_OPEN} value="advisor@example.edu"/>`);
    expect(html).toContain('checked=""');
  });

  it("keeps exactly one status region in the same place in every state", () => {
    const states: Array<Partial<PublicUpdatesFormState>> = [
      {},
      { ...typed, status: "pending" },
      { status: "success", message: "Request received." },
      { ...typed, status: "error", message: "Daily updates could not be requested." },
    ];

    for (const state of states) {
      const html = render(state);
      expect(html.split(STATUS_REGION_OPEN), state.status).toHaveLength(2);
      expect(html.indexOf('id="public-updates-website"')).toBeLessThan(html.indexOf(STATUS_REGION_OPEN));
      expect(html.endsWith("</p></form>"), state.status).toBe(true);
      expect(html.split('role="status"'), state.status).toHaveLength(2);
    }
  });
});

describe("publicUpdatesFormReducer", () => {
  it("records edits to every field", () => {
    let state = initialPublicUpdatesFormState;
    state = publicUpdatesFormReducer(state, { type: "email", value: "advisor@example.edu" });
    state = publicUpdatesFormReducer(state, { type: "privacyConsent", value: true });
    state = publicUpdatesFormReducer(state, { type: "website", value: "https://spam.example" });

    expect(state).toEqual({ ...typed, website: "https://spam.example" });
  });

  it("starts one submission, clears the previous message, and ignores a repeat while pending", () => {
    const errored: PublicUpdatesFormState = { ...typed, status: "error", message: "Daily updates could not be requested." };

    const pending = publicUpdatesFormReducer(errored, { type: "submit" });
    expect(pending).toEqual({ ...typed, status: "pending", message: "" });
    expect(publicUpdatesFormReducer(pending, { type: "submit" })).toBe(pending);
  });

  it("clears the address and consent on success and keeps the anti-bot field", () => {
    const pending: PublicUpdatesFormState = { ...typed, website: "kept", status: "pending" };

    const settled = publicUpdatesFormReducer(pending, {
      type: "settle",
      outcome: { type: "success", message: "Check your email to confirm daily updates." },
    });

    expect(settled).toEqual({
      email: "",
      privacyConsent: false,
      website: "kept",
      status: "success",
      message: "Check your email to confirm daily updates.",
    });
  });

  it("keeps every entered value on failure", () => {
    const pending: PublicUpdatesFormState = { ...typed, status: "pending" };

    const settled = publicUpdatesFormReducer(pending, {
      type: "settle",
      outcome: { type: "error", message: RETRY_MESSAGE },
    });

    expect(settled).toEqual({ ...typed, status: "error", message: RETRY_MESSAGE });
  });

  it("ignores a settle that belongs to no pending submission", () => {
    expect(
      publicUpdatesFormReducer(typed, { type: "settle", outcome: { type: "success", message: "late" } }),
    ).toBe(typed);
  });
});

describe("requestPublicUpdates", () => {
  const pendingForm: PublicUpdatesFormState = { ...typed, status: "pending" };

  it("sends exactly one POST with the unchanged payload and shows the server's message", async () => {
    const fetch = fakeFetch(async () => jsonResponse(true, { ok: true, message: "Request received." }));

    const outcome = await requestPublicUpdates(pendingForm, fetch.impl);

    expect(outcome).toEqual({ type: "success", message: "Request received." });
    expect(fetch.calls).toHaveLength(1);
    expect(PUBLIC_UPDATES_SUBSCRIBE_ENDPOINT).toBe("/api/public-updates/subscribe");
    expect(fetch.calls[0].url).toBe("/api/public-updates/subscribe");
    expect(fetch.calls[0].init.method).toBe("POST");
    expect(fetch.calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(fetch.calls[0].init.body).toBe('{"email":"advisor@example.edu","privacyConsent":true,"website":""}');
  });

  it("falls back to the generic confirmation copy when the server sends none", async () => {
    const fetch = fakeFetch(async () => jsonResponse(true, { ok: true }));

    expect(await requestPublicUpdates(pendingForm, fetch.impl)).toEqual({
      type: "success",
      message: "Check your email to confirm daily updates.",
    });
  });

  it("posts the anti-bot field's value as entered and lets the server decide", async () => {
    const fetch = fakeFetch(async () => jsonResponse(true, { ok: true }));

    const outcome = await requestPublicUpdates({ ...pendingForm, website: "https://spam.example" }, fetch.impl);

    expect(outcome.type).toBe("success");
    expect(fetch.calls).toHaveLength(1);
    expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({
      email: "advisor@example.edu",
      privacyConsent: true,
      website: "https://spam.example",
    });
  });

  it("reports an API failure with the server's error or the generic copy", async () => {
    const rejected = fakeFetch(async () =>
      jsonResponse(false, { ok: false, error: "Enter a valid email address and accept the privacy terms." }),
    );
    expect(await requestPublicUpdates(pendingForm, rejected.impl)).toEqual({
      type: "error",
      message: "Enter a valid email address and accept the privacy terms.",
    });

    const silent = fakeFetch(async () => jsonResponse(true, { ok: false }));
    expect(await requestPublicUpdates(pendingForm, silent.impl)).toEqual({
      type: "error",
      message: "Daily updates could not be requested.",
    });
    expect(rejected.calls).toHaveLength(1);
    expect(silent.calls).toHaveLength(1);
  });

  it("turns a network failure or an unreadable reply into one retry message and never throws", async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await requestPublicUpdates(pendingForm, offline.impl)).toEqual({ type: "error", message: RETRY_MESSAGE });

    const unreadable = fakeFetch(async () => ({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    expect(await requestPublicUpdates(pendingForm, unreadable.impl)).toEqual({ type: "error", message: RETRY_MESSAGE });
  });
});

describe("the submit handler the form binds", () => {
  it("prevents default on two synchronous submits, sends one request, then allows a retry", async () => {
    const fetch = deferredFetch();
    const bound = bindHandler(fetch.impl);
    const first = fakeEvent();
    const second = fakeEvent();

    const firstRun = bound.submit(first);
    const secondRun = bound.submit(second);

    // Both events are handled; only the first starts a request.
    expect(first.prevented).toBe(1);
    expect(second.prevented).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(bound.inFlight.current).toBe(true);
    expect(bound.dispatched).toEqual([{ type: "submit" }]);
    await secondRun;
    expect(fetch.calls).toHaveLength(1);
    const pendingHtml = render(bound.state());
    expect(submitButton(pendingHtml).disabled).toBe(true);
    expect(pendingHtml).toContain("Subscribing…");
    expect(statusRegion(pendingHtml).text).toBe("");

    // The first request fails on the network: values stay, latch releases.
    fetch.rejectNext(new TypeError("Failed to fetch"));
    await firstRun;
    expect(bound.inFlight.current).toBe(false);
    expect(bound.state()).toEqual({ ...typed, status: "error", message: RETRY_MESSAGE });
    const failedHtml = render(bound.state());
    expect(statusRegion(failedHtml).text).toBe(RETRY_MESSAGE);
    expect(failedHtml).toContain(`${EMAIL_INPUT_OPEN} value="advisor@example.edu"/>`);

    // A later retry is allowed and makes exactly one more request.
    const retry = fakeEvent();
    const retryRun = bound.submit(retry);
    expect(retry.prevented).toBe(1);
    expect(fetch.calls).toHaveLength(2);
    expect(JSON.parse(String(fetch.calls[1].init.body))).toEqual({
      email: "advisor@example.edu",
      privacyConsent: true,
      website: "",
    });
    fetch.resolveNext(jsonResponse(true, { ok: true, message: "Request received." }));
    await retryRun;
    expect(bound.inFlight.current).toBe(false);
    expect(bound.state()).toEqual({ ...initialPublicUpdatesFormState, status: "success", message: "Request received." });
    expect(bound.dispatched).toHaveLength(4);
    const successHtml = render(bound.state());
    expect(statusRegion(successHtml).text).toBe("Request received.");
    expect(successHtml).toContain(`${EMAIL_INPUT_OPEN} value=""/>`);
    expect(submitButton(successHtml).disabled).toBe(false);
  });

  it("keeps the latch across re-renders: a handler bound later sees the same in-flight request", async () => {
    const fetch = deferredFetch();
    const bound = bindHandler(fetch.impl);

    const firstRun = bound.submit(fakeEvent());
    // A re-render binds a new handler around the same ref and dispatch.
    const rebound = bound.bind();
    const laterEvent = fakeEvent();
    await rebound(laterEvent);

    expect(laterEvent.prevented).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(bound.dispatched).toEqual([{ type: "submit" }]);

    fetch.resolveNext(jsonResponse(true, { ok: true }));
    await firstRun;
    expect(bound.inFlight.current).toBe(false);

    // Once settled, the later-bound handler starts its own single request.
    const retryRun = rebound(fakeEvent());
    expect(fetch.calls).toHaveLength(2);
    expect(bound.inFlight.current).toBe(true);
    fetch.resolveNext(jsonResponse(true, { ok: true }));
    await retryRun;
    expect(bound.inFlight.current).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  it("releases the latch and settles with the retry message if the request itself rejects", async () => {
    let requests = 0;
    const bound = bindHandler(fakeFetch(async () => jsonResponse(true, { ok: true })).impl, {
      request: () => {
        requests += 1;
        return Promise.reject(new Error("unexpected"));
      },
    });

    await bound.submit(fakeEvent());

    expect(requests).toBe(1);
    expect(bound.inFlight.current).toBe(false);
    expect(bound.state()).toEqual({ ...typed, status: "error", message: RETRY_MESSAGE });

    await bound.submit(fakeEvent());
    expect(requests).toBe(2);
  });

  // A visitor who keeps typing after pressing Subscribe used to change the
  // fields under an in-flight request: the POST carried the old address, the
  // form showed the new one, and a success then cleared the new one as though
  // it had been submitted.
  it("ignores an address typed while the request is in flight, and never sends it", async () => {
    const fetch = deferredFetch();
    const bound = bindHandler(fetch.impl);

    const run = bound.submit(fakeEvent());
    expect(fetch.calls).toHaveLength(1);
    expect(JSON.parse(String(fetch.calls[0].init.body)).email).toBe("advisor@example.edu");

    // The visitor keeps typing, and toggles consent, while the request is open.
    bound.dispatchAction({ type: "email", value: "someone-else@example.edu" });
    bound.dispatchAction({ type: "privacyConsent", value: false });
    bound.dispatchAction({ type: "website", value: "https://spam.example" });

    // None of it lands: the form still shows exactly what was submitted.
    expect(bound.state()).toMatchObject({
      email: "advisor@example.edu",
      privacyConsent: true,
      website: "",
      status: "pending",
    });
    const pendingHtml = render(bound.state());
    expect(emailInput(pendingHtml)).toMatchObject({ disabled: true, value: "advisor@example.edu" });
    expect(consentInput(pendingHtml)).toMatchObject({ disabled: true, checked: true });
    expect(pendingHtml).not.toContain("someone-else@example.edu");

    fetch.resolveNext(jsonResponse(true, { ok: true, message: "Request received." }));
    await run;

    // Exactly one request, carrying only the submitted address.
    expect(fetch.calls).toHaveLength(1);
    expect(String(fetch.calls[0].init.body)).not.toContain("someone-else@example.edu");
    // Success clears the submitted values, not an address that was never sent.
    expect(bound.state()).toEqual({ ...initialPublicUpdatesFormState, status: "success", message: "Request received." });
    const settled = render(bound.state());
    expect(emailInput(settled)).toMatchObject({ disabled: false, value: "" });
    expect(consentInput(settled)).toMatchObject({ disabled: false, checked: false });
  });

  it("re-enables the fields and keeps the submitted values when the request fails", async () => {
    const fetch = deferredFetch();
    const bound = bindHandler(fetch.impl);

    const run = bound.submit(fakeEvent());
    bound.dispatchAction({ type: "email", value: "someone-else@example.edu" });
    fetch.rejectNext(new TypeError("Failed to fetch"));
    await run;

    expect(bound.state()).toEqual({ ...typed, status: "error", message: RETRY_MESSAGE });
    const html = render(bound.state());
    expect(emailInput(html)).toMatchObject({ disabled: false, value: "advisor@example.edu" });
    expect(consentInput(html)).toMatchObject({ disabled: false, checked: true });
    expect(html).not.toContain("someone-else@example.edu");
  });

  it("accepts edits again once the request has settled, and on a fresh form", () => {
    for (const state of [
      initialPublicUpdatesFormState,
      { ...typed, status: "error" as const, message: RETRY_MESSAGE },
      { ...initialPublicUpdatesFormState, status: "success" as const, message: "Request received." },
    ]) {
      const next = publicUpdatesFormReducer(state, { type: "email", value: "new@example.edu" });
      expect(next.email, state.status).toBe("new@example.edu");
      expect(publicUpdatesFormReducer(state, { type: "privacyConsent", value: true }).privacyConsent, state.status).toBe(true);
      expect(publicUpdatesFormReducer(state, { type: "website", value: "bot" }).website, state.status).toBe("bot");

      const html = render(state);
      expect(emailInput(html).disabled, state.status).toBe(false);
      expect(consentInput(html).disabled, state.status).toBe(false);
    }
  });

  it("leaves the hidden anti-bot field enabled but frozen while pending, and still sends it", async () => {
    // The field is unreachable to a visitor (hidden, aria-hidden, not tabbable),
    // so nothing about it needs disabling; marking it disabled would only hand
    // an automated filler a signal. The reducer freeze is what keeps the value
    // it is asked to send identical to the value captured at submit.
    const idle = render();
    expect(honeypotInput(idle).disabled).toBe(false);
    expect(honeypotInput(render({ ...typed, status: "pending" })).disabled).toBe(false);

    const fetch = deferredFetch();
    const bound = bindHandler(fetch.impl);
    bound.dispatchAction({ type: "website", value: "https://spam.example" });
    // Re-bound after that edit, exactly as a re-render rebinds onSubmit.
    const run = bound.bind()(fakeEvent());

    expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({
      email: "advisor@example.edu",
      privacyConsent: true,
      website: "https://spam.example",
    });
    bound.dispatchAction({ type: "website", value: "changed-mid-flight" });
    expect(bound.state().website).toBe("https://spam.example");

    fetch.resolveNext(jsonResponse(true, { ok: true }));
    await run;
    // A success clears only the submitted address and consent, as before.
    expect(bound.state().website).toBe("https://spam.example");
  });

  it("is exactly what the component binds to onSubmit", () => {
    const source = readFileSync(new URL("./public-updates-form.tsx", import.meta.url), "utf8");

    expect(source).toContain("const inFlight = useRef(false);");
    expect(source).toContain(
      "return createPublicUpdatesSubmitHandler({ inFlight, submission: form, dispatch })(event);",
    );
    expect(source.match(/createPublicUpdatesSubmitHandler\(/g)).toHaveLength(2);
    expect(source.match(/onSubmit=/g)).toHaveLength(1);
    expect(source).toContain("onSubmit={submit}");
    expect(source.match(/fetchImpl\(/g)).toHaveLength(1);
    expect(source.match(/\/api\/public-updates\/subscribe/g)).toHaveLength(1);
  });
});
