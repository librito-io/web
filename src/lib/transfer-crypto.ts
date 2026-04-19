const ALGO = "AES-GCM";
const IV_LENGTH = 12;
const KEY_STORAGE_PREFIX = "librito_transfer_key_";

export async function deriveKey(secretBase64: string): Promise<CryptoKey> {
  const rawKey = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    rawKey,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("librito-transfer-v1"),
      info: new TextEncoder().encode("librito-transfer"),
    },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface EncryptedFile {
  data: ArrayBuffer;
  iv: Uint8Array;
}

export async function encryptFile(
  data: ArrayBuffer,
  key: CryptoKey,
): Promise<EncryptedFile> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: ALGO, iv }, key, data);
  return { data: encrypted, iv };
}

export async function decryptFile(
  data: ArrayBuffer,
  iv: Uint8Array,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    data,
  );
}

export function storeTransferKey(deviceId: string, secretBase64: string): void {
  localStorage.setItem(`${KEY_STORAGE_PREFIX}${deviceId}`, secretBase64);
}

export function getTransferKey(deviceId: string): string | null {
  return localStorage.getItem(`${KEY_STORAGE_PREFIX}${deviceId}`);
}

export function getAnyTransferKey(): string | null {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(KEY_STORAGE_PREFIX)) {
      return localStorage.getItem(key);
    }
  }
  return null;
}
