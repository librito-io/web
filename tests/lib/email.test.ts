import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock $env/dynamic/private before importing email.ts
vi.mock("$env/dynamic/private", () => ({
  env: { RESEND_API_KEY: "test-key" },
}));

// Mock the resend module before importing email.ts
vi.mock("resend", () => {
  const mockSend = vi
    .fn()
    .mockResolvedValue({ data: { id: "test-id" }, error: null });
  return {
    // Regular function (not arrow) so `new Resend()` is constructable —
    // vitest 4 invokes a mock's implementation with `new` when the mock is
    // called with `new`, and arrow functions throw "is not a constructor".
    Resend: vi.fn().mockImplementation(function () {
      return { emails: { send: mockSend } };
    }),
  };
});

// Must import after mock setup
import {
  sendWelcomeEmail,
  sendContactEmail,
  sendNewsletterWelcome,
  _getResendClient,
} from "$lib/server/email";

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

  it("strips injected payloads from a malicious siteUrl", async () => {
    await sendWelcomeEmail(
      "user@example.com",
      'https://evil.com"><script>alert(1)</script>',
    );

    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    // safeSiteUrl rejects unparseable URLs (the embedded `">` makes WHATWG
    // URL throw) and falls back to the canonical origin.
    expect(call.html).not.toContain("<script>alert(1)</script>");
    expect(call.html).not.toContain("evil.com");
    expect(call.html).toContain("https://librito.io/app");
  });

  it("strips path/query/fragment from a parseable but extended siteUrl", async () => {
    // A parseable URL with a path — safeSiteUrl returns origin only, so
    // any future template that drops siteUrl into an attribute can't be
    // pivoted via path/query injection.
    await sendWelcomeEmail(
      "user@example.com",
      "https://attacker.example/some/path?q=1#frag",
    );

    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.html).toContain("https://attacker.example/app");
    expect(call.html).not.toContain("/some/path");
    expect(call.html).not.toContain("?q=1");
    expect(call.html).not.toContain("#frag");
  });

  it("falls back to canonical site URL when given an unparseable siteUrl", async () => {
    await sendWelcomeEmail("user@example.com", "not a url at all");

    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.html).toContain("https://librito.io/app");
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

describe("sendContactEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("relays to support@ with Reply-To set to the submitter", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");

    await sendContactEmail("visitor@example.com", "Hello, I need help.");

    expect(client.emails.send).toHaveBeenCalledOnce();
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.from).toBe("Librito <noreply@librito.io>");
    expect(call.to).toBe("support@librito.io");
    expect(call.replyTo).toBe("visitor@example.com");
    expect(call.subject).toContain("support");
    expect(String(call.html)).toContain("Hello, I need help.");
  });

  it("escapes HTML in the submitted message", async () => {
    await sendContactEmail("v@example.com", "<script>alert(1)</script>");
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(String(call.html)).not.toContain("<script>alert(1)</script>");
    expect(String(call.html)).toContain("&lt;script&gt;");
  });

  it("does not throw on send failure", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    vi.mocked(client.emails.send).mockRejectedValueOnce(new Error("down"));
    await expect(
      sendContactEmail("v@example.com", "hi"),
    ).resolves.toBeUndefined();
  });
});

describe("sendNewsletterWelcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a thank-you to the subscriber", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");

    await sendNewsletterWelcome("sub@example.com");

    const call = vi.mocked(client.emails.send).mock.calls[0][0];
    expect(call.from).toBe("Librito <noreply@librito.io>");
    expect(call.to).toBe("sub@example.com");
    expect(call.subject).toContain("signing up");
  });

  it("does not throw on send failure", async () => {
    const client = _getResendClient();
    if (!client) throw new Error("Client should exist in test");
    vi.mocked(client.emails.send).mockRejectedValueOnce(new Error("down"));
    await expect(
      sendNewsletterWelcome("sub@example.com"),
    ).resolves.toBeUndefined();
  });
});
