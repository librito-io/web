import { describe, it, expect, vi } from "vitest";

vi.mock("$env/static/private", () => ({
  UPSTASH_REDIS_REST_URL: "https://mock.upstash.example",
  UPSTASH_REDIS_REST_TOKEN: "mock-token",
}));

import {
  pairRequestLimiter,
  pairStatusLimiter,
  pairClaimLimiter,
  syncLimiter,
  transferUploadLimiter,
  transferDownloadLimiter,
  transferConfirmLimiter,
  transferRetryLimiter,
  realtimeTokenLimiter,
  realtimeTokenUserLimiter,
} from "$lib/server/ratelimit";

describe("rate-limit policy snapshot", () => {
  // This test locks the per-limiter failMode table from
  // docs/superpowers/specs/2026-05-01-ratelimit-fail-mode-policy-design.md.
  // Failing this test forces a deliberate update with PR-review eyes on
  // the change. Do not flip any value to make the test pass without
  // updating the design doc and getting review on the security
  // implication.
  it("locks per-limiter failMode policy", () => {
    expect(pairRequestLimiter.failMode).toBe("closed");
    expect(pairStatusLimiter.failMode).toBe("open");
    expect(pairClaimLimiter.failMode).toBe("closed");
    expect(syncLimiter.failMode).toBe("open");
    expect(transferUploadLimiter.failMode).toBe("open");
    expect(transferDownloadLimiter.failMode).toBe("open");
    expect(transferConfirmLimiter.failMode).toBe("open");
    expect(transferRetryLimiter.failMode).toBe("open");
    expect(realtimeTokenLimiter.failMode).toBe("closed");
    expect(realtimeTokenUserLimiter.failMode).toBe("closed");
  });

  it("locks per-limiter labels (no namespace drift)", () => {
    expect(pairRequestLimiter.label).toBe("pair:request");
    expect(pairStatusLimiter.label).toBe("pair:status");
    expect(pairClaimLimiter.label).toBe("pair:claim");
    expect(syncLimiter.label).toBe("sync:device");
    expect(transferUploadLimiter.label).toBe("transfer:upload");
    expect(transferDownloadLimiter.label).toBe("transfer:download");
    expect(transferConfirmLimiter.label).toBe("transfer:confirm");
    expect(transferRetryLimiter.label).toBe("transfer:retry");
    expect(realtimeTokenLimiter.label).toBe("realtime:token");
    expect(realtimeTokenUserLimiter.label).toBe("realtime:token:user");
  });
});
