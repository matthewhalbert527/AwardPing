"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { normalizeOrganizationName } from "@/lib/organizations";
import { bestExistingOrganizationMatch } from "@/lib/organization-matching";

type Props = {
  mode: "login" | "signup";
  nextPath?: string;
};

type OrganizationOption = {
  id: string;
  name: string;
  country: string | null;
  country_code: string | null;
  state_province: string | null;
};

type OfficeOption = {
  id: string;
  name: string;
  officeName?: string;
  organizationId?: string | null;
  organizationName?: string | null;
};

export function AuthForm({ mode, nextPath = "" }: Props) {
  const router = useRouter();
  const fallbackPath = mode === "signup" ? "/dashboard/onboarding" : "/dashboard";
  const safeNext = safeNextPath(nextPath) || fallbackPath;
  const [fullName, setFullName] = useState("");
  const [organizationQuery, setOrganizationQuery] = useState("");
  const [organizationOptions, setOrganizationOptions] = useState<OrganizationOption[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [organizationSearchOpen, setOrganizationSearchOpen] = useState(false);
  const [organizationSearching, setOrganizationSearching] = useState(false);
  const [forceCreateOrganization, setForceCreateOrganization] = useState(false);
  const [officeName, setOfficeName] = useState("");
  const [officeMode, setOfficeMode] = useState<"new" | "existing">("new");
  const [officeQuery, setOfficeQuery] = useState("");
  const [officeOptions, setOfficeOptions] = useState<OfficeOption[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedOffice = useMemo(
    () => officeOptions.find((office) => office.id === selectedOfficeId) || null,
    [officeOptions, selectedOfficeId],
  );
  const selectedOrganization = useMemo(
    () =>
      organizationOptions.find((organization) => organization.id === selectedOrganizationId) ||
      null,
    [organizationOptions, selectedOrganizationId],
  );
  const normalizedTypedOrganization = normalizeOrganizationName(organizationQuery);
  const matchedOrganization =
    selectedOrganization ||
    (!forceCreateOrganization
      ? bestExistingOrganizationMatch(organizationQuery, organizationOptions)
      : null);
  const organizationName =
    selectedOffice?.organizationName ||
    matchedOrganization?.name ||
    normalizedTypedOrganization;

  const effectiveOrganizationId =
    selectedOffice?.organizationId ||
    selectedOrganizationId ||
    matchedOrganization?.id ||
    "";

  useEffect(() => {
    if (mode !== "signup") return;

    const query = organizationQuery.trim();
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      if (!query) {
        setOrganizationOptions([]);
        setOrganizationSearching(false);
        return;
      }

      setOrganizationSearching(true);
      const response = await fetch(
        `/api/organizations/search?query=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      ).catch(() => null);
      if (controller.signal.aborted) return;

      if (!response?.ok) {
        setOrganizationSearching(false);
        return;
      }

      const data = await response.json();
      if (controller.signal.aborted) return;
      setOrganizationOptions(data.organizations || []);
      setOrganizationSearching(false);
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [mode, organizationQuery]);

  function selectOrganization(organization: OrganizationOption) {
    setSelectedOrganizationId(organization.id);
    setOrganizationQuery(organization.name);
    setSelectedOfficeId("");
    setOrganizationSearching(false);
    setForceCreateOrganization(false);
    setOrganizationSearchOpen(false);
  }

  useEffect(() => {
    if (mode !== "signup" || officeMode !== "existing") return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      const params = new URLSearchParams();
      if (officeQuery.trim()) params.set("query", officeQuery.trim());
      if (effectiveOrganizationId) params.set("organizationId", effectiveOrganizationId);
      const response = await fetch(
        `/api/offices/search?${params.toString()}`,
        { signal: controller.signal },
      ).catch(() => null);
      if (!response?.ok) return;

      const data = await response.json();
      setOfficeOptions(data.offices || []);
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [mode, officeMode, officeQuery, effectiveOrganizationId]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "signup" && officeMode === "new" && !organizationName) {
      setMessage("Enter or select an organization.");
      return;
    }

    setLoading(true);
    setMessage("");
    const supabase = createSupabaseBrowserClient();

    const result =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                full_name: fullName,
                organization: organizationName,
                organization_id: effectiveOrganizationId || undefined,
                office_name: officeMode === "new" ? officeName : undefined,
                existing_office_id:
                  officeMode === "existing" && selectedOfficeId ? selectedOfficeId : undefined,
              },
              emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(safeNext)}`,
            },
          });

    setLoading(false);

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Check your email to confirm your account.");
      return;
    }

    router.push(safeNext);
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {mode === "signup" && (
        <>
          <div>
            <label className="text-sm font-bold" htmlFor="full-name">
              Name
            </label>
            <input
              id="full-name"
              className="input mt-1"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
            />
          </div>
          <div>
            <label className="text-sm font-bold" htmlFor="organization">
              Organization
            </label>
            <div
              className="relative mt-1"
              onBlur={(event) => {
                if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
                  setOrganizationSearchOpen(false);
                }
              }}
            >
              <input
                id="organization"
                className="input"
                type="text"
                value={organizationQuery}
                onFocus={() => setOrganizationSearchOpen(true)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setOrganizationQuery(nextValue);
                  setOrganizationOptions([]);
                  setSelectedOrganizationId("");
                  setSelectedOfficeId("");
                  setForceCreateOrganization(false);
                  setOrganizationSearching(Boolean(nextValue.trim()));
                  setOrganizationSearchOpen(true);
                }}
                placeholder="University of Arkansas, Fayetteville"
                role="combobox"
                aria-expanded={organizationSearchOpen}
                aria-controls="organization-results"
                aria-autocomplete="list"
                required
              />
              {matchedOrganization && !selectedOrganizationId && !forceCreateOrganization && (
                <p className="mt-2 text-xs font-bold text-[var(--brand)]">
                  Will use existing organization: {matchedOrganization.name}
                </p>
              )}
              {organizationSearchOpen && (
                <div
                  id="organization-results"
                  className="absolute left-0 right-0 top-full z-40 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-[var(--line)] bg-white p-2 shadow-[0_24px_70px_rgba(22,34,74,0.16)]"
                  role="listbox"
                  aria-label="Matching organizations"
                  tabIndex={-1}
                >
                  {organizationSearching && (
                    <p className="rounded-xl border border-dashed border-[var(--line)] p-3 text-sm font-semibold text-[var(--muted)]">
                      Searching existing organizations...
                    </p>
                  )}
                  {organizationOptions.map((organization) => (
                    <button
                      className={`flex w-full flex-col rounded-xl px-3 py-2 text-left hover:bg-[var(--brand-blue-soft)] ${
                        matchedOrganization?.id === organization.id ? "bg-[var(--brand-blue-soft)]" : ""
                      }`}
                      key={organization.id}
                      type="button"
                      role="option"
                      aria-selected={matchedOrganization?.id === organization.id}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectOrganization(organization);
                      }}
                    >
                      <span className="font-black">{organization.name}</span>
                      {(organization.state_province || organization.country) && (
                        <span className="mt-1 text-xs font-semibold text-[var(--muted)]">
                          {[organization.state_province, organization.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      )}
                    </button>
                  ))}
                  {!organizationSearching && normalizedTypedOrganization && !matchedOrganization && (
                    <button
                      className="mt-1 flex w-full flex-col rounded-xl border border-dashed border-[var(--line)] px-3 py-2 text-left text-sm hover:bg-[var(--brand-blue-soft)]"
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setSelectedOrganizationId("");
                        setSelectedOfficeId("");
                        setForceCreateOrganization(true);
                        setOrganizationQuery(normalizedTypedOrganization);
                        setOrganizationSearchOpen(false);
                      }}
                    >
                      <span className="font-black">
                        Create &quot;{normalizedTypedOrganization}&quot;
                      </span>
                      <span className="mt-1 text-xs font-semibold text-[var(--muted)]">
                        Use only if your organization is not listed above.
                      </span>
                    </button>
                  )}
                  {!organizationSearching && !organizationOptions.length && !normalizedTypedOrganization && (
                    <p className="rounded-xl border border-dashed border-[var(--line)] p-3 text-sm text-[var(--muted)]">
                      Start typing to search organizations.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--brand-blue-soft)] p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  className="accent-[var(--brand)]"
                  type="radio"
                  checked={officeMode === "new"}
                  onChange={() => {
                    setOfficeMode("new");
                    setSelectedOfficeId("");
                  }}
                />
                Create a new office
              </label>
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  className="accent-[var(--brand)]"
                  type="radio"
                  checked={officeMode === "existing"}
                  onChange={() => setOfficeMode("existing")}
                />
                Join an existing office
              </label>
            </div>
            {officeMode === "new" && (
              <label className="mt-3 block">
                <span className="text-sm font-bold">Office</span>
                <input
                  className="input mt-1"
                  value={officeName}
                  onChange={(event) => setOfficeName(event.target.value)}
                  placeholder="Office of Nationally Competitive Awards"
                  required
                />
              </label>
            )}
            {officeMode === "existing" && (
              <div className="mt-3 grid gap-3">
                <label className="block">
                  <span className="text-sm font-bold">Search offices</span>
                  <input
                    className="input mt-1"
                    placeholder={
                      effectiveOrganizationId
                        ? "Search offices under this organization"
                        : "Start typing an office name"
                    }
                    value={officeQuery}
                    onChange={(event) => setOfficeQuery(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-bold">Matching offices</span>
                  <select
                    className="input mt-1"
                    value={selectedOfficeId}
                    onChange={(event) => setSelectedOfficeId(event.target.value)}
                    required={officeMode === "existing"}
                  >
                    <option value="">Select an office</option>
                    {officeOptions.map((office) => (
                      <option value={office.id} key={office.id}>
                        {office.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        </>
      )}
      <div>
        <label className="text-sm font-bold" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input mt-1"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      <div>
        <label className="text-sm font-bold" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input mt-1"
          type="password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {message && (
        <p className="rounded-xl bg-[var(--brand-pink-soft)] p-3 text-sm font-semibold text-[var(--foreground)]">
          {message}
        </p>
      )}
      <button className="button-primary w-full" type="submit" disabled={loading}>
        {loading ? "Working..." : mode === "login" ? "Log in" : "Create account"}
      </button>
    </form>
  );
}

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "";
  return value;
}
