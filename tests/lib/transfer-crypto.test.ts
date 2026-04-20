import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  deriveKey,
  encryptFile,
  decryptFile,
  storeTransferKey,
  getTransferKey,
  getAnyTransferKey,
  clearTransferKey,
  reconcileTransferKeys,
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
    const plaintext = new TextEncoder().encode("hello");
    const enc = await encryptFile(plaintext.buffer, key1);
    const decrypted = await decryptFile(enc.data, enc.iv, key2);
    expect(new TextDecoder().decode(decrypted)).toBe("hello");
  });
});

describe("encryptFile", () => {
  it("data is plaintext length + 16 (GCM auth tag), iv is 12 bytes", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const plaintext = new Uint8Array(100).fill(0xab);
    const enc = await encryptFile(plaintext.buffer, key);
    expect(enc.data.byteLength).toBe(plaintext.byteLength + 16);
    expect(enc.iv.byteLength).toBe(12);
  });

  it("iv is random per call", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const plaintext = new Uint8Array(64).fill(0x01);
    const enc1 = await encryptFile(plaintext.buffer, key);
    const enc2 = await encryptFile(plaintext.buffer, key);
    expect(enc1.iv).not.toEqual(enc2.iv);
  });
});

describe("decryptFile", () => {
  it("round-trip: encrypt then decrypt returns the original data", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const original = new TextEncoder().encode("Hello, Librito!");
    const enc = await encryptFile(original.buffer, key);
    const decrypted = await decryptFile(enc.data, enc.iv, key);
    expect(new Uint8Array(decrypted)).toEqual(original);
  });

  it("round-trip works with binary data", async () => {
    const key = await deriveKey(TEST_SECRET_BASE64);
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const enc = await encryptFile(original.buffer, key);
    const decrypted = await decryptFile(enc.data, enc.iv, key);
    expect(new Uint8Array(decrypted)).toEqual(original);
  });

  it("throws when decrypting with the wrong key", async () => {
    const key1 = await deriveKey(TEST_SECRET_BASE64);
    const key2 = await deriveKey(
      btoa(String.fromCharCode(...new Array(32).fill(0x99))),
    );
    const plaintext = new Uint8Array(64).fill(0x01);
    const enc = await encryptFile(plaintext.buffer, key1);
    await expect(decryptFile(enc.data, enc.iv, key2)).rejects.toThrow();
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

  it("evicts prior entries under a different deviceId on store", () => {
    const newSecret = btoa(String.fromCharCode(...new Array(32).fill(0x11)));
    storeTransferKey("device-old", TEST_SECRET_BASE64);
    storeTransferKey("device-new", newSecret);
    expect(getTransferKey("device-old")).toBeNull();
    expect(getTransferKey("device-new")).toBe(newSecret);
    // Exactly one transfer-prefixed entry remains.
    const transferKeys = [...storage.keys()].filter((k) =>
      k.startsWith("librito_transfer_key_"),
    );
    expect(transferKeys).toHaveLength(1);
  });

  it("leaves unrelated localStorage entries untouched on store", () => {
    storage.set("unrelated_key", "keep-me");
    storeTransferKey("device-abc", TEST_SECRET_BASE64);
    expect(storage.get("unrelated_key")).toBe("keep-me");
  });
});

describe("clearTransferKey", () => {
  it("removes only the matching entry", () => {
    const secret2 = btoa(String.fromCharCode(...new Array(32).fill(0x55)));
    // storeTransferKey evicts on each call, so seed via the mock store
    // directly to exercise clearTransferKey against multiple entries.
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    storage.set("librito_transfer_key_device-2", secret2);
    storage.set("unrelated_key", "keep-me");
    clearTransferKey("device-1");
    expect(getTransferKey("device-1")).toBeNull();
    expect(getTransferKey("device-2")).toBe(secret2);
    expect(storage.get("unrelated_key")).toBe("keep-me");
  });

  it("is a no-op when the deviceId has no stored key", () => {
    storeTransferKey("device-abc", TEST_SECRET_BASE64);
    clearTransferKey("device-nonexistent");
    expect(getTransferKey("device-abc")).toBe(TEST_SECRET_BASE64);
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

  it("returns null when multiple transfer keys exist (ambiguous)", () => {
    const secret2 = btoa(String.fromCharCode(...new Array(32).fill(0x55)));
    // Bypass storeTransferKey's eviction to create an ambiguous state,
    // matching the legacy-localStorage scenarios this guard exists for.
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    storage.set("librito_transfer_key_device-2", secret2);
    expect(getAnyTransferKey()).toBeNull();
  });
});

describe("reconcileTransferKeys", () => {
  it("removes entries whose deviceId is not in the live set", () => {
    const secret2 = btoa(String.fromCharCode(...new Array(32).fill(0x55)));
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    storage.set("librito_transfer_key_device-2", secret2);
    reconcileTransferKeys(["device-1"]);
    expect(getTransferKey("device-1")).toBe(TEST_SECRET_BASE64);
    expect(getTransferKey("device-2")).toBeNull();
  });

  it("removes all transfer entries when live list is empty", () => {
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    reconcileTransferKeys([]);
    expect(getTransferKey("device-1")).toBeNull();
  });

  it("retains an entry whose deviceId is in the live set", () => {
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    reconcileTransferKeys(["device-1"]);
    expect(getTransferKey("device-1")).toBe(TEST_SECRET_BASE64);
  });

  it("leaves non-prefixed localStorage entries untouched", () => {
    storage.set("librito_transfer_key_device-1", TEST_SECRET_BASE64);
    storage.set("unrelated_key", "keep-me");
    storage.set("another_key", "also-keep");
    reconcileTransferKeys([]);
    expect(storage.get("unrelated_key")).toBe("keep-me");
    expect(storage.get("another_key")).toBe("also-keep");
  });
});
