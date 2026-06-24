import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

// OAuthButtons.signIn is the only entry point for Google/Apple sign-in and the
// only surface that tells a user a sign-in attempt failed (bad provider config,
// network). Its error display + pending reset are $state-driven. The repo has
// no component-render harness — rendered UI behaviour is covered by Playwright
// e2e, which CANNOT deterministically trigger signInWithOAuth's error/throw
// paths because the happy path navigates the tab (signInWithOAuth resolves with
// error: null and redirects before any provider error surfaces). This
// source-assertion guards the load-bearing invariants of the error/catch
// branches against regression — same pattern as highlight-card-savenote.test.ts.
const SOURCE = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "src",
    "lib",
    "components",
    "OAuthButtons.svelte",
  ),
  "utf8",
);

describe("OAuthButtons signIn error handling", () => {
  it("renders the error as an alert-role element (a11y + e2e discoverable)", () => {
    expect(SOURCE).toMatch(
      /\{#if error\}[\s\S]*?role="alert"[\s\S]*?\{error\}/,
    );
  });

  it("surfaces the returned error message and clears pending on a non-null error", () => {
    // if (err) { error = err.message; pending = null }
    expect(SOURCE).toMatch(
      /if\s*\(\s*err\s*\)\s*\{[\s\S]*?error\s*=\s*err\.message[\s\S]*?pending\s*=\s*null[\s\S]*?\}/,
    );
  });

  it("clears pending in the catch branch so a thrown error never strands a disabled button", () => {
    // catch (e) { error = ...; pending = null }
    expect(SOURCE).toMatch(
      /catch\s*\([\s\S]*?\)\s*\{[\s\S]*?error\s*=[\s\S]*?pending\s*=\s*null[\s\S]*?\}/,
    );
  });
});
