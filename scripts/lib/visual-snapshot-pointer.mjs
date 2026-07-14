export async function advanceVisualSnapshotPointer(supabase, {
  existing = null,
  snapshot,
} = {}) {
  if (!supabase || typeof supabase.rpc !== "function") {
    throw new TypeError("Supabase client with rpc() is required.");
  }
  const { data, error } = await supabase.rpc(
    "advance_shared_award_visual_snapshot",
    {
      p_expected_exists: Boolean(existing),
      p_expected_updated_at: existing?.updated_at || null,
      p_snapshot: snapshot,
    },
  );
  if (error) throw new Error(`Advance visual snapshot pointer failed: ${error.message}`);
  return data === true;
}
