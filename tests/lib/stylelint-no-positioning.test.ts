import { describe, it, expect } from "vitest";
import stylelint from "stylelint";
import plugin, {
  ruleName,
} from "../../stylelint/no-positioning-on-bare-type.js";

type Mode = "global" | "scoped";

async function lintCss(code: string, mode: Mode): Promise<string[]> {
  const { results } = await stylelint.lint({
    code,
    config: { plugins: [plugin], rules: { [ruleName]: [true, { mode }] } },
  });
  return results[0].warnings.map((w) => w.text);
}

async function lintSvelte(css: string): Promise<string[]> {
  const { results } = await stylelint.lint({
    code: `<style>\n${css}\n</style>`,
    customSyntax: "postcss-html",
    config: {
      plugins: [plugin],
      rules: { [ruleName]: [true, { mode: "scoped" }] },
    },
  });
  return results[0].warnings.map((w) => w.text);
}

describe("librito/no-positioning-on-bare-type — global (CSS) mode", () => {
  it("flags position + z-index on a bare type selector", async () => {
    const w = await lintCss(
      "blockquote { position: relative; z-index: 2; }",
      "global",
    );
    expect(w).toHaveLength(2);
    expect(w.every((t) => t.includes("blockquote"))).toBe(true);
  });

  it("does NOT flag positioning anchored by an ancestor class (.menu-icon span)", async () => {
    const w = await lintCss(
      ".menu-icon span { position: absolute; left: 0; }",
      "global",
    );
    expect(w).toHaveLength(0);
  });

  it("does NOT flag typography on bare h1, h2 (#421)", async () => {
    const w = await lintCss(
      'h1, h2 { font-variation-settings: "opsz" 14; letter-spacing: normal; }',
      "global",
    );
    expect(w).toHaveLength(0);
  });

  it("in a comma list, flags only the bare type, not the class", async () => {
    const w = await lintCss(".foo, header { position: sticky; }", "global");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("header");
  });

  it("catches a reintroduced sticky header rule (acceptance criterion)", async () => {
    const w = await lintCss(
      "header { position: sticky; z-index: 60; }",
      "global",
    );
    expect(w).toHaveLength(2);
  });

  it("flags transform on a bare type (creates a stacking context)", async () => {
    const w = await lintCss(
      "section { transform: translateY(4px); }",
      "global",
    );
    expect(w).toHaveLength(1);
  });

  it("does NOT flag 'transform' inside a transition value (property check)", async () => {
    const w = await lintCss(
      "nav { transition: transform 0.2s ease; }",
      "global",
    );
    expect(w).toHaveLength(0);
  });

  it("flags positioning on a bare type's pseudo-element (class the host instead)", async () => {
    const w = await lintCss(
      "blockquote::before { content: ''; position: absolute; }",
      "global",
    );
    expect(w).toHaveLength(1);
  });

  it("does NOT flag a pseudo-element anchored by a class", async () => {
    const w = await lintCss(
      ".book-cover::after { position: absolute; inset: 0; }",
      "global",
    );
    expect(w).toHaveLength(0);
  });
});

describe("librito/no-positioning-on-bare-type — scoped (Svelte) mode", () => {
  it("does NOT flag a bare type (Svelte auto-scopes it)", async () => {
    const w = await lintSvelte(
      "blockquote { position: relative; z-index: 2; }",
    );
    expect(w).toHaveLength(0);
  });

  it("flags :global(type) with positioning", async () => {
    const w = await lintSvelte(
      ":global(header) { position: sticky; z-index: 60; }",
    );
    expect(w).toHaveLength(2);
    expect(w.every((t) => t.includes(":global(header)"))).toBe(true);
  });

  it("does NOT flag a class selector", async () => {
    const w = await lintSvelte(".card-link { position: absolute; inset: 0; }");
    expect(w).toHaveLength(0);
  });

  it("does NOT flag :global(type) anchored by an ancestor class", async () => {
    const w = await lintSvelte(".foo :global(header) { position: sticky; }");
    expect(w).toHaveLength(0);
  });

  it("does NOT flag a bare pseudo-element (Svelte auto-scopes it)", async () => {
    const w = await lintSvelte(
      "blockquote::before { content: ''; position: absolute; }",
    );
    expect(w).toHaveLength(0);
  });
});

describe("librito/no-positioning-on-bare-type — nested CSS / &", () => {
  it("does not double-report a nested decl against the outer selector", async () => {
    // `header { & span { … } }` resolves to `header span` — a genuine bare-type
    // leak, flagged ONCE against the nested rule, not also against `header`.
    const w = await lintCss(
      "header { & span { position: absolute; } }",
      "global",
    );
    expect(w).toHaveLength(1);
  });

  it("does NOT flag a nested rule anchored by an ancestor class (& form)", async () => {
    const w = await lintCss(
      ".foo { & header { position: absolute; } }",
      "global",
    );
    expect(w).toHaveLength(0);
  });

  it("does NOT flag a nested rule anchored by an ancestor class (implicit nesting)", async () => {
    const w = await lintCss(
      ".menu-icon { span { position: absolute; } }",
      "global",
    );
    expect(w).toHaveLength(0);
  });

  it("does NOT flag :global(type) nested under an ancestor class (scoped)", async () => {
    const w = await lintSvelte(
      ".wrap { & :global(header) { position: absolute; } }",
    );
    expect(w).toHaveLength(0);
  });
});
