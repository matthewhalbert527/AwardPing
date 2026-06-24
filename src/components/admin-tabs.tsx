import Link from "next/link";

type AdminTab = {
  href: string;
  label: string;
  count?: number;
};

const tabs: AdminTab[] = [
  { href: "/dashboard/admin", label: "Scan status" },
  { href: "/dashboard/admin/issues", label: "Page issues" },
];

export function AdminTabs({
  active,
  issueCount,
}: {
  active: "status" | "issues";
  issueCount?: number;
}) {
  const enrichedTabs = tabs.map((tab) =>
    tab.href.endsWith("/issues") ? { ...tab, count: issueCount } : tab,
  );

  return (
    <nav aria-label="Admin sections" className="admin-tabs">
      {enrichedTabs.map((tab) => {
        const isActive =
          (active === "status" && tab.href === "/dashboard/admin") ||
          (active === "issues" && tab.href.endsWith("/issues"));
        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={`admin-tab ${isActive ? "admin-tab-active" : ""}`}
            href={tab.href}
            key={tab.href}
          >
            <span>{tab.label}</span>
            {typeof tab.count === "number" && tab.count > 0 && (
              <span className="admin-tab-count">{formatNumber(tab.count)}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
