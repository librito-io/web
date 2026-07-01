import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SafeOutcome, LimitResult } from "../../src/lib/server/ratelimit";

vi.mock("$env/dynamic/private", () => ({ env: {} }));

// Mirrors fullLimitResult() in tests/lib/ratelimit.test.ts — only
// `success` matters for this action's branching.
function limitResult(success: boolean): LimitResult {
  return {
    success,
    limit: 3,
    remaining: success ? 2 : 0,
    reset: Date.now() + 3_600_000,
    pending: Promise.resolve(),
  } as LimitResult;
}

const { safeLimit } = vi.hoisted(() => ({
  safeLimit: vi.fn<() => Promise<SafeOutcome>>(),
}));
vi.mock("$lib/server/ratelimit", () => ({
  safeLimit,
  contactLimiter: { failMode: "closed", label: "rl:contact:ip" },
}));

const { sendContactEmail } = vi.hoisted(() => ({
  sendContactEmail: vi.fn(async () => true),
}));
vi.mock("$lib/server/email", () => ({ sendContactEmail }));

import { actions } from "../../src/routes/support/+page.server";

function submit(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return (actions as never as { contact: Function }).contact({
    request: { formData: async () => fd },
    getClientAddress: () => "1.2.3.4",
  });
}

describe("support ?/contact action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeLimit.mockResolvedValue({ kind: "ok", result: limitResult(true) });
  });

  it("sends the email and returns ok on a valid submit", async () => {
    const res = await submit({
      email: "v@example.com",
      message: "Help please",
    });
    expect(res).toEqual({ ok: true });
    expect(sendContactEmail).toHaveBeenCalledWith(
      "v@example.com",
      "Help please",
    );
  });

  it("silently succeeds without sending when the honeypot is filled", async () => {
    const res = await submit({
      email: "bot@example.com",
      message: "spam",
      company: "AcmeBot",
    });
    expect(res).toEqual({ ok: true });
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("returns a 400 fail on invalid input", async () => {
    const res: any = await submit({ email: "nope", message: "" });
    expect(res.status).toBe(400);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("returns a 503 fail when the limiter is fail-closed down", async () => {
    safeLimit.mockResolvedValue({ kind: "failClosed", label: "rl:contact:ip" });
    const res: any = await submit({ email: "v@example.com", message: "hi" });
    expect(res.status).toBe(503);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("returns a 429 fail when rate limited", async () => {
    safeLimit.mockResolvedValue({ kind: "ok", result: limitResult(false) });
    const res: any = await submit({ email: "v@example.com", message: "hi" });
    expect(res.status).toBe(429);
    expect(sendContactEmail).not.toHaveBeenCalled();
  });

  it("returns a 502 fail when email delivery fails, without hiding that it tried", async () => {
    sendContactEmail.mockResolvedValueOnce(false);
    const res: any = await submit({
      email: "v@example.com",
      message: "hi",
    });
    expect(res.status).toBe(502);
    expect(sendContactEmail).toHaveBeenCalledWith("v@example.com", "hi");
  });
});
