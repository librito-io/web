import { fail, redirect } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({
  locals: { safeGetSession, supabase },
}) => {
  const { user } = await safeGetSession();
  if (!user) redirect(303, "/auth/login");

  const { data: devices } = await supabase
    .from("devices")
    .select(
      "id, name, hardware_id, last_synced_at, created_at, paired_at, revoked_at",
    )
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("paired_at", { ascending: false });

  return { devices: devices ?? [] };
};

export const actions: Actions = {
  rename: async ({ request, locals: { safeGetSession, supabase } }) => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const deviceId = formData.get("deviceId");
    const name =
      typeof formData.get("name") === "string"
        ? (formData.get("name") as string).trim()
        : "";

    if (!deviceId || typeof deviceId !== "string" || !name)
      return fail(400, { error: "Device ID and name are required" });
    if (name.length > 50)
      return fail(400, { error: "Name must be 50 characters or less" });

    // Atomic ownership UPDATE: RLS WITH CHECK enforces user_id = auth.uid();
    // the explicit .eq("user_id", user.id) predicate is kept as
    // defense-in-depth so a future RLS regression cannot widen the blast
    // radius on its own. PGRST116 = "no rows" from .single(), which here
    // means the device id doesn't exist OR belongs to another user; we
    // collapse both into a 404 to avoid leaking existence.
    const { data, error } = await supabase
      .from("devices")
      .update({ name })
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .select("id")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return fail(404, { error: "Device not found" });
      return fail(500, { error: "Failed to rename device" });
    }
    if (!data) return fail(404, { error: "Device not found" });
    return { success: true };
  },

  revoke: async ({ request, locals: { safeGetSession, supabase } }) => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const deviceId = formData.get("deviceId");

    if (!deviceId || typeof deviceId !== "string")
      return fail(400, { error: "Device ID is required" });

    const { data, error } = await supabase
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .select("id")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return fail(404, { error: "Device not found" });
      return fail(500, { error: "Failed to revoke device" });
    }
    if (!data) return fail(404, { error: "Device not found" });
    return { success: true };
  },
};
