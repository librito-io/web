import { createHash } from "crypto";
import { basename } from "path";

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_FILENAME_LENGTH = 255;
export const MAX_PENDING_TRANSFERS = 20;
export const UPLOAD_URL_TTL = 300; // 5 minutes
export const DOWNLOAD_URL_TTL = 3600; // 1 hour

export function sanitizeFilename(filename: string): string {
  return basename(filename);
}

export function validateTransferFilename(filename: string): string | null {
  if (!filename.toLowerCase().endsWith(".epub")) {
    return "Only EPUB files are accepted";
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return "Filename exceeds 255 character limit";
  }
  return null;
}

export function validateTransferSize(size: number): string | null {
  if (size <= 0) return "File size must be greater than 0";
  if (size > MAX_FILE_SIZE) return "File exceeds 20MB limit";
  return null;
}

export function buildStoragePath(
  userId: string,
  transferId: string,
  filename: string,
): string {
  return `${userId}/${transferId}/${filename}`;
}

export function computeFileSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
