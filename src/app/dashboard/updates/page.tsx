import { redirect } from "next/navigation";

export default function UpdatesRedirectPage() {
  redirect("/dashboard?scope=all");
}
