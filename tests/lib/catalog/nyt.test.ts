import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchNytBestsellerIsbns } from "../../../src/lib/server/catalog/nyt";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nytBody(isbns: string[]): unknown {
  return { results: { books: isbns.map((i) => ({ primary_isbn13: i })) } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchNytBestsellerIsbns", () => {
  it("fires all three list fetches in parallel (not sequentially)", async () => {
    const callTimestamps: number[] = [];
    const start = Date.now();
    const fetchFn = vi.fn(async () => {
      callTimestamps.push(Date.now() - start);
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(nytBody(["9780743273565"]));
    });

    await fetchNytBestsellerIsbns("k", fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const spread = Math.max(...callTimestamps) - Math.min(...callTimestamps);
    // Parallel dispatch: all three should start within a tight window.
    // Sequential code spaces them by ~50ms (the per-fetch settle delay).
    expect(spread).toBeLessThan(20);
  });

  it("aborts a hung fetch after 5 seconds and skips that list", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const promise = fetchNytBestsellerIsbns(
      "k",
      fetchFn as unknown as typeof fetch,
    );
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // Each call must have received a signal — verifies AbortController wiring.
    for (const call of fetchFn.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    warn.mockRestore();
  });

  it("merges ISBNs from all three lists, deduplicating", async () => {
    const responses = [
      nytBody(["9780743273565", "9780451524935"]),
      nytBody(["9780451524935", "9780062316097"]),
      nytBody(["9780062316097", "9780316769174"]),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => jsonResponse(responses[i++]));

    const result = await fetchNytBestsellerIsbns(
      "k",
      fetchFn as unknown as typeof fetch,
    );

    expect(new Set(result)).toEqual(
      new Set([
        "9780743273565",
        "9780451524935",
        "9780062316097",
        "9780316769174",
      ]),
    );
    expect(result.length).toBe(4);
  });
});
