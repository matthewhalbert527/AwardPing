import { AlertTriangle, CheckCircle2, CircleHelp, ShieldAlert } from "lucide-react";
import type {
  ReleaseCheckState,
  ReleaseGateState,
  Stage1ReleaseGateSummary,
} from "@/lib/stage1-release-gate-summary";

type AdminStage1ReleaseGateProps = {
  summary: Stage1ReleaseGateSummary;
};

export function AdminStage1ReleaseGate({ summary }: AdminStage1ReleaseGateProps) {
  return (
    <section
      aria-labelledby="stage1-release-gate-title"
      className="card admin-section-card space-y-5 p-5 sm:p-6"
      data-release-gate-phase={summary.phase}
      data-release-gate-state={summary.state}
    >
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <GateStatePill state={summary.state} />
            <span className="text-sm font-bold text-[var(--muted)]">
              {summary.visibleCount}/25 effectively visible · {summary.registryCount}/25 registered
            </span>
          </div>
          <h2 className="mt-3 text-2xl font-bold" id="stage1-release-gate-title">
            Stage 1 Beta Release Gate
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Verified evidence stays valid while its exact keys and hashes still match. Live sources must be checked every 24 hours, and public visibility also requires a current signed R2 recovery drill.
          </p>
        </div>
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" role="status">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Safe next action</p>
          <p className="mt-1 text-sm font-bold">{summary.safeNextAction}</p>
        </div>
      </header>

      {summary.unknownReasons.length > 0 && (
        <div className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
          <CircleHelp className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
          <p>
            <strong>Release evidence is incomplete.</strong> {summary.unknownReasons[0]}
          </p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ReleaseCheckCard
          detail={`${summary.authoritativeGate.detail} Snapshot generated ${formatDate(summary.authoritativeGate.generatedAt)}.`}
          label="Database release authority"
          status={summary.authoritativeGate.status}
          value={`${summary.authoritativeGate.currentValidArtifactBindings}/${summary.authoritativeGate.requiredArtifactBindings} exact ID + hash`}
        />
        <ReleaseCheckCard
          detail={`Vault API surface safe: ${booleanLabel(summary.authoritativeGate.vaultApiSurfaceSafe)}. Service-role Data API profile blocked: ${booleanLabel(summary.authoritativeGate.serviceRoleDataApiProfileBlocked)}. Probe: ${summary.authoritativeGate.profileHttpStatus ?? "unavailable"} / ${summary.authoritativeGate.profilePostgrestCode || "unavailable"}.`}
          label="Authoritative Vault security"
          status={vaultStatus(summary.authoritativeGate)}
          value={summary.authoritativeGate.vaultApiSurfaceSafe === true &&
            summary.authoritativeGate.serviceRoleDataApiProfileBlocked === true
            ? "Both controls safe"
            : "Release blocked"}
        />
        <ReleaseCheckCard
          detail={atomicReleaseDetail(summary)}
          label="Atomic cohort release"
          status={atomicReleaseStatus(summary)}
          value={atomicReleaseValue(summary)}
        />
        <ReleaseCheckCard
          detail={summary.invite.detail}
          label="Invite-only signup"
          status={summary.invite.status}
          value={summary.invite.disableSignup === true ? "Hosted signup disabled" : summary.invite.disableSignup === false ? "Public signup enabled" : "Not verified"}
        />
        <ReleaseCheckCard
          detail={summary.inviteSecurityReissues.detail}
          label="Advisor invite reissues"
          status={summary.inviteSecurityReissues.status}
          value={summary.inviteSecurityReissues.count === null
            ? "Exact count unavailable"
            : `${summary.inviteSecurityReissues.count} unresolved`}
        />
        <ReleaseCheckCard
          detail={summary.nightly.detail}
          label="6 PM release acceptance"
          status={summary.nightly.status}
          value={summary.nightly.label}
        />
        <ReleaseCheckCard
          detail={summary.recovery.detail}
          label="R2 recovery readiness"
          status={summary.recovery.status}
          value={`${summary.recovery.reportingShards}/3 shards · ${summary.recovery.failed} failed · ${summary.recovery.refused} refused`}
        />
        {summary.acceptanceArtifacts.map((artifact) => (
          <ReleaseCheckCard
            detail={`${artifact.detail} Authoritative binding: ${artifact.authoritativeArtifactId || "none"} / ${artifact.authoritativeEvidenceHash || "none"}.${artifact.validUntil ? ` Valid until ${formatDate(artifact.validUntil)}.` : ""}`}
            key={artifact.kind}
            label={artifact.label}
            status={artifact.status}
            value={artifact.status === "pass" ? "Proof retained" : "Release blocked"}
          />
        ))}
        {summary.budgets.map((budget) => (
          <ReleaseCheckCard
            detail={`${money(budget.spentUsd)} spent · ${money(budget.reservedUsd)} reserved · ${money(budget.remainingUsd)} remaining · ${budget.configurationSource}`}
            key={budget.laneKey}
            label={`${budget.label} budget`}
            status={budget.status}
            value={budget.capUsd === null ? "Unavailable" : `${money(budget.capUsd)} / day`}
          />
        ))}
      </div>

      <section aria-labelledby="release-nightly-acceptance-title" className="rounded-2xl border border-[var(--border)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold" id="release-nightly-acceptance-title">6 PM acceptance history</h3>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Only normal scheduled scans count. Targeted, repair, partial, and historical-onboarding runs are excluded.
            </p>
          </div>
          <div className="text-right text-xs font-bold text-[var(--muted)]">
            <p>{summary.nightly.acceptance.healthyCohorts}/3 cohorts passed · dates {summary.nightly.acceptance.consecutive ? "consecutive" : "not consecutive"}</p>
            <p>
              24-hour soak: {summary.nightly.acceptance.soakComplete
                ? "complete"
                : `${summary.nightly.acceptance.soakElapsedHours ?? 0}/24 hours`}
            </p>
          </div>
        </div>
        <ol className="mt-3 grid gap-2 md:grid-cols-3">
          {summary.nightly.acceptance.cohorts.map((cohort) => (
            <li className="rounded-xl border border-[var(--border)] p-3 text-sm" key={cohort.monitoringDate}>
              <div className="flex items-start justify-between gap-2">
                <strong>{cohort.monitoringDate}</strong>
                <StatusPill label={statusLabel(cohort.status)} status={cohort.status} />
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">{cohort.detail}</p>
              <time className="mt-2 block text-xs font-bold text-[var(--muted)]" dateTime={cohort.finishedAt || undefined}>
                Finished {formatDate(cohort.finishedAt)}
              </time>
            </li>
          ))}
          {Array.from({ length: Math.max(0, 3 - summary.nightly.acceptance.cohorts.length) }, (_, index) => (
            <li className="rounded-xl border border-dashed border-[var(--border)] p-3 text-sm" key={`missing-nightly-${index}`}>
              <div className="flex items-start justify-between gap-2">
                <strong>Awaiting cohort</strong>
                <StatusPill label="Hold" status="hold" />
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">No qualifying normal scheduled 6 PM cohort is available for this position.</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="release-lanes-title" className="rounded-2xl border border-[var(--border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold" id="release-lanes-title">Eight downstream lanes</h3>
          <span className="text-xs font-bold text-[var(--muted)]">
            {summary.lanes.filter((lane) => lane.status === "pass").length}/8 healthy
          </span>
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {summary.lanes.map((lane) => (
            <li className="rounded-xl border border-[var(--border)] p-3 text-sm" key={lane.laneKey}>
              <div className="flex items-start justify-between gap-2">
                <strong>{lane.label}</strong>
                <StatusPill label={statusLabel(lane.status)} status={lane.status} />
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">{lane.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="release-identity-title" className="rounded-2xl border border-[var(--border)] p-4">
        <h3 className="text-sm font-bold" id="release-identity-title">Runtime and migration identity</h3>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summary.identities.map((identity) => (
            <li className="flex min-w-0 items-start gap-2 text-sm" key={identity.key}>
              <CheckIcon status={identity.status} />
              <span>
                <strong>{identity.label}:</strong> {identity.detail}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
        <table className="w-full min-w-[78rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Exactly 25 Stage 1 awards with effective publication, source-manifest, reconciliation, audit, and quarantine readiness.
          </caption>
          <thead className="bg-[var(--surface)] text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3" scope="col">Award</th>
              <th className="px-4 py-3" scope="col">Publication</th>
              <th className="px-4 py-3" scope="col">Registry verification</th>
              <th className="px-4 py-3" scope="col">Source manifest</th>
              <th className="px-4 py-3" scope="col">Reconciliation</th>
              <th className="px-4 py-3" scope="col">Page audit</th>
              <th className="px-4 py-3" scope="col">Quarantine</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {summary.awards.map((award) => (
              <tr key={award.cohortKey}>
                <th className="px-4 py-3 align-top" scope="row">
                  <span className="block font-bold">{award.launchRank}. {award.canonicalName}</span>
                  <span className="mt-1 block font-normal text-[var(--muted)]">{award.cohortKey}</span>
                </th>
                <td className="max-w-sm px-4 py-3 align-top">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={award.effectivelyVisible ? "Visible" : "Held"} status={award.effectivelyVisible ? "pass" : "hold"} />
                    <span className="font-bold">{humanize(award.publicationState)}</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{award.effectiveReason}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusPill label={award.verificationEpochValid ? "Verified epoch" : "Missing / future"} status={award.verificationEpochValid ? "pass" : "hold"} />
                  <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={award.evidenceCheckedAt || undefined}>
                    {formatDate(award.evidenceCheckedAt)}
                  </time>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusPill
                    label={`${award.completedManifestRoles}/8 complete · ${award.verifiedManifestRoles}/8 verified`}
                    status={award.completedManifestRoles === 8 && award.verifiedManifestRoles === 8 ? "pass" : "hold"}
                  />
                  {award.missingManifestRoles.length > 0 && (
                    <p className="mt-1 max-w-xs text-xs text-[var(--muted)]">
                      Missing: {award.missingManifestRoles.map(humanize).join(", ")}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusPill label={humanize(award.reconciliationStatus)} status={award.reconciliationValid ? "pass" : "hold"} />
                  <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={award.reconciliationAt || undefined}>
                    {formatDate(award.reconciliationAt)}
                  </time>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusPill label={humanize(award.auditStatus)} status={award.auditValid ? "pass" : "hold"} />
                  <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={award.auditAt || undefined}>
                    {formatDate(award.auditAt)}
                  </time>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusPill label={`${award.quarantineCount} open`} status={award.quarantineCount === 0 ? "pass" : "hold"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReleaseCheckCard({
  detail,
  label,
  status,
  value,
}: {
  detail: string;
  label: string;
  status: ReleaseCheckState;
  value: string;
}) {
  return (
    <article className="rounded-2xl border border-[var(--border)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</h3>
        <StatusPill label={statusLabel(status)} status={status} />
      </div>
      <p className="mt-2 font-bold">{value}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">{detail}</p>
    </article>
  );
}

function GateStatePill({ state }: { state: ReleaseGateState }) {
  return <StatusPill label={state} status={state === "READY" ? "pass" : state === "HOLD" ? "hold" : "unknown"} />;
}

function StatusPill({ label, status }: { label: string; status: ReleaseCheckState }) {
  const className = status === "pass"
    ? "border-emerald-300 bg-emerald-50 text-emerald-950"
    : status === "hold"
      ? "border-rose-300 bg-rose-50 text-rose-950"
      : "border-amber-300 bg-amber-50 text-amber-950";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${className}`}>{label}</span>;
}

function CheckIcon({ status }: { status: ReleaseCheckState }) {
  if (status === "pass") return <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-700" size={16} aria-hidden="true" />;
  if (status === "hold") return <ShieldAlert className="mt-0.5 shrink-0 text-rose-700" size={16} aria-hidden="true" />;
  return <AlertTriangle className="mt-0.5 shrink-0 text-amber-700" size={16} aria-hidden="true" />;
}

function statusLabel(status: ReleaseCheckState) {
  return status === "pass" ? "Pass" : status === "hold" ? "Hold" : "Unknown";
}

function formatDate(value: string | null) {
  if (!value) return "No current evidence";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(date);
}

function money(value: number | null) {
  return value === null ? "unavailable" : `$${value.toFixed(2)}`;
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function booleanLabel(value: boolean | null) {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function atomicReleaseStatus(summary: Stage1ReleaseGateSummary): ReleaseCheckState {
  if (summary.release.atomic || summary.phase === "preactivation_ready") return "pass";
  return summary.phase === "unknown" ? "unknown" : "hold";
}

function atomicReleaseValue(summary: Stage1ReleaseGateSummary) {
  if (summary.release.atomic) return "25/25 active on one epoch";
  if (summary.phase === "preactivation_ready") return "Ready for atomic activation";
  return humanize(summary.release.state);
}

function atomicReleaseDetail(summary: Stage1ReleaseGateSummary) {
  if (summary.phase === "preactivation_ready") {
    return "All 25 awards are release-ready and remain private pending the separate atomic activation step.";
  }
  return `${humanize(summary.release.effectiveReason)} · ${summary.release.epoch || "No active epoch"}`;
}

function vaultStatus(
  authority: Stage1ReleaseGateSummary["authoritativeGate"],
): ReleaseCheckState {
  if (
    authority.vaultApiSurfaceSafe === null ||
    authority.serviceRoleDataApiProfileBlocked === null
  ) return "unknown";
  return authority.vaultApiSurfaceSafe &&
    authority.serviceRoleDataApiProfileBlocked
    ? "pass"
    : "hold";
}
