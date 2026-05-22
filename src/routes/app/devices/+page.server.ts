import { fail, type ActionFailure } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";

// Explicit per-action return shape. Without this, TS's subtype-reduction
// of `ActionFailure<T>` unions in the `Actions: Actions` annotation
// collapses every `fail()` data shape into the first one's `T`, losing
// the `action`/`deviceId` echo fields the UI uses to scope error display.
// Keeping a narrow union here also keeps the page-level `form` prop
// type useful for `"action" in form` narrows in the template.
type DeviceActionResult =
  | { success: true }
  | ActionFailure<{ error: string }>
  | ActionFailure<{
      action: "rename" | "unpair";
      deviceId: string | null;
      error: string;
    }>;

export const load: PageServerLoad = async ({
  parent,
  locals: { supabase },
}) => {
  const { user } = await parent();

  // .limit(50) bounds the SSR payload defensively. Typical users have a
  // handful of devices, but no schema-level cap exists, so a runaway
  // automation or test loop could otherwise return unbounded rows
  // (issue #133).
  const { data: devices } = await supabase
    .from("devices")
    .select(
      "id, name, hardware_id, last_synced_at, created_at, paired_at, revoked_at",
    )
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("paired_at", { ascending: false })
    .limit(50);

  return { devices: devices ?? [] };
};

export const actions: Actions = {
  rename: async ({
    request,
    locals: { safeGetSession, supabase },
  }): Promise<DeviceActionResult> => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const rawDeviceId = formData.get("deviceId");
    const deviceId = typeof rawDeviceId === "string" ? rawDeviceId : null;
    const rawName = formData.get("name");
    const name = typeof rawName === "string" ? rawName.trim() : "";

    // deviceId is echoed back in every fail() payload so the client can
    // scope per-row error display under the matching device <li>; the
    // page's `form` prop is page-wide, so without this the same error
    // would render under every device's rename form on a re-render.
    if (!deviceId || !name)
      return fail(400, {
        action: "rename",
        deviceId,
        error: "Device ID and name are required",
      });
    if (name.length > 50)
      return fail(400, {
        action: "rename",
        deviceId,
        error: "Name must be 50 characters or less",
      });

    // Atomic ownership UPDATE: RLS WITH CHECK enforces user_id = auth.uid();
    // the explicit .eq("user_id", user.id) predicate is kept as
    // defense-in-depth so a future RLS regression cannot widen the blast
    // radius on its own. .is("revoked_at", null) mirrors the load query's
    // filter so a row revoked between page load and Save (sibling tab
    // unpair, admin revoke) yields PGRST116 → 404 rather than silently
    // succeeding into a row that's about to disappear from the list.
    // PGRST116 = "no rows" from .single() collapses three cases into the
    // same 404: device id doesn't exist, belongs to another user, or is
    // already revoked — intentional, to avoid leaking existence.
    const { error } = await supabase
      .from("devices")
      .update({ name })
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .select("id")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return fail(404, {
          action: "rename",
          deviceId,
          error: "Device not found",
        });
      return fail(500, {
        action: "rename",
        deviceId,
        error: "Failed to rename device",
      });
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
  unpair: async ({
    request,
    locals: { safeGetSession, supabase },
  }): Promise<DeviceActionResult> => {
    const { user } = await safeGetSession();
    if (!user) return fail(401, { error: "Not authenticated" });

    const formData = await request.formData();
    const rawDeviceId = formData.get("deviceId");
    const deviceId = typeof rawDeviceId === "string" ? rawDeviceId : null;

    if (!deviceId)
      return fail(400, {
        action: "unpair",
        deviceId,
        error: "Device ID is required",
      });

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
        return fail(404, {
          action: "unpair",
          deviceId,
          error: "Device not found",
        });
      return fail(500, {
        action: "unpair",
        deviceId,
        error: "Failed to unpair device",
      });
    }
    return { success: true };
  },
};
