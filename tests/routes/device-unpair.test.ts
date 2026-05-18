// tests/routes/device-unpair.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

vi.mock("$lib/server/auth", async () => {
  const { jsonError } = await import("../../src/lib/server/errors");
  return {
    authenticateDevice: vi.fn(async () => ({
      device: { id: "d-1", userId: "u-1" },
    })),
    authErrorResponse: vi.fn((code: string) =>
      jsonError(401, code, `auth:${code}`),
    ),
  };
});

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { POST } = await import("../../src/routes/api/device/unpair/+server");

function buildEvent() {
  return {
    request: new Request("http://x/api/device/unpair", {
      method: "POST",
      headers: { Authorization: "Bearer sk_device_xxx" },
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/device/unpair", () => {
  beforeEach(() => {
    supabase._results.clear();
  });

  it.each(["invalid_token", "token_revoked"] as const)(
    "treats %s as idempotent success without calling authErrorResponse",
    async (errorCode) => {
      const auth = await import("$lib/server/auth");
      (
        auth.authenticateDevice as unknown as {
          mockResolvedValueOnce: (v: unknown) => void;
        }
      ).mockResolvedValueOnce({ error: errorCode });
      (
        auth.authErrorResponse as unknown as { mockClear: () => void }
      ).mockClear();

      const res = await POST(buildEvent());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(auth.authErrorResponse).not.toHaveBeenCalled();
    },
  );

  it("returns 401 via authErrorResponse on missing_token", async () => {
    const auth = await import("$lib/server/auth");
    (
      auth.authenticateDevice as unknown as {
        mockResolvedValueOnce: (v: unknown) => void;
      }
    ).mockResolvedValueOnce({ error: "missing_token" });
    (
      auth.authErrorResponse as unknown as { mockClear: () => void }
    ).mockClear();

    const res = await POST(buildEvent());
    expect(res.status).toBe(401);
    expect(auth.authErrorResponse).toHaveBeenCalledWith("missing_token");
  });

  it("revokes the device on success", async () => {
    supabase._results.set("devices.update", { data: null, error: null });
    const res = await POST(buildEvent());
    expect(res.status).toBe(200);
    expect(supabase._updateCalls).toEqual([
      expect.objectContaining({ table: "devices" }),
    ]);
  });
});
