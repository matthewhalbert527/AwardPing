import { redirect } from "next/navigation";

export default function ToolsRedirectPage() {
  redirect("/dashboard/awards?view=request");
}
