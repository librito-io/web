import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  MAX_FILE_SIZE,
} from "../../src/lib/server/transfer";

describe("validateTransferFilename", () => {
  it("accepts a valid .epub filename", () => {
    expect(validateTransferFilename("book.epub")).toEqual({ ok: true });
  });

  it("accepts .EPUB (uppercase extension)", () => {
    expect(validateTransferFilename("book.EPUB")).toEqual({ ok: true });
  });

  it("accepts .Epub (mixed case extension)", () => {
    expect(validateTransferFilename("book.Epub")).toEqual({ ok: true });
  });

  it("rejects a .pdf file", () => {
    expect(validateTransferFilename("book.pdf")).toMatchObject({ ok: false });
  });

  it("rejects a .txt file", () => {
    expect(validateTransferFilename("book.txt")).toMatchObject({ ok: false });
  });

  it("rejects a filename with no extension", () => {
    expect(validateTransferFilename("book")).toMatchObject({ ok: false });
  });

  it("returns a descriptive error message for invalid files", () => {
    expect(validateTransferFilename("book.pdf")).toEqual({
      ok: false,
      error: "Only EPUB files are accepted",
    });
  });

  it("rejects filename exceeding 255 characters", () => {
    const longName = "a".repeat(252) + ".epub"; // 256 chars
    expect(validateTransferFilename(longName)).toEqual({
      ok: false,
      error: "Filename exceeds 255 character limit",
    });
  });

  it("accepts filename at exactly 255 characters", () => {
    const maxName = "a".repeat(250) + ".epub"; // 255 chars
    expect(validateTransferFilename(maxName)).toEqual({ ok: true });
  });
});

describe("sanitizeFilename", () => {
  it("returns basename from path with forward slashes", () => {
    expect(sanitizeFilename("../../other/file.epub")).toBe("file.epub");
  });

  it("returns filename unchanged when no path separators", () => {
    expect(sanitizeFilename("book.epub")).toBe("book.epub");
  });

  it("strips directory traversal attempts", () => {
    expect(sanitizeFilename("../../../etc/passwd.epub")).toBe("passwd.epub");
  });

  it("normalizes NFD-decomposed combining accents to NFC", () => {
    // "América" = NFD ('e' + U+0301 COMBINING ACUTE ACCENT).
    // "América" = NFC (single U+00E9 LATIN SMALL LETTER E WITH ACUTE).
    const nfd = "América.epub";
    const nfc = "América.epub";
    expect(nfd).not.toBe(nfc);
    expect(sanitizeFilename(nfd)).toBe(nfc);
  });

  it("leaves already-NFC filenames unchanged", () => {
    const nfc = "Nicolás.epub";
    expect(sanitizeFilename(nfc)).toBe(nfc);
  });
});

describe("validateTransferSize", () => {
  it("accepts 1 byte", () => {
    expect(validateTransferSize(1)).toEqual({ ok: true });
  });

  it("accepts exactly MAX_FILE_SIZE", () => {
    expect(validateTransferSize(MAX_FILE_SIZE)).toEqual({ ok: true });
  });

  it("rejects 0 bytes", () => {
    expect(validateTransferSize(0)).toMatchObject({ ok: false });
  });

  it("rejects negative size", () => {
    expect(validateTransferSize(-1)).toMatchObject({ ok: false });
  });

  it("rejects MAX_FILE_SIZE + 1", () => {
    expect(validateTransferSize(MAX_FILE_SIZE + 1)).toMatchObject({
      ok: false,
    });
  });

  it("returns an error message for zero size", () => {
    expect(validateTransferSize(0)).toEqual({
      ok: false,
      error: "File size must be greater than 0",
    });
  });

  it("returns an error message when file exceeds limit", () => {
    expect(validateTransferSize(MAX_FILE_SIZE + 1)).toEqual({
      ok: false,
      error: "File exceeds 20MB limit",
    });
  });
});

describe("buildStoragePath", () => {
  it("returns {userId}/{transferId}.epub — ASCII-only", () => {
    expect(
      buildStoragePath(
        "fbb5b2c8-1d1f-4c1f-a3e7-9c1c43e2c0e3",
        "9c2c7c1c-1f1f-4c1f-b3e7-fbb5b2c81d1f",
      ),
    ).toBe(
      "fbb5b2c8-1d1f-4c1f-a3e7-9c1c43e2c0e3/9c2c7c1c-1f1f-4c1f-b3e7-fbb5b2c81d1f.epub",
    );
  });

  it("output contains no non-ASCII bytes (Storage key regex safety)", () => {
    // Regression for #216: Supabase Storage `isValidKey` regex rejects any
    // byte outside [A-Za-z0-9_] plus a small ASCII punctuation set.
    // UUID-based path is regex-clean by construction.
    const path = buildStoragePath(crypto.randomUUID(), crypto.randomUUID());
    expect(path).toMatch(/^[A-Za-z0-9_./-]+$/);
  });

  it("first folder segment is the userId so RLS foldername[1] holds", () => {
    const userId = "0e0e0e0e-0000-0000-0000-000000000000";
    const path = buildStoragePath(userId, crypto.randomUUID());
    expect(path.split("/")[0]).toBe(userId);
  });
});
