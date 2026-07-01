import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: {} }));

// Limiter: allow by default (fail-closed path is covered in ratelimit unit tests).
const { enforceRateLimit } = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(async (): Promise<Response | null> => null),
}));
vi.mock("$lib/server/ratelimit", () => ({
  enforceRateLimit,
  newsletterLimiter: { failMode: "closed", label: "rl:newsletter:ip" },
}));

const { processNewsletterSignup } = vi.hoisted(() => ({
  processNewsletterSignup: vi.fn(async () => ({ fresh: true })),
}));
vi.mock("$lib/server/newsletter", async () => {
  const actual = await vi.importActual<typeof import("$lib/server/newsletter")>(
    "$lib/server/newsletter",
  );
  return { ...actual, processNewsletterSignup };
});

const { sendNewsletterWelcome } = vi.hoisted(() => ({
  sendNewsletterWelcome: vi.fn(async () => {}),
}));
vi.mock("$lib/server/email", () => ({ sendNewsletterWelcome }));

vi.mock("$lib/server/supabase", () => ({ createAdminClient: () => ({}) }));

import { POST } from "../../src/routes/api/newsletter/+server";

function post(body: unknown) {
  return POST({
    request: new Request("http://localhost/api/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    getClientAddress: () => "1.2.3.4",
  } as never);
}

describe("POST /api/newsletter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimit.mockResolvedValue(null);
    processNewsletterSignup.mockResolvedValue({ fresh: true });
  });

  it("subscribes a valid email and sends welcome on fresh insert", async () => {
    const res = await post({ email: "New@Example.com", locale: "en" });
    expect(res.status).toBe(200);
    expect(processNewsletterSignup).toHaveBeenCalledOnce();
    expect(sendNewsletterWelcome).toHaveBeenCalledWith("new@example.com");
  });

  it("does NOT resend welcome when the email already existed", async () => {
    processNewsletterSignup.mockResolvedValue({ fresh: false });
    const res = await post({ email: "dup@example.com" });
    expect(res.status).toBe(200);
    expect(sendNewsletterWelcome).not.toHaveBeenCalled();
  });

  it("silently succeeds and skips work when the honeypot is filled", async () => {
    const res = await post({ email: "bot@example.com", company: "AcmeBot" });
    expect(res.status).toBe(200);
    expect(processNewsletterSignup).not.toHaveBeenCalled();
    expect(sendNewsletterWelcome).not.toHaveBeenCalled();
  });

  it("rejects a malformed email with 400", async () => {
    const res = await post({ email: "nope" });
    expect(res.status).toBe(400);
    expect(processNewsletterSignup).not.toHaveBeenCalled();
  });

  it("returns the limiter response when rate limited", async () => {
    enforceRateLimit.mockResolvedValue(new Response("nope", { status: 429 }));
    const res = await post({ email: "a@b.co" });
    expect(res.status).toBe(429);
    expect(processNewsletterSignup).not.toHaveBeenCalled();
  });
});
