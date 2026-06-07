"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

export function CheckNowButton({ monitorId }: { monitorId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function checkNow() {
    setLoading(true);
    await fetch(`/api/monitors/${monitorId}/check`, { method: "POST" });
    setLoading(false);
    router.refresh();
  }

  return (
    <button className="button-secondary" type="button" onClick={checkNow} disabled={loading}>
      <RotateCw size={15} aria-hidden="true" />
      {loading ? "Checking..." : "Check now"}
    </button>
  );
}
