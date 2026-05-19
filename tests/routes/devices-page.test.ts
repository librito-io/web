// Covers the /app/devices route's rename + unpair actions after the
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
    // Predicate assertions: the load query must scope by user_id, hide
    // revoked rows, and order by paired_at desc. A silent drop of any of
    // these would leak other users' devices, surface revoked entries to
    // the UI, or scramble the displayed order — none of which would
    // otherwise fail this suite.
    const selectChain = supabase._chainCalls.filter(
      (c) => c.table === "devices" && c.operation === "select",
    );
    expect(selectChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "eq",
          args: ["user_id", USER_ID],
        }),
        expect.objectContaining({
          method: "is",
          args: ["revoked_at", null],
        }),
        expect.objectContaining({
          method: "order",
          args: ["paired_at", { ascending: false }],
        }),
      ]),
    );
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
      { table: "devices", payload: { name: "Reader" } },
    ]);
    // Predicate assertions: the UPDATE must scope by id AND user_id.
    // The .eq("user_id", user.id) clause is documented as
    // defense-in-depth against a future RLS regression — silent removal
    // would widen the blast radius without failing this suite otherwise.
    const updateChain = supabase._chainCalls.filter(
      (c) => c.table === "devices" && c.operation === "update",
    );
    expect(updateChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "eq",
          args: ["id", "d-1"],
        }),
        expect.objectContaining({
          method: "eq",
          args: ["user_id", USER_ID],
        }),
      ]),
    );
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

describe("action unpair /app/devices", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await actions.unpair(
      buildActionEvent({ deviceId: "d-1" }, null),
    );
    expect(res).toMatchObject({ status: 401 });
  });

  it("returns 400 when deviceId missing", async () => {
    const res = await actions.unpair(buildActionEvent({}));
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 404 when the device row does not match user_id (RLS-filtered)", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.unpair(buildActionEvent({ deviceId: "d-other" }));
    expect(res).toMatchObject({ status: 404 });
  });

  it("unpairs the device and reports success", async () => {
    supabase._results.set("devices.update", {
      data: { id: "d-1" },
      error: null,
    });
    const res = await actions.unpair(buildActionEvent({ deviceId: "d-1" }));
    expect(res).toEqual({ success: true });
    // Payload must carry an ISO-formatted revoked_at timestamp. A bug
    // that wrote the wrong shape (e.g. `null`, a Date object, an empty
    // string) would still satisfy a table-only assertion.
    expect(supabase._updateCalls).toHaveLength(1);
    const [call] = supabase._updateCalls;
    expect(call.table).toBe("devices");
    const payload = call.payload as { revoked_at: string };
    expect(typeof payload.revoked_at).toBe("string");
    expect(payload.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Predicate assertions: id + user_id scoping, plus the
    // .is("revoked_at", null) guard that makes unpair idempotent
    // (already-unpaired rows hit no candidates → PGRST116 → 404, rather
    // than refreshing the timestamp).
    const updateChain = supabase._chainCalls.filter(
      (c) => c.table === "devices" && c.operation === "update",
    );
    expect(updateChain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "eq",
          args: ["id", "d-1"],
        }),
        expect.objectContaining({
          method: "eq",
          args: ["user_id", USER_ID],
        }),
        expect.objectContaining({
          method: "is",
          args: ["revoked_at", null],
        }),
      ]),
    );
  });

  it("returns 500 on non-PGRST116 update error", async () => {
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "23514", message: "check constraint" },
    });
    const res = await actions.unpair(buildActionEvent({ deviceId: "d-1" }));
    expect(res).toMatchObject({ status: 500 });
  });

  it("returns 404 for an already-unpaired device (idempotent unpair)", async () => {
    // The route adds .is("revoked_at", null) to the UPDATE chain, so
    // an already-unpaired row matches no candidates and PostgREST yields
    // PGRST116 from .single(). Behaviorally indistinguishable from
    // "device id doesn't exist" — both collapse to 404 by design.
    // Backstop at the DB layer is trigger devices_prevent_unrevoke,
    // verified separately in the integration suite.
    supabase._results.set("devices.update", {
      data: null,
      error: { code: "PGRST116" },
    });
    const res = await actions.unpair(
      buildActionEvent({ deviceId: "d-already-revoked" }),
    );
    expect(res).toMatchObject({ status: 404 });
  });
});
