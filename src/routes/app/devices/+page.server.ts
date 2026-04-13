import { fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import { createAdminClient } from "$lib/server/supabase";

export const load: PageServerLoad = async ({ locals: { safeGetSession } }) => {
  const { user } = await safeGetSession();
  if (!user) return { devices: [] };

  const supabase = createAdminClient();
  const { data: devices } = await supabase
    .from("devices")
    .select("id, name, hardware_id, last_synced_at, created_at, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  return { devices: devices ?? [] };
};

export const actions: Actions = {
  rename: async ({ request, locals: { safeGetSession } }) => {
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

    const supabase = createAdminClient();

    // Verify device belongs to user
    const { data: device } = await supabase
      .from("devices")
      .select("id")
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .single();

    if (!device) return fail(404, { error: "Device not found" });

    const { error } = await supabase
      .from("devices")
      .update({ name })
      .eq("id", deviceId);

    if (error) return fail(500, { error: "Failed to rename device" });
    return { success: true };
  },

  revoke: async ({ request, locals: { safeGetSession } }) => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const deviceId = formData.get("deviceId");

    if (!deviceId || typeof deviceId !== "string")
      return fail(400, { error: "Device ID is required" });

    const supabase = createAdminClient();

    // Verify device belongs to user
    const { data: device } = await supabase
      .from("devices")
      .select("id")
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .single();

    if (!device) return fail(404, { error: "Device not found" });

    const { error } = await supabase
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", deviceId);

    if (error) return fail(500, { error: "Failed to revoke device" });
    return { success: true };
  },
};
