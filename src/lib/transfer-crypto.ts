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
  // A new claim invalidates any prior transfer secret for this account on
  // this browser. Keep exactly one entry to prevent getAnyTransferKey() from
  // silently picking a stale one after re-pair or device delete.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(KEY_STORAGE_PREFIX)) localStorage.removeItem(k);
  }
  localStorage.setItem(`${KEY_STORAGE_PREFIX}${deviceId}`, secretBase64);
}

export function getTransferKey(deviceId: string): string | null {
  return localStorage.getItem(`${KEY_STORAGE_PREFIX}${deviceId}`);
}

export function clearTransferKey(deviceId: string): void {
  localStorage.removeItem(`${KEY_STORAGE_PREFIX}${deviceId}`);
}

/**
 * @deprecated Use getTransferKey(deviceId) with the target device's id.
 * This helper returns null when 0 or >1 keys exist; callers should resolve
 * the target device and fetch its key explicitly.
 */
export function getAnyTransferKey(): string | null {
  let found: string | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(KEY_STORAGE_PREFIX)) continue;
    if (found !== null) return null;
    found = localStorage.getItem(k);
  }
  return found;
}
