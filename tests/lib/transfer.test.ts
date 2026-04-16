import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  validateTransferFilename,
  validateTransferSize,
  buildStoragePath,
  computeFileSha256,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
} from "../../src/lib/server/transfer";

describe("validateTransferFilename", () => {
  it("accepts a valid .epub filename", () => {
    expect(validateTransferFilename("book.epub")).toBeNull();
  });

  it("accepts .EPUB (uppercase extension)", () => {
    expect(validateTransferFilename("book.EPUB")).toBeNull();
  });

  it("accepts .Epub (mixed case extension)", () => {
    expect(validateTransferFilename("book.Epub")).toBeNull();
  });

  it("rejects a .pdf file", () => {
    expect(validateTransferFilename("book.pdf")).not.toBeNull();
  });

  it("rejects a .txt file", () => {
    expect(validateTransferFilename("book.txt")).not.toBeNull();
  });

  it("rejects a filename with no extension", () => {
    expect(validateTransferFilename("book")).not.toBeNull();
  });

  it("returns a descriptive error message for invalid files", () => {
    expect(validateTransferFilename("book.pdf")).toBe(
      "Only EPUB files are accepted",
    );
  });

  it("rejects filename exceeding 255 characters", () => {
    const longName = "a".repeat(252) + ".epub"; // 256 chars
    expect(validateTransferFilename(longName)).toBe(
      "Filename exceeds 255 character limit",
    );
  });

  it("accepts filename at exactly 255 characters", () => {
    const maxName = "a".repeat(250) + ".epub"; // 255 chars
    expect(validateTransferFilename(maxName)).toBeNull();
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
    expect(validateTransferSize(1)).toBeNull();
  });

  it("accepts exactly MAX_FILE_SIZE", () => {
    expect(validateTransferSize(MAX_FILE_SIZE)).toBeNull();
  });

  it("rejects 0 bytes", () => {
    expect(validateTransferSize(0)).not.toBeNull();
  });

  it("rejects negative size", () => {
    expect(validateTransferSize(-1)).not.toBeNull();
  });

  it("rejects MAX_FILE_SIZE + 1", () => {
    expect(validateTransferSize(MAX_FILE_SIZE + 1)).not.toBeNull();
  });

  it("returns an error message for zero size", () => {
    expect(validateTransferSize(0)).toBe("File size must be greater than 0");
  });

  it("returns an error message when file exceeds limit", () => {
    expect(validateTransferSize(MAX_FILE_SIZE + 1)).toBe(
      "File exceeds 20MB limit",
    );
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

describe("computeFileSha256", () => {
  it("returns a hex string of length 64", () => {
    const result = computeFileSha256(Buffer.from("hello"));
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("returns the correct SHA-256 digest for a known input", () => {
    // SHA-256 of "hello" is well-known
    const expected =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(computeFileSha256(Buffer.from("hello"))).toBe(expected);
  });

  it("returns different digests for different inputs", () => {
    const a = computeFileSha256(Buffer.from("hello"));
    const b = computeFileSha256(Buffer.from("world"));
    expect(a).not.toBe(b);
  });

  it("handles an empty buffer", () => {
    // SHA-256 of empty string
    const expected =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(computeFileSha256(Buffer.alloc(0))).toBe(expected);
  });
});
