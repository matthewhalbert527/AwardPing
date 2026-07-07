"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function accept() {
    setLoading(true);
    setMessage("");
    const response = await fetch(`/api/offices/invites/${token}/accept`, {
      method: "POST",
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setMessage(data.error || "Invitation could not be accepted.");
      return;
    }

    router.push("/updates");
    router.refresh();
  }

  return (
    <div>
      <button className="button-primary" type="button" onClick={accept} disabled={loading}>
        {loading ? "Joining..." : "Join office"}
      </button>
      {message && <p className="mt-3 text-sm font-semibold text-[var(--foreground)]">{message}</p>}
    </div>
  );
}
