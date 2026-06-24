import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_SITE_URL: "" } }));
const { sendWelcomeEmail } = vi.hoisted(() => ({
  sendWelcomeEmail: vi.fn(async () => {}),
}));
vi.mock("$lib/server/email", () => ({ sendWelcomeEmail }));

import { GET } from "../../src/routes/auth/callback/+server";

function makeEvent(search: string, auth: Record<string, unknown>) {
  return {
    url: new URL(`http://localhost${search}`),
    locals: { supabase: { auth } },
  } as never;
}

beforeEach(() => sendWelcomeEmail.mockClear());

describe("/auth/callback", () => {
  it("redirects to login when no code present", async () => {
    await expect(GET(makeEvent("/auth/callback", {}))).rejects.toMatchObject({
      status: 303,
      location: "/auth/login",
    });
  });

  it("maps a signups-disabled provider error to a friendly login redirect", async () => {
    await expect(
      GET(
        makeEvent(
          "/auth/callback?error=server_error&error_description=Signups+not+allowed",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: "/auth/login?error=signup_disabled",
    });
  });

  it("maps a user-cancel error to a friendly login redirect", async () => {
    await expect(
      GET(makeEvent("/auth/callback?error=access_denied", {})),
    ).rejects.toMatchObject({
      status: 303,
      location: "/auth/login?error=cancelled",
    });
  });

  it("redirects to a validated return_to on success", async () => {
    const auth = {
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
      getUser: vi.fn(async () => ({
        data: { user: { email: "u@e.com", email_confirmed_at: null } },
      })),
    };
    await expect(
      GET(
        makeEvent("/auth/callback?code=abc&return_to=%2Fapp%2Flibrary", auth),
      ),
    ).rejects.toMatchObject({ status: 303, location: "/app/library" });
  });

  it("falls back to /app when return_to is forged", async () => {
    const auth = {
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
      getUser: vi.fn(async () => ({
        data: { user: { email: "u@e.com", email_confirmed_at: null } },
      })),
    };
    await expect(
      GET(
        makeEvent(
          "/auth/callback?code=abc&return_to=https%3A%2F%2Fevil.com",
          auth,
        ),
      ),
    ).rejects.toMatchObject({ status: 303, location: "/app" });
  });

  it("redirects to link_expired when code exchange fails", async () => {
    const auth = {
      exchangeCodeForSession: vi.fn(async () => ({
        error: { message: "bad" },
      })),
    };
    await expect(
      GET(makeEvent("/auth/callback?code=stale", auth)),
    ).rejects.toMatchObject({
      status: 303,
      location: "/auth/login?error=link_expired",
    });
  });

  it("fires the welcome email for a fresh OAuth user then redirects", async () => {
    const auth = {
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
      getUser: vi.fn(async () => ({
        data: {
          user: {
            email: "new@e.com",
            email_confirmed_at: new Date().toISOString(),
          },
        },
      })),
    };
    await expect(
      GET(makeEvent("/auth/callback?code=abc", auth)),
    ).rejects.toMatchObject({ status: 303, location: "/app" });
    expect(sendWelcomeEmail).toHaveBeenCalledWith(
      "new@e.com",
      "https://librito.io",
    );
  });

  it("maps unknown provider errors to oauth_failed", async () => {
    await expect(
      GET(
        makeEvent(
          "/auth/callback?error=temporarily_unavailable&error_description=Service+is+down",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: "/auth/login?error=oauth_failed",
    });
  });

  it("does not map bare 'signup' word in description to signup_disabled", async () => {
    await expect(
      GET(
        makeEvent(
          "/auth/callback?error=server_error&error_description=Unexpected+failure+during+signup+step",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: "/auth/login?error=oauth_failed",
    });
  });
});
