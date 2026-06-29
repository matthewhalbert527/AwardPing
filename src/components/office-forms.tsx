"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Download,
  Link as LinkIcon,
  MailPlus,
  Save,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import type { NotificationPreference, OfficeRole } from "@/lib/database.types";

type SearchUser = {
  id: string;
  email: string;
};

export function ProfileSettingsForm({
  initialFullName,
  initialOrganization,
}: {
  initialFullName: string;
  initialOrganization: string;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState(initialFullName);
  const [organization, setOrganization] = useState(initialOrganization);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName, organization }),
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Profile could not be saved.");
      return;
    }

    setMessage("Profile saved.");
    router.refresh();
  }

  return (
    <form className="dashboard-panel dashboard-panel-pad" onSubmit={submit}>
      <h2 className="dashboard-panel-title flex items-center gap-2">
        <UserRound size={21} aria-hidden="true" />
        Your profile
      </h2>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="block">
          <span className="text-sm font-bold">Name</span>
          <input
            className="input mt-1"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="text-sm font-bold">Organization</span>
          <input
            className="input mt-1"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            required
          />
        </label>
        <button className="button-primary self-end" type="submit" disabled={loading}>
          <Save size={17} aria-hidden="true" />
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
      {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
    </form>
  );
}

export function CreateOfficeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const response = await fetch("/api/offices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Office could not be created.");
      return;
    }

    setName("");
    setMessage("Office created.");
    router.refresh();
  }

  return (
    <form className="card rounded-3xl p-5" onSubmit={submit}>
      <h2 className="text-2xl font-black">Create university office</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Use the name your school uses, such as University Fellowship Office,
        Office of Nationally Competitive Awards, or Honors Advising.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="University of Example Office of Nationally Competitive Awards"
          required
        />
        <button className="button-primary" type="submit" disabled={loading}>
          <Building2 size={17} aria-hidden="true" />
          {loading ? "Creating..." : "Create"}
        </button>
      </div>
      {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
    </form>
  );
}

export function OfficeNameForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/offices/current", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();

    if (!response.ok) {
      setMessage(data.error || "Office name could not be saved.");
      return;
    }

    setMessage("Office name saved.");
    router.refresh();
  }

  return (
    <form className="dashboard-panel dashboard-panel-pad" onSubmit={submit}>
      <label className="text-sm font-bold" htmlFor="office-name">
        Office name
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id="office-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <button className="button-primary" type="submit">
          <Save size={17} aria-hidden="true" />
          Save
        </button>
      </div>
      {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
    </form>
  );
}

