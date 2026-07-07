"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clipboard, Play, SlidersHorizontal } from "lucide-react";
import {
  DEFAULT_BASELINE_COST_CAP_USD,
  MAINTENANCE_PROFILE_IDS,
  MAINTENANCE_PROFILES,
  type MaintenanceProfileId,
} from "@/lib/maintenance-profiles";

type Props = {
  controlAvailable: boolean;
  unavailableReason: string;
  commandTemplates: Record<MaintenanceProfileId, string>;
};

type RunMessage = {
  tone: "success" | "error" | "info";
  text: string;
};

export function AdminMaintenanceControls({
  controlAvailable,
  unavailableReason,
  commandTemplates,
}: Props) {
  const router = useRouter();
  const [profile, setProfile] = useState<MaintenanceProfileId>("catchup");
  const [apply, setApply] = useState(true);
  const [baselineCostCapUsd, setBaselineCostCapUsd] = useState(DEFAULT_BASELINE_COST_CAP_USD);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<RunMessage | null>(null);

  const command = useMemo(
    () => commandWithOptions(commandTemplates[profile], apply, baselineCostCapUsd),
    [apply, baselineCostCapUsd, commandTemplates, profile],
  );

  async function startRun() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/maintenance-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile, apply, baselineCostCapUsd }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Maintenance run failed.");
      }
      setMessage({
        tone: "success",
        text: `Started ${MAINTENANCE_PROFILES[profile].label}${typeof data.pid === "number" ? ` as PID ${data.pid}` : ""}.`,
      });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Maintenance run failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    if (!navigator.clipboard) {
      setMessage({ tone: "info", text: "Clipboard access is not available in this browser." });
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setMessage({ tone: "success", text: "Command copied." });
    } catch {
      setMessage({ tone: "error", text: "Command could not be copied." });
    }
  }

  return (
    <div className="admin-maintenance-controls">
      <div className="admin-profile-selector" role="tablist" aria-label="Maintenance profile">
        {MAINTENANCE_PROFILE_IDS.map((profileId) => {
          const selected = profileId === profile;
          return (
            <button
              aria-selected={selected}
              className={`admin-profile-button ${selected ? "admin-profile-button-active" : ""}`}
              key={profileId}
              onClick={() => setProfile(profileId)}
              role="tab"
              type="button"
            >
              {MAINTENANCE_PROFILES[profileId].label}
            </button>
          );
        })}
      </div>

      <div className="admin-maintenance-options">
        <label className="admin-maintenance-check">
          <input
            checked={apply}
            onChange={(event) => setApply(event.target.checked)}
            type="checkbox"
          />
          <span>Apply changes</span>
        </label>
        <label className="admin-maintenance-number">
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>Gemini cap</span>
          <input
            min={0}
            max={100}
            onChange={(event) => setBaselineCostCapUsd(Number(event.target.value))}
            step={1}
            type="number"
            value={baselineCostCapUsd}
          />
        </label>
      </div>

      <div className="admin-command-box">
        <code>{command}</code>
        <button
          aria-label="Copy command"
          className="admin-icon-button"
          onClick={copyCommand}
          type="button"
        >
          <Clipboard size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="admin-maintenance-action-row">
        <button
          className="button-primary"
          disabled={!controlAvailable || busy}
          onClick={startRun}
          type="button"
        >
          <Play size={16} aria-hidden="true" />
          {busy ? "Starting" : `Start ${MAINTENANCE_PROFILES[profile].label}`}
        </button>
        {!controlAvailable && (
          <p className="admin-maintenance-inline-note">{unavailableReason}</p>
        )}
      </div>

      {message && (
        <p
          className={`admin-maintenance-message admin-maintenance-message-${message.tone}`}
          role="status"
        >
          {message.tone === "success" && <CheckCircle2 size={15} aria-hidden="true" />}
          {message.text}
        </p>
      )}
    </div>
  );
}

function commandWithOptions(template: string, apply: boolean, baselineCostCapUsd: number) {
  return template
    .replace(/--apply=(true|false)/, `--apply=${apply}`)
    .replace(
      /--baseline-cost-cap-usd=[^\s"]+/,
      `--baseline-cost-cap-usd=${safeCostCapLabel(baselineCostCapUsd)}`,
    );
}

function safeCostCapLabel(value: number) {
  if (!Number.isFinite(value) || value < 0) return String(DEFAULT_BASELINE_COST_CAP_USD);
  return String(Math.min(100, Math.round(value * 100) / 100));
}
