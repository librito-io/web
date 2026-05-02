import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
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
  it("returns {userId}/{transferId}/{filename}", () => {
    expect(buildStoragePath("user-123", "transfer-456", "book.epub")).toBe(
      "user-123/transfer-456/book.epub",
    );
  });

  it("works with arbitrary string segments", () => {
    expect(buildStoragePath("abc", "def", "my-file.epub")).toBe(
      "abc/def/my-file.epub",
    );
  });
});
