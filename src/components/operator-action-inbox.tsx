import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { AdminPageIssueActions } from "@/components/admin-page-issue-actions";
import { AdminPaidReviewRetryAction } from "@/components/admin-paid-review-retry-action";
import { dashboardAwardPath } from "@/lib/award-slugs";
import {
  operatorActionInboxSummary,
  type OperatorActionInboxItem,
} from "@/lib/operator-action-inbox";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  items: OperatorActionInboxItem[];
};

export function OperatorActionInbox({ items }: Props) {
  const summary = operatorActionInboxSummary(items);

  return (
    <section className="operator-inbox" aria-labelledby="operator-inbox-title">
      <div className="card operator-inbox-summary">
        <div>
          <p className="operator-inbox-kicker">One queue, ordered by public impact</p>
          <h2 id="operator-inbox-title">
            {summary.total === 0
              ? "The Action Inbox is clear"
              : summary.needsOperator === 0
                ? "Everything open is retrying automatically"
                : `${formatNumber(summary.needsOperator)} ${summary.needsOperator === 1 ? "item needs" : "items need"} a person`}
          </h2>
          <p>
            {summary.total === 0
              ? "There are no current operator decisions, publication blockers, or failed automatic retries."
              : `${formatNumber(summary.autoRetrying)} ${summary.autoRetrying === 1 ? "item is" : "items are"} retrying automatically. Every row says what failed, who owns it, whether a retry costs money, and the safest next step.`}
          </p>
        </div>
        {summary.publicBlockers > 0 ? (
          <span className="operator-inbox-summary-status operator-inbox-summary-status-attention">
            <AlertTriangle size={16} aria-hidden="true" />
            {formatNumber(summary.publicBlockers)} public {summary.publicBlockers === 1 ? "impact" : "impacts"}
          </span>
        ) : summary.publicImpactUnknown > 0 ? (
          <span className="operator-inbox-summary-status operator-inbox-summary-status-attention">
            <AlertTriangle size={16} aria-hidden="true" />
            {formatNumber(summary.publicImpactUnknown)} public {summary.publicImpactUnknown === 1 ? "impact needs" : "impacts need"} verification
          </span>
        ) : (
          <span className="operator-inbox-summary-status">
            <ShieldCheck size={16} aria-hidden="true" />
            Public safeguards active
          </span>
        )}
      </div>

      {items.length > 0 ? (
        <div className="operator-inbox-list">
          {items.map((item) => (
            <OperatorActionRow item={item} key={item.id} />
          ))}
        </div>
      ) : (
        <div className="card operator-inbox-empty">
          <CheckCircle2 size={22} aria-hidden="true" />
          <div>
            <h3>No safe action is waiting</h3>
            <p>Normal pending work and historical exclusions are intentionally not treated as failures.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function OperatorActionRow({ item }: { item: OperatorActionInboxItem }) {
  const sourceUrl = safeExternalUrl(item.source?.url || null);
  const exactTime = item.occurredAt ? formatCentralDateTime(item.occurredAt) : "Exact time unavailable";

  return (
    <article
      className={`card operator-inbox-item operator-inbox-item-${item.severity} operator-inbox-item-${item.state}`}
    >
      <header className="operator-inbox-item-header">
        <div className="operator-inbox-badges">
          <span className={`admin-severity-pill admin-severity-pill-${item.severity}`}>
            {item.severityLabel}
          </span>
          <span className={`operator-impact-pill operator-impact-pill-${item.publicImpact.level}`}>
            {item.publicImpact.label}
          </span>
          <span className={`operator-state-pill operator-state-pill-${item.state}`}>
            {item.stateLabel}
          </span>
        </div>
        <time dateTime={item.occurredAt || undefined} title={exactTime}>
          {item.ageLabel}
        </time>
      </header>

      <div className="operator-inbox-title-block">
        <h3>{item.title}</h3>
        {item.context && <p>{item.context}</p>}
      </div>

      <div className="operator-inbox-reason">
        <span>Why it failed</span>
        <p>{item.failureReason}</p>
      </div>

      <dl className="operator-inbox-facts">
        <InboxFact
          detail={item.occurredAt ? exactTime : "The source record has no reliable timestamp."}
          icon={Clock3}
          label="Age / last seen"
          value={item.ageLabel}
        />
        <InboxFact
          detail={item.owner.detail}
          icon={UserRound}
          label="Owner"
          value={item.owner.label}
        />
        <InboxFact
          detail={item.retry.detail}
          icon={RefreshCw}
          label="Automatic retry"
          value={item.retry.label}
        />
        <InboxFact
          detail={item.charge.detail}
          icon={CircleDollarSign}
          label="Retry charge"
          tone={item.charge.level}
          value={item.charge.label}
        />
      </dl>

      <div className="operator-inbox-impact-copy">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>{item.publicImpact.detail}</p>
      </div>

      <div className="operator-inbox-recommendation">
        <div>
          <span>Recommended safe action</span>
          <h4>{item.recommendedAction.label}</h4>
          <p>{item.recommendedAction.detail}</p>
        </div>
        {item.recommendedAction.href && (
          <Link className="button-secondary" href={item.recommendedAction.href}>
            Open workspace
          </Link>
        )}
      </div>

      {(item.award || sourceUrl) && (
        <div className="operator-inbox-links" aria-label="Related records">
          {item.award && (
            <Link href={dashboardAwardPath(item.award.slug, item.award.name, item.award.id)}>
              Award page
            </Link>
          )}
          {sourceUrl && (
            <a href={sourceUrl} rel="noreferrer" target="_blank">
              Original source <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      <details className="operator-inbox-evidence">
        <summary>
          Evidence and policy <span>{item.policy.version}</span>
        </summary>
        <div className="operator-inbox-evidence-body">
          <dl className="operator-inbox-evidence-grid">
            {item.evidence.map((evidence) => (
              <div key={`${evidence.label}:${evidence.value}`}>
                <dt>{evidence.label}</dt>
                <dd>{evidence.value}</dd>
              </div>
            ))}
          </dl>
          <div className="operator-inbox-policy">
            <h4>Policy used for this queue decision</h4>
            <dl>
              <div>
                <dt>Identity</dt>
                <dd>{item.policy.id}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{item.policy.version}</dd>
              </div>
              <div>
                <dt>Hash</dt>
                <dd>{item.policy.hash || "Not recorded"}</dd>
              </div>
            </dl>
            <p>{item.policy.description}</p>
          </div>
        </div>
      </details>

      {item.action.kind === "source" && (
        <AdminPageIssueActions
          mode="active"
          sourceId={item.action.sourceId}
          sourceTitle={item.action.sourceTitle}
        />
      )}
      {item.action.kind === "paid_visual_retry" && (
        <AdminPaidReviewRetryAction
          candidateId={item.action.candidateId}
          candidateUpdatedAt={item.action.candidateUpdatedAt}
          sourceTitle={item.action.sourceTitle}
        />
      )}
    </article>
  );
}

function InboxFact({
  detail,
  icon: Icon,
  label,
  tone = "neutral",
  value,
}: {
  detail: string;
  icon: typeof Clock3;
  label: string;
  tone?: OperatorActionInboxItem["charge"]["level"] | "neutral";
  value: string;
}) {
  return (
    <div className={`operator-inbox-fact operator-inbox-fact-${tone}`}>
      <dt>
        <Icon size={14} aria-hidden="true" />
        {label}
      </dt>
      <dd>{value}</dd>
      <p>{detail}</p>
    </div>
  );
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
