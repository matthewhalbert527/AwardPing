import { redirect } from "next/navigation";
import { signedInLandingPath } from "@/lib/navigation";

export default function DashboardPage() {
  redirect(signedInLandingPath());
}
