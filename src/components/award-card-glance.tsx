import { awardCardGlance, type AwardCardGlanceInput } from "@/lib/award-card-glance";
import styles from "./award-card-glance.module.css";

/** One consistent, display-only facts row inside the award's existing link. */
export function AwardCardGlance(props: AwardCardGlanceInput) {
  return (
    <div className={styles.container}>
      <dl className={styles.facts} aria-label="Award at a glance">
        {awardCardGlance(props).map((item) => (
          <div className={styles.field} key={item.key}>
            <dt className={styles.label}>{item.label}</dt>
            <dd
              className={item.highlight ? `${styles.value} ${styles.highlight}` : styles.value}
              data-field={item.key}
              title={item.detail}
            >
              {item.dateTime ? <time dateTime={item.dateTime} aria-label={item.detail}>{item.value}</time> : item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
