// tests/routes/pair-claim.test.ts
//
// Wiring guarantees the unit-tested business logic in
// src/lib/server/pairing.ts cannot enforce alone:
//
// 1. The route MUST forward the email from the server-validated session,
//    not from the request body. A future refactor that reads `body.email`
//    would let a malicious browser display any email on the device's
//    pairing-confirmation screen — security-adjacent UX.
// 2. Missing session emails (phone-only / OAuth-without-email-scope) flow
//    through as `null`, not as the empty string. The single NULL → ""
//    conversion lives in pairing.ts:checkPairingStatus.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/server/pairing", () => ({
  claimPairingCode: vi.fn(async () => ({
    deviceId: "device-uuid",
    deviceName: "Librito",
  })),
}));

vi.mock("$lib/server/ratelimit", async () => {
  const { passThroughSafeLimit } = await import("../helpers");
  return {
    redis: {},
    pairClaimLimiter: {
      limit: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
    },
    safeLimit: passThroughSafeLimit,
  };
});

vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => ({}),
}));

const { POST } = await import("../../src/routes/api/pair/claim/+server");
const { claimPairingCode } = await import("$lib/server/pairing");
const claimSpy = claimPairingCode as unknown as ReturnType<typeof vi.fn>;

function buildEvent(
  body: unknown,
  user: { id: string; email?: string } | null,
) {
  return {
    request: new Request("http://x/api/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: {
      safeGetSession: async () => ({ user }),
    },
    getClientAddress: () => "203.0.113.7",
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/pair/claim — session-email wiring", () => {
  beforeEach(() => {
    claimSpy.mockClear();
    claimSpy.mockResolvedValue({
      deviceId: "device-uuid",
      deviceName: "Librito",
    });
  });

  it("forwards user.email from the session, ignoring any body-supplied email", async () => {
    const res = await POST(
      buildEvent(
        { code: "482901", email: "attacker@example.com" },
        { id: "user-uuid", email: "real@example.com" },
      ),
    );

    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        userId: "user-uuid",
        userEmail: "real@example.com",
        code: "482901",
      },
    );
  });

  it("passes userEmail as null when the session user has no email (phone/OAuth-no-email)", async () => {
    const res = await POST(buildEvent({ code: "482901" }, { id: "user-uuid" }));

    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        userId: "user-uuid",
        userEmail: null,
        code: "482901",
      },
    );
  });

  it("returns 401 when the session has no user", async () => {
    const res = await POST(buildEvent({ code: "482901" }, null));
    expect(res.status).toBe(401);
    expect(claimSpy).not.toHaveBeenCalled();
  });
});
