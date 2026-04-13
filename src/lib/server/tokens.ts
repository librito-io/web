import { randomInt, randomBytes } from "crypto";
import bcrypt from "bcryptjs";

export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateDeviceToken(): string {
  return `sk_device_${randomBytes(32).toString("base64url")}`;
}

export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, 10);
}
