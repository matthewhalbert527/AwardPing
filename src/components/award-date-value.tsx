import { awardDateZoneSlices } from "@/lib/award-date-display";

/** Keep a stated UTC offset readable without changing copied or spoken text. */
export function AwardDateValue({ value }: { value: string }) {
  const parts = awardDateZoneSlices(value);
  if (!parts) return <>{value}</>;
  return <>{parts.prefix}<span className="award-date-zone">{parts.zone}</span>{parts.suffix}</>;
}
