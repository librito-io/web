// resolveReturnTo validates the ?return_to= query param /auth/login
// receives from the appAuthGuard hook (issue #349). The param is
// attacker-controllable end-to-end (any link can ship a forged value),
// so validation at the consumer is mandatory — open-redirect (CWE-601)
// is the failure mode. Allow-list semantics: same-origin /app/* paths
// only; anything else falls back to /app.

import { describe, it, expect } from "vitest";
import { resolveReturnTo } from "../../src/lib/auth/return-to";

describe("resolveReturnTo", () => {
  it.each([
    ["/app", "/app"],
    ["/app/", "/app/"],
    ["/app/devices", "/app/devices"],
    ["/app/book/abc123", "/app/book/abc123"],
    ["/app/book/abc?sort=recent", "/app/book/abc?sort=recent"],
    [encodeURIComponent("/app/book/abc123"), "/app/book/abc123"],
    [
      encodeURIComponent("/app/book/abc?sort=recent"),
      "/app/book/abc?sort=recent",
    ],
  ])("accepts %s → %s", (input, expected) => {
    expect(resolveReturnTo(input)).toBe(expected);
  });

  it.each([
    ["null input", null],
    ["undefined input", undefined],
    ["empty string", ""],
    // Protocol-relative — most dangerous; bypasses naive scheme checks.
    ["protocol-relative //evil.com", "//evil.com"],
    ["protocol-relative //evil.com/path", "//evil.com/path"],
    ["explicit https://attacker.com", "https://attacker.com"],
    ["explicit http://attacker.com", "http://attacker.com"],
    // Backslash smuggling — some browsers normalize \ → /.
    ["backslash \\\\evil.com", "\\\\evil.com"],
    ["mixed /app/\\\\evil.com", "/app/\\\\evil.com"],
    // Other route prefixes — only /app/* is gated, others must not echo back.
    ["/auth/login", "/auth/login"],
    ["/auth/signup", "/auth/signup"],
    ["/api/sync", "/api/sync"],
    ["/", "/"],
    // Bare hostname without scheme.
    ["evil.com", "evil.com"],
    // Malformed percent encoding — decodeURIComponent throws.
    ["%E0%A4%A", "%E0%A4%A"],
  ])("falls back to /app for %s", (_label, input) => {
    expect(resolveReturnTo(input)).toBe("/app");
  });

  it("does NOT accept /app prefix without /app/ trailing (prevents /appfoo bypass)", () => {
    // Without the trailing slash check, `/appfoo` and `/app-attacker`
    // would both startsWith("/app") and slip past.
    expect(resolveReturnTo("/appfoo")).toBe("/app");
    expect(resolveReturnTo("/app-attacker")).toBe("/app");
  });
});
