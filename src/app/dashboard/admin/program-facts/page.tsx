import { redirect } from "next/navigation";

// Previous private reviews remain retained; the owner's workflow is alert review.
export default function AdminProgramFactsPage() {
  redirect("/dashboard/admin/issues");
}
