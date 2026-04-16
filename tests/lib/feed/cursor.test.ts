import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "$lib/feed/cursor";

describe("cursor", () => {
  it("round-trips an object", () => {
    const obj = { u: "2026-04-10T12:00:00Z", id: "abc-123" };
    const encoded = encodeCursor(obj);
    expect(typeof encoded).toBe("string");
    expect(decodeCursor(encoded)).toEqual(obj);
  });

  it("round-trips a reading-sort cursor with numbers", () => {
    const obj = { c: 3, s: 420, id: "xyz" };
    const encoded = encodeCursor(obj);
    expect(decodeCursor(encoded)).toEqual(obj);
  });

  it("decodeCursor returns null for null input", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("decodeCursor returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("decodeCursor returns null for malformed base64", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
  });

  it("decodeCursor returns null for non-JSON payload", () => {
    const badPayload = Buffer.from("not json").toString("base64url");
    expect(decodeCursor(badPayload)).toBeNull();
  });

  it("encodeCursor of null returns null", () => {
    expect(encodeCursor(null)).toBeNull();
  });
});
