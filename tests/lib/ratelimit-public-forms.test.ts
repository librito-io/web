import { describe, it, expect, vi } from "vitest";

// ratelimit.ts reads Upstash env at module load — mock it so import succeeds.
vi.mock("$env/dynamic/private", () => ({
  env: {
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
  },
}));

import { contactLimiter, newsletterLimiter } from "$lib/server/ratelimit";

describe("public-form limiters", () => {
  it("contactLimiter is fail-closed with an rl: prefix", () => {
    expect(contactLimiter.failMode).toBe("closed");
    expect(contactLimiter.label).toBe("contact:ip");
  });

  it("newsletterLimiter is fail-closed with an rl: prefix", () => {
    expect(newsletterLimiter.failMode).toBe("closed");
    expect(newsletterLimiter.label).toBe("newsletter:ip");
  });
});
