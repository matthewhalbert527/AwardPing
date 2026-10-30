import { AwardDateValue } from "@/components/award-date-value";
import type { AwardDeadlinePresentation } from "@/lib/award-page-presentation";
import styles from "./award-deadline-value.module.css";

/** The same readable date treatment on cards and individual award pages. */
export function AwardDeadlineValue({ value, status }: Pick<AwardDeadlinePresentation["entries"][number], "value" | "status">) {
  const past = status === "past";
  return <>
    <span className={past ? styles.pastDeadline : undefined}><AwardDateValue value={value} /></span>
    {past ? <span className="sr-only"> (deadline has passed)</span> : null}
  </>;
}
