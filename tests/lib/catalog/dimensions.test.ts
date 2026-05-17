import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeImageDimensions } from "../../../src/lib/server/catalog/dimensions";

// 1×1 PNG (red pixel) — standard fixture inlined for self-containment
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x5b, 0x4d, 0xff, 0x6f, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

const JPEG_600x900 = new Uint8Array(
  readFileSync("tests/fixtures/catalog/600x900.jpg"),
);
const JPEG_200x300 = new Uint8Array(
  readFileSync("tests/fixtures/catalog/200x300.jpg"),
);
const JPEG_143x218 = new Uint8Array(
  readFileSync("tests/fixtures/catalog/143x218.jpg"),
);

describe("decodeImageDimensions", () => {
  it("decodes PNG IHDR width/height", () => {
    const result = decodeImageDimensions(PNG_1x1);
    expect(result).toEqual({ width: 1, height: 1, type: "png" });
  });

  it("decodes JPEG SOF0 dimensions (600x900)", () => {
    const result = decodeImageDimensions(JPEG_600x900);
    expect(result?.width).toBe(600);
    expect(result?.height).toBe(900);
    expect(result?.type).toBe("jpeg");
  });

  it("decodes JPEG SOF0 dimensions (200x300)", () => {
    const result = decodeImageDimensions(JPEG_200x300);
    expect(result?.width).toBe(200);
    expect(result?.height).toBe(300);
  });

  it("decodes JPEG SOF0 dimensions (143x218)", () => {
    const result = decodeImageDimensions(JPEG_143x218);
    expect(result?.width).toBe(143);
    expect(result?.height).toBe(218);
  });

  it("returns null on bytes too short to identify", () => {
    expect(decodeImageDimensions(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("returns null on unrecognized format", () => {
    expect(decodeImageDimensions(new Uint8Array(64))).toBeNull();
  });
});
