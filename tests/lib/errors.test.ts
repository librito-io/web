import { describe, it, expect } from "vitest";
import { jsonError, jsonSuccess } from "$lib/server/errors";

describe("jsonError", () => {
  it("returns a Response with correct status and JSON body", async () => {
    const res = jsonError(400, "invalid_request", "Missing field");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_request",
      message: "Missing field",
    });
  });

  it("includes Retry-After header when retryAfter is provided", () => {
    const res = jsonError(429, "rate_limited", "Too many requests", 30);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

describe("jsonSuccess", () => {
  it("returns a 200 Response with JSON body", async () => {
    const res = jsonSuccess({ code: "123456", pairingId: "abc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ code: "123456", pairingId: "abc" });
  });
});
