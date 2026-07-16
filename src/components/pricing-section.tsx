import { Check } from "lucide-react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { signedInLandingLabel, signedInLandingPath } from "@/lib/navigation";

const features = [
  "Unlimited award page monitors",
  "Scheduled daily checks",
  "Email alerts",
  "Update history for follow-up",
  "Find exact official award pages",
];

export async function PricingSection() {
  const user = await getCurrentUser();

  return (
    <div className="card max-w-3xl rounded-3xl p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-black">Create a free account</h2>
          <p className="mt-2 text-[var(--muted)]">
            AwardPing is free to use for students, advisors, and offices.
          </p>
        </div>
        <p className="text-4xl font-black">$0</p>
      </div>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {features.map((feature) => (
          <li className="flex items-center gap-2 text-sm" key={feature}>
            <Check size={17} className="text-[var(--brand)]" aria-hidden="true" />
            {feature}
          </li>
        ))}
      </ul>
      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        <Link className="button-primary" href={user ? signedInLandingPath() : "/signup"}>
          {user ? signedInLandingLabel() : "Sign up for free"}
        </Link>
        <Link className="button-secondary" href="/award-directory" prefetch={false}>
          Find exact pages
        </Link>
      </div>
    </div>
  );
}
