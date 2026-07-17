import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { requireOfficeContext } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = {
  params: Promise<{ id: string }>;
};

export default async function PipelineAwardRedirectPage({ params }: Params) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) redirect("/award-directory");

  const user = await requireUser();
  const officeContext = await requireOfficeContext(user);
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: award } = await supabase
    .from("awards")
    .select("shared_award_id")
    .eq("id", id)
    .eq("office_id", officeContext.current.officeId)
    .maybeSingle();

  if (award?.shared_award_id) {
    // The authenticated query above proves office ownership. Mutable shared
    // catalog tables are intentionally service-only after the Stage 1 gate.
    const admin = createSupabaseAdminClient();
    const { data: sharedAward } = await admin
      .from("shared_awards")
      .select("id, name, slug")
      .eq("id", award.shared_award_id)
      .eq("status", "active")
      .maybeSingle();

    if (sharedAward) {
      redirect(dashboardAwardPath(sharedAward.slug, sharedAward.name, sharedAward.id));
    }

    redirect("/award-directory");
  }

  redirect("/award-directory");
}
