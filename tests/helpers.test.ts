// tests/helpers.test.ts
import { describe, it, expect } from "vitest";
import { createMockSupabase } from "./helpers";

describe("createMockSupabase storage", () => {
  it("returns a deterministic fake URL when no override is registered", async () => {
    const mock = createMockSupabase();
    const result = await mock.storage
      .from("book-transfers")
      .createSignedUrl("user-1/transfer-1/file.epub", 3600);
    expect(result).toEqual({
      data: {
        signedUrl: "https://mock.example/user-1/transfer-1/file.epub?ttl=3600",
      },
      error: null,
    });
  });

  it("returns the override registered for a specific path", async () => {
    const mock = createMockSupabase();
    mock._results.set(
      "storage.createSignedUrl.book-transfers.user-1/transfer-1/file.epub",
      { data: { signedUrl: "https://override.example/x" }, error: null },
    );
    const result = await mock.storage
      .from("book-transfers")
      .createSignedUrl("user-1/transfer-1/file.epub", 3600);
    expect(result.data?.signedUrl).toBe("https://override.example/x");
  });

  it("returns an error when registered as an error result", async () => {
    const mock = createMockSupabase();
    mock._results.set(
      "storage.createSignedUrl.book-transfers.user-1/transfer-1/file.epub",
      { data: null, error: { message: "bucket unavailable" } },
    );
    const result = await mock.storage
      .from("book-transfers")
      .createSignedUrl("user-1/transfer-1/file.epub", 3600);
    expect(result.data).toBeNull();
    expect(result.error).toEqual({ message: "bucket unavailable" });
  });

  it("exposes the createSignedUrl spy so tests can assert call arguments", async () => {
    const mock = createMockSupabase();
    await mock.storage
      .from("book-transfers")
      .createSignedUrl("user-1/transfer-1/file.epub", 3600);
    expect(mock._storageSpy).toHaveBeenCalledTimes(1);
    expect(mock._storageSpy).toHaveBeenCalledWith(
      "book-transfers",
      "user-1/transfer-1/file.epub",
      3600,
    );
  });
});
