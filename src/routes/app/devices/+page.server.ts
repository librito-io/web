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
    const { error } = await supabase
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
    return { success: true };
  },

  // Action name `unpair` matches the UI's binding vocabulary; the
  // underlying write still sets `devices.revoked_at` because that column
  // tracks token validity (a strict superset of binding state — manual
  // unpair AND server-side token revocation both null out the binding).
  // Keeping the schema column name `revoked_at` is intentional; only
  // the user-visible action name is reconciled here. See #181/#183
  // archeology in CLAUDE.md for the design history.
  unpair: async ({ request, locals: { safeGetSession, supabase } }) => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const deviceId = formData.get("deviceId");

    if (!deviceId || typeof deviceId !== "string")
      return fail(400, { error: "Device ID is required" });

    // .is("revoked_at", null) collapses three cases into the same 404:
    // device id doesn't exist, device belongs to another user, or device
    // is already unpaired. Aligns with the load query's filter so the
    // "unpair an already-unpaired row" code path doesn't refresh
    // revoked_at (also enforced at the DB layer by trigger
    // devices_prevent_unrevoke, but cheap to fast-path here).
    const { error } = await supabase
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .select("id")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return fail(404, { error: "Device not found" });
      return fail(500, { error: "Failed to unpair device" });
    }
    return { success: true };
  },
};
