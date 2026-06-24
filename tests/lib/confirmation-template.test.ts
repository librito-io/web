import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(
  resolve(__dirname, "../../supabase/templates/confirmation.html"),
  "utf8",
);

describe("confirmation.html (OTP code email)", () => {
  it("renders the 6-digit OTP token", () => {
    expect(html).toContain("{{ .Token }}");
  });

  it("does not offer a magic link (OTP-only flow)", () => {
    expect(html).not.toContain("{{ .ConfirmationURL }}");
  });
});
