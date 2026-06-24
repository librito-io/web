import { describe, it, expect } from "vitest";
import { buildOAuthRedirectTo } from "$lib/auth/oauth";

describe("buildOAuthRedirectTo", () => {
  it("appends an encoded return_to to the callback path", () => {
    expect(buildOAuthRedirectTo("https://librito.io", "/app/library/abc")).toBe(
      "https://librito.io/auth/callback?return_to=%2Fapp%2Flibrary%2Fabc",
    );
  });

  it("encodes the default /app return_to", () => {
    expect(buildOAuthRedirectTo("http://localhost:5173", "/app")).toBe(
      "http://localhost:5173/auth/callback?return_to=%2Fapp",
    );
  });
});
