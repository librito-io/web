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
      salt: new Uint8Array(32),
      info: new TextEncoder().encode("librito-transfer"),
    },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptFile(
  data: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: ALGO, iv }, key, data);
  const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), IV_LENGTH);
  return combined.buffer;
}

export async function decryptFile(
  data: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
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