export function InviteMemberForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [message, setMessage] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);

  async function createInvite(input: { email?: string }) {
    setLoading(true);
    setMessage("");
    setInviteUrl("");
    setInviteCode("");
    const response = await fetch("/api/offices/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: input.email || undefined,
        role,
      }),
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Invitation could not be sent.");
      return;
    }

    setInviteUrl(data.inviteUrl || "");
    setInviteCode(data.inviteCode || "");
    setMessage(input.email ? "Invitation created and email sent." : "Invite link created.");
    router.refresh();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createInvite({ email });
  }

  async function searchUsers() {
    if (email.trim().length < 3) {
      setMessage("Enter at least 3 characters to search users.");
      return;
    }

    setSearching(true);
    setMessage("");
    const response = await fetch(`/api/offices/users?query=${encodeURIComponent(email)}`);
    const data = await response.json();
    setSearching(false);

    if (!response.ok) {
      setMessage(data.error || "Users could not be searched.");
      return;
    }

    setSearchResults(data.users || []);
    if (!data.users?.length) setMessage("No matching existing users found.");
  }

  return (
    <form className="dashboard-panel dashboard-panel-pad" onSubmit={submit}>
      <h2 className="dashboard-panel-title">Invite advisor</h2>
      <p className="dashboard-panel-copy">
        Search for an existing user by email, send an email invite, or create a
        shareable invite code for someone who still needs to sign up.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_160px_auto]">
        <input
          className="input"
          name="email"
          type="email"
          placeholder="advisor@example.edu"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="button-secondary" type="button" onClick={searchUsers} disabled={searching}>
          <Search size={17} aria-hidden="true" />
          {searching ? "Searching..." : "Search"}
        </button>
        <select
          className="input"
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value as "admin" | "member")}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button className="button-primary" type="submit" disabled={loading || !email}>
          <MailPlus size={17} aria-hidden="true" />
          {loading ? "Sending..." : "Invite"}
        </button>
      </div>
      {searchResults.length > 0 && (
        <div className="mt-3 grid gap-2">
          {searchResults.map((user) => (
            <button
              className="dashboard-list-item text-left text-sm font-bold"
              key={user.id}
              type="button"
              onClick={() => setEmail(user.email)}
            >
              {user.email}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3">
        <button
          className="button-secondary"
          type="button"
          onClick={() => createInvite({})}
          disabled={loading}
        >
          <LinkIcon size={17} aria-hidden="true" />
          Create invite code
        </button>
      </div>
      {(inviteUrl || inviteCode) && (
        <div className="dashboard-list-item mt-4">
          {inviteCode && (
            <p className="text-sm font-black">
              Code: <span className="font-mono">{inviteCode}</span>
            </p>
          )}
          {inviteUrl && (
            <input
              className="input mt-2 font-mono text-sm"
              value={inviteUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </div>
      )}
      {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
    </form>
  );
}

export function MemberPreferenceSelect({
  memberId,
  value,
}: {
  memberId: string;
  value: NotificationPreference;
}) {
  const router = useRouter();

  async function update(notificationPreference: NotificationPreference) {
    await fetch(`/api/offices/members/${memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationPreference }),
    });
    router.refresh();
  }

  return (
    <select
      className="input max-w-xs"
      value={value}
      onChange={(event) => update(event.target.value as NotificationPreference)}
    >
      <option value="immediate">Immediate</option>
      <option value="daily_digest">Daily digest</option>
      <option value="both">Both</option>
      <option value="none">None</option>
    </select>
  );
}

export function MemberRoleSelect({
  memberId,
  value,
  disabled,
}: {
  memberId: string;
  value: OfficeRole;
  disabled?: boolean;
}) {
  const router = useRouter();

  async function update(role: "admin" | "member") {
    await fetch(`/api/offices/members/${memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    router.refresh();
  }

  if (value === "owner") {
    return <span className="badge">Owner/admin</span>;
  }

  return (
    <select
      className="input max-w-[150px]"
      value={value}
      disabled={disabled}
      onChange={(event) => update(event.target.value as "admin" | "member")}
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </select>
  );
}

export function PrivacyControls() {
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function deleteAccount() {
    setDeleting(true);
    setMessage("");

    const response = await fetch("/api/privacy/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setDeleting(false);
      setMessage(data.error || "Account could not be deleted.");
      return;
    }

    window.location.href = "/";
  }

  return (
    <section className="dashboard-panel dashboard-panel-pad">
      <h2 className="dashboard-panel-title">Privacy controls</h2>
      <p className="dashboard-panel-copy">
        Export your account data or permanently delete your AwardPing account.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <a className="button-secondary" href="/api/privacy/export" download>
          <Download size={17} aria-hidden="true" />
          Download my data
        </a>
      </div>
      <div className="mt-5 rounded-2xl border border-[var(--line)] bg-white p-4">
        <label className="block">
          <span className="text-sm font-bold">Type DELETE to delete your account</span>
          <input
            className="input mt-2"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className="button-secondary mt-3"
          type="button"
          onClick={deleteAccount}
          disabled={deleting || confirm !== "DELETE"}
        >
          <Trash2 size={17} aria-hidden="true" />
          {deleting ? "Deleting..." : "Delete account"}
        </button>
        {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
      </div>
    </section>
  );
}
