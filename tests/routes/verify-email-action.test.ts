import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_SITE_URL: "" } }));
const { sendWelcomeEmail } = vi.hoisted(() => ({
  sendWelcomeEmail: vi.fn(async () => {}),
}));
vi.mock("$lib/server/email", () => ({ sendWelcomeEmail }));

import { actions } from "../../src/routes/auth/verify-email/+page.server";

function makeEvent(
  form: Record<string, string>,
  auth: Record<string, unknown>,
) {
  const data = new Map(Object.entries(form));
  return {
    request: {
      formData: async () => ({ get: (k: string) => data.get(k) ?? null }),
    },
    locals: { supabase: { auth } },
  } as never;
}

beforeEach(() => sendWelcomeEmail.mockClear());

describe("verify-email default action", () => {
  it("verifies the OTP, sends the welcome email, redirects to /app", async () => {
    const verifyOtp = vi.fn(async () => ({
      data: { user: { email: "new@e.com" } },
      error: null,
    }));
    await expect(
      actions.default(
        makeEvent({ email: "new@e.com", token: "123456" }, { verifyOtp }),
      ),
    ).rejects.toMatchObject({ status: 303, location: "/app" });
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "new@e.com",
      token: "123456",
      type: "signup",
    });
    expect(sendWelcomeEmail).toHaveBeenCalledWith(
      "new@e.com",
      "https://librito.io",
    );
  });

  it("returns a 400 fail on an invalid code (no welcome email)", async () => {
    const verifyOtp = vi.fn(async () => ({
      data: { user: null },
      error: { message: "Token has expired or is invalid" },
    }));
    const result = await actions.default(
      makeEvent({ email: "new@e.com", token: "000000" }, { verifyOtp }),
    );
    expect(result).toMatchObject({
      status: 400,
      data: { message: "Token has expired or is invalid" },
    });
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("returns a 400 fail when email or token is missing", async () => {
    const verifyOtp = vi.fn();
    const result = await actions.default(
      makeEvent({ email: "new@e.com" }, { verifyOtp }),
    );
    expect(result).toMatchObject({ status: 400 });
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});
