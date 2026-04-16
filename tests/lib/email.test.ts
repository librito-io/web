import { describe, it, expect, vi, beforeEach } from "vitest";

// Set env var before module is imported so getClient() returns a client
process.env.RESEND_API_KEY = "test-key";

// Mock the resend module before importing email.ts
vi.mock("resend", () => {
  const mockSend = vi
    .fn()
    .mockResolvedValue({ data: { id: "test-id" }, error: null });
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: { send: mockSend },
    })),
  };
});

// Must import after mock setup
import { sendWelcomeEmail, _getResendClient } from "$lib/server/email";
import { Resend } from "resend";

describe("sendWelcomeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls resend.emails.send with correct params", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");

    await sendWelcomeEmail("user@example.com", "https://librito.io");

    expect(client.emails.send).toHaveBeenCalledOnce();
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.to).toBe("user@example.com");
    expect(call.from).toBe("Librito <noreply@librito.io>");
    expect(call.subject).toBe("Welcome to Librito");
    expect(call.html).toContain("https://librito.io/app");
  });

  it("replaces APP_URL placeholder in template", async () => {
    await sendWelcomeEmail("user@example.com", "https://custom.example.com");

    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.html).toContain("https://custom.example.com/app");
    expect(call.html).not.toContain("{{APP_URL}}");
  });

  it("does not throw on send failure", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    vi.mocked(client.emails.send).mockRejectedValueOnce(new Error("SMTP down"));

    // Should not throw — welcome email is best-effort
    await expect(
      sendWelcomeEmail("user@example.com", "https://librito.io"),
    ).resolves.toBeUndefined();
  });
});
