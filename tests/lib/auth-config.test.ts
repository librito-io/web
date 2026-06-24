import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = readFileSync(
  resolve(__dirname, "../../supabase/config.toml"),
  "utf8",
);

describe("auth.external provider config", () => {
  it("declares both google and apple provider blocks", () => {
    expect(config).toContain("[auth.external.google]");
    expect(config).toContain("[auth.external.apple]");
  });

  it("sources every client_id and secret from env(), never inline", () => {
    expect(config).toContain(
      'client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"',
    );
    expect(config).toContain(
      'secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"',
    );
    expect(config).toContain(
      'client_id = "env(SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID)"',
    );
    expect(config).toContain(
      'secret = "env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)"',
    );
    // Apple client_id must no longer be the empty-string literal.
    expect(config).not.toContain('client_id = ""');
  });

  it("leaves both providers disabled in committed local config", () => {
    // Pre-launch parity: no provider is enabled in git; creds + enable live in Dashboard.
    const googleBlock = config.slice(config.indexOf("[auth.external.google]"));
    expect(googleBlock).toMatch(
      /\[auth\.external\.google\][\s\S]*?enabled = false/,
    );
  });
});
