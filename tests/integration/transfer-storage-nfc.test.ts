import { afterAll, describe, expect, it } from "vitest";
import { getAdmin, shutdown } from "./helpers";
import {
  buildStoragePath,
  sanitizeFilename,
} from "../../src/lib/server/transfer";

// Regression for #216. End-to-end proof that the two halves of the fix
// hold against the real Supabase Storage server:
//   1. sanitizeFilename produces NFC-canonical user-facing filename.
//   2. buildStoragePath produces an ASCII-only key that survives the
//      Storage `isValidKey` regex on both upload and sign.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)(
  "book-transfers bucket: NFD filename → ASCII storage path round-trip",
  () => {
    const admin = getAdmin();
    // Service_role bypasses RLS; synthetic ids are fine.
    const userId = crypto.randomUUID();
    const transferId = crypto.randomUUID();
    // NFD form of "América - Nicolás.epub" via explicit ́ escapes
    // ('e' + U+0301 for é, 'a' + U+0301 for á) — the device sends this
    // byte sequence when uploading from a macOS APFS volume.
    const deviceFilename = "América - Nicolás.epub";
    const safe = sanitizeFilename(deviceFilename);
    const path = buildStoragePath(userId, transferId);
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);

    afterAll(async () => {
      await admin.storage.from("book-transfers").remove([path]);
      await shutdown();
    });

    it("sanitizeFilename collapses NFD to NFC", () => {
      // 'e' + U+0301 → U+00E9; bytes differ even though glyphs match.
      expect(safe).toBe(safe.normalize("NFC"));
      expect(deviceFilename).not.toBe(safe);
    });

    it("buildStoragePath emits an ASCII-only key", () => {
      expect(path).toMatch(/^[A-Za-z0-9_./-]+$/);
      expect(path).toBe(`${userId}/${transferId}.epub`);
    });

    it("uploads and signs the same ASCII key successfully", async () => {
      const { error: upErr } = await admin.storage
        .from("book-transfers")
        .upload(path, body, {
          contentType: "application/epub+zip",
          upsert: true,
        });
      expect(upErr).toBeNull();

      const { data, error } = await admin.storage
        .from("book-transfers")
        .createSignedUrl(path, 60);
      expect(error).toBeNull();
      expect(data?.signedUrl).toBeTruthy();

      const res = await fetch(data!.signedUrl);
      expect(res.status).toBe(200);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf).toEqual(body);
    });
  },
);
