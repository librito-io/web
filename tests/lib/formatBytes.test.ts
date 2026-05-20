import { describe, it, expect } from "vitest";
import { formatBytes } from "../../src/lib/formatBytes";

describe("formatBytes", () => {
  it("renders bytes under 1 KiB without unit conversion", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders sub-MiB values in KiB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("renders MiB-range values without trailing .0 for round numbers", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });

  it("keeps one decimal for non-round MiB values", () => {
    expect(formatBytes(Math.round(9.7 * 1024 * 1024))).toBe("9.7 MB");
    expect(formatBytes(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
  });
});
