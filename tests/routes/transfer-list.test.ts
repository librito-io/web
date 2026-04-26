// tests/routes/transfer-list.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";

const supabase = createMockSupabase();
vi.mock("$lib/server/supabase", () => ({
  createAdminClient: () => supabase,
}));

const { GET } = await import("../../src/routes/api/transfer/list/+server");

beforeEach(() => {
  supabase._results.clear();
});

describe("GET /api/transfer/list — WS-D projection", () => {
  it("returns attemptCount, lastError, lastAttemptAt for each transfer", async () => {
    supabase._results.set("book_transfers.select", {
      data: [
        {
          id: "t-1",
          filename: "a.epub",
          file_size: 100,
          status: "failed",
          uploaded_at: "2026-04-25T00:00:00Z",
          downloaded_at: null,
          attempt_count: 10,
          last_error: "Couldn't deliver to your device after 10 attempts.",
          last_attempt_at: "2026-04-25T01:23:45Z",
        },
      ],
      error: null,
    });

    const evt = {
      locals: {
        safeGetSession: async () => ({
          user: { id: "u-1" },
          session: null,
        }),
      },
    } as unknown as Parameters<typeof GET>[0];
    const res = await GET(evt);
    const body = await res.json();

    expect(body.transfers[0]).toMatchObject({
      attemptCount: 10,
      lastError: "Couldn't deliver to your device after 10 attempts.",
      lastAttemptAt: "2026-04-25T01:23:45Z",
    });
  });
});
