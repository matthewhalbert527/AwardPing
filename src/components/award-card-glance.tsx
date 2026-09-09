import { awardCardLastUpdate, type AwardCardGlanceInput } from "@/lib/award-card-glance";
import styles from "./award-card-glance.module.css";

/** A display-only date stamp inside the award's existing link, not a button. */
export function AwardCardGlance(
  props: Pick<AwardCardGlanceInput, "changeCount" | "latestUpdateAt" | "firstPublishedCaptureAt">,
) {
  const item = awardCardLastUpdate(props);
  return (
    <div className={styles.container}>
      <dl className={styles.stamp} aria-label="Award last update">
        <div className={styles.field}>
          <dt className={styles.label}>{item.label}</dt>
          <dd
            className={styles.value}
            data-field={item.key}
            title={item.detail}
          >
            {item.dateTime ? <time dateTime={item.dateTime} aria-label={item.detail}>{item.value}</time> : item.value}
          </dd>
        </div>
      </dl>
    </div>
  );
}
