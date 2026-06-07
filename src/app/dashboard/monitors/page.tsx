import { redirect } from "next/navigation";

export default function MonitorsRedirectPage() {
  redirect("/dashboard/awards?view=request");
}
