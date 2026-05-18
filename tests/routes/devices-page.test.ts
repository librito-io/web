// Covers the /app/devices route's rename + revoke actions after the
// migration to RLS-gated writes (issues #129 + #130). The page now uses
// the per-request anon client (`event.locals.supabase`); ownership is
// enforced atomically inside Postgres via the "Users can update own
// devices" UPDATE policy. We unit-test the route's response handling
// here; behavior of the RLS policy itself is covered by the integration
// suite (when it adds a devices-RLS check), not by these tests.

import { describe, it, expect, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

let supabase: ReturnType<typeof createMockSupabase>;

const { load, actions } =
  await import("../../src/routes/app/devices/+page.server");

const USER_ID = "u-1";

function buildLoadEvent(user: { id: string } | null = { id: USER_ID }) {
  const url = new URL("https://example.com/app/devices");
  return {
    locals: {
      supabase,
      safeGetSession: async () => ({ user }),
    },
    url,
    // Required by @sentry/sveltekit's wrapServerLoadWithSentry, which reads
    // event.request.method to populate the http.method span attribute.
    request: new Request(url),
  } as unknown as Parameters<typeof load>[0];
}

function buildActionEvent(
  formEntries: Record<string, string>,
  user: { id: string } | null = { id: USER_ID },
) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(formEntries)) formData.append(k, v);
  return {
    request: new Request("http://x/app/devices", {
      method: "POST",
      body: formData,
    }),
    locals: {
      supabase,
      safeGetSession: async () => ({ user }),
    },
  } as unknown as Parameters<typeof actions.rename>[0];
}

beforeEach(() => {
  supabase = createMockSupabase();
});

describe("load /app/devices", () => {
  it("redirects to /auth/login when unauthenticated", async () => {
    await expect(load(buildLoadEvent(null))).rejects.toMatchObject({
      status: 303,
      location: "/auth/login",
    });
  });

  it("returns the user's non-revoked devices", async () => {
    supabase._results.set("devices.select", {
      data: [{ id: "d-1", name: "Reader", user_id: USER_ID }],
      error: null,
    });
    const result = await load(buildLoadEvent());
    expect(result).toEqual({
      devices: [{ id: "d-1", name: "Reader", user_id: USER_ID }],
    });
  });
});

describe("action rename /app/devices", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-1", name: "New" }, null),
    );
    expect(res).toMatchObject({ status: 401 });
  });

  it("returns 400 when deviceId missing", async () => {
    const res = await actions.rename(buildActionEvent({ name: "New" }));
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 400 when name empty", async () => {
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-1", name: "   " }),
    );
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 400 when name exceeds 50 chars", async () => {
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-1", name: "x".repeat(51) }),
    );
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 404 when the device row does not match user_id (RLS-filtered)", async () => {
    // RLS makes the row invisible; .single() yields PGRST116. Same code
    // path covers "device id doesn't exist" and "device belongs to
    // another user" — the route intentionally conflates them so we
    // don't leak device-id existence across accounts.
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-other", name: "New" }),
    );
    expect(res).toMatchObject({ status: 404 });
  });

  it("returns 404 when the device id does not exist", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-missing", name: "New" }),
    );
    expect(res).toMatchObject({ status: 404 });
  });

  it("renames the device and reports success", async () => {
    supabase._results.set("devices.update", {
      data: { id: "d-1" },
      error: null,
    });
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-1", name: "Reader" }),
    );
    expect(res).toEqual({ success: true });
    expect(supabase._updateCalls).toEqual([
      expect.objectContaining({ table: "devices" }),
    ]);
  });

  it("returns 500 on non-PGRST116 update error", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "42501", message: "permission denied" },
    });
    const res = await actions.rename(
      buildActionEvent({ deviceId: "d-1", name: "Reader" }),
    );
    expect(res).toMatchObject({ status: 500 });
  });
});

describe("action revoke /app/devices", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await actions.revoke(
      buildActionEvent({ deviceId: "d-1" }, null),
    );
    expect(res).toMatchObject({ status: 401 });
  });

  it("returns 400 when deviceId missing", async () => {
    const res = await actions.revoke(buildActionEvent({}));
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 404 when the device row does not match user_id (RLS-filtered)", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.revoke(buildActionEvent({ deviceId: "d-other" }));
    expect(res).toMatchObject({ status: 404 });
  });

  it("revokes the device and reports success", async () => {
    supabase._results.set("devices.update", {
      data: { id: "d-1" },
      error: null,
    });
    const res = await actions.revoke(buildActionEvent({ deviceId: "d-1" }));
    expect(res).toEqual({ success: true });
    expect(supabase._updateCalls).toEqual([
      expect.objectContaining({ table: "devices" }),
    ]);
  });

  it("returns 500 on non-PGRST116 update error", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "23514", message: "check constraint" },
    });
    const res = await actions.revoke(buildActionEvent({ deviceId: "d-1" }));
    expect(res).toMatchObject({ status: 500 });
  });

  it("returns 404 for an already-revoked device (idempotent revoke)", async () => {
    // The route adds .is("revoked_at", null) to the UPDATE chain, so
    // an already-revoked row matches no candidates and PostgREST yields
    // PGRST116 from .single(). Behaviorally indistinguishable from
    // "device id doesn't exist" — both collapse to 404 by design.
    // Backstop at the DB layer is trigger devices_prevent_unrevoke,
    // verified separately in the integration suite.
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.revoke(
      buildActionEvent({ deviceId: "d-already-revoked" }),
    );
    expect(res).toMatchObject({ status: 404 });
  });
});
