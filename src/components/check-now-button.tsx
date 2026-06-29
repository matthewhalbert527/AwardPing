"use client";

import { Clock } from "lucide-react";

export function CheckNowButton({ monitorId: _monitorId }: { monitorId: string }) {
  void _monitorId;

  return (
    <button className="button-secondary" type="button" disabled title="Checked by the daily screenshot worker">
      <Clock size={15} aria-hidden="true" />
      Daily scan
    </button>
  );
}
