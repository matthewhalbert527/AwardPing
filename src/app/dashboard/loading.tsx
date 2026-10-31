export default function DashboardLoading() {
  return (
    <section className="card p-6" aria-busy="true" aria-label="Loading workspace">
      <p className="text-sm text-[var(--muted)]" role="status">Loading your workspace…</p>
    </section>
  );
}
