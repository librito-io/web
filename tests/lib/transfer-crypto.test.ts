import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  deriveKey,
  encryptFile,
  decryptFile,
  storeTransferKey,
  getTransferKey,
  getAnyTransferKey,
} from "$lib/transfer-crypto";

vi.stubGlobal("crypto", webcrypto);

// Mock localStorage with in-memory store
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
});

// A deterministic base64 secret (32 bytes → 256-bit raw key for HKDF)
const TEST_SECRET_BASE64 = btoa(
  String.fromCharCode(...new Array(32).fill(0x42)),
);

beforeEach(() => {
  storage.clear();
});

describe("deriveKey", () => {
  it("derives an AES-256-GCM CryptoKey from a base64 secret", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
  });

  it("produces the same key material deterministically", async () => {
    const key1 = await deriveKey(TEST_SECRET_BASE64);
    const key2 = await deriveKey(TEST_SECRET_BASE64);
    // Both keys should successfully decrypt data encrypted with the other
    const plaintext = new TextEncoder().encode("hello");
    const encrypted = await encryptFile(plaintext.buffer, key1);
    const decrypted = await decryptFile(encrypted, key2);
    expect(new TextDecoder().decode(decrypted)).toBe("hello");
  });
});

describe("encryptFile", () => {
  it("output is larger than input (IV + AES-GCM tag overhead)", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const plaintext = new Uint8Array(100).fill(0xab);
    const encrypted = await encryptFile(plaintext.buffer, key);
    // 12-byte IV + 16-byte GCM auth tag = at least 28 bytes overhead
    expect(encrypted.byteLength).toBeGreaterThan(plaintext.byteLength);
  });

  it("output starts with a 12-byte IV", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const plaintext = new Uint8Array(64).fill(0x01);
    const encrypted1 = await encryptFile(plaintext.buffer, key);
    const encrypted2 = await encryptFile(plaintext.buffer, key);
    const iv1 = new Uint8Array(encrypted1).slice(0, 12);
    const iv2 = new Uint8Array(encrypted2).slice(0, 12);
    // IVs should be random and thus differ between calls
    expect(iv1).not.toEqual(iv2);
  });
});

describe("decryptFile", () => {
  it("round-trip: encrypt then decrypt returns the original data", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const original = new TextEncoder().encode("Hello, Librito!");
    const encrypted = await encryptFile(original.buffer, key);
    const decrypted = await decryptFile(encrypted, key);
    expect(new Uint8Array(decrypted)).toEqual(original);
  });

  it("round-trip works with binary data", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const encrypted = await encryptFile(original.buffer, key);
    const decrypted = await decryptFile(encrypted, key);
    expect(new Uint8Array(decrypted)).toEqual(original);
  });

  it("throws when decrypting with the wrong key", async () => {
    const key1 = await deriveKey(TEST_SECRET_BASE64);
    const key2 = await deriveKey(
      btoa(String.fromCharCode(...new Array(32).fill(0x99))),
    );
    const plaintext = new Uint8Array(64).fill(0x01);
    const encrypted = await encryptFile(plaintext.buffer, key1);
    await expect(decryptFile(encrypted, key2)).rejects.toThrow();
  });
});

describe("storeTransferKey / getTransferKey", () => {
  it("stores and retrieves a key by deviceId", () => {
    storeTransferKey("device-abc", TEST_SECRET_BASE64);
    expect(getTransferKey("device-abc")).toBe(TEST_SECRET_BASE64);
  });

  it("returns null for an unknown deviceId", () => {
    expect(getTransferKey("device-nonexistent")).toBeNull();
  });

  it("overwrites an existing key for the same deviceId", () => {
    const newSecret = btoa(String.fromCharCode(...new Array(32).fill(0x11)));
    storeTransferKey("device-abc", TEST_SECRET_BASE64);
    storeTransferKey("device-abc", newSecret);
    expect(getTransferKey("device-abc")).toBe(newSecret);
  });
});

describe("getAnyTransferKey", () => {
  it("returns null when no transfer keys are stored", () => {
    expect(getAnyTransferKey()).toBeNull();
  });

  it("finds a key stored with the transfer prefix", () => {
    storeTransferKey("device-xyz", TEST_SECRET_BASE64);
    expect(getAnyTransferKey()).toBe(TEST_SECRET_BASE64);
  });

  it("returns null when only unrelated keys are in localStorage", () => {
    storage.set("some_other_key", "some_value");
    expect(getAnyTransferKey()).toBeNull();
  });

  it("returns one of the keys when multiple transfer keys exist", () => {
    const secret2 = btoa(String.fromCharCode(...new Array(32).fill(0x55)));
    storeTransferKey("device-1", TEST_SECRET_BASE64);
    storeTransferKey("device-2", secret2);
    const result = getAnyTransferKey();
    expect([TEST_SECRET_BASE64, secret2]).toContain(result);
  });
});
