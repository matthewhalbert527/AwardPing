"use client";

import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";

type OfficeOption = {
  officeId: string;
  officeName: string;
};

export function OfficeSwitcher({
  offices,
  currentOfficeId,
}: {
  offices: OfficeOption[];
  currentOfficeId: string;
}) {
  const router = useRouter();

  async function switchOffice(officeId: string) {
    await fetch("/api/offices/current", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ officeId }),
    });
    router.refresh();
  }

  if (offices.length <= 1) {
    return (
      <div className="dashboard-office-switcher">
        <Building2 size={16} aria-hidden="true" />
        <span className="truncate">{offices[0]?.officeName || "Award office"}</span>
      </div>
    );
  }

  return (
    <label className="dashboard-office-switcher">
      <Building2 size={16} aria-hidden="true" />
      <span className="sr-only">Office</span>
      <select
        className="bg-transparent text-sm font-bold outline-none"
        value={currentOfficeId}
        onChange={(event) => switchOffice(event.target.value)}
      >
        {offices.map((office) => (
          <option value={office.officeId} key={office.officeId}>
            {office.officeName}
          </option>
        ))}
      </select>
    </label>
  );
}
