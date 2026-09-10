import { load } from "cheerio";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as null | { id: string },
  configured: true,
}));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: () => state.configured,
  hasSupabaseAdminConfig: () => false,
}));
vi.mock("@/lib/onboarding", () => ({
  getOnboardingStatus: async () => "ready",
  onboardingRedirectPath: () => "/dashboard",
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));
vi.mock("@/components/auth-form", () => ({
  AuthForm: ({ mode, nextPath }: { mode: string; nextPath: string }) =>
    createElement("div", { "data-form": mode, "data-next": nextPath }),
}));
vi.mock("@/components/password-recovery-request-form", () => ({
  PasswordRecoveryRequestForm: () => createElement("div", { "data-form": "recovery" }),
}));
vi.mock("@/components/password-update-form", () => ({
  PasswordUpdateForm: ({ nextPath }: { nextPath: string }) =>
    createElement("div", { "data-form": "password", "data-next": nextPath }),
}));
vi.mock("@/components/accept-invite-button", () => ({
  AcceptInviteButton: ({ token }: { token: string }) =>
    createElement("button", { "data-invite": token }, "Accept invitation"),
}));
vi.mock("@/components/setup-notice", () => ({
  SetupNotice: () => createElement("p", { "data-setup": true }, "Setup required"),
}));

import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage from "@/app/reset-password/page";
import JoinOfficePage from "@/app/join/[token]/page";

beforeEach(() => {
  state.user = null;
  state.configured = true;
});

describe("compact account entry pages", () => {
  it("keeps login focused without losing next-path handling or account links", async () => {
    const $ = load(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "/dashboard/privacy" }) })));
    expect($("main.public-page-main.public-page-main-narrow")).toHaveLength(1);
    expect($(".public-page-heading > h1").text()).toBe("Log in");
    expect($('[data-form="login"]').attr("data-next")).toBe("/dashboard/privacy");
    expect($('a[href="/forgot-password"]')).toHaveLength(1);
    expect($('a[href="/contact"]')).toHaveLength(1);
    expect($("main").text()).toContain("New accounts require a secure office invitation.");
  });

  it.each([
    [{ account: "created" }, "Your invited account was created. Log in to continue."],
    [{ recovery: "invalid" }, "That password-reset link is invalid or expired. Request a new link below."],
    [{ confirmation: "invalid" }, "That confirmation link is invalid or expired. Request a new invitation from your office administrator."],
  ] as const)("preserves the login status for %j", async (query, message) => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(query) }));
    expect(load(html)("main").text()).toContain(message);
  });

  it("does not pass an external redirect into the login form", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "https://example.com" }) }));
    expect(load(html)('[data-form="login"]').attr("data-next")).toBe("");
  });

  it("retains the invitation-only signup boundary and existing login link", async () => {
    const $ = load(renderToStaticMarkup(await SignupPage()));
    expect($(".public-page-heading > h1").text()).toBe("Invitation required");
    expect($("main").text()).toContain("New accounts can only be created from a valid office invitation.");
    expect($("main form, [data-form]")).toHaveLength(0);
    expect($('a[href="/login"]')).toHaveLength(1);
  });

  it("keeps password recovery wording non-enumerating and the original form available", () => {
    const $ = load(renderToStaticMarkup(ForgotPasswordPage()));
    expect($(".public-page-heading > h1").text()).toBe("Reset your password");
    expect($("main").text()).toContain("We will send a one-time link if that account exists.");
    expect($('[data-form="recovery"]')).toHaveLength(1);
    expect($('a[href="/login"]')).toHaveLength(1);
  });

  it("keeps setup notices instead of rendering unusable account forms", async () => {
    state.configured = false;
    const login = load(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) })));
    const recovery = load(renderToStaticMarkup(ForgotPasswordPage()));
    for (const $ of [login, recovery]) {
      expect($("[data-setup]")).toHaveLength(1);
      expect($("[data-form]")).toHaveLength(0);
    }
  });

  it("preserves signed-in onboarding redirects and the signed-out recovery guard", async () => {
    await expect(ResetPasswordPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/login?recovery=invalid");
    state.user = { id: "fixture-user" };
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/dashboard");
    await expect(SignupPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("preserves the verified recovery form and its safe next path", async () => {
    state.user = { id: "fixture-user" };
    const $ = load(renderToStaticMarkup(await ResetPasswordPage({ searchParams: Promise.resolve({ next: "/dashboard/profile" }) })));
    expect($(".public-page-heading > h1").text()).toBe("Choose a new password");
    expect($('[data-form="password"]').attr("data-next")).toBe("/dashboard/profile");
    expect($("main").text()).toContain("Your one-time recovery link was verified.");
  });

  it("preserves the office invitation acceptance action without moving its token", async () => {
    state.user = { id: "fixture-user" };
    const $ = load(renderToStaticMarkup(await JoinOfficePage({ params: Promise.resolve({ token: "fixture-invitation" }) })));
    expect($(".public-page-heading > h1").text()).toBe("Join an AwardPing office");
    expect($("[data-invite]").attr("data-invite")).toBe("fixture-invitation");
    expect($("[data-form]")).toHaveLength(0);
  });
});
