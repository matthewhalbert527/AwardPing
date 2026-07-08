export type PlanName = "free" | "pro";
export type Cadence = "daily" | "hourly";
export type MonitorContentType = "auto" | "html" | "pdf";

export type PlanLimits = {
  name: PlanName;
  label: string;
  price: string;
  monitors: number;
  cadences: Cadence[];
  historyDays: number;
};

export const planLimits: Record<PlanName, PlanLimits> = {
  free: {
    name: "free",
    label: "Free",
    price: "$0",
    monitors: Number.MAX_SAFE_INTEGER,
    cadences: ["daily"],
    historyDays: 365,
  },
  pro: {
    name: "pro",
    label: "Free",
    price: "$0",
    monitors: Number.MAX_SAFE_INTEGER,
    cadences: ["daily"],
    historyDays: 365,
  },
};

export function canUseCadence(plan: PlanName, cadence: Cadence) {
  return planLimits[plan].cadences.includes(cadence);
}

export function nextCheckDate(cadence: Cadence, from = new Date()) {
  const intervalMs = cadence === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + intervalMs).toISOString();
}
