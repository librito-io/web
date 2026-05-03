import { describe, it, expect } from "vitest";
import { sha256Hex } from "$lib/server/catalog/sha";

describe("sha256Hex", () => {
  it('returns the correct digest for "abc" (NIST vector)', async () => {
    // NIST SHA-256 test vector: SHA256("abc") =
    // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const result = await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]));
    expect(result).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns the correct digest for empty input (NIST vector)", async () => {
    // NIST SHA-256 test vector: SHA256("") =
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const result = await sha256Hex(new Uint8Array(0));
    expect(result).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
