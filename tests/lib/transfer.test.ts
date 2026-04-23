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
