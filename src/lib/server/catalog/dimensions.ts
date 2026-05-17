// Lightweight image-dimension reader for JPEG, PNG, and WebP. Pure function,
// no I/O. Used by `downloadCover` to enforce a width floor before accepting
// cover bytes from upstream sources.
//
// JPEG: scan past SOI (FF D8), find SOF marker (FF C0..C3 / C5..C7 / C9..CB /
// CD..CF), read 16-bit height and width after the 2-byte segment length and
// 1-byte precision.
// PNG: 8-byte signature + 4-byte chunk length + "IHDR" + 4-byte width + 4-byte
// height (network byte order).
// WebP: RIFF...WEBP container, then VP8 / VP8L / VP8X chunk with format-
// specific width/height encoding.

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageDimensions {
  width: number;
  height: number;
  type: ImageFormat;
}

export function decodeImageDimensions(
  bytes: Uint8Array,
): ImageDimensions | null {
  if (bytes.length < 24) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      type: "png",
    };
  }

  // JPEG: FF D8 ... FF Cn (SOF marker)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) return null;
      const marker = bytes[i];
      i++;
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        if (i + 7 > bytes.length) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset + i + 3);
        return {
          width: view.getUint16(2),
          height: view.getUint16(0),
          type: "jpeg",
        };
      }
      if (i + 2 > bytes.length) return null;
      const segLen = new DataView(bytes.buffer, bytes.byteOffset + i).getUint16(
        0,
      );
      if (segLen < 2) return null;
      i += segLen;
    }
    return null;
  }

  // WebP: 'RIFF' .... 'WEBP'
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    // VP8 (lossy)
    if (
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x20
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + 26);
      return {
        width: view.getUint16(0, true) & 0x3fff,
        height: view.getUint16(2, true) & 0x3fff,
        type: "webp",
      };
    }
    // VP8L (lossless)
    if (
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x4c
    ) {
      const b0 = bytes[21],
        b1 = bytes[22],
        b2 = bytes[23],
        b3 = bytes[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        type: "webp",
      };
    }
    // VP8X (extended)
    if (
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x58
    ) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height, type: "webp" };
    }
  }

  return null;
}
