import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeImageDimensions } from "../../../src/lib/server/catalog/dimensions";

// ---------------------------------------------------------------------------
// WebP inline fixtures (Option A — no binary file commits, all branches hit)
// ---------------------------------------------------------------------------

// VP8 lossy 300×450
// Offsets 0-3: "RIFF", 4-7: file size LE (dummy 0x24), 8-11: "WEBP"
// Offsets 12-15: "VP8 " (note trailing space = 0x20)
// Offsets 16-19: VP8 chunk size LE (dummy 0x10)
// Offsets 20-25: frame tag (3 bytes) + start code (9D 01 2A)
// Offsets 26-27: width  LE uint16 masked with 0x3FFF — 300 = 0x012C → 2C 01
// Offsets 28-29: height LE uint16 masked with 0x3FFF — 450 = 0x01C2 → C2 01
const WEBP_VP8_300x450 = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x24,
  0x00,
  0x00,
  0x00, // file size - 8 (dummy)
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x20, // "VP8 " (lossy, trailing space)
  0x10,
  0x00,
  0x00,
  0x00, // VP8 chunk size (dummy)
  0x00,
  0x00,
  0x00, // VP8 frame tag (3 bytes, flags)
  0x9d,
  0x01,
  0x2a, // VP8 start code
  0x2c,
  0x01, // width  = 300 = 0x012C, LE → 0x2C 0x01; decoded: 0x012C & 0x3FFF = 300
  0xc2,
  0x01, // height = 450 = 0x01C2, LE → 0xC2 0x01; decoded: 0x01C2 & 0x3FFF = 450
]);

// VP8L lossless 320×480
// Offsets 12-15: "VP8L" (0x56 0x50 0x38 0x4C)
// Offset 20: signature byte 0x2F
// Offsets 21-24: packed dims (4 bytes), b0..b3 below
//   width-1  = 319 = 0x13F
//   height-1 = 479 = 0x1DF
//   b0 = (width-1) & 0xFF               = 0x3F
//   b1 = ((width-1) >> 8) & 0x3F        = 0x01  (low 6 bits carry w-1 high)
//      | ((height-1) & 0x3) << 6        = 0xC0  (low 2 bits of h-1 go to b1[7:6])
//      → b1 = 0x01 | 0xC0              = 0xC1
//   b2 = ((height-1) >> 2) & 0xFF       = 0x77  (479>>2 = 119 = 0x77)
//   b3 = ((height-1) >> 10) & 0x0F      = 0x00  (479 < 1024)
// Decode check:
//   width  = 1 + (((0xC1 & 0x3F) << 8) | 0x3F) = 1 + (0x01<<8 | 0x3F) = 1 + 319 = 320 ✓
//   height = 1 + (((0x00 & 0xF) << 10) | (0x77 << 2) | ((0xC1 & 0xC0) >> 6))
//          = 1 + (0 | 0x1DC | 0x03) = 1 + 0x1DF = 480 ✓
const WEBP_VP8L_320x480 = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x20,
  0x00,
  0x00,
  0x00, // file size - 8 (dummy)
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x4c, // "VP8L"
  0x0c,
  0x00,
  0x00,
  0x00, // VP8L chunk size (dummy)
  0x2f, // VP8L signature byte
  0x3f,
  0xc1,
  0x77,
  0x00, // packed dims: b0=0x3F b1=0xC1 b2=0x77 b3=0x00
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // padding to reach minimum 30 bytes (impl guard: bytes.length >= 30)
]);

// VP8X extended 1200×1800  (matches future xlarge variant)
// Offsets 12-15: "VP8X" (0x56 0x50 0x38 0x58)
// Offsets 16-19: VP8X chunk size = 10 (always)
// Offset 20: flags byte (0 = no ICC, no alpha, no EXIF, no XMP, no animation)
// Offsets 21-23: reserved (0x00 0x00 0x00)
// Offsets 24-26: canvas width-1  = 1199 = 0x0004AF, LE 24-bit → 0xAF 0x04 0x00
// Offsets 27-29: canvas height-1 = 1799 = 0x000707, LE 24-bit → 0x07 0x07 0x00
// Decode check:
//   width  = 1 + (0xAF | (0x04 << 8) | (0x00 << 16)) = 1 + (175 + 1024 + 0) = 1200 ✓
//   height = 1 + (0x07 | (0x07 << 8) | (0x00 << 16)) = 1 + (7   + 1792 + 0) = 1800 ✓
const WEBP_VP8X_1200x1800 = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x24,
  0x00,
  0x00,
  0x00, // file size - 8 (dummy)
  0x57,
  0x45,
  0x42,
  0x50, // "WEBP"
  0x56,
  0x50,
  0x38,
  0x58, // "VP8X"
  0x0a,
  0x00,
  0x00,
  0x00, // VP8X chunk size = 10 (spec requires exactly 10)
  0x00, // flags
  0x00,
  0x00,
  0x00, // reserved
  0xaf,
  0x04,
  0x00, // canvas width-1  = 1199 = 0x04AF, LE 24-bit
  0x07,
  0x07,
  0x00, // canvas height-1 = 1799 = 0x0707, LE 24-bit
]);

// ---------------------------------------------------------------------------

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

  it("decodes WebP VP8 (lossy) dimensions (300x450)", () => {
    const result = decodeImageDimensions(WEBP_VP8_300x450);
    expect(result?.width).toBe(300);
    expect(result?.height).toBe(450);
    expect(result?.type).toBe("webp");
  });

  it("decodes WebP VP8L (lossless) dimensions (320x480)", () => {
    const result = decodeImageDimensions(WEBP_VP8L_320x480);
    expect(result?.width).toBe(320);
    expect(result?.height).toBe(480);
    expect(result?.type).toBe("webp");
  });

  it("decodes WebP VP8X (extended) dimensions (1200x1800)", () => {
    const result = decodeImageDimensions(WEBP_VP8X_1200x1800);
    expect(result?.width).toBe(1200);
    expect(result?.height).toBe(1800);
    expect(result?.type).toBe("webp");
  });

  it("returns null on bytes too short to identify", () => {
    expect(decodeImageDimensions(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("returns null on unrecognized format", () => {
    expect(decodeImageDimensions(new Uint8Array(64))).toBeNull();
  });
});
